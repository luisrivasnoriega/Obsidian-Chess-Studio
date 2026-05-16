//! UCI engine process abstraction and communication utilities.
//!
//! This module provides the `EngineProcess` struct for managing a UCI chess engine process,
//! sending commands, updating options, and parsing engine output for best-move analysis.

use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Mutex as StdMutex;
use std::time::Instant;

use lru::LruCache;
use once_cell::sync::Lazy;
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::time::{timeout, Duration};
use vampirc_uci::UciInfoAttribute;

use crate::error::Error;

use super::types::{BestMoves, EngineLog, EngineOptions, GoMode, Score, ScoreValue};
use super::uci::UciCommunicator;
use shakmaty::{fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, Color, Position};

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x08000000;
const UCI_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const UCI_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const ENGINE_QUIT_TIMEOUT: Duration = Duration::from_millis(300);
const ENGINE_FORCE_KILL_TIMEOUT: Duration = Duration::from_secs(1);
const PARSED_POSITION_CACHE_SIZE: usize = 256;
const MAX_ENGINE_LOG_LINES: usize = 4_000;
const ENGINE_LOG_TRIM_BATCH: usize = 512;

static PARSED_POSITION_CACHE: Lazy<StdMutex<LruCache<String, Chess>>> = Lazy::new(|| {
    let capacity = NonZeroUsize::new(PARSED_POSITION_CACHE_SIZE)
        .expect("PARSED_POSITION_CACHE_SIZE must be non-zero");
    StdMutex::new(LruCache::new(capacity))
});

fn push_capped_log(logs: &mut Vec<EngineLog>, entry: EngineLog) {
    logs.push(entry);
    if logs.len() > MAX_ENGINE_LOG_LINES + ENGINE_LOG_TRIM_BATCH {
        let overflow = logs.len().saturating_sub(MAX_ENGINE_LOG_LINES);
        logs.drain(0..overflow);
    }
}

/// Represents a running UCI engine process and its state.
pub struct EngineProcess {
    pub child: Child,
    pub stdin: tokio::process::ChildStdin,
    pub last_depth: u32,
    pub best_moves: Vec<BestMoves>,
    pub last_best_moves: Vec<BestMoves>,
    pub last_progress: f32,
    pub options: EngineOptions,
    pub go_mode: GoMode,
    pub running: bool,
    pub reconfiguring: bool,
    pub real_multipv: u16,
    pub logs: Vec<EngineLog>,
    pub start: Instant,
}

impl EngineProcess {
    pub fn append_log(&mut self, entry: EngineLog) {
        push_capped_log(&mut self.logs, entry);
    }

    async fn wait_for_token(
        comm: &mut UciCommunicator,
        logs: &mut Vec<EngineLog>,
        token: &str,
    ) -> Result<(), Error> {
        let wait_result = timeout(UCI_HANDSHAKE_TIMEOUT, async {
            loop {
                match comm.stdout_lines.next_line().await? {
                    Some(line) => {
                        push_capped_log(logs, EngineLog::Engine(line.clone()));
                        if line == token {
                            return Ok(());
                        }
                    }
                    None => return Err(Error::EngineTimeout),
                }
            }
        })
        .await;

        match wait_result {
            Ok(inner_result) => inner_result,
            Err(_) => Err(Error::EngineTimeout),
        }
    }

    async fn write_with_timeout(&mut self, msg: &str, timeout_error: Error) -> Result<(), Error> {
        let write_result = timeout(UCI_COMMAND_TIMEOUT, self.stdin.write_all(msg.as_bytes())).await;
        match write_result {
            Ok(Ok(())) => {
                self.append_log(EngineLog::Gui(msg.to_string()));
                Ok(())
            }
            Ok(Err(err)) => Err(Error::Io(err)),
            Err(_) => Err(timeout_error),
        }
    }

    /// Spawn a new UCI engine process and initialize it.
    ///
    /// Returns the process and a line reader for its stdout.
    pub async fn new(
        path: PathBuf,
    ) -> Result<
        (
            Self,
            tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
        ),
        Error,
    > {
        let mut comm = UciCommunicator::spawn(path).await?;

        let mut logs = Vec::new();

        comm.write_line("uci\n").await?;
        push_capped_log(&mut logs, EngineLog::Gui("uci\n".to_string()));
        Self::wait_for_token(&mut comm, &mut logs, "uciok").await?;

        comm.write_line("isready\n").await?;
        push_capped_log(&mut logs, EngineLog::Gui("isready\n".to_string()));
        Self::wait_for_token(&mut comm, &mut logs, "readyok").await?;

        Ok((
            Self {
                child: comm.child,
                stdin: comm.stdin,
                last_depth: 0,
                best_moves: Vec::new(),
                last_best_moves: Vec::new(),
                last_progress: 0.0,
                logs,
                options: EngineOptions::default(),
                real_multipv: 0,
                go_mode: GoMode::Infinite,
                running: false,
                reconfiguring: false,
                start: Instant::now(),
            },
            comm.stdout_lines,
        ))
    }

    /// Set a single UCI option for the engine.
    pub async fn set_option<T>(&mut self, name: &str, value: T) -> Result<(), Error>
    where
        T: std::fmt::Display,
    {
        let msg = format!("setoption name {} value {}\n", name, value);
        self.write_with_timeout(&msg, Error::EngineTimeout).await
    }

    /// Ask the engine to report when it has processed all pending commands.
    pub async fn request_ready(&mut self) -> Result<(), Error> {
        self.write_with_timeout("isready\n", Error::EngineTimeout)
            .await
    }

    /// Set all engine options, including FEN, moves, and extra UCI options.
    /// Updates multipv and resets best-move tracking.
    pub async fn set_options(&mut self, options: EngineOptions) -> Result<(), Error> {
        let fen: Fen = options.fen.parse()?;
        let mut pos: Chess = match fen.into_position(CastlingMode::Chess960) {
            Ok(p) => p,
            Err(e) => e.ignore_too_much_material()?,
        };
        for m in &options.moves {
            let uci = UciMove::from_ascii(m.as_bytes())?;
            let mv = uci.to_move(&pos)?;
            pos.play_unchecked(&mv);
        }
        let multipv = options
            .extra_options
            .iter()
            .find(|x| x.name == "MultiPV")
            .map(|x| x.value.parse().unwrap_or(1))
            .unwrap_or(1);

        self.real_multipv = multipv.min(pos.legal_moves().len() as u16);

        for option in &options.extra_options {
            if !self.options.extra_options.contains(option) {
                self.set_option(&option.name, &option.value).await?;
            }
        }

        if options.fen != self.options.fen || options.moves != self.options.moves {
            self.set_position(&options.fen, &options.moves).await?;
        }
        // Send isready after setting options to ensure engine is ready
        let has_uci_showwdl = options
            .extra_options
            .iter()
            .any(|o| o.name == "UCI_ShowWDL");
        if has_uci_showwdl {
            self.write_with_timeout("isready\n", Error::EngineTimeout)
                .await?;
        }
        self.last_depth = 0;
        self.last_progress = 0.0;
        self.options = options.clone();
        self.best_moves.clear();
        self.last_best_moves.clear();
        Ok(())
    }

    /// Set the engine's position using FEN and move list.
    pub async fn set_position(&mut self, fen: &str, moves: &Vec<String>) -> Result<(), Error> {
        let msg = if moves.is_empty() {
            format!("position fen {}\n", fen)
        } else {
            format!("position fen {} moves {}\n", fen, moves.join(" "))
        };
        self.write_with_timeout(&msg, Error::EngineTimeout).await?;
        self.options.fen = fen.to_string();
        self.options.moves = moves.clone();
        Ok(())
    }

    /// Start engine search with the given mode (depth, time, etc).
    pub async fn go(&mut self, mode: &GoMode) -> Result<(), Error> {
        self.go_mode = mode.clone();
        let msg = match mode {
            GoMode::Depth(depth) => format!("go depth {}\n", depth),
            GoMode::Time(time) => format!("go movetime {}\n", time),
            GoMode::Nodes(nodes) => format!("go nodes {}\n", nodes),
            GoMode::PlayersTime(super::types::PlayersTime {
                white,
                black,
                winc,
                binc,
            }) => {
                // Don't add movetime limit - let the engine use the available time
                // The engine will manage its time based on wtime/btime
                format!(
                    "go wtime {} btime {} winc {} binc {}\n",
                    white, black, winc, binc
                )
            }
            GoMode::Infinite => "go infinite\n".to_string(),
        };
        self.write_with_timeout(&msg, Error::EngineTimeout).await?;
        self.running = true;
        self.start = Instant::now();
        Ok(())
    }

    /// Stop the engine's current search.
    pub async fn stop(&mut self) -> Result<(), Error> {
        self.write_with_timeout("stop\n", Error::EngineStopTimeout)
            .await?;
        self.running = false;
        Ok(())
    }

    /// Kill the engine process.
    pub async fn kill(&mut self) -> Result<(), Error> {
        let _ = timeout(UCI_COMMAND_TIMEOUT, self.stdin.write_all(b"quit\n")).await;
        self.append_log(EngineLog::Gui("quit\n".to_string()));
        self.running = false;

        // Give the engine a brief chance to exit gracefully after "quit".
        match timeout(ENGINE_QUIT_TIMEOUT, self.child.wait()).await {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(err)) => return Err(Error::Io(err)),
            Err(_) => {}
        }

        // Force-kill as fallback to prevent orphan processes.
        let _ = self.child.start_kill();
        match timeout(ENGINE_FORCE_KILL_TIMEOUT, self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(err)) => Err(Error::Io(err)),
            Err(_) => Err(Error::EngineStopTimeout),
        }
    }
}

/// Invert a UCI score (for black's perspective).
fn invert_score(score: Score) -> Score {
    let new_value = match score.value {
        ScoreValue::Cp(x) => ScoreValue::Cp(-x),
        ScoreValue::Mate(x) => ScoreValue::Mate(-x),
    };
    let new_wdl = score.wdl.map(|(w, d, l)| (l, d, w));
    Score {
        value: new_value,
        wdl: new_wdl,
    }
}

fn build_position_cache_key(fen: &Fen, moves: &[String]) -> String {
    if moves.is_empty() {
        return fen.to_string();
    }

    let mut key = fen.to_string();
    key.push('\u{1f}');
    key.push_str(&moves.join("\u{1f}"));
    key
}

fn build_position_from_fen_moves(fen: &Fen, moves: &[String]) -> Result<Chess, Error> {
    let mut pos: Chess = match fen.clone().into_position(CastlingMode::Chess960) {
        Ok(p) => p,
        Err(e) => e.ignore_too_much_material()?,
    };

    for m in moves {
        let uci = UciMove::from_ascii(m.as_bytes())?;
        let mv = uci.to_move(&pos)?;
        pos.play_unchecked(&mv);
    }

    Ok(pos)
}

fn get_cached_position(fen: &Fen, moves: &[String]) -> Result<Chess, Error> {
    let cache_key = build_position_cache_key(fen, moves);

    if let Ok(mut cache) = PARSED_POSITION_CACHE.lock() {
        if let Some(position) = cache.get(&cache_key) {
            return Ok(position.clone());
        }
    }

    let position = build_position_from_fen_moves(fen, moves)?;

    if let Ok(mut cache) = PARSED_POSITION_CACHE.lock() {
        cache.put(cache_key, position.clone());
    }

    Ok(position)
}

/// Parse UCI info attributes into a `BestMoves` struct for the current position.
///
/// # Arguments
/// * `attrs` - UCI info attributes from the engine.
/// * `fen` - FEN string for the position.
/// * `moves` - List of moves leading to the position.
/// * `original_line` - Optional original UCI line for manual PV parsing if needed.
///
/// # Returns
/// `BestMoves` struct with parsed data.
///
/// # Errors
/// Returns `Error` if parsing fails or no moves are found.
pub fn parse_uci_attrs(
    attrs: Vec<UciInfoAttribute>,
    fen: &Fen,
    moves: &Vec<String>,
) -> Result<BestMoves, Error> {
    parse_uci_attrs_with_line(attrs, fen, moves, None)
}

/// Parse UCI info attributes into a `BestMoves` struct for the current position.
/// This version accepts an optional original line for manual PV parsing.
pub fn parse_uci_attrs_with_line(
    attrs: Vec<UciInfoAttribute>,
    fen: &Fen,
    moves: &Vec<String>,
    original_line: Option<&str>,
) -> Result<BestMoves, Error> {
    let mut best_moves = BestMoves::default();

    // Hot path optimization: avoid re-parsing FEN + replaying moves for each UCI info line.
    // The base position is stable across many engine lines and is cached with a small LRU.
    let mut pos = get_cached_position(fen, moves)?;
    let turn = pos.turn();

    fn parse_wdl_value(value: &str) -> Option<(u32, u32, u32)> {
        let mut iter = value.split_whitespace();
        let w = iter.next()?.parse::<u32>().ok()?;
        let d = iter.next()?.parse::<u32>().ok()?;
        let l = iter.next()?.parse::<u32>().ok()?;
        Some((w, d, l))
    }

    // First pass: collect WDL value if present (it may come before or after Score)
    let mut wdl_value: Option<(u32, u32, u32)> = None;
    for a in &attrs {
        if let UciInfoAttribute::Any(name, value) = a {
            if name.eq_ignore_ascii_case("wdl") {
                if let Some(wdl) = parse_wdl_value(value) {
                    wdl_value = Some(wdl);
                    break;
                }
            }
        }
    }

    // Second pass: process all attributes, preserving WDL when setting Score
    for a in attrs {
        match a {
            UciInfoAttribute::Pv(m) => {
                for mv in m {
                    let uci: UciMove = mv.to_string().parse()?;
                    let m = uci.to_move(&pos)?;
                    let san = SanPlus::from_move_and_play_unchecked(&mut pos, &m);
                    best_moves.san_moves.push(san.to_string());
                    best_moves.uci_moves.push(uci.to_string());
                }
            }
            UciInfoAttribute::Nps(nps) => {
                best_moves.nps = nps as u32;
            }
            UciInfoAttribute::Nodes(nodes) => {
                best_moves.nodes = nodes as u32;
            }
            UciInfoAttribute::Depth(depth) => {
                best_moves.depth = depth as u32;
            }
            UciInfoAttribute::MultiPv(multipv) => {
                best_moves.multipv = multipv;
            }
            UciInfoAttribute::Score { cp, mate, .. } => {
                // Preserve WDL value found in first pass
                best_moves.score = if let Some(mate) = mate {
                    Score {
                        value: ScoreValue::Mate(mate as i32),
                        wdl: wdl_value,
                    }
                } else {
                    Score {
                        value: ScoreValue::Cp(cp.unwrap_or(0)),
                        wdl: wdl_value,
                    }
                };
            }
            UciInfoAttribute::Any(name, value) if name.eq_ignore_ascii_case("wdl") => {
                // This is already handled in first pass, but set it here too for safety
                if let Some(wdl) = parse_wdl_value(&value) {
                    best_moves.score.wdl = Some(wdl);
                }
            }
            _ => {}
        }
    }

    // If no PV was found in attributes but we have WDL, try to parse PV manually from original line
    if best_moves.san_moves.is_empty() && best_moves.score.wdl.is_some() && original_line.is_some()
    {
        if let Some(line) = original_line {
            // Try to extract PV from line like "info ... pv e2e4 d7d5 ..."
            if let Some(pv_start) = line.find(" pv ") {
                let pv_part = &line[pv_start + 4..];
                let pv_moves: Vec<&str> = pv_part.split_whitespace().collect();
                let mut pos_for_pv = get_cached_position(fen, moves)?;
                for pv_move_str in pv_moves {
                    let uci = UciMove::from_ascii(pv_move_str.as_bytes())?;
                    let mv = uci.to_move(&pos_for_pv)?;
                    let san = SanPlus::from_move_and_play_unchecked(&mut pos_for_pv, &mv);
                    best_moves.san_moves.push(san.to_string());
                    best_moves.uci_moves.push(uci.to_string());
                }
            }
        }
    }

    if best_moves.san_moves.is_empty() {
        return Err(Error::NoMovesFound);
    }

    if turn == Color::Black {
        best_moves.score = invert_score(best_moves.score);
    }

    Ok(best_moves)
}

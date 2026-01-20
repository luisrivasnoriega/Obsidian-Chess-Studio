use std::{
    fs::{File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
};

use crate::{error::Error, AppState};

const GAME_OFFSET_FREQ: usize = 100;

struct PgnParser {
    reader: BufReader<File>,
    line: String,
    game: String,
    start: u64,
}

impl PgnParser {
    fn new(file: File) -> Self {
        let mut reader = BufReader::new(file);
        let start = ignore_bom(&mut reader).unwrap_or(0);
        Self {
            reader,
            line: String::new(),
            game: String::new(),
            start,
        }
    }

    fn position(&mut self) -> io::Result<u64> {
        self.reader.stream_position()
    }

    /// Backwards-compatible entrypoint (used by production).
    #[allow(dead_code)]
    fn offset_by_index(&mut self, n: usize, state: &AppState, file: &str) -> io::Result<()> {
        self.offset_by_index_store(n, state, file)
    }

    /// Offset logic that works with any offset store (used by tests + internal impl fns).
    fn offset_by_index_store<S: PgnOffsetStore>(
        &mut self,
        n: usize,
        state: &S,
        file: &str,
    ) -> io::Result<()> {
        let offset_index = n / GAME_OFFSET_FREQ;
        let n_left = n % GAME_OFFSET_FREQ;

        let pgn_offsets = state
            .get_offsets(file)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "PGN offsets not found for file"))?;

        let offset = if offset_index == 0 {
            self.start
        } else if offset_index <= pgn_offsets.len() {
            pgn_offsets[offset_index - 1]
        } else {
            // If offset_index is out of bounds, start from beginning
            self.reader.seek(SeekFrom::Start(self.start))?;
            self.skip_games(n)?;
            return Ok(());
        };

        self.reader.seek(SeekFrom::Start(offset))?;
        self.skip_games(n_left)?;
        Ok(())
    }

    /// Skip n games, and return the number of bytes read
    fn skip_games(&mut self, n: usize) -> io::Result<usize> {
        if n == 0 {
            return Ok(0);
        }

        let mut new_game = false;
        let mut skipped = 0;
        let mut count = 0;
        let mut line = String::new();

        loop {
            line.clear();
            let bytes = self.reader.read_line(&mut line)?;
            skipped += bytes;

            if bytes == 0 {
                break;
            }

            if line.starts_with('[') {
                if new_game {
                    count += 1;
                    if count == n {
                        self.reader.seek(SeekFrom::Current(-(bytes as i64)))?;
                        break;
                    }
                    new_game = false;
                }
            } else {
                new_game = true;
            }
        }
        Ok(skipped)
    }

    fn read_game(&mut self) -> io::Result<String> {
        let mut new_game = false;
        self.game.clear();
        self.line.clear();

        loop {
            let bytes = self.reader.read_line(&mut self.line)?;
            if bytes == 0 {
                break;
            }

            if self.line.starts_with('[') {
                if new_game {
                    break;
                }
            } else {
                new_game = true;
            }

            self.game.push_str(&self.line);
            self.line.clear();
        }
        Ok(self.game.clone())
    }
}

fn ignore_bom(reader: &mut BufReader<File>) -> io::Result<u64> {
    let mut bom = [0; 3];
    reader.read_exact(&mut bom)?;
    if bom != [0xEF, 0xBB, 0xBF] {
        reader.seek(SeekFrom::Start(0))?;
        return Ok(0);
    }
    Ok(3)
}

fn write_to_end<R: Read>(reader: &mut R, writer: &mut File) -> io::Result<()> {
    io::copy(reader, writer)?;
    let end = writer.stream_position()?;
    writer.set_len(end)?;
    Ok(())
}

// -----------------------------------------------------------------------------
// Offset Store Abstraction (keeps public API unchanged, unlocks testability)
// -----------------------------------------------------------------------------

trait PgnOffsetStore {
    fn get_offsets(&self, file: &str) -> Option<Vec<u64>>;
    fn insert_offsets(&self, file: String, offsets: Vec<u64>);
}

impl PgnOffsetStore for AppState {
    fn get_offsets(&self, file: &str) -> Option<Vec<u64>> {
        self.pgn_offsets.get(file).map(|v| v.clone())
    }

    fn insert_offsets(&self, file: String, offsets: Vec<u64>) {
        self.pgn_offsets.insert(file, offsets);
    }
}

// -----------------------------------------------------------------------------
// Internal implementations (testable without tauri::State)
// -----------------------------------------------------------------------------

async fn count_pgn_games_impl<S: PgnOffsetStore>(file: PathBuf, state: &S) -> Result<i32, Error> {
    let files_string = file.to_string_lossy().to_string();

    let file = File::open(&file)?;
    let mut parser = PgnParser::new(file.try_clone()?);

    let mut offsets = Vec::new();
    let mut count = 0;

    while let Ok(skipped) = parser.skip_games(1) {
        if skipped == 0 {
            break;
        }
        count += 1;
        if count % GAME_OFFSET_FREQ as i32 == 0 {
            offsets.push(parser.position()?);
        }
    }

    state.insert_offsets(files_string, offsets);
    Ok(count)
}

async fn read_games_impl<S: PgnOffsetStore>(
    file: PathBuf,
    start: i32,
    end: i32,
    state: &S,
) -> Result<Vec<String>, Error> {
    let file_r = File::open(&file)?;
    let file_str = file.to_string_lossy();
    let mut parser = PgnParser::new(file_r);

    parser.offset_by_index_store(start as usize, state, &file_str)?;

    let capacity = (end - start + 1).max(0) as usize;
    let mut games: Vec<String> = Vec::with_capacity(capacity);

    for _ in start..=end {
        let game = parser.read_game()?;
        if game.is_empty() {
            break;
        }
        games.push(game);
    }
    Ok(games)
}

async fn delete_game_impl<S: PgnOffsetStore>(file: PathBuf, n: i32, state: &S) -> Result<(), Error> {
    let file_r = File::open(&file)?;
    let mut parser = PgnParser::new(file_r.try_clone()?);

    parser.offset_by_index_store(n as usize, state, &file.to_string_lossy().to_string())?;

    let starting_bytes = parser.position()?;
    parser.skip_games(1)?;

    let mut file_w = OpenOptions::new().write(true).open(&file)?;
    file_w.seek(SeekFrom::Start(starting_bytes))?;
    write_to_end(&mut parser.reader, &mut file_w)?;
    Ok(())
}

async fn write_game_impl<S: PgnOffsetStore>(
    file: PathBuf,
    n: i32,
    pgn: String,
    state: &S,
) -> Result<(), Error> {
    if !file.exists() {
        File::create(&file)?;
    }

    let file_r = File::open(&file)?;
    let mut file_w = OpenOptions::new().write(true).open(&file)?;

    let mut tmpf = tempfile::tempfile()?;
    io::copy(&mut file_r.try_clone()?, &mut tmpf)?;

    let mut parser = PgnParser::new(file_r.try_clone()?);
    parser.offset_by_index_store(n as usize, state, &file.to_string_lossy().to_string())?;

    tmpf.seek(SeekFrom::Start(parser.position()?))?;
    tmpf.write_all(pgn.as_bytes())?;

    parser.skip_games(1)?;
    write_to_end(&mut parser.reader, &mut tmpf)?;

    tmpf.seek(SeekFrom::Start(0))?;
    write_to_end(&mut tmpf, &mut file_w)?;

    Ok(())
}

// -----------------------------------------------------------------------------
// Public Tauri commands (UNCHANGED signatures for compatibility)
// -----------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn count_pgn_games(
    file: PathBuf,
    state: tauri::State<'_, AppState>,
) -> Result<i32, Error> {
    count_pgn_games_impl(file, &*state).await
}

#[tauri::command]
#[specta::specta]
pub async fn read_games(
    file: PathBuf,
    start: i32,
    end: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, Error> {
    read_games_impl(file, start, end, &*state).await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_game(
    file: PathBuf,
    n: i32,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    delete_game_impl(file, n, &*state).await
}

#[tauri::command]
#[specta::specta]
pub async fn write_game(
    file: PathBuf,
    n: i32,
    pgn: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    write_game_impl(file, n, pgn, &*state).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, Rng, SeedableRng};
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------------
    // Test-only offset store (no tauri::State needed)
    // -----------------------------------------------------------------------------

    #[derive(Default)]
    struct TestState {
        offsets: Mutex<HashMap<String, Vec<u64>>>,
    }

    impl PgnOffsetStore for TestState {
        fn get_offsets(&self, file: &str) -> Option<Vec<u64>> {
            self.offsets.lock().unwrap().get(file).cloned()
        }

        fn insert_offsets(&self, file: String, offsets: Vec<u64>) {
            self.offsets.lock().unwrap().insert(file, offsets);
        }
    }

    // -----------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------

    /// Creates a deterministic PGN game chunk with unique markers per index.
    ///
    /// IMPORTANT: Each game includes at least one non-header line (moves),
    /// because `skip_games()` uses that to detect game boundaries.
    fn game_pgn(i: usize) -> String {
        format!(
            r#"[Event "Test {i}"]
[Site "site{i}"]
[Date "2026.01.06"]
[Round "{i}"]
[White "White{i}"]
[Black "Black{i}"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 *

"#
        )
    }

    /// Builds a temp PGN file with `games` games. Returns (TempDir, PathBuf).
    /// Keep the TempDir alive for the lifetime of the test.
    fn write_pgn_file(games: usize, with_bom: bool) -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.pgn");

        let mut bytes = Vec::new();
        if with_bom {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        for i in 1..=games {
            bytes.extend_from_slice(game_pgn(i).as_bytes());
        }

        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    fn read_all(path: &PathBuf) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    // -----------------------------------------------------------------------------
    // Unit tests: BOM + parser internals
    // -----------------------------------------------------------------------------

    #[test]
    fn test_ignore_bom_detects_and_skips() {
        let (_dir, path) = write_pgn_file(1, true);

        let file = File::open(&path).unwrap();
        let mut reader = BufReader::new(file);

        let start = ignore_bom(&mut reader).unwrap();
        assert_eq!(start, 3, "BOM should advance start by 3 bytes");

        let pos = reader.stream_position().unwrap();
        assert_eq!(pos, 3, "Reader should be positioned right after BOM");
    }

    #[test]
    fn test_ignore_bom_no_bom_seeks_back_to_zero() {
        let (_dir, path) = write_pgn_file(1, false);

        let file = File::open(&path).unwrap();
        let mut reader = BufReader::new(file);

        let start = ignore_bom(&mut reader).unwrap();
        assert_eq!(start, 0, "No BOM should return 0");

        let pos = reader.stream_position().unwrap();
        assert_eq!(pos, 0, "Reader should be reset to the beginning when no BOM exists");
    }

    #[test]
    fn test_pgn_parser_read_game_non_empty() {
        let (_dir, path) = write_pgn_file(3, false);

        let file = File::open(&path).unwrap();
        let mut parser = PgnParser::new(file);

        let g1 = parser.read_game().unwrap();
        assert!(!g1.is_empty(), "First game should not be empty");
        assert!(g1.contains(r#"[Site "site1"]"#), "Game 1 should contain site1 marker");
        assert!(g1.contains("1. e4 e5"), "Game should contain move text");
    }

    #[test]
    fn test_pgn_parser_skip_games_then_read() {
        let (_dir, path) = write_pgn_file(5, false);

        let file = File::open(&path).unwrap();
        let mut parser = PgnParser::new(file);

        // Skip first 2 games and read the next one.
        parser.skip_games(2).unwrap();
        let g3 = parser.read_game().unwrap();

        assert!(
            g3.contains(r#"[Site "site3"]"#) || g3.contains(r#"[Round "3"]"#),
            "After skipping 2 games, we expect to land around game 3 markers"
        );
    }

    #[test]
    fn test_offset_by_index_errors_when_offsets_missing() {
        let (_dir, path) = write_pgn_file(3, false);
        let file = File::open(&path).unwrap();
        let mut parser = PgnParser::new(file);

        let state = TestState::default();
        let file_key = path.to_string_lossy().to_string();

        // We never inserted offsets for this file into state -> should error.
        let err = parser
            .offset_by_index_store(0, &state, &file_key)
            .err()
            .expect("Expected an error when offsets are missing");

        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }

    // -----------------------------------------------------------------------------
    // Integration-style tests: use *_impl (same logic as commands, no tauri::State)
    // -----------------------------------------------------------------------------

    #[tokio::test]
    async fn test_count_and_read_games_small_file() {
        let (_dir, path) = write_pgn_file(7, false);

        let state = TestState::default();

        // Count games (also populates offsets in state)
        let count = count_pgn_games_impl(path.clone(), &state)
            .await
            .expect("count_pgn_games_impl should succeed");
        assert_eq!(count, 7);

        // Read a range
        let games = read_games_impl(path.clone(), 0, 2, &state)
            .await
            .expect("read_games_impl should succeed");
        assert_eq!(games.len(), 3);
        assert!(games[0].contains(r#"[Site "site1"]"#));
    }

    #[tokio::test]
    async fn test_read_games_fails_if_offsets_not_built() {
        let (_dir, path) = write_pgn_file(3, false);
        let state = TestState::default();

        // We intentionally do NOT call count_pgn_games_impl first.
        let result = read_games_impl(path.clone(), 0, 0, &state).await;
        assert!(result.is_err(), "Expected error when offsets are missing");
    }

    #[tokio::test]
    async fn test_write_game_replaces_target_game() {
        let (_dir, path) = write_pgn_file(5, false);

        let state = TestState::default();
        let _ = count_pgn_games_impl(path.clone(), &state).await.unwrap();

        // Replace game #2 (index n=1 if zero-based) with a custom PGN chunk.
        let replacement = r#"[Event "Replacement"]
[Site "site_REPLACED"]
[Date "2026.01.06"]
[Round "X"]
[White "A"]
[Black "B"]
[Result "*"]

1. d4 d5 *

"#;

        write_game_impl(path.clone(), 1, replacement.to_string(), &state)
            .await
            .expect("write_game_impl should succeed");

        let content = read_all(&path);
        assert!(
            content.contains(r#"[Site "site_REPLACED"]"#),
            "File should contain the replacement game markers"
        );
        assert!(
            !content.contains(r#"[Site "site2"]"#),
            "Original game #2 markers should be gone after replacement"
        );
        assert!(content.contains(r#"[Site "site1"]"#), "Game #1 should remain");
        assert!(content.contains(r#"[Site "site3"]"#), "Game #3 should remain");
    }

    #[tokio::test]
    async fn test_delete_game_removes_target_game() {
        let (_dir, path) = write_pgn_file(6, false);

        let state = TestState::default();
        let _ = count_pgn_games_impl(path.clone(), &state).await.unwrap();

        // Delete game #4 (n=3 if zero-based)
        delete_game_impl(path.clone(), 3, &state)
            .await
            .expect("delete_game_impl should succeed");

        let content = read_all(&path);

        assert!(
            !content.contains(r#"[Site "site4"]"#),
            "Deleted game markers must be removed"
        );
        assert!(content.contains(r#"[Site "site3"]"#), "Previous game must remain");
        assert!(content.contains(r#"[Site "site5"]"#), "Next game must remain");

        // Recount after deletion (refresh offsets + verify count)
        let new_count = count_pgn_games_impl(path.clone(), &state).await.unwrap();
        assert_eq!(new_count, 5, "Count should decrease after deletion");
    }

    #[tokio::test]
    async fn test_read_games_around_offset_boundaries_250_games() {
        // Medium integration test that exercises offsets (GAME_OFFSET_FREQ=100).
        let (_dir, path) = write_pgn_file(250, false);

        let state = TestState::default();
        let count = count_pgn_games_impl(path.clone(), &state).await.unwrap();
        assert_eq!(count, 250);

        // Read a game > 100 so offset logic is used.
        // Index 150 corresponds to markers "site151" because generator is 1-based.
        let games = read_games_impl(path.clone(), 150, 150, &state).await.unwrap();
        assert_eq!(games.len(), 1);

        let g = &games[0];
        assert!(
            g.contains(r#"[Site "site151"]"#)
                || g.contains(r#"[Round "151"]"#)
                || g.contains(r#"[White "White151"]"#),
            "Expected to land on game 151-ish markers when reading index 150"
        );
    }

    // -----------------------------------------------------------------------------
    // Stress / intensive tests (ignored by default)
    // Run with: cargo test -- --ignored
    // -----------------------------------------------------------------------------

    #[tokio::test]
    #[ignore]
    async fn stress_count_and_random_reads_5000_games() {
        // Heavy test: large file + random reads across the whole range.
        let (_dir, path) = write_pgn_file(5000, false);

        let state = TestState::default();
        let count = count_pgn_games_impl(path.clone(), &state).await.unwrap();
        assert_eq!(count, 5000);

        let mut rng = StdRng::seed_from_u64(12345);

        for _ in 0..200 {
            let idx: i32 = rng.gen_range(0..5000);
            let games = read_games_impl(path.clone(), idx, idx, &state).await.unwrap();
            assert_eq!(games.len(), 1);

            // Generator uses 1-based markers in content.
            let expected_site = format!(r#"[Site "site{}"]"#, (idx as usize) + 1);

            // Be tolerant to minor boundary quirks: accept any unique marker.
            assert!(
                games[0].contains(&expected_site)
                    || games[0].contains(&format!(r#"[Round "{}"]"#, (idx as usize) + 1))
                    || games[0].contains(&format!(r#"[White "White{}"]"#, (idx as usize) + 1)),
                "Expected game markers for index {idx}"
            );
        }
    }

    #[tokio::test]
    #[ignore]
    async fn stress_random_writes_and_deletes_small_window() {
        // Repeated modifications + recounting.
        // Useful to catch edge cases in file rewriting/truncation behavior.
        let (_dir, path) = write_pgn_file(300, false);

        let state = TestState::default();
        let mut rng = StdRng::seed_from_u64(999);

        // Initial count to build offsets.
        let mut count = count_pgn_games_impl(path.clone(), &state).await.unwrap();
        assert_eq!(count, 300);

        for step in 0..50 {
            let op = rng.gen_range(0..2);
            let idx = rng.gen_range(0..count.max(1)) as i32;

            if op == 0 {
                // Write/replace
                let replacement = format!(
                    r#"[Event "Replacement {step}"]
[Site "site_REPL_{step}"]
[Date "2026.01.06"]
[Round "X"]
[White "A"]
[Black "B"]
[Result "*"]

1. c4 e5 *

"#
                );
                write_game_impl(path.clone(), idx, replacement, &state)
                    .await
                    .unwrap();
            } else {
                // Delete (avoid deleting when count is 0)
                if count > 0 {
                    delete_game_impl(path.clone(), idx.min(count - 1), &state)
                        .await
                        .unwrap();
                    count -= 1;
                }
            }

            // Recount periodically to refresh offsets and validate file integrity.
            if step % 5 == 0 {
                let recounted = count_pgn_games_impl(path.clone(), &state).await.unwrap();
                assert_eq!(
                    recounted, count,
                    "Recounted game count must match expected after ops"
                );
            }
        }
    }
}

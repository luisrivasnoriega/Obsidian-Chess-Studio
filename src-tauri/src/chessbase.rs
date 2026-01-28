use serde::{Deserialize, Serialize};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::uci::Uci;
use shakmaty::{CastlingMode, Chess, Position as _};
use tauri::State;
use tokio::sync::{mpsc, oneshot, watch, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::http::HeaderValue;

#[derive(Debug, Serialize, specta::Type)]
pub struct ChessbaseCredentialsSummary {
    pub username: Option<String>,
    pub has_password: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct ChessbaseSessionStatus {
    pub connected: bool,
    pub username: Option<String>,
    pub state: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct ChessbaseDownloadResult {
    pub pgn: String,
    pub games: u32,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct ChessbaseQuickSearchCount {
    pub returned: u32,
    pub total: u32,
}

#[derive(Debug, Deserialize, Serialize)]
struct StoredCredentials {
    username: String,
    password: String,
}

const KEYRING_SERVICE: &str = "ObsidianChessStudio";
const KEYRING_USERNAME: &str = "chessbase_credentials";

// ChessBase OnlineDB websocket endpoint. The browser client connects without showing a UI; we do the same.
// The trailing slash matters for some websocket servers.
const CHESSBASE_WS_URL: &str = "wss://dbserver.chessbase.com:443/";
const LOGIN_WAIT_SECS: u64 = 10;
const MAX_GAMES_PER_QUERY: u32 = 1000;
const MAX_GAMES_PER_BATCH: usize = 100;

fn credentials_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USERNAME).map_err(|e| e.to_string())
}

fn load_credentials() -> Result<Option<StoredCredentials>, String> {
    let entry = credentials_entry()?;
    match entry.get_password() {
        Ok(secret) => {
            let creds: StoredCredentials =
                serde_json::from_str(&secret).map_err(|e| format!("Invalid stored credentials: {e}"))?;
            Ok(Some(creds))
        }
        Err(_) => Ok(None),
    }
}

fn save_credentials(username: String, password: String) -> Result<(), String> {
    let entry = credentials_entry()?;
    let secret = serde_json::to_string(&StoredCredentials { username, password })
        .map_err(|e| format!("Failed to serialize credentials: {e}"))?;
    entry.set_password(&secret).map_err(|e| e.to_string())
}

fn delete_credentials() -> Result<(), String> {
    let entry = credentials_entry()?;
    let _ = entry.delete_password();
    Ok(())
}

#[derive(Default)]
pub struct ChessbaseWsState {
    session: Option<Arc<ChessbaseWsSession>>,
}

pub struct ChessbaseWsSession {
    username: String,
    requests_tx: mpsc::UnboundedSender<ChessbaseWsRequest>,
    ready_rx: watch::Receiver<bool>,
    last_error: Arc<Mutex<Option<String>>>,
}

enum ChessbaseWsRequest {
    DownloadByQuickSearch {
        query: String,
        max_games: u32,
        respond_to: oneshot::Sender<Result<ChessbaseDownloadResult, String>>,
    },
    CountByQuickSearch {
        query: String,
        respond_to: oneshot::Sender<Result<ChessbaseQuickSearchCount, String>>,
    },
    Shutdown,
}

#[derive(Clone, Copy)]
#[repr(i16)]
enum SockMsgId {
    Logon = 7002,
    YourId = 7004,
    DefaultGroups = 7062,
    QueryOnlineDb = 7100,
    RequestOnlineDbGames = 7101,
    RequestOnlineDbUserInfo = 7104,
    OnlineDbNumbers = 7106,
    OnlineDbGames = 7107,
    OnlineDbUserInfo = 7111,
}

#[derive(Clone, Copy)]
#[repr(i32)]
enum LoginMode {
    Normal = 1,
    Guest = 2,
}

#[derive(Default, Clone)]
struct DataBuffer {
    pos: usize,
    data: Vec<u8>,
    size_markers: Vec<usize>,
    marked_sizes: Vec<usize>,
}

impl DataBuffer {
    fn from_bytes(bytes: Vec<u8>) -> Self {
        Self {
            pos: 0,
            data: bytes,
            size_markers: vec![],
            marked_sizes: vec![],
        }
    }

    fn rewind(&mut self) {
        self.pos = 0;
        self.size_markers.clear();
        self.marked_sizes.clear();
    }

    fn begin_sized_write(&mut self) {
        let marker = self.data.len();
        self.size_markers.push(marker);
        self.write_i32_le(0);
    }

    fn end_sized_write(&mut self) -> Result<(), String> {
        let marker = self
            .size_markers
            .pop()
            .ok_or("DataBuffer endSizedWrite without marker")?;
        let curr = self.data.len();
        let payload_len = curr
            .checked_sub(marker + 4)
            .ok_or("DataBuffer sized write underflow")?;
        let bytes = (payload_len as i32).to_le_bytes();
        self.data[marker..marker + 4].copy_from_slice(&bytes);
        Ok(())
    }

    fn begin_sized_read(&mut self) -> Result<(), String> {
        let marker = self.pos;
        self.size_markers.push(marker);
        let size = self.read_i32_le()? as isize;
        if size < 0 {
            return Err("Negative sized read length".to_string());
        }
        self.marked_sizes.push(size as usize);
        Ok(())
    }

    fn end_sized_read(&mut self) -> Result<(), String> {
        let marker = self
            .size_markers
            .pop()
            .ok_or("DataBuffer endSizedRead without marker")?;
        let expected = self
            .marked_sizes
            .pop()
            .ok_or("DataBuffer endSizedRead without expected size")?;
        let read = self
            .pos
            .checked_sub(marker + 4)
            .ok_or("DataBuffer sized read underflow")?;
        if read > expected {
            return Err("DataBuffer sized read overflow".to_string());
        }
        let skip = expected - read;
        self.skip(skip)?;
        Ok(())
    }

    fn skip_sized_read(&mut self) -> Result<(), String> {
        let len = self.read_i32_le()? as isize;
        if len < 0 {
            return Err("Negative sized block length".to_string());
        }
        self.skip(len as usize)
    }

    fn skip(&mut self, n: usize) -> Result<(), String> {
        if self.pos + n > self.data.len() {
            return Err("DataBuffer skip beyond end".to_string());
        }
        self.pos += n;
        Ok(())
    }

    fn write_u8(&mut self, v: u8) {
        self.data.push(v);
    }

    fn write_i16_le(&mut self, v: i16) {
        self.data.extend_from_slice(&v.to_le_bytes());
    }

    fn write_u16_le(&mut self, v: u16) {
        self.data.extend_from_slice(&v.to_le_bytes());
    }

    fn write_i32_le(&mut self, v: i32) {
        self.data.extend_from_slice(&v.to_le_bytes());
    }

    fn write_u32_le(&mut self, v: u32) {
        self.data.extend_from_slice(&v.to_le_bytes());
    }

    fn write_ascii_string(&mut self, s: &str) {
        let bytes = s.as_bytes();
        self.write_i32_le(bytes.len() as i32);
        self.data.extend_from_slice(bytes);
    }

    fn write_utf_string(&mut self, s: &str) {
        self.write_ascii_string(s);
    }

    fn read_u8(&mut self) -> Result<u8, String> {
        if self.pos + 1 > self.data.len() {
            return Err("DataBuffer read_u8 beyond end".to_string());
        }
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_bool(&mut self) -> Result<bool, String> {
        Ok(self.read_u8()? != 0)
    }

    fn read_i16_le(&mut self) -> Result<i16, String> {
        if self.pos + 2 > self.data.len() {
            return Err("DataBuffer read_i16 beyond end".to_string());
        }
        let mut b = [0u8; 2];
        b.copy_from_slice(&self.data[self.pos..self.pos + 2]);
        self.pos += 2;
        Ok(i16::from_le_bytes(b))
    }

    fn read_u16_le(&mut self) -> Result<u16, String> {
        if self.pos + 2 > self.data.len() {
            return Err("DataBuffer read_u16 beyond end".to_string());
        }
        let mut b = [0u8; 2];
        b.copy_from_slice(&self.data[self.pos..self.pos + 2]);
        self.pos += 2;
        Ok(u16::from_le_bytes(b))
    }

    fn read_i32_le(&mut self) -> Result<i32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("DataBuffer read_i32 beyond end".to_string());
        }
        let mut b = [0u8; 4];
        b.copy_from_slice(&self.data[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(i32::from_le_bytes(b))
    }

    fn read_u32_le(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.data.len() {
            return Err("DataBuffer read_u32 beyond end".to_string());
        }
        let mut b = [0u8; 4];
        b.copy_from_slice(&self.data[self.pos..self.pos + 4]);
        self.pos += 4;
        Ok(u32::from_le_bytes(b))
    }

    fn read_ascii_string(&mut self, max_len: usize) -> Result<String, String> {
        let n = self.read_i32_le()? as isize;
        if n < 0 {
            return Err("Negative string length".to_string());
        }
        let n = n as usize;
        if n > max_len || self.pos + n > self.data.len() {
            return Err("String out of bounds".to_string());
        }
        let s = String::from_utf8_lossy(&self.data[self.pos..self.pos + n]).to_string();
        self.pos += n;
        Ok(s)
    }

    fn read_byte_len_ascii_string(&mut self, max_len: usize) -> Result<String, String> {
        let mut n = self.read_u8()? as usize;
        if n > 0 {
            n -= 1;
        }
        if n > max_len || self.pos + n + 1 > self.data.len() {
            return Err("DataBuffer byteLen string out of bounds".to_string());
        }
        let s = String::from_utf8_lossy(&self.data[self.pos..self.pos + n]).to_string();
        self.pos += n + 1;
        Ok(s)
    }

    fn checksum16(&self) -> i16 {
        let mut sum: i64 = 0;
        for (i, b) in self.data.iter().enumerate() {
            sum += (*b as i64) + (i as i64);
        }
        (sum.abs() % 0x7fff) as i16
    }
}

#[derive(Default)]
struct WebSockMessage {
    msg_type: i16,
    n_val: i32,
    id_sender: i32,
    user_type: i16,
    id_receiver: i32,
    msg_id: i32,
    buf: DataBuffer,
}

impl WebSockMessage {
    fn new(msg_type: SockMsgId) -> Self {
        Self {
            msg_type: msg_type as i16,
            ..Default::default()
        }
    }

    fn from_receive_buf(arr: &[u8]) -> Result<Self, String> {
        if arr.len() < 16 {
            return Err("Illegal message received (too short)".to_string());
        }
        let msg_type = i16::from_be_bytes([arr[0], arr[1]]);
        let n_val = i32::from_be_bytes([arr[2], arr[3], arr[4], arr[5]]);
        let id_sender = i32::from_be_bytes([arr[6], arr[7], arr[8], arr[9]]);
        let user_type = i16::from_be_bytes([arr[10], arr[11]]);
        let id_receiver = i32::from_be_bytes([arr[12], arr[13], arr[14], arr[15]]);

        let mut buf = DataBuffer::default();
        if arr.len() >= 20 {
            let size = i32::from_le_bytes([arr[16], arr[17], arr[18], arr[19]]) as isize;
            if size < 0 || size as usize > 350_000 {
                return Err("Illegal payload size".to_string());
            }
            let size = size as usize;
            if arr.len() < 20 + size {
                return Err("Payload truncated".to_string());
            }
            buf = DataBuffer::from_bytes(arr[20..20 + size].to_vec());
            buf.rewind();
        }

        Ok(Self {
            msg_type,
            n_val,
            id_sender,
            user_type,
            id_receiver,
            msg_id: 0,
            buf,
        })
    }

    fn to_send_buf(&self, with_msg_id: bool, with_checksum: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.buf.data.len());
        out.extend_from_slice(&self.msg_type.to_be_bytes());
        out.extend_from_slice(&self.n_val.to_be_bytes());
        out.extend_from_slice(&self.id_sender.to_be_bytes());
        out.extend_from_slice(&self.user_type.to_be_bytes());
        out.extend_from_slice(&self.id_receiver.to_be_bytes());
        if with_msg_id {
            out.extend_from_slice(&self.msg_id.to_be_bytes());
        }
        out.extend_from_slice(&(self.buf.data.len() as i32).to_le_bytes());
        out.extend_from_slice(&self.buf.data);
        if with_msg_id && with_checksum {
            out.extend_from_slice(&self.buf.checksum16().to_be_bytes());
        }
        out
    }
}

#[derive(Default)]
struct CbGuid {
    data1: u32,
    data2: u16,
    data3: u16,
    data4: [u8; 8],
}

impl CbGuid {
    fn new_random(seed: &str) -> Self {
        use rand::RngCore;
        let mut rng = rand::rngs::OsRng;
        let seed_sum: u32 = seed.bytes().map(|b| b as u32).sum();
        let mut g = Self::default();
        g.data1 = rng.next_u32().wrapping_add(seed_sum);
        g.data2 = (rng.next_u32() as u16).wrapping_add(seed_sum as u16);
        g.data3 = (rng.next_u32() as u16).wrapping_add(seed_sum as u16);
        rng.fill_bytes(&mut g.data4);
        for b in g.data4.iter_mut() {
            *b = b.wrapping_add((seed_sum & 0xff) as u8);
        }
        g
    }

    fn to_data_buf(&self, buf: &mut DataBuffer) {
        buf.write_u32_le(self.data1);
        buf.write_u16_le(self.data2);
        buf.write_u16_le(self.data3);
        for b in self.data4 {
            buf.write_u8(b);
        }
    }
}

struct VersionCode {
    family: i16,
    major: i16,
    minor: i16,
    beta: i16,
}

impl VersionCode {
    fn online_db() -> Self {
        // OnlineDB React reports VersionCodeEnum.JSNLINE (1103), major=5, minor=5, beta=0.
        Self {
            family: 1103,
            major: 5,
            minor: 5,
            beta: 0,
        }
    }

    fn to_data_buf(&self, buf: &mut DataBuffer) {
        buf.write_i16_le(self.family);
        buf.write_i16_le(self.major);
        buf.write_i16_le(self.minor);
        buf.write_i16_le(self.beta);
        buf.write_i16_le(83);
        buf.write_i16_le(0);
        buf.write_i32_le(0);
        buf.write_i16_le(0);
        buf.write_i16_le(0);
    }
}

#[derive(Default)]
struct SearchMask {
    wh_mask: String,
    bl_mask: String,
    title: String,
    place: String,
    free_text: String,
    min_eco: u16,
    max_eco: u16,
    min_year: i32,
    max_year: i32,
    min_white_elo: i32,
    min_black_elo: i32,
    flags: i32,
}

impl SearchMask {
    fn new_quick_search(free_text: String) -> Self {
        // FilterFlagsEnum from SearchMask.js: wins=0x10 draws=0x20 losses=0x40 white=0x100 black=0x200.
        let flags = 0x10 | 0x20 | 0x40 | 0x100 | 0x200;
        Self {
            free_text,
            min_eco: 0,
            max_eco: 0xffff,
            min_year: 0,
            max_year: 3000,
            min_white_elo: 0,
            min_black_elo: 0,
            flags,
            ..Default::default()
        }
    }

    fn write_to(&self, buf: &mut DataBuffer) -> Result<(), String> {
        buf.begin_sized_write();
        buf.write_u8(1);
        buf.write_ascii_string(&self.wh_mask);
        buf.write_ascii_string(&self.bl_mask);
        buf.write_ascii_string(&self.title);
        buf.write_ascii_string(&self.place);
        buf.write_i32_le(self.min_year);
        buf.write_i32_le(self.max_year);
        buf.write_i32_le(self.min_white_elo);
        buf.write_i32_le(self.min_black_elo);
        buf.write_u16_le(self.min_eco);
        buf.write_u16_le(self.max_eco);
        buf.write_i32_le(self.flags);
        buf.write_ascii_string(&self.free_text);
        buf.end_sized_write()?;
        Ok(())
    }
}

#[derive(Debug)]
struct ParsedGameHeader {
    white: String,
    black: String,
    event: String,
    site: String,
    date: (u16, u8, u8),
    result: u8,
}

#[derive(Debug)]
struct ParsedGame {
    header: ParsedGameHeader,
    fen: Option<String>,
    moves: Vec<(u8, u8, Option<char>)>,
}

fn cb_date_from_num(num: i32) -> (u16, u8, u8) {
    let n = num as u32;
    let year = (n >> 9) as u16;
    let month = ((n >> 5) & 0x0f) as u8;
    let day = (n & 0x1f) as u8;
    (year, month, day)
}

fn cb_square_to_coord(idx: u8) -> Result<String, String> {
    let file = (idx >> 3) as u8;
    let rank = (idx & 7) as u8;
    if file > 7 || rank > 7 {
        return Err("Invalid square index".to_string());
    }
    let f = (b'a' + file) as char;
    let r = (b'1' + rank) as char;
    Ok(format!("{f}{r}"))
}

fn castle_rights_to_fen(cr: u8) -> String {
    // CastleRights: W_000=1, W_00=2, B_000=4, B_00=8
    let mut s = String::new();
    if (cr & 2) != 0 {
        s.push('K');
    }
    if (cr & 1) != 0 {
        s.push('Q');
    }
    if (cr & 8) != 0 {
        s.push('k');
    }
    if (cr & 4) != 0 {
        s.push('q');
    }
    if s.is_empty() {
        "-".to_string()
    } else {
        s
    }
}

fn cb_board_to_fen_pieces(board: &[u8]) -> Result<String, String> {
    if board.len() != 64 {
        return Err("Invalid board length".to_string());
    }
    // CB board is file-major: a1..a8 then b1..b8.
    let mut out = String::new();
    for rank in (0..8).rev() {
        let mut empty = 0;
        for file in 0..8 {
            let cb_idx = (file * 8 + rank) as usize;
            let pc = board[cb_idx];
            let ch = match pc {
                0 => None,
                1 => Some('K'),
                2 => Some('Q'),
                3 => Some('N'),
                4 => Some('B'),
                5 => Some('R'),
                6 => Some('P'),
                9 => Some('k'),
                10 => Some('q'),
                11 => Some('n'),
                12 => Some('b'),
                13 => Some('r'),
                14 => Some('p'),
                _ => return Err(format!("Unknown piece code: {pc}")),
            };
            if let Some(ch) = ch {
                if empty > 0 {
                    out.push_str(&empty.to_string());
                    empty = 0;
                }
                out.push(ch);
            } else {
                empty += 1;
            }
        }
        if empty > 0 {
            out.push_str(&empty.to_string());
        }
        if rank != 0 {
            out.push('/');
        }
    }
    Ok(out)
}

fn parse_game_header(buf: &mut DataBuffer) -> Result<ParsedGameHeader, String> {
    let white_last = buf.read_byte_len_ascii_string(50)?.trim().to_string();
    let white_first = buf.read_byte_len_ascii_string(50)?.trim().to_string();
    let black_last = buf.read_byte_len_ascii_string(50)?.trim().to_string();
    let black_first = buf.read_byte_len_ascii_string(50)?.trim().to_string();

    let site = buf.read_byte_len_ascii_string(100)?.trim().to_string();
    let event = buf.read_byte_len_ascii_string(100)?.trim().to_string();
    let _event_dt = buf.read_i32_le()?;
    let _event_type = buf.read_i16_le()?;
    let _nation = buf.read_i16_le()?;
    let _category = buf.read_u8()?;
    let _flags = buf.read_u8()?;
    let _rounds = buf.read_i16_le()?;

    let _source = buf.read_byte_len_ascii_string(100)?;
    let _publisher = buf.read_byte_len_ascii_string(100)?;
    let _pubdt = buf.read_i32_le()?;
    let _verdt = buf.read_i32_le()?;
    let _version = buf.read_u8()?;
    let _quality = buf.read_u8()?;

    let _annotator = buf.read_byte_len_ascii_string(100)?;

    let _elo_wh = buf.read_i16_le()?;
    let _elo_bl = buf.read_i16_le()?;
    let _eco = buf.read_u16_le()?;

    let result = buf.read_u8()?;
    let _ = buf.read_u8()?;
    let _ = buf.read_u8()?;

    let dt = buf.read_i32_le()?;
    let date = cb_date_from_num(dt);
    let _ply_count = buf.read_i16_le()?;
    let _round = buf.read_u8()?;
    let _sub_round = buf.read_u8()?;

    let _ = buf.read_i32_le()?;
    let _ = buf.read_i32_le()?;

    buf.skip_sized_read()?;

    let white = if !white_first.is_empty() && !white_last.is_empty() {
        format!("{white_first} {white_last}")
    } else {
        white_last
    };
    let black = if !black_first.is_empty() && !black_last.is_empty() {
        format!("{black_first} {black_last}")
    } else {
        black_last
    };

    Ok(ParsedGameHeader {
        white,
        black,
        event,
        site,
        date,
        result,
    })
}

fn parse_game(buf: &mut DataBuffer) -> Result<ParsedGame, String> {
    let header = parse_game_header(buf)?;

    let normal_init = buf.read_bool()?;
    let mut fen: Option<String> = None;
    if !normal_init {
        let mut board = vec![0u8; 64];
        for i in 0..64 {
            board[i] = buf.read_u8()?;
        }
        let sd = buf.read_i32_le()?;
        let ep = buf.read_u8()? as i16 - 1;
        let cr = buf.read_u8()?;

        // reserved shorts and moveno
        let _ = buf.read_i16_le()?;
        let _ = buf.read_i16_le()?;

        let normal_init2 = buf.read_bool()?;
        if !normal_init2 {
            let pieces = cb_board_to_fen_pieces(&board)?;
            let side = if sd == 0 { "w" } else { "b" };
            let castling = castle_rights_to_fen(cr);
            let ep_sq = if ep >= 0 {
                cb_square_to_coord(ep as u8)?
            } else {
                "-".to_string()
            };
            fen = Some(format!("{pieces} {side} {castling} {ep_sq} 0 1"));
        }
    }

    let cnt_anno = buf.read_u8()?;
    if cnt_anno != 0 {
        return Err("ChessBase annotations are not supported yet".to_string());
    }

    let mut line_len = buf.read_u8()? as u16;
    if (line_len & 0x80) != 0 {
        let b2 = buf.read_u8()? as u16;
        line_len = (((line_len << 8) | b2) & 0x7fff) as u16;
    }
    if line_len > 0x800 {
        return Err("ChessBase line too long".to_string());
    }

    let mut moves = Vec::with_capacity(line_len as usize);
    for _ in 0..line_len {
        let from_raw = buf.read_u8()?;
        let to_raw = buf.read_u8()?;
        let from = from_raw & 0x3f;
        let to = to_raw & 0x3f;

        let mut prom: Option<char> = None;
        if (from_raw & 0xc0) == 0x40 {
            let prom_code = (to_raw >> 6) & 0x03;
            prom = Some(match prom_code {
                0 => 'q',
                1 => 'n',
                2 => 'b',
                3 => 'r',
                _ => 'q',
            });
        }

        let flags = buf.read_u8()?;
        if flags != 0 {
            return Err("ChessBase variations/annotations are not supported yet".to_string());
        }
        moves.push((from, to, prom));
    }

    Ok(ParsedGame { header, fen, moves })
}

fn result_to_pgn(result: u8) -> &'static str {
    match result {
        0 => "0-1",
        1 => "1/2-1/2",
        2 => "1-0",
        _ => "*",
    }
}

fn escape_pgn_tag_value(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn game_to_pgn_text(game: &ParsedGame) -> Result<String, String> {
    let (y, m, d) = game.header.date;
    let date = if y == 0 {
        "????.??.??".to_string()
    } else {
        format!("{:04}.{:02}.{:02}", y, m, d)
    };
    let result = result_to_pgn(game.header.result);

    let mut pos: Chess = if let Some(fen) = &game.fen {
        let fen: Fen = fen.parse().map_err(|e| format!("Invalid FEN: {e}"))?;
        fen.into_position(CastlingMode::Standard)
            .map_err(|e| format!("Invalid position: {e}"))?
    } else {
        Chess::default()
    };
    let starts_white = pos.turn() == shakmaty::Color::White;

    let mut sans: Vec<String> = Vec::with_capacity(game.moves.len());
    for (from, to, prom) in &game.moves {
        let mut uci = format!("{}{}", cb_square_to_coord(*from)?, cb_square_to_coord(*to)?);
        if let Some(p) = prom {
            uci.push(*p);
        }
        let uci: Uci = uci.parse().map_err(|e| format!("Invalid UCI: {e}"))?;
        let mv = uci.to_move(&pos).map_err(|e| format!("Illegal move: {e}"))?;
        let san = San::from_move(&pos, &mv);
        pos = pos.play(&mv).map_err(|e| format!("Failed to play move: {e}"))?;
        sans.push(san.to_string());
    }

    let mut out = String::new();
    let site_tag = "database.chessbase.com";
    let tags = [
        ("Event", game.header.event.as_str()),
        ("Site", site_tag),
        ("Date", date.as_str()),
        ("White", game.header.white.as_str()),
        ("Black", game.header.black.as_str()),
        ("Result", result),
    ];
    for (k, v) in tags {
        out.push_str(&format!("[{} \"{}\"]\n", k, escape_pgn_tag_value(v)));
    }
    if let Some(fen) = &game.fen {
        out.push_str(&format!("[FEN \"{}\"]\n", escape_pgn_tag_value(fen)));
        out.push_str("[SetUp \"1\"]\n");
    }
    out.push('\n');

    let mut move_no: u32 = 1;
    let mut idx = 0usize;
    if !starts_white && !sans.is_empty() {
        out.push_str(&format!("{}... {}", move_no, sans[0]));
        idx = 1;
        move_no += 1;
        if idx < sans.len() {
            out.push(' ');
        }
    }
    while idx < sans.len() {
        out.push_str(&format!("{}. {}", move_no, sans[idx]));
        idx += 1;
        if idx < sans.len() {
            out.push(' ');
            out.push_str(&sans[idx]);
            idx += 1;
        }
        move_no += 1;
        if idx < sans.len() {
            out.push(' ');
        }
    }
    if !out.ends_with(' ') {
        out.push(' ');
    }
    out.push_str(result);
    Ok(out)
}

struct ActiveDownload {
    respond_to: oneshot::Sender<Result<ChessbaseDownloadResult, String>>,
    max_games: u32,
    games: Vec<ParsedGame>,
    pending_ids: Vec<u32>,
    batch_expected: usize,
    batch_received: usize,
}

struct ActiveCount {
    respond_to: oneshot::Sender<Result<ChessbaseQuickSearchCount, String>>,
}

fn build_logon_message(username: &str, password: &str, mode: LoginMode, has_sock_ids: bool) -> Vec<u8> {
    let mut msg = WebSockMessage::new(SockMsgId::Logon);
    msg.id_sender = 0;
    msg.id_receiver = 1;

    msg.buf.write_i32_le(mode as i32);
    VersionCode::online_db().to_data_buf(&mut msg.buf);
    msg.buf.write_utf_string(username);
    msg.buf.write_utf_string(password);
    CbGuid::new_random("OnlineDB").to_data_buf(&mut msg.buf);
    msg.buf.write_ascii_string("en");
    msg.buf.write_ascii_string("Windows");
    msg.buf.write_i32_le(0);
    msg.buf.write_utf_string("");
    msg.buf.write_ascii_string("");
    msg.buf.write_utf_string("");
    msg.buf.write_ascii_string("");
    let flags = if has_sock_ids { 128 } else { 0 };
    msg.buf.write_i32_le(flags);
    msg.buf.write_ascii_string("OCS");
    msg.buf.write_ascii_string("");

    // LOGON is sent without msgId/checksum.
    msg.to_send_buf(false, false)
}

async fn start_ws_session(username: String, password: String) -> Arc<ChessbaseWsSession> {
    let (requests_tx, mut requests_rx) = mpsc::unbounded_channel();
    let (ready_tx, ready_rx) = watch::channel(false);
    let last_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let session = Arc::new(ChessbaseWsSession {
        username: username.clone(),
        requests_tx,
        ready_rx,
        last_error: Arc::clone(&last_error),
    });

    tauri::async_runtime::spawn(async move {
        let res = run_ws_session(username, password, &mut requests_rx, ready_tx, Arc::clone(&last_error)).await;
        if let Err(e) = res {
            *last_error.lock().await = Some(e);
        }
    });

    session
}

async fn run_ws_session(
    username: String,
    password: String,
    requests_rx: &mut mpsc::UnboundedReceiver<ChessbaseWsRequest>,
    ready_tx: watch::Sender<bool>,
    last_error: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    let ws_stream = connect_chessbase_ws()
        .await
        .map_err(|e| format!("Failed to connect to ChessBase websocket: {e}"))?;
    let (mut ws_write, mut ws_read) = ws_stream.split();
    *last_error.lock().await = None;

    let mut connect_id: i32 = 0;
    let mut msg_cnt: i32 = 0;
    let mut ready = false;
    let mut active_download: Option<ActiveDownload> = None;
    let mut active_count: Option<ActiveCount> = None;
    let mut login_phase: &'static str = "connecting";
    let mut login_timeout = tokio::time::sleep(std::time::Duration::from_secs(20));
    tokio::pin!(login_timeout);

    let logon = build_logon_message(&username, &password, LoginMode::Normal, true);
    ws_write
        .send(Message::Binary(logon))
        .await
        .map_err(|e| format!("Failed to send LOGON: {e}"))?;

    loop {
        tokio::select! {
            _ = &mut login_timeout, if !ready => {
                let _ = ready_tx.send(false);
                return Err(format!("ChessBase login timed out (phase={login_phase})"));
            }
            req = requests_rx.recv() => {
                match req {
                    Some(ChessbaseWsRequest::Shutdown) | None => {
                        let _ = ready_tx.send(false);
                        return Ok(());
                    }
                    Some(ChessbaseWsRequest::DownloadByQuickSearch { query, max_games, respond_to }) => {
                        if !ready {
                            let _ = respond_to.send(Err("ChessBase session is not ready yet".to_string()));
                            continue;
                        }
                        if active_download.is_some() || active_count.is_some() {
                            let _ = respond_to.send(Err("Another ChessBase download is already in progress".to_string()));
                            continue;
                        }
                        let max_games = max_games.max(1).min(MAX_GAMES_PER_QUERY);

                        let search_mask = SearchMask::new_quick_search(query);
                        let mut msg = WebSockMessage::new(SockMsgId::QueryOnlineDb);
                        msg.id_sender = connect_id;
                        msg.id_receiver = 1;
                        msg.msg_id = { msg_cnt += 1; msg_cnt };
                        search_mask.write_to(&mut msg.buf)?;

                        let out = msg.to_send_buf(true, true);
                        ws_write.send(Message::Binary(out)).await.map_err(|e| format!("Failed to send search: {e}"))?;
                        active_download = Some(ActiveDownload{
                            respond_to,
                            max_games,
                            games: vec![],
                            pending_ids: vec![],
                            batch_expected: 0,
                            batch_received: 0,
                        });
                    }
                    Some(ChessbaseWsRequest::CountByQuickSearch { query, respond_to }) => {
                        if !ready {
                            let _ = respond_to.send(Err("ChessBase session is not ready yet".to_string()));
                            continue;
                        }
                        if active_download.is_some() || active_count.is_some() {
                            let _ = respond_to.send(Err("Another ChessBase request is already in progress".to_string()));
                            continue;
                        }

                        let search_mask = SearchMask::new_quick_search(query);
                        let mut msg = WebSockMessage::new(SockMsgId::QueryOnlineDb);
                        msg.id_sender = connect_id;
                        msg.id_receiver = 1;
                        msg.msg_id = { msg_cnt += 1; msg_cnt };
                        search_mask.write_to(&mut msg.buf)?;

                        let out = msg.to_send_buf(true, true);
                        ws_write.send(Message::Binary(out)).await.map_err(|e| format!("Failed to send search: {e}"))?;
                        active_count = Some(ActiveCount { respond_to });
                    }
                }
            }
            incoming = ws_read.next() => {
                let msg = match incoming {
                    Some(Ok(Message::Binary(b))) => b,
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Err(format!("ChessBase websocket error: {e}")),
                    None => return Err("ChessBase websocket closed".to_string()),
                };

                let mut sock = WebSockMessage::from_receive_buf(&msg)?;

                match sock.msg_type {
                    x if x == SockMsgId::YourId as i16 => {
                        login_phase = "your_id";
                        // YourIdData.fromSocketsMsg:
                        // int32 defaultGroup, int32 broadcastGroup, int32 nId, int32 cmsArchiv,
                        // ASCII token, int16 accountType, ASCII userId, int32 flags
                        let _ = sock.buf.read_i32_le()?;
                        let _ = sock.buf.read_i32_le()?;
                        connect_id = sock.buf.read_i32_le()?;
                        let _ = sock.buf.read_i32_le()?;
                        let _ = sock.buf.read_ascii_string(200)?;
                        let _ = sock.buf.read_i16_le()?;
                        let _ = sock.buf.read_ascii_string(200)?;
                        let _ = sock.buf.read_i32_le()?;
                    }
                    x if x == SockMsgId::DefaultGroups as i16 => {
                        login_phase = "default_groups";
                        // OnlineLobby requests user info on DEFAULTGROUPS.
                        let mut req_info = WebSockMessage::new(SockMsgId::RequestOnlineDbUserInfo);
                        req_info.id_sender = connect_id;
                        req_info.id_receiver = 1;
                        req_info.msg_id = { msg_cnt += 1; msg_cnt };
                        let out = req_info.to_send_buf(true, true);
                        ws_write.send(Message::Binary(out)).await.map_err(|e| format!("Failed to request user info: {e}"))?;
                    }
                    x if x == SockMsgId::OnlineDbUserInfo as i16 => {
                        login_phase = "user_info";
                        if !ready {
                            ready = true;
                            let _ = ready_tx.send(true);
                        }
                    }
                    x if x == SockMsgId::OnlineDbNumbers as i16 => {
                        if let Some(active) = active_count.take() {
                            let returned = sock.buf.read_u32_le()?;
                            let total = sock.buf.read_u32_le()?;
                            let _ = active.respond_to.send(Ok(ChessbaseQuickSearchCount { returned, total }));
                            continue;
                        }
                        if let Some(active) = active_download.as_mut() {
                            let n_games = sock.buf.read_u32_le()? as usize;
                            let _total = sock.buf.read_u32_le()?;
                            let mut ids = Vec::new();
                            for _ in 0..n_games {
                                let id = sock.buf.read_u32_le()?;
                                if id > 0 && ids.len() < active.max_games as usize {
                                    ids.push(id);
                                }
                            }
                            if ids.is_empty() {
                                let active = active_download.take().unwrap();
                                let _ = active.respond_to.send(Err("No games found".to_string()));
                                continue;
                            }
                            active.pending_ids = ids;
                            active.batch_received = 0;
                            active.batch_expected =
                                send_next_games_batch(active, connect_id, &mut msg_cnt, &mut ws_write).await?;
                        }
                    }
                    x if x == SockMsgId::OnlineDbGames as i16 => {
                        if let Some(active) = active_download.as_mut() {
                            let n_read = sock.buf.read_u32_le()? as usize;
                            for _ in 0..n_read {
                                sock.buf.begin_sized_read()?;
                                let _game_no = sock.buf.read_u32_le()?;
                                let game = parse_game(&mut sock.buf)?;
                                sock.buf.end_sized_read()?;
                                active.games.push(game);
                            }
                            active.batch_received = active.batch_received.saturating_add(n_read);

                            // A batch response can be split into multiple OnlineDbGames messages.
                            // Only proceed once we've received the full batch we requested.
                            if active.batch_expected > 0 && active.batch_received < active.batch_expected {
                                continue;
                            }
                            active.batch_expected = 0;
                            active.batch_received = 0;

                            if !active.pending_ids.is_empty() && active.games.len() < active.max_games as usize {
                                active.batch_expected =
                                    send_next_games_batch(active, connect_id, &mut msg_cnt, &mut ws_write).await?;
                                continue;
                            }

                            let active = active_download.take().unwrap();
                            let mut pgn = String::new();
                            let mut ok_games = 0u32;
                            for g in &active.games {
                                if let Ok(txt) = game_to_pgn_text(g) {
                                    if !pgn.is_empty() {
                                        pgn.push_str("\n\n");
                                    }
                                    pgn.push_str(&txt);
                                    ok_games += 1;
                                }
                            }
                            let _ = active.respond_to.send(Ok(ChessbaseDownloadResult { pgn, games: ok_games }));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn send_next_games_batch(
    active: &mut ActiveDownload,
    connect_id: i32,
    msg_cnt: &mut i32,
    ws_write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
) -> Result<usize, String> {
    let batch_len = active.pending_ids.len().min(MAX_GAMES_PER_BATCH);
    let batch: Vec<u32> = active.pending_ids.drain(..batch_len).collect();
    if batch.is_empty() {
        return Ok(0);
    }

    let mut req_games = WebSockMessage::new(SockMsgId::RequestOnlineDbGames);
    req_games.n_val = 2;
    req_games.id_sender = connect_id;
    req_games.id_receiver = 1;
    req_games.msg_id = { *msg_cnt += 1; *msg_cnt };
    req_games.buf.write_u32_le(batch.len() as u32);
    for id in batch {
        req_games.buf.write_u32_le(id);
    }
    let out = req_games.to_send_buf(true, true);
    ws_write
        .send(Message::Binary(out))
        .await
        .map_err(|e| format!("Failed to request games: {e}"))?;
    Ok(batch_len)
}

async fn connect_chessbase_ws(
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    // Some websocket servers require an Origin header (browser-like). If it fails, fall back to the plain connect.
    let mut req = CHESSBASE_WS_URL
        .into_client_request()
        .map_err(|e| format!("Failed to build websocket request: {e}"))?;
    req.headers_mut().insert(
        "Origin",
        HeaderValue::from_static("https://database.chessbase.com"),
    );
    req.headers_mut().insert(
        "User-Agent",
        HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) OCS/1.0",
        ),
    );

    match tokio_tungstenite::connect_async(req).await {
        Ok((ws, _)) => Ok(ws),
        Err(e) => {
            // If we got an HTTP response, include the status/headers for debugging.
            let extra = match &e {
                WsError::Http(resp) => format!(" (http status={}, headers={:?})", resp.status(), resp.headers()),
                _ => String::new(),
            };

            // Fallback: plain connect (no explicit headers).
            match tokio_tungstenite::connect_async(CHESSBASE_WS_URL).await {
                Ok((ws, _)) => Ok(ws),
                Err(e2) => Err(format!("{e}{extra}; fallback failed: {e2}")),
            }
        }
    }
}

async fn ensure_session(state: &crate::AppState) -> Result<Arc<ChessbaseWsSession>, String> {
    let creds = load_credentials()?.ok_or("No ChessBase credentials stored")?;

    let mut ws = state.chessbase_ws.lock().await;
    let needs_new = match ws.session.as_ref() {
        None => true,
        Some(s) if s.username != creds.username => true,
        Some(s) => s.last_error.lock().await.is_some(),
    };

    if needs_new {
        if let Some(old) = ws.session.take() {
            let _ = old.requests_tx.send(ChessbaseWsRequest::Shutdown);
        }
        ws.session = Some(start_ws_session(creds.username.clone(), creds.password).await);
    }

    Ok(ws
        .session
        .as_ref()
        .ok_or("ChessBase session not initialized")?
        .clone())
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_get_credentials() -> Result<ChessbaseCredentialsSummary, String> {
    let creds = load_credentials()?;
    Ok(ChessbaseCredentialsSummary {
        username: creds.as_ref().map(|c| c.username.clone()),
        has_password: creds.is_some(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_set_credentials(username: String, password: String) -> Result<(), String> {
    save_credentials(username, password)
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_clear_credentials(state: State<'_, crate::AppState>) -> Result<(), String> {
    {
        let mut ws = state.chessbase_ws.lock().await;
        if let Some(session) = ws.session.take() {
            let _ = session.requests_tx.send(ChessbaseWsRequest::Shutdown);
        }
    }
    delete_credentials()
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_login_background(state: State<'_, crate::AppState>) -> Result<ChessbaseSessionStatus, String> {
    let session = ensure_session(state.inner()).await?;
    let mut connected = *session.ready_rx.borrow();

    if !connected && session.last_error.lock().await.is_none() {
        let mut rx = session.ready_rx.clone();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(LOGIN_WAIT_SECS), rx.changed()).await;
        connected = *session.ready_rx.borrow();
    }

    let last_error = session.last_error.lock().await.clone();
    let state_str = if connected {
        "ready"
    } else if last_error.is_some() {
        "error"
    } else {
        "connecting"
    };

    Ok(ChessbaseSessionStatus {
        connected,
        username: Some(session.username.clone()),
        state: state_str.to_string(),
        last_error,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_download_games_quick_search(
    state: State<'_, crate::AppState>,
    query: String,
    max_games: u32,
) -> Result<ChessbaseDownloadResult, String> {
    let session = ensure_session(state.inner()).await?;
    if !*session.ready_rx.borrow() {
        return Err("ChessBase session is not ready yet".to_string());
    }

    let (tx, rx) = oneshot::channel();
    session
        .requests_tx
        .send(ChessbaseWsRequest::DownloadByQuickSearch {
            query,
            max_games,
            respond_to: tx,
        })
        .map_err(|_| "ChessBase session unavailable".to_string())?;

    rx.await.map_err(|_| "ChessBase request canceled".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_quick_search_count(
    state: State<'_, crate::AppState>,
    query: String,
) -> Result<ChessbaseQuickSearchCount, String> {
    let session = ensure_session(state.inner()).await?;
    if !*session.ready_rx.borrow() {
        return Err("ChessBase session is not ready yet".to_string());
    }

    let (tx, rx) = oneshot::channel();
    session
        .requests_tx
        .send(ChessbaseWsRequest::CountByQuickSearch { query, respond_to: tx })
        .map_err(|_| "ChessBase session unavailable".to_string())?;

    rx.await.map_err(|_| "ChessBase request canceled".to_string())?
}

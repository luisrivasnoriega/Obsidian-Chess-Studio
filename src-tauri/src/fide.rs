use std::{
    fs::{remove_file, File},
    io::{BufReader, BufWriter},
    path::{Path, PathBuf},
};

use bincode::{config, Decode, Encode};
use quick_xml::de::from_reader;
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use strsim::{jaro_winkler, sorensen_dice};
use tauri::{path::BaseDirectory, Manager};
use tauri_specta::Event;

use crate::{error::Error, fs::DownloadProgress};
use crate::{fs::download_file, AppState};

#[derive(Debug, Deserialize, Serialize, Type, Clone, Decode, Encode)]
pub struct FidePlayer {
    pub fideid: u32,
    pub name: String,
    pub country: String,
    pub sex: String,
    #[serde(deserialize_with = "empty_string_is_none")]
    pub title: Option<String>,
    #[serde(deserialize_with = "empty_string_is_none")]
    pub w_title: Option<String>,
    #[serde(deserialize_with = "empty_string_is_none")]
    pub o_title: Option<String>,
    #[serde(deserialize_with = "empty_string_is_none")]
    pub foa_title: Option<String>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub rating: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub games: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub k: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub rapid_rating: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub rapid_games: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub rapid_k: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub blitz_rating: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub blitz_games: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub blitz_k: Option<u16>,
    #[serde(deserialize_with = "deserialize_option_u16")]
    pub birthday: Option<u16>,
    #[serde(deserialize_with = "empty_string_is_none")]
    pub flag: Option<String>,
}

fn empty_string_is_none<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let s = String::deserialize(deserializer)?;
    if s.is_empty() {
        Ok(None)
    } else {
        Ok(Some(s))
    }
}

fn deserialize_option_u16<'de, D>(deserializer: D) -> Result<Option<u16>, D::Error>
where
    D: Deserializer<'de>,
{
    // If parsing fails (e.g. empty string), treat as None.
    Ok(Option::deserialize(deserializer).unwrap_or(None))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct PlayersList {
    #[serde(rename = "player")]
    pub players: Vec<FidePlayer>,
}

// -----------------------------
// Internal helpers (testable)
// -----------------------------

fn fide_bin_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    Ok(app.path().resolve("fide.bin", BaseDirectory::AppData)?)
}

fn fide_xml_path(app: &tauri::AppHandle) -> Result<PathBuf, Error> {
    Ok(app
        .path()
        .resolve("players_list_xml_foa.xml", BaseDirectory::AppData)?)
}

fn decode_fide_players_from_bin(path: &Path) -> Result<Vec<FidePlayer>, Error> {
    let config = config::standard();
    let f = File::open(path)?;
    Ok(bincode::decode_from_reader(BufReader::new(f), config)?)
}

fn best_match_player<'a>(query: &str, players: &'a [FidePlayer]) -> Option<(&'a FidePlayer, f64)> {
    let mut best: Option<(&FidePlayer, f64)> = None;

    for p in players.iter() {
        let sorenson_score = sorensen_dice(query, &p.name);
        let jaro_score = jaro_winkler(query, &p.name);
        let score = sorenson_score.max(jaro_score);

        match best {
            None => best = Some((p, score)),
            Some((_, best_score)) if score > best_score => best = Some((p, score)),
            _ => {}
        }
    }

    best
}

fn find_fide_player_in_list(query: &str, players: &[FidePlayer]) -> Result<FidePlayer, Error> {
    let Some((p, score)) = best_match_player(query, players) else {
        return Err(Error::NoMatchFound);
    };

    if score > 0.8 {
        Ok(p.clone())
    } else {
        Err(Error::NoMatchFound)
    }
}

async fn save_fide_photo_to_dir(
    fide_id: &str,
    photo_data: &str,
    app_data_dir: &Path,
) -> Result<PathBuf, String> {
    use base64::{engine::general_purpose, Engine as _};
    use log::error;
    use std::fs;

    // Create fide-photos directory
    let photos_dir = app_data_dir.join("fide-photos");
    fs::create_dir_all(&photos_dir).map_err(|e| {
        let err_msg = format!("Failed to create photos directory: {}", e);
        error!("save_fide_photo: {}", err_msg);
        err_msg
    })?;

    let photo_path = photos_dir.join(format!("{}.jpg", fide_id));

    // Check if photo_data is a data URI (base64) or a URL
    if photo_data.starts_with("data:image") {
        let base64_data = photo_data.split(',').nth(1).ok_or_else(|| {
            let err_msg = "Invalid base64 data URI - no comma found".to_string();
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;

        let image_bytes = general_purpose::STANDARD.decode(base64_data).map_err(|e| {
            let err_msg = format!("Failed to decode base64: {}", e);
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;

        fs::write(&photo_path, image_bytes).map_err(|e| {
            let err_msg = format!("Failed to write photo file: {}", e);
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;
    } else if photo_data.starts_with("http") {
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| {
                let err_msg = format!("Failed to create HTTP client: {}", e);
                error!("save_fide_photo: {}", err_msg);
                err_msg
            })?;

        let response = client.get(photo_data).send().await.map_err(|e| {
            let err_msg = format!("Failed to download photo: {}", e);
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;

        if !response.status().is_success() {
            let err_msg = format!("Photo download failed with status: {}", response.status());
            error!("save_fide_photo: {}", err_msg);
            return Err(err_msg);
        }

        let bytes = response.bytes().await.map_err(|e| {
            let err_msg = format!("Failed to read photo bytes: {}", e);
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;

        fs::write(&photo_path, bytes).map_err(|e| {
            let err_msg = format!("Failed to write photo file: {}", e);
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?;
    } else {
        let err_msg = format!(
            "Invalid photo data format. Starts with: {}",
            &photo_data[..photo_data.len().min(50)]
        );
        error!("save_fide_photo: {}", err_msg);
        return Err(err_msg);
    }

    Ok(photo_path)
}

// -----------------------------
// Tauri commands
// -----------------------------

#[tauri::command]
#[specta::specta]
pub async fn download_fide_db(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), Error> {
    let fide_path = fide_bin_path(&app)?;

    download_file(
        "fide_db".to_string(),
        "http://ratings.fide.com/download/players_list_xml.zip".to_string(),
        app.path().config_dir().unwrap(),
        app.clone(),
        None,
        Some(false),
        None,
    )
    .await?;

    let xml_path = fide_xml_path(&app)?;
    let reader = BufReader::new(File::open(&xml_path)?);
    let players_list: PlayersList = from_reader(reader)?;

    let mut out_file = BufWriter::new(File::create(&fide_path)?);
    bincode::encode_into_std_write(&players_list.players, &mut out_file, config::standard())?;

    let mut fide_players = state.fide_players.write().await;
    *fide_players = players_list.players;

    DownloadProgress {
        progress: 100.0,
        id: "fide_db".to_string(),
        finished: true,
    }
    .emit(&app)?;

    remove_file(&xml_path)?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn find_fide_player(
    player: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<Option<FidePlayer>, Error> {
    let fide_players = state.fide_players.read().await;

    if fide_players.is_empty() {
        drop(fide_players);

        let fide_path = fide_bin_path(&app)?;
        if let Ok(players) = decode_fide_players_from_bin(&fide_path) {
            let mut fide_players = state.fide_players.write().await;
            *fide_players = players;
        }
    }

    let fide_players = state.fide_players.read().await;
    let found = find_fide_player_in_list(&player, &fide_players)?;
    Ok(Some(found))
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_fide_profile_html(fide_id: String) -> Result<String, String> {
    let url = format!("https://ratings.fide.com/profile/{}", fide_id);

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch FIDE profile: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP error: {}", response.status()));
    }

    let html = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(html)
}

/// Save a FIDE profile photo (either from URL or base64 data) to local storage
/// Returns the local file path
#[tauri::command]
#[specta::specta]
pub async fn save_fide_photo(
    fide_id: String,
    photo_data: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    use log::error;

    let app_data_dir = app.path().app_data_dir().map_err(|e| {
        let err_msg = format!("Failed to get app data directory: {}", e);
        error!("save_fide_photo: {}", err_msg);
        err_msg
    })?;

    let photo_path = save_fide_photo_to_dir(&fide_id, &photo_data, &app_data_dir).await?;

    let path_str = photo_path
        .to_str()
        .ok_or_else(|| {
            let err_msg = "Failed to convert path to string".to_string();
            error!("save_fide_photo: {}", err_msg);
            err_msg
        })?
        .to_string();

    Ok(path_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Cursor, time::SystemTime};

    fn unique_suffix() -> String {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{}_{}", std::process::id(), nanos)
    }

    fn temp_dir(test_name: &str) -> PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("ocs_test_{}_{}", test_name, unique_suffix()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    fn cleanup_dir(path: &Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    fn minimal_player_xml(
        title: &str,
        rating: &str,
        birthday: &str,
        flag: &str,
        name: &str,
    ) -> String {
        // Provide all fields required by FidePlayer.
        // numeric option fields are intentionally strings; empty should become None via deserialize_option_u16.
        format!(
            r#"
            <player>
              <fideid>123</fideid>
              <name>{name}</name>
              <country>NOR</country>
              <sex>M</sex>
              <title>{title}</title>
              <w_title></w_title>
              <o_title></o_title>
              <foa_title></foa_title>
              <rating>{rating}</rating>
              <games></games>
              <k></k>
              <rapid_rating></rapid_rating>
              <rapid_games></rapid_games>
              <rapid_k></rapid_k>
              <blitz_rating></blitz_rating>
              <blitz_games></blitz_games>
              <blitz_k></blitz_k>
              <birthday>{birthday}</birthday>
              <flag>{flag}</flag>
            </player>
            "#
        )
    }

    #[test]
    fn xml_deserialize_empty_string_fields_become_none() {
        let xml = minimal_player_xml("", "", "", "", "Test Player");
        let player: FidePlayer = from_reader(Cursor::new(xml)).unwrap();

        assert_eq!(player.title, None);
        assert_eq!(player.flag, None);

        // Empty numeric should be None
        assert_eq!(player.rating, None);
        assert_eq!(player.birthday, None);
    }

    #[test]
    fn xml_deserialize_non_empty_fields_become_some() {
        let xml = minimal_player_xml("GM", "2500", "1990", "🇳🇴", "Magnus Carlsen");
        let player: FidePlayer = from_reader(Cursor::new(xml)).unwrap();

        assert_eq!(player.title.as_deref(), Some("GM"));
        assert_eq!(player.rating, Some(2500));
        assert_eq!(player.birthday, Some(1990));
        assert_eq!(player.flag.as_deref(), Some("🇳🇴"));
    }

    #[test]
    fn players_list_parses_multiple_players() {
        let p1 = minimal_player_xml("IM", "2400", "2000", "", "Alpha Player");
        let p2 = minimal_player_xml("", "", "", "", "Beta Player");

        let xml = format!(
            r#"<playerslist>
                {p1}
                {p2}
               </playerslist>"#
        );

        let list: PlayersList = from_reader(Cursor::new(xml)).unwrap();
        assert_eq!(list.players.len(), 2);
        assert_eq!(list.players[0].name, "Alpha Player");
        assert_eq!(list.players[1].name, "Beta Player");
    }

    #[test]
    fn bincode_roundtrip_vec_players() {
        let players = vec![
            FidePlayer {
                fideid: 1,
                name: "One".into(),
                country: "MEX".into(),
                sex: "M".into(),
                title: Some("GM".into()),
                w_title: None,
                o_title: None,
                foa_title: None,
                rating: Some(2500),
                games: None,
                k: None,
                rapid_rating: None,
                rapid_games: None,
                rapid_k: None,
                blitz_rating: None,
                blitz_games: None,
                blitz_k: None,
                birthday: Some(1990),
                flag: None,
            },
            FidePlayer {
                fideid: 2,
                name: "Two".into(),
                country: "USA".into(),
                sex: "F".into(),
                title: None,
                w_title: Some("WIM".into()),
                o_title: None,
                foa_title: None,
                rating: None,
                games: None,
                k: None,
                rapid_rating: None,
                rapid_games: None,
                rapid_k: None,
                blitz_rating: None,
                blitz_games: None,
                blitz_k: None,
                birthday: None,
                flag: Some("US".into()),
            },
        ];

        let cfg = config::standard();
        let bytes = bincode::encode_to_vec(&players, cfg).unwrap();
        let (decoded, _len): (Vec<FidePlayer>, usize) = bincode::decode_from_slice(&bytes, cfg).unwrap();

        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].fideid, 1);
        assert_eq!(decoded[0].title.as_deref(), Some("GM"));
        assert_eq!(decoded[1].w_title.as_deref(), Some("WIM"));
        assert_eq!(decoded[1].flag.as_deref(), Some("US"));
    }

    #[test]
    fn best_match_selects_highest_scoring_player() {
        let players = vec![
            FidePlayer {
                fideid: 1,
                name: "Magnus Carlsen".into(),
                country: "NOR".into(),
                sex: "M".into(),
                title: None,
                w_title: None,
                o_title: None,
                foa_title: None,
                rating: None,
                games: None,
                k: None,
                rapid_rating: None,
                rapid_games: None,
                rapid_k: None,
                blitz_rating: None,
                blitz_games: None,
                blitz_k: None,
                birthday: None,
                flag: None,
            },
            FidePlayer {
                fideid: 2,
                name: "Maximilian Carlsson".into(),
                country: "SWE".into(),
                sex: "M".into(),
                title: None,
                w_title: None,
                o_title: None,
                foa_title: None,
                rating: None,
                games: None,
                k: None,
                rapid_rating: None,
                rapid_games: None,
                rapid_k: None,
                blitz_rating: None,
                blitz_games: None,
                blitz_k: None,
                birthday: None,
                flag: None,
            },
        ];

        let (p, score) = best_match_player("Magnus Carl", &players).unwrap();
        assert_eq!(p.fideid, 1);
        assert!(score > 0.8);
    }

    #[test]
    fn find_player_returns_err_when_below_threshold() {
        let players = vec![FidePlayer {
            fideid: 1,
            name: "Completely Different".into(),
            country: "NOR".into(),
            sex: "M".into(),
            title: None,
            w_title: None,
            o_title: None,
            foa_title: None,
            rating: None,
            games: None,
            k: None,
            rapid_rating: None,
            rapid_games: None,
            rapid_k: None,
            blitz_rating: None,
            blitz_games: None,
            blitz_k: None,
            birthday: None,
            flag: None,
        }];

        let err = find_fide_player_in_list("zzzzzz", &players).unwrap_err();
        match err {
            Error::NoMatchFound => {}
            other => panic!("expected NoMatchFound, got {:?}", other),
        }
    }

    #[test]
    fn decode_from_bin_file_works() {
        let dir = temp_dir("decode_from_bin_file_works");
        let path = dir.join("fide.bin");

        let players = vec![FidePlayer {
            fideid: 10,
            name: "Bin Player".into(),
            country: "MEX".into(),
            sex: "M".into(),
            title: None,
            w_title: None,
            o_title: None,
            foa_title: None,
            rating: Some(2000),
            games: None,
            k: None,
            rapid_rating: None,
            rapid_games: None,
            rapid_k: None,
            blitz_rating: None,
            blitz_games: None,
            blitz_k: None,
            birthday: None,
            flag: None,
        }];

        let cfg = config::standard();
        let bytes = bincode::encode_to_vec(&players, cfg).unwrap();
        std::fs::write(&path, bytes).unwrap();

        let decoded = decode_fide_players_from_bin(&path).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].fideid, 10);
        assert_eq!(decoded[0].rating, Some(2000));

        cleanup_dir(&dir);
    }

    #[test]
    fn save_fide_photo_base64_writes_file_and_returns_path() {
        use base64::Engine;
        // Avoid requiring tokio in dev-deps by using Tauri runtime helper.
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("save_fide_photo_base64_writes_file_and_returns_path");

            let bytes = vec![1u8, 2, 3, 4, 5, 6, 7];
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let data_uri = format!("data:image/jpeg;base64,{}", b64);

            let out = save_fide_photo_to_dir("12345", &data_uri, &dir).await.unwrap();
            assert!(out.exists());

            let written = std::fs::read(&out).unwrap();
            assert_eq!(written, bytes);

            cleanup_dir(&dir);
        });
    }

    #[test]
    fn save_fide_photo_invalid_format_errors() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("save_fide_photo_invalid_format_errors");

            let err = save_fide_photo_to_dir("12345", "not-a-url-or-data-uri", &dir)
                .await
                .unwrap_err();

            assert!(err.contains("Invalid photo data format"));

            cleanup_dir(&dir);
        });
    }
}

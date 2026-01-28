use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State};

use crate::{chessbase, db, AppState};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChessbasePreparedDownload {
    pub query: String,
    pub max_games: u32,
    pub downloaded_games: u32,
}

#[derive(Debug, Clone)]
pub struct ChessbaseCachedDownload {
    pub query: String,
    pub max_games: u32,
    pub downloaded_games: u32,
    pub pgn: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChessbaseImportPreparedResult {
    pub downloaded_games: u32,
    pub imported_games: i32,
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_get_prepared_download(
    state: State<'_, AppState>,
) -> Result<Option<ChessbasePreparedDownload>, String> {
    let cached = state
        .chessbase_cache
        .lock()
        .await
        .as_ref()
        .map(|c| ChessbasePreparedDownload {
            query: c.query.clone(),
            max_games: c.max_games,
            downloaded_games: c.downloaded_games,
        });
    Ok(cached)
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_clear_prepared_download(state: State<'_, AppState>) -> Result<(), String> {
    *state.chessbase_cache.lock().await = None;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_prepare_download(
    state: State<'_, AppState>,
    query: String,
    max_games: u32,
) -> Result<ChessbasePreparedDownload, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("Quick search query cannot be empty".to_string());
    }

    let result =
        chessbase::chessbase_download_games_quick_search(state.clone(), query.clone(), max_games)
            .await?;
    let cached = ChessbaseCachedDownload {
        query: query.clone(),
        max_games,
        downloaded_games: result.games,
        pgn: result.pgn,
    };
    *state.chessbase_cache.lock().await = Some(cached);

    Ok(ChessbasePreparedDownload {
        query,
        max_games,
        downloaded_games: result.games,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn chessbase_import_prepared_download(
    app: AppHandle,
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ChessbaseImportPreparedResult, String> {
    let profile_id = profile_id.trim().to_string();
    if profile_id.is_empty() {
        return Err("Profile id cannot be empty".to_string());
    }

    let cached = state.chessbase_cache.lock().await.take();
    let Some(cached) = cached else {
        return Err("No ChessBase download is ready to import".to_string());
    };

    let imported = db::add_profile_games_from_pgn(
        profile_id,
        cached.query.clone(),
        cached.pgn,
        state,
        app,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(ChessbaseImportPreparedResult {
        downloaded_games: cached.downloaded_games,
        imported_games: imported,
    })
}


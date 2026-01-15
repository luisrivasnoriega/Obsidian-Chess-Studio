use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{Error, Result};

async fn reqwest_client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(5_000))
        .timeout(Duration::from_secs(60))
        .user_agent("Obsidian Chess Studio")
        .build()?)
}

#[tauri::command]
#[specta::specta]
pub async fn get_lichess_account(
    token: Option<String>,
    username: Option<String>,
) -> Result<Option<String>> {
    let client = reqwest_client().await?;

    let res = if let Some(token) = token.as_deref() {
        match client
            .get("https://lichess.org/api/account")
            .bearer_auth(token)
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok(None),
        }
    } else {
        let Some(username) = username.as_deref() else {
            return Ok(None);
        };
        match client
            .get(format!("https://lichess.org/api/user/{username}"))
            .send()
            .await
        {
            Ok(r) => r,
            Err(_) => return Ok(None),
        }
    };

    if !res.status().is_success() {
        return Ok(None);
    }
    Ok(Some(res.text().await?))
}

#[tauri::command]
#[specta::specta]
pub async fn get_chesscom_account(username: String) -> Result<Option<String>> {
    let client = reqwest_client().await?;
    let url = format!(
        "https://api.chess.com/pub/player/{}/stats",
        username.to_ascii_lowercase()
    );
    let res = match client.get(url).send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    if !res.status().is_success() {
        return Ok(None);
    }
    Ok(Some(res.text().await?))
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LichessTournamentCreateRequest {
    pub token: String,
    /// Form-encoded fields (key/value), same as URLSearchParams in the frontend.
    pub form: Vec<(String, String)>,
}

#[tauri::command]
#[specta::specta]
pub async fn create_lichess_tournament(
    input: LichessTournamentCreateRequest,
) -> Result<String> {
    let client = reqwest_client().await?;

    let res = client
        .post("https://lichess.org/api/tournament")
        .bearer_auth(input.token)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&input.form)
        .send()
        .await?;

    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(Error::PackageManager(format!(
            "Lichess tournament create failed ({status}): {text}"
        )));
    }

    Ok(res.text().await?)
}


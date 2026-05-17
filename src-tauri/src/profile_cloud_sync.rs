use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use reqwest::StatusCode;
use ring::{aead, digest, pbkdf2, rand as ring_rand};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::path::PathBuf;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::error::{Error, Result};

const MAGIC: &[u8; 8] = b"OCSSYNC1";
const KDF_ITERATIONS: u32 = 150_000;
const STATE_FILE: &str = "profile-cloud-sync/state.json";

#[derive(Debug, Clone, Copy)]
struct ProfileCloudSyncTarget {
    profile_name: &'static str,
    platform: &'static str,
    username: &'static str,
    user_id: &'static str,
}

const PROFILE_CLOUD_SYNC_TARGETS: &[ProfileCloudSyncTarget] = &[
    ProfileCloudSyncTarget {
        profile_name: "Isabella",
        platform: "lichess",
        username: "bethfisher94",
        user_id: "bethfisher94",
    },
    ProfileCloudSyncTarget {
        profile_name: "Kevin",
        platform: "chesscom",
        username: "kevin09877",
        user_id: "kevin09877",
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloudRemoteStateDto {
    pub user_id: String,
    pub current_revision: String,
    pub object_key: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub updated_at: String,
    pub updated_by_device: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloudLocalStateDto {
    pub user_id: String,
    pub profile_id: String,
    pub revision: String,
    pub sha256: String,
    pub synced_at: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloudDownloadedDto {
    pub state: ProfileCloudRemoteStateDto,
    pub package_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ProfileCloudSyncResultDto {
    Uploaded {
        state: ProfileCloudRemoteStateDto,
    },
    Downloaded {
        state: ProfileCloudRemoteStateDto,
        package_json: String,
    },
    Unchanged {
        state: ProfileCloudRemoteStateDto,
    },
    Conflict {
        state: ProfileCloudRemoteStateDto,
        local_sha256: String,
        local_revision: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCloudSyncStatusDto {
    pub configured: bool,
    pub missing: Vec<String>,
}

#[derive(Debug, Clone)]
struct ProfileCloudSyncConfig {
    endpoint: String,
    sync_secret: String,
    auth_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedContainerHeader {
    version: i32,
    alg: String,
    kdf: String,
    iterations: u32,
    salt: String,
    iv: String,
    compression: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCloudSyncStateFile {
    device_id: Option<String>,
    local_states: HashMap<String, ProfileCloudLocalStateDto>,
}

#[derive(Debug, Deserialize)]
struct ProfileCloudSyncTargetProfile {
    id: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCloudSyncTargetSession {
    profile_id: Option<String>,
    lichess: Option<ProfileCloudSyncSessionAccount>,
    chess_com: Option<ProfileCloudSyncSessionAccount>,
}

#[derive(Debug, Deserialize)]
struct ProfileCloudSyncSessionAccount {
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProfileCloudSyncPackage {
    profile: Option<ProfileCloudSyncTargetProfile>,
    sessions: Option<Vec<ProfileCloudSyncTargetSession>>,
}

fn compile_or_runtime_env(name: &str, compiled: Option<&'static str>) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            compiled
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn backend_config() -> Result<ProfileCloudSyncConfig> {
    let endpoint = compile_or_runtime_env(
        "OCS_CLOUD_SYNC_ENDPOINT",
        option_env!("OCS_CLOUD_SYNC_ENDPOINT"),
    );
    let sync_secret =
        compile_or_runtime_env("OCS_CLOUD_SYNC_KEY", option_env!("OCS_CLOUD_SYNC_KEY"));
    let auth_token = compile_or_runtime_env(
        "OCS_CLOUD_SYNC_AUTH_TOKEN",
        option_env!("OCS_CLOUD_SYNC_AUTH_TOKEN"),
    );

    let mut missing = Vec::new();
    if endpoint.is_none() {
        missing.push("OCS_CLOUD_SYNC_ENDPOINT");
    }
    if sync_secret.is_none() {
        missing.push("OCS_CLOUD_SYNC_KEY");
    }
    if !missing.is_empty() {
        return Err(Error::InvalidInput(format!(
            "Cloud sync backend configuration is missing: {}.",
            missing.join(", ")
        )));
    }

    Ok(ProfileCloudSyncConfig {
        endpoint: normalize_endpoint(&endpoint.unwrap_or_default()),
        sync_secret: sync_secret.unwrap_or_default(),
        auth_token,
    })
}

fn normalize_endpoint(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_string()
}

fn normalize_target_value(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_lowercase()
}

fn describe_target(target: &ProfileCloudSyncTarget) -> String {
    let platform = if target.platform == "chesscom" {
        "Chess.com"
    } else {
        "Lichess"
    };
    format!("{} / {} {}", target.profile_name, platform, target.username)
}

fn normalize_known_cloud_sync_user_id(value: &str) -> Option<&'static str> {
    let normalized = normalize_target_value(Some(value));
    PROFILE_CLOUD_SYNC_TARGETS
        .iter()
        .find(|target| normalize_target_value(Some(target.user_id)) == normalized)
        .map(|target| target.user_id)
}

fn cloud_sync_user_id(value: &str) -> Result<&'static str> {
    normalize_known_cloud_sync_user_id(value).ok_or_else(|| {
        Error::InvalidInput(format!(
            "Cloud sync is currently limited to {}.",
            PROFILE_CLOUD_SYNC_TARGETS
                .iter()
                .map(describe_target)
                .collect::<Vec<_>>()
                .join(" or ")
        ))
    })
}

fn target_session_username<'a>(
    session: &'a ProfileCloudSyncTargetSession,
    target: &ProfileCloudSyncTarget,
) -> Option<&'a str> {
    if target.platform == "lichess" {
        session.lichess.as_ref()?.username.as_deref()
    } else {
        session.chess_com.as_ref()?.username.as_deref()
    }
}

fn get_profile_package_cloud_sync_target(
    package_json: &str,
) -> Result<&'static ProfileCloudSyncTarget> {
    let parsed: ProfileCloudSyncPackage = serde_json::from_str(package_json)
        .map_err(|err| Error::InvalidInput(format!("Invalid cloud profile package JSON: {err}")))?;
    let profile_name = parsed
        .profile
        .as_ref()
        .and_then(|profile| profile.name.as_deref());
    let profile_id = parsed
        .profile
        .as_ref()
        .and_then(|profile| profile.id.as_deref());
    let sessions = parsed.sessions.unwrap_or_default();

    PROFILE_CLOUD_SYNC_TARGETS
        .iter()
        .find(|target| {
            if normalize_target_value(profile_name)
                != normalize_target_value(Some(target.profile_name))
            {
                return false;
            }
            sessions.iter().any(|session| {
                let same_profile = match (profile_id, session.profile_id.as_deref()) {
                    (Some(profile_id), Some(session_profile_id)) => {
                        profile_id == session_profile_id
                    }
                    (Some(_), None) => false,
                    (None, _) => true,
                };
                if !same_profile {
                    return false;
                }
                normalize_target_value(target_session_username(session, target))
                    == normalize_target_value(Some(target.username))
            })
        })
        .ok_or_else(|| {
            Error::InvalidInput(format!(
                "Cloud sync is currently limited to {}.",
                PROFILE_CLOUD_SYNC_TARGETS
                    .iter()
                    .map(describe_target)
                    .collect::<Vec<_>>()
                    .join(" or ")
            ))
        })
}

fn assert_profile_package_matches_user_id(package_json: &str, user_id: &str) -> Result<()> {
    let target = get_profile_package_cloud_sync_target(package_json)?;
    if normalize_target_value(Some(target.user_id)) != normalize_target_value(Some(user_id)) {
        return Err(Error::InvalidInput(format!(
            "Cloud sync target is {user_id}, but the package is for {}.",
            target.user_id
        )));
    }
    Ok(())
}

fn api_url(config: &ProfileCloudSyncConfig, path: &str, query: &[(&str, &str)]) -> String {
    let mut url = format!("{}{}", config.endpoint, path);
    if !query.is_empty() {
        let params = query
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>();
        if !params.is_empty() {
            url.push('?');
            url.push_str(&params.join("&"));
        }
    }
    url
}

fn state_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app.path().resolve(STATE_FILE, BaseDirectory::AppData)?)
}

fn read_state_file(app: &AppHandle) -> Result<ProfileCloudSyncStateFile> {
    let path = state_path(app)?;
    if !path.exists() {
        return Ok(ProfileCloudSyncStateFile::default());
    }
    let raw = std::fs::read_to_string(path)?;
    serde_json::from_str(&raw)
        .map_err(|err| Error::InvalidInput(format!("Invalid cloud sync state file: {err}")))
}

fn write_state_file(app: &AppHandle, state: &ProfileCloudSyncStateFile) -> Result<()> {
    let path = state_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(state).map_err(|err| {
        Error::InvalidInput(format!("Failed to serialize cloud sync state: {err}"))
    })?;
    std::fs::write(path, raw)?;
    Ok(())
}

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let rng = ring_rand::SystemRandom::new();
    let mut bytes = [0u8; N];
    ring_rand::SecureRandom::fill(&rng, &mut bytes)
        .map_err(|_| Error::InvalidInput("Failed to generate random bytes.".to_string()))?;
    Ok(bytes)
}

fn device_id(app: &AppHandle) -> Result<String> {
    let mut state = read_state_file(app)?;
    if let Some(existing) = state
        .device_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(existing.clone());
    }
    let id = format!(
        "ocs-{}",
        BASE64
            .encode(random_bytes::<8>()?)
            .replace(['+', '/', '='], "")
            .to_lowercase()
    );
    state.device_id = Some(id.clone());
    write_state_file(app, &state)?;
    Ok(id)
}

fn local_state_key(profile_id: &str, user_id: &str) -> String {
    format!("{user_id}:{profile_id}")
}

fn load_local_state(
    app: &AppHandle,
    profile_id: &str,
    user_id: &str,
) -> Result<Option<ProfileCloudLocalStateDto>> {
    let state = read_state_file(app)?;
    Ok(state
        .local_states
        .get(&local_state_key(profile_id, user_id))
        .filter(|entry| entry.profile_id == profile_id && entry.user_id == user_id)
        .cloned())
}

fn save_local_state(
    app: &AppHandle,
    user_id: &str,
    profile_id: &str,
    remote: &ProfileCloudRemoteStateDto,
) -> Result<()> {
    let current_device_id = device_id(app)?;
    let mut state = read_state_file(app)?;
    state.device_id = Some(current_device_id.clone());
    state.local_states.insert(
        local_state_key(profile_id, user_id),
        ProfileCloudLocalStateDto {
            user_id: user_id.to_string(),
            profile_id: profile_id.to_string(),
            revision: remote.current_revision.clone(),
            sha256: remote.sha256.clone(),
            synced_at: Utc::now().to_rfc3339(),
            device_id: current_device_id,
        },
    );
    write_state_file(app, &state)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = digest::digest(&digest::SHA256, bytes);
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn derive_key(sync_secret: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        NonZeroU32::new(KDF_ITERATIONS).expect("constant KDF iterations must be nonzero"),
        salt,
        sync_secret.as_bytes(),
        &mut key,
    );
    key
}

fn encrypt_package_json(
    package_json: &str,
    config: &ProfileCloudSyncConfig,
) -> Result<(Vec<u8>, String)> {
    let plain = package_json.as_bytes();
    let sha256 = sha256_hex(plain);
    let salt = random_bytes::<16>()?;
    let iv = random_bytes::<12>()?;
    let key_bytes = derive_key(&config.sync_secret, &salt);
    let unbound_key = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes).map_err(|_| {
        Error::InvalidInput("Failed to initialize cloud sync encryption.".to_string())
    })?;
    let key = aead::LessSafeKey::new(unbound_key);
    let nonce = aead::Nonce::assume_unique_for_key(iv);
    let mut ciphertext = plain.to_vec();
    key.seal_in_place_append_tag(nonce, aead::Aad::empty(), &mut ciphertext)
        .map_err(|_| Error::InvalidInput("Failed to encrypt cloud profile payload.".to_string()))?;

    let header = EncryptedContainerHeader {
        version: 1,
        alg: "AES-256-GCM".to_string(),
        kdf: "PBKDF2-SHA256".to_string(),
        iterations: KDF_ITERATIONS,
        salt: BASE64.encode(salt),
        iv: BASE64.encode(iv),
        compression: "none".to_string(),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|err| {
        Error::InvalidInput(format!("Failed to serialize cloud payload header: {err}"))
    })?;
    let header_len = u32::try_from(header_bytes.len())
        .map_err(|_| Error::InvalidInput("Cloud payload header is too large.".to_string()))?;
    let mut out = Vec::with_capacity(MAGIC.len() + 4 + header_bytes.len() + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&header_len.to_be_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&ciphertext);
    Ok((out, sha256))
}

fn decrypt_package_json(container: &[u8], config: &ProfileCloudSyncConfig) -> Result<String> {
    if container.len() < MAGIC.len() + 4 || &container[..MAGIC.len()] != MAGIC {
        return Err(Error::InvalidInput(
            "Invalid cloud profile payload.".to_string(),
        ));
    }
    let header_len_start = MAGIC.len();
    let header_len_end = header_len_start + 4;
    let header_len = u32::from_be_bytes(
        container[header_len_start..header_len_end]
            .try_into()
            .map_err(|_| Error::InvalidInput("Invalid cloud profile payload.".to_string()))?,
    ) as usize;
    let header_start = header_len_end;
    let header_end = header_start + header_len;
    if header_end > container.len() {
        return Err(Error::InvalidInput(
            "Invalid cloud profile payload.".to_string(),
        ));
    }
    let header: EncryptedContainerHeader =
        serde_json::from_slice(&container[header_start..header_end])
            .map_err(|err| Error::InvalidInput(format!("Invalid cloud payload header: {err}")))?;
    if header.version != 1
        || header.alg != "AES-256-GCM"
        || header.kdf != "PBKDF2-SHA256"
        || header.iterations != KDF_ITERATIONS
    {
        return Err(Error::InvalidInput(
            "Unsupported cloud profile payload.".to_string(),
        ));
    }
    if header.compression != "none" {
        return Err(Error::InvalidInput(
            "Compressed cloud profile payloads are not supported by this build.".to_string(),
        ));
    }
    let salt = BASE64
        .decode(header.salt)
        .map_err(|err| Error::InvalidInput(format!("Invalid cloud payload salt: {err}")))?;
    let iv = BASE64
        .decode(header.iv)
        .map_err(|err| Error::InvalidInput(format!("Invalid cloud payload IV: {err}")))?;
    let iv: [u8; 12] = iv
        .try_into()
        .map_err(|_| Error::InvalidInput("Invalid cloud payload IV length.".to_string()))?;
    let key_bytes = derive_key(&config.sync_secret, &salt);
    let unbound_key = aead::UnboundKey::new(&aead::AES_256_GCM, &key_bytes).map_err(|_| {
        Error::InvalidInput("Failed to initialize cloud sync decryption.".to_string())
    })?;
    let key = aead::LessSafeKey::new(unbound_key);
    let nonce = aead::Nonce::assume_unique_for_key(iv);
    let mut ciphertext = container[header_end..].to_vec();
    let plain = key
        .open_in_place(nonce, aead::Aad::empty(), &mut ciphertext)
        .map_err(|_| Error::InvalidInput("Failed to decrypt cloud profile payload.".to_string()))?;
    String::from_utf8(plain.to_vec()).map_err(Error::from)
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

fn apply_auth(
    builder: reqwest::RequestBuilder,
    config: &ProfileCloudSyncConfig,
) -> reqwest::RequestBuilder {
    match config
        .auth_token
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(token) => builder.bearer_auth(token.trim()),
        None => builder,
    }
}

async fn read_json_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T> {
    let status = response.status();
    let raw = response.text().await?;
    if !status.is_success() {
        return Err(Error::InvalidInput(if raw.trim().is_empty() {
            format!("Cloud sync request failed ({status}).")
        } else {
            raw
        }));
    }
    serde_json::from_str(&raw)
        .map_err(|err| Error::InvalidInput(format!("Invalid cloud sync response JSON: {err}")))
}

async fn get_cloud_state(
    config: &ProfileCloudSyncConfig,
    user_id: &str,
) -> Result<Option<ProfileCloudRemoteStateDto>> {
    let url = api_url(config, "/sync/profile/state", &[("userId", user_id)]);
    let response = apply_auth(client().get(url), config).send().await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    read_json_response(response).await.map(Some)
}

async fn upload_encrypted_profile(
    app: &AppHandle,
    config: &ProfileCloudSyncConfig,
    user_id: &str,
    profile_id: &str,
    package_json: &str,
    base_revision: Option<&str>,
) -> Result<ProfileCloudRemoteStateDto> {
    assert_profile_package_matches_user_id(package_json, user_id)?;
    let (encrypted, sha256) = encrypt_package_json(package_json, config)?;
    let revision = format!(
        "rev_{}_{}",
        Utc::now().timestamp_millis(),
        uuid::Uuid::new_v4()
    );
    let url = api_url(config, "/sync/profile/upload", &[("userId", user_id)]);
    let response = apply_auth(
        client()
            .post(url)
            .header("content-type", "application/octet-stream")
            .header("x-ocs-base-revision", base_revision.unwrap_or_default())
            .header("x-ocs-device-id", device_id(app)?)
            .header("x-ocs-revision", revision)
            .header("x-ocs-sha256", sha256)
            .header("x-ocs-size-bytes", encrypted.len().to_string())
            .body(encrypted),
        config,
    )
    .send()
    .await?;
    let state = read_json_response::<ProfileCloudRemoteStateDto>(response).await?;
    save_local_state(app, user_id, profile_id, &state)?;
    Ok(state)
}

async fn download_profile_package(
    config: &ProfileCloudSyncConfig,
    user_id: &str,
) -> Result<ProfileCloudDownloadedDto> {
    let state = get_cloud_state(config, user_id).await?.ok_or_else(|| {
        Error::InvalidInput("No cloud profile has been uploaded yet.".to_string())
    })?;
    let url = api_url(config, "/sync/profile/download", &[("userId", user_id)]);
    let response = apply_auth(client().get(url), config).send().await?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(Error::InvalidInput(if raw.trim().is_empty() {
            format!("Cloud sync download failed ({status}).")
        } else {
            raw
        }));
    }
    let encrypted = response.bytes().await?;
    let package_json = decrypt_package_json(encrypted.as_ref(), config)?;
    assert_profile_package_matches_user_id(&package_json, user_id)?;
    let plain_sha256 = sha256_hex(package_json.as_bytes());
    if plain_sha256 != state.sha256 {
        return Err(Error::InvalidInput(
            "Downloaded cloud profile failed integrity verification.".to_string(),
        ));
    }
    Ok(ProfileCloudDownloadedDto {
        state,
        package_json,
    })
}

#[tauri::command]
#[specta::specta]
pub fn profile_cloud_sync_status() -> ProfileCloudSyncStatusDto {
    let mut missing = Vec::new();
    if compile_or_runtime_env(
        "OCS_CLOUD_SYNC_ENDPOINT",
        option_env!("OCS_CLOUD_SYNC_ENDPOINT"),
    )
    .is_none()
    {
        missing.push("OCS_CLOUD_SYNC_ENDPOINT".to_string());
    }
    if compile_or_runtime_env("OCS_CLOUD_SYNC_KEY", option_env!("OCS_CLOUD_SYNC_KEY")).is_none() {
        missing.push("OCS_CLOUD_SYNC_KEY".to_string());
    }
    ProfileCloudSyncStatusDto {
        configured: missing.is_empty(),
        missing,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn profile_cloud_sync_upload(
    app: AppHandle,
    target_user_id: String,
    profile_id: String,
    package_json: String,
) -> Result<ProfileCloudRemoteStateDto> {
    let user_id = cloud_sync_user_id(&target_user_id)?;
    let config = backend_config()?;
    let remote = get_cloud_state(&config, user_id).await?;
    upload_encrypted_profile(
        &app,
        &config,
        user_id,
        profile_id.trim(),
        &package_json,
        remote.as_ref().map(|state| state.current_revision.as_str()),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn profile_cloud_sync_download(
    target_user_id: String,
) -> Result<ProfileCloudDownloadedDto> {
    let user_id = cloud_sync_user_id(&target_user_id)?;
    let config = backend_config()?;
    download_profile_package(&config, user_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn profile_cloud_sync_sync(
    app: AppHandle,
    target_user_id: String,
    profile_id: String,
    package_json: String,
) -> Result<ProfileCloudSyncResultDto> {
    let user_id = cloud_sync_user_id(&target_user_id)?;
    let config = backend_config()?;
    assert_profile_package_matches_user_id(&package_json, user_id)?;
    let local_sha256 = sha256_hex(package_json.as_bytes());
    let remote = get_cloud_state(&config, user_id).await?;
    let local_state = load_local_state(&app, profile_id.trim(), user_id)?;

    let Some(remote) = remote else {
        let state = upload_encrypted_profile(
            &app,
            &config,
            user_id,
            profile_id.trim(),
            &package_json,
            None,
        )
        .await?;
        return Ok(ProfileCloudSyncResultDto::Uploaded { state });
    };

    if remote.sha256 == local_sha256 {
        save_local_state(&app, user_id, profile_id.trim(), &remote)?;
        return Ok(ProfileCloudSyncResultDto::Unchanged { state: remote });
    }

    let local_changed = local_state
        .as_ref()
        .map(|state| state.sha256 != local_sha256)
        .unwrap_or(true);
    let remote_changed = local_state
        .as_ref()
        .map(|state| state.revision != remote.current_revision)
        .unwrap_or(true);

    if !local_changed && remote_changed {
        let downloaded = download_profile_package(&config, user_id).await?;
        return Ok(ProfileCloudSyncResultDto::Downloaded {
            state: downloaded.state,
            package_json: downloaded.package_json,
        });
    }

    if local_changed && !remote_changed {
        let state = upload_encrypted_profile(
            &app,
            &config,
            user_id,
            profile_id.trim(),
            &package_json,
            Some(remote.current_revision.as_str()),
        )
        .await?;
        return Ok(ProfileCloudSyncResultDto::Uploaded { state });
    }

    Ok(ProfileCloudSyncResultDto::Conflict {
        state: remote,
        local_sha256,
        local_revision: local_state.map(|state| state.revision),
    })
}

#[tauri::command]
#[specta::specta]
pub fn profile_cloud_sync_save_local_state(
    app: AppHandle,
    target_user_id: String,
    profile_id: String,
    state: ProfileCloudRemoteStateDto,
) -> Result<()> {
    let user_id = cloud_sync_user_id(&target_user_id)?;
    save_local_state(&app, user_id, profile_id.trim(), &state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_profile_package_target() {
        let package_json = r#"{
          "profile": { "id": "p1", "name": "Isabella" },
          "sessions": [{ "profileId": "p1", "lichess": { "username": "bethfisher94" } }]
        }"#;

        let target = get_profile_package_cloud_sync_target(package_json).unwrap();
        assert_eq!(target.user_id, "bethfisher94");
    }

    #[test]
    fn rejects_unknown_profile_package_target() {
        let package_json = r#"{
          "profile": { "id": "p1", "name": "Other" },
          "sessions": []
        }"#;

        assert!(get_profile_package_cloud_sync_target(package_json).is_err());
    }

    #[test]
    fn rejects_target_session_from_different_profile_id() {
        let package_json = r#"{
          "profile": { "id": "p1", "name": "Isabella" },
          "sessions": [{ "profileId": "p2", "lichess": { "username": "bethfisher94" } }]
        }"#;

        assert!(get_profile_package_cloud_sync_target(package_json).is_err());
    }

    #[test]
    fn encrypts_and_decrypts_current_payload_format() {
        let config = ProfileCloudSyncConfig {
            endpoint: "https://example.com".to_string(),
            sync_secret: "test-secret".to_string(),
            auth_token: None,
        };
        let package_json = r#"{"profile":{"name":"Isabella"},"sessions":[]}"#;
        let (encrypted, sha256) = encrypt_package_json(package_json, &config).unwrap();
        let decrypted = decrypt_package_json(&encrypted, &config).unwrap();

        assert_eq!(decrypted, package_json);
        assert_eq!(sha256, sha256_hex(package_json.as_bytes()));
    }
}

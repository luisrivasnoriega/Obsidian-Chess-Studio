#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod analysis_storage;
mod app;
mod chess;
mod dashboard_games_history;
mod db;
mod error;
mod fide;
mod fs;
mod chessbase;
mod chessbase_service;
mod lexer;
mod oauth;
mod online;
mod opening;
mod package_manager;
mod player_match_planner;
mod pawn_structures;
mod pgn;
mod puzzle;
mod puzzle_variants;
mod variants_builder;
mod variant_positions;

use std::sync::Arc;

use chess::{BestMovesPayload, EngineProcess, ReportProgress};
use dashmap::DashMap;
use db::{DatabaseProgress, GameQueryJs, NormalizedGame, PositionStats};
use derivative::Derivative;
use fide::FidePlayer;
use oauth::AuthState;
#[cfg(all(debug_assertions, not(target_os = "android")))]
use specta_typescript::{BigIntExportBehavior, Typescript};
use sysinfo::SystemExt;
use tauri::AppHandle;

use crate::analysis_storage::{
    analysis_db_clear_analyzed_pgns, analysis_db_delete_entries, analysis_db_get_all_analyzed_games,
    analysis_db_get_analyzed_game, analysis_db_get_analyzed_games_bulk, analysis_db_get_game_stats,
    analysis_db_get_game_stats_bulk, analysis_db_set_analyzed_game, analysis_db_set_game_stats,
};
use crate::dashboard_games_history::{
    dashboard_get_analyze_all_counts, dashboard_get_games_history_rows, dashboard_resolve_profile_db_game_id,
    dashboard_search_profile_opponents,
};
use crate::player_match_planner::{planner_build_variant_book, planner_build_variant_pgn};
use crate::chess::{
    analyze_game, get_best_moves, get_engine_config, get_engine_logs, kill_engine, kill_engines,
    stop_engine,
};
use crate::db::{
    calculate_earliest_date_from_range, calculate_player_elo_buckets, calculate_player_elo_domain,
    calculate_player_game_stats, calculate_player_openings_stats, calculate_player_rating_timeline,
    calculate_player_sidebar_model,
    clear_games, convert_pgn, create_indexes, delete_database, delete_db_game, delete_empty_games, optimize_database,
    delete_indexes, download_position_cache, export_position_games_to_pgn,
    export_selected_games_to_pgn, export_to_pgn, fill_missing_months_data, get_player,
    get_players_game_info, get_tournaments, init_profile_db, merge_player_site_stats,
    merge_years_data, precache_openings, search_position, import_online_tournament, get_account_sync_state,
    upsert_account_sync_state, mark_account_sync_batch_complete, list_account_sync_completed_batches,
    get_account_import_stats, sync_account_games_to_profile_db,
    upsert_managed_event, list_managed_events, delete_managed_event, add_event_games_from_pgn,
    add_profile_games_from_pgn,
    create_event_game,
    get_db_source, set_db_source,
    merge_profile_event_from_db_player,
    download_game_database,
};
use crate::fide::{download_fide_db, fetch_fide_profile_html, find_fide_player, save_fide_photo};
use crate::fs::{download_engine, set_file_as_executable, DownloadProgress};
use crate::lexer::lex_pgn;
use crate::oauth::authenticate;
use crate::online::{create_lichess_tournament, get_chesscom_account, get_lichess_account};
use crate::package_manager::{
    check_package_installed, check_package_manager_available, find_executable_path, install_package,
};
use crate::pgn::{count_pgn_games, delete_game, read_games, write_game};
use crate::puzzle::{
    check_puzzle_db_columns, get_puzzle, get_puzzle_db_info, get_puzzle_opening_tags,
    get_puzzle_rating_range, get_puzzle_themes, import_puzzle_file, validate_puzzle_database,
    download_puzzle_database,
};
use crate::puzzle_variants::generate_puzzle_variants_from_tree;
use crate::variants_builder::build_variants_tree;
use crate::pawn_structures::compute_pawn_structures;
use crate::variant_positions::{get_variant_position, upsert_variant_position};
use crate::chessbase::{
    chessbase_clear_credentials, chessbase_download_games_quick_search, chessbase_get_credentials,
    chessbase_login_background, chessbase_quick_search_count, chessbase_set_credentials,
};
use crate::chessbase_service::{
    chessbase_clear_prepared_download, chessbase_get_prepared_download, chessbase_import_prepared_download,
    chessbase_prepare_download,
};
use crate::{
    db::{
        delete_duplicated_games, edit_db_info, get_db_info, get_game, get_games, get_players,
        merge_players, set_profile_metadata, update_game,
    },
    fs::{download_file, file_exists, get_file_metadata, save_welcome_card_image},
    opening::{
        get_opening_from_fen, get_opening_from_name, get_opening_info_from_fen,
        search_opening_name,
    },
};
use tokio::sync::{Mutex, RwLock, Semaphore};

pub type GameData = (
    i32,
    i32,
    i32,
    Option<String>,
    Option<String>,
    Vec<u8>,
    Option<String>,
    i32,
    i32,
    i32,
);

#[derive(Derivative)]
#[derivative(Default)]
pub struct AppState {
    connection_pool: DashMap<
        String,
        diesel::r2d2::Pool<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>,
    >,
    line_cache:
        DashMap<(GameQueryJs, std::path::PathBuf), (Vec<PositionStats>, Vec<NormalizedGame>)>,
    // Cache for games loaded from database (optimized for repeated queries)
    db_cache: std::sync::Mutex<Vec<GameData>>,
    #[derivative(Default(value = "Arc::new(Semaphore::new(10))"))]
    new_request: Arc<Semaphore>,
    pgn_offsets: DashMap<String, Vec<u64>>,
    fide_players: RwLock<Vec<FidePlayer>>,
    engine_processes: DashMap<(String, String), Arc<tokio::sync::Mutex<EngineProcess>>>,
    auth: AuthState,
    chessbase_ws: Mutex<chessbase::ChessbaseWsState>,
    chessbase_cache: Mutex<Option<chessbase_service::ChessbaseCachedDownload>>,
}

// ============================================================================
// MAIN APPLICATION ENTRY POINT
// ============================================================================

#[tokio::main]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands!(
            get_system_locale,
            app::platform::screen_capture,
            find_fide_player,
            fetch_fide_profile_html,
            save_fide_photo,
            get_best_moves,
            analyze_game,
            stop_engine,
            kill_engine,
            kill_engines,
            get_engine_logs,
            memory_size,
            get_puzzle,
            search_opening_name,
            get_opening_from_fen,
            get_opening_from_name,
            get_opening_info_from_fen,
            get_players_game_info,
            get_engine_config,
            file_exists,
            get_file_metadata,
            save_welcome_card_image,
            merge_players,
            convert_pgn,
            init_profile_db,
            get_player,
            count_pgn_games,
            read_games,
            lex_pgn,
            is_bmi2_compatible,
            delete_game,
            delete_duplicated_games,
            delete_empty_games,
            clear_games,
            set_file_as_executable,
            delete_indexes,
            create_indexes,
            edit_db_info,
            set_profile_metadata,
            delete_db_game,
    delete_database,
    optimize_database,
    export_to_pgn,
            export_position_games_to_pgn,
            export_selected_games_to_pgn,
            authenticate,
            write_game,
            download_fide_db,
            download_file,
            download_engine,
            get_tournaments,
            get_db_info,
            get_games,
            get_game,
            update_game,
            search_position,
            precache_openings,
            import_online_tournament,
            download_position_cache,
            download_game_database,
            set_db_source,
            get_db_source,
            merge_profile_event_from_db_player,
            get_players,
            get_puzzle_db_info,
            get_puzzle_rating_range,
            import_puzzle_file,
            check_puzzle_db_columns,
            get_puzzle_themes,
            get_puzzle_opening_tags,
            validate_puzzle_database,
            download_puzzle_database,
            check_package_manager_available,
            install_package,
            check_package_installed,
            find_executable_path,
            get_variant_position,
            upsert_variant_position,
            generate_puzzle_variants_from_tree,
            build_variants_tree,
            analysis_db_set_analyzed_game,
            analysis_db_get_analyzed_game,
            analysis_db_get_all_analyzed_games,
            analysis_db_set_game_stats,
            analysis_db_get_game_stats,
            analysis_db_get_game_stats_bulk,
            analysis_db_delete_entries,
            analysis_db_clear_analyzed_pgns,
            analysis_db_get_analyzed_games_bulk,
            dashboard_get_analyze_all_counts,
            dashboard_get_games_history_rows,
            dashboard_search_profile_opponents,
            dashboard_resolve_profile_db_game_id,
            planner_build_variant_book,
            planner_build_variant_pgn,
            chessbase_get_credentials,
            chessbase_set_credentials,
            chessbase_clear_credentials,
            chessbase_login_background,
            chessbase_download_games_quick_search,
            chessbase_quick_search_count,
            chessbase_get_prepared_download,
            chessbase_clear_prepared_download,
            chessbase_prepare_download,
            chessbase_import_prepared_download,
            open_external_link,
            compute_pawn_structures,
            calculate_player_game_stats,
            calculate_player_elo_buckets,
            calculate_player_sidebar_model,
            calculate_player_openings_stats,
            calculate_player_rating_timeline,
            calculate_player_elo_domain,
            merge_player_site_stats,
            fill_missing_months_data,
            merge_years_data,
            calculate_earliest_date_from_range,
            get_account_sync_state,
            upsert_account_sync_state,
            mark_account_sync_batch_complete,
            list_account_sync_completed_batches,
            get_account_import_stats,
            sync_account_games_to_profile_db,
            get_lichess_account,
            get_chesscom_account,
            create_lichess_tournament,
            upsert_managed_event,
            list_managed_events,
            delete_managed_event,
            add_event_games_from_pgn,
            add_profile_games_from_pgn,
            create_event_game,
        ))
        .events(tauri_specta::collect_events!(
            BestMovesPayload,
            DatabaseProgress,
            DownloadProgress,
            ReportProgress,
            db::AccountSyncProgress
        ));

    #[cfg(all(debug_assertions, not(target_os = "android")))]
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::BigInt),
            "../src/bindings/generated.ts",
        )
        .expect("Failed to export types");

    // Configure WebView2 to use Roaming (AppData) instead of LocalAppData
    // This must be set BEFORE creating the Tauri builder
    #[cfg(target_os = "windows")]
    {
        if std::env::var("WEBVIEW2_USER_DATA_FOLDER").is_err() {
            if let Ok(appdata) = std::env::var("APPDATA") {
                // APPDATA on Windows points to Roaming (AppData\Roaming)
                let mut webview_data_folder = std::path::PathBuf::from(appdata);
                webview_data_folder.push("com.ocs");
                webview_data_folder.push("EBWebView");
                
                // Create the directory if it doesn't exist
                if let Some(parent) = webview_data_folder.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                
                // Set the environment variable for WebView2
                std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview_data_folder.to_string_lossy().as_ref());
                log::info!("WebView2 user data folder set to: {}", webview_data_folder.display());
            }
        }
    }
    
    let builder = tauri::Builder::default();
    let builder = app::platform::setup_tauri_plugins(builder, &specta_builder);

    builder
        .setup(move |app| app::setup::setup_tauri_app(app, &specta_builder))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ============================================================================
// SHARED COMMANDS (Available on all platforms)
// ============================================================================

#[tauri::command]
#[specta::specta]
fn is_bmi2_compatible() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("bmi2") {
        return true;
    }
    false
}

#[tauri::command]
#[specta::specta]
fn memory_size() -> u64 {
    sysinfo::System::new_all().total_memory() / (1024 * 1024)
}

#[tauri::command]
#[specta::specta]
fn get_system_locale() -> Result<Option<String>, String> {
    // Try to get locale from environment variables (works on most platforms)
    // Priority: LC_ALL > LC_MESSAGES > LANG
    let locale = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .ok();

    // On Windows, if env vars don't work, try to get from system
    #[cfg(windows)]
    {
        if locale.is_none() {
            // Try to get from Windows registry via environment
            // Windows 10+ sets some locale-related env vars
            if let Ok(lang) = std::env::var("LOCALE") {
                return Ok(Some(lang));
            }
            // Try PowerShell command as fallback
            use std::process::Command;
            if let Ok(output) = Command::new("powershell")
                .args(["-Command", "[System.Globalization.CultureInfo]::CurrentCulture.Name"])
                .output()
            {
                if output.status.success() {
                    if let Ok(locale_str) = String::from_utf8(output.stdout) {
                        let locale_str = locale_str.trim().to_string();
                        if !locale_str.is_empty() {
                            return Ok(Some(locale_str));
                        }
                    }
                }
            }
        }
    }

    Ok(locale)
}

fn validate_external_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http/https URLs are allowed".to_string()),
    }

    if let Some(host) = parsed.host_str() {
        if is_private_or_localhost(host) {
            return Err("Refusing to open private/local URLs".to_string());
        }
    }

    Ok(parsed)
}

#[tauri::command]
#[specta::specta]
async fn open_external_link(app: AppHandle, url: String) -> Result<(), String> {
    // Keep URL validation unit-testable and deterministic.
    validate_external_url(&url)?;

    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<String>)
        .map_err(|e| format!("Failed to open external link: {}", e))
}

fn is_private_or_localhost(host: &str) -> bool {
    use std::net::IpAddr;

    // Be defensive: depending on the URL parser, IPv6 hosts may appear bracketed.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host_lc = host.to_ascii_lowercase();

    if host_lc == "localhost" || host == "::1" {
        return true;
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(ipv4) => {
                let o = ipv4.octets();
                o[0] == 127
                    || o[0] == 10
                    || o[0] == 0
                    || (o[0] == 172 && (16..=31).contains(&o[1]))
                    || (o[0] == 192 && o[1] == 168)
            }
            IpAddr::V6(ipv6) => ipv6.is_loopback() || ipv6.is_unspecified(),
        }
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_private_or_localhost_detects_common_cases() {
        // hostnames
        assert!(is_private_or_localhost("localhost"));
        assert!(is_private_or_localhost("::1"));

        // ipv4 private/loopback/unspecified
        assert!(is_private_or_localhost("127.0.0.1"));
        assert!(is_private_or_localhost("127.99.1.2"));
        assert!(is_private_or_localhost("10.0.0.1"));
        assert!(is_private_or_localhost("10.255.255.255"));
        assert!(is_private_or_localhost("192.168.0.1"));
        assert!(is_private_or_localhost("172.16.0.1"));
        assert!(is_private_or_localhost("172.31.255.255"));
        assert!(is_private_or_localhost("0.0.0.0"));

        // boundaries
        assert!(!is_private_or_localhost("172.32.0.1"));
        assert!(!is_private_or_localhost("8.8.8.8"));

        // non-ip hostnames should be treated as non-private here
        assert!(!is_private_or_localhost("example.com"));
        assert!(!is_private_or_localhost("ratings.fide.com"));
    }

    #[test]
    fn validate_external_url_accepts_public_http_https() {
        let u = validate_external_url("https://example.com/path?x=1").unwrap();
        assert_eq!(u.scheme(), "https");

        let u2 = validate_external_url("http://example.com").unwrap();
        assert_eq!(u2.scheme(), "http");
    }

    #[test]
    fn validate_external_url_rejects_non_http_schemes() {
        let err = validate_external_url("file:///etc/passwd").unwrap_err();
        assert!(err.contains("Only http/https"));
    }

    #[test]
    fn validate_external_url_rejects_private_hosts() {
        for u in [
            "http://127.0.0.1/test",
            "http://localhost/test",
            "http://10.0.0.1/test",
            "http://192.168.1.1/test",
            "http://172.16.0.1/test",
            "http://0.0.0.0/test",
            "http://[::1]/test",
        ] {
            let err = validate_external_url(u).unwrap_err();
            assert!(err.contains("Refusing to open private/local URLs"), "url: {}", u);
        }
    }

    #[test]
    fn is_bmi2_compatible_matches_runtime_detection_on_x86() {
        // This test is portable: it only asserts an exact relationship on x86/x86_64,
        // and on other architectures it should always be false.
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            assert_eq!(is_bmi2_compatible(), is_x86_feature_detected!("bmi2"));
        }

        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        {
            assert!(!is_bmi2_compatible());
        }
    }

    #[test]
    fn memory_size_returns_something_reasonable() {
        // We only assert it doesn't panic and is not obviously invalid.
        let m = memory_size();
        assert!(m > 0, "memory_size() returned 0 MB (unexpected in most environments)");
    }
}

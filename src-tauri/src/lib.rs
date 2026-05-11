#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod analysis_storage;
mod app;
mod chess;
mod coverage_explorer_cache;
mod dashboard_games_history;
pub mod db;
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
mod post_game_review;
mod player_match_planner;
mod pawn_structures;
mod pgn;
mod puzzle;
mod puzzle_variants;
mod tab_state_storage;
mod variants_builder;
mod variants_manager;
mod variants_opening;
mod variant_coverage_graph;
mod variant_positions;

#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::Arc;

use chess::{BestMovesPayload, CoverageEngineSession, EngineProcess, ReportProgress};
use dashmap::DashMap;
use db::{DatabaseProgress, GameQueryJs, NormalizedGame, PositionStats};
use derivative::Derivative;
use fide::FidePlayer;
use oauth::AuthState;
#[cfg(all(debug_assertions, not(target_os = "android")))]
use specta_typescript::{BigIntExportBehavior, Typescript};
use sysinfo::{PidExt, ProcessExt, SystemExt};
use tauri::AppHandle;

use crate::analysis_storage::{
    analysis_db_clear_analyzed_pgns, analysis_db_delete_entries, analysis_db_get_all_analyzed_games,
    analysis_db_get_analyzed_game, analysis_db_get_analyzed_games_bulk, analysis_db_get_game_stats,
    analysis_db_get_game_stats_bulk, analysis_db_set_analyzed_game, analysis_db_set_game_stats,
};
use crate::coverage_explorer_cache::{coverage_cache_get, coverage_cache_set};
use crate::dashboard_games_history::{
    dashboard_get_analyze_all_counts, dashboard_get_analyze_all_counts_bulk, dashboard_get_games_history_rows,
    dashboard_get_games_history_filter_meta,
    dashboard_get_overview_metrics,
    dashboard_decode_profile_game_blob_moves,
    dashboard_resolve_chesscom_game_url,
    dashboard_resolve_profile_db_game_id,
    dashboard_search_profile_opponents,
};
use crate::player_match_planner::{planner_build_variant_book, planner_build_variant_pgn};
use crate::chess::{
    analyze_game, analyze_game_human_report, build_human_strategic_live_report,
    evaluate_coverage_engine_session_position, evaluate_engine_position_once, evaluate_engine_positions_batch,
    get_best_moves, get_engine_config, get_engine_logs, kill_engine, kill_engines, pick_human_strategic_move,
    run_coverage_engine_analysis, start_coverage_engine_session, stop_coverage_engine_session, stop_engine,
    dashboard_analyze_all_run, dashboard_analyze_all_cancel,
};
use crate::db::{
    calculate_earliest_date_from_range, calculate_player_elo_buckets, calculate_player_elo_domain,
    calculate_player_game_stats, calculate_player_openings_stats, calculate_player_rating_timeline,
    calculate_player_sidebar_model,
    clear_games, convert_pgn, create_indexes, delete_database, delete_db_game, delete_empty_games, optimize_database,
    replace_profile_db_file,
    delete_indexes, download_position_cache, export_position_games_to_pgn,
    export_selected_games_to_pgn, export_to_pgn, fill_missing_months_data, get_player,
    get_players_game_info, get_profile_accounts_game_info, get_profile_sidebar_stats, get_profile_game_stats, get_profile_rating_timeline, get_tournaments, init_profile_db, merge_player_site_stats,
    merge_years_data, precache_openings, search_position, import_online_tournament, get_account_sync_state,
    upsert_account_sync_state, mark_account_sync_batch_complete, list_account_sync_completed_batches,
    get_account_import_stats, sync_account_games_to_profile_db,
    save_profile_game_analysis_stats,
    get_profile_phase_outcomes,
    get_profile_phase_accuracy,
    get_profile_outcome_accuracy,
    get_profile_fork_stats,
    generate_profile_missed_fork_puzzles,
    get_profile_missed_fork_games,
    get_profile_outcome_reason_breakdown,
    get_profile_intensity_breakdown,
    get_profile_intensity_outcomes,
    get_profile_intensity_accuracy,
    get_profile_phase_games,
    get_profile_intensity_games,
    get_profile_weakness_model,
    upsert_managed_event, list_managed_events, delete_managed_event, add_event_games_from_pgn,
    add_profile_games_from_pgn,
    create_event_game,
    get_db_source, set_db_source,
    merge_profile_event_from_db_player,
    download_game_database,
};
use crate::fide::{download_fide_db, fetch_fide_profile_html, find_fide_player, save_fide_photo};
use crate::fs::{download_engine, list_lc0_networks, set_file_as_executable, DownloadProgress};
use crate::lexer::lex_pgn;
use crate::oauth::authenticate;
use crate::online::{
    consult_orion_plan, consult_orion_plan_from_analysis, create_lichess_tournament, get_chesscom_account, get_lichess_account,
    lichess_challenge_ai, lichess_find_human_game, lichess_get_board_game_state, lichess_make_board_move,
    lichess_resign_board_game, lichess_start_board_game_stream, lichess_stop_board_game_stream,
};
use crate::package_manager::{
    check_package_installed, check_package_manager_available, find_executable_path, install_package,
};
use crate::post_game_review::post_game_review_variants;
use crate::pgn::{count_pgn_games, delete_game, read_games, write_game};
use crate::puzzle::{
    check_puzzle_db_columns, get_puzzle, get_puzzle_batch, get_puzzle_db_info, get_puzzle_opening_tags,
    get_puzzle_dependent_filters_metadata, get_puzzle_filters_metadata, get_puzzle_rating_range, get_puzzle_themes,
    import_puzzle_file, validate_puzzle_database,
    download_puzzle_database,
};
use crate::puzzle_variants::{
    generate_puzzle_variants_from_coverage_node, generate_puzzle_variants_from_tree,
};
use crate::tab_state_storage::{tab_state_clear_all, tab_state_read, tab_state_remove, tab_state_write};
use crate::variants_builder::build_variants_tree;
use crate::variants_manager::{variants_delete_files, variants_list_fast, variants_validate_consistency};
use crate::variants_opening::variants_create_opening_variants;
use crate::variant_coverage_graph::{
    variant_coverage_apply_node_visibility_rules, variant_coverage_apply_position_flags,
    variant_coverage_apply_profile_position_flags, variant_coverage_build_source_signature,
    variant_coverage_build_graph, variant_coverage_classify_position, variant_coverage_get_cached_position,
    variant_coverage_get_profile_position, variant_coverage_graph_cache_path,
    variant_coverage_parse_build_config_tags, variant_coverage_read_graph_cache,
    variant_coverage_critical_line_report,
    variant_coverage_trim_graph_by_depth, variant_coverage_write_graph_cache,
};
use crate::pawn_structures::compute_pawn_structures;
use crate::variant_positions::{
    get_variant_position, get_variant_position_engine_eval, upsert_variant_position,
    upsert_variant_position_engine_eval,
};
use crate::chessbase::{
    chessbase_cancel_active_request,
    chessbase_clear_credentials, chessbase_download_games_quick_search, chessbase_get_credentials,
    chessbase_login_background, chessbase_quick_search_count, chessbase_search_position,
    chessbase_session_status, chessbase_set_credentials,
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
    coverage_engine_sessions: DashMap<String, Arc<tokio::sync::Mutex<CoverageEngineSession>>>,
    dashboard_analyze_all_cancellations: DashMap<String, bool>,
    // Key: (run_id, analysis_id), Value: engine path.
    dashboard_analyze_all_active: DashMap<(String, String), String>,
    auth: AuthState,
    chessbase_ws: Mutex<chessbase::ChessbaseWsState>,
    chessbase_cache: Mutex<Option<chessbase_service::ChessbaseCachedDownload>>,
}

// ============================================================================
// MAIN APPLICATION ENTRY POINT
// ============================================================================

fn install_rustls_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[tokio::main]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    install_rustls_crypto_provider();

    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands!(
        get_system_locale,
        get_preferred_lc0_engine_name,
        get_preferred_stockfish_build_key,
            app::platform::screen_capture,
            find_fide_player,
            fetch_fide_profile_html,
            save_fide_photo,
            evaluate_engine_position_once,
            evaluate_engine_positions_batch,
            run_coverage_engine_analysis,
            start_coverage_engine_session,
            evaluate_coverage_engine_session_position,
            stop_coverage_engine_session,
            get_best_moves,
            pick_human_strategic_move,
            analyze_game,
            analyze_game_human_report,
            build_human_strategic_live_report,
            stop_engine,
            kill_engine,
            kill_engines,
            get_engine_logs,
            memory_size,
            process_memory_rss_mb,
            tab_state_write,
            tab_state_read,
            tab_state_remove,
            tab_state_clear_all,
            get_puzzle,
            get_puzzle_batch,
            search_opening_name,
            get_opening_from_fen,
            get_opening_from_name,
            get_opening_info_from_fen,
            get_players_game_info,
            get_profile_accounts_game_info,
            get_profile_sidebar_stats,
            get_profile_game_stats,
            get_profile_rating_timeline,
            get_engine_config,
            coverage_cache_get,
            coverage_cache_set,
            variant_coverage_parse_build_config_tags,
            variant_coverage_build_graph,
            variant_coverage_build_source_signature,
            variant_coverage_graph_cache_path,
            variant_coverage_read_graph_cache,
            variant_coverage_write_graph_cache,
            variant_coverage_trim_graph_by_depth,
            variant_coverage_critical_line_report,
            variant_coverage_classify_position,
            variant_coverage_get_cached_position,
            variant_coverage_get_profile_position,
            variant_coverage_apply_position_flags,
            variant_coverage_apply_profile_position_flags,
            variant_coverage_apply_node_visibility_rules,
            file_exists,
            get_file_metadata,
            save_welcome_card_image,
            merge_players,
            convert_pgn,
            init_profile_db,
            replace_profile_db_file,
            save_profile_game_analysis_stats,
            get_profile_phase_outcomes,
            get_profile_phase_accuracy,
            get_profile_outcome_accuracy,
            get_profile_fork_stats,
            generate_profile_missed_fork_puzzles,
            get_profile_missed_fork_games,
            get_profile_outcome_reason_breakdown,
            get_profile_intensity_breakdown,
            get_profile_intensity_outcomes,
            get_profile_intensity_accuracy,
            get_profile_phase_games,
            get_profile_intensity_games,
            get_profile_weakness_model,
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
            list_lc0_networks,
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
            get_puzzle_filters_metadata,
            get_puzzle_dependent_filters_metadata,
            validate_puzzle_database,
            download_puzzle_database,
            check_package_manager_available,
            install_package,
            check_package_installed,
            find_executable_path,
            get_variant_position,
            upsert_variant_position,
            get_variant_position_engine_eval,
            upsert_variant_position_engine_eval,
            generate_puzzle_variants_from_coverage_node,
            generate_puzzle_variants_from_tree,
            build_variants_tree,
            variants_list_fast,
            variants_validate_consistency,
            variants_delete_files,
            variants_create_opening_variants,
            post_game_review_variants,
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
            dashboard_get_analyze_all_counts_bulk,
            dashboard_get_games_history_rows,
            dashboard_get_games_history_filter_meta,
            dashboard_get_overview_metrics,
            dashboard_decode_profile_game_blob_moves,
            dashboard_search_profile_opponents,
            dashboard_resolve_chesscom_game_url,
            dashboard_resolve_profile_db_game_id,
            dashboard_analyze_all_run,
            dashboard_analyze_all_cancel,
            planner_build_variant_book,
            planner_build_variant_pgn,
            chessbase_get_credentials,
            chessbase_set_credentials,
            chessbase_clear_credentials,
            chessbase_cancel_active_request,
            chessbase_session_status,
            chessbase_login_background,
            chessbase_download_games_quick_search,
            chessbase_search_position,
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
            consult_orion_plan,
            consult_orion_plan_from_analysis,
            lichess_find_human_game,
            lichess_challenge_ai,
            lichess_get_board_game_state,
            lichess_make_board_move,
            lichess_resign_board_game,
            lichess_start_board_game_stream,
            lichess_stop_board_game_stream,
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

// Prefer the fastest Stockfish build available for this device.
//
// We keep the build matrix and URLs in the frontend, but hardware detection is
// done here (like Lc0) to avoid fragile/incorrect JS-side CPU probing.
#[cfg(target_os = "android")]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    // Keys must match the mapping in `src/utils/engines.ts`.
    //
    // NOTE: Stockfish naming uses `ubuntu` in filenames for Linux builds.
    //
    // On Android we ship a bundled Stockfish and the backend resolves it to native libs.
    "android-bundled".to_string()
}

// --- Windows ---

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if has_avx512_icl_like() {
        return "windows-x86-64-avx512icl".to_string();
    }
    if is_x86_feature_detected!("avx512f") {
        // Prefer VNNI-512 if available, otherwise fall back to plain AVX-512.
        if is_x86_feature_detected!("avx512vnni") {
            return "windows-x86-64-vnni512".to_string();
        }
        return "windows-x86-64-avx512".to_string();
    }
    if has_avx_vnni() && is_x86_feature_detected!("avx2") {
        return "windows-x86-64-avxvnni".to_string();
    }
    if is_x86_feature_detected!("bmi2") {
        return "windows-x86-64-bmi2".to_string();
    }
    if is_x86_feature_detected!("avx2") {
        return "windows-x86-64-avx2".to_string();
    }
    if is_x86_feature_detected!("sse4.1") && is_x86_feature_detected!("popcnt") {
        return "windows-x86-64-sse41-popcnt".to_string();
    }
    "windows-x86-64".to_string()
}

#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if has_aarch64_dotprod() {
        return "windows-armv8-dotprod".to_string();
    }
    "windows-armv8".to_string()
}

#[cfg(all(
    target_os = "windows",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    String::new()
}

// --- Linux ---

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if has_avx512_icl_like() {
        return "linux-x86-64-avx512icl".to_string();
    }
    if is_x86_feature_detected!("avx512f") {
        if is_x86_feature_detected!("avx512vnni") {
            return "linux-x86-64-vnni512".to_string();
        }
        return "linux-x86-64-avx512".to_string();
    }
    if has_avx_vnni() && is_x86_feature_detected!("avx2") {
        return "linux-x86-64-avxvnni".to_string();
    }
    if is_x86_feature_detected!("bmi2") {
        return "linux-x86-64-bmi2".to_string();
    }
    if is_x86_feature_detected!("avx2") {
        return "linux-x86-64-avx2".to_string();
    }
    if is_x86_feature_detected!("sse4.1") && is_x86_feature_detected!("popcnt") {
        return "linux-x86-64-sse41-popcnt".to_string();
    }
    "linux-x86-64".to_string()
}

#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if has_aarch64_dotprod() {
        return "linux-armv8-dotprod".to_string();
    }
    "linux-armv8".to_string()
}

#[cfg(all(target_os = "linux", target_arch = "arm"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if has_arm_neon() {
        return "linux-armv7-neon".to_string();
    }
    "linux-armv7".to_string()
}

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "x86_64", target_arch = "aarch64", target_arch = "arm"))
))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    String::new()
}

// --- macOS ---

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    "macos-m1-apple-silicon".to_string()
}

#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    if is_x86_feature_detected!("bmi2") {
        return "macos-x86-64-bmi2".to_string();
    }
    if is_x86_feature_detected!("avx2") {
        return "macos-x86-64-avx2".to_string();
    }
    if is_x86_feature_detected!("sse4.1") && is_x86_feature_detected!("popcnt") {
        return "macos-x86-64-sse41-popcnt".to_string();
    }
    "macos-x86-64".to_string()
}

#[cfg(all(
    target_os = "macos",
    not(any(target_arch = "x86_64", target_arch = "aarch64"))
))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    String::new()
}

// --- Fallback ---

#[cfg(not(any(target_os = "android", target_os = "windows", target_os = "linux", target_os = "macos")))]
#[tauri::command]
#[specta::specta]
fn get_preferred_stockfish_build_key() -> String {
    String::new()
}

#[cfg(all(
    any(target_os = "windows", target_os = "linux"),
    target_arch = "x86_64"
))]
fn has_avx_vnni() -> bool {
    // AVX VNNI (aka AVX2+VNNI) is reported by CPUID.(EAX=7, ECX=1):EAX[4].
    //
    // We intentionally only use this for build selection; actual AVX usage is
    // validated via `is_x86_feature_detected!` elsewhere (e.g. AVX2).
    use std::arch::x86_64::__cpuid_count;

    unsafe {
        // First check max supported subleaf for leaf 7.
        let leaf7_0 = __cpuid_count(0x7, 0x0);
        let max_subleaf = leaf7_0.eax;
        if max_subleaf < 1 {
            return false;
        }

        let leaf7_1 = __cpuid_count(0x7, 0x1);
        (leaf7_1.eax & (1 << 4)) != 0
    }
}

#[cfg(all(
    any(target_os = "windows", target_os = "linux"),
    target_arch = "x86_64"
))]
fn has_avx512_icl_like() -> bool {
    // "AVX-512ICL" binaries typically assume the "full" AVX-512 feature set found on
    // Ice Lake-family CPUs (and later), including VNNI. We approximate this by
    // requiring the key AVX-512 subsets that Stockfish uses in that build.
    is_x86_feature_detected!("avx512f")
        && is_x86_feature_detected!("avx512bw")
        && is_x86_feature_detected!("avx512dq")
        && is_x86_feature_detected!("avx512vl")
        && is_x86_feature_detected!("avx512vnni")
}

#[cfg(all(any(target_os = "windows", target_os = "linux"), target_arch = "aarch64"))]
fn has_aarch64_dotprod() -> bool {
    // `dotprod` is optional on ARMv8; gate selection for dotprod builds.
    //
    // `std::arch::is_*_feature_detected!` for ARM is currently unstable on stable Rust.
    // For our purposes (selecting a bundled engine build), compile-time detection is
    // sufficient and avoids relying on unstable std APIs.
    cfg!(target_feature = "dotprod")
}

#[cfg(all(target_os = "linux", target_arch = "arm"))]
fn has_arm_neon() -> bool {
    // `std::arch::is_arm_feature_detected!` is currently unstable on stable Rust.
    // Use compile-time detection instead to keep release builds working everywhere.
    cfg!(target_feature = "neon")
}

#[tauri::command]
#[specta::specta]
fn memory_size() -> u64 {
    sysinfo::System::new_all().total_memory() / (1024 * 1024)
}

#[tauri::command]
#[specta::specta]
fn process_memory_rss_mb() -> Option<u64> {
    let mut system = sysinfo::System::new_all();
    let pid = sysinfo::Pid::from_u32(std::process::id());
    system.refresh_process(pid);
    system
        .process(pid)
        .map(|process| process.memory() / (1024 * 1024))
}

#[cfg(target_os = "windows")]
fn get_gpu_names() -> Result<Vec<String>, String> {
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
        ])
        .output()
        .map_err(|e| format!("Failed to query GPU names: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let names: Vec<String> = stdout
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .filter(|line| {
                let lower = line.to_lowercase();
                !lower.contains("microsoft basic display adapter") && !lower.contains("virtual")
            })
            .map(|line| line.to_string())
            .collect();

        if !names.is_empty() {
            return Ok(names);
        }
    }

    let output = Command::new("wmic")
        .args(["path", "win32_VideoController", "get", "name"])
        .output()
        .map_err(|e| format!("Failed to query GPU names via wmic: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let names: Vec<String> = stdout
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty() && !line.eq_ignore_ascii_case("name"))
            .filter(|line| {
                let lower = line.to_lowercase();
                !lower.contains("microsoft basic display adapter") && !lower.contains("virtual")
            })
            .map(|line| line.to_string())
            .collect();

        return Ok(names);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!("Failed to query GPU names: {}", stderr.trim()))
}

#[cfg(target_os = "windows")]
#[tauri::command]
#[specta::specta]
fn get_preferred_lc0_engine_name() -> Result<Option<String>, String> {
    const LC0_CUDA12: &str = "Leela Chess Zero (CUDA 12)";
    const LC0_CUDNN: &str = "Leela Chess Zero (CUDNN)";
    const LC0_ONNX_DML: &str = "Leela Chess Zero (ONNX-DML)";
    const LC0_DNNL: &str = "Leela Chess Zero (DNNL)";

    let gpu_names = get_gpu_names().unwrap_or_default();
    if gpu_names.is_empty() {
        return Ok(Some(LC0_DNNL.to_string()));
    }

    let mut has_gtx_legacy = false;
    for raw_name in gpu_names {
        let name = raw_name.to_uppercase();

        if name.contains("RTX") {
            if let Some(series) = parse_gpu_series(&name, "RTX") {
                if series >= 2000 {
                    return Ok(Some(LC0_CUDA12.to_string()));
                }
            } else if contains_any(&name, &["RTX 20", "RTX 30", "RTX 40"]) {
                return Ok(Some(LC0_CUDA12.to_string()));
            }
        }

        if name.contains("GTX") {
            if let Some(series) = parse_gpu_series(&name, "GTX") {
                if (600..=1699).contains(&series) {
                    has_gtx_legacy = true;
                }
            } else {
                has_gtx_legacy = true;
            }
        }
    }

    if has_gtx_legacy {
        return Ok(Some(LC0_CUDNN.to_string()));
    }

    Ok(Some(LC0_ONNX_DML.to_string()))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
#[specta::specta]
fn get_preferred_lc0_engine_name() -> Result<Option<String>, String> {
    Ok(Some("Leela Chess Zero (DNNL)".to_string()))
}

#[cfg(target_os = "windows")]
fn parse_gpu_series(name: &str, token: &str) -> Option<u32> {
    let name_upper = name.to_uppercase();
    let token_upper = token.to_uppercase();
    let start = name_upper.find(&token_upper)?;
    let after_token = start.checked_add(token_upper.len())?;
    let mut chars = name_upper.get(after_token..)?.chars().peekable();

    while let Some(c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }

    let mut digits = String::new();
    while let Some(c) = chars.peek() {
        if c.is_ascii_digit() && digits.len() < 4 {
            digits.push(*c);
            chars.next();
        } else {
            break;
        }
    }

    if digits.len() >= 3 {
        digits.parse::<u32>().ok()
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
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

use diesel::Connection as DieselConnection;
use ocs_lib::db::{
    backfill_profile_weakness_features_for_player, build_weakness_snapshot_v1, ensure_profile_weakness_tables,
    get_weakness_evidence, get_weakness_signals, replace_weakness_snapshot, WeaknessAggregationInputRow,
};
use rusqlite::{Connection as RusqliteConnection, OptionalExtension};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

#[derive(Debug)]
struct ProfileGameRow {
    game_id: i32,
    result: Option<String>,
    white_id: i32,
    white_name: Option<String>,
    black_name: Option<String>,
    ply_count: Option<i32>,
    opening_family: Option<String>,
    time_control_bucket: Option<String>,
    color_played: Option<String>,
    ply_bucket_features_json: String,
    features_json: String,
}

fn app_data_dir() -> PathBuf {
    let app_data = std::env::var("APPDATA").expect("APPDATA is required for Isabeast E2E test");
    Path::new(&app_data).join("com.ocs")
}

fn profile_id_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    stem.strip_prefix("profile_").map(|v| v.to_string())
}

fn find_profile_by_name(db_dir: &Path, profile_name: &str) -> Option<(String, PathBuf)> {
    let entries = fs::read_dir(db_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db3") {
            continue;
        }
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if !file_name.starts_with("profile_") {
            continue;
        }

        let Ok(conn) = RusqliteConnection::open(&path) else {
            continue;
        };
        let player_name: Option<String> = conn
            .query_row(
                "SELECT Value FROM Info WHERE Name = 'ProfilePlayerName' LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten();
        if player_name
            .as_deref()
            .map(|v| v.eq_ignore_ascii_case(profile_name))
            .unwrap_or(false)
        {
            if let Some(profile_id) = profile_id_from_filename(&path) {
                return Some((profile_id, path));
            }
        }
    }
    None
}

fn load_profile_player_id(conn: &RusqliteConnection) -> i32 {
    let raw_value = conn
        .query_row(
            "SELECT Value FROM Info WHERE Name = 'ProfilePlayerId' LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .expect("ProfilePlayerId must exist for Isabeast profile");
    raw_value
        .trim()
        .parse::<i32>()
        .expect("ProfilePlayerId in Info.Value must be a valid integer")
}

fn profile_outcome_from_result(result: Option<&str>, profile_is_white: bool) -> Option<String> {
    match result.unwrap_or_default().trim() {
        "1-0" => Some(if profile_is_white { "win" } else { "loss" }.to_string()),
        "0-1" => Some(if profile_is_white { "loss" } else { "win" }.to_string()),
        "1/2-1/2" => Some("draw".to_string()),
        _ => Some("unknown".to_string()),
    }
}

fn normalize_opt_text(v: Option<String>) -> Option<String> {
    v.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        }
    })
}

fn ensure_profile_analysis_tables(conn: &RusqliteConnection) {
    conn.execute_batch(include_str!("../../database/schema/profile_analysis_tables.sql"))
        .expect("ensure profile analysis tables");
}

fn analysis_game_key_to_db_id(
    stored_profile_id: &str,
    game_key: &str,
    target_profile_id: &str,
) -> Option<i32> {
    let key = game_key.trim();
    if key.is_empty() {
        return None;
    }
    if let Ok(v) = key.parse::<i32>() {
        if v <= 0 {
            return None;
        }
        let pid = stored_profile_id.trim();
        if pid.eq_ignore_ascii_case(target_profile_id) || pid.is_empty() {
            return Some(v);
        }
        return None;
    }

    let suffix_digits_rev: String = key.chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if suffix_digits_rev.is_empty() {
        return None;
    }
    let suffix_digits: String = suffix_digits_rev.chars().rev().collect();
    let Ok(v) = suffix_digits.parse::<i32>() else {
        return None;
    };
    if v <= 0 {
        return None;
    }

    let key_lower = key.to_lowercase();
    let profile_lower = target_profile_id.to_lowercase();
    if key_lower.contains(&profile_lower) {
        Some(v)
    } else {
        None
    }
}

fn load_profile_game_ids(conn: &RusqliteConnection, profile_player_id: i32) -> HashSet<i32> {
    let mut out = HashSet::new();
    let mut stmt = conn
        .prepare("SELECT ID FROM Games WHERE WhiteID = ?1 OR BlackID = ?1")
        .expect("prepare profile games id query");
    let rows = stmt
        .query_map([profile_player_id], |row| row.get::<_, i32>(0))
        .expect("query profile game ids");
    for gid in rows.flatten() {
        out.insert(gid);
    }
    out
}

fn build_analysis_stats_map(
    profile_conn: &RusqliteConnection,
    analysis_conn: &RusqliteConnection,
    profile_id: &str,
    profile_player_id: i32,
) -> HashMap<i32, (Option<f64>, Option<f64>, Option<i64>)> {
    let profile_game_ids = load_profile_game_ids(profile_conn, profile_player_id);
    let mut out: HashMap<i32, (Option<f64>, Option<f64>, Option<i64>)> = HashMap::new();

    let mut stmt = analysis_conn
        .prepare(
            r#"
            SELECT profile_id, game_id, accuracy, acpl, estimated_elo
            FROM game_analysis
            WHERE analyzed_pgn IS NOT NULL
            "#,
        )
        .expect("prepare analysis map query");
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<f64>>(2)?,
                row.get::<_, Option<f64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .expect("query analysis map rows");

    for row in rows.flatten() {
        let Some(mapped_game_id) = analysis_game_key_to_db_id(&row.0, &row.1, profile_id) else {
            continue;
        };
        if !profile_game_ids.contains(&mapped_game_id) {
            continue;
        }
        out.entry(mapped_game_id).or_insert((row.2, row.3, row.4));
    }

    out
}

fn seed_game_analysis_stats(
    profile_conn: &RusqliteConnection,
    analysis_stats_map: &HashMap<i32, (Option<f64>, Option<f64>, Option<i64>)>,
    fallback_game_ids: &HashSet<i32>,
) -> usize {
    let mut seeded = 0usize;
    let mut ids: Vec<i32> = if analysis_stats_map.is_empty() {
        fallback_game_ids.iter().copied().collect()
    } else {
        analysis_stats_map.keys().copied().collect()
    };
    ids.sort_unstable();
    ids.dedup();

    for gid in ids {
        let inserted = profile_conn
            .execute(
                r#"
                INSERT OR IGNORE INTO GameAnalysisStats
                    (GameID, Winner, WinPhase, WinPly, ComputedAt, Version, Extra)
                VALUES
                    (?1, 'unknown', 'unknown', NULL, '2026-01-01T00:00:00Z', 1, '{}')
                "#,
                [gid],
            )
            .expect("insert placeholder GameAnalysisStats row");
        if inserted > 0 {
            seeded += 1;
        }
    }
    seeded
}

fn load_profile_rows(conn: &RusqliteConnection, profile_player_id: i32) -> Vec<ProfileGameRow> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                g.ID AS game_id,
                g.Result,
                g.WhiteID,
                pw.Name AS white_name,
                pb.Name AS black_name,
                g.PlyCount,
                wgf.OpeningFamily,
                wgf.TimeControlBucket,
                wgf.ColorPlayed,
                wgf.PlyBucketFeaturesJson,
                wgf.FeaturesJson
            FROM Games g
            LEFT JOIN Players pw ON pw.ID = g.WhiteID
            LEFT JOIN Players pb ON pb.ID = g.BlackID
            INNER JOIN GameAnalysisStats gas ON gas.GameID = g.ID
            INNER JOIN WeaknessGameFeatures wgf ON wgf.GameID = g.ID
            WHERE g.WhiteID = ?1 OR g.BlackID = ?1
            "#,
        )
        .expect("prepare profile weakness source query");

    let rows = stmt
        .query_map([profile_player_id], |row| {
            Ok(ProfileGameRow {
                game_id: row.get(0)?,
                result: row.get(1)?,
                white_id: row.get(2)?,
                white_name: row.get(3)?,
                black_name: row.get(4)?,
                ply_count: row.get(5)?,
                opening_family: row.get(6)?,
                time_control_bucket: row.get(7)?,
                color_played: row.get(8)?,
                ply_bucket_features_json: row.get(9)?,
                features_json: row.get(10)?,
            })
        })
        .expect("map profile weakness rows");

    rows.filter_map(Result::ok).collect()
}

#[test]
fn isabeast_real_profile_generates_weakness_signals_e2e() {
    let app_data = app_data_dir();
    let profiles_dir = app_data.join("db");
    let analysis_db_path = app_data.join("analysis.db3");
    assert!(
        analysis_db_path.exists(),
        "analysis.db3 was not found at {}",
        analysis_db_path.display()
    );

    let (profile_id, profile_db_path) = find_profile_by_name(&profiles_dir, "Isabeast")
        .expect("Could not find Isabeast profile DB under AppData/com.ocs/db");

    let temp_copy = NamedTempFile::new().expect("create temp profile DB copy");
    fs::copy(&profile_db_path, temp_copy.path()).expect("copy Isabeast profile DB to temp");

    let profile_conn = RusqliteConnection::open(temp_copy.path()).expect("open temp profile db");
    let analysis_conn = RusqliteConnection::open(&analysis_db_path).expect("open analysis.db3");
    let profile_player_id = load_profile_player_id(&profile_conn);
    let profile_game_ids = load_profile_game_ids(&profile_conn, profile_player_id);

    ensure_profile_analysis_tables(&profile_conn);
    let analysis_stats_map = build_analysis_stats_map(
        &profile_conn,
        &analysis_conn,
        &profile_id,
        profile_player_id,
    );
    let seeded = seed_game_analysis_stats(&profile_conn, &analysis_stats_map, &profile_game_ids);

    let mut diesel_conn =
        diesel::SqliteConnection::establish(temp_copy.path().to_string_lossy().as_ref()).expect("open temp profile db with diesel");
    ensure_profile_weakness_tables(&mut diesel_conn).expect("ensure weakness tables");
    let backfilled = backfill_profile_weakness_features_for_player(&mut diesel_conn, profile_player_id)
        .expect("backfill weakness features for Isabeast");

    let source_rows = load_profile_rows(&profile_conn, profile_player_id);
    assert!(
        !source_rows.is_empty(),
        "No weakness source rows after seeding/backfill (seeded={seeded}, backfilled={backfilled})"
    );

    let mut input_rows: Vec<WeaknessAggregationInputRow> = Vec::with_capacity(source_rows.len());
    for row in source_rows {
        let profile_is_white = row.white_id == profile_player_id;
        let stats = analysis_stats_map.get(&row.game_id).copied();
        let opponent_name = if profile_is_white {
            row.black_name.clone()
        } else {
            row.white_name.clone()
        };

        input_rows.push(WeaknessAggregationInputRow {
            game_id: row.game_id,
            timestamp_ms: None,
            profile_outcome: profile_outcome_from_result(row.result.as_deref(), profile_is_white),
            opponent_name: normalize_opt_text(opponent_name),
            accuracy: stats.and_then(|s| s.0),
            acpl: stats.and_then(|s| s.1),
            blunder_rate: None,
            mistake_rate: None,
            inaccuracy_rate: None,
            estimated_elo: stats.and_then(|s| s.2),
            opening_family: normalize_opt_text(row.opening_family),
            time_control_bucket: normalize_opt_text(row.time_control_bucket),
            color_played: normalize_opt_text(row.color_played),
            game_length_ply: row.ply_count,
            ply_bucket_features_json: serde_json::from_str(&row.ply_bucket_features_json).unwrap_or_else(|_| json!({})),
            features_json: serde_json::from_str(&row.features_json).unwrap_or_else(|_| json!({})),
        });
    }

    let build = build_weakness_snapshot_v1(&input_rows, Some(12), Some(4));
    assert!(
        build.scored_games > 0,
        "Expected scored games > 0 for Isabeast weakness model"
    );
    assert!(
        !build.signals.is_empty(),
        "Expected at least one weakness signal for Isabeast"
    );

    let snapshot_key = format!("wm:v1:{}:p-all_tc-any_elo-all_dr-all", profile_id);
    let generated_at = "2026-01-01T00:00:00Z".to_string();
    let filters_json = json!({
        "scope": "p-all_tc-any_elo-all_dr-all",
        "platform": "all",
        "timeControl": "any",
        "opponentEloBucket": serde_json::Value::Null,
        "dateRange": "all",
    });
    replace_weakness_snapshot(
        &mut diesel_conn,
        &snapshot_key,
        1,
        &generated_at,
        &filters_json,
        &build.signals,
        &build.evidence,
    )
    .expect("persist weakness snapshot");

    let signals = get_weakness_signals(&mut diesel_conn, &snapshot_key, 12, 0).expect("load persisted signals");
    assert!(
        !signals.is_empty(),
        "Expected persisted weakness signals for Isabeast"
    );

    let evidence = get_weakness_evidence(&mut diesel_conn, &snapshot_key, &signals[0].signal_key, 4, 0)
        .expect("load persisted evidence");
    assert!(
        !evidence.is_empty(),
        "Expected at least one evidence row for first signal"
    );
}

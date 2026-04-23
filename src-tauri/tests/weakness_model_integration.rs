use diesel::prelude::*;
use ocs_lib::db::{
    build_weakness_snapshot_v1, compose_profile_weakness_model, ensure_profile_weakness_tables,
    get_weakness_evidence, get_weakness_signals, replace_weakness_snapshot,
    WeaknessAggregationInputRow,
};
use serde_json::json;
use tempfile::NamedTempFile;

fn create_minimal_games_table(conn: &mut SqliteConnection) {
    diesel::sql_query(
        "CREATE TABLE IF NOT EXISTS Games (
            ID INTEGER PRIMARY KEY NOT NULL
        )",
    )
    .execute(conn)
    .expect("create minimal Games table");
}

fn seed_games(conn: &mut SqliteConnection, rows: &[WeaknessAggregationInputRow]) {
    for row in rows {
        diesel::sql_query(format!(
            "INSERT INTO Games (ID) VALUES ({})",
            row.game_id
        ))
        .execute(conn)
        .expect("seed game id");
    }
}

fn make_row(game_id: i32, is_hit: bool) -> WeaknessAggregationInputRow {
    let (outcome, acpl, accuracy, blunder_rate, mistake_rate, inaccuracy_rate) = if is_hit {
        ("loss", 82.0, 73.0, 0.14, 0.22, 0.31)
    } else {
        ("win", 24.0, 93.0, 0.02, 0.07, 0.12)
    };

    WeaknessAggregationInputRow {
        game_id,
        timestamp_ms: None,
        profile_outcome: Some(outcome.to_string()),
        opponent_name: Some(format!("Opponent_{game_id}")),
        accuracy: Some(accuracy),
        acpl: Some(acpl),
        blunder_rate: Some(blunder_rate),
        mistake_rate: Some(mistake_rate),
        inaccuracy_rate: Some(inaccuracy_rate),
        estimated_elo: Some(2300),
        opening_family: None,
        time_control_bucket: None,
        color_played: None,
        game_length_ply: Some(44),
        ply_bucket_features_json: json!({}),
        features_json: json!({
            "castling": {
                "uncastledByPly12": is_hit,
                "profilePly": if is_hit { serde_json::Value::Null } else { json!(7) }
            },
            "rookActivity": {
                "rooksConnectedByPly18": !is_hit,
                "firstRookActivationPly": if is_hit { 21 } else { 12 }
            },
            "fileControl": {
                "openFileControlDeltaPly20": if is_hit { -1 } else { 1 },
                "openFileControlDeltaFinal": if is_hit { -1 } else { 1 },
                "semiOpenFileControlDeltaPly20": if is_hit { -1 } else { 1 },
                "semiOpenFileControlDeltaFinal": if is_hit { -1 } else { 1 }
            },
            "pressureTargets": {
                "hTargetPressurePly": if is_hit { json!(14) } else { serde_json::Value::Null },
                "fTargetPressurePly": if is_hit { json!(13) } else { serde_json::Value::Null }
            },
            "longEndgame": true,
            "gameLengthPly": 44
        }),
    }
}

#[test]
fn isabeast_scope_all_any_all_all_time_generates_and_persists_signals() {
    let db_file = NamedTempFile::new().expect("create temp db file");
    let db_path = db_file.path().to_string_lossy().to_string();
    let mut conn = SqliteConnection::establish(&db_path).expect("open sqlite connection");

    create_minimal_games_table(&mut conn);
    ensure_profile_weakness_tables(&mut conn).expect("create weakness tables");

    let mut rows = Vec::new();
    for i in 0..12 {
        rows.push(make_row(1000 + i, true));
    }
    for i in 0..8 {
        rows.push(make_row(2000 + i, false));
    }
    seed_games(&mut conn, &rows);

    let build = build_weakness_snapshot_v1(&rows, Some(12), Some(4));
    assert!(
        !build.signals.is_empty(),
        "Expected at least one signal in all/any/all/all-time scope"
    );

    let snapshot_key = "wm:v1:isabeast:p-all_tc-any_elo-all_dr-all".to_string();
    let generated_at = "2026-01-01T00:00:00Z".to_string();
    let filters_json = json!({
        "scope": "p-all_tc-any_elo-all_dr-all",
        "platform": "all",
        "timeControl": "any",
        "opponentEloBucket": serde_json::Value::Null,
        "dateRange": "all",
    });

    replace_weakness_snapshot(
        &mut conn,
        &snapshot_key,
        1,
        &generated_at,
        &filters_json,
        &build.signals,
        &build.evidence,
    )
    .expect("persist weakness snapshot");

    let signals = get_weakness_signals(&mut conn, &snapshot_key, 12, 0).expect("load signals");
    assert!(
        !signals.is_empty(),
        "Expected persisted weakness signals to be retrievable"
    );

    let first_signal_key = signals[0].signal_key.clone();
    let evidence =
        get_weakness_evidence(&mut conn, &snapshot_key, &first_signal_key, 4, 0).expect("load evidence");
    assert!(
        !evidence.is_empty(),
        "Expected at least one evidence row for top signal"
    );

    let mut evidence_by_signal = std::collections::HashMap::new();
    evidence_by_signal.insert(first_signal_key.clone(), evidence);
    let model = compose_profile_weakness_model(
        snapshot_key,
        generated_at,
        build.total_games,
        build.scored_games,
        0,
        signals,
        evidence_by_signal,
        None,
    );
    assert!(
        !model.signals.is_empty(),
        "Expected composed weakness model to contain signals"
    );
}

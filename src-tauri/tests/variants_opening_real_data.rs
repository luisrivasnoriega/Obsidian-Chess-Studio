use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use ocs_lib::db::pgn::{GameTree, GameTreeNode, Importer};
use ocs_lib::{variants_compress_variant_family, variants_create_opening_variants};
use pgn_reader::BufferedReader;
use serde_json::Value;
use shakmaty::{fen::Fen, Chess, EnPassantMode, Position};
use tempfile::tempdir;

const B00_FILE_NAME: &str = "B00 - King's Pawn Game.pgn";
const B00_INFO_NAME: &str = "B00 - King's Pawn Game.info";
const B31_ROSSOLIMO_C3_FILE_NAME: &str = "B31 - Rossolimo, 3...g6 4.O-O Bg7 5.c3.pgn";

fn copy_dir_contents(source: &Path, target: &Path) {
    for entry in fs::read_dir(source).expect("read source variants directory") {
        let entry = entry.expect("read source variants entry");
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry.file_type().expect("read source variants file type");
        if file_type.is_dir() {
            fs::create_dir_all(&target_path).expect("create copied variants subdirectory");
            copy_dir_contents(&source_path, &target_path);
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).expect("copy variant file");
        }
    }
}

fn real_variants_dir() -> PathBuf {
    env::var_os("OCS_REAL_VARIANTS_DIR")
        .map(PathBuf::from)
        .expect("set OCS_REAL_VARIANTS_DIR to the Isabella variants directory")
}

fn child_link_count(info_path: &Path) -> usize {
    let raw = fs::read_to_string(info_path).expect("read B00 info file");
    let value: Value = serde_json::from_str(&raw).expect("parse B00 info file");
    value
        .get("links")
        .and_then(|links| links.get("children"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or_default()
}

fn fen_from_position(position: &Chess) -> String {
    Fen::from_position(position.clone(), EnPassantMode::Legal).to_string()
}

fn validate_game_tree(tree: &GameTree, start_position: &Chess) -> Result<(), String> {
    let mut current_position = start_position.clone();
    let mut previous_position = current_position.clone();

    for node in tree.nodes() {
        match node {
            GameTreeNode::Move(san_plus) => {
                let san = san_plus.to_string();
                let before = fen_from_position(&current_position);
                let chess_move = san_plus
                    .san
                    .to_move(&current_position)
                    .map_err(|error| format!("invalid SAN {san} at {before}: {error}"))?;
                previous_position = current_position.clone();
                current_position.play_unchecked(&chess_move);
            }
            GameTreeNode::Variation(branch) => validate_game_tree(branch, &previous_position)?,
            GameTreeNode::Comment(_) | GameTreeNode::Nag(_) => {}
        }
    }

    Ok(())
}

fn count_backend_readable_games(path: &Path) -> Result<usize, String> {
    let file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut reader = BufferedReader::new(file);
    let mut count = 0;

    loop {
        let mut importer = Importer::new(None);
        match reader.read_game(&mut importer) {
            Ok(Some(Some(game))) => {
                validate_game_tree(&game.tree, &game.position)?;
                count += 1;
            }
            Ok(Some(None)) => {}
            Ok(None) => break,
            Err(error) => return Err(error.to_string()),
        }
    }

    Ok(count)
}

#[test]
#[ignore = "requires Isabella real variants data; set OCS_REAL_VARIANTS_DIR"]
fn real_data_b00_compress_is_safe_and_split_rewrites_root_when_family_is_valid() {
    let source_dir = real_variants_dir();
    let source_target = source_dir.join(B00_FILE_NAME);
    assert!(
        source_target.exists(),
        "missing real-data source variant: {}",
        source_target.display()
    );

    let temp = tempdir().expect("create temporary variants directory");
    copy_dir_contents(&source_dir, temp.path());

    let target_path = temp.path().join(B00_FILE_NAME);
    let info_path = temp.path().join(B00_INFO_NAME);
    assert!(target_path.exists(), "temporary B00 PGN was not copied");
    assert!(info_path.exists(), "temporary B00 metadata was not copied");
    let initial_games = count_backend_readable_games(&target_path).unwrap_or_else(|error| {
        panic!(
            "copied real-data B00 PGN is not backend-readable before compression: {error}; path={}",
            target_path.display()
        )
    });
    assert!(
        initial_games > 0,
        "copied real-data B00 PGN has no backend-readable games before compression"
    );
    let original_root = fs::read_to_string(&target_path).expect("read copied B00 PGN");

    let compress_result = variants_compress_variant_family(
        temp.path().to_string_lossy().to_string(),
        target_path.to_string_lossy().to_string(),
    );
    let compress_result = match compress_result {
        Ok(result) => result,
        Err(error) => {
            let error = error.to_string();
            assert!(
                error.contains("Cannot process variant")
                    || error.contains("contains illegal PGN")
                    || error.contains("parser error"),
                "compression failed for an unexpected reason: {error}"
            );
            assert_eq!(
                fs::read_to_string(&target_path).expect("read rejected B00 PGN"),
                original_root,
                "failed compression should leave copied B00 unchanged"
            );
            assert!(
                child_link_count(&info_path) > 0,
                "failed compression should leave copied B00 child links unchanged"
            );
            return;
        }
    };
    assert!(
        compress_result.merged > 1,
        "real B00 data should have descendants to compress"
    );

    let compressed_root = fs::read_to_string(&target_path).expect("read compressed B00 PGN");
    let compressed_games = count_backend_readable_games(&target_path).unwrap_or_else(|error| {
        panic!(
            "compression wrote a B00 PGN that the backend parser cannot read: {error}; path={}",
            target_path.display()
        )
    });
    assert!(
        compressed_games > 0,
        "compression wrote a B00 PGN with no backend-readable games"
    );

    let split_result = variants_create_opening_variants(
        temp.path().to_string_lossy().to_string(),
        target_path.to_string_lossy().to_string(),
    )
    .expect("split copied compressed B00 family into ECO variants");
    assert!(
        split_result.created > 0,
        "ECO split should create descendant variants from the copied B00 data"
    );

    let split_root = fs::read_to_string(&target_path).expect("read split B00 PGN");
    let split_child_links = child_link_count(&info_path);
    assert!(
        split_child_links > 0,
        "ECO split should recreate child links for the copied B00 root"
    );
    assert_ne!(
        split_root, compressed_root,
        "ECO split recreated children but left the compressed root PGN unchanged"
    );
}

#[test]
#[ignore = "requires Isabella real variants data; set OCS_REAL_VARIANTS_DIR"]
fn real_data_b31_rossolimo_c3_is_backend_readable() {
    let target_path = real_variants_dir().join(B31_ROSSOLIMO_C3_FILE_NAME);
    assert!(
        target_path.exists(),
        "missing real-data source variant: {}",
        target_path.display()
    );

    let games = count_backend_readable_games(&target_path).unwrap_or_else(|error| {
        panic!(
            "real-data B31 Rossolimo c3 PGN is not backend-readable: {error}; path={}",
            target_path.display()
        )
    });
    assert!(games > 0, "real-data B31 Rossolimo c3 PGN has no games");
}

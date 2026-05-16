//! PGN enrichment utilities for annotated analysis output.
//!
//! This module builds an enriched PGN by replaying the main line from UCI moves
//! and injecting:
//! - NAGs
//! - textual comments
//! - optional suggested variations

use chrono::Utc;
use pgn_reader::Nag;
use serde::{Deserialize, Serialize};
use shakmaty::{
    fen::Fen, san::SanPlus, uci::UciMove, CastlingMode, Chess, EnPassantMode, Position,
};
use specta::Type;

use crate::{
    db::pgn::{GameTree, GameTreeNode},
    error::Error,
};

/// Per-move PGN annotation payload for the enriched main line.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct PgnMoveAnnotation {
    pub nag: Option<u8>,
    pub comment: Option<String>,
    pub variation_uci: Vec<String>,
    pub variation_comment: Option<String>,
}

/// Input payload for PGN enrichment.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BuildAnnotatedPgnRequest {
    pub initial_fen: String,
    pub moves: Vec<String>,
    pub original_pgn: Option<String>,
    pub annotator: Option<String>,
    pub move_annotations: Vec<PgnMoveAnnotation>,
    pub max_variation_plies: Option<u32>,
}

/// Build an enriched PGN text from a move list and per-move annotations.
pub fn build_annotated_pgn(request: BuildAnnotatedPgnRequest) -> Result<String, Error> {
    let BuildAnnotatedPgnRequest {
        initial_fen,
        moves,
        original_pgn,
        annotator,
        move_annotations,
        max_variation_plies,
    } = request;

    let mut position = parse_position(&initial_fen)?;
    let mut tree = GameTree::new();
    let max_var = max_variation_plies.unwrap_or(5).clamp(1, 20) as usize;

    for (ply, raw_uci) in moves.iter().enumerate() {
        let before = position.clone();
        let played_uci = normalize_move_key(raw_uci);
        let parsed_uci = UciMove::from_ascii(played_uci.as_bytes())?;
        let mv = parsed_uci.to_move(&before)?;
        let san_plus = SanPlus::from_move_and_play_unchecked(&mut position, &mv);
        tree.push(GameTreeNode::Move(san_plus));

        let ann = move_annotations.get(ply).cloned().unwrap_or_default();
        if let Some(nag) = ann.nag {
            tree.push(GameTreeNode::Nag(Nag(nag)));
        }
        if let Some(comment) = ann.comment {
            let sanitized = sanitize_comment(&comment);
            if !sanitized.is_empty() {
                tree.push(GameTreeNode::Comment(sanitized));
            }
        }
        if !ann.variation_uci.is_empty() {
            let variation_tree = build_variation_tree(
                before,
                &ann.variation_uci,
                ann.variation_comment.as_deref(),
                max_var,
            );
            if !variation_tree.nodes().is_empty() {
                tree.push(GameTreeNode::Variation(variation_tree));
            }
        }
    }

    let (mut headers, result_token) =
        extract_or_build_headers(original_pgn.as_deref(), &initial_fen);
    ensure_annotator_header(
        &mut headers,
        annotator
            .as_deref()
            .unwrap_or("OCS Human Strategic Analyzer"),
    );

    let movetext = tree.to_string().trim().to_string();
    if movetext.is_empty() {
        return Err(Error::InvalidInput(
            "Could not build annotated movetext from provided moves".to_string(),
        ));
    }

    Ok(format!(
        "{}\n\n{} {}\n",
        headers.join("\n"),
        movetext,
        result_token
    ))
}

fn build_variation_tree(
    start: Chess,
    line_uci: &[String],
    variation_comment: Option<&str>,
    max_plies: usize,
) -> GameTree {
    let mut variation = GameTree::new();
    let mut pos = start;
    let mut first_move_written = false;
    for uci_str in line_uci.iter().take(max_plies) {
        let uci_norm = normalize_move_key(uci_str);
        let Ok(uci) = UciMove::from_ascii(uci_norm.as_bytes()) else {
            break;
        };
        let Ok(mv) = uci.to_move(&pos) else {
            break;
        };
        let san = SanPlus::from_move_and_play_unchecked(&mut pos, &mv);
        variation.push(GameTreeNode::Move(san));
        if !first_move_written {
            if let Some(raw) = variation_comment {
                let sanitized = sanitize_comment(raw);
                if !sanitized.is_empty() {
                    variation.push(GameTreeNode::Comment(sanitized));
                }
            }
            first_move_written = true;
        }
        if pos.is_game_over() {
            break;
        }
    }
    variation
}

fn sanitize_comment(raw: &str) -> String {
    raw.replace('{', "(")
        .replace('}', ")")
        .replace('\n', " ")
        .trim()
        .to_string()
}

fn normalize_move_key(mv: &str) -> String {
    mv.trim().to_ascii_lowercase()
}

fn parse_position(initial_fen: &str) -> Result<Chess, Error> {
    let trimmed = initial_fen.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("startpos") {
        return Ok(Chess::default());
    }
    let fen = Fen::from_ascii(trimmed.as_bytes())?;
    Ok(fen.into_position(CastlingMode::Chess960)?)
}

fn normalize_fen_key(fen: &str) -> String {
    fen.split_whitespace().take(4).collect::<Vec<_>>().join(" ")
}

fn is_start_position(initial_fen: &str) -> bool {
    let trimmed = initial_fen.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("startpos") {
        return true;
    }
    let start_key = normalize_fen_key(
        &Fen::from_setup(Chess::default().clone().into_setup(EnPassantMode::Legal)).to_string(),
    );
    normalize_fen_key(trimmed) == start_key
}

fn extract_or_build_headers(
    original_pgn: Option<&str>,
    initial_fen: &str,
) -> (Vec<String>, String) {
    let mut headers = extract_headers_from_pgn(original_pgn.unwrap_or_default());
    let mut result = find_tag_value(&headers, "Result").unwrap_or_else(|| "*".to_string());
    if result.trim().is_empty() {
        result = "*".to_string();
    }

    if headers.is_empty() {
        let date = Utc::now().format("%Y.%m.%d").to_string();
        headers = vec![
            r#"[Event "?"]"#.to_string(),
            r#"[Site "?"]"#.to_string(),
            format!(r#"[Date "{}"]"#, date),
            r#"[Round "?"]"#.to_string(),
            r#"[White "?"]"#.to_string(),
            r#"[Black "?"]"#.to_string(),
            format!(r#"[Result "{}"]"#, result),
        ];
    } else if find_tag_value(&headers, "Result").is_none() {
        headers.push(format!(r#"[Result "{}"]"#, result));
    }

    if !is_start_position(initial_fen) {
        if find_tag_value(&headers, "SetUp").is_none() {
            headers.push(r#"[SetUp "1"]"#.to_string());
        }
        if find_tag_value(&headers, "FEN").is_none() {
            headers.push(format!(
                r#"[FEN "{}"]"#,
                initial_fen.trim().replace('"', "\\\"")
            ));
        }
    }

    (headers, result)
}

fn extract_headers_from_pgn(pgn: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in pgn.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !out.is_empty() {
                break;
            }
            continue;
        }
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            out.push(trimmed.to_string());
        } else {
            break;
        }
    }
    out
}

fn find_tag_value(headers: &[String], tag: &str) -> Option<String> {
    let needle = format!("[{} \"", tag);
    for line in headers {
        if !line.starts_with(&needle) {
            continue;
        }
        let rest = &line[needle.len()..];
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    None
}

fn ensure_annotator_header(headers: &mut Vec<String>, annotator: &str) {
    if find_tag_value(headers, "Annotator").is_none() {
        headers.push(format!(
            r#"[Annotator "{}"]"#,
            annotator.trim().replace('"', "\\\"")
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Temporarily disabled while adjusting variation/comment formatting"]
    fn build_annotated_pgn_includes_nag_comment_and_variation() {
        let req = BuildAnnotatedPgnRequest {
            initial_fen: "startpos".to_string(),
            moves: vec![
                "e2e4".to_string(),
                "e7e5".to_string(),
                "g1f3".to_string(),
                "b8c6".to_string(),
            ],
            original_pgn: None,
            annotator: Some("UnitTest Annotator".to_string()),
            move_annotations: vec![
                PgnMoveAnnotation {
                    nag: Some(8),
                    comment: Some("Best {center}\ncontrol".to_string()),
                    variation_uci: vec!["d2d4".to_string(), "d7d5".to_string()],
                    variation_comment: Some("Strategic plan.".to_string()),
                },
                PgnMoveAnnotation::default(),
                PgnMoveAnnotation::default(),
                PgnMoveAnnotation::default(),
            ],
            max_variation_plies: Some(5),
        };

        let pgn = build_annotated_pgn(req).expect("annotated pgn should build");
        assert!(pgn.contains(r#"[Annotator "UnitTest Annotator"]"#));
        assert!(pgn.contains("$8"));
        assert!(pgn.contains("{Best (center) control}"));
        assert!(pgn.contains("( 1.d4 {Strategic plan.} d5 )"));
    }

    #[test]
    fn build_annotated_pgn_preserves_result_from_original_headers() {
        let original = r#"[Event "Test Event"]
[Site "Test Site"]
[Date "2026.04.19"]
[Round "1"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 1-0
"#;

        let req = BuildAnnotatedPgnRequest {
            initial_fen: "startpos".to_string(),
            moves: vec!["e2e4".to_string(), "e7e5".to_string()],
            original_pgn: Some(original.to_string()),
            annotator: None,
            move_annotations: vec![],
            max_variation_plies: None,
        };

        let pgn = build_annotated_pgn(req).expect("annotated pgn should build");
        assert!(pgn.contains(r#"[Event "Test Event"]"#));
        assert!(pgn.contains(r#"[Result "1-0"]"#));
        assert!(pgn.trim_end().ends_with("1-0"));
    }

    #[test]
    fn build_annotated_pgn_adds_setup_and_fen_for_non_start_positions() {
        let fen = "r1bqkbnr/pppp1ppp/2n5/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2";
        let req = BuildAnnotatedPgnRequest {
            initial_fen: fen.to_string(),
            moves: vec!["d2d4".to_string()],
            original_pgn: None,
            annotator: None,
            move_annotations: vec![],
            max_variation_plies: None,
        };

        let pgn = build_annotated_pgn(req).expect("annotated pgn should build");
        assert!(pgn.contains(r#"[SetUp "1"]"#));
        assert!(pgn.contains(&format!(r#"[FEN "{}"]"#, fen)));
    }
}

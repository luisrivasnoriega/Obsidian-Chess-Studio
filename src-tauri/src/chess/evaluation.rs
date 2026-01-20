//! Naive chess evaluation functions for quick material and tactical assessment.
//!
//! This module provides a simple static evaluation and quiescence search for chess positions.
//! Used for quick, engine-independent heuristics (e.g., sacrifice detection).

use shakmaty::{ByColor, Chess, Color, Position, Role};

/// Return the material value for a given piece role.
fn piece_value(role: Role) -> i32 {
    match role {
        Role::Pawn => 90,
        Role::Knight => 300,
        Role::Bishop => 300,
        Role::Rook => 500,
        Role::Queen => 1000,
        _ => 0,
    }
}

/// Count the material balance for the current player.
/// Returns a large negative value if the position is checkmate.
fn count_material(position: &Chess) -> i32 {
    if position.is_checkmate() {
        return -10000;
    }
    let material: ByColor<i32> = position.board().material().map(|p| {
        p.pawn as i32 * piece_value(Role::Pawn)
            + p.knight as i32 * piece_value(Role::Knight)
            + p.bishop as i32 * piece_value(Role::Bishop)
            + p.rook as i32 * piece_value(Role::Rook)
            + p.queen as i32 * piece_value(Role::Queen)
    });
    if position.turn() == Color::White {
        material.white - material.black
    } else {
        material.black - material.white
    }
}

/// Quiescence search: recursively evaluate only capture moves to avoid horizon effect.
/// Returns the best static evaluation for the current player, considering only captures.
fn qsearch(position: &Chess, mut alpha: i32, beta: i32) -> i32 {
    let stand_pat = count_material(position);

    if stand_pat >= beta {
        return beta;
    }
    if alpha < stand_pat {
        alpha = stand_pat;
    }
    let legal_moves = position.legal_moves();
    let mut captures: Vec<_> = legal_moves.iter().filter(|m| m.is_capture()).collect();

    captures.sort_by(|a, b| {
        let a_value = piece_value(a.capture().unwrap());
        let b_value = piece_value(b.capture().unwrap());
        b_value.cmp(&a_value)
    });

    for capture in captures {
        let mut new_position = position.clone();
        new_position.play_unchecked(capture);
        let score = -qsearch(&new_position, -beta, -alpha);
        if score >= beta {
            return beta;
        }
        if score > alpha {
            alpha = score;
        }
    }

    alpha
}

/// Naive static evaluation for a chess position.
///
/// For each legal move, plays the move, runs a quiescence search, and returns the best score.
/// Returns `i32::MIN` if no legal moves are available.
///
/// # Arguments
/// * `pos` - The chess position to evaluate.
///
/// # Returns
/// The best static evaluation score for the current player.
pub fn naive_eval(pos: &Chess) -> i32 {
    pos.legal_moves()
        .iter()
        .map(|mv| {
            let mut new_position = pos.clone();
            new_position.play_unchecked(mv);
            -qsearch(&new_position, i32::MIN, i32::MAX)
        })
        .max()
        .unwrap_or(i32::MIN)
}


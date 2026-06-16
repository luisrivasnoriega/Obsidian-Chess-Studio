use std::collections::HashSet;

use shakmaty::{Board, Color, File, Move, Rank, Role, Square};

#[derive(Debug, Clone)]
pub(super) struct PositionFeatures {
    pub white_pawn_files: [u8; 8],
    pub black_pawn_files: [u8; 8],
    pub white_attacks: HashSet<(usize, usize)>,
    pub black_attacks: HashSet<(usize, usize)>,
    pub white_king: Option<Square>,
    pub black_king: Option<Square>,
    pub white_material_cp: i32,
    pub black_material_cp: i32,
    pub white_mobility: i32,
    pub black_mobility: i32,
    pub white_knight_freedom: i32,
    pub black_knight_freedom: i32,
    pub non_king_piece_total: i32,
    pub white_has_queen: bool,
    pub black_has_queen: bool,
}

impl PositionFeatures {
    pub(super) fn new(board: &Board) -> Self {
        let white_pawn_files = pawn_file_counts_fast(board, Color::White);
        let black_pawn_files = pawn_file_counts_fast(board, Color::Black);

        Self {
            white_pawn_files,
            black_pawn_files,
            white_attacks: attacked_coords_fast(board, Color::White),
            black_attacks: attacked_coords_fast(board, Color::Black),
            white_king: king_square_fast(board, Color::White),
            black_king: king_square_fast(board, Color::Black),
            white_material_cp: material_for(board, Color::White),
            black_material_cp: material_for(board, Color::Black),
            white_mobility: pseudo_mobility_fast(board, Color::White),
            black_mobility: pseudo_mobility_fast(board, Color::Black),
            white_knight_freedom: knight_freedom_fast(board, Color::White),
            black_knight_freedom: knight_freedom_fast(board, Color::Black),
            non_king_piece_total: non_king_piece_total_fast(board),
            white_has_queen: has_queen_fast(board, Color::White),
            black_has_queen: has_queen_fast(board, Color::Black),
        }
    }

    pub(super) fn pawn_files(&self, color: Color) -> &[u8; 8] {
        if color == Color::White {
            &self.white_pawn_files
        } else {
            &self.black_pawn_files
        }
    }

    pub(super) fn attacks(&self, color: Color) -> &HashSet<(usize, usize)> {
        if color == Color::White {
            &self.white_attacks
        } else {
            &self.black_attacks
        }
    }

    pub(super) fn king(&self, color: Color) -> Option<Square> {
        if color == Color::White {
            self.white_king
        } else {
            self.black_king
        }
    }

    pub(super) fn material_balance_cp(&self, side: Color, opponent: Color) -> i32 {
        self.material_for(side) - self.material_for(opponent)
    }

    pub(super) fn mobility(&self, color: Color) -> i32 {
        if color == Color::White {
            self.white_mobility
        } else {
            self.black_mobility
        }
    }

    pub(super) fn knight_freedom(&self, color: Color) -> i32 {
        if color == Color::White {
            self.white_knight_freedom
        } else {
            self.black_knight_freedom
        }
    }

    pub(super) fn has_queen(&self, color: Color) -> bool {
        if color == Color::White {
            self.white_has_queen
        } else {
            self.black_has_queen
        }
    }

    fn material_for(&self, color: Color) -> i32 {
        if color == Color::White {
            self.white_material_cp
        } else {
            self.black_material_cp
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct CandidateFeatures {
    pub before: PositionFeatures,
    pub after: PositionFeatures,
    pub mover: Color,
    pub opponent: Color,
    pub material_investment_cp: i32,
    pub landing_attacked_by_opponent: bool,
    pub landing_defended_by_mover: bool,
}

impl CandidateFeatures {
    pub(super) fn new(
        before: &Board,
        after: &Board,
        mover: Color,
        opponent: Color,
        mv: &Move,
    ) -> Self {
        let before_features = PositionFeatures::new(before);
        let after_features = PositionFeatures::new(after);
        let landing_attacked_by_opponent = is_square_attacked_by_fast(after, opponent, mv.to());
        let landing_defended_by_mover = is_square_attacked_by_fast(after, mover, mv.to());
        let material_drop = (before_features.material_balance_cp(mover, opponent)
            - after_features.material_balance_cp(mover, opponent))
        .max(0);
        let moved_value = role_value_cp(mv.role());
        let captured_value = capture_square_for_move(before, mv, mover)
            .and_then(|sq| before.piece_at(sq))
            .filter(|piece| piece.color == opponent)
            .map(|piece| role_value_cp(piece.role))
            .unwrap_or(0);
        let loose_landing_exposure = if landing_attacked_by_opponent && !landing_defended_by_mover {
            (moved_value - captured_value).max(0)
        } else {
            0
        };

        Self {
            before: before_features,
            after: after_features,
            mover,
            opponent,
            material_investment_cp: material_drop.max(loose_landing_exposure),
            landing_attacked_by_opponent,
            landing_defended_by_mover,
        }
    }

    pub(super) fn feature_balance_signal(&self) -> f32 {
        let mover = self.mover;
        let opponent = self.opponent;
        let material_edge = self.after.material_balance_cp(mover, opponent) as f32;
        let mobility_gain =
            (self.after.mobility(mover) - self.before.mobility(mover)).max(0) as f32;
        let opponent_mobility_drop =
            (self.before.mobility(opponent) - self.after.mobility(opponent)).max(0) as f32;
        let knight_restriction = (self.before.knight_freedom(opponent)
            - self.after.knight_freedom(opponent))
        .max(0) as f32;
        let attack_gain = (self.after.attacks(mover).len() as i32
            - self.before.attacks(mover).len() as i32)
            .max(0) as f32;
        let king_known = if self.after.king(opponent).is_some() {
            0.05
        } else {
            0.0
        };
        let own_pawn_files = self
            .after
            .pawn_files(mover)
            .iter()
            .filter(|count| **count > 0)
            .count() as f32;
        let queen_presence = if self.after.has_queen(mover) {
            0.04
        } else {
            0.0
        };
        let simplification =
            (self.before.non_king_piece_total - self.after.non_king_piece_total).max(0) as f32;

        (material_edge.max(-300.0) / 600.0)
            + mobility_gain / 40.0
            + opponent_mobility_drop / 32.0
            + knight_restriction / 12.0
            + attack_gain / 50.0
            + own_pawn_files / 80.0
            + simplification / 80.0
            + king_known
            + queen_presence
    }
}

#[inline]
pub(super) fn square_to_coords_fast(square: Square) -> (usize, usize) {
    let index = u32::from(square) as usize;
    (index & 7, index >> 3)
}

#[inline]
pub(super) fn coords_to_square_fast(file: usize, rank: usize) -> Option<Square> {
    if file > 7 || rank > 7 {
        return None;
    }
    Some(Square::from_coords(
        File::new(file as u32),
        Rank::new(rank as u32),
    ))
}

fn pawn_file_counts_fast(board: &Board, color: Color) -> [u8; 8] {
    let mut files = [0u8; 8];
    for sq in board.pawns() & board.by_color(color) {
        let (file, _) = square_to_coords_fast(sq);
        files[file] = files[file].saturating_add(1);
    }
    files
}

fn attacked_coords_fast(board: &Board, color: Color) -> HashSet<(usize, usize)> {
    let mut coords = HashSet::new();
    for from in board.by_color(color) {
        for to in board.attacks_from(from) {
            coords.insert(square_to_coords_fast(to));
        }
    }
    coords
}

fn king_square_fast(board: &Board, color: Color) -> Option<Square> {
    (board.kings() & board.by_color(color)).into_iter().next()
}

fn material_for(board: &Board, color: Color) -> i32 {
    let mut total = 0i32;
    for sq in board.by_color(color) {
        let Some(piece) = board.piece_at(sq) else {
            continue;
        };
        if piece.role != Role::King {
            total += role_value_cp(piece.role);
        }
    }
    total
}

fn pseudo_mobility_fast(board: &Board, color: Color) -> i32 {
    let mut mobility = 0;
    for from in board.by_color(color) {
        for to in board.attacks_from(from) {
            if !board.by_color(color).contains(to) {
                mobility += 1;
            }
        }
    }
    mobility
}

fn knight_freedom_fast(board: &Board, color: Color) -> i32 {
    let mut freedom = 0;
    for from in board.knights() & board.by_color(color) {
        for to in board.attacks_from(from) {
            if !board.by_color(color).contains(to) {
                freedom += 1;
            }
        }
    }
    freedom
}

fn non_king_piece_total_fast(board: &Board) -> i32 {
    let mut total = 0;
    for side in [Color::White, Color::Black] {
        for sq in board.by_color(side) {
            let Some(piece) = board.piece_at(sq) else {
                continue;
            };
            if piece.role != Role::King {
                total += 1;
            }
        }
    }
    total
}

fn has_queen_fast(board: &Board, side: Color) -> bool {
    !(board.queens() & board.by_color(side)).is_empty()
}

fn is_square_attacked_by_fast(board: &Board, side: Color, target: Square) -> bool {
    for from in board.by_color(side) {
        if board.attacks_from(from).contains(target) {
            return true;
        }
    }
    false
}

fn capture_square_for_move(board: &Board, mv: &Move, mover: Color) -> Option<Square> {
    if board.piece_at(mv.to()).is_some() {
        return Some(mv.to());
    }

    if mv.role() != Role::Pawn {
        return None;
    }

    let from = mv.from()?;
    let (from_file, _) = square_to_coords_fast(from);
    let (to_file, to_rank) = square_to_coords_fast(mv.to());
    if from_file == to_file {
        return None;
    }

    let captured_rank = match mover {
        Color::White => to_rank.checked_sub(1)?,
        Color::Black => to_rank + 1,
    };
    if captured_rank > 7 {
        return None;
    }
    coords_to_square_fast(to_file, captured_rank)
}

fn role_value_cp(role: Role) -> i32 {
    match role {
        Role::Pawn => 100,
        Role::Knight => 320,
        Role::Bishop => 330,
        Role::Rook => 500,
        Role::Queen => 900,
        Role::King => 20_000,
    }
}

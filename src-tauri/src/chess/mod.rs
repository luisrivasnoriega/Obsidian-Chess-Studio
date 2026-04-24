//! Chess engine integration and analysis submodules.
//!
//! This module re-exports all core chess logic, including UCI engine process management, analysis routines,
//! evaluation, and Tauri command handlers. It serves as the main entry point for chess-related backend features.

pub mod analysis;
pub mod commands;
pub mod dashboard_analyze_all;
pub mod engine_path;
pub mod evaluation;
pub mod human_game_analyzer;
pub mod human_strategy;
pub mod manager;
pub mod pgn_annotator;
pub mod process;
pub mod types;
pub mod uci;

#[allow(unused_imports)]
pub use {
    analysis::*, commands::*, dashboard_analyze_all::*, engine_path::*, evaluation::*, manager::*,
    process::*, types::*, uci::*,
};

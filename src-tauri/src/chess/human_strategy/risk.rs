use serde::{Deserialize, Serialize};
use specta::Type;

use super::features::CandidateFeatures;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum StrategicRiskFlag {
    MaterialInvestment,
    UndefendedLandingSquare,
    LowDepthCandidate,
    ForcedTacticalLine,
    MateRisk,
    UnstableScore,
    WdlDrop,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct RiskEvaluationInput<'a> {
    pub candidate_features: &'a CandidateFeatures,
    pub engine_cp_mover: i32,
    pub engine_drop_cp: i32,
    pub depth: u32,
    pub best_depth: u32,
    pub wdl_drop_milli: Option<i32>,
}

pub(super) fn risk_flags_for_candidate(input: RiskEvaluationInput<'_>) -> Vec<StrategicRiskFlag> {
    let mut flags = Vec::new();
    let feature_balance = input.candidate_features.feature_balance_signal();

    if input.candidate_features.material_investment_cp >= 180 {
        flags.push(StrategicRiskFlag::MaterialInvestment);
    }

    if input.candidate_features.landing_attacked_by_opponent
        && !input.candidate_features.landing_defended_by_mover
    {
        flags.push(StrategicRiskFlag::UndefendedLandingSquare);
    }

    if input.depth < 12 || input.depth.saturating_add(4) < input.best_depth {
        flags.push(StrategicRiskFlag::LowDepthCandidate);
    }

    if input.engine_cp_mover <= -9000 {
        flags.push(StrategicRiskFlag::MateRisk);
    }

    if input.wdl_drop_milli.unwrap_or(0) >= 70 {
        flags.push(StrategicRiskFlag::WdlDrop);
    }

    if input.engine_drop_cp >= 95
        || input.wdl_drop_milli.unwrap_or(0) >= 90
        || feature_balance < -0.25
    {
        flags.push(StrategicRiskFlag::UnstableScore);
    }

    if flags.contains(&StrategicRiskFlag::MaterialInvestment)
        && (flags.contains(&StrategicRiskFlag::UndefendedLandingSquare)
            || input.engine_drop_cp >= 45
            || input.wdl_drop_milli.unwrap_or(0) >= 50)
    {
        flags.push(StrategicRiskFlag::ForcedTacticalLine);
    }

    flags
}

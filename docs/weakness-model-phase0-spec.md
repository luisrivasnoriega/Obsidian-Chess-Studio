# Weakness Model - Phase 0 Specification (Strategic/Tactical Exploitability)

## 1) Goal

Build a profile-level weakness model that goes beyond descriptive averages and identifies **exploitable tendencies** with:

- measurable impact,
- statistical confidence,
- strategic controllability (how forceable the pattern is),
- direct attack plan outputs.

The model must produce practical outputs such as:

- "vs Maroczy at ply 10-15: +X ACPL, +Y% blunder rate"
- "uncastled by ply 12: +Z% loss rate"
- "long endgames (>= 40 plies): low conversion"
- "rook activation is late"
- "open-file control is repeatedly lost"
- "pressure on h7/h2 and f3/f6 causes above-baseline damage"

## 2) Scope (Phase 0)

Phase 0 is design/specification only:

- define signal catalog (MVP + extended),
- define feature semantics and formulas,
- define scoring/ranking method,
- define output contract,
- define acceptance criteria for implementation phases.

No migration, command, or UI code is implemented in this phase.

## 3) Existing Data and Current Capabilities

Current backend provides solid foundations:

- `analysis.db3` game-level `accuracy`, `acpl`, `estimated_elo`, analyzed PGN.
- Profile DB `GameAnalysisStats` with `Winner`, `WinPhase`, `WinPly`, and extensible `Extra`.
- Existing profile analytics for:
  - phase outcomes and phase accuracy,
  - intensity buckets and intensity accuracy,
  - outcome reason breakdown,
  - missed/allowed/found forks.
- Existing pawn-structure detection at configurable move number with named structures and motifs.
- Human strategic analyzer output (mistake/blunder counts, motifs/themes) available at analysis time.

Reference modules:

- `src-tauri/src/db/analysis_stats.rs`
- `src-tauri/src/db/mod.rs`
- `src-tauri/src/pawn_structures.rs`
- `src-tauri/src/chess/human_game_analyzer.rs`

## 4) Weakness Model Output Contract

Each weakness signal must return:

- `signalKey`: stable identifier.
- `title`: short strategic label.
- `trigger`: condition that activates the weakness.
- `impact`:
  - `deltaAcpl`
  - `deltaAccuracy`
  - `deltaLossRate`
  - `deltaBlunderRate` (when available)
- `support`: sample size (`n`) and effective sample size (`nEff`).
- `confidence`: `[0, 1]` confidence score and interval.
- `controllability`: `[0, 1]` forceability score.
- `recency`: `[0, 1]` recency-weight score.
- `exploitabilityScore`: final rank score.
- `evidence`: top example games (IDs + short evidence text).
- `attackPlan`: explicit practical plan.

## 5) Statistical Framework

### 5.1 Baselines

For each signal, compare target profile against context-matched baseline:

- same color,
- time-control bucket,
- opponent-ELO bucket,
- opening family (when relevant).

### 5.2 Smoothing

- Binary rates (`loss`, `blunder`, `mistake`, event occurrence):
  - Beta-Binomial posterior.
  - posterior mean used for rate estimates.
- Continuous metrics (`acpl`, `accuracy`):
  - shrinkage to context baseline using reliability weight `w = n / (n + k)`.

### 5.3 Confidence

Confidence combines:

- posterior interval width,
- effective sample size,
- signal stability over recency windows.

Suggested minimum support:

- hard floor: `n >= 20`,
- high-confidence tier: `n >= 60`.

### 5.4 Final Ranking Score

`exploitabilityScore = severity * confidence * controllability * recency`

Where:

- `severity`: normalized impact magnitude vs baseline.
- `confidence`: reliability of estimate.
- `controllability`: how easily an opponent can steer into the trigger.
- `recency`: higher if pattern persists in recent games.

## 6) Feature Dictionary (Canonical)

### 6.1 Core Context Features

- `phase`: opening/middlegame/endgame.
- `plyBucket`: 5/10/15/20/25.
- `timeControlBucket`: bullet/blitz/rapid/classical.
- `colorPlayed`: white/black.
- `openingFamily`: normalized family from ECO/opening text.
- `pawnStructureAtBucket`: named structure at configured bucket.

### 6.2 King Safety / Castling

- `castledShortByPly12`, `castledLongByPly12`.
- `uncastledByPly12`, `uncastledByPly15`.
- `oppositeSideCastling`.
- `kingCenterExposureIndex` (derived from uncastled + center openness proxy).

### 6.3 Rook Activity

- `rooksConnectedByPly18`.
- `firstRookActivationPly` (first rook move that improves activity).
- `rookOnOpenFileByPly20`.
- `doubleRooksOpenFileByPly25`.

### 6.4 File Control

- `openFileControlDelta` (owned open files - enemy owned open files).
- `semiOpenFileControlDelta`.
- `lostMainFileAfterPly15` (binary event).

### 6.5 Tactical Pressure Points

- `pressureOnH7H2Window` (event in early-midgame window).
- `pressureOnF3F6Window` (event in early-midgame window).
- `damageAfterPressureCpLoss` (cp/quality drop in next N plies).

### 6.6 Quality and Error Features

- `acpl`, `accuracy`, `estimatedElo`.
- `blunderRate`, `mistakeRate`, `inaccuracyRate` (from analyzed move stream).
- `firstBigErrorPly`.

### 6.7 Endgame Conversion

- `longEndgame` (`plyCount >= 40` and endgame phase reached).
- `conversionWithAdvantage` (win probability when entering endgame with advantage proxy).
- `defenseWhenWorse` (draw/save rate when entering endgame worse).

## 7) Signal Catalog (MVP + Strategic Extensions)

## 7.1 MVP Signals

1. `WM_UNCASTLED_EARLY`
- Trigger: `uncastledByPly12 = true`.
- Impact focus: `deltaLossRate`, `deltaAcpl`.
- Controllability: high.

2. `WM_MAROCCZY_10_15`
- Trigger: Maroczy structure in ply bucket 10-15.
- Impact focus: `deltaAcpl`, `deltaBlunderRate`.
- Controllability: medium-high.

3. `WM_LONG_ENDGAME_CONVERSION`
- Trigger: `longEndgame = true` with non-losing entry.
- Impact focus: conversion drop.
- Controllability: medium.

4. `WM_LATE_ROOK_CONNECTION`
- Trigger: `rooksConnectedByPly18 = false`.
- Impact focus: `deltaAcpl`, `deltaLossRate`.
- Controllability: high.

5. `WM_OPEN_FILE_CONTROL_LOSS`
- Trigger: negative `openFileControlDelta` after ply 15.
- Impact focus: score drop and accuracy decay.
- Controllability: high.

6. `WM_H7_H2_PRESSURE_DAMAGE`
- Trigger: pressure event on h7/h2 in defined window.
- Impact focus: blunder/loss spike in next N plies.
- Controllability: medium-high.

7. `WM_F3_F6_PRESSURE_DAMAGE`
- Trigger: pressure event on f3/f6 in defined window.
- Impact focus: tactical error spike.
- Controllability: medium-high.

## 7.2 Strategic Extension Signals (Phase 2+)

- `WM_OPPOSITE_CASTLING_RACE_LOSS`
- `WM_UNDERMINED_DARK_SQUARES`
- `WM_OUTPOST_CONCESSION`
- `WM_BREAK_RESISTANCE_C5_E5_F5`
- `WM_PREMATURE_SIMPLIFICATION`
- `WM_INTENSITY_EDGE_COLLAPSE`
- `WM_RIVAL_SPECIFIC_PATTERN`

## 8) Output Language Templates

Template:

`[Signal] <Trigger>: <Impact> (n=<support>, confidence=<band>). Exploit plan: <plan>.`

Examples:

- `[Rook Activation] Rooks not connected by ply 18: +15.8 ACPL and -11.2 pp score (n=84, confidence=high). Exploit plan: keep central tension, open one file, contest entry squares before move 20.`
- `[Open Files] Repeated loss of open-file control after ply 15: +12.4 ACPL and blunder rate x1.6 (n=73, confidence=medium-high). Exploit plan: force pawn exchanges in the center and double rooks on the first open file.`
- `[King Safety] Uncastled by ply 12: +19.1 pp loss rate (n=67, confidence=high). Exploit plan: accelerate development and open center immediately.`
- `[Pressure Pattern] h7/h2 pressure window causes above-baseline damage: +9.8 pp blunder rate in next 8 plies (n=41, confidence=medium). Exploit plan: build battery motifs and keep attacking pieces on board.`

## 9) Controllability Heuristic (v1)

- High: castling timing, rook activity, open-file creation.
- Medium-high: structure steering in common opening families, wing pressure motifs.
- Medium: long-endgame conversion opportunities.
- Low: rare tactical motifs with low steering ability.

Map to numeric:

- high `= 0.85`
- medium-high `= 0.70`
- medium `= 0.55`
- low `= 0.35`

## 10) Recency Weighting (v1)

Use exponential decay by game age:

- `w = exp(-lambda * ageDays)`
- target half-life: 120 days.

Report both:

- all-time score,
- recency-adjusted score.

## 11) Data Quality and Guardrails

- Do not emit high-priority signal below minimum support.
- Collapse duplicate/overlapping signals into one canonical parent.
- Avoid contradictory outputs in same context.
- Always provide uncertainty label: `low`, `medium`, `high`.
- Keep deterministic ranking when scores tie (stable sort by key).

## 12) Phase 0 Acceptance Criteria

- Catalog includes MVP and extended strategic signals.
- Every signal has:
  - trigger definition,
  - impact metrics,
  - support thresholds,
  - controllability tier.
- Scoring framework is fully specified.
- Output contract and wording templates are defined.
- Dependencies on existing modules are identified.

## 13) Immediate Next Step (Phase 1 Input)

Create schema and persistence for:

- per-game extracted weakness features,
- aggregated signal snapshots,
- signal evidence rows.

Then implement incremental extraction in the existing analysis save flow and backfill path.

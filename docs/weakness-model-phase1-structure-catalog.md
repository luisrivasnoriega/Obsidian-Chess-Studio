# Weakness Model - Phase 1 Structure Catalog (V1)

## 1) Scope

Phase 1 defines the **canonical structure catalog** used by the weakness model.

This phase does not add new ranked weakness signals yet. It locks the contract for:

- structure keys,
- color perspective,
- ply windows,
- mandatory conditions,
- contextual conditions,
- anti-false-positive exclusions.

## 2) Design Principles

- Use **strict detection gates** for named structures (avoid visual-only matches).
- Keep windows practical for training prep (opening/early middlegame emphasis).
- Separate profile-side and opponent-side perspectives where strategic plans differ.
- Prefer deterministic rules first; probabilistic scoring comes in later phases.

## 3) Canonical Catalog (V1)

| Key | Perspective | Window (ply) | Required conditions | Contextual conditions | Exclusions |
|---|---|---:|---|---|---|
| `MAROCZY_BIND_STRICT` | both | 10-15 | c/e duo advanced; opponent c-pawn absent on c-file; opponent d-break absent; opponent d-pawn restrictive; side d-pawn absent | Open Sicilian skeleton; d5/d4 restriction | c4+e4 lookalikes without restrictive d-pawn pattern |
| `SICILIAN_DRAGON_CLASSICAL` | both | 10-18 | opponent pawns `c5+d6+g6` | fianchetto shell support | missing `c5` or no g-pawn fianchetto |
| `SICILIAN_DRAGON_ACCELERATED` | both | 8-16 | opponent pawns `c5+g6`; opponent d-pawn not fixed on `d6` by window end | Sicilian family; early ...d5 pressure motifs | fixed classical Dragon (`d6`) without acceleration evidence |
| `IQP_PROFILE` | both | 12-30 | profile isolated d-pawn; no c/e pawn support | open files around IQP; activity compensation | hanging pawns; blocked center where IQP is strategically neutralized |
| `IQP_OPPONENT` | both | 12-30 | opponent isolated d-pawn; no c/e pawn support | pressure squares in front of IQP | hanging pawns; transient isolation resolved quickly |
| `HANGING_PAWNS_PROFILE` | both | 12-30 | profile connected `c+d` pawns; no b/e support | expansion potential vs overextension risk | single IQP or fully supported chain |
| `HANGING_PAWNS_OPPONENT` | both | 12-30 | opponent connected `c+d` pawns; no b/e support | blockade targets on c/d files | temporary pair that resolves immediately |
| `CARLSBAD_PROFILE` | both | 12-32 | strict Carlsbad skeleton present for profile side | minority attack timing; central breaks | pseudo-Carlsbad without c6/d5 anchors |
| `CARLSBAD_OPPONENT` | both | 12-32 | strict Carlsbad skeleton present for opponent side | minority-attack defense; c-file pressure | pseudo-Carlsbad without core anchors |
| `STONEWALL_PROFILE` | both | 10-25 | profile stonewall chain `c/d/e/f` | dark-square control; light-square weaknesses | partial 3-pawn chain |
| `BENONI_OPPONENT` | both | 10-25 | opponent `c5+d6` with profile pawn on `d5` | queenside counterplay vs central space | closed shapes without Benoni tension |
| `FRENCH_CHAIN_TENSION` | both | 8-22 | French core lock `d4/e5` vs `d5/e6` | chain-base attacks; bishop quality | Caro-Kann-like shapes without full lock |
| `KID_LOCKED_CENTER` | both | 10-25 | King’s Indian center lock in d/e files | wing-race planning | open center positions |
| `GRUNFELD_BROAD_CENTER` | both | 8-18 | broad white center with hypermodern pressure shell | central targetability and piece pressure | QGD/Slav transpositions lacking Grünfeld pressure profile |

## 4) Priority Set for Signal Rollout

First implementation wave for new signals should use:

1. `SICILIAN_DRAGON_CLASSICAL`
2. `IQP_PROFILE`
3. `IQP_OPPONENT`
4. `CARLSBAD_PROFILE`
5. `CARLSBAD_OPPONENT`

Second wave:

1. `HANGING_PAWNS_PROFILE`
2. `HANGING_PAWNS_OPPONENT`
3. `STONEWALL_PROFILE`
4. `BENONI_OPPONENT`

Third wave:

1. `SICILIAN_DRAGON_ACCELERATED`
2. `FRENCH_CHAIN_TENSION`
3. `KID_LOCKED_CENTER`
4. `GRUNFELD_BROAD_CENTER`

## 5) Contract Alignment in Code

The same catalog is mirrored in backend code as `STRUCTURE_CATALOG_V1` under:

- `src-tauri/src/db/weakness_model.rs`

Contract tests validate:

- Dragon/IQP/Carlsbad presence,
- valid ply windows,
- valid perspective values,
- non-empty required-condition lists.

## 6) Exit Criteria for Phase 1

Phase 1 is complete when:

- catalog keys are frozen,
- windows and strict gates are documented,
- code contract exists and passes validation tests.


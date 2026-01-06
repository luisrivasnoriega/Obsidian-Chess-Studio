# Reporte de Cobertura de Comandos Tauri

**Fecha:** $(Get-Date -Format "yyyy-MM-dd")  
**Total de Comandos Tauri:** 79  
**Comandos con Tests Directos:** 1  
**Cobertura de Comandos:** 1.3%

---

## Resumen Ejecutivo

| Métrica | Valor |
|---------|-------|
| **Total Comandos Tauri** | 79 |
| **Comandos con Tests Directos** | 1 |
| **Comandos sin Tests** | 78 |
| **Cobertura de Comandos** | **1.3%** |
| **Total Tests (funciones internas)** | 119 |

**Nota:** Los tests actuales cubren principalmente funciones internas, no los comandos Tauri directamente. Esto se debe a que los comandos Tauri requieren `AppHandle` y `tauri::State` que son difíciles de mockear en Tauri 2.

---

## Cobertura por Archivo

### 1. `opening.rs` - 4 comandos, 7 tests
**Cobertura de Comandos:** 25% (1/4)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `get_opening_from_fen` | ✅ 1 | ✅ 3 | **CUBIERTO** |
| `get_opening_from_name` | ❌ 0 | ✅ 1 | Parcial |
| `get_opening_info_from_fen` | ❌ 0 | ✅ 2 | Parcial |
| `search_opening_name` | ❌ 0 | ✅ 1 | Parcial |

**Tests:** 7
- `test_get_opening_from_fen` (3 casos)
- `test_get_opening_from_name` (3 casos)
- `test_get_opening_info_from_fen` (2 casos)
- `test_get_opening_info_parsing` (3 casos)
- `test_search_opening_name` (6 casos)
- `test_get_opening_from_setup` (2 casos)
- `test_opening_loading` (1 caso)

---

### 2. `pgn.rs` - 4 comandos, 8 tests
**Cobertura de Comandos:** 0% (0/4)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `count_pgn_games` | ❌ 0 | ✅ 3 | Parcial |
| `read_games` | ❌ 0 | ✅ 2 | Parcial |
| `delete_game` | ❌ 0 | ✅ 0 | **SIN TESTS** |
| `write_game` | ❌ 0 | ✅ 0 | **SIN TESTS** |

**Tests:** 8 (todos prueban funciones internas `PgnParser`)
- `test_count_pgn_games_internal` (3 casos)
- `test_read_games_internal` (3 casos)
- `test_read_games_range_internal` (1 caso)
- `test_read_games_empty_after_end` (1 caso)
- `test_pgn_parser_position` (1 caso)
- `test_pgn_parser_skip_games` (1 caso)
- `test_ignore_bom` (2 casos)

---

### 3. `db/search.rs` - 2 comandos, 70 tests
**Cobertura de Comandos:** 0% (0/2)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `search_position` | ❌ 0 | ✅ 60+ | Parcial |
| `build_position_checkpoints` | ❌ 0 | ✅ 0 | **SIN TESTS** |

**Tests:** 70 (todos prueban funciones internas)
- Tests de `PositionQuery` (20+)
- Tests de matching (15+)
- Tests de hashing (5+)
- Tests de `MoveStream` (10+)
- Tests de reachability (10+)
- Tests de edge cases (10+)

---

### 4. `db/mod.rs` - 24 comandos, 1 test
**Cobertura de Comandos:** 0% (0/24)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `convert_pgn` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `init_profile_db` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_db_info` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `create_indexes` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `delete_indexes` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `edit_db_info` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_games` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_player` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_players` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_tournaments` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_players_game_info` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `delete_database` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `delete_duplicated_games` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `delete_empty_games` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `export_to_pgn` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `export_position_games_to_pgn` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `export_selected_games_to_pgn` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `delete_db_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `update_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `merge_players` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `clear_games` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `precache_openings` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `download_position_cache` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 1 (solo función interna `get_pawn_home`)
- `test_home_row` (3 casos)

---

### 5. `chess/commands.rs` - 7 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/7)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `kill_engines` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `kill_engine` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `stop_engine` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_engine_logs` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_best_moves` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analyze_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_engine_config` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 6. `puzzle.rs` - 8 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/8)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `get_puzzle` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `check_puzzle_db_columns` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_puzzle_themes` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_puzzle_opening_tags` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_puzzle_rating_range` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_puzzle_db_info` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `import_puzzle_file` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `validate_puzzle_database` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 7. `analysis_storage.rs` - 9 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/9)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `analysis_db_set_analyzed_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_get_analyzed_game` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_get_all_analyzed_games` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_set_game_stats` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_get_game_stats` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_get_game_stats_bulk` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_get_analyzed_games_bulk` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_delete_entries` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `analysis_db_clear_analyzed_pgns` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 8. `fide.rs` - 4 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/4)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `download_fide_db` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `find_fide_player` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `fetch_fide_profile_html` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `save_fide_photo` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 9. `fs.rs` - 4 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/4)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `download_file` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `set_file_as_executable` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `file_exists` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `get_file_metadata` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 10. `package_manager.rs` - 4 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/4)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `check_package_manager_available` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `install_package` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `check_package_installed` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `find_executable_path` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 11. `variant_positions.rs` - 2 comandos, 6 tests
**Cobertura de Comandos:** 0% (0/2)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `get_variant_position` | ❌ 0 | ✅ 3 | Parcial |
| `upsert_variant_position` | ❌ 0 | ✅ 3 | Parcial |

**Tests:** 6 (todos prueban funciones internas)
- `test_fen_identity_key` (3 casos)
- `test_fen_identity_key_short` (1 caso)
- `test_fen_identity_key_various_formats` (2 casos)

---

### 12. `lib.rs` - 3 comandos, 0 tests
**Cobertura de Comandos:** 0% (0/3)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `is_bmi2_compatible` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `memory_size` | ❌ 0 | ❌ 0 | **SIN TESTS** |
| `open_external_link` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 13. `pawn_structures.rs` - 1 comando, 0 tests
**Cobertura de Comandos:** 0% (0/1)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `compute_pawn_structures` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 14. `oauth.rs` - 1 comando, 0 tests
**Cobertura de Comandos:** 0% (0/1)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `authenticate` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 15. `lexer.rs` - 1 comando, 0 tests
**Cobertura de Comandos:** 0% (0/1)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `lex_pgn` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 16. `app/platform/mod.rs` - 1 comando, 0 tests
**Cobertura de Comandos:** 0% (0/1)

| Comando | Tests Directos | Tests Internos | Estado |
|---------|----------------|----------------|--------|
| `screen_capture` | ❌ 0 | ❌ 0 | **SIN TESTS** |

**Tests:** 0

---

### 17. `db/pgn.rs` - 0 comandos, 3 tests
**Nota:** Este archivo contiene funciones de parsing PGN, no comandos Tauri.

**Tests:** 3
- Tests de `GameTree` encoding/decoding
- Tests de `Importer` parsing

---

### 18. `db/core.rs` - 0 comandos, 1 test
**Nota:** Este archivo contiene funciones internas de base de datos.

**Tests:** 1
- `test_home_row` (3 casos)

---

### 19. `chess/evaluation.rs` - 0 comandos, 23 tests
**Nota:** Este archivo contiene funciones de evaluación, no comandos Tauri.

**Tests:** 23
- Tests de evaluación de posiciones
- Tests de checkmate/stalemate
- Tests de material
- Tests de edge cases

---

## Resumen por Archivo

| Archivo | Comandos | Tests | Cobertura Comandos | Tests por Comando |
|---------|----------|-------|-------------------|-------------------|
| `opening.rs` | 4 | 7 | 25% | 1.75 |
| `pgn.rs` | 4 | 8 | 0% | 2.00 |
| `db/search.rs` | 2 | 70 | 0% | 35.00 |
| `db/mod.rs` | 24 | 1 | 0% | 0.04 |
| `chess/commands.rs` | 7 | 0 | 0% | 0.00 |
| `puzzle.rs` | 8 | 0 | 0% | 0.00 |
| `analysis_storage.rs` | 9 | 0 | 0% | 0.00 |
| `fide.rs` | 4 | 0 | 0% | 0.00 |
| `fs.rs` | 4 | 0 | 0% | 0.00 |
| `package_manager.rs` | 4 | 0 | 0% | 0.00 |
| `variant_positions.rs` | 2 | 6 | 0% | 3.00 |
| `lib.rs` | 3 | 0 | 0% | 0.00 |
| `pawn_structures.rs` | 1 | 0 | 0% | 0.00 |
| `oauth.rs` | 1 | 0 | 0% | 0.00 |
| `lexer.rs` | 1 | 0 | 0% | 0.00 |
| `app/platform/mod.rs` | 1 | 0 | 0% | 0.00 |
| **TOTAL** | **79** | **119** | **1.3%** | **1.51** |

---

## Análisis Detallado

### Comandos con Tests Directos (1/79 = 1.3%)
1. ✅ `get_opening_from_fen` (opening.rs)

### Comandos con Tests Indirectos (Funciones Internas)
- `get_opening_from_name` - funciones internas testeadas
- `get_opening_info_from_fen` - funciones internas testeadas
- `search_opening_name` - funciones internas testeadas
- `count_pgn_games` - `PgnParser` testado
- `read_games` - `PgnParser` testado
- `search_position` - funciones internas extensivamente testeadas

### Comandos Sin Tests (78/79 = 98.7%)
Todos los demás comandos no tienen tests directos ni indirectos.

---

## Recomendaciones

### Prioridad Crítica (0% cobertura)
1. **`db/mod.rs`** (24 comandos) - Módulo más crítico
   - `get_games`, `get_game`, `convert_pgn` son esenciales
2. **`chess/commands.rs`** (7 comandos) - Funcionalidad core
   - `analyze_game`, `get_best_moves` son críticos
3. **`puzzle.rs`** (8 comandos) - Funcionalidad importante

### Prioridad Alta
4. **`analysis_storage.rs`** (9 comandos)
5. **`fs.rs`** (4 comandos)
6. **`fide.rs`** (4 comandos)

### Prioridad Media
7. Completar tests de `opening.rs` (3 comandos restantes)
8. Completar tests de `pgn.rs` (2 comandos restantes)
9. Agregar tests de `search_position` (integration test)

---

## Conclusión

**Cobertura Actual:** 1.3% (1/79 comandos)

**Problema Principal:** Los comandos Tauri requieren `AppHandle` y `tauri::State` que son difíciles de mockear en Tauri 2. La mayoría de los tests actuales prueban funciones internas, no los comandos directamente.

**Solución Propuesta:** Crear un módulo de testing helpers (`src/testing.rs`) para facilitar el testing de comandos Tauri, o usar un framework especializado para Tauri 2.





# Coverage Engine Crash Debug Track

## Problem

Coverage graph engine evaluation can abort the Tauri process with native exit codes such as:

- `0xc000001d, STATUS_ILLEGAL_INSTRUCTION`
- `0xc0000409, STATUS_STACK_BUFFER_OVERRUN`

The crash has been observed in two different windows. Earlier runs crashed after a log like:

```text
coverage engine session eval completed ... has_score=true
```

Later runs also crashed after:

```text
coverage engine session eval lock acquired ...
```

with no following `coverage engine session eval completed`. That narrows that run to the native UCI evaluation helper, between acquiring the session lock and returning the engine result.

## Instrumentation

Every coverage engine run now has a frontend `runId`. The same `runId` is passed into backend commands and the progress event payload.

Look for these log prefixes:

- Frontend: `coverageEngineTrack`
- Backend: `coverage engine session ...`
- Backend event handoff: `coverage engine progress emit ...`

The minimum expected successful sequence for one uncached node is:

1. `front.run.requested`
2. `front.targets.collected`
3. `front.engine.selected`
4. `front.run.state.begin`
5. `front.database.cancel.before`
6. `front.database.cancel.after`
7. `front.notification.before` / `front.notification.after` for `started`
8. `front.cache.scan.begin`
9. `front.cache.miss`
10. `front.session.start.before`
11. `coverage engine session start requested`
12. `coverage engine session started`
13. `front.session.start.after`
14. `front.progress.listener.subscribe.before`
15. `front.progress.listener.subscribe.after`
16. `front.invoke.eval.before`
17. `coverage engine session eval requested`
18. `coverage engine session eval lock acquired`
19. `coverage engine eval step begin`
20. `coverage engine eval set_options begin`
21. `coverage engine eval set_options done`
22. `coverage engine eval ready drain begin`
23. `coverage engine eval ready drain done`
24. `coverage engine eval go begin`
25. `coverage engine eval go done`
26. `coverage engine eval candidate`
27. `coverage engine eval bestmove received`
28. `coverage engine eval step done`
29. `coverage engine session eval completed`
30. `coverage engine progress emit schedule`
31. `coverage engine progress emit begin`
32. `coverage engine progress emit done`
33. `front.progress.event.received`
34. `front.progress.rendered`
35. `front.invoke.eval.after`
36. `front.result.process.requested`
37. `front.result.save.before`
38. `front.result.save.after`
39. `front.persist.begin`
40. `front.persist.done`
41. `front.session.loop.done`
42. `front.session.stop.before`
43. `coverage engine session stop requested`
44. `coverage engine session stopped`
45. `front.session.stop.after`
46. `front.final.persist.before`
47. `front.final.persist.after`
48. `front.notification.before` / `front.notification.after` for `completed`
49. `front.run.completed`
50. `front.run.finally.begin`
51. `front.run.finally.after`

If the process crashes, the last emitted phase narrows the failing boundary.

## Isolation Switches

Set these in the WebView console to disable specific subsystems before reproducing:

```js
localStorage.setItem("ocs.coverageEngine.disableProgressEvents", "1");
localStorage.setItem("ocs.coverageEngine.disableProgressUi", "1");
localStorage.setItem("ocs.coverageEngine.disableNotifications", "1");
localStorage.setItem("ocs.coverageEngine.disableGraphCacheWrites", "1");
```

Clear them with:

```js
localStorage.removeItem("ocs.coverageEngine.disableProgressEvents");
localStorage.removeItem("ocs.coverageEngine.disableProgressUi");
localStorage.removeItem("ocs.coverageEngine.disableNotifications");
localStorage.removeItem("ocs.coverageEngine.disableGraphCacheWrites");
```

Enable native frontend log mirroring only when explicitly investigating the Tauri log plugin:

```js
localStorage.setItem("ocs.coverageEngine.enableTrackConsoleLog", "1");
localStorage.setItem("ocs.coverageEngine.enableTrackNativeLog", "1");
localStorage.removeItem("ocs.coverageEngine.enableTrackConsoleLog");
localStorage.removeItem("ocs.coverageEngine.enableTrackNativeLog");
```

Use this matrix:

- Only `disableNotifications=1`: isolates Mantine notifications.
- Only `disableProgressUi=1`: isolates React progress state/rendering.
- Only `disableProgressEvents=1`: isolates Tauri event emission and listener delivery.
- Only `disableGraphCacheWrites=1`: isolates final coverage graph JSON persistence. Engine evaluations still persist to `variant_positions`.
- Only `enableTrackConsoleLog=1`: writes frontend `coverageEngineTrack` messages to the browser console. Leave this unset during CPU or crash isolation.
- Only `enableTrackNativeLog=1`: mirrors frontend `coverageEngineTrack` messages into the Tauri log plugin. Leave this unset during CPU or crash isolation.
- All UI switches enabled: confirms whether the engine/session/save path is stable without UI feedback.

## Validation Checklist

Run the smallest validation that matches the change under investigation.

### Build Checks

Use these after Rust command/session changes:

```powershell
cargo check --manifest-path src-tauri/Cargo.toml
```

Use these after frontend progress, modal, or cache-flow changes:

```powershell
pnpm exec tsc --noEmit
```

Use this only when the generated bindings or route generation may be affected:

```powershell
pnpm build-vite
```

### Runtime Reproduction

For each reproduction, capture the final backend `coverage engine ...` line and the final frontend `coverageEngineTrack` line before the crash or completion.

1. Run coverage engine analysis with all debug switches cleared.
2. Repeat with only `enableTrackConsoleLog=1`.
3. Repeat with only `enableTrackNativeLog=1`.
4. Repeat with only `disableProgressEvents=1`.
5. Repeat with only `disableProgressUi=1`.
6. Repeat with only `disableNotifications=1`.
7. Repeat with only `disableGraphCacheWrites=1`.
8. Repeat with all four disabling switches enabled and both tracking flags unset.

Expected stable backend sequence for every uncached node:

```text
coverage engine eval step begin
coverage engine eval set_options begin
coverage engine eval set_options done
coverage engine eval ready drain begin
coverage engine eval ready drain done
coverage engine eval go begin
coverage engine eval go done
coverage engine eval bestmove received
coverage engine eval step done
coverage engine session eval completed
```

If the run completes with all switches enabled but fails with one switch cleared, the last cleared switch identifies the active crash boundary. If it still fails with all switches enabled, focus on the backend UCI helper and engine child-process logs.

### CPU Budget Checks

Coverage engine analysis intentionally overrides heavy engine settings:

- `MultiPV=1`
- `Threads=1`
- `Hash=256`

This keeps the coverage job sequential and prevents the selected engine's general analysis profile from consuming all CPU cores or allocating multi-gigabyte hash tables. If Task Manager still shows high CPU in `obsidian-chess-studio.exe`, check these toggles first:

- `debug.memoryTelemetry`: disable it unless memory telemetry is under investigation.
- `obsidian.debugNav`: disable it unless navigation diagnostics are under investigation.
- `ocs.coverageEngine.enableTrackConsoleLog`: leave it unset unless frontend phase logs are required.
- `ocs.coverageEngine.enableTrackNativeLog`: leave it unset unless native frontend log mirroring is required.

Expected CPU shape:

- `stockfish-*.exe`: most CPU while a node is being searched.
- `obsidian-chess-studio.exe`: low to moderate CPU for UCI stdout parsing, SQLite cache reads/writes, and progress rendering.

If OCS CPU exceeds the engine process for sustained periods, capture the last `coverageEngineTrack` phase and check whether memory telemetry, debug navigation, or native log mirroring is enabled.

### Data Integrity Checks

After a successful run:

- Reopen the same coverage graph and confirm evaluated nodes show persisted engine advantage labels.
- Re-run the same coverage analysis and confirm previously evaluated positions are counted as cached.
- Confirm the final `front.final.persist.after` appears exactly once per completed run.
- Confirm cancellation only happens after `front.abort.requested`.
- Confirm no `front.run.cancelled` appears during an uninterrupted run.

## Current Hypotheses

1. A crash before `coverage engine eval step begin` points to session lookup/locking.
2. A crash between `coverage engine eval step begin` and `coverage engine eval set_options done` points to FEN validation, UCI option application, or `position fen`.
3. A crash between `coverage engine eval ready drain begin` and `coverage engine eval ready drain done` points to engine stdout synchronization.
4. A crash after `coverage engine eval go done` but before `coverage engine eval bestmove received` points to engine search output handling or the child engine exiting during search.
5. A crash before `coverage engine progress emit schedule` but after `coverage engine session eval completed` points to post-evaluation Rust logic before event scheduling.
6. A crash after `coverage engine progress emit begin` but before `coverage engine progress emit done` points to native event emission.
7. A crash after `front.progress.event.received` points to frontend progress state/rendering.
8. A crash after `front.notification.before` and before `front.notification.after` points to Mantine notification rendering or WebView event handling.
9. `Search stopped` logs come from ChessBase cancellation and are only relevant if they appear interleaved with `front.database.cancel.*` or a DatabasePanel query restart.

## Abort Tracking

The coverage action modal no longer aborts analysis from an incidental close event while the engine task is active. During evaluation:

- outside click close is disabled
- Escape close is disabled
- the header close button is hidden
- the Cancel button is disabled
- an explicit Stop button requests cancellation

Cancellation requests are logged as:

```text
front.abort.requested
```

with an `origin` field. If a run reaches `front.run.cancelled` without a preceding `front.abort.requested`, the abort flag was mutated by a path that still needs to be tracked.

## Notes

The progress event payload is intentionally lightweight. It contains only run/session identifiers, node position metadata, completion counters, and error state. Engine results are still processed through the sequential `invoke` return path.

Coverage UCI output is no longer accumulated in the session `EngineProcess.logs` vector for this helper. The helper still records high-level backend phases, depth milestones, bestmove receipt, child-process exit checks, and timeout waits.

## Persist Strategy

Engine evaluations are persisted node-by-node to `variant_positions` first. The coverage graph JSON cache is only updated at the end of the run.

This avoids repeatedly sending and writing the full graph cache after every node. The previous per-node graph-cache write path could crash after:

```text
front.persist.cache.write.before
```

before returning to `front.persist.done`. The backend graph-cache writer now streams JSON directly to a temporary file and renames it into place instead of allocating one large pretty-printed JSON string.

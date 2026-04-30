# Variants Segmentation - Phase 0 Specification

## 1) Goal

Define the technical contract for splitting large variants trees into linked sub-variants while keeping current behavior unchanged until later phases.

Phase 0 is contract-first:

- request/response DTOs for builder segmentation,
- metadata schema for parent/child links between variants files,
- compatibility rules for existing files and callers.

No segmentation behavior is enabled in this phase.

## 2) Scope

This phase includes:

- frontend type contract updates,
- backend DTO updates,
- metadata schema definition.

This phase excludes:

- manual split UI flow,
- automatic split execution,
- PGN viewer focus/collapse enhancements.

## 3) Build Variants Contract

### 3.1 Request (`BuildVariantsTreeRequest`)

Add an optional `splitConfig` object:

- `enabled: boolean`
- `mode: "none" | "manual" | "auto"`
- `splitAtPly?: number`
- `maxSegments?: number`
- `maxLinesPerSegment?: number`

All fields are optional at transport level except `enabled` and `mode` once `splitConfig` is present.

### 3.2 Response (`BuildVariantsTreeResponse`)

Keep legacy output:

- `lines: LineDto[]`

Add optional fields:

- `segments?: SegmentDto[]`
- `warnings?: string[]`

`segments` is reserved for Phase 3 implementation and remains empty/omitted in Phase 0.

### 3.3 Segment DTO

- `id: string`
- `anchorPly: number`
- `anchorFen: string`
- `anchorPath: number[]`
- `title?: string`
- `lines: LineDto[]`
- `stats: { lineCount: number }`

## 4) Progress Event Contract

Current `variants_builder_progress` remains valid:

- `startPath`
- `moves`

Future-compatible optional field:

- `segmentId?: string`

## 5) Variants `.info` Metadata (Schema v2)

Existing fields remain valid:

- `type`
- `tags`

Add optional fields:

- `schemaVersion: 2`
- `links`
- `split`

`links`:

- `parent?: LinkRef`
- `children?: LinkRef[]`

`split`:

- `mode: "manual" | "auto"`
- `splitAtPly?: number`
- `createdAt: string` (ISO)

`LinkRef`:

- `path` (relative to documents root)
- `name`
- `anchorFen`
- `anchorPath`
- `anchorPly`
- `label?`

## 6) Compatibility Rules

- If `splitConfig` is omitted, backend behavior must match current behavior.
- If `segments` is omitted, frontend must continue using `lines`.
- Existing `.info` files without `schemaVersion` must be treated as schema v1.
- `tags` must never be removed by schema migration logic.

## 7) Definition of Done

Phase 0 is complete when:

- frontend and backend compile with the new optional DTO fields,
- schema v2 is documented and represented by TypeScript types,
- no runtime behavior changes are introduced.

# Agents Guide (OCS)

This repository contains **Obsidian Chess Studio**, a **Tauri (Rust) + React (Vite)** chess application.

All code, comments, commit messages, and documentation changes **must be written in English**.

## Quick map

- **Frontend**: `src/` (React 19, Vite, Mantine, TanStack Router/Query)
- **Backend**: `src-tauri/` (Tauri 2, Rust, Diesel/SQLite, chess logic, engine management)
- **Generated bindings**: `src/bindings/generated.ts` (from `src-tauri`, via `tauri-specta`)
- **SQL + schema assets**: `database/` (schema, migrations, queries, pragmas)

## Tech stack (high level)

- **UI**: Mantine (`@mantine/*`), `vanilla-extract` CSS-in-TS in some components
- **Routing**: TanStack Router file routes (`src/routes/*`) + generated `src/routeTree.gen.ts`
- **Data fetching**: TanStack Query (`@tanstack/react-query`)
- **State**:
  - **Jotai** for most app settings + user/session/tab state (`src/state/atoms.ts`)
  - **Zustand** for some complex view stores (e.g. tree + database views)
- **i18n**: i18next + react-i18next (`src/i18n.ts`, `src/locales/*`)
- **Native / backend**: Tauri plugins (fs/http/log/updater/etc), Rust commands/events

## Frontend architecture (`src/`)

### Entry points

- `src/index.tsx`: bootstraps the React app and initializes i18n (`import "./i18n"`).
- `src/App.tsx`: app composition:
  - TanStack Router + route tree
  - TanStack Query client provider
  - Theme provider + global styles
  - Tauri log console attachment (single-flight)
  - Initialization flow (loads directories, handles CLI file open, etc.)

### Routing

- Routes live in `src/routes/` and follow TanStack Router **file route** conventions.
- `src/routeTree.gen.ts` is **generated** by the router plugin; do **not** edit it manually.
- Example: `src/routes/index.tsx` defines the `/` route and uses a loader to call `loadDirs()`.

**When adding a route**

- Create a new route file under `src/routes/` using `createFileRoute(...)`.
- Do not edit `src/routeTree.gen.ts`; the build/dev tooling regenerates it.

### Features vs shared components

- **Feature modules** live in `src/features/*` (domain-focused pages + feature-specific components).
- **Shared components** live in `src/components/*` (reusable UI building blocks and app shell pieces).
- **Utility logic** lives in `src/utils/*` (chess logic, formatting, storage helpers, API helpers, etc.).

### State management patterns

#### Jotai (primary)

Most persistent settings and lightweight app state are Jotai atoms in `src/state/atoms.ts`.

Common storage patterns:

- `atomWithStorage(..., localStorage)` for durable settings.
- `atomWithStorage(..., sessionStorage)` for session-only state (tabs, current selections).
- **Tauri file-backed storage** via `fileStorage` in `src/state/utils.ts`:
  - Uses `@tauri-apps/plugin-fs` with `BaseDirectory.AppData`.
  - Used for persisted JSON files like `engines/engines.json`.

Guideline:

- Prefer **Jotai atoms** for settings/preferences and simple app state that is shared.
- If a state needs “view model” style transitions or complex reducers, consider a dedicated store.

#### Zustand (selectively)

The repo uses Zustand where state is more “store-like” or performance-sensitive:

- `src/state/store/tree.ts`: chess tree editing/navigation store (persisted per-tab via `tabStateStorage`).
- `src/state/store/database.ts`: database view state store (persisted to `sessionStorage`).
- `src/state/userStatsStore.ts`: persisted user learning stats (localStorage).

Guideline:

- Keep Zustand stores focused and avoid cross-store hidden coupling.
- When adding persistence: choose `sessionStorage` vs `localStorage` intentionally.

### Styling

- Global styles: `src/styles/*` and imported in `src/App.tsx`.
- A mix of `.css.ts` (vanilla-extract) and plain CSS files are used.

## i18n (language, formatting, and persistence)

### Initialization

- `src/i18n.ts` configures i18next with:
  - `resources` from `src/locales/*`
  - `lng` from `localStorage.getItem("lang")` (normalized to use `-`)
  - `fallbackLng` = `"en-US"`
  - namespaces: `["language", "translation"]`
  - custom formatters (bytes, nodes, duration, date/time formatting, move notation, etc.)

### Locale structure

Each locale folder (e.g. `src/locales/es/`) exports an object like:

- `language.DisplayName` (used to display language name in UI)
- `translation` loaded from `common.json`

### Language switching

Language selection is handled in `src/features/settings/SettingsPage.tsx`:

- Calls `i18n.changeLanguage(...)`
- Persists to `localStorage.lang`
- Updates direction using `i18n.dir()`

There is also a `useLanguageChangeListener` hook (`src/hooks/useLanguageChangeListener.ts`) that listens for a `window` event named `"languageChanged"` to force re-renders in some components (e.g., tables relying on formatter functions).

**When adding new text**

- **Always add new text strings to both**:
  - `src/locales/en-US/common.json` (English - US)
  - `src/locales/es/common.json` (Spanish)
- This applies to **any user-facing text**: messages, labels, placeholders, tooltips, button text, error messages, notifications, titles, descriptions, etc.
- Use `t("...")` calls consistently (prefer existing namespaces/keys).
- Never hardcode text strings directly in components; always use i18n keys.
- If you need to update missing translation tracking for other languages, use the repo script:
  - `pnpm update-missing-translations`

## Tauri backend (`src-tauri/`)

### Command and type exposure to the frontend

This repo uses **tauri-specta** to:

- expose Rust commands to the frontend
- generate TypeScript bindings into `src/bindings/generated.ts`

The generation is wired in `src-tauri/src/lib.rs`:

- `tauri_specta::Builder::new()`
- `.commands(collect_commands!(...))`
- `.events(collect_events!(...))`
- In debug builds, it exports TS to `../src/bindings/generated.ts`

**Do not manually edit** `src/bindings/generated.ts`. It will be overwritten.

Frontend-facing wrapper types live in `src/bindings/index.ts` (e.g., widened score value types).

### Plugins, setup, and app data directories

- Tauri plugins are initialized in `src-tauri/src/app/platform/mod.rs`.
- Required directories/files under `AppData` are ensured in `src-tauri/src/app/platform/shared.rs`:
  - directories like `engines/`, `db/`, `puzzles/`, `documents/`, etc.
  - files like `engines/engines.json` and `settings.json`

### Tauri config

- `src-tauri/tauri.conf.json` controls bundle, updater endpoints, CSP, window defaults, and dev URL.

## Generated files (do/don’t)

- **Do not edit**:
  - `src/routeTree.gen.ts` (TanStack Router generated)
  - `src/bindings/generated.ts` (tauri-specta generated)
- **Safe to edit**:
  - `src/bindings/index.ts` (frontend type adapters/wrappers)
  - Any files under `src/routes/` (source routes)
  - Rust command implementations under `src-tauri/src/**`

## Development workflows (commands)

From `package.json`:

- `pnpm dev`: Tauri dev (runs Vite via `beforeDevCommand`)
- `pnpm build`: Tauri build (no bundle)
- `pnpm start-vite`: Vite only
- `pnpm build-vite`: typecheck + Vite build
- `pnpm test`: Vitest run
- `pnpm lint`: `tsc --noEmit` + Biome checks
- `pnpm format`: Biome format on `src/`

## Practical "agent" rules

- Make changes **where the source of truth lives**:
  - UI/logic: `src/`
  - native commands/types: `src-tauri/`
  - SQL assets: `database/`
- Never patch generated files directly (see above). Fix the generator inputs instead.
- Prefer small, localized changes and keep behavior backwards compatible unless explicitly requested.
- Keep persistence stable:
  - If you change storage keys (e.g. Jotai `atomWithStorage` keys), provide migration logic.
- When adding new i18n keys, **always add them to both `en-US` and `es`**:
  - `src/locales/en-US/common.json` (English)
  - `src/locales/es/common.json` (Spanish)
  - This is mandatory for any user-facing text (messages, labels, placeholders, buttons, errors, etc.).

### Code modification guidelines

- **Do not modify files unnecessarily**: Only edit files that are directly related to the requested change. Avoid touching unrelated files, even if they have minor formatting differences.
- **Do not move ending lines arbitrarily**: Do not add or remove trailing newlines, move closing braces, or reformat file endings unless the change is explicitly required or improves code quality in a meaningful way.
- **Do not run tests or extra validations unless requested**: Only execute tests, linters, or validation scripts if the user explicitly asks for them. Do not run `pnpm test`, `pnpm lint`, or similar commands proactively unless the prompt requests verification or testing.

## How to add a new Tauri command (checklist)

1. Implement the command in Rust and mark it with:
   - `#[tauri::command]`
   - `#[specta::specta]`
2. Add it to the `collect_commands!(...)` list in `src-tauri/src/lib.rs`.
3. Run in dev mode to regenerate `src/bindings/generated.ts` (debug builds export types).
4. Call it from the frontend via `commands.<yourCommand>(...)` from `src/bindings/generated.ts`.

## How to add a new setting (recommended pattern)

1. Add a Jotai atom in `src/state/atoms.ts` using `atomWithStorage`.
2. Decide storage target:
   - `localStorage` for durable preferences
   - `sessionStorage` for per-session UI state
   - `fileStorage` (AppData) for large or file-based settings (Tauri FS)
3. Wire it into the relevant UI under `src/features/settings/*`.



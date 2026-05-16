import { Alert, Box, Group, LoadingOverlay, ScrollArea, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useAtom, useAtomValue } from "jotai";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { match } from "ts-pattern";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { NormalizedGame } from "@/bindings";
import { TreeStateContext } from "@/components/TreeStateContext";
import {
  activeProfileIdAtom,
  coverageEngineAnalysisActiveAtom,
  currentDbTabAtom,
  currentDbTypeAtom,
  currentLocalOptionsAtom,
  currentTabAtom,
  currentTabSelectedAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
  profilesAtom,
} from "@/state/atoms";
import {
  CHESSBASE_DATABASE_SENTINEL,
  type DatabaseInfo,
  getDatabases,
  isChessbaseDatabasePath,
  type Opening,
  searchPosition,
} from "@/utils/db";
import { convertToNormalized, getLichessGames, getMasterGames } from "@/utils/lichess/api";
import type { LichessGamesOptions, MasterGamesOptions } from "@/utils/lichess/explorer";
import DatabaseLoader from "./DatabaseLoader";
import GamesTable from "./GamesTable";
import OpeningsTable from "./OpeningsTable";
import LichessOptionsPanel from "./options/LichessOptionsPanel";
import LocalOptionsPanel from "./options/LocalOptionsPanel";
import MasterOptionsPanel from "./options/MastersOptionsPanel";

type OpeningData = { openings: Opening[]; games: NormalizedGame[] };
type ChessbaseSessionStatus = {
  connected: boolean;
  username: string | null;
  state: "ready" | "connecting" | "error" | "disconnected";
  last_error: string | null;
};
type ChessbaseCredentialsSummary = {
  username: string | null;
  has_password: boolean;
};

type DBType =
  | { type: "local"; options: LocalOptions }
  | { type: "lch_all"; options: LichessGamesOptions; fen: string }
  | { type: "lch_master"; options: MasterGamesOptions; fen: string };

function extractProfileIdFromDbFilename(filename: string | null | undefined): string | null {
  const value = (filename ?? "").trim();
  const match = /^profile_(.+)\.db3$/i.exec(value);
  if (!match?.[1]) return null;
  return match[1];
}

export type LocalOptions = {
  path: string | null;
  fen: string;
  type: "exact" | "partial";
  players: number[];
  color: "white" | "black" | "any";
  start_date?: string;
  end_date?: string;
  result: "any" | "whitewon" | "draw" | "blackwon";
  sort?: "id" | "date" | "whiteElo" | "blackElo" | "averageElo" | "ply_count";
  direction?: "asc" | "desc";
  gameDetailsLimit?: number;
};

function sortOpenings(openings: Opening[]) {
  return openings.sort((a, b) => b.black + b.draw + b.white - (a.black + a.draw + a.white));
}

async function fetchOpening(
  db: DBType,
  tab: string,
  gameDetailsLimit: number,
  includeGames: boolean,
  lichessToken?: string,
  signal?: AbortSignal,
) {
  return match(db)
    .with({ type: "lch_all" }, async ({ fen, options }) => {
      const data = await getLichessGames(fen, options, lichessToken, signal, !includeGames);
      return {
        openings: data.moves.map((move) => ({
          move: move.san,
          white: move.white,
          black: move.black,
          draw: move.draws,
        })),
        games: includeGames ? await convertToNormalized(data.topGames || data.recentGames || [], signal) : [],
      };
    })
    .with({ type: "lch_master" }, async ({ fen, options }) => {
      const data = await getMasterGames(fen, options, lichessToken, signal);
      return {
        openings: data.moves.map((move) => ({
          move: move.san,
          white: move.white,
          black: move.black,
          draw: move.draws,
        })),
        games: includeGames ? await convertToNormalized(data.topGames || data.recentGames || [], signal) : [],
      };
    })
    .with({ type: "local" }, async ({ options }) => {
      if (!options.path) throw Error("Missing reference database");
      if (!options.fen || options.fen.trim() === "") {
        throw Error("Missing FEN for local database search");
      }
      const positionData = await searchPosition({ ...options, gameDetailsLimit }, tab, signal);
      return {
        openings: sortOpenings(positionData[0]),
        games: positionData[1],
      };
    })
    .exhaustive();
}

function DatabasePanel({ forceActive = false }: { forceActive?: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const store = useContext(TreeStateContext);
  if (!store) {
    throw new Error("DatabasePanel must be used within a TreeStateProvider");
  }
  const [db, setDb] = useAtom(currentDbTypeAtom);
  const [lichessOptions] = useAtom(lichessOptionsAtom);
  const [masterOptions] = useAtom(masterOptionsAtom);
  const [localOptions, setLocalOptions] = useAtom(currentLocalOptionsAtom);
  const [gameLimit, setGameLimit] = useState(1000);
  const tab = useAtomValue(currentTabAtom);
  const [tabType, setTabType] = useAtom(currentDbTabAtom);
  const currentTabSelected = useAtomValue(currentTabSelectedAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const profiles = useAtomValue(profilesAtom);
  const coverageEngineAnalysisActive = useAtomValue(coverageEngineAnalysisActiveAtom);
  const tabValue = tab?.value ?? "analysis";
  const lichessAuthToken = useMemo(() => {
    const profileToken = profiles.find((p) => p.id === activeProfileId)?.lichessToken?.trim() || "";
    return profileToken || undefined;
  }, [activeProfileId, profiles]);
  const { data: chessbaseSessionStatus } = useQuery({
    queryKey: ["chessbase", "session-status", "database-panel"],
    queryFn: async () => {
      try {
        return await invoke<ChessbaseSessionStatus>("chessbase_session_status");
      } catch {
        return null;
      }
    },
    refetchInterval: 5000,
    staleTime: 2000,
  });
  const chessbaseConnected = chessbaseSessionStatus?.connected === true;
  const chessbaseAutoLoginAttemptedRef = useRef(false);

  useEffect(() => {
    if (chessbaseAutoLoginAttemptedRef.current) return;
    chessbaseAutoLoginAttemptedRef.current = true;

    void (async () => {
      try {
        const credentials = await invoke<ChessbaseCredentialsSummary>("chessbase_get_credentials");
        if (!credentials.has_password) return;
        const status = await invoke<ChessbaseSessionStatus>("chessbase_login_background");
        queryClient.setQueryData(["chessbase", "session-status", "database-panel"], status);
      } catch {
        // Ignore: no stored credentials or background login failed.
      } finally {
        queryClient.invalidateQueries({ queryKey: ["chessbase", "session-status", "database-panel"] });
      }
    })();
  }, [queryClient]);

  // Get available local databases
  const { data: databases } = useQuery({
    queryKey: ["databases"],
    queryFn: getDatabases,
  });

  // Filter only successful game databases (not puzzles)
  // Note: DatabaseInfo from getDatabases includes 'file' field at runtime
  const gameDatabases = useMemo(() => {
    const knownProfileDbFilenames = new Set(profiles.map((profile) => `profile_${profile.id}.db3`.toLowerCase()));

    return (databases ?? []).filter((db) => {
      if (db.type !== "success") return false;
      const filename = (db.filename ?? "").toLowerCase();
      if (!filename.startsWith("profile_") || !filename.endsWith(".db3")) {
        return true;
      }
      // Hide orphan profile DBs not linked to a live profile in app state.
      return knownProfileDbFilenames.has(filename);
    }) as Array<DatabaseInfo & { type: "success"; file: string }>;
  }, [databases, profiles]);

  // Default local DB selection:
  // - keep user's explicit selection (`localOptions.path`) if present
  // - otherwise pick the first available local DB
  const defaultLocalDbPath = useMemo(() => {
    if (localOptions.path) return localOptions.path;
    return gameDatabases[0]?.file ?? null;
  }, [gameDatabases, localOptions.path]);
  const localDatabaseOptions = useMemo(() => {
    const profileNameById = new Map(profiles.map((profile) => [profile.id, profile.name]));
    const options = gameDatabases.map((database) => {
      const profileId = extractProfileIdFromDbFilename(database.filename);
      const profileName = profileId ? profileNameById.get(profileId) : null;
      return {
        label: profileName ?? database.title,
        value: database.file,
      };
    });
    if (chessbaseConnected) {
      options.unshift({
        label: t("chessbase.title"),
        value: CHESSBASE_DATABASE_SENTINEL,
      });
    }
    return options;
  }, [gameDatabases, chessbaseConnected, profiles, t]);

  useEffect(() => {
    if (db !== "local") return;
    if (!localOptions.path) return;
    const existsInOptions = localDatabaseOptions.some((option) => option.value === localOptions.path);
    if (existsInOptions) return;
    setLocalOptions((prev) => ({
      ...prev,
      path: localDatabaseOptions[0]?.value ?? null,
    }));
  }, [db, localOptions.path, localDatabaseOptions, setLocalOptions]);

  // Only search when we're in the database tab and viewing stats or games
  const isDatabaseTabActive = currentTabSelected === "database";
  const isStatsOrGamesTab = tabType === "stats" || tabType === "games";
  const shouldSearch = !coverageEngineAnalysisActive && (forceActive || isDatabaseTabActive) && isStatsOrGamesTab;
  const includeGameDetails = tabType === "games";

  // Always get FEN from store to ensure we have the current position
  // Use a ref to track the last FEN to prevent unnecessary re-renders when not searching
  const lastNeededFenRef = useRef<string>(localOptions.fen || "");

  // Always get FEN from store - ALWAYS subscribe to changes
  // This ensures we always have the latest FEN, even when not searching
  const fenFromStore = useStore(
    store,
    useShallow((s: ReturnType<typeof store.getState>) => s.currentNode().fen),
  ) as string;

  // Always use the current FEN from store
  const fen: string = fenFromStore || lastNeededFenRef.current;

  // Update lastNeededFenRef when FEN changes
  useEffect(() => {
    if (fenFromStore && fenFromStore !== lastNeededFenRef.current) {
      lastNeededFenRef.current = fenFromStore;
    }
  }, [fenFromStore]);

  // Remote explorer calls are intentionally debounced a little longer to avoid piling up requests during fast navigation.
  const fenDebounceMs = db === "local" && isChessbaseDatabasePath(localOptions.path) ? 250 : db === "local" ? 100 : 150;
  const [debouncedFen] = useDebouncedValue(fen, fenDebounceMs);
  const effectiveLocalFen =
    db === "local" && isChessbaseDatabasePath(localOptions.path) ? debouncedFen || localOptions.fen : localOptions.fen;

  const prevFenRef = useRef<string>(localOptions.fen || "");

  // Cancel stale searches immediately when the board position changes, before the debounced query key settles.
  useEffect(() => {
    if (coverageEngineAnalysisActive) return;
    if (!fen) return;

    const fenChanged = fen !== prevFenRef.current;
    if (!fenChanged) return;
    prevFenRef.current = fen;

    if (shouldSearch) {
      void queryClient.cancelQueries({ queryKey: ["database-opening"] }).catch(() => {});
    }

    if (db !== "local" || !localOptions.path) return;

    setLocalOptions((q) => {
      const updated =
        q.fen !== fen
          ? { ...q, fen, sort: "averageElo" as const, direction: "desc" as const }
          : { ...q, sort: "averageElo" as const, direction: "desc" as const };
      return updated;
    });

    if (shouldSearch) {
      setGameLimit(1000);
    }
  }, [coverageEngineAnalysisActive, fen, setLocalOptions, db, queryClient, shouldSearch, localOptions.path]);

  // Handle debounced FEN for final query invalidation
  // This ensures we don't trigger too many queries during rapid FEN changes
  // ONLY invalidate if we're in the database tab and viewing stats or games
  useEffect(() => {
    if (db === "local" && debouncedFen === fen && shouldSearch && localOptions.path) {
      // Only invalidate when debounce settles and matches current FEN
      void queryClient.invalidateQueries({ queryKey: ["database-opening"] }).catch(() => {});
    }
  }, [debouncedFen, fen, db, queryClient, shouldSearch, localOptions.path]);

  // Auto-select database when switching to local DB mode
  // Also ensure FEN is initialized from store
  useEffect(() => {
    if (db === "local") {
      const currentFenFromStore = store.getState().currentNode().fen;
      const needsPathUpdate = defaultLocalDbPath && !localOptions.path;
      const needsFenUpdate = (!localOptions.fen || localOptions.fen.trim() === "") && currentFenFromStore;

      if (needsPathUpdate || needsFenUpdate) {
        setLocalOptions((q) => ({
          ...q,
          ...(needsPathUpdate ? { path: defaultLocalDbPath } : {}),
          ...(needsFenUpdate ? { fen: currentFenFromStore } : {}),
        }));
      }
    }
  }, [db, defaultLocalDbPath, localOptions.path, localOptions.fen, setLocalOptions, store]);

  useEffect(() => {
    if (db !== "local") return;
    if (!isChessbaseDatabasePath(localOptions.path)) return;
    if (chessbaseConnected) return;

    setLocalOptions((prev) => ({
      ...prev,
      path: gameDatabases[0]?.file ?? null,
    }));
  }, [db, localOptions.path, chessbaseConnected, setLocalOptions, gameDatabases]);

  // Memoize dbType to avoid recreating on every render
  // IMPORTANT: Always use localOptions.fen (updated immediately) for local DB to ensure synchronization
  const dbType: DBType = useMemo(
    () =>
      match(db)
        .with("local", (v) => ({
          type: v,
          options: { ...localOptions, fen: effectiveLocalFen }, // Use debounced fen for ChessBase only
        }))
        .with("lch_all", (v) => ({
          type: v,
          options: lichessOptions,
          fen: debouncedFen,
        }))
        .with("lch_master", (v) => ({
          type: v,
          options: masterOptions,
          fen: debouncedFen,
        }))
        .exhaustive(),
    [db, localOptions, effectiveLocalFen, lichessOptions, masterOptions, debouncedFen],
  );

  // Ensure FEN is always set when we have a path but no FEN
  useEffect(() => {
    if (db === "local" && localOptions.path && (!localOptions.fen || localOptions.fen.trim() === "")) {
      const currentFenFromStore = store.getState().currentNode().fen;
      if (currentFenFromStore) {
        setLocalOptions((q) => ({ ...q, fen: currentFenFromStore }));
      }
    }
  }, [db, localOptions.path, localOptions.fen, setLocalOptions, store]);

  // Only enable query when:
  // 1. We're in the database tab (currentTabSelected === "database")
  // 2. We're viewing stats or games (not options)
  // 3. For local DB, we have FEN and path
  const queryEnabled =
    shouldSearch && (db !== "local" || (!!effectiveLocalFen && !!localOptions.path && effectiveLocalFen.trim() !== ""));

  const queryKey = [
    "database-opening",
    db,
    db === "local" ? effectiveLocalFen : debouncedFen, // include fen for all DBs to refetch on board move
    db === "local" ? localOptions.path : null, // include path to refetch when database changes
    db === "local" ? localOptions.type : null,
    db === "local" ? localOptions.players : null,
    db === "local" ? localOptions.color : null,
    db === "local" ? localOptions.start_date : null,
    db === "local" ? localOptions.end_date : null,
    db === "local" ? localOptions.result : null,
    db === "local" ? localOptions.sort : null,
    db === "local" ? localOptions.direction : null,
    tabValue,
    includeGameDetails,
    gameLimit,
    db === "local" ? null : (lichessAuthToken ?? null),
    db === "local" ? null : activeProfileId,
  ];
  const {
    data: openingData,
    isLoading,
    isFetching,
    error,
  } = useQuery<OpeningData, Error, OpeningData, readonly unknown[]>({
    // Use localOptions.fen directly for queryKey to ensure it matches what's sent to backend
    queryKey,
    queryFn: async ({ signal }) => {
      const result = (await fetchOpening(
        dbType,
        tabValue,
        gameLimit,
        includeGameDetails,
        lichessAuthToken,
        signal,
      )) as OpeningData;
      return result;
    },
    enabled: queryEnabled && (db !== "local" || (!!effectiveLocalFen && !!localOptions.path)),
    staleTime: 0, // Always refetch when FEN or parameters change to show latest results
    gcTime: 10000, // Keep in cache for 10 seconds (reduced from 30)
    refetchOnMount: true, // Refetch when component mounts to ensure fresh data
    placeholderData: (previousData) => previousData,
  });

  const grandTotal = openingData?.openings?.reduce(
    (acc: number, curr: Opening) => acc + curr.black + curr.white + curr.draw,
    0,
  );
  const isSearching = isLoading || isFetching;
  const matches = Math.max(grandTotal || 0, openingData?.games.length || 0);

  return (
    <Stack h="100%" gap="xs" style={{ minHeight: 0, minWidth: 0 }}>
      <Stack gap="xs" style={{ flexShrink: 0 }}>
        <Group justify="space-between" gap="xs" wrap="wrap">
          <SegmentedControl
            size="sm"
            data={[
              { label: t("features.board.database.local"), value: "local" },
              { label: t("features.board.database.lichessAll"), value: "lch_all" },
              { label: t("features.board.database.lichessMaster"), value: "lch_master" },
            ]}
            value={db}
            onChange={(value) => setDb(value as "local" | "lch_all" | "lch_master")}
          />

          <Group gap="xs" wrap="wrap" justify="flex-end">
            {tabType !== "options" && (
              <Text size="md" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
                {t("features.board.database.matches", { matches })}
              </Text>
            )}
            <SegmentedControl
              size="sm"
              data={[
                {
                  label: t("features.board.database.stats"),
                  value: "stats",
                  disabled:
                    dbType.type === "local" &&
                    dbType.options.type === "partial" &&
                    !isChessbaseDatabasePath(dbType.options.path),
                },
                { label: t("features.board.database.games"), value: "games" },
                { label: t("features.board.database.options"), value: "options" },
              ]}
              value={tabType}
              onChange={(value) => setTabType(value)}
            />
          </Group>
        </Group>

        {db === "local" && (
          <Select
            data={localDatabaseOptions}
            value={localOptions.path ?? defaultLocalDbPath}
            onChange={(value) => {
              if (value) {
                const currentFenFromStore = store.getState().currentNode().fen;
                const isChessbase = isChessbaseDatabasePath(value);
                setLocalOptions((prev) => ({
                  ...prev,
                  path: value,
                  fen: currentFenFromStore || prev.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
                  players: isChessbase ? [] : prev.players,
                }));
                void queryClient.invalidateQueries({ queryKey: ["database-opening"] }).catch(() => {});
              }
            }}
            placeholder={t("features.board.database.selectDatabase")}
            searchable
            clearable={false}
          />
        )}
      </Stack>

      <DatabaseLoader isLoading={isSearching} tab={tab?.value ?? null} />

      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {tabType === "stats" && (
          <PanelWithError
            value="stats"
            error={error}
            type={db}
            hasLocalDatabase={!!localOptions.path}
            loading={isSearching}
          >
            <OpeningsTable openings={openingData?.openings || []} loading={false} />
          </PanelWithError>
        )}
        {tabType === "games" && (
          <PanelWithError
            value="games"
            error={error}
            type={db}
            hasLocalDatabase={!!localOptions.path}
            loading={isSearching}
          >
            <GamesTable
              games={openingData?.games || []}
              loading={false}
              fen={db === "local" ? effectiveLocalFen : debouncedFen}
              databasePath={
                db === "local" && localOptions.path && !isChessbaseDatabasePath(localOptions.path)
                  ? localOptions.path
                  : undefined
              }
            />
          </PanelWithError>
        )}
        {tabType === "options" && (
          <PanelWithError
            value="options"
            error={error}
            type={db}
            hasLocalDatabase={!!localOptions.path}
            loading={isSearching}
          >
            <ScrollArea h="100%" offsetScrollbars>
              {match(db)
                .with("local", () => <LocalOptionsPanel boardFen={debouncedFen} />)
                .with("lch_all", () => <LichessOptionsPanel />)
                .with("lch_master", () => <MasterOptionsPanel />)
                .exhaustive()}
            </ScrollArea>
          </PanelWithError>
        )}
      </Box>
    </Stack>
  );
}

function PanelWithError(props: {
  value: string;
  error: Error | null;
  type: string;
  hasLocalDatabase: boolean;
  loading: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  let children = props.children;
  if (props.type === "local" && !props.hasLocalDatabase) {
    children = <Text size="sm">{t("features.board.variants.treeBuilder.missingDb")}</Text>;
  }
  if (props.error && props.type !== "local") {
    children = <Alert color="red">{props.error.message}</Alert>;
  }

  return (
    <Box
      flex={1}
      pos="relative"
      style={{ minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      <LoadingOverlay
        visible={props.loading && props.value !== "options"}
        zIndex={30}
        overlayProps={{ blur: 1 }}
        loaderProps={{ size: "md" }}
      />
      <Box style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {children}
      </Box>
    </Box>
  );
}

export default memo(DatabasePanel);

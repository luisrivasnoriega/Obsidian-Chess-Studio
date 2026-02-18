import { Alert, Group, LoadingOverlay, ScrollArea, SegmentedControl, Select, Stack, Tabs, Text } from "@mantine/core";
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
  currentDbTabAtom,
  currentDbTypeAtom,
  currentLocalOptionsAtom,
  currentTabAtom,
  currentTabSelectedAtom,
  lichessOptionsAtom,
  masterOptionsAtom,
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

type DBType =
  | { type: "local"; options: LocalOptions }
  | { type: "lch_all"; options: LichessGamesOptions; fen: string }
  | { type: "lch_master"; options: MasterGamesOptions; fen: string };

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

async function fetchOpening(db: DBType, tab: string, gameDetailsLimit: number, signal?: AbortSignal) {
  return match(db)
    .with({ type: "lch_all" }, async ({ fen, options }) => {
      const data = await getLichessGames(fen, options);
      return {
        openings: data.moves.map((move) => ({
          move: move.san,
          white: move.white,
          black: move.black,
          draw: move.draws,
        })),
        games: await convertToNormalized(data.topGames || data.recentGames || []),
      };
    })
    .with({ type: "lch_master" }, async ({ fen, options }) => {
      const data = await getMasterGames(fen, options);
      return {
        openings: data.moves.map((move) => ({
          move: move.san,
          white: move.white,
          black: move.black,
          draw: move.draws,
        })),
        games: await convertToNormalized(data.topGames || data.recentGames || []),
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

function DatabasePanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const store = useContext(TreeStateContext)!;
  const [db, setDb] = useAtom(currentDbTypeAtom);
  const [lichessOptions] = useAtom(lichessOptionsAtom);
  const [masterOptions] = useAtom(masterOptionsAtom);
  const [localOptions, setLocalOptions] = useAtom(currentLocalOptionsAtom);
  const [gameLimit, setGameLimit] = useState(1000);
  const tab = useAtomValue(currentTabAtom);
  const [tabType, setTabType] = useAtom(currentDbTabAtom);
  const currentTabSelected = useAtomValue(currentTabSelectedAtom);
  const tabValue = tab?.value ?? "analysis";
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

  // Get available local databases
  const { data: databases } = useQuery({
    queryKey: ["databases"],
    queryFn: getDatabases,
  });

  // Filter only successful game databases (not puzzles)
  // Note: DatabaseInfo from getDatabases includes 'file' field at runtime
  const gameDatabases = useMemo(() => {
    return (databases ?? []).filter((db) => db.type === "success") as Array<
      DatabaseInfo & { type: "success"; file: string }
    >;
  }, [databases]);

  // Default local DB selection:
  // - keep user's explicit selection (`localOptions.path`) if present
  // - otherwise pick the first available local DB
  const defaultLocalDbPath = useMemo(() => {
    if (localOptions.path) return localOptions.path;
    return gameDatabases[0]?.file ?? null;
  }, [gameDatabases, localOptions.path]);
  const localDatabaseOptions = useMemo(() => {
    const options = gameDatabases.map((database) => ({
      label: database.title,
      value: database.file,
    }));
    if (chessbaseConnected) {
      options.unshift({
        label: t("chessbase.title"),
        value: CHESSBASE_DATABASE_SENTINEL,
      });
    }
    return options;
  }, [gameDatabases, chessbaseConnected, t]);

  // Only search when we're in the database tab and viewing stats or games
  const isDatabaseTabActive = currentTabSelected === "database";
  const isStatsOrGamesTab = tabType === "stats" || tabType === "games";
  const shouldSearch = isDatabaseTabActive && isStatsOrGamesTab;

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

  const fenDebounceMs = db === "local" && isChessbaseDatabasePath(localOptions.path) ? 250 : db === "local" ? 100 : 50;
  // Use a higher debounce for ChessBase to avoid flooding websocket requests while dragging pieces quickly.
  const [debouncedFen] = useDebouncedValue(fen, fenDebounceMs);
  const effectiveLocalFen =
    db === "local" && isChessbaseDatabasePath(localOptions.path) ? debouncedFen || localOptions.fen : localOptions.fen;

  const prevFenRef = useRef<string>(localOptions.fen || "");

  // Update localOptions immediately when FEN changes (before debounce)
  // This ensures the query always uses the latest FEN
  // Always load 1000 games sorted by elo when FEN changes
  // Update FEN whenever it changes, not just when searching
  useEffect(() => {
    if (db === "local" && localOptions.path && fen) {
      const fenChanged = fen !== prevFenRef.current;
      if (fenChanged) {
        prevFenRef.current = fen;

        // Cancel any ongoing queries immediately when FEN changes
        if (shouldSearch) {
          queryClient.cancelQueries({ queryKey: ["database-opening"] });
        }

        setLocalOptions((q) => {
          // Update FEN immediately and ensure sort is by averageElo
          const updated =
            q.fen !== fen
              ? { ...q, fen, sort: "averageElo" as const, direction: "desc" as const }
              : { ...q, sort: "averageElo" as const, direction: "desc" as const };
          return updated;
        });

        // Always set limit to 1000 when FEN changes
        if (shouldSearch) {
          setGameLimit(1000);
        }
      }
    }
  }, [fen, setLocalOptions, db, queryClient, shouldSearch, localOptions.path]);

  // Handle debounced FEN for final query invalidation
  // This ensures we don't trigger too many queries during rapid FEN changes
  // ONLY invalidate if we're in the database tab and viewing stats or games
  useEffect(() => {
    if (db === "local" && debouncedFen === fen && shouldSearch && localOptions.path) {
      // Only invalidate when debounce settles and matches current FEN
      queryClient.invalidateQueries({ queryKey: ["database-opening"] });
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
    gameLimit,
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
      const result = (await fetchOpening(dbType, tabValue, gameLimit, signal)) as OpeningData;
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

  return (
    <Stack h="100%" gap={0}>
      <Group justify="space-between" w="100%">
        <SegmentedControl
          data={[
            { label: t("features.board.database.local"), value: "local" },
            { label: t("features.board.database.lichessAll"), value: "lch_all" },
            { label: t("features.board.database.lichessMaster"), value: "lch_master" },
          ]}
          value={db}
          onChange={(value) => setDb(value as "local" | "lch_all" | "lch_master")}
        />

        {tabType !== "options" && (
          <Text>
            {t("features.board.database.matches", {
              matches: Math.max(grandTotal || 0, openingData?.games.length || 0),
            })}
          </Text>
        )}
      </Group>

      <DatabaseLoader isLoading={isSearching} tab={tab?.value ?? null} />

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
              // Invalidate queries to trigger new search with new database
              queryClient.invalidateQueries({ queryKey: ["database-opening"] });
            }
          }}
          placeholder={t("features.board.database.selectDatabase")}
          searchable
          clearable={false}
          style={{ minWidth: 200 }}
          mb="xs"
        />
      )}

      <Tabs
        defaultValue="stats"
        orientation="vertical"
        placement="right"
        value={tabType}
        onChange={(v) => setTabType(v!)}
        display="flex"
        flex={1}
        style={{ overflow: "hidden" }}
      >
        <Tabs.List>
          <Tabs.Tab
            value="stats"
            disabled={
              dbType.type === "local" &&
              dbType.options.type === "partial" &&
              !isChessbaseDatabasePath(dbType.options.path)
            }
          >
            {t("features.board.database.stats")}
          </Tabs.Tab>
          <Tabs.Tab value="games">{t("features.board.database.games")}</Tabs.Tab>
          <Tabs.Tab value="options">{t("features.board.database.options")}</Tabs.Tab>
        </Tabs.List>

        <PanelWithError
          value="stats"
          error={error}
          type={db}
          hasLocalDatabase={!!localOptions.path}
          loading={isSearching}
          activeValue={tabType}
        >
          <OpeningsTable openings={openingData?.openings || []} loading={false} />
        </PanelWithError>
        <PanelWithError
          value="games"
          error={error}
          type={db}
          hasLocalDatabase={!!localOptions.path}
          loading={isSearching}
          activeValue={tabType}
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
        <PanelWithError
          value="options"
          error={error}
          type={db}
          hasLocalDatabase={!!localOptions.path}
          loading={isSearching}
          activeValue={tabType}
        >
          <ScrollArea h="100%" offsetScrollbars>
            {match(db)
              .with("local", () => <LocalOptionsPanel boardFen={debouncedFen} />)
              .with("lch_all", () => <LichessOptionsPanel />)
              .with("lch_master", () => <MasterOptionsPanel />)
              .exhaustive()}
          </ScrollArea>
        </PanelWithError>
      </Tabs>
    </Stack>
  );
}

function PanelWithError(props: {
  value: string;
  activeValue: string;
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
    <Tabs.Panel pt="xs" value={props.value} flex={1} pos="relative">
      <LoadingOverlay
        visible={props.loading && props.value !== "options" && props.value === props.activeValue}
        zIndex={30}
        overlayProps={{ blur: 1 }}
        loaderProps={{ size: "md" }}
      />
      {children}
    </Tabs.Panel>
  );
}

export default memo(DatabasePanel);

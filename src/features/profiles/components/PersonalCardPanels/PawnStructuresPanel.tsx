import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  DEFAULT_THEME,
  Flex,
  Group,
  Modal,
  MultiSelect,
  Pagination,
  Paper,
  Progress,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMediaQuery } from "@mantine/hooks";
import { IconCopy, IconSearch } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NormalizedGame, PlayerGameInfo, SiteStatsData } from "@/bindings";
import { commands } from "@/bindings";
import { playerStatsCommands } from "@/bindings/playerStats";
import { Chessground } from "@/components/Chessground";
import PlayerSidebarCard, {
  type PlatformFilter,
  type TimeControlFilter,
} from "@/features/profiles/components/PersonalCardPanels/PlayerSidebarCard";
import { DateRange } from "@/features/profiles/components/PersonalCardPanels/DateRangeTabs";
import { createSiteStatsSignature, convertDateRangeToBackend } from "@/utils/playerStats";
import { PanelLoadGate } from "@/features/profiles/components/PersonalCardPanels/PanelLoadGate";
import { activeTabAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import { parsePGN } from "@/utils/chess";
import { query_players } from "@/utils/db";
import type { PawnStructureStat as PawnStructureStatBackend, PawnStructureGame as PawnStructureGameBackend } from "@/bindings";
import { getProfileDbPath } from "@/utils/profileDb";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import {
  buildSessionsSignature,
  computePersonalInfoSignature,
  fetchMergedPlayerInfo,
  fetchPersonalInfoForProfile,
  getMergedPlayerInfoQueryKey,
  getPersonalInfoQueryKey,
} from "@/features/profiles/components/PersonalCardPanels/Databases";

type PawnStructuresPanelProps = {
  playerName: string;
  databaseFile?: string;
  profileId?: string;
};

const fallbackFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Frontend types (camelCase) mapped from backend types (snake_case)
type PawnStructureGame = {
  gameId?: number;
  white?: string;
  black?: string;
  whiteElo?: number;
  blackElo?: number;
  result?: string;
  fen: string;
};

type PawnStructureStat = {
  structure: string;
  frequency: number;
  winRate: number;
  sampleFen?: string;
  games?: PawnStructureGame[];
};

function matchesName(candidate: string | undefined, targets: string[]): boolean {
  if (!candidate || targets.length === 0) return false;
  const cand = candidate.toLowerCase().trim();
  return targets.some((target) => {
    const normalizedTarget = target.toLowerCase().trim();
    // Exact match or one contains the other
    return cand === normalizedTarget || cand.includes(normalizedTarget) || normalizedTarget.includes(cand);
  });
}

function createPgnFromNormalizedGame(game: NormalizedGame): string {
  const resultTag = game.result || "*";
  const movesText = (game.moves || "").trim();
  const hasResult = /(?:1-0|0-1|1\/2-1\/2|\*)$/.test(movesText);
  const movetext = movesText ? (hasResult ? movesText : `${movesText} ${resultTag}`) : resultTag;

  let pgn = `[Event "${game.event || "Online Game"}"]\n`;
  pgn += `[Site "${game.site || "Online"}"]\n`;
  pgn += `[Date "${game.date || "????.??.??"}"]\n`;
  if (game.round) {
    pgn += `[Round "${game.round}"]\n`;
  }
  pgn += `[White "${game.white || "White"}"]\n`;
  pgn += `[Black "${game.black || "Black"}"]\n`;
  pgn += `[Result "${resultTag}"]\n`;
  if (game.white_elo) {
    pgn += `[WhiteElo "${game.white_elo}"]\n`;
  }
  if (game.black_elo) {
    pgn += `[BlackElo "${game.black_elo}"]\n`;
  }
  if (game.time_control) {
    pgn += `[TimeControl "${game.time_control}"]\n`;
  }
  if (game.eco) {
    pgn += `[ECO "${game.eco}"]\n`;
  }
  pgn += "\n";
  pgn += movetext;
  return pgn;
}

export default function PawnStructuresPanel({ playerName, databaseFile, profileId }: PawnStructuresPanelProps) {
  const { t } = useTranslation();
  const isStackedLayout = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const queryClient = useQueryClient();

  const [pawnMoveFilter, setPawnMoveFilter] = useState(10);
  const [pawnColorFilter, setPawnColorFilter] = useState<"white" | "black" | "any">("white");
  const [pawnStructureMode, setPawnStructureMode] = useState<"player" | "both">("player");
  const [pawnMotifFilters, setPawnMotifFilters] = useState<string[]>([]);
  const [pawnNamedStructureFilters, setPawnNamedStructureFilters] = useState<string[]>([]);
  const [pawnSortBy, setPawnSortBy] = useState<"frequency" | "winRate">("frequency");
  const [pawnLoading, setPawnLoading] = useState(false);
  const [pawnProgress, setPawnProgress] = useState<number | null>(null);
  const [expandedStructure, setExpandedStructure] = useState<string | null>(null);
  const [expandedFen, setExpandedFen] = useState<string | null>(null);
  const [mobileViewedStructure, setMobileViewedStructure] = useState<PawnStructureStat | null>(null);
  const [gamesPage, setGamesPage] = useState(1);
  const [, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const sessions = useAtomValue(sessionsAtom);
  const sessionsSignature = useMemo(() => buildSessionsSignature(sessions), [sessions]);

  const moveOptions = Array.from({ length: 50 }, (_, i) => ({ value: (i + 1).toString(), label: (i + 1).toString() }));

  const motifOptions = useMemo(
    () => [
      { value: "islands", label: t("features.dashboard.pawnMotif.islands", { defaultValue: "Pawn islands" }) },
      { value: "isolated", label: t("features.dashboard.pawnMotif.isolated", { defaultValue: "Isolated pawn" }) },
      { value: "doubled", label: t("features.dashboard.pawnMotif.doubled", { defaultValue: "Doubled pawns" }) },
      { value: "passed", label: t("features.dashboard.pawnMotif.passed", { defaultValue: "Passed pawn" }) },
      { value: "hanging", label: t("features.dashboard.pawnMotif.hanging", { defaultValue: "Hanging pawns" }) },
      { value: "backward", label: t("features.dashboard.pawnMotif.backward", { defaultValue: "Backward pawn" }) },
      { value: "minority_attack", label: t("features.dashboard.pawnMotif.minorityAttack", { defaultValue: "Minority attack" }) },
      { value: "iqp", label: t("features.dashboard.pawnMotif.iqp", { defaultValue: "Isolated Queen’s Pawn (IQP)" }) },
      { value: "connected_passed", label: t("features.dashboard.pawnMotif.connectedPassed", { defaultValue: "Connected passed pawns" }) },
      { value: "fianchetto", label: t("features.dashboard.pawnMotif.fianchetto", { defaultValue: "Fianchetto pawn structure" }) },
    ],
    [t],
  );

  const namedStructureOptions = useMemo(
    () => [
      { value: "carlsbad", label: t("features.dashboard.pawnStructure.carlsbad", { defaultValue: "Carlsbad" }) },
      { value: "maroczy_bind", label: t("features.dashboard.pawnStructure.maroczyBind", { defaultValue: "Maróczy Bind" }) },
      { value: "hedgehog", label: t("features.dashboard.pawnStructure.hedgehog", { defaultValue: "Hedgehog" }) },
      { value: "stonewall", label: t("features.dashboard.pawnStructure.stonewall", { defaultValue: "Stonewall" }) },
      { value: "scheveningen", label: t("features.dashboard.pawnStructure.scheveningen", { defaultValue: "Scheveningen" }) },
      { value: "najdorf", label: t("features.dashboard.pawnStructure.najdorf", { defaultValue: "Najdorf" }) },
      { value: "dragon", label: t("features.dashboard.pawnStructure.dragon", { defaultValue: "Dragon" }) },
      { value: "benoni", label: t("features.dashboard.pawnStructure.benoni", { defaultValue: "Benoni" }) },
      { value: "benko", label: t("features.dashboard.pawnStructure.benko", { defaultValue: "Benko Gambit Structure" }) },
      { value: "french", label: t("features.dashboard.pawnStructure.french", { defaultValue: "French Structure" }) },
      { value: "slav", label: t("features.dashboard.pawnStructure.slav", { defaultValue: "Slav Structure" }) },
      { value: "semi_slav_triangle", label: t("features.dashboard.pawnStructure.semiSlavTriangle", { defaultValue: "Semi-Slav Triangle" }) },
      { value: "kings_indian", label: t("features.dashboard.pawnStructure.kingsIndian", { defaultValue: "King’s Indian Structure" }) },
    ],
    [t],
  );

  const { data: resolvedDbPath } = useQuery<string | null>({
    queryKey: ["pawnStructuresDbPath", profileId ?? "", databaseFile ?? ""],
    queryFn: async () => {
      if (profileId) return await getProfileDbPath(profileId);
      return databaseFile ?? null;
    },
    enabled: !!profileId || !!databaseFile,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const playerSessions = useMemo(
    () =>
      sessions.filter(
        (session) => session.profileId === profileId && (session.lichess?.username || session.chessCom?.username),
      ),
    [sessions, profileId],
  );

  // Get all possible account keys for matching player names in games
  const playerAccountKeys = useMemo(() => {
    const keys: string[] = [];
    if (profileId && playerSessions.length > 0) {
      for (const session of playerSessions) {
        if (session.lichess?.username) {
          keys.push(getAccountKey("lichess", session.lichess.username));
        }
        if (session.chessCom?.username) {
          keys.push(getAccountKey("chesscom", session.chessCom.username));
        }
      }
    }
    // Only fall back to the raw playerName if we couldn't derive any account keys.
    // In profile context, playerName is often a human label (e.g. "Mata") that may match many DB rows.
    if (keys.length === 0 && playerName) {
      keys.push(playerName);
    }
    return keys;
  }, [profileId, playerSessions, playerName]);

  // Cached pawn structures result key (so tab switches don't recompute).
  const pawnSearchKey = useMemo(() => {
    const dbPath = resolvedDbPath ?? null;
    if (!dbPath) return null;
    const backendDateRange = convertDateRangeToBackend(dateRange) ?? "";
    const motifs = [...pawnMotifFilters].sort().join(",");
    const names = [...pawnNamedStructureFilters].sort().join(",");
    const accounts = [...playerAccountKeys].map((k) => k.trim().toLowerCase()).sort().join("|");
    return [
      dbPath,
      accounts,
      pawnColorFilter,
      platform,
      timeControl,
      opponentEloBucket,
      backendDateRange,
      String(pawnMoveFilter),
      pawnStructureMode,
      motifs,
      names,
    ].join("||");
  }, [
    resolvedDbPath,
    playerAccountKeys,
    pawnColorFilter,
    platform,
    timeControl,
    opponentEloBucket,
    dateRange,
    pawnMoveFilter,
    pawnStructureMode,
    pawnMotifFilters,
    pawnNamedStructureFilters,
  ]);

  const pawnResultQueryKey = pawnSearchKey
    ? (["pawnStructuresResult", pawnSearchKey] as const)
    : (["pawnStructuresResult", "disabled"] as const);

  const { data: pawnStructures = [] } = useQuery<PawnStructureStat[]>({
    queryKey: pawnResultQueryKey,
    queryFn: async () => [],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const sortedStructures = useMemo(() => {
    const next = [...pawnStructures];
    return next.sort((a, b) => (pawnSortBy === "frequency" ? b.frequency - a.frequency : b.winRate - a.winRate));
  }, [pawnStructures, pawnSortBy]);

  // Reuse the same cached PersonalInfo/Merge pipeline used by the other profile tabs.
  const { data: personalInfo, isLoading: isLoadingPersonalInfo, isFetching: isFetchingPersonalInfo } = useQuery({
    queryKey: getPersonalInfoQueryKey(profileId ?? "", sessionsSignature),
    queryFn: async () => {
      if (!profileId) return [];
      return fetchPersonalInfoForProfile({ effectiveProfileId: profileId, sessions });
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled: !!profileId && sessions.length > 0,
  });

  const personalInfoSignature = useMemo(() => computePersonalInfoSignature(personalInfo), [personalInfo]);

  const { data: mergedInfo } = useQuery<PlayerGameInfo | null>({
    queryKey: personalInfoSignature ? getMergedPlayerInfoQueryKey(personalInfoSignature) : ["mergedPlayerInfo", null],
    queryFn: async () => {
      if (!personalInfo || personalInfo.length === 0) return null;
      return fetchMergedPlayerInfo(personalInfo);
    },
    enabled: !!personalInfo && personalInfo.length > 0 && personalInfoSignature !== null,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
  });

  const playerInfo = mergedInfo ?? { site_stats_data: [] };

  const statsSig = useMemo(() => createSiteStatsSignature(playerInfo.site_stats_data), [playerInfo.site_stats_data]);

  const { data: sidebarModel } = useQuery({
    queryKey: ["playerSidebarModel", statsSig.key],
    queryFn: async () => {
      return unwrap(await playerStatsCommands.calculatePlayerSidebarModel(playerInfo.site_stats_data ?? []));
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    enabled: statsSig.games > 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const opponentEloOptions = useMemo(() => {
    const buckets = new Set<number>();
    for (const site of playerInfo.site_stats_data ?? []) {
      for (const game of site.data) {
        if (typeof game.opponent_elo !== "number") continue;
        buckets.add(Math.floor(game.opponent_elo / 200) * 200);
      }
    }
    const sorted = Array.from(buckets).sort((a, b) => a - b);
    return [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      ...sorted.map((start) => ({ value: String(start), label: `${start}-${start + 199}` })),
    ];
  }, [playerInfo.site_stats_data, t]);


  const handleSearch = async () => {
    // Keep the source of truth consistent with the other profile tabs:
    // if we have a profileId, always use getProfileDbPath(profileId).
    const dbPath = resolvedDbPath ?? (profileId ? await getProfileDbPath(profileId) : (databaseFile ?? null));

    if (!dbPath) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("features.dashboard.noPawnStructures"),
        color: "orange",
      });
      return;
    }

    if (playerAccountKeys.length === 0) {
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("profiles.errors.missingName", { defaultValue: "Profile name is required." }),
        color: "red",
      });
      return;
    }

    setPawnLoading(true);
    setPawnProgress(10);

    try {
      // Get player IDs from the database using account keys
      setPawnProgress(20);
      const playerIds = new Set<number>();
      for (const accountKey of playerAccountKeys) {
        try {
          const players = await query_players(dbPath, {
            name: accountKey,
            options: {
              pageSize: 200,
              direction: "asc",
              sort: "id",
              skipCount: false,
            },
          });
          const normalizedAccountKey = accountKey.trim().toLowerCase();
          const player =
            players.data.find((p) => (p.name ?? "").trim().toLowerCase() === normalizedAccountKey) ?? players.data[0];
          if (player?.id != null) playerIds.add(player.id);
        } catch (error) {
          // Continue if one account key fails
          console.warn(`Failed to find player for account key ${accountKey}:`, error);
        }
      }

      if (playerIds.size === 0) {
        notifications.show({
          title: t("common.error", { defaultValue: "Error" }),
          message: t("profiles.errors.missingName", { defaultValue: "Player not found in database." }),
          color: "red",
        });
        setPawnLoading(false);
        setPawnProgress(null);
        return;
      }

      setPawnProgress(40);
      
      // Convert dateRange to backend format (all filtering happens in backend)
      const backendDateRange = convertDateRangeToBackend(dateRange);
      
      // Prepare parameters for the command
      const params: any = {
        playerIds: Array.from(playerIds),
        colorFilter: pawnColorFilter,
        platformFilter: platform,
        timeControlFilter: timeControl,
        opponentEloBucket: opponentEloBucket,
        dateRange: backendDateRange,
        moveNumber: pawnMoveFilter,
        playerColor: pawnColorFilter === "any" ? "any" : pawnColorFilter,
        pawnStructureMode: pawnStructureMode,
        structureFilters: pawnMotifFilters,
        structureNameFilters: pawnNamedStructureFilters,
      };

      // Simulate progress during computation
      setPawnProgress(60);
      
      // Call Rust backend to compute pawn structures
      const result = await commands.computePawnStructures(dbPath, params);
      
      setPawnProgress(90);

      const structures = unwrap(result);

      if (!structures || !Array.isArray(structures) || structures.length === 0) {
        notifications.show({
          title: t("features.dashboard.noPawnStructures"),
          message: t("features.dashboard.noPawnStructuresMessage"),
          color: "orange",
        });
        setPawnLoading(false);
        setPawnProgress(null);
        return;
      }

      // Convert Rust types (snake_case) to frontend types (camelCase) and cache the result.
      const converted = structures.map((s: PawnStructureStatBackend): PawnStructureStat => ({
        structure: s.structure,
        frequency: s.frequency,
        winRate: s.win_rate,
        sampleFen: s.sample_fen ?? undefined,
        games: (s.games || []).map((g: PawnStructureGameBackend): PawnStructureGame => ({
          gameId: g.game_id,
          white: g.white,
          black: g.black,
          whiteElo: g.white_elo ?? undefined,
          blackElo: g.black_elo ?? undefined,
          result: g.result,
          fen: g.fen,
        })),
      }));

      // Compute a key from the *actual* dbPath used (resolvedDbPath may not be ready yet).
      const cacheDateRange = convertDateRangeToBackend(dateRange) ?? "";
      const motifs = [...pawnMotifFilters].sort().join(",");
      const names = [...pawnNamedStructureFilters].sort().join(",");
      const accounts = [...playerAccountKeys].map((k) => k.trim().toLowerCase()).sort().join("|");
      const key = [
        dbPath,
        accounts,
        pawnColorFilter,
        platform,
        timeControl,
        opponentEloBucket,
        cacheDateRange,
        String(pawnMoveFilter),
        pawnStructureMode,
        motifs,
        names,
      ].join("||");
      queryClient.setQueryData(["pawnStructuresResult", key], converted);
      
      setPawnProgress(100);
      // Small delay to show 100% before hiding
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (error) {
      console.error("Error computing pawn structures:", error);
      notifications.show({
        title: t("common.error", { defaultValue: "Error" }),
        message: t("features.dashboard.errorAnalyzingPawns"),
        color: "red",
      });
    } finally {
      setPawnLoading(false);
      setPawnProgress(null);
    }
  };

  const toggleStructureDetails = (structure: PawnStructureStat) => {
    if (expandedStructure === structure.structure) {
      setExpandedStructure(null);
      setExpandedFen(null);
      setGamesPage(1);
      return;
    }
    setExpandedStructure(structure.structure);
    setExpandedFen(structure.sampleFen ?? fallbackFen);
    setGamesPage(1);
  };

  const copyFenToClipboard = (fen: string) => {
    navigator.clipboard.writeText(fen);
    notifications.show({
      title: t("features.dashboard.copied"),
      message: t("features.dashboard.fenCopiedMessage"),
      color: "green",
    });
  };

  const openGameInNewTab = async (gameId: number, fen: string) => {
    if (!databaseFile && !profileId) {
      notifications.show({
        title: t("features.dashboard.gameNotFound"),
        message: t("features.dashboard.gameNotFoundMessage"),
        color: "orange",
      });
      return;
    }

    try {
      // Save the current active tab to restore it later
      const currentActiveTab = activeTab;

      const dbPath = profileId ? await getProfileDbPath(profileId) : (databaseFile ?? null);
      if (!dbPath) {
        notifications.show({
          title: t("features.dashboard.gameNotFound"),
          message: t("features.dashboard.gameNotFoundMessage"),
          color: "orange",
        });
        return;
      }

      // Get the game from the database
      const game = unwrap(await commands.getGame(dbPath, gameId));
      const pgn = createPgnFromNormalizedGame(game);
      const tree = await parsePGN(pgn);
      
      // Normalize FEN for comparison (remove move counters)
      const normalizeFen = (f: string) => f.split(" ").slice(0, 4).join(" ");
      const targetFen = normalizeFen(fen);
      
      // Find the position in the game (only mainline)
      let targetPosition: number[] = [];
      const findPosition = (node: typeof tree.root, path: number[] = []): void => {
        if (normalizeFen(node.fen) === targetFen) {
          targetPosition = path;
          return;
        }
        // Only search mainline (index 0)
        if (node.children && node.children.length > 0) {
          findPosition(node.children[0], [...path, 0]);
        }
      };
      findPosition(tree.root);

      // Create the tab without activating it (autoActivate: false)
      // This ensures we don't change the active tab or navigate away
      await createTab({
        tab: {
          name: `${tree.headers?.white || "White"} - ${tree.headers?.black || "Black"}`,
          type: "analysis",
        },
        setTabs,
        setActiveTab,
        pgn: pgn,
        headers: tree.headers,
        position: targetPosition.length > 0 ? targetPosition : undefined,
        autoActivate: false, // Don't activate the new tab
      });

      // Restore the original active tab to ensure nothing changed
      if (currentActiveTab) {
        // Use requestAnimationFrame to ensure all state updates are complete
        requestAnimationFrame(() => {
          setActiveTab(currentActiveTab);
        });
      }
      
      notifications.show({
        title: t("features.dashboard.gameOpened"),
        message: t("features.dashboard.gameOpenedMessage"),
        color: "green",
      });
    } catch (error) {
      console.error("Error opening game:", error);
      notifications.show({
        title: t("features.dashboard.error"),
        message: t("features.dashboard.errorOpeningGame"),
        color: "red",
      });
    }
  };

  // Show loading only if query is actively loading/fetching
  // Don't show loading if query is enabled but data is not yet available - show the card immediately
  const isAnyLoading = isLoadingPersonalInfo || isFetchingPersonalInfo;

  return (
    <Flex
      h="100%"
      align="stretch"
      direction={isStackedLayout ? "column" : "row"}
      gap="md"
      style={{ minHeight: 0, minWidth: 0 }}
    >
      <Modal
        opened={isStackedLayout && mobileViewedStructure !== null}
        onClose={() => setMobileViewedStructure(null)}
        fullScreen={isStackedLayout}
        title={t("features.dashboard.pawnStructures", { defaultValue: "Pawn structures" })}
        styles={{
          header: {
            paddingTop: "calc(env(safe-area-inset-top, 0px) + var(--mantine-spacing-md))",
          },
          body: {
            paddingTop: "var(--mantine-spacing-md)",
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + var(--mantine-spacing-md))",
          },
        }}
        centered
      >
        {mobileViewedStructure && (
          <Stack gap="md">
            <Box>
              <Group gap="xs" mb="xs">
                <Badge size="sm" variant="light">
                  {t("features.dashboard.structure", { defaultValue: "Structure" })}:
                </Badge>
                <Text size="sm" fw={600}>
                  {mobileViewedStructure.structure}
                </Text>
              </Group>
              <Group gap="xs" align="flex-start">
                <Text size="xs" c="dimmed">
                  FEN:
                </Text>
                <Text size="xs" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                  {mobileViewedStructure.sampleFen ?? fallbackFen}
                </Text>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  onClick={() => copyFenToClipboard(mobileViewedStructure.sampleFen ?? fallbackFen)}
                >
                  <IconCopy size={14} />
                </ActionIcon>
              </Group>
            </Box>

            <Center>
              <Box style={{ width: "min(92vw, 92vmin)", maxWidth: 520 }}>
                <Chessground
                  fen={mobileViewedStructure.sampleFen ?? fallbackFen}
                  coordinates={false}
                  viewOnly
                  orientation={pawnColorFilter === "black" ? "black" : "white"}
                />
              </Box>
            </Center>

            {mobileViewedStructure.games && mobileViewedStructure.games.length > 0 && (
              <Box style={{ minWidth: 0 }}>
                <Text size="sm" fw={600} mb="xs">
                  {t("features.dashboard.games", { defaultValue: "Games" })} ({mobileViewedStructure.games.length})
                </Text>
                <ScrollArea type="auto" offsetScrollbars>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>
                          {t("features.dashboard.playerColor", { defaultValue: "Player color" })} (
                          {t("common.elo", { defaultValue: "Elo" })})
                        </Table.Th>
                        <Table.Th>
                          {t("common.opponent", { defaultValue: "Opponent" })} ({t("common.elo", { defaultValue: "Elo" })}
                          )
                        </Table.Th>
                        <Table.Th>{t("features.dashboard.actions", { defaultValue: "Actions" })}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {mobileViewedStructure.games
                        .slice((gamesPage - 1) * 5, gamesPage * 5)
                        .map((game, idx) => {
                          const isPlayerWhite = matchesName(game.white, playerAccountKeys);
                          const playerElo = isPlayerWhite ? game.whiteElo : game.blackElo;
                          const opponentElo = isPlayerWhite ? game.blackElo : game.whiteElo;
                          const opponentName = isPlayerWhite ? game.black : game.white;

                          return (
                            <Table.Tr key={idx}>
                              <Table.Td>
                                <Text size="xs">
                                  {isPlayerWhite ? t("features.dashboard.white") : t("features.dashboard.black")} ({playerElo || "-"})
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs">
                                  {opponentName || "-"} ({opponentElo || "-"})
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Button
                                  size="xs"
                                  variant="light"
                                  onClick={() => openGameInNewTab(game.gameId ?? 0, game.fen)}
                                  disabled={!game.gameId}
                                >
                                  {t("features.dashboard.openGame", { defaultValue: "Open Game" })}
                                </Button>
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea>
                {mobileViewedStructure.games.length > 5 && (
                  <Group justify="center" mt="md">
                    <Pagination
                      value={gamesPage}
                      onChange={setGamesPage}
                      total={Math.ceil(mobileViewedStructure.games.length / 5)}
                      size="sm"
                    />
                  </Group>
                )}
              </Box>
            )}
          </Stack>
        )}
      </Modal>
      <Box
        style={{
          flex: isStackedLayout ? "0 0 auto" : "0 0 25%",
          width: isStackedLayout ? "100%" : undefined,
          minWidth: isStackedLayout ? 0 : 280,
          minHeight: 0,
        }}
      >
        <Stack h="100%" gap="md" style={{ minHeight: 0 }}>
          <PlayerSidebarCard
            playerName={playerName}
            model={sidebarModel ?? null}
            visiblePlatforms={[...(platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const))]}
            platform={platform}
            onPlatformChange={setPlatform}
            timeControl={timeControl}
            onTimeControlChange={setTimeControl}
            opponentEloOptions={opponentEloOptions}
            opponentEloBucket={opponentEloBucket}
            onOpponentEloChange={setOpponentEloBucket}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            isLoading={isAnyLoading}
            fullHeight={false}
          />

          <Paper
            withBorder
            p={0}
            style={{
              backgroundColor: "var(--mantine-color-dark-6)",
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <ScrollArea type="auto" style={{ flex: 1 }}>
              <Stack gap="sm" p="md">
                <Text size="sm" fw={600}>
                  {t("features.dashboard.pawnFilters", { defaultValue: "Pawn filters" })}
                </Text>

                <Select
                  label={t("features.dashboard.inMove")}
                  data={moveOptions}
                  value={pawnMoveFilter.toString()}
                  onChange={(value) => setPawnMoveFilter(Number.parseInt(value || "10", 10))}
                  size="xs"
                  disabled={pawnLoading}
                />

                <Select
                  label={t("features.dashboard.playerColor")}
                  data={[
                    { value: "white", label: t("features.dashboard.white") },
                    { value: "black", label: t("features.dashboard.black") },
                    { value: "any", label: t("features.dashboard.any") },
                  ]}
                  value={pawnColorFilter}
                  onChange={(value) => setPawnColorFilter((value as "white" | "black" | "any") || "any")}
                  size="xs"
                  disabled={pawnLoading}
                />

                <SegmentedControl
                  value={pawnStructureMode}
                  onChange={(value) => setPawnStructureMode(value as "player" | "both")}
                  data={[
                    { label: t("features.dashboard.playerStructure"), value: "player" },
                    { label: t("features.dashboard.bothStructures"), value: "both" },
                  ]}
                  size="xs"
                  disabled={pawnLoading}
                />

                <MultiSelect
                  label={t("features.dashboard.pawnMotifs", { defaultValue: "Pawn motifs" })}
                  placeholder={t("features.dashboard.pawnMotifsPlaceholder", { defaultValue: "Select motifs..." })}
                  data={motifOptions}
                  value={pawnMotifFilters}
                  onChange={setPawnMotifFilters}
                  searchable
                  clearable
                  size="xs"
                  disabled={pawnLoading}
                />

                <MultiSelect
                  label={t("features.dashboard.pawnStructures", { defaultValue: "Pawn structures" })}
                  placeholder={t("features.dashboard.pawnStructuresPlaceholder", { defaultValue: "Select structures..." })}
                  data={namedStructureOptions}
                  value={pawnNamedStructureFilters}
                  onChange={setPawnNamedStructureFilters}
                  searchable
                  clearable
                  size="xs"
                  disabled={pawnLoading}
                />

                <Button
                  leftSection={<IconSearch size={14} />}
                  onClick={handleSearch}
                  loading={pawnLoading}
                  size="xs"
                  disabled={pawnLoading}
                >
                  {t("features.dashboard.search")}
                </Button>

                {pawnLoading && (
                  <Stack gap="xs">
                    <Group justify="space-between" align="center">
                      <Text size="xs" c="dimmed">
                        {t("features.dashboard.analyzingPawnStructures", { defaultValue: "Analyzing pawn structures..." })}
                      </Text>
                      <Text size="xs" c="dimmed" fw={500}>
                        {pawnProgress !== null ? `${pawnProgress}%` : "0%"}
                      </Text>
                    </Group>
                    <Progress value={pawnProgress ?? 0} size="md" animated={pawnProgress !== null && pawnProgress < 100} />
                  </Stack>
                )}
              </Stack>
            </ScrollArea>
          </Paper>
        </Stack>
      </Box>
      <Box
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Scrollable Content with Table */}
        <Box
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            overflowX: "hidden",
          }}
        >
          <PanelLoadGate
            isLoading={isLoadingPersonalInfo}
            isFetching={isFetchingPersonalInfo}
            hasData={sortedStructures.length > 0}
          >
            <Stack gap="md" p="md" style={{ minHeight: 0 }}>
              {sortedStructures.length > 0 ? (
              <Box>
                <ScrollArea type="auto" offsetScrollbars>
                  <Table>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t("features.dashboard.structure")}</Table.Th>
                      <Table.Th style={{ width: 120, cursor: "pointer" }} onClick={() => setPawnSortBy("frequency")}>
                        {t("features.dashboard.frequency")} {pawnSortBy === "frequency" ? "^" : ""}
                      </Table.Th>
                      <Table.Th style={{ width: 120, cursor: "pointer" }} onClick={() => setPawnSortBy("winRate")}>
                        {t("features.dashboard.winRate")} {pawnSortBy === "winRate" ? "^" : ""}
                      </Table.Th>
                      <Table.Th>{t("features.dashboard.actions")}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sortedStructures.map((structure) => {
                      const displayFen = expandedFen ?? structure.sampleFen ?? fallbackFen;
                      return (
                        <Fragment key={structure.structure}>
                          <Table.Tr>
                            <Table.Td>
                              <Text fw={600}>{structure.structure}</Text>
                            </Table.Td>
                            <Table.Td>{structure.frequency}</Table.Td>
                            <Table.Td>{(structure.winRate * 100).toFixed(1)}%</Table.Td>
                            <Table.Td>
                              <Button
                                size="xs"
                                variant="light"
                                onClick={() => {
                                  if (isStackedLayout) {
                                    setGamesPage(1);
                                    setMobileViewedStructure(structure);
                                  } else {
                                    toggleStructureDetails(structure);
                                  }
                                }}
                              >
                                {expandedStructure === structure.structure ? t("features.dashboard.hide") : t("features.dashboard.view")}
                              </Button>
                            </Table.Td>
                          </Table.Tr>
                          {!isStackedLayout && expandedStructure === structure.structure && (
                            <Table.Tr>
                              <Table.Td colSpan={4}>
                                <Flex
                                  align="flex-start"
                                  direction={isStackedLayout ? "column" : "row"}
                                  gap="md"
                                  style={{ minWidth: 0 }}
                                >
                                  {/* Board Preview */}
                                  <Box
                                    style={{
                                      flex: isStackedLayout ? "0 0 auto" : "0 0 38.2%",
                                      width: isStackedLayout ? "100%" : undefined,
                                      minWidth: 0,
                                    }}
                                  >
                                    <Chessground
                                      fen={displayFen}
                                      coordinates={false}
                                      viewOnly
                                      orientation={pawnColorFilter === "black" ? "black" : "white"}
                                    />
                                  </Box>
                                  
                                  {/* Right Section */}
                                  <Box style={{ flex: 1, minWidth: 0, width: isStackedLayout ? "100%" : undefined }}>
                                    <Stack gap="md">
                                      {/* Structure Info with FEN */}
                                      <Box>
                                        <Group gap="xs" mb="xs">
                                          <Badge size="sm" variant="light">
                                            {t("features.dashboard.structure")}:
                                          </Badge>
                                          <Text size="sm" fw={500}>{structure.structure}</Text>
                                        </Group>
                                        <Group gap="xs">
                                          <Text size="xs" c="dimmed">FEN:</Text>
                                          <Text size="xs" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
                                            {displayFen}
                                          </Text>
                                          <ActionIcon
                                            size="sm"
                                            variant="subtle"
                                            onClick={() => copyFenToClipboard(displayFen)}
                                          >
                                            <IconCopy size={14} />
                                          </ActionIcon>
                                        </Group>
                                      </Box>

                                      {/* Games Table */}
                                      {structure.games && structure.games.length > 0 && (
                                        <Box style={{ minWidth: 0 }}>
                                          <Text size="sm" fw={600} mb="xs">
                                            {t("features.dashboard.games", { defaultValue: "Games" })} ({structure.games.length})
                                          </Text>
                                          <ScrollArea type="auto" offsetScrollbars>
                                            <Table striped highlightOnHover>
                                            <Table.Thead>
                                              <Table.Tr>
                                                <Table.Th>{t("features.dashboard.playerColor", { defaultValue: "Player color" })} ({t("common.elo", { defaultValue: "Elo" })})</Table.Th>
                                                <Table.Th>{t("common.opponent", { defaultValue: "Opponent" })} ({t("common.elo", { defaultValue: "Elo" })})</Table.Th>
                                                <Table.Th>{t("features.dashboard.actions", { defaultValue: "Actions" })}</Table.Th>
                                              </Table.Tr>
                                            </Table.Thead>
                                            <Table.Tbody>
                                              {structure.games
                                                .slice((gamesPage - 1) * 5, gamesPage * 5)
                                                .map((game, idx) => {
                                                  const isPlayerWhite = matchesName(game.white, playerAccountKeys);
                                                  const playerElo = isPlayerWhite ? game.whiteElo : game.blackElo;
                                                  const opponentElo = isPlayerWhite ? game.blackElo : game.whiteElo;
                                                  const opponentName = isPlayerWhite ? game.black : game.white;
                                                  
                                                  return (
                                                    <Table.Tr key={idx}>
                                                      <Table.Td>
                                                        <Text size="xs">
                                                          {isPlayerWhite ? t("features.dashboard.white") : t("features.dashboard.black")} ({playerElo || "-"})
                                                        </Text>
                                                      </Table.Td>
                                                      <Table.Td>
                                                        <Text size="xs">{opponentName || "-"} ({opponentElo || "-"})</Text>
                                                      </Table.Td>
                                                      <Table.Td>
                                                        <Button
                                                          size="xs"
                                                          variant="light"
                                                          onClick={() => openGameInNewTab(game.gameId ?? 0, game.fen)}
                                                          disabled={!game.gameId}
                                                        >
                                                          {t("features.dashboard.openGame", { defaultValue: "Open Game" })}
                                                        </Button>
                                                      </Table.Td>
                                                    </Table.Tr>
                                                  );
                                                })}
                                            </Table.Tbody>
                                            </Table>
                                          </ScrollArea>
                                          {structure.games.length > 5 && (
                                            <Group justify="center" mt="md">
                                              <Pagination
                                                value={gamesPage}
                                                onChange={setGamesPage}
                                                total={Math.ceil(structure.games.length / 5)}
                                                size="sm"
                                              />
                                            </Group>
                                          )}
                                        </Box>
                                      )}
                                    </Stack>
                                  </Box>
                                </Flex>
                              </Table.Td>
                            </Table.Tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Table.Tbody>
                  </Table>
                </ScrollArea>
              </Box>
            ) : (
              <Text size="sm" c="dimmed" p="md">
                {t("features.dashboard.noPawnStructuresHint")}
              </Text>
              )}
            </Stack>
          </PanelLoadGate>
        </Box>
      </Box>
    </Flex>
  );
}

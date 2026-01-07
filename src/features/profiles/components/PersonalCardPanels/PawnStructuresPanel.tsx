import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
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
import { IconCopy, IconSearch } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useAtom, useAtomValue } from "jotai";
import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NormalizedGame, PlayerGameInfo, SiteStatsData } from "@/bindings";
import { commands } from "@/bindings";
import { Chessground } from "@/components/Chessground";
import PlayerSidebarCard, {
  normalizePlatform,
  type PlatformFilter,
  type TimeControlFilter,
} from "@/features/profiles/components/PersonalCardPanels/PlayerSidebarCard";
import { DateRange } from "@/features/profiles/components/PersonalCardPanels/DateRangeTabs";
import { PanelLoadGate } from "@/features/profiles/components/PersonalCardPanels/PanelLoadGate";
import { activeTabAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import { parsePGN } from "@/utils/chess";
import { query_players } from "@/utils/db";
import type { PawnStructureStat as PawnStructureStatBackend, PawnStructureGame as PawnStructureGameBackend } from "@/bindings";
import { getProfileDbPath } from "@/utils/profileDb";
import { createTab } from "@/utils/tabs";
import { unwrap } from "@/utils/unwrap";
import { getTimeControl } from "@/utils/timeControl";

type PawnStructuresPanelProps = {
  playerName: string;
  databaseFile?: string;
  profileId?: string;
};

const fallbackFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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

function calculateEarliestDate(dateRange: DateRange, ratingDates: number[]): number {
  const lastDate = ratingDates[ratingDates.length - 1];
  switch (dateRange) {
    case DateRange.SevenDays:
      return lastDate - 7 * MILLISECONDS_PER_DAY;
    case DateRange.ThirtyDays:
      return lastDate - 30 * MILLISECONDS_PER_DAY;
    case DateRange.NinetyDays:
      return lastDate - 90 * MILLISECONDS_PER_DAY;
    case DateRange.OneYear:
      return lastDate - 365 * MILLISECONDS_PER_DAY;
    default:
      return Math.min(...ratingDates);
  }
}

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

  const [pawnMoveFilter, setPawnMoveFilter] = useState(10);
  const [pawnColorFilter, setPawnColorFilter] = useState<"white" | "black" | "any">("white");
  const [pawnStructureMode, setPawnStructureMode] = useState<"player" | "both">("player");
  const [pawnMotifFilters, setPawnMotifFilters] = useState<string[]>([]);
  const [pawnNamedStructureFilters, setPawnNamedStructureFilters] = useState<string[]>([]);
  const [pawnStructures, setPawnStructures] = useState<PawnStructureStat[]>([]);
  const [pawnSortBy, setPawnSortBy] = useState<"frequency" | "winRate">("frequency");
  const [pawnLoading, setPawnLoading] = useState(false);
  const [pawnProgress, setPawnProgress] = useState<number | null>(null);
  const [expandedStructure, setExpandedStructure] = useState<string | null>(null);
  const [expandedFen, setExpandedFen] = useState<string | null>(null);
  const [gamesPage, setGamesPage] = useState(1);
  const [, setTabs] = useAtom(tabsAtom);
  const [activeTab, setActiveTab] = useAtom(activeTabAtom);
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [timeControl, setTimeControl] = useState<TimeControlFilter>("any");
  const [opponentEloBucket, setOpponentEloBucket] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange | null>(DateRange.NinetyDays);
  const sessions = useAtomValue(sessionsAtom);

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

  const sortedStructures = [...pawnStructures].sort((a, b) =>
    pawnSortBy === "frequency" ? b.frequency - a.frequency : b.winRate - a.winRate,
  );

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

  const { data: personalInfo, isLoading: isLoadingPersonalInfo, isFetching: isFetchingPersonalInfo } = useQuery({
    queryKey: [
      "pawnStructuresInfo",
      profileId,
      playerSessions.map((session) => session.lichess?.username ?? session.chessCom?.username).join("|"),
    ],
    queryFn: async () => {
      if (!profileId || playerSessions.length === 0) return [];
      const dbPath = await getProfileDbPath(profileId);
      const results = await Promise.allSettled(
        playerSessions.map(async (session) => {
          const accountKey = session.lichess
            ? getAccountKey("lichess", session.lichess.username)
            : session.chessCom
              ? getAccountKey("chesscom", session.chessCom.username)
              : null;
          if (!accountKey) throw new Error("Session does not have an account key");

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
          if (!player) throw new Error("Player not found in database");

          const info = unwrap(await commands.getPlayersGameInfo(dbPath, player.id));
          return info;
        }),
      );

      return results
        .filter((r) => r.status === "fulfilled")
        .map((r) => (r as PromiseFulfilledResult<PlayerGameInfo>).value);
    },
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled: !!profileId && playerSessions.length > 0,
  });

  const mergedInfo = useMemo<PlayerGameInfo | null>(() => {
    if (!personalInfo || personalInfo.length === 0) return null;
    const mergedSiteStatsData: SiteStatsData[] = [];
    const byKey = new Map<string, SiteStatsData>();

    for (const entry of personalInfo.flatMap((info) => info.site_stats_data)) {
      const key = `${entry.site}:${entry.player}`;
      const existing = byKey.get(key);
      if (!existing) {
        const next: SiteStatsData = { site: entry.site, player: entry.player, data: [...entry.data] };
        byKey.set(key, next);
        mergedSiteStatsData.push(next);
        continue;
      }
      existing.data.push(...entry.data);
    }

    return { site_stats_data: mergedSiteStatsData };
  }, [personalInfo]);

  const playerInfo = mergedInfo ?? { site_stats_data: [] };

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

  const dates = useMemo(() => {
    const gameDates =
      playerInfo.site_stats_data
        ?.filter((games) => platform === "all" || normalizePlatform(games.site) === platform)
        .flatMap((games) =>
          games.data
            .filter((game) => {
              if (timeControl === "any") return true;
              if (typeof game.time_control !== "string" || !game.time_control) return false;
              return getTimeControl(games.site, game.time_control) === timeControl;
            })
            .map((game) => {
              if (!game.date) return null;
              return new Date(game.date.replaceAll(".", "-")).getTime();
            }),
        )
        .filter((date): date is number => Number.isFinite(date)) ?? [];

    return Array.from(new Set(gameDates)).sort((a, b) => a - b);
  }, [playerInfo.site_stats_data, platform, timeControl]);

  const handleSearch = async () => {
    // Keep the source of truth consistent with the other profile tabs:
    // if we have a profileId, always use getProfileDbPath(profileId).
    const dbPath = profileId ? await getProfileDbPath(profileId) : (databaseFile ?? null);

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
    setPawnStructures([]);

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
      const earliestDate = dateRange && dates.length > 0 ? calculateEarliestDate(dateRange, dates) : undefined;
      
      // Prepare parameters for the command
      const params: any = {
        playerIds: Array.from(playerIds),
        colorFilter: pawnColorFilter,
        platformFilter: platform,
        timeControlFilter: timeControl,
        opponentEloBucket: opponentEloBucket,
        earliestDate: earliestDate ? new Date(earliestDate).toISOString().split("T")[0] : null,
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

      // Convert Rust types (snake_case) to frontend types (camelCase)
      setPawnStructures(
        structures.map((s: PawnStructureStatBackend): PawnStructureStat => ({
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
        }))
      );
      
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
    <Group h="100%" align="stretch" wrap="nowrap" gap="md" style={{ minHeight: 0, minWidth: 0 }}>
      <Box style={{ flex: "0 0 25%", minWidth: 280, minHeight: 0 }}>
        <Stack h="100%" gap="md" style={{ minHeight: 0 }}>
          <PlayerSidebarCard
            playerName={playerName}
            info={playerInfo}
            platform={platform}
            onPlatformChange={setPlatform}
            timeControl={timeControl}
            onTimeControlChange={setTimeControl}
            opponentEloOptions={opponentEloOptions}
            opponentEloBucket={opponentEloBucket}
            onOpponentEloChange={setOpponentEloBucket}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            profileId={profileId}
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
      <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {/* Scrollable Content with Table */}
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
          <PanelLoadGate
            isLoading={isLoadingPersonalInfo}
            isFetching={isFetchingPersonalInfo}
            hasData={sortedStructures.length > 0}
          >
            <Stack gap="md" p="md" style={{ minHeight: 0 }}>
              {sortedStructures.length > 0 ? (
              <Box>
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
                              <Button size="xs" variant="light" onClick={() => toggleStructureDetails(structure)}>
                                {expandedStructure === structure.structure
                                  ? t("features.dashboard.hide")
                                  : t("features.dashboard.view")}
                              </Button>
                            </Table.Td>
                          </Table.Tr>
                          {expandedStructure === structure.structure && (
                            <Table.Tr>
                              <Table.Td colSpan={4}>
                                <Group align="flex-start" gap="md" wrap="nowrap">
                                  {/* Board Preview - 38.20% */}
                                  <Box style={{ flex: "0 0 38.2%", minWidth: 0 }}>
                                    <Chessground
                                      fen={displayFen}
                                      coordinates={false}
                                      viewOnly
                                      orientation={pawnColorFilter === "black" ? "black" : "white"}
                                    />
                                  </Box>
                                  
                                  {/* Right Section - 61.8% */}
                                  <Box style={{ flex: 1, minWidth: 0 }}>
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
                                        <Box>
                                          <Text size="sm" fw={600} mb="xs">
                                            {t("features.dashboard.games", { defaultValue: "Games" })} ({structure.games.length})
                                          </Text>
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
                                </Group>
                              </Table.Td>
                            </Table.Tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Table.Tbody>
                </Table>
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
    </Group>
  );
}

import {
  ActionIcon,
  Autocomplete,
  Avatar,
  Badge,
  Box,
  Button,
  Group,
  Loader,
  Menu,
  Pagination,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconChess,
  IconChevronDown,
  IconExternalLink,
  IconSortAscending,
  IconSortDescending,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Event } from "@/bindings";
import { AnalysisPreview } from "@/components/AnalysisPreview";
import { stripAccountKey } from "@/utils/accountKeys";
import { getChesscomGame } from "@/utils/chess.com/api";
import type { FavoriteGame } from "@/utils/favoriteGames";
import type { GameRecord } from "@/utils/gameRecords";
import { getLichessGame } from "@/utils/lichess/api";
import type { ChessComGameWithEvent, DashboardLichessGame, TimeControlCategory } from "../types";
import { formatRelativeTimeAgo } from "../utils/relativeTime";

type GamesHistoryKind = "local" | "chesscom" | "lichess" | "chessbase";

type GamesHistoryRow = {
  kind: GamesHistoryKind;
  gameKey: string;
  analysisGameId: string;
  externalUrl: string | null;
  opponent: string;
  color: "white" | "black";
  outcome: "win" | "loss" | "draw" | "unknown";
  pgn: string | null;
  accuracy: number | null;
  acpl: number | null;
  estimatedElo: number | null;
  moves: number;
  timeControl: string | null;
  timeControlCategory: TimeControlCategory | null;
  timestampMs: number;
  eventId: number | null;
  eventName: string | null;
  isAnalyzed: boolean;
};

type GamesHistoryResponse = {
  rows: GamesHistoryRow[];
  totalCount: number;
};

function isFavorite(favorites: FavoriteGame[], source: FavoriteGame["source"], id: string) {
  return favorites.some((f) => f.source === source && f.gameId === id);
}

const TIME_CONTROL_TAG_REGEX = /\[TimeControl\s+"([^"]+)"\]/i;
const INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const _getTimeControlFromPgn = (pgn?: string | null): string | null => {
  if (!pgn) return null;
  const match = pgn.match(TIME_CONTROL_TAG_REGEX);
  return match?.[1] ?? null;
};

const _getTagFromPgn = (pgn: string, tag: string): string | null => {
  const re = new RegExp(`\\[${tag}\\s+\\"([^\\"]+)\\"\\]`, "i");
  const m = pgn.match(re);
  return m?.[1] ? m[1] : null;
};

const _hasPgnHeaders = (pgn?: string | null): boolean => {
  if (!pgn) return false;
  return /\[[A-Za-z0-9_]+\s+"[^"]*"\]/.test(pgn);
};

const _getResultFromPgn = (pgn: string): string | null => _getTagFromPgn(pgn, "Result");

const _winnerFromResult = (result: string | null | undefined): "white" | "black" | undefined => {
  const r = (result ?? "").trim();
  if (r === "1-0") return "white";
  if (r === "0-1") return "black";
  return undefined;
};

const _chessComResultsFromPgn = (pgn: string): { white: string; black: string } => {
  const r = (_getResultFromPgn(pgn) ?? "").trim();
  if (r === "1-0") return { white: "win", black: "checkmated" };
  if (r === "0-1") return { white: "checkmated", black: "win" };
  if (r === "1/2-1/2") return { white: "agreed", black: "agreed" };
  return { white: "referred", black: "referred" };
};

function getTimeControlLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  value: TimeControlCategory,
) {
  switch (value) {
    case "ultra_bullet":
      return t("chess.timeControl.ultraBullet", { defaultValue: "UltraBullet" });
    case "bullet":
      return t("chess.timeControl.bullet", { defaultValue: "Bullet" });
    case "blitz":
      return t("chess.timeControl.blitz", { defaultValue: "Blitz" });
    case "rapid":
      return t("chess.timeControl.rapid", { defaultValue: "Rapid" });
    case "classical":
      return t("chess.timeControl.classical", { defaultValue: "Classical" });
    case "correspondence":
      return t("chess.timeControl.correspondence", { defaultValue: "Correspondence" });
    case "daily":
      return t("chess.timeControl.daily", { defaultValue: "Daily" });
  }
}

export function ProfileGamesTab({
  profileId,
  selectedOpponentId,
  gameHistoryLimit,
  localGames,
  chessComGames,
  lichessGames,
  profileUsernames,
  isLoadingOnline = false,
  onAnalyzeLocalGame,
  onAnalyzeChessComGame,
  onAnalyzeLichessGame,
  onDeleteLocalGame,
  onToggleFavoriteLocal,
  onToggleFavoriteChessCom,
  onToggleFavoriteLichess,
  onAnalyzeAll,
  favoriteGames = [],
  eventFilterId,
  onEventFilterChange,
  eventOptions,
  isLoadingEventOptions = false,
  onEventSearchChange,
  eventSearchValue,
  profileDbPath,
  onOpponentSelected,
  timeControlCategory,
  onTimeControlCategoryChange,
}: {
  profileId: string | null;
  selectedOpponentId: number | null;
  gameHistoryLimit: number;
  localGames: GameRecord[];
  chessComGames: ChessComGameWithEvent[];
  lichessGames: DashboardLichessGame[];
  profileUsernames: string[];
  isLoadingOnline?: boolean;
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGameWithEvent, meta?: { profileId: string; profileDbGameId: string }) => void;
  onAnalyzeLichessGame: (game: DashboardLichessGame, meta?: { profileId: string; profileDbGameId: string }) => void;
  onDeleteLocalGame?: (gameId: string) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
  onAnalyzeAll?: (payload: {
    type: "local" | "chesscom" | "lichess" | "chessbase" | "all";
    opponentContains: string | null;
    resultFilter: string | null;
  }) => void;
  favoriteGames?: FavoriteGame[];
  eventFilterId: number | null;
  onEventFilterChange: (eventId: number | null) => void;
  eventOptions: Event[];
  isLoadingEventOptions?: boolean;
  onEventSearchChange: (value: string) => void;
  eventSearchValue: string;
  profileDbPath: string | null;
  onOpponentSelected: (opponentName: string | null) => void;
  timeControlCategory: TimeControlCategory | null;
  onTimeControlCategoryChange: (category: TimeControlCategory | null) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 48em)");

  const [rows, setRows] = useState<GamesHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const itemsPerPage = Math.max(1, gameHistoryLimit);
  const [_refreshTick, setRefreshTick] = useState(0);
  const [sortBy, setSortBy] = useState<"elo" | "date" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [opponentFilter, setOpponentFilter] = useState("");
  const [resultFilter, setResultFilter] = useState<string | null>(null);
  const [opponentOptions, setOpponentOptions] = useState<string[]>([]);
  const [isLoadingOpponentOptions, setIsLoadingOpponentOptions] = useState(false);
  const [debouncedOpponentFilter] = useDebouncedValue(opponentFilter, 250);
  const selectedOpponentRef = useRef<string | null>(null);
  const [analyzeAllTypeCounts, setAnalyzeAllTypeCounts] = useState<{
    all: number;
    local: number;
    chesscom: number;
    lichess: number;
    chessbase: number;
  } | null>(null);

  useEffect(() => {
    const query = debouncedOpponentFilter.trim();
    if (!profileId || query.length < 3) {
      setOpponentOptions([]);
      setIsLoadingOpponentOptions(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setIsLoadingOpponentOptions(true);
      try {
        const options =
          (await invoke<string[]>("dashboard_search_profile_opponents", {
            profileId,
            query,
            profileUsernames,
          })) ?? [];
        if (!cancelled) {
          setOpponentOptions(options);
        }
      } catch {
        if (!cancelled) setOpponentOptions([]);
      } finally {
        if (!cancelled) setIsLoadingOpponentOptions(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [debouncedOpponentFilter, profileId, profileUsernames]);

  useEffect(() => {
    const onRefresh = () => setRefreshTick((v) => v + 1);
    const events = [
      "dashboard:games-history:refresh",
      "games:updated",
      "chesscom:games:updated",
      "lichess:games:updated",
    ] as const;
    for (const eventName of events) {
      window.addEventListener(eventName, onRefresh);
    }
    return () => {
      for (const eventName of events) {
        window.removeEventListener(eventName, onRefresh);
      }
    };
  }, []);

  useEffect(() => {
    // If the visible limit changes, restart from page 1 so the table reflects the new amount immediately.
    setPage(1);
  }, []);

  useEffect(() => {
    // Filters can shrink the result set; keep pagination on a valid page.
    setPage(1);
  }, []);

  useEffect(() => {
    if (!profileId) {
      setRows([]);
      setTotalCount(0);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const res = (await invoke<GamesHistoryResponse>("dashboard_get_games_history_rows", {
        req: {
          profileId,
          profileUsernames,
          gameHistoryLimit,
          page,
          pageSize: itemsPerPage,
          eventFilterId,
          selectedOpponentId,
          opponentContains: debouncedOpponentFilter.trim() || null,
          timeControlCategory,
          resultFilter,
          sortBy: sortBy ?? "date",
          sortDirection,
        },
      })) ?? { rows: [], totalCount: 0 };

      if (cancelled) return;
      setRows(res.rows ?? []);
      setTotalCount(res.totalCount ?? 0);
    };
    void run().catch(() => {
      if (!cancelled) {
        setRows([]);
        setTotalCount(0);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    profileId,
    profileUsernames,
    gameHistoryLimit,
    page,
    eventFilterId,
    debouncedOpponentFilter,
    timeControlCategory,
    resultFilter,
    sortBy,
    sortDirection,
    selectedOpponentId,
    itemsPerPage,
  ]);

  useEffect(() => {
    if (!profileId) {
      setAnalyzeAllTypeCounts(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      try {
        const targets = ["all", "local", "chesscom", "lichess", "chessbase"] as const;
        const responses = await Promise.all(
          targets.map((target) =>
            invoke<{ total: number }>("dashboard_get_analyze_all_counts", {
              req: {
                profileId,
                profileUsernames,
                gameHistoryLimit,
                eventFilterId,
                selectedOpponentId,
                timeControlCategory,
                target,
              },
            }),
          ),
        );

        if (cancelled) return;
        setAnalyzeAllTypeCounts({
          all: Math.max(0, responses[0]?.total ?? 0),
          local: Math.max(0, responses[1]?.total ?? 0),
          chesscom: Math.max(0, responses[2]?.total ?? 0),
          lichess: Math.max(0, responses[3]?.total ?? 0),
          chessbase: Math.max(0, responses[4]?.total ?? 0),
        });
      } catch {
        if (!cancelled) {
          setAnalyzeAllTypeCounts(null);
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [profileId, profileUsernames, gameHistoryLimit, eventFilterId, selectedOpponentId, timeControlCategory]);

  const handleSort = (field: "elo" | "date") => {
    if (sortBy === field) setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    else {
      setSortBy(field);
      setSortDirection("desc");
    }
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / itemsPerPage));
  const hasActiveFilters =
    eventFilterId != null ||
    selectedOpponentId != null ||
    opponentFilter.trim().length > 0 ||
    resultFilter != null ||
    timeControlCategory != null;
  const now = useMemo(() => Date.now(), []);
  const stickyFooterCellStyle = useMemo(
    () => ({
      position: "sticky" as const,
      bottom: 0,
      zIndex: 3,
      background: "var(--mantine-color-body)",
      borderTop: "1px solid var(--mantine-color-default-border)",
    }),
    [],
  );
  const stickyFooterLabelCellStyle = useMemo(
    () => ({
      ...stickyFooterCellStyle,
      zIndex: 4,
    }),
    [stickyFooterCellStyle],
  );
  const averageStats = useMemo(() => {
    const accuracyValues = rows
      .map((row) => row.accuracy)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const acplValues = rows
      .map((row) => row.acpl)
      .filter((value): value is number => typeof value === "number" && value > 0);
    const estimatedEloValues = rows
      .map((row) => row.estimatedElo)
      .filter((value): value is number => typeof value === "number" && value > 0);

    const average = (values: number[]) => {
      if (values.length === 0) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    return {
      accuracy: average(accuracyValues),
      acpl: average(acplValues),
      estimatedElo: average(estimatedEloValues),
    };
  }, [rows]);
  const analyzeAllOptions = useMemo(() => {
    const total = analyzeAllTypeCounts?.all ?? localGames.length + chessComGames.length + lichessGames.length;
    const localCount = analyzeAllTypeCounts?.local ?? localGames.length;
    const chesscomCount = analyzeAllTypeCounts?.chesscom ?? chessComGames.length;
    const lichessCount = analyzeAllTypeCounts?.lichess ?? lichessGames.length;
    const chessbaseCount =
      analyzeAllTypeCounts?.chessbase ??
      Math.max(0, totalCount - (localGames.length + chessComGames.length + lichessGames.length));
    return [
      { type: "all" as const, label: "All", count: total },
      { type: "local" as const, label: "Local", count: localCount },
      { type: "chesscom" as const, label: "Chess.com", count: chesscomCount },
      { type: "lichess" as const, label: "Lichess", count: lichessCount },
      { type: "chessbase" as const, label: t("chessbase.title"), count: chessbaseCount },
    ];
  }, [analyzeAllTypeCounts, localGames.length, chessComGames.length, lichessGames.length, t, totalCount]);

  const handleOpenGame = async (url: string | null) => {
    if (!url) return;
    try {
      await openUrl(url, "inAppBrowser");
      return;
    } catch {}

    try {
      await openUrl(url);
      return;
    } catch {}

    try {
      await openPath(url);
      return;
    } catch {}

    try {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    } catch {}

    notifications.show({
      title: t("features.dashboard.openGameFailedTitle", "Could not open game"),
      message: t("features.dashboard.openGameFailedMessage", "Failed to open the game link. Please try again."),
      color: "red",
    });
  };

  const handleAnalyzeRow = async (row: GamesHistoryRow, pgn: string | null) => {
    const profileDisplayName = (profileUsernames?.[0] ?? "").trim() || t("common.player", { defaultValue: "Player" });
    const inferredWhite = row.color === "white" ? profileDisplayName : row.opponent;
    const inferredBlack = row.color === "white" ? row.opponent : profileDisplayName;

    if (row.kind === "local") {
      const g = localGames.find((x) => x.id === row.gameKey);
      if (g) onAnalyzeLocalGame(g);
      return;
    }

    if (row.kind === "chesscom") {
      const existing = chessComGames.find((x) => x.url === row.gameKey);
      if (existing?.pgn && _hasPgnHeaders(existing.pgn)) {
        if (profileId) onAnalyzeChessComGame(existing, { profileId, profileDbGameId: row.analysisGameId });
        else onAnalyzeChessComGame(existing);
        return;
      }

      const url = row.externalUrl || row.gameKey;
      const fetched =
        ((await getChesscomGame(url)) ?? "").trim() || (pgn?.trim() ?? "") || (existing?.pgn?.trim() ?? "");
      if (!fetched) {
        if (existing) {
          if (profileId) onAnalyzeChessComGame(existing, { profileId, profileDbGameId: row.analysisGameId });
          else onAnalyzeChessComGame(existing);
        }
        return;
      }

      const whiteFromPgn = (_getTagFromPgn(fetched, "White") ?? "").trim();
      const blackFromPgn = (_getTagFromPgn(fetched, "Black") ?? "").trim();
      const white = whiteFromPgn && whiteFromPgn !== "?" ? whiteFromPgn : inferredWhite;
      const black = blackFromPgn && blackFromPgn !== "?" ? blackFromPgn : inferredBlack;
      const tc = _getTimeControlFromPgn(fetched) ?? row.timeControl ?? "";
      const results = _chessComResultsFromPgn(fetched);
      const initialFen = _getTagFromPgn(fetched, "FEN") ?? INITIAL_FEN;

      const stub: ChessComGameWithEvent = {
        url,
        pgn: fetched,
        time_control: tc,
        end_time: Math.floor(row.timestampMs / 1000),
        rated: true,
        initial_setup: initialFen,
        fen: initialFen,
        rules: "chess",
        white: { rating: 0, result: results.white, username: stripAccountKey(white) },
        black: { rating: 0, result: results.black, username: stripAccountKey(black) },
        eventId: row.eventId ?? 0,
        eventName: row.eventName ?? null,
      };

      if (profileId) onAnalyzeChessComGame(stub, { profileId, profileDbGameId: row.analysisGameId });
      else onAnalyzeChessComGame(stub);
      return;
    }

    if (row.kind === "chessbase") {
      const fetched = pgn?.trim() ? pgn : "";
      if (!fetched) return;

      const whiteFromPgn = (_getTagFromPgn(fetched, "White") ?? "").trim();
      const blackFromPgn = (_getTagFromPgn(fetched, "Black") ?? "").trim();
      const white = whiteFromPgn && whiteFromPgn !== "?" ? whiteFromPgn : inferredWhite;
      const black = blackFromPgn && blackFromPgn !== "?" ? blackFromPgn : inferredBlack;
      const timeControl = _getTimeControlFromPgn(fetched) ?? row.timeControl ?? null;
      const winner = _winnerFromResult(_getResultFromPgn(fetched));
      const fen = _getTagFromPgn(fetched, "FEN") ?? INITIAL_FEN;

      const stub: DashboardLichessGame = {
        id: `chessbase:${row.analysisGameId}`,
        players: {
          white: { user: { name: stripAccountKey(white) } },
          black: { user: { name: stripAccountKey(black) } },
        },
        speed: row.timeControlCategory
          ? getTimeControlLabel(t, row.timeControlCategory)
          : t("chess.timeControl.rapid", { defaultValue: "Rapid" }),
        timeControl,
        createdAt: row.timestampMs,
        winner,
        status: "finished",
        pgn: fetched,
        lastFen: fen,
        eventId: row.eventId ?? 0,
        eventName: row.eventName ?? null,
      };

      if (profileId) onAnalyzeLichessGame(stub, { profileId, profileDbGameId: row.analysisGameId });
      else onAnalyzeLichessGame(stub);
      return;
    }

    // Lichess
    const existing = lichessGames.find((x) => x.id === row.gameKey);
    if (existing?.pgn && _hasPgnHeaders(existing.pgn)) {
      if (profileId) onAnalyzeLichessGame(existing, { profileId, profileDbGameId: row.analysisGameId });
      else onAnalyzeLichessGame(existing);
      return;
    }

    const gameId = row.gameKey;
    const fetched =
      ((await getLichessGame(gameId)) ?? "").trim() || (pgn?.trim() ?? "") || (existing?.pgn?.trim() ?? "");
    if (!fetched) {
      if (existing) {
        if (profileId) onAnalyzeLichessGame(existing, { profileId, profileDbGameId: row.analysisGameId });
        else onAnalyzeLichessGame(existing);
      }
      return;
    }

    const whiteFromPgn = (_getTagFromPgn(fetched, "White") ?? "").trim();
    const blackFromPgn = (_getTagFromPgn(fetched, "Black") ?? "").trim();
    const white = whiteFromPgn && whiteFromPgn !== "?" ? whiteFromPgn : inferredWhite;
    const black = blackFromPgn && blackFromPgn !== "?" ? blackFromPgn : inferredBlack;
    const timeControl = _getTimeControlFromPgn(fetched) ?? row.timeControl ?? null;
    const winner = _winnerFromResult(_getResultFromPgn(fetched));
    const fen = _getTagFromPgn(fetched, "FEN") ?? INITIAL_FEN;

    const stub: DashboardLichessGame = {
      id: gameId,
      players: {
        white: { user: { name: stripAccountKey(white) } },
        black: { user: { name: stripAccountKey(black) } },
      },
      speed: row.timeControlCategory
        ? getTimeControlLabel(t, row.timeControlCategory)
        : t("chess.timeControl.rapid", { defaultValue: "Rapid" }),
      timeControl,
      createdAt: row.timestampMs,
      winner,
      status: "finished",
      pgn: fetched,
      lastFen: fen,
      eventId: row.eventId ?? 0,
      eventName: row.eventName ?? null,
    };

    if (profileId) onAnalyzeLichessGame(stub, { profileId, profileDbGameId: row.analysisGameId });
    else onAnalyzeLichessGame(stub);
  };

  // Favorite toggling & analyzed detection are handled per-row using backend-provided fields.

  if (isLoadingOnline) {
    return (
      <Stack gap="xs" align="center" justify="center" style={{ minHeight: "200px" }}>
        <Loader size="md" />
        <Text size="sm" c="dimmed">
          {t("common.loading", { defaultValue: "Loading..." })}
        </Text>
      </Stack>
    );
  }

  if (!profileId) {
    return (
      <Stack align="center" justify="center" style={{ flex: 1, minHeight: 200 }}>
        <Text c="dimmed">{t("features.dashboard.noGames") || "No games yet"}</Text>
      </Stack>
    );
  }
  return (
    <Stack
      gap="xs"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        minHeight: 0,
        ...(isMobile && { minHeight: "650px" }),
      }}
    >
      <Group gap="xs">
        <Select
          placeholder={t("features.dashboard.filterByEvent", "Filter by event")}
          value={eventFilterId != null ? String(eventFilterId) : undefined}
          onChange={(value) => onEventFilterChange(value ? Number(value) : null)}
          data={[...eventOptions]
            .sort((a, b) => {
              // Sort by date (most recent first)
              // Use end_date if available, otherwise start_date
              const getDate = (event: Event): string | null => {
                return event.end_date || event.start_date || null;
              };

              const dateA = getDate(a);
              const dateB = getDate(b);

              // Events with dates come first
              if (dateA && !dateB) return -1;
              if (!dateA && dateB) return 1;

              // Both have dates: compare (descending - most recent first)
              if (dateA && dateB) {
                return dateB.localeCompare(dateA);
              }

              // Neither has date: sort by ID (descending - most recent first)
              return b.id - a.id;
            })
            .map((event) => ({
              value: String(event.id),
              label: `#${event.id} - ${(event.name ?? "").trim() || t("features.dashboard.unnamedEvent", "Unnamed event")}`,
            }))}
          searchable
          clearable
          size="sm"
          maxDropdownHeight={240}
          nothingFoundMessage={t("features.dashboard.noEventsMatch", "No events match")}
          rightSection={isLoadingEventOptions ? <Loader size="xs" /> : undefined}
          searchValue={eventSearchValue}
          onSearchChange={onEventSearchChange}
          style={{ minWidth: 200, maxWidth: 280 }}
        />
        <Autocomplete
          placeholder={t("features.dashboard.filterByOpponent", "Filter by opponent")}
          value={opponentFilter}
          onChange={(value) => {
            setOpponentFilter(value);
            const trimmed = value.trim();
            if (!trimmed) {
              selectedOpponentRef.current = null;
              onOpponentSelected(null);
              return;
            }

            if (selectedOpponentRef.current && trimmed !== selectedOpponentRef.current) {
              selectedOpponentRef.current = null;
              onOpponentSelected(null);
            }
          }}
          onBlur={() => {
            const trimmed = opponentFilter.trim();
            if (!trimmed) {
              selectedOpponentRef.current = null;
              onOpponentSelected(null);
              return;
            }
            if (trimmed.length < 3) return;
            if ((selectedOpponentRef.current ?? "").toLowerCase() === trimmed.toLowerCase()) return;

            const exact = opponentOptions.find((o) => o.toLowerCase() === trimmed.toLowerCase());
            if (!exact) {
              selectedOpponentRef.current = trimmed;
              onOpponentSelected(trimmed);
              return;
            }

            selectedOpponentRef.current = exact;
            setOpponentFilter(exact);
            onOpponentSelected(exact);
          }}
          onOptionSubmit={(value) => {
            selectedOpponentRef.current = value.trim() || null;
            setOpponentFilter(value);
            onOpponentSelected(value);
          }}
          data={opponentOptions}
          limit={25}
          maxDropdownHeight={240}
          rightSection={isLoadingOpponentOptions ? <Loader size="xs" /> : undefined}
          style={{ flex: 1 }}
          size="sm"
        />
        <Select
          placeholder={t("features.dashboard.filterByResult", "Filter by result")}
          value={resultFilter}
          onChange={setResultFilter}
          data={[
            { value: "win", label: t("features.dashboard.win", "Win") },
            { value: "loss", label: t("features.dashboard.loss", "Loss") },
            { value: "draw", label: t("chess.draw", "Draw") },
          ]}
          clearable
          size="sm"
          style={{ width: 150 }}
        />
        <Select
          placeholder={t("features.dashboard.filterByTimeControl", "Filter by time control")}
          value={timeControlCategory ?? undefined}
          onChange={(value) => onTimeControlCategoryChange((value as TimeControlCategory) ?? null)}
          data={(["ultra_bullet", "bullet", "blitz", "rapid", "classical", "correspondence", "daily"] as const).map(
            (value) => ({
              value,
              label: getTimeControlLabel(t, value),
            }),
          )}
          clearable
          searchable
          size="sm"
          style={{ width: 180 }}
        />
      </Group>
      <ScrollArea
        style={{
          flex: 1,
          minHeight: 0,
          ...(isMobile && { minHeight: "550px" }),
        }}
        type="auto"
      >
        <Table stickyHeader striped highlightOnHover style={{ tableLayout: "fixed", width: "100%" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 105 }}>{t("features.dashboard.source", { defaultValue: "Source" })}</Table.Th>
              <Table.Th style={{ width: 180 }}>
                {t("dashboard.tableHeaders.opponent", { defaultValue: "Opponent" })}
              </Table.Th>
              <Table.Th style={{ width: 70 }}>{t("dashboard.tableHeaders.color", { defaultValue: "Color" })}</Table.Th>
              <Table.Th style={{ width: 85 }}>
                {t("dashboard.tableHeaders.result", { defaultValue: "Result" })}
              </Table.Th>
              <Table.Th style={{ width: 90 }}>
                {t("dashboard.tableHeaders.accuracy", { defaultValue: "Accuracy" })}
              </Table.Th>
              <Table.Th style={{ width: 80 }}>ACPL</Table.Th>
              <Table.Th style={{ width: 110, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("elo")}>
                <Group gap="xs" wrap="nowrap">
                  {t("dashboard.estimatedElo")}
                  {sortBy === "elo" &&
                    (sortDirection === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />)}
                </Group>
              </Table.Th>
              <Table.Th style={{ width: 75 }}>{t("dashboard.tableHeaders.moves", { defaultValue: "Moves" })}</Table.Th>
              <Table.Th style={{ width: 95 }}>{t("dashboard.tableHeaders.timeControl")}</Table.Th>
              <Table.Th style={{ width: 95, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("date")}>
                <Group gap="xs" wrap="nowrap">
                  {t("dashboard.tableHeaders.date", { defaultValue: "Date" })}
                  {sortBy === "date" &&
                    (sortDirection === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />)}
                </Group>
              </Table.Th>
              <Table.Th style={{ width: 85 }}>
                {t("features.dashboard.favorite", { defaultValue: "Favorite" })}
              </Table.Th>
              <Table.Th style={{ width: 200, textAlign: "left" }}>
                {onAnalyzeAll && (
                  <Menu position="bottom-start" withinPortal>
                    <Menu.Target>
                      <Button size="xs" variant="light" rightSection={<IconChevronDown size={14} />}>
                        {t("features.dashboard.analyzeAll", { defaultValue: "Analyze All" })}
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {analyzeAllOptions.map((option) => (
                        <Menu.Item
                          key={option.type}
                          disabled={option.count === 0}
                          onClick={() =>
                            onAnalyzeAll({
                              type: option.type,
                              opponentContains: opponentFilter.trim() || null,
                              resultFilter,
                            })
                          }
                        >
                          {option.label} ({option.count})
                        </Menu.Item>
                      ))}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={12} style={{ textAlign: "center", padding: "2rem" }}>
                  <Text c="dimmed">
                    {hasActiveFilters
                      ? t("features.dashboard.noGamesMatchFilters", "No games match the filters")
                      : (t("features.dashboard.noGames") ?? "No games yet")}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ) : (
              rows.map((row) => {
                const pgn = row.pgn ?? null;
                const dateStr = formatRelativeTimeAgo(row.timestampMs, now, t);

                const favoriteSource =
                  row.kind === "local"
                    ? "local"
                    : row.kind === "chesscom"
                      ? "chesscom"
                      : row.kind === "lichess"
                        ? "lichess"
                        : null;
                const fav = favoriteSource ? isFavorite(favoriteGames, favoriteSource, row.gameKey) : false;

                return (
                  <Table.Tr key={`${row.kind}:${row.gameKey}`}>
                    <Table.Td>
                      <Badge
                        variant="light"
                        color={
                          row.kind === "lichess"
                            ? "red"
                            : row.kind === "chesscom"
                              ? "green"
                              : row.kind === "chessbase"
                                ? "blue"
                                : "gray"
                        }
                      >
                        {row.kind === "local"
                          ? t("features.dashboard.sourceLocal", { defaultValue: "Local" })
                          : row.kind === "chesscom"
                            ? t("features.dashboard.sourceChessCom", { defaultValue: "Chess.com" })
                            : row.kind === "chessbase"
                              ? t("features.dashboard.sourceChessBase", { defaultValue: "ChessBase" })
                              : t("features.dashboard.sourceLichess", { defaultValue: "Lichess" })}
                      </Badge>
                    </Table.Td>
                    <Table.Td style={{ width: 180 }}>
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Avatar size={24} radius="xl">
                          {(row.opponent || "?")[0]?.toUpperCase()}
                        </Avatar>
                        <Text truncate style={{ minWidth: 0 }}>
                          {row.opponent}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Box
                        aria-label={row.color}
                        style={{
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          backgroundColor: row.color === "white" ? "#ffffff" : "#000000",
                          border: row.color === "white" ? "1px solid #666666" : "1px solid #000000",
                          marginLeft: 4,
                        }}
                      />
                    </Table.Td>
                    <Table.Td style={{ width: 85 }}>
                      {(() => {
                        const label =
                          row.outcome === "win"
                            ? t("features.dashboard.win", { defaultValue: "Win" })
                            : row.outcome === "loss"
                              ? t("features.dashboard.loss", { defaultValue: "Loss" })
                              : row.outcome === "draw"
                                ? t("chess.draw", { defaultValue: "Draw" })
                                : "-";
                        const color = row.outcome === "win" ? "blue" : row.outcome === "loss" ? "red" : "gray";
                        return (
                          <Badge variant="light" color={color}>
                            {label}
                          </Badge>
                        );
                      })()}
                    </Table.Td>
                    <Table.Td>{row.accuracy != null ? `${Math.round(row.accuracy)}%` : "-"}</Table.Td>
                    <Table.Td>{row.acpl != null ? Math.round(row.acpl) : "-"}</Table.Td>
                    <Table.Td>{row.estimatedElo != null ? Math.round(row.estimatedElo) : "-"}</Table.Td>
                    <Table.Td>{row.moves || "-"}</Table.Td>
                    <Table.Td>
                      {row.timeControl?.trim()
                        ? (() => {
                            const category = row.timeControlCategory ?? null;
                            return category ? getTimeControlLabel(t, category) : "-";
                          })()
                        : "-"}
                    </Table.Td>
                    <Table.Td>{dateStr}</Table.Td>
                    <Table.Td>
                      <ActionIcon
                        variant="subtle"
                        onClick={async () => {
                          if (row.kind === "local" && onToggleFavoriteLocal)
                            return await onToggleFavoriteLocal(row.gameKey);
                          if (row.kind === "chesscom" && onToggleFavoriteChessCom)
                            return await onToggleFavoriteChessCom(row.gameKey);
                          if (row.kind === "lichess" && onToggleFavoriteLichess)
                            return await onToggleFavoriteLichess(row.gameKey);
                        }}
                        disabled={
                          row.kind === "chessbase" ||
                          (row.kind === "local" && !onToggleFavoriteLocal) ||
                          (row.kind === "chesscom" && !onToggleFavoriteChessCom) ||
                          (row.kind === "lichess" && !onToggleFavoriteLichess)
                        }
                      >
                        {fav ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                      </ActionIcon>
                    </Table.Td>
                    <Table.Td style={{ textAlign: "left" }}>
                      <Group gap="xs" wrap="nowrap" justify="flex-start">
                        {row.kind === "local" && onDeleteLocalGame && (
                          <ActionIcon variant="subtle" color="red" onClick={() => onDeleteLocalGame(row.gameKey)}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        )}
                        {row.isAnalyzed && pgn ? (
                          <AnalysisPreview pgn={pgn}>
                            <Button
                              size="xs"
                              variant="default"
                              leftSection={<IconChess size={16} />}
                              onClick={async () => {
                                await handleAnalyzeRow(row, pgn);
                              }}
                            >
                              {t("features.dashboard.analyze") || "Analyze"}
                            </Button>
                          </AnalysisPreview>
                        ) : (
                          <Button
                            size="xs"
                            variant="default"
                            leftSection={<IconChess size={16} />}
                            onClick={async () => {
                              await handleAnalyzeRow(row, pgn);
                            }}
                          >
                            {t("features.dashboard.analyze") || "Analyze"}
                          </Button>
                        )}
                        {row.kind !== "local" && (
                          <Tooltip label={t("features.dashboard.openGame", "Open game")}>
                            <ActionIcon variant="subtle" onClick={() => void handleOpenGame(row.externalUrl)}>
                              <IconExternalLink size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })
            )}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Td colSpan={4} style={stickyFooterLabelCellStyle}>
                <Text fw={600} size="sm">
                  {t("dashboard.tableFooterAverageVisible", "Average (visible)")}
                </Text>
              </Table.Td>
              <Table.Td style={stickyFooterCellStyle}>
                {averageStats.accuracy != null ? `${averageStats.accuracy.toFixed(1)}%` : "-"}
              </Table.Td>
              <Table.Td style={stickyFooterCellStyle}>
                {averageStats.acpl != null ? Math.round(averageStats.acpl) : "-"}
              </Table.Td>
              <Table.Td style={stickyFooterCellStyle}>
                {averageStats.estimatedElo != null ? Math.round(averageStats.estimatedElo) : "-"}
              </Table.Td>
              <Table.Td colSpan={5} style={stickyFooterCellStyle} />
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </ScrollArea>

      {totalPages > 1 && (
        <Group justify="center" mt="xs">
          <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
        </Group>
      )}
    </Stack>
  );
}

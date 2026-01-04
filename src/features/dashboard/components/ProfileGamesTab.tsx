import { ActionIcon, Avatar, Badge, Box, Button, Group, Loader, Menu, Pagination, ScrollArea, Stack, Table, Text } from "@mantine/core";
import {
  IconChartLine,
  IconChevronDown,
  IconChess,
  IconSortAscending,
  IconSortDescending,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnalysisPreview } from "@/components/AnalysisPreview";
import { getAnalyzedGamesBulk, getGameStatsBulk } from "@/utils/analyzedGames";
import { stripAccountKey } from "@/utils/accountKeys";
import type { ChessComGame } from "@/utils/chess.com/api";
import type { FavoriteGame } from "@/utils/favoriteGames";
import type { GameRecord } from "@/utils/gameRecords";
import { createPGNFromMoves } from "../utils/gameHelpers";

type LichessGame = {
  id: string;
  players: {
    white: { user?: { name: string } };
    black: { user?: { name: string } };
  };
  speed: string;
  createdAt: number;
  winner?: string;
  status: string;
  pgn?: string;
  lastFen: string;
};

type OnlineGameStats = {
  accuracy: number;
  acpl: number;
  estimatedElo?: number;
};

type GameItem =
  | { type: "local"; id: string; timestamp: number; game: GameRecord }
  | { type: "chesscom"; id: string; timestamp: number; game: ChessComGame }
  | { type: "lichess"; id: string; timestamp: number; game: LichessGame };

function isFavorite(favorites: FavoriteGame[], source: FavoriteGame["source"], id: string) {
  return favorites.some((f) => f.source === source && f.gameId === id);
}

function resultOutcome(color: "white" | "black", result: string): "win" | "loss" | "draw" | "unknown" {
  const r = (result ?? "").trim().toLowerCase();
  if (!r) return "unknown";
  if (r === "draw") return "draw";
  if (r === "win") return "win";
  if (r === "loss" || r === "lose") return "loss";
  if (r === "1/2-1/2" || r === "½-½" || r === "0.5-0.5") return "draw";
  if (r === "1-0") return color === "white" ? "win" : "loss";
  if (r === "0-1") return color === "black" ? "win" : "loss";
  return "unknown";
}

export function ProfileGamesTab({
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
}: {
  localGames: GameRecord[];
  chessComGames: ChessComGame[];
  lichessGames: LichessGame[];
  profileUsernames: string[];
  isLoadingOnline?: boolean;
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGame) => void;
  onAnalyzeLichessGame: (game: LichessGame) => void;
  onDeleteLocalGame?: (gameId: string) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
  onAnalyzeAll?: (type: "local" | "chesscom" | "lichess" | "all") => void;
  favoriteGames?: FavoriteGame[];
}) {
  const { t } = useTranslation();
  const usernamesLower = useMemo(() => {
    const set = new Set<string>();
    for (const username of profileUsernames) {
      const raw = (username ?? "").toLowerCase();
      if (raw) set.add(raw);
      const stripped = stripAccountKey(username).toLowerCase();
      if (stripped) set.add(stripped);
    }
    return set;
  }, [profileUsernames]);

  const items = useMemo<GameItem[]>(() => {
    const res: GameItem[] = [];
    for (const g of localGames) res.push({ type: "local", id: g.id, timestamp: g.timestamp, game: g });
    for (const g of chessComGames) res.push({ type: "chesscom", id: g.url, timestamp: g.end_time * 1000, game: g });
    for (const g of lichessGames) res.push({ type: "lichess", id: g.id, timestamp: g.createdAt, game: g });
    return res.sort((a, b) => b.timestamp - a.timestamp);
  }, [localGames, chessComGames, lichessGames]);

  const [onlineStats, setOnlineStats] = useState<Map<string, OnlineGameStats>>(new Map());
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const onlineIds = items.filter((i) => i.type !== "local").map((i) => i.id);
      if (onlineIds.length === 0) {
        setOnlineStats(new Map());
        return;
      }
      const stats = await getGameStatsBulk(onlineIds);
      if (!cancelled) setOnlineStats(stats as unknown as Map<string, OnlineGameStats>);
    };

    load().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [items]);

  const [analyzedPgns, setAnalyzedPgns] = useState<Map<string, string>>(new Map());
  const [analyzedGameIds, setAnalyzedGameIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const itemsPerPage = 25;
  const [sortBy, setSortBy] = useState<"elo" | "date" | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const sortedAndPaginatedItems = useMemo(() => {
    const sorted = [...items];

    if (sortBy === "elo") {
      sorted.sort((a, b) => {
        const eloA = a.type === "local" ? a.game.stats?.estimatedElo || 0 : onlineStats.get(a.id)?.estimatedElo || 0;
        const eloB = b.type === "local" ? b.game.stats?.estimatedElo || 0 : onlineStats.get(b.id)?.estimatedElo || 0;
        return sortDirection === "asc" ? eloA - eloB : eloB - eloA;
      });
    } else if (sortBy === "date") {
      sorted.sort((a, b) => (sortDirection === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp));
    }

    const start = (page - 1) * itemsPerPage;
    return sorted.slice(start, start + itemsPerPage);
  }, [items, onlineStats, page, itemsPerPage, sortBy, sortDirection]);

  useEffect(() => {
    setPage(1);
  }, [items.length]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const idsToLoad = sortedAndPaginatedItems.map((i) => i.id).filter((id) => !analyzedPgns.has(id));
      if (idsToLoad.length === 0) return;

      const analyzed = await getAnalyzedGamesBulk(idsToLoad);
      if (cancelled) return;

      setAnalyzedPgns((prev) => {
        const next = new Map(prev);
        const analyzedIds = new Set<string>();
        
        for (const item of sortedAndPaginatedItems) {
          if (next.has(item.id)) {
            // Already loaded, check if it's analyzed by checking if it has analysis markers
            const existingPgn = next.get(item.id);
            if (existingPgn && /\[%eval|\[%clk|\$[0-9]|!!|!\?|\?!/i.test(existingPgn)) {
              analyzedIds.add(item.id);
            }
            continue;
          }
          const analyzedPgn = analyzed.get(item.id);
          if (analyzedPgn) {
            // This PGN is actually analyzed
            next.set(item.id, analyzedPgn);
            analyzedIds.add(item.id);
            continue;
          }
          // Fallback: use original PGN (not analyzed)
          const fallback =
            item.type === "local"
              ? item.game.pgn ?? createPGNFromMoves(item.game.moves, item.game.result, item.game.initialFen)
              : item.type === "chesscom"
                ? item.game.pgn ?? undefined
                : item.game.pgn;
          if (fallback) next.set(item.id, fallback);
        }
        
        setAnalyzedGameIds((prevIds) => {
          const nextIds = new Set(prevIds);
          analyzedIds.forEach((id) => nextIds.add(id));
          return nextIds;
        });
        
        return next;
      });
    };

    load().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sortedAndPaginatedItems, analyzedPgns]);

  const handleSort = (field: "elo" | "date") => {
    if (sortBy === field) setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    else {
      setSortBy(field);
      setSortDirection("desc");
    }
    setPage(1);
  };

  const totalPages = Math.ceil(items.length / itemsPerPage);
  const now = useMemo(() => Date.now(), [sortedAndPaginatedItems]);
  const analyzeAllOptions = useMemo(
    () => {
      const totalCount = localGames.length + chessComGames.length + lichessGames.length;
      return [
        { type: "all" as const, label: "All", count: totalCount },
        { type: "local" as const, label: "Local", count: localGames.length },
        { type: "chesscom" as const, label: "Chess.com", count: chessComGames.length },
        { type: "lichess" as const, label: "Lichess", count: lichessGames.length },
      ];
    },
    [localGames.length, chessComGames.length, lichessGames.length],
  );

  const itemMeta = (item: GameItem) => {
    if (item.type === "local") {
      const isUserWhite = item.game.white.type === "human";
      const opponent = isUserWhite ? item.game.black : item.game.white;
      const color: "white" | "black" = isUserWhite ? "white" : "black";
      return {
        source: "Local" as const,
        color,
        opponent: opponent.name ?? (opponent.engine ? `${t("features.dashboard.engine")} (${opponent.engine})` : "?"),
        result: item.game.result,
        moves: item.game.moves?.length ?? 0,
        accuracy: item.game.stats?.accuracy ?? 0,
        acpl: item.game.stats?.acpl ?? 0,
        elo: item.game.stats?.estimatedElo ?? 0,
      };
    }

    if (item.type === "chesscom") {
      const whiteRaw = item.game.white.username || "";
      const blackRaw = item.game.black.username || "";
      const whiteName = stripAccountKey(whiteRaw);
      const blackName = stripAccountKey(blackRaw);
      const isUserWhite = usernamesLower.has(whiteRaw.toLowerCase()) || usernamesLower.has(whiteName.toLowerCase());
      const isUserBlack = usernamesLower.has(blackRaw.toLowerCase()) || usernamesLower.has(blackName.toLowerCase());
      const userIsWhite = isUserWhite || (!isUserBlack && true);
      const opponent = userIsWhite ? blackName : whiteName;
      const color: "white" | "black" = userIsWhite ? "white" : "black";
      const stats = onlineStats.get(item.id);
      return {
        source: "Chess.com" as const,
        color,
        opponent: opponent || "?",
        result: item.game.white.result === "win" ? "1-0" : item.game.black.result === "win" ? "0-1" : "1/2-1/2",
        moves: item.game.pgn ? (item.game.pgn.match(/\d+\.\s+\S+/g) || []).length : 0,
        accuracy: stats?.accuracy ?? 0,
        acpl: stats?.acpl ?? 0,
        elo: stats?.estimatedElo ?? 0,
      };
    }

    const whiteRaw = item.game.players.white.user?.name || "";
    const blackRaw = item.game.players.black.user?.name || "";
    const whiteName = stripAccountKey(whiteRaw);
    const blackName = stripAccountKey(blackRaw);
    const isUserWhite = usernamesLower.has(whiteRaw.toLowerCase()) || usernamesLower.has(whiteName.toLowerCase());
    const isUserBlack = usernamesLower.has(blackRaw.toLowerCase()) || usernamesLower.has(blackName.toLowerCase());
    const userIsWhite = isUserWhite || (!isUserBlack && true);
    const opponent = userIsWhite ? blackName : whiteName;
    const color: "white" | "black" = userIsWhite ? "white" : "black";
    const stats = onlineStats.get(item.id);
    return {
      source: "Lichess" as const,
      color,
      opponent: opponent || "?",
      result: item.game.winner === "white" ? "1-0" : item.game.winner === "black" ? "0-1" : "1/2-1/2",
      moves: item.game.pgn ? (item.game.pgn.match(/\d+\.\s+\S+/g) || []).length : 0,
      accuracy: stats?.accuracy ?? 0,
      acpl: stats?.acpl ?? 0,
      elo: stats?.estimatedElo ?? 0,
    };
  };

  const handleAnalyze = (item: GameItem) => {
    if (item.type === "local") onAnalyzeLocalGame(item.game);
    else if (item.type === "chesscom") onAnalyzeChessComGame(item.game);
    else onAnalyzeLichessGame(item.game);
  };

  const handleToggleFavorite = async (item: GameItem) => {
    if (item.type === "local" && onToggleFavoriteLocal) return await onToggleFavoriteLocal(item.id);
    if (item.type === "chesscom" && onToggleFavoriteChessCom) return await onToggleFavoriteChessCom(item.id);
    if (item.type === "lichess" && onToggleFavoriteLichess) return await onToggleFavoriteLichess(item.id);
  };

  const isGameAnalyzed = (gameId: string): boolean => {
    return analyzedGameIds.has(gameId);
  };

  if (isLoadingOnline) {
    return (
      <Stack gap="xs" align="center" justify="center" style={{ minHeight: "200px" }}>
        <Loader size="md" />
        <Text size="sm" c="dimmed">
          Loading...
        </Text>
      </Stack>
    );
  }

  if (items.length === 0) {
    return (
      <Stack align="center" justify="center" style={{ flex: 1, minHeight: 200 }}>
        <Text c="dimmed">{t("features.dashboard.noGames") || "No games yet"}</Text>
      </Stack>
    );
  }

  return (
    <Stack gap="xs" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
        <Table striped highlightOnHover style={{ tableLayout: "fixed", width: "100%" }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 105 }}>Source</Table.Th>
              <Table.Th style={{ width: 180 }}>Opponent</Table.Th>
              <Table.Th style={{ width: 70 }}>Color</Table.Th>
              <Table.Th style={{ width: 85 }}>Result</Table.Th>
              <Table.Th style={{ width: 90 }}>Accuracy</Table.Th>
              <Table.Th style={{ width: 80 }}>ACPL</Table.Th>
              <Table.Th style={{ width: 110, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("elo")}>
                <Group gap="xs" wrap="nowrap">
                  {t("dashboard.estimatedElo")}
                  {sortBy === "elo" &&
                    (sortDirection === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />)}
                </Group>
              </Table.Th>
              <Table.Th style={{ width: 75 }}>Moves</Table.Th>
              <Table.Th style={{ width: 95, cursor: "pointer", userSelect: "none" }} onClick={() => handleSort("date")}>
                <Group gap="xs" wrap="nowrap">
                  Date
                  {sortBy === "date" &&
                    (sortDirection === "asc" ? <IconSortAscending size={16} /> : <IconSortDescending size={16} />)}
                </Group>
              </Table.Th>
              <Table.Th style={{ width: 85 }}>Favorite</Table.Th>
              <Table.Th style={{ width: 200, textAlign: "left" }}>
                {onAnalyzeAll && (
                  <Menu position="bottom-start" withinPortal>
                    <Menu.Target>
                      <Button size="xs" variant="light" rightSection={<IconChevronDown size={14} />}>
                        Analyze All
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      {analyzeAllOptions.map((option) => (
                        <Menu.Item
                          key={option.type}
                          disabled={option.count === 0}
                          onClick={() => onAnalyzeAll(option.type)}
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
            {sortedAndPaginatedItems.map((item) => {
              const meta = itemMeta(item);
              const pgn = analyzedPgns.get(item.id) ?? null;
              const diffMs = now - item.timestamp;
              const dateStr =
                diffMs < 60 * 60 * 1000
                  ? `${Math.floor(diffMs / (60 * 1000))}m ago`
                  : diffMs < 24 * 60 * 60 * 1000
                    ? `${Math.floor(diffMs / (60 * 60 * 1000))}h ago`
                    : `${Math.floor(diffMs / (24 * 60 * 60 * 1000))}d ago`;

              const favoriteSource = item.type === "local" ? "local" : item.type === "chesscom" ? "chesscom" : "lichess";
              const fav = isFavorite(favoriteGames, favoriteSource, item.id);

              return (
                <Table.Tr key={`${item.type}:${item.id}`}>
                  <Table.Td>
                    <Badge variant="light" color={item.type === "lichess" ? "red" : item.type === "chesscom" ? "green" : "gray"}>
                      {meta.source}
                    </Badge>
                  </Table.Td>
                  <Table.Td style={{ width: 180 }}>
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Avatar size={24} radius="xl">
                        {(meta.opponent || "?")[0]?.toUpperCase()}
                      </Avatar>
                      <Text truncate style={{ minWidth: 0 }}>
                        {meta.opponent}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Box
                      aria-label={meta.color}
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 999,
                        backgroundColor: meta.color === "white" ? "#ffffff" : "#000000",
                        border: meta.color === "white" ? "1px solid #666666" : "1px solid #000000",
                        marginLeft: 4,
                      }}
                    />
                  </Table.Td>
                  <Table.Td style={{ width: 85 }}>
                    {(() => {
                      const outcome = resultOutcome(meta.color, meta.result);
                      const label =
                        outcome === "win" ? "Win" : outcome === "loss" ? "Loss" : outcome === "draw" ? "Draw" : "-";
                      const color = outcome === "win" ? "blue" : outcome === "loss" ? "red" : "gray";
                      return (
                        <Badge variant="light" color={color}>
                          {label}
                        </Badge>
                      );
                    })()}
                  </Table.Td>
                  <Table.Td>{meta.accuracy ? `${Math.round(meta.accuracy)}%` : "-"}</Table.Td>
                  <Table.Td>{meta.acpl ? Math.round(meta.acpl) : "-"}</Table.Td>
                  <Table.Td>{meta.elo ? Math.round(meta.elo) : "-"}</Table.Td>
                  <Table.Td>{meta.moves || "-"}</Table.Td>
                  <Table.Td>{dateStr}</Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" onClick={() => handleToggleFavorite(item)} disabled={
                      (item.type === "local" && !onToggleFavoriteLocal) ||
                      (item.type === "chesscom" && !onToggleFavoriteChessCom) ||
                      (item.type === "lichess" && !onToggleFavoriteLichess)
                    }>
                      {fav ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                    </ActionIcon>
                  </Table.Td>
                  <Table.Td style={{ textAlign: "left" }}>
                    <Group gap="xs" wrap="nowrap" justify="flex-start">
                      {item.type === "local" && onDeleteLocalGame && (
                        <ActionIcon variant="subtle" color="red" onClick={() => onDeleteLocalGame(item.id)}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      )}
                      {isGameAnalyzed(item.id) && pgn ? (
                        <AnalysisPreview pgn={pgn}>
                          <Button
                            size="xs"
                            variant="default"
                            leftSection={<IconChess size={16} />}
                            onClick={() => handleAnalyze(item)}
                            disabled={!pgn && item.type !== "local"}
                          >
                            {t("features.dashboard.analyze") || "Analyze"}
                          </Button>
                        </AnalysisPreview>
                      ) : (
                        <Button
                          size="xs"
                          variant="default"
                          leftSection={<IconChess size={16} />}
                          onClick={() => handleAnalyze(item)}
                          disabled={!pgn && item.type !== "local"}
                        >
                          {t("features.dashboard.analyze") || "Analyze"}
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
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

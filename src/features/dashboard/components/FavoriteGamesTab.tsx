import { ActionIcon, Avatar, Badge, Group, Pagination, ScrollArea, Stack, Table, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconStarFilled } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnalysisPreview } from "@/components/AnalysisPreview";
import { currentThemeIdAtom } from "@/features/themes/state/themeAtoms";
import { stripAccountKey } from "@/utils/accountKeys";
import { getAnalyzedGamesBulk } from "@/utils/analyzedGames";
import type { FavoriteGame } from "@/utils/favoriteGames";
import type { GameRecord } from "@/utils/gameRecords";
import type { ChessComGameWithEvent, DashboardLichessGame } from "../types";
import { formatRelativeTimeAgo } from "../utils/relativeTime";

interface FavoriteGamesTabProps {
  localGames: GameRecord[];
  chessComGames: ChessComGameWithEvent[];
  lichessGames: DashboardLichessGame[];
  favoriteGames: FavoriteGame[];
  chessComUsernames: string[];
  lichessUsernames: string[];
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGameWithEvent, meta?: { profileId: string; profileDbGameId: string }) => void;
  onAnalyzeLichessGame: (game: DashboardLichessGame, meta?: { profileId: string; profileDbGameId: string }) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
}

type FavoriteGameItem =
  | { type: "local"; game: GameRecord }
  | { type: "chesscom"; game: ChessComGameWithEvent }
  | { type: "lichess"; game: DashboardLichessGame };

const normalizeAccountName = (name?: string | null) => stripAccountKey((name ?? "").trim()).toLowerCase();

const extractResultFromPgn = (pgn?: string | null): string | null => {
  if (!pgn) return null;
  const match = pgn.match(/\[Result\s+"([^"]+)"\]/i);
  return match?.[1] ?? null;
};

const normalizeResult = (result?: string | null) => {
  const value = (result ?? "").trim().toLowerCase();
  if (value === "1-0" || value === "0-1" || value === "*") return value;
  if (value === "1/2-1/2" || value === "draw" || value === "0.5-0.5") return "1/2-1/2";
  return "*";
};

const resolveUserColorAndOpponent = (
  whiteName: string | null | undefined,
  blackName: string | null | undefined,
  knownUsernames: Set<string>,
): { userColor: "white" | "black" | null; opponent: string } => {
  const white = stripAccountKey((whiteName ?? "").trim());
  const black = stripAccountKey((blackName ?? "").trim());
  const whiteNormalized = normalizeAccountName(white);
  const blackNormalized = normalizeAccountName(black);
  const isWhiteUser = whiteNormalized ? knownUsernames.has(whiteNormalized) : false;
  const isBlackUser = blackNormalized ? knownUsernames.has(blackNormalized) : false;

  if (isWhiteUser && !isBlackUser) {
    return { userColor: "white", opponent: black || "?" };
  }
  if (isBlackUser && !isWhiteUser) {
    return { userColor: "black", opponent: white || "?" };
  }
  if (isWhiteUser && isBlackUser) {
    return { userColor: "white", opponent: black || white || "?" };
  }
  return { userColor: null, opponent: black || white || "?" };
};

export function FavoriteGamesTab({
  localGames,
  chessComGames,
  lichessGames,
  favoriteGames,
  chessComUsernames,
  lichessUsernames,
  onAnalyzeLocalGame,
  onAnalyzeChessComGame,
  onAnalyzeLichessGame,
  onToggleFavoriteLocal,
  onToggleFavoriteChessCom,
  onToggleFavoriteLichess,
}: FavoriteGamesTabProps) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 48em)");
  const currentThemeId = useAtomValue(currentThemeIdAtom);
  const isAcademiaMaya = currentThemeId === "academia-maya";
  const [analyzedPgns, setAnalyzedPgns] = useState<Map<string, string>>(new Map());
  const [page, setPage] = useState(1);
  const itemsPerPage = 25;
  const normalizedChessComUsernames = useMemo(() => {
    return new Set(chessComUsernames.map((username) => normalizeAccountName(username)).filter(Boolean));
  }, [chessComUsernames]);
  const normalizedLichessUsernames = useMemo(() => {
    return new Set(lichessUsernames.map((username) => normalizeAccountName(username)).filter(Boolean));
  }, [lichessUsernames]);

  // Combine all favorite games from all sources
  const favoriteGameItems = useMemo<FavoriteGameItem[]>(() => {
    const items: FavoriteGameItem[] = [];

    // Add local favorite games
    favoriteGames
      .filter((f) => f.source === "local")
      .forEach((favorite) => {
        const game = localGames.find((g) => g.id === favorite.gameId);
        if (game) {
          items.push({ type: "local", game });
        }
      });

    // Add Chess.com favorite games
    favoriteGames
      .filter((f) => f.source === "chesscom")
      .forEach((favorite) => {
        const game = chessComGames.find((g) => g.url === favorite.gameId);
        if (game) {
          items.push({ type: "chesscom", game });
        }
      });

    // Add Lichess favorite games
    favoriteGames
      .filter((f) => f.source === "lichess")
      .forEach((favorite) => {
        const game = lichessGames.find((g) => g.id === favorite.gameId);
        if (game) {
          items.push({ type: "lichess", game });
        }
      });

    // Sort by timestamp (most recent first)
    return items.sort((a, b) => {
      const timeA =
        a.type === "local" ? a.game.timestamp : a.type === "chesscom" ? a.game.end_time * 1000 : a.game.createdAt;
      const timeB =
        b.type === "local" ? b.game.timestamp : b.type === "chesscom" ? b.game.end_time * 1000 : b.game.createdAt;
      return timeB - timeA;
    });
  }, [favoriteGames, localGames, chessComGames, lichessGames]);

  // Paginate games
  const paginatedGames = useMemo(() => {
    const start = (page - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    return favoriteGameItems.slice(start, end);
  }, [favoriteGameItems, page]);
  const paginatedGameIds = useMemo(
    () => paginatedGames.map((item) => (item.type === "chesscom" ? item.game.url : item.game.id)),
    [paginatedGames],
  );
  const missingGameIds = useMemo(
    () => paginatedGameIds.filter((gameId) => !analyzedPgns.has(gameId)),
    [paginatedGameIds, analyzedPgns],
  );

  // Load analyzed PGNs for preview (only for the visible page)
  useEffect(() => {
    let cancelled = false;

    const loadAnalyzedPgns = async () => {
      if (paginatedGames.length === 0 || missingGameIds.length === 0) return;
      const analyzed = await getAnalyzedGamesBulk(missingGameIds);
      if (cancelled) return;

      setAnalyzedPgns((prev) => {
        const next = new Map(prev);
        for (const item of paginatedGames) {
          const gameId = item.type === "local" ? item.game.id : item.type === "chesscom" ? item.game.url : item.game.id;
          if (next.has(gameId)) continue;
          const analyzedPgn = analyzed.get(gameId);
          const fallbackPgn = item.game.pgn;
          if (analyzedPgn) {
            next.set(gameId, analyzedPgn);
          } else if (fallbackPgn) {
            next.set(gameId, fallbackPgn);
          }
        }
        return next;
      });
    };

    loadAnalyzedPgns().catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [missingGameIds, paginatedGames]);

  const totalPages = Math.ceil(favoriteGameItems.length / itemsPerPage);
  const _favoriteGameItemsKey = useMemo(
    () =>
      favoriteGameItems
        .map((item) => `${item.type}:${item.type === "chesscom" ? item.game.url : item.game.id}`)
        .join("|"),
    [favoriteGameItems],
  );

  // Reset to page 1 when games change
  useEffect(() => {
    setPage(1);
  }, []);

  // Calculate current time once per render
  const now = useMemo(() => Date.now(), []);

  const handleToggleFavorite = async (item: FavoriteGameItem) => {
    if (item.type === "local" && onToggleFavoriteLocal) {
      await onToggleFavoriteLocal(item.game.id);
    } else if (item.type === "chesscom" && onToggleFavoriteChessCom) {
      await onToggleFavoriteChessCom(item.game.url);
    } else if (item.type === "lichess" && onToggleFavoriteLichess) {
      await onToggleFavoriteLichess(item.game.id);
    }
  };

  const handleAnalyze = (item: FavoriteGameItem) => {
    if (item.type === "local") {
      onAnalyzeLocalGame(item.game);
    } else if (item.type === "chesscom") {
      onAnalyzeChessComGame(item.game);
    } else {
      onAnalyzeLichessGame(item.game);
    }
  };

  if (favoriteGameItems.length === 0) {
    return (
      <Stack align="center" justify="center" style={{ flex: 1, minHeight: 200 }}>
        <Text c="dimmed">{t("features.dashboard.noFavorites") || "No favorite games yet"}</Text>
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
      <ScrollArea
        style={{
          flex: 1,
          minHeight: 0,
          ...(isMobile && { minHeight: "550px" }),
        }}
        type="auto"
      >
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t("features.dashboard.source", { defaultValue: "Source" })}</Table.Th>
              <Table.Th>{t("dashboard.tableHeaders.color", { defaultValue: "Color" })}</Table.Th>
              <Table.Th>{t("dashboard.tableHeaders.opponent", { defaultValue: "Opponent" })}</Table.Th>
              <Table.Th>{t("dashboard.tableHeaders.result", { defaultValue: "Result" })}</Table.Th>
              <Table.Th>{t("dashboard.tableHeaders.date", { defaultValue: "Date" })}</Table.Th>
              <Table.Th>{t("features.dashboard.favorite", { defaultValue: "Favorite" })}</Table.Th>
              <Table.Th>{t("features.dashboard.actions", { defaultValue: "Actions" })}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {paginatedGames.map((item) => {
              let opponent: string;
              let result: string;
              let timestamp: number;
              let gameId: string;
              let source: string;
              let userColor: "white" | "black" | null = null;

              if (item.type === "local") {
                const whiteName =
                  item.game.white.name ??
                  (item.game.white.engine ? `${t("features.dashboard.engine")} (${item.game.white.engine})` : "");
                const blackName =
                  item.game.black.name ??
                  (item.game.black.engine ? `${t("features.dashboard.engine")} (${item.game.black.engine})` : "");

                if (item.game.white.type === "human" && item.game.black.type !== "human") userColor = "white";
                else if (item.game.black.type === "human" && item.game.white.type !== "human") userColor = "black";

                opponent =
                  userColor === "white"
                    ? blackName || "?"
                    : userColor === "black"
                      ? whiteName || "?"
                      : blackName || whiteName || "?";
                result = normalizeResult(item.game.result);
                timestamp = item.game.timestamp;
                gameId = item.game.id;
                source = t("features.dashboard.sourceLocal", { defaultValue: "Local" });
              } else if (item.type === "chesscom") {
                const whiteName = item.game.white?.username ?? "";
                const blackName = item.game.black?.username ?? "";
                const resolved = resolveUserColorAndOpponent(whiteName, blackName, normalizedChessComUsernames);
                userColor = resolved.userColor;
                opponent = resolved.opponent;

                const pgnResult = extractResultFromPgn(item.game.pgn);
                if (pgnResult) {
                  result = normalizeResult(pgnResult);
                } else if ((item.game.white?.result ?? "").toLowerCase() === "win") {
                  result = "1-0";
                } else if ((item.game.black?.result ?? "").toLowerCase() === "win") {
                  result = "0-1";
                } else {
                  const whiteResult = (item.game.white?.result ?? "").toLowerCase();
                  const blackResult = (item.game.black?.result ?? "").toLowerCase();
                  const drawMarkers = ["agreed", "repetition", "stalemate", "50move", "insufficient", "draw"];
                  result = drawMarkers.some((marker) => whiteResult.includes(marker) || blackResult.includes(marker))
                    ? "1/2-1/2"
                    : "*";
                }
                timestamp = item.game.end_time * 1000;
                gameId = item.game.url;
                source = t("features.dashboard.sourceChessCom", { defaultValue: "Chess.com" });
              } else {
                const whiteName = item.game.players.white?.user?.name ?? "";
                const blackName = item.game.players.black?.user?.name ?? "";
                const resolved = resolveUserColorAndOpponent(whiteName, blackName, normalizedLichessUsernames);
                userColor = resolved.userColor;
                opponent = resolved.opponent;

                const pgnResult = extractResultFromPgn(item.game.pgn);
                result = normalizeResult(
                  pgnResult ??
                    (item.game.winner === "white" ? "1-0" : item.game.winner === "black" ? "0-1" : "1/2-1/2"),
                );
                timestamp = item.game.createdAt;
                gameId = item.game.id;
                source = t("features.dashboard.sourceLichess", { defaultValue: "Lichess" });
              }

              const dateStr = formatRelativeTimeAgo(timestamp, now, t);

              const pgn = analyzedPgns.get(gameId);

              return (
                <Table.Tr key={`${item.type}-${gameId}`}>
                  <Table.Td>
                    <Badge variant="light">{source}</Badge>
                  </Table.Td>
                  <Table.Td>
                    {userColor === "white" || userColor === "black" ? (
                      <Badge variant="light" color={userColor === "white" ? "gray" : "dark"}>
                        {userColor === "white"
                          ? t("chess.white", { defaultValue: "White" })
                          : t("chess.black", { defaultValue: "Black" })}
                      </Badge>
                    ) : (
                      <Text size="sm">-</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Avatar size={24} radius="xl">
                        {opponent[0]?.toUpperCase()}
                      </Avatar>
                      <Text>{opponent}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={result === "1-0" || result === "0-1" ? (isAcademiaMaya ? "green" : "teal") : "gray"}>
                      {result}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{dateStr}</Text>
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon
                      variant="subtle"
                      color="yellow"
                      onClick={() => handleToggleFavorite(item)}
                      title={t("features.dashboard.removeFavorite") || "Remove from favorites"}
                    >
                      <IconStarFilled size={16} />
                    </ActionIcon>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      {pgn && <AnalysisPreview pgn={pgn}>{null}</AnalysisPreview>}
                      <Text
                        size="sm"
                        style={{ cursor: "pointer", textDecoration: "underline" }}
                        onClick={() => handleAnalyze(item)}
                      >
                        {t("features.dashboard.analyze") || "Analyze"}
                      </Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </ScrollArea>
      {totalPages > 1 && (
        <Group justify="center" mt="md">
          <Pagination value={page} onChange={setPage} total={totalPages} />
        </Group>
      )}
    </Stack>
  );
}

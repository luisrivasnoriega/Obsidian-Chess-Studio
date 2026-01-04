import type { MantineColor } from "@mantine/core";
import { Box, Button, Grid, Group, Select, Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconBolt, IconChess, IconClock, IconStopwatch } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { appDataDir, resolve } from "@tauri-apps/api/path";
import { mkdir, writeTextFile } from "@tauri-apps/plugin-fs";
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type GoMode } from "@/bindings";
import { activeProfileIdAtom, activeTabAtom, enginesAtom, profilesAtom, sessionsAtom, tabsAtom } from "@/state/atoms";
import { getAccountKey } from "@/utils/accountKeys";
import { getAccountPgnPath } from "@/utils/accountPgnPaths";
import { getAllAnalyzedGames, saveAnalyzedGame, saveGameStats } from "@/utils/analyzedGames";
import { getGameStats, getMainLine, getPGN, parsePGN } from "@/utils/chess";
import type { ChessComGame } from "@/utils/chess.com/api";
import { downloadChessCom, getChessComAccount } from "@/utils/chess.com/api";
import { query_games } from "@/utils/db";
import { calculateEstimatedElo } from "@/utils/eloEstimation";
import type { LocalEngine } from "@/utils/engines";
import {
  type FavoriteGame,
  getAllFavoriteGames,
  isFavoriteGame,
  removeFavoriteGame,
  saveFavoriteGame,
} from "@/utils/favoriteGames";
import { fetchFidePlayer } from "@/utils/fide";
import {
  deleteGameRecord,
  type GameRecord,
  type GameStats,
  getRecentGames,
  updateGameRecord,
} from "@/utils/gameRecords";
import { downloadLichess, getLichessAccount } from "@/utils/lichess/api";
import { rewritePgnAccountTags } from "@/utils/pgnAccountTags";
import type { AnalysisResult } from "@/utils/playerMistakes";
import { getProfileDbPath } from "@/utils/profileDb";
import { getAccountSyncStateFromProfileDb } from "@/utils/profileGameSync";
import { getPuzzleStats } from "@/utils/puzzleStreak";
import type { Session } from "@/utils/session";
import { createTab, genID, type Tab } from "@/utils/tabs";
import type { TreeState } from "@/utils/treeReducer";
import { unwrap } from "@/utils/unwrap";
import { AnalyzeAllModal } from "./components/AnalyzeAllModal";
import { GamesHistoryCard } from "./components/GamesHistoryCard";
import { PlayerStatsModal } from "./components/PlayerStatsModal";
import { PuzzleStatsCard } from "./components/PuzzleStatsCard";
import { PuzzleVariantsCard } from "./components/PuzzleVariantsCard";
import { QuickActionsGrid } from "./components/QuickActionsGrid";
import { UserProfileCard } from "./components/UserProfileCard";
import { WelcomeCard } from "./components/WelcomeCard";
import { calculateOnlineRating } from "./utils/calculateOnlineRating";
import { getChessTitle } from "./utils/chessTitle";
import {
  convertNormalizedToChessComGame,
  convertNormalizedToLichessGame,
  createChessComGameHeaders,
  createLichessGameHeaders,
  createLocalGameHeaders,
  createPGNFromMoves,
} from "./utils/gameHelpers";

export default function DashboardPage() {
  const [isFirstOpen, setIsFirstOpen] = useState(false);
  useEffect(() => {
    const key = "obsidian-chess-studio.firstOpen";

    const hasSeen = localStorage.getItem(key);
    if (!hasSeen) {
      localStorage.setItem(key, "true");
      setIsFirstOpen(true);
    } else {
      setIsFirstOpen(false);
    }
  }, []);
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [_tabs, setTabs] = useAtom(tabsAtom);
  const [_activeTab, setActiveTab] = useAtom(activeTabAtom);

  const [sessions, setSessions] = useAtom(sessionsAtom);
  const [profiles, setProfiles] = useAtom(profilesAtom);
  const [activeProfileId, setActiveProfileId] = useAtom(activeProfileIdAtom);

  const sortedProfiles = useMemo(() => {
    const list = [...profiles];
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return list;
  }, [profiles]);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  const topProfileOptions = useMemo(() => sortedProfiles.slice(0, 5), [sortedProfiles]);
  const otherProfileOptions = useMemo(() => sortedProfiles.slice(5), [sortedProfiles]);

  const activeProfileSessions = useMemo(
    () => sessions.filter((s) => (activeProfileId ? s.profileId === activeProfileId : true)),
    [sessions, activeProfileId],
  );

  const profileLichessUsernames = useMemo(
    () => [...new Set(activeProfileSessions.map((s) => s.lichess?.username).filter(Boolean) as string[])],
    [activeProfileSessions],
  );
  const profileChessComUsernames = useMemo(
    () => [...new Set(activeProfileSessions.map((s) => s.chessCom?.username).filter(Boolean) as string[])],
    [activeProfileSessions],
  );
  const profileUsernames = useMemo(() => {
    const lichessKeys = profileLichessUsernames.map((username) => getAccountKey("lichess", username));
    const chessComKeys = profileChessComUsernames.map((username) => getAccountKey("chesscom", username));
    return [...new Set([...profileLichessUsernames, ...profileChessComUsernames, ...lichessKeys, ...chessComKeys])];
  }, [profileLichessUsernames, profileChessComUsernames]);
  const engines = useAtomValue(enginesAtom);
  const localEngines = engines.filter((e): e is LocalEngine => e.type === "local");
  const defaultEngine = localEngines.length > 0 ? localEngines[0] : null;

  const hasAutoSyncedAccountsRef = useRef(false);
  useEffect(() => {
    if (hasAutoSyncedAccountsRef.current) return;
    if (sessions.length === 0) return;
    hasAutoSyncedAccountsRef.current = true;

    const run = async () => {
      try {
        const dbDir = await resolve(await appDataDir(), "db");
        await mkdir(dbDir, { recursive: true });
      } catch {
        // Best-effort; downloads/conversion will surface errors if this fails.
      }

      const profileNameById = new Map(profiles.map((p) => [p.id, p.name] as const));

      const getDbSyncState = async (
        dbFile: string,
        platform: "lichess" | "chesscom",
        username: string,
      ): Promise<{ lastGameDate: number | null; count: number }> => {
        try {
          const accountKey = getAccountKey(platform, username);
          return await getAccountSyncStateFromProfileDb(dbFile, accountKey);
        } catch {
          return { lastGameDate: null, count: 0 };
        }
      };

      for (const session of sessions) {
        const profileId = session.profileId ?? activeProfileId;
        if (!profileId) continue;

        const dbPath = await getProfileDbPath(profileId);
        const dbTitle = profileNameById.get(profileId) ?? `Profile ${profileId}`;

        if (session.lichess) {
          try {
            const username = session.lichess.username;
            const token = session.lichess.accessToken;

            const updatedAccount = await getLichessAccount({ token, username });
            if (updatedAccount) {
              setSessions((prev) =>
                prev.map((s) =>
                  (s.profileId ?? activeProfileId) === profileId && s.lichess?.username === username
                    ? { ...s, updatedAt: Date.now(), lichess: { ...s.lichess, account: updatedAccount } }
                    : s,
                ),
              );
            }

            const { lastGameDate, count } = await getDbSyncState(dbPath, "lichess", username);
            const totalGames = updatedAccount?.count?.all ?? session.lichess.account.count?.all ?? 0;
            const gamesToDownload = Math.max(0, totalGames - count);

            const appDir = await appDataDir();
            const pgnPath = await getAccountPgnPath({
              appDataDir: appDir,
              profileId,
              platform: "lichess",
              username,
            });
            await downloadLichess(
              username,
              lastGameDate,
              gamesToDownload,
              () => {},
              token,
              pgnPath,
              `lichess_${profileId}_${username}`,
            );
            await rewritePgnAccountTags(pgnPath, "lichess", username);
            unwrap(
              await commands.convertPgn(pgnPath, dbPath, lastGameDate ? lastGameDate / 1000 : null, dbTitle, null),
            );
          } catch {
            // Best-effort: keep processing other accounts.
          }
        }

        if (session.chessCom) {
          try {
            const username = session.chessCom.username;

            const updatedStats = await getChessComAccount(username);
            if (updatedStats) {
              setSessions((prev) =>
                prev.map((s) =>
                  (s.profileId ?? activeProfileId) === profileId && s.chessCom?.username === username
                    ? { ...s, updatedAt: Date.now(), chessCom: { ...s.chessCom, stats: updatedStats } }
                    : s,
                ),
              );
            }

            const { lastGameDate } = await getDbSyncState(dbPath, "chesscom", username);

            const appDir = await appDataDir();
            const pgnPath = await getAccountPgnPath({
              appDataDir: appDir,
              profileId,
              platform: "chesscom",
              username,
            });
            await downloadChessCom(username, lastGameDate, pgnPath, `chesscom_${profileId}_${username}`);
            await rewritePgnAccountTags(pgnPath, "chesscom", username);
            unwrap(
              await commands.convertPgn(pgnPath, dbPath, lastGameDate ? lastGameDate / 1000 : null, dbTitle, null),
            );
          } catch {
            // Best-effort: keep processing other accounts.
          }
        }
      }
    };

    void run();
  }, [activeProfileId, profiles, sessions, setSessions]);

  const [activeGamesTab, setActiveGamesTab] = useState<string | null>("games");
  const [analyzeAllModalOpened, setAnalyzeAllModalOpened] = useState(false);
  const [analyzeAllGameType, setAnalyzeAllGameType] = useState<"local" | "chesscom" | "lichess" | "all" | null>(null);
  const [unanalyzedGameCount, setUnanalyzedGameCount] = useState<number | null>(null);
  const handleAnalyzeAll = useCallback((type: "local" | "chesscom" | "lichess" | "all") => {
    setAnalyzeAllGameType(type);
    setUnanalyzedGameCount(null);
    setAnalyzeAllModalOpened(true);
  }, []);
  const [playerStatsModalOpened, setPlayerStatsModalOpened] = useState(false);
  const [playerStatsResult, setPlayerStatsResult] = useState<AnalysisResult | null>(null);
  const [playerStatsDebugPgns, setPlayerStatsDebugPgns] = useState<string | null>(null);
  const [playerStatsGameType, _setPlayerStatsGameType] = useState<"local" | "chesscom" | "lichess" | null>(null);
  const [playerStatsAccountName, _setPlayerStatsAccountName] = useState<string | null>(null);

  // FIDE player information
  const [fidePlayer, setFidePlayer] = useState<{
    name: string;
    firstName: string;
    gender: "male" | "female";
    title?: string;
    standardRating?: number;
    rapidRating?: number;
    blitzRating?: number;
    worldRank?: number;
    nationalRank?: number;
    photo?: string;
    age?: number;
    birthYear?: number;
  } | null>(null);

  const displayName = activeProfile?.displayName ?? "";
  const lichessToken = activeProfile?.lichessToken ?? "";

  const loadMainAccountData = useCallback(async () => {
    const fideId = activeProfile?.fideId?.trim() ?? "";
    if (!fideId) {
      setFidePlayer(null);
      return;
    }

    try {
      const player = await fetchFidePlayer(fideId);
      if (!player) {
        setFidePlayer(null);
        return;
      }

      setFidePlayer({
        name: player.name,
        firstName: player.firstName,
        gender: player.gender,
        title: player.title,
        standardRating: player.standardRating ?? player.rating,
        rapidRating: player.rapidRating,
        blitzRating: player.blitzRating,
        worldRank: player.worldRank,
        nationalRank: player.nationalRank,
        photo: player.photo,
        age: player.age,
        birthYear: player.birthYear,
      });
    } catch {
      setFidePlayer(null);
    }
  }, [activeProfile?.fideId]);

  useEffect(() => {
    void loadMainAccountData();
  }, [loadMainAccountData]);

  const sumLichessPerfGames = useCallback((perfs: unknown) => {
    if (!perfs || typeof perfs !== "object") return 0;
    let total = 0;
    for (const value of Object.values(perfs as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      if (!("games" in value)) continue;
      const games = (value as { games?: unknown }).games;
      if (typeof games === "number") total += games;
    }
    return total;
  }, []);

  const getSessionGameCount = useCallback(
    (session: Session | undefined) => {
      if (!session) return 0;
      let total = 0;

      total += sumLichessPerfGames(session.lichess?.account?.perfs);

      const chessComStats = session.chessCom?.stats;
      if (chessComStats) {
        const addPerf = (perf?: { record?: { win: number; loss: number; draw: number } }) => {
          if (!perf?.record) return;
          total += (perf.record.win ?? 0) + (perf.record.loss ?? 0) + (perf.record.draw ?? 0);
        };
        addPerf(chessComStats.chess_daily);
        addPerf(chessComStats.chess_rapid);
        addPerf(chessComStats.chess_blitz);
        addPerf(chessComStats.chess_bullet);
      }

      return total;
    },
    [sumLichessPerfGames],
  );

  // Find the main session - prioritize exact username matches over player name matches
  // This ensures we pick the most active account (by games played) for the main card
  const mainSession = useMemo(() => {
    if (!activeProfileSessions.length) return undefined;
    const sorted = [...activeProfileSessions].sort((a, b) => {
      const gamesDiff = getSessionGameCount(b) - getSessionGameCount(a);
      if (gamesDiff !== 0) return gamesDiff;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
    return sorted[0];
  }, [activeProfileSessions, getSessionGameCount]);

  // Calculate average online rating based on time controls with more than 10 games
  const averageOnlineRating = calculateOnlineRating(mainSession);

  let user = {
    name: activeProfile?.name ?? t("dashboard.noMainAccount"),
    handle: "",
    rating: averageOnlineRating,
  };
  let ratingHistory: { classical?: number; rapid?: number; blitz?: number; bullet?: number } = {};
  let platform: "lichess" | "chesscom" | null = null;
  if (mainSession?.lichess?.account) {
    platform = "lichess";
    const acc = mainSession.lichess.account;
    user = {
      name: acc.username,
      handle: `@${acc.username}`,
      rating: averageOnlineRating,
    };
    const classical = acc.perfs?.classical?.rating;
    const rapid = acc.perfs?.rapid?.rating;
    const blitz = acc.perfs?.blitz?.rating;
    const bullet = acc.perfs?.bullet?.rating;
    ratingHistory = { classical, rapid, blitz, bullet };
  } else if (mainSession?.chessCom?.stats) {
    platform = "chesscom";
    const stats = mainSession.chessCom.stats;
    user = {
      name: mainSession.chessCom.username,
      handle: `@${mainSession.chessCom.username}`,
      rating: averageOnlineRating,
    };
    const rapid = stats.chess_rapid?.last?.rating;
    const blitz = stats.chess_blitz?.last?.rating;
    const bullet = stats.chess_bullet?.last?.rating;
    ratingHistory = { rapid, blitz, bullet };
  }

  // Memoize fideInfo to ensure WelcomeCard updates when fidePlayer changes
  const fideInfo = useMemo(() => {
    if (!fidePlayer) return undefined;
    return {
      title: fidePlayer.title,
      standardRating: fidePlayer.standardRating,
      rapidRating: fidePlayer.rapidRating,
      blitzRating: fidePlayer.blitzRating,
      worldRank: fidePlayer.worldRank,
      nationalRank: fidePlayer.nationalRank,
      photo: fidePlayer.photo,
      age: fidePlayer.age,
    };
  }, [fidePlayer]);

  const lichessUsernames = profileLichessUsernames;
  const chessComUsernames = profileChessComUsernames;

  const [recentGames, setRecentGames] = useState<GameRecord[]>([]);
  const [gameHistoryLimit, setGameHistoryLimit] = useState(100);

  const getOrientationFromFen = useCallback((fen?: string | null) => {
    if (!fen) return null;
    const parts = fen.trim().split(/\s+/);
    const turn = parts[1];
    if (turn === "w") return "white";
    if (turn === "b") return "black";
    return null;
  }, []);

  const getOrientationFromPgn = useCallback(
    (pgn?: string | null) => {
      if (!pgn) return null;
      const match = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
      return getOrientationFromFen(match?.[1]);
    },
    [getOrientationFromFen],
  );

  const loadGames = useCallback(async () => {
    try {
      const games = await getRecentGames(gameHistoryLimit);
      // Filter out games with less than 5 moves
      const filteredGames = games.filter((g) => {
        // Filter out games with no moves or less than 5 moves
        if (!g.moves || g.moves.length === 0) return false;
        return g.moves.length >= 5;
      });
      const profileFiltered =
        activeProfileId == null
          ? filteredGames
          : filteredGames.filter((g) => !g.profileId || g.profileId === activeProfileId);
      setRecentGames(profileFiltered);
    } catch {}
  }, [activeProfileId, gameHistoryLimit]);

  useEffect(() => {
    loadGames();

    // Listen for games:updated event to refresh local games after analysis
    const handleGamesUpdated = () => {
      loadGames();
    };
    window.addEventListener("games:updated", handleGamesUpdated);

    return () => {
      window.removeEventListener("games:updated", handleGamesUpdated);
    };
  }, [loadGames]);

  const [lichessGames, setLichessGames] = useState<
    Array<{
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
    }>
  >([]);
  const [isLoadingLichessGames, setIsLoadingLichessGames] = useState(false);
  useEffect(() => {
    const hasEnoughMoves = (pgn?: string | null) => {
      if (!pgn) return false;
      try {
        const movesSection = pgn.split(/\n\n/)[1] || pgn;
        const cleanMoves = movesSection
          .replace(/\[[^\]]*\]/g, "")
          .replace(/\{[^}]*\}/g, "")
          .replace(/\([^)]*\)/g, "");
        const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
        const matches = cleanMoves.match(movePattern) || [];
        return matches.length >= 5;
      } catch {
        return false;
      }
    };

    const loadGamesFromProfileDatabase = async () => {
      setLichessGames([]);

      if (!activeProfileId) {
        setIsLoadingLichessGames(false);
        return;
      }

      setIsLoadingLichessGames(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        const queryResult = await query_games(dbPath, {
          options: {
            page: 1,
            pageSize: gameHistoryLimit,
            sort: "date",
            direction: "desc",
            skipCount: true,
          },
        });

        const analyzedGames = await getAllAnalyzedGames();
        const games = (queryResult.data ?? [])
          .filter((g) => g.site?.toLowerCase().includes("lichess.org"))
          .map(convertNormalizedToLichessGame)
          .filter((g) => hasEnoughMoves(g.pgn))
          .slice(0, gameHistoryLimit)
          .map((g) => (analyzedGames[g.id] ? { ...g, pgn: analyzedGames[g.id] } : g));

        setLichessGames(games);
      } catch {
      } finally {
        setIsLoadingLichessGames(false);
      }
    };

    void loadGamesFromProfileDatabase();

    const handleLichessGamesUpdated = async () => {
      setIsLoadingLichessGames(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await loadGamesFromProfileDatabase();
    };

    window.addEventListener("lichess:games:updated", handleLichessGamesUpdated);

    return () => {
      window.removeEventListener("lichess:games:updated", handleLichessGamesUpdated);
    };
  }, [activeProfileId, gameHistoryLimit]);

  const [chessComGames, setChessComGames] = useState<ChessComGame[]>([]);
  const [isLoadingChessComGames, setIsLoadingChessComGames] = useState(false);
  useEffect(() => {
    const hasEnoughMoves = (pgn?: string | null) => {
      if (!pgn) return false;
      try {
        const movesSection = pgn.split(/\n\n/)[1] || pgn;
        const cleanMoves = movesSection
          .replace(/\[[^\]]*\]/g, "")
          .replace(/\{[^}]*\}/g, "")
          .replace(/\([^)]*\)/g, "");
        const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
        const matches = cleanMoves.match(movePattern) || [];
        return matches.length >= 5;
      } catch {
        return false;
      }
    };

    const loadGamesFromProfileDatabase = async () => {
      setChessComGames([]);

      if (!activeProfileId) {
        setIsLoadingChessComGames(false);
        return;
      }

      setIsLoadingChessComGames(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      try {
        const dbPath = await getProfileDbPath(activeProfileId);
        const queryResult = await query_games(dbPath, {
          options: {
            page: 1,
            pageSize: gameHistoryLimit,
            sort: "date",
            direction: "desc",
            skipCount: true,
          },
        });

        const analyzedGames = await getAllAnalyzedGames();
        const games = (queryResult.data ?? [])
          .filter((g) => g.site?.toLowerCase().includes("chess.com"))
          .map(convertNormalizedToChessComGame)
          .filter((g) => hasEnoughMoves(g.pgn))
          .slice(0, gameHistoryLimit)
          .map((g) => (analyzedGames[g.url] ? { ...g, pgn: analyzedGames[g.url] } : g));

        setChessComGames(games);
      } catch {
      } finally {
        setIsLoadingChessComGames(false);
      }
    };

    void loadGamesFromProfileDatabase();

    const handleChessComGamesUpdated = async () => {
      setIsLoadingChessComGames(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await loadGamesFromProfileDatabase();
    };

    window.addEventListener("chesscom:games:updated", handleChessComGamesUpdated);

    return () => {
      window.removeEventListener("chesscom:games:updated", handleChessComGamesUpdated);
    };
  }, [activeProfileId, gameHistoryLimit]);

  const [puzzleStats, setPuzzleStats] = useState(() => getPuzzleStats());
  const [favoriteGames, setFavoriteGames] = useState<FavoriteGame[]>([]);

  // Load favorite games
  const loadFavoriteGames = useCallback(async () => {
    try {
      const favorites = await getAllFavoriteGames();
      setFavoriteGames(favorites);
    } catch {}
  }, []);

  useEffect(() => {
    loadFavoriteGames();

    const handleFavoritesUpdated = () => {
      loadFavoriteGames();
    };
    window.addEventListener("favorites:updated", handleFavoritesUpdated);

    return () => {
      window.removeEventListener("favorites:updated", handleFavoritesUpdated);
    };
  }, [loadFavoriteGames]);
  useEffect(() => {
    const update = () => setPuzzleStats(getPuzzleStats());
    const onVisibility = () => {
      if (!document.hidden) update();
    };
    window.addEventListener("storage", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const PLAY_CHESS = {
    icon: <IconChess size={50} />,
    title: t("features.dashboard.cards.playChess.title"),
    description: t("features.dashboard.cards.playChess.desc"),
    label: t("features.dashboard.cards.playChess.button"),
    onClick: () => {
      const uuid = genID();
      setTabs((prev: Tab[]) => {
        return [
          ...prev,
          {
            value: uuid,
            name: t("features.dashboard.newGame"),
            type: "play",
          },
        ];
      });
      setActiveTab(uuid);
      navigate({ to: "/play" });
    },
  };

  const quickActions: {
    icon: React.ReactNode;
    title: string;
    description: string;
    onClick: () => void;
    color: MantineColor;
  }[] = [
    {
      icon: <IconClock />,
      title: t("chess.timeControl.classical"),
      description: t("dashboard.timeControlCards.classicalDesc"),
      onClick: () => {
        const uuid = genID();
        setTabs((prev: Tab[]) => {
          return [
            ...prev,
            {
              value: uuid,
              name: t("chess.timeControl.classical"),
              type: "play",
              meta: {
                timeControl: {
                  seconds: 30 * 60 * 1000,
                  increment: 0,
                },
              },
            },
          ];
        });
        setActiveTab(uuid);
        navigate({ to: "/play" });
      },
      color: "blue.6",
    },
    {
      icon: <IconStopwatch />,
      title: t("chess.timeControl.rapid"),
      description: t("dashboard.timeControlCards.rapidDesc"),
      onClick: () => {
        const uuid = genID();
        setTabs((prev: Tab[]) => {
          return [
            ...prev,
            {
              value: uuid,
              name: t("chess.timeControl.rapid"),
              type: "play",
              meta: {
                timeControl: {
                  seconds: 10 * 60 * 1000,
                  increment: 0,
                },
              },
            },
          ];
        });
        setActiveTab(uuid);
        navigate({ to: "/play" });
      },
      color: "teal.6",
    },
    {
      icon: <IconBolt />,
      title: t("chess.timeControl.blitz"),
      description: t("dashboard.timeControlCards.blitzDesc"),
      onClick: () => {
        const uuid = genID();
        setTabs((prev: Tab[]) => {
          return [
            ...prev,
            {
              value: uuid,
              name: t("chess.timeControl.blitz"),
              type: "play",
              meta: {
                timeControl: {
                  seconds: 3 * 60 * 1000,
                  increment: 0,
                },
              },
            },
          ];
        });
        setActiveTab(uuid);
        navigate({ to: "/play" });
      },
      color: "yellow.6",
    },
    {
      icon: <IconBolt />,
      title: t("chess.timeControl.bullet"),
      description: t("dashboard.timeControlCards.bulletDesc"),
      onClick: () => {
        const uuid = genID();
        setTabs((prev: Tab[]) => {
          return [
            ...prev,
            {
              value: uuid,
              name: t("chess.timeControl.bullet"),
              type: "play",
              meta: {
                timeControl: {
                  seconds: 1 * 60 * 1000,
                  increment: 0,
                },
              },
            },
          ];
        });
        setActiveTab(uuid);
        navigate({ to: "/play" });
      },
      color: "blue.6",
    },
  ];

  return (
    <Box style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" }}>
      <Stack p="md" gap="md" style={{ minHeight: "100%" }}>
        <WelcomeCard
          isFirstOpen={isFirstOpen}
          onPlayChess={PLAY_CHESS.onClick}
          onImportGame={() => {
            navigate({ to: "/analysis" });
            modals.openContextModal({
              modal: "importModal",
              innerProps: {},
            });
          }}
          playerFirstName={displayName || fidePlayer?.firstName || undefined}
          playerGender={fidePlayer?.gender}
          fideInfo={fideInfo}
        />

        <Group justify="flex-end" align="center" gap="xs">
          <Text size="xs" c="dimmed">
            Profile
          </Text>
          <Group gap={4} wrap="nowrap">
            {topProfileOptions.map((p) => (
              <Button
                key={p.id}
                size="xs"
                radius="xl"
                variant={p.id === activeProfileId ? "light" : "subtle"}
                onClick={() => setActiveProfileId(p.id)}
                styles={{
                  root: { paddingInline: 10, minHeight: 28 },
                }}
              >
                {p.name}
              </Button>
            ))}
            {otherProfileOptions.length > 0 && (
              <Select
                size="xs"
                radius="xl"
                w={180}
                value={otherProfileOptions.some((p) => p.id === activeProfileId) ? activeProfileId : null}
                onChange={(value) => {
                  if (value) setActiveProfileId(value);
                }}
                data={otherProfileOptions.map((p) => ({ value: p.id, label: p.name }))}
                placeholder="More"
                clearable={false}
                styles={{
                  input: { backgroundColor: "var(--mantine-color-dark-6)", borderColor: "var(--mantine-color-dark-4)" },
                }}
              />
            )}
          </Group>
        </Group>

        <Grid>
          <Grid.Col span={{ base: 12, sm: 12, md: 4, lg: 3, xl: 3 }}>
            <UserProfileCard
              name={user.name}
              handle={user.handle}
              title={fidePlayer?.title || getChessTitle(user.rating)}
              ratingHistory={ratingHistory}
              customName={displayName}
              platform={platform}
              onFideUpdate={async (newFideId, newFidePlayer, newDisplayName, newLichessToken) => {
                if (!activeProfileId) return;

                const now = Date.now();
                const cleanedFideId = newFideId.trim().replace(/\D/g, "");
                const nextDisplayName = (newDisplayName ?? "").trim();
                const nextToken = (newLichessToken ?? "").trim();

                setProfiles((prev) =>
                  prev.map((p) =>
                    p.id === activeProfileId
                      ? {
                          ...p,
                          fideId: cleanedFideId || undefined,
                          displayName: nextDisplayName || undefined,
                          lichessToken: nextToken || undefined,
                          updatedAt: now,
                        }
                      : p,
                  ),
                );

                if (!cleanedFideId) {
                  setFidePlayer(null);
                  return;
                }

                if (newFidePlayer) {
                  setFidePlayer({ ...newFidePlayer });
                } else {
                  setFidePlayer(null);
                }
              }}
              fidePlayer={fidePlayer}
              currentFideId={activeProfile?.fideId || undefined}
              currentLichessToken={lichessToken}
            />
          </Grid.Col>

          <Grid.Col span={{ base: 12, sm: 12, md: 8, lg: 9, xl: 9 }}>
            <QuickActionsGrid actions={quickActions} />
          </Grid.Col>
        </Grid>

        <Grid>
          <Grid.Col span={12}>
            <GamesHistoryCard
              activeTab={activeGamesTab}
              onTabChange={setActiveGamesTab}
              localGames={recentGames}
              gameHistoryLimit={gameHistoryLimit}
              onGameHistoryLimitChange={setGameHistoryLimit}
              onAnalyzeAll={handleAnalyzeAll}
              onDeleteLocalGame={async (gameId: string) => {
                await deleteGameRecord(gameId);
                const updatedGames = await getRecentGames(gameHistoryLimit);
                const filteredGames = updatedGames.filter((g) => g.moves.length >= 5);
                const profileFiltered =
                  activeProfileId == null
                    ? filteredGames
                    : filteredGames.filter((g) => !g.profileId || g.profileId === activeProfileId);
                setRecentGames(profileFiltered);
              }}
              chessComGames={chessComGames}
              lichessGames={lichessGames}
              profileUsernames={profileUsernames}
              isLoadingOnlineGames={isLoadingChessComGames || isLoadingLichessGames}
              onAnalyzeLocalGame={(game) => {
                const headers = createLocalGameHeaders(game);
                const pgn = game.pgn || createPGNFromMoves(game.moves, game.result, game.initialFen);
                const isUserWhite = game.white.type === "human";
                const isUserBlack = game.black.type === "human";
                const orientation = isUserWhite
                  ? "white"
                  : isUserBlack
                    ? "black"
                    : getOrientationFromFen(game.initialFen) || getOrientationFromPgn(pgn) || "white";
                headers.orientation = orientation;
                createTab({
                  tab: {
                    name: `${headers.white} - ${headers.black}`,
                    type: "analysis",
                  },
                  setTabs,
                  setActiveTab,
                  pgn,
                  headers,
                  initialAnalysisTab: "analysis",
                  initialAnalysisSubTab: "report",
                  initialNotationView: "report",
                }).then((tabId) => {
                  // Store the gameId in sessionStorage so we can update it when analysis completes
                  if (tabId && typeof window !== "undefined") {
                    sessionStorage.setItem(`${tabId}_localGameId`, game.id);
                  }
                });
              }}
              onAnalyzeChessComGame={(game) => {
                if (game.pgn) {
                  const headers = createChessComGameHeaders(game);
                  const accountUsername =
                    chessComUsernames.find(
                      (u) =>
                        u.toLowerCase() === game.white.username.toLowerCase() ||
                        u.toLowerCase() === game.black.username.toLowerCase(),
                    ) || game.white.username;
                  const isUserWhite = game.white.username.toLowerCase() === accountUsername.toLowerCase();
                  const orientation = isUserWhite ? "white" : "black";
                  headers.orientation = orientation;
                  createTab({
                    tab: {
                      name: `${game.white.username} - ${game.black.username}`,
                      type: "analysis",
                    },
                    setTabs,
                    setActiveTab,
                    pgn: game.pgn,
                    headers,
                    initialAnalysisTab: "analysis",
                    initialAnalysisSubTab: "report",
                    initialNotationView: "report",
                  }).then((tabId) => {
                    // Store the game URL and username in sessionStorage so we can save the analyzed PGN when analysis completes
                    if (tabId && typeof window !== "undefined") {
                      sessionStorage.setItem(`${tabId}_chessComGameUrl`, game.url);
                      sessionStorage.setItem(`${tabId}_chessComUsername`, accountUsername);
                    }
                  });
                }
              }}
              onAnalyzeLichessGame={(game) => {
                if (game.pgn) {
                  const headers = createLichessGameHeaders(game);
                  const gameWhiteName = game.players.white.user?.name || "";
                  const gameBlackName = game.players.black.user?.name || "";
                  const accountUsername =
                    lichessUsernames.find(
                      (u) =>
                        u.toLowerCase() === gameWhiteName.toLowerCase() ||
                        u.toLowerCase() === gameBlackName.toLowerCase(),
                    ) || gameWhiteName;
                  const isUserWhite = gameWhiteName.toLowerCase() === accountUsername.toLowerCase();
                  const orientation = isUserWhite ? "white" : "black";
                  headers.orientation = orientation;
                  createTab({
                    tab: {
                      name: `${headers.white} - ${headers.black}`,
                      type: "analysis",
                    },
                    setTabs,
                    setActiveTab,
                    pgn: game.pgn,
                    headers,
                    initialAnalysisTab: "analysis",
                    initialAnalysisSubTab: "report",
                    initialNotationView: "report",
                  }).then((tabId) => {
                    // Store the game ID and username in sessionStorage so we can save the analyzed PGN when analysis completes
                    if (tabId && typeof window !== "undefined") {
                      sessionStorage.setItem(`${tabId}_lichessGameId`, game.id);
                      sessionStorage.setItem(`${tabId}_lichessUsername`, accountUsername);
                    }
                  });
                }
              }}
              onToggleFavoriteLocal={async (gameId: string) => {
                const isFavorite = await isFavoriteGame(gameId, "local");
                if (isFavorite) {
                  await removeFavoriteGame(gameId, "local");
                } else {
                  await saveFavoriteGame(gameId, "local");
                }
                loadFavoriteGames();
              }}
              onToggleFavoriteChessCom={async (gameId: string) => {
                const isFavorite = await isFavoriteGame(gameId, "chesscom");
                if (isFavorite) {
                  await removeFavoriteGame(gameId, "chesscom");
                } else {
                  await saveFavoriteGame(gameId, "chesscom");
                }
                loadFavoriteGames();
              }}
              onToggleFavoriteLichess={async (gameId: string) => {
                const isFavorite = await isFavoriteGame(gameId, "lichess");
                if (isFavorite) {
                  await removeFavoriteGame(gameId, "lichess");
                } else {
                  await saveFavoriteGame(gameId, "lichess");
                }
                loadFavoriteGames();
              }}
              favoriteGames={favoriteGames}
            />
          </Grid.Col>
        </Grid>

        <Grid>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <PuzzleStatsCard
              stats={puzzleStats}
              onStartPuzzles={() => {
                createTab({
                  tab: { name: t("features.tabs.puzzle.title"), type: "puzzles" },
                  setTabs,
                  setActiveTab,
                });
                navigate({ to: "/puzzles" });
              }}
            />
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 6 }}>
            <PuzzleVariantsCard />
          </Grid.Col>
        </Grid>

        <PlayerStatsModal
          opened={playerStatsModalOpened}
          onClose={() => {
            setPlayerStatsModalOpened(false);
            setPlayerStatsResult(null);
            setPlayerStatsDebugPgns(null);
          }}
          result={playerStatsResult}
          debugPgns={playerStatsDebugPgns || undefined}
          statsGameType={playerStatsGameType || undefined}
          statsAccountName={playerStatsAccountName || undefined}
        />

        <AnalyzeAllModal
          opened={analyzeAllModalOpened}
          onClose={() => {
            setAnalyzeAllModalOpened(false);
            setAnalyzeAllGameType(null);
            setUnanalyzedGameCount(null);
          }}
          onAnalyze={async (config, onProgress, isCancelled) => {
            if (!defaultEngine) {
              notifications.show({
                title: t("features.dashboard.noEngineAvailable"),
                message: t("features.dashboard.noEngineAvailableMessage"),
                color: "red",
              });
              return;
            }

            // Get all analyzed games to filter out already analyzed ones if needed
            const analyzedGames = await getAllAnalyzedGames();

            const getFilteredGames = (type: "local" | "chesscom" | "lichess") => {
              if (type === "local") {
                return recentGames.filter((g) => {
                  if (!g.moves || g.moves.length === 0) return false;
                  return g.moves.length >= 5;
                });
              } else if (type === "chesscom") {
                return chessComGames.filter((g) => {
                  if (!g.pgn) return false;
                  try {
                    const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                    const cleanMoves = movesSection
                      .replace(/\[[^\]]*\]/g, "")
                      .replace(/\{[^}]*\}/g, "")
                      .replace(/\([^)]*\)/g, "");
                    const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                    const matches = cleanMoves.match(movePattern) || [];
                    return matches.length >= 5;
                  } catch {
                    return false;
                  }
                });
              } else {
                // lichess
                return lichessGames.filter((g) => {
                  if (!g.pgn) return false;
                  try {
                    const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                    const cleanMoves = movesSection
                      .replace(/\[[^\]]*\]/g, "")
                      .replace(/\{[^}]*\}/g, "")
                      .replace(/\([^)]*\)/g, "");
                    const movePattern =
                      /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                    const matches = cleanMoves.match(movePattern) || [];
                    return matches.length >= 5;
                  } catch {
                    return false;
                  }
                });
              }
            };

            const allGames =
              analyzeAllGameType === "all"
                ? [
                    ...getFilteredGames("local").map((g) => ({ type: "local" as const, game: g })),
                    ...getFilteredGames("chesscom").map((g) => ({ type: "chesscom" as const, game: g })),
                    ...getFilteredGames("lichess").map((g) => ({ type: "lichess" as const, game: g })),
                  ]
                : analyzeAllGameType === "local"
                  ? getFilteredGames("local").map((g) => ({ type: "local" as const, game: g }))
                  : analyzeAllGameType === "chesscom"
                    ? getFilteredGames("chesscom").map((g) => ({ type: "chesscom" as const, game: g }))
                    : analyzeAllGameType === "lichess"
                      ? getFilteredGames("lichess").map((g) => ({ type: "lichess" as const, game: g }))
                      : [];

            // Filter to only unanalyzed games if requested
            const gamesToAnalyze =
              config.analyzeMode === "unanalyzed"
                ? allGames.filter((item) => {
                    if (item.type === "local") {
                      const gameRecord = item.game as GameRecord;
                      // For local games, check if PGN exists and has analysis annotations
                      // If PGN exists but doesn't have analysis markers, consider it unanalyzed
                      if (!gameRecord.pgn) return true;
                      // Check if PGN has analysis annotations (evaluation comments, NAGs, etc.)
                      const hasAnalysis = /\[%eval|\[%clk|\$[0-9]|!!|!\?|\?!/i.test(gameRecord.pgn);
                      return !hasAnalysis;
                    } else if (item.type === "chesscom") {
                      const chessComGame = item.game as ChessComGame;
                      // Check if this game has been analyzed
                      return !analyzedGames[chessComGame.url];
                    } else {
                      // lichess
                      const lichessGame = item.game as (typeof lichessGames)[0];
                      // Check if this game has been analyzed
                      return !analyzedGames[lichessGame.id];
                    }
                  })
                : allGames;

            if (gamesToAnalyze.length === 0) {
              notifications.show({
                title: "No Games to Analyze",
                message:
                  config.analyzeMode === "unanalyzed"
                    ? "No unanalyzed games available to analyze."
                    : "No games with PGN data available to analyze.",
                color: "orange",
              });
              return;
            }

            const goMode: GoMode = { t: "Time", c: config.timeMs };
            const engineSettings = (defaultEngine.settings ?? []).map((s) => ({
              ...s,
              value: s.value?.toString() ?? "",
            }));

            // Detect available CPU threads and calculate parallel analysis count (25% of available threads)
            const availableThreads = navigator.hardwareConcurrency || 4;
            const parallelAnalyses = Math.max(1, Math.floor(availableThreads / 4));

            // Force Threads to 1 for each individual analysis, regardless of engine configuration
            const threadsSetting = engineSettings.find((s) => s.name.toLowerCase() === "threads");
            if (threadsSetting) {
              threadsSetting.value = "1";
            } else {
              // Add Threads setting if it doesn't exist
              engineSettings.push({ name: "Threads", value: "1" });
            }

            // Create directory for analyzed games
            const baseDir = await appDataDir();
            const analyzedDir = await resolve(baseDir, "analyzed-games");
            await mkdir(analyzedDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const folderName = `${analyzedDir}/${analyzeAllGameType}-analyzed-${timestamp}`;
            await mkdir(folderName, { recursive: true });

            notifications.show({
              title: t("features.dashboard.analysisStarted"),
              message: `Analyzing ${gamesToAnalyze.length} games...`,
              color: "blue",
            });

            let successCount = 0;
            let failCount = 0;
            const activeAnalysisIds = new Set<string>();
            let completedCount = 0;

            // Process games in parallel batches
            const processGame = async (item: (typeof gamesToAnalyze)[0], index: number): Promise<void> => {
              const gameType = item.type;
              const game = item.game;
              const analysisId = `analyze_all_${gameType}_${index}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              activeAnalysisIds.add(analysisId);

              try {
                let tree: TreeState;
                let moves: string[];
                let initialFen: string;
                let gameHeaders: ReturnType<
                  typeof createLocalGameHeaders | typeof createChessComGameHeaders | typeof createLichessGameHeaders
                >;

                if (gameType === "local") {
                  // For local games, use PGN if available, otherwise reconstruct from moves
                  const gameRecord = game as GameRecord;
                  const pgn =
                    gameRecord.pgn || createPGNFromMoves(gameRecord.moves, gameRecord.result, gameRecord.initialFen);
                  tree = await parsePGN(pgn, gameRecord.initialFen);
                  moves = gameRecord.moves;
                  initialFen = gameRecord.initialFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
                  gameHeaders = createLocalGameHeaders(gameRecord);
                } else if (gameType === "chesscom") {
                  // For Chess.com games, parse PGN
                  const chessComGame = game as ChessComGame;
                  const pgn = chessComGame.pgn;
                  if (!pgn) {
                    activeAnalysisIds.delete(analysisId);
                    return;
                  }
                  tree = await parsePGN(pgn);
                  // Extract UCI moves from the main line using getMainLine
                  const is960 = tree.headers?.variant === "Chess960";
                  moves = getMainLine(tree.root, is960);
                  initialFen = tree.headers?.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
                  gameHeaders = createChessComGameHeaders(chessComGame);
                } else {
                  // Lichess games
                  const lichessGame = game as (typeof lichessGames)[0];
                  const pgn = lichessGame.pgn;
                  if (!pgn) {
                    activeAnalysisIds.delete(analysisId);
                    return;
                  }
                  tree = await parsePGN(pgn);
                  // Extract UCI moves from the main line using getMainLine
                  const is960 = tree.headers?.variant === "Chess960";
                  moves = getMainLine(tree.root, is960);
                  initialFen = tree.headers?.fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
                  gameHeaders = createLichessGameHeaders(lichessGame);
                }

                // Check if cancelled before starting analysis
                if (isCancelled()) {
                  activeAnalysisIds.delete(analysisId);
                  return;
                }

                // Analyze the game
                const analysisPromise = commands.analyzeGame(
                  analysisId,
                  defaultEngine.path,
                  goMode,
                  {
                    annotateNovelties: false,
                    fen: initialFen,
                    referenceDb: null,
                    reversed: false,
                    moves,
                  },
                  engineSettings,
                );

                // Check for cancellation while analysis is running
                let analysisCancelled = false;
                const cancellationCheckInterval = setInterval(() => {
                  if (isCancelled()) {
                    analysisCancelled = true;
                    // Stop the engine immediately
                    commands.stopEngine(defaultEngine.path, analysisId).catch(() => {
                      // Ignore errors when stopping
                    });
                    clearInterval(cancellationCheckInterval);
                  }
                }, 50); // Check more frequently for faster cancellation

                let analysisResult: Awaited<typeof analysisPromise>;
                try {
                  analysisResult = await analysisPromise;
                } catch (_error) {
                  clearInterval(cancellationCheckInterval);
                  // If cancelled, stop the engine and return
                  if (analysisCancelled || isCancelled()) {
                    try {
                      await commands.stopEngine(defaultEngine.path, analysisId);
                    } catch {
                      // Ignore errors when stopping
                    }
                    activeAnalysisIds.delete(analysisId);
                    return;
                  }
                  throw _error;
                }

                clearInterval(cancellationCheckInterval);

                // Check again if cancelled after analysis
                if (isCancelled() || analysisCancelled) {
                  activeAnalysisIds.delete(analysisId);
                  return;
                }

                const analysis = unwrap(analysisResult);

                // Use the same addAnalysis function from the store to ensure consistency
                const { addAnalysis } = await import("@/state/store/tree");

                // Apply analysis using the same function used in individual analysis
                addAnalysis(tree, analysis);

                // Update tree headers with gameHeaders to ensure names are included
                tree.headers = {
                  ...tree.headers,
                  ...gameHeaders,
                  fen: tree.headers.fen || gameHeaders.fen, // Preserve FEN from parsed PGN
                };

                // Check if cancelled before saving
                if (isCancelled()) {
                  activeAnalysisIds.delete(analysisId);
                  return;
                }

                // Generate PGN with analysis
                let analyzedPgn = getPGN(tree.root, {
                  headers: tree.headers,
                  comments: true,
                  extraMarkups: true,
                  glyphs: true,
                  variations: true,
                });

                // Validate and fix PGN before saving
                if (!analyzedPgn || analyzedPgn.trim().length === 0) {
                  activeAnalysisIds.delete(analysisId);
                  return;
                }

                // Ensure PGN has a result (required for valid PGN)
                const hasResult =
                  /\[Result\s+"[^"]+"\]/.test(analyzedPgn) || /\s+(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(analyzedPgn);
                if (!hasResult && tree.headers?.result) {
                  analyzedPgn = `${analyzedPgn.trim()} ${tree.headers.result}`;
                } else if (!hasResult) {
                  analyzedPgn = `${analyzedPgn.trim()} *`;
                }

                // Only save if analysis was not cancelled
                if (!isCancelled() && !analysisCancelled) {
                  // Save analyzed PGN to file
                  const fileName = `${gameHeaders.white}-${gameHeaders.black}-${index + 1}`.replace(
                    /[<>:"/\\|?*]/g,
                    "_",
                  );
                  const filePath = await resolve(folderName, `${fileName}.pgn`);

                  await writeTextFile(filePath, analyzedPgn);

                  // Calculate stats from the analyzed game
                  const reportStats = getGameStats(tree.root);

                  // Update the game object with the analyzed PGN and stats
                  if (gameType === "local") {
                    const gameRecord = game as GameRecord;

                    // Determine which color the user played
                    const isUserWhite = gameRecord.white.type === "human";
                    const userColor = isUserWhite ? "white" : "black";

                    // Get stats for the user's color from the report
                    const accuracy = userColor === "white" ? reportStats.whiteAccuracy : reportStats.blackAccuracy;
                    const acpl = userColor === "white" ? reportStats.whiteCPL : reportStats.blackCPL;

                    // Calculate estimated Elo
                    let calculatedStats: GameStats | null = null;
                    if (accuracy > 0 || acpl > 0) {
                      calculatedStats = {
                        accuracy,
                        acpl,
                        estimatedElo: acpl > 0 ? calculateEstimatedElo(acpl) : undefined,
                      };
                    }

                    // Update the game record with analyzed PGN and stats
                    if (calculatedStats) {
                      await updateGameRecord(gameRecord.id, { pgn: analyzedPgn, stats: calculatedStats });
                    } else {
                      await updateGameRecord(gameRecord.id, { pgn: analyzedPgn });
                    }
                  } else if (gameType === "chesscom") {
                    const chessComGame = game as ChessComGame;
                    chessComGame.pgn = analyzedPgn;
                    // Persist the analyzed PGN
                    await saveAnalyzedGame(chessComGame.url, analyzedPgn);

                    // Calculate and save stats
                    const whiteUsername = chessComGame.white.username.toLowerCase();
                    const blackUsername = chessComGame.black.username.toLowerCase();
                    const accountUsername =
                      chessComUsernames
                        .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                        ?.toLowerCase() || whiteUsername;

                    const isUserWhite = whiteUsername === accountUsername;
                    const userColor = isUserWhite ? "white" : "black";

                    const accuracy = userColor === "white" ? reportStats.whiteAccuracy : reportStats.blackAccuracy;
                    const acpl = userColor === "white" ? reportStats.whiteCPL : reportStats.blackCPL;

                    if (accuracy > 0 || acpl > 0) {
                      const stats: GameStats = {
                        accuracy,
                        acpl,
                        estimatedElo: acpl > 0 ? calculateEstimatedElo(acpl) : undefined,
                      };
                      await saveGameStats(chessComGame.url, stats);
                    }

                    // Update the games array to trigger re-render and stats recalculation
                    setChessComGames((prev) => {
                      const updated = [...prev];
                      const index = updated.findIndex((g) => g.url === chessComGame.url);
                      if (index >= 0) {
                        updated[index] = { ...chessComGame };
                      }
                      return updated;
                    });
                  } else {
                    // lichess
                    const lichessGame = game as (typeof lichessGames)[0];
                    lichessGame.pgn = analyzedPgn;
                    // Persist the analyzed PGN
                    await saveAnalyzedGame(lichessGame.id, analyzedPgn);

                    // Calculate and save stats
                    const whiteUsername = (lichessGame.players.white.user?.name || "").toLowerCase();
                    const blackUsername = (lichessGame.players.black.user?.name || "").toLowerCase();
                    const accountUsername =
                      lichessUsernames
                        .find((u) => u.toLowerCase() === whiteUsername || u.toLowerCase() === blackUsername)
                        ?.toLowerCase() || whiteUsername;

                    const isUserWhite = whiteUsername === accountUsername;
                    const userColor = isUserWhite ? "white" : "black";

                    const accuracy = userColor === "white" ? reportStats.whiteAccuracy : reportStats.blackAccuracy;
                    const acpl = userColor === "white" ? reportStats.whiteCPL : reportStats.blackCPL;

                    if (accuracy > 0 || acpl > 0) {
                      const stats: GameStats = {
                        accuracy,
                        acpl,
                        estimatedElo: acpl > 0 ? calculateEstimatedElo(acpl) : undefined,
                      };
                      await saveGameStats(lichessGame.id, stats);
                    }

                    // Update the games array to trigger re-render and stats recalculation
                    setLichessGames((prev) => {
                      const updated = [...prev];
                      const index = updated.findIndex((g) => g.id === lichessGame.id);
                      if (index >= 0) {
                        updated[index] = { ...lichessGame };
                      }
                      return updated;
                    });
                  }

                  successCount++;
                }
              } catch (_error) {
                failCount++;
              } finally {
                activeAnalysisIds.delete(analysisId);
                completedCount++;

                // Update progress
                onProgress(completedCount, gamesToAnalyze.length);

                // Update notifications less frequently
                if (completedCount % 10 === 0 || completedCount === gamesToAnalyze.length) {
                  notifications.show({
                    title: t("features.dashboard.analysisProgress"),
                    message: `Analyzed ${completedCount}/${gamesToAnalyze.length} games (${successCount} success, ${failCount} failed)`,
                    color: "blue",
                  });
                }
              }
            };

            // Process games in parallel batches
            for (let i = 0; i < gamesToAnalyze.length; i += parallelAnalyses) {
              // Check if analysis was cancelled
              if (isCancelled()) {
                // Stop all active engines
                for (const analysisId of activeAnalysisIds) {
                  try {
                    await commands.stopEngine(defaultEngine.path, analysisId);
                  } catch {
                    // Ignore errors when stopping
                  }
                }
                notifications.show({
                  title: t("features.dashboard.analysisCancelled"),
                  message: `Analysis stopped. ${successCount} games analyzed successfully.`,
                  color: "yellow",
                });
                break;
              }

              // Get batch of games to process in parallel
              const batch = gamesToAnalyze.slice(i, i + parallelAnalyses);

              // Process batch in parallel
              const batchPromises = batch.map((game, batchIndex) => processGame(game, i + batchIndex));

              // Wait for all games in batch to complete or be cancelled
              // Use allSettled so we can check cancellation status after each completes
              await Promise.allSettled(batchPromises);

              // Check cancellation after batch completes - if cancelled, stop all engines immediately
              if (isCancelled()) {
                // Stop all remaining active engines immediately
                const stopPromises = Array.from(activeAnalysisIds).map((analysisId) =>
                  commands.stopEngine(defaultEngine.path, analysisId).catch(() => {
                    // Ignore errors when stopping
                  }),
                );
                await Promise.all(stopPromises);
                activeAnalysisIds.clear();
                notifications.show({
                  title: t("features.dashboard.analysisCancelled"),
                  message: `Analysis stopped. ${successCount} games analyzed successfully.`,
                  color: "yellow",
                });
                break;
              }
            }

            // Only show completion message if not cancelled
            if (!isCancelled()) {
              // Stop any remaining active engines
              for (const analysisId of activeAnalysisIds) {
                try {
                  await commands.stopEngine(defaultEngine.path, analysisId);
                } catch {
                  // Ignore errors when stopping
                }
              }

              // Final progress update
              onProgress(gamesToAnalyze.length, gamesToAnalyze.length);

              // Refresh games to update stats
              if (analyzeAllGameType === "local" || analyzeAllGameType === "all") {
                const updatedGames = await getRecentGames(gameHistoryLimit);
                const filteredGames = updatedGames.filter((g) => g.moves.length >= 5);
                const profileFiltered =
                  activeProfileId == null
                    ? filteredGames
                    : filteredGames.filter((g) => !g.profileId || g.profileId === activeProfileId);
                setRecentGames(profileFiltered);
              }
              if (analyzeAllGameType === "chesscom" || analyzeAllGameType === "all") {
                // Trigger refresh for Chess.com games
                window.dispatchEvent(new Event("chesscom:games:updated"));
              }
              if (analyzeAllGameType === "lichess" || analyzeAllGameType === "all") {
                // Trigger refresh for Lichess games
                window.dispatchEvent(new Event("lichess:games:updated"));
              }

              notifications.show({
                title: t("features.dashboard.analysisComplete"),
                message: `Analyzed ${successCount} games successfully. Files saved to: ${folderName}`,
                color: "green",
              });
            } else {
              // If cancelled, make sure all engines are stopped
              for (const analysisId of activeAnalysisIds) {
                try {
                  await commands.stopEngine(defaultEngine.path, analysisId);
                } catch {
                  // Ignore errors when stopping
                }
              }
            }
          }}
          gameCount={
            analyzeAllGameType === "all"
              ? recentGames.filter((g) => {
                  if (!g.moves || g.moves.length === 0) return false;
                  return g.moves.length >= 5;
                }).length +
                chessComGames.filter((g) => {
                  if (!g.pgn) return false;
                  try {
                    const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                    const cleanMoves = movesSection
                      .replace(/\[[^\]]*\]/g, "")
                      .replace(/\{[^}]*\}/g, "")
                      .replace(/\([^)]*\)/g, "");
                    const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                    const matches = cleanMoves.match(movePattern) || [];
                    return matches.length >= 5;
                  } catch {
                    return false;
                  }
                }).length +
                lichessGames.filter((g) => {
                  if (!g.pgn) return false;
                  try {
                    const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                    const cleanMoves = movesSection
                      .replace(/\[[^\]]*\]/g, "")
                      .replace(/\{[^}]*\}/g, "")
                      .replace(/\([^)]*\)/g, "");
                    const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                    const matches = cleanMoves.match(movePattern) || [];
                    return matches.length >= 5;
                  } catch {
                    return false;
                  }
                }).length
              : analyzeAllGameType === "local"
                ? recentGames.filter((g) => {
                    if (!g.moves || g.moves.length === 0) return false;
                    return g.moves.length >= 5;
                  }).length
                : analyzeAllGameType === "chesscom"
                  ? chessComGames.filter((g) => {
                      if (!g.pgn) return false;
                      try {
                        const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                        const cleanMoves = movesSection
                          .replace(/\[[^\]]*\]/g, "")
                          .replace(/\{[^}]*\}/g, "")
                          .replace(/\([^)]*\)/g, "");
                        const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                        const matches = cleanMoves.match(movePattern) || [];
                        return matches.length >= 5;
                      } catch {
                        return false;
                      }
                    }).length
                  : analyzeAllGameType === "lichess"
                    ? lichessGames.filter((g) => {
                        if (!g.pgn) return false;
                        try {
                          const movesSection = g.pgn.split(/\n\n/)[1] || g.pgn;
                          const cleanMoves = movesSection
                            .replace(/\[[^\]]*\]/g, "")
                            .replace(/\{[^}]*\}/g, "")
                            .replace(/\([^)]*\)/g, "");
                          const movePattern = /\b([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)\b/g;
                          const matches = cleanMoves.match(movePattern) || [];
                          return matches.length >= 5;
                        } catch {
                          return false;
                        }
                      }).length
                    : 0
          }
          unanalyzedGameCount={unanalyzedGameCount ?? undefined}
        />
      </Stack>
    </Box>
  );
}

import { Card, Group, Select, Tabs } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChessComGame } from "@/utils/chess.com/api";
import type { GameRecord } from "@/utils/gameRecords";
import type { FavoriteGame } from "@/utils/favoriteGames";
import { FavoriteGamesTab } from "./FavoriteGamesTab";
import { ProfileGamesTab } from "./ProfileGamesTab";

interface LichessGame {
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
}

interface GamesHistoryCardProps {
  activeTab: string | null;
  onTabChange: (tab: string | null) => void;
  localGames: GameRecord[];
  chessComGames: ChessComGame[];
  lichessGames: LichessGame[];
  profileUsernames: string[];
  isLoadingOnlineGames?: boolean;
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGame) => void;
  onAnalyzeLichessGame: (game: LichessGame) => void;
  onAnalyzeAll?: (type: "local" | "chesscom" | "lichess") => void;
  onDeleteLocalGame?: (gameId: string) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
  favoriteGames?: FavoriteGame[];
  gameHistoryLimit: number;
  onGameHistoryLimitChange: (limit: number) => void;
}

export function GamesHistoryCard({
  activeTab,
  onTabChange,
  localGames,
  chessComGames,
  lichessGames,
  profileUsernames,
  isLoadingOnlineGames = false,
  onAnalyzeLocalGame,
  onAnalyzeChessComGame,
  onAnalyzeLichessGame,
  onAnalyzeAll,
  onDeleteLocalGame,
  onToggleFavoriteLocal,
  onToggleFavoriteChessCom,
  onToggleFavoriteLichess,
  favoriteGames = [],
  gameHistoryLimit,
  onGameHistoryLimitChange,
}: GamesHistoryCardProps) {
  const { t } = useTranslation();

  // Default height in pixels
  const DEFAULT_HEIGHT = 400;
  const MIN_HEIGHT = 200;
  const MAX_HEIGHT = 800;

  // Load saved height from localStorage
  const [height, setHeight] = useState(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("gamesHistoryCardHeight");
      return saved ? parseInt(saved, 10) : DEFAULT_HEIGHT;
    }
    return DEFAULT_HEIGHT;
  });

  const [isResizing, setIsResizing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const resizeStartY = useRef<number>(0);
  const resizeStartHeight = useRef<number>(0);

  // Save height to localStorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("gamesHistoryCardHeight", height.toString());
    }
  }, [height]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartY.current = e.clientY;
    if (cardRef.current) {
      resizeStartHeight.current = cardRef.current.offsetHeight;
    }
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaY = e.clientY - resizeStartY.current;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, resizeStartHeight.current + deltaY));
      setHeight(newHeight);
    },
    [isResizing],
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);

  return (
    <Card
      ref={cardRef}
      withBorder
      p="lg"
      radius="md"
      style={{
        height: `${height}px`,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Resize handle at the top */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "8px",
          cursor: "row-resize",
          zIndex: 10,
          backgroundColor: "transparent",
        }}
        title="Drag to resize"
      />
      <Tabs
        value={activeTab}
        onChange={onTabChange}
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <Group justify="space-between" align="center" style={{ marginTop: "4px" }}>
          <Tabs.List>
            <Tabs.Tab value="games">Games</Tabs.Tab>
            <Tabs.Tab value="favorites">Favorites</Tabs.Tab>
          </Tabs.List>
          <Group gap="xs">
            <Select
              placeholder={t("features.dashboard.maxGames", "Max games")}
              value={String(gameHistoryLimit)}
              onChange={(value) => {
                if (!value) return;
                const parsed = Number(value);
                if (!Number.isNaN(parsed)) onGameHistoryLimitChange(parsed);
              }}
              data={[
                { value: "100", label: "100" },
                { value: "200", label: "200" },
                { value: "300", label: "300" },
                { value: "500", label: "500" },
                { value: "1000", label: "1000" },
              ]}
            />
          </Group>
        </Group>

        <Tabs.Panel
          value="games"
          pt="xs"
          style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}
        >
          <ProfileGamesTab
            localGames={localGames}
            chessComGames={chessComGames}
            lichessGames={lichessGames}
            profileUsernames={profileUsernames}
            isLoadingOnline={isLoadingOnlineGames}
            onAnalyzeLocalGame={onAnalyzeLocalGame}
            onAnalyzeChessComGame={onAnalyzeChessComGame}
            onAnalyzeLichessGame={onAnalyzeLichessGame}
            onAnalyzeAll={onAnalyzeAll}
            onDeleteLocalGame={onDeleteLocalGame}
            onToggleFavoriteLocal={onToggleFavoriteLocal}
            onToggleFavoriteChessCom={onToggleFavoriteChessCom}
            onToggleFavoriteLichess={onToggleFavoriteLichess}
            favoriteGames={favoriteGames}
          />
        </Tabs.Panel>

        <Tabs.Panel
          value="favorites"
          pt="xs"
          style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}
        >
          <FavoriteGamesTab
            localGames={localGames}
            chessComGames={chessComGames}
            lichessGames={lichessGames}
            favoriteGames={favoriteGames}
            chessComUsernames={[]}
            lichessUsernames={[]}
            onAnalyzeLocalGame={onAnalyzeLocalGame}
            onAnalyzeChessComGame={onAnalyzeChessComGame}
            onAnalyzeLichessGame={onAnalyzeLichessGame}
            onToggleFavoriteLocal={onToggleFavoriteLocal}
            onToggleFavoriteChessCom={onToggleFavoriteChessCom}
            onToggleFavoriteLichess={onToggleFavoriteLichess}
          />
        </Tabs.Panel>
      </Tabs>

      {/* Resize handle at the bottom */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: "8px",
          cursor: "row-resize",
          zIndex: 10,
          backgroundColor: "transparent",
        }}
        title="Drag to resize"
      />
    </Card>
  );
}

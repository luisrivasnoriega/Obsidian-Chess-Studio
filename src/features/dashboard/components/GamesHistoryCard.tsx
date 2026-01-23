import { Card, Group, Select, Tabs } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Event } from "@/bindings";
import type { FavoriteGame } from "@/utils/favoriteGames";
import type { GameRecord } from "@/utils/gameRecords";
import type { ChessComGameWithEvent, DashboardLichessGame, TimeControlCategory } from "../types";
import { FavoriteGamesTab } from "./FavoriteGamesTab";
import { ProfileGamesTab } from "./ProfileGamesTab";

interface GamesHistoryCardProps {
  profileId: string | null;
  selectedOpponentId: number | null;
  activeTab: string | null;
  onTabChange: (tab: string | null) => void;
  localGames: GameRecord[];
  chessComGames: ChessComGameWithEvent[];
  lichessGames: DashboardLichessGame[];
  profileUsernames: string[];
  isLoadingOnlineGames?: boolean;
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (game: ChessComGameWithEvent, meta?: { profileId: string; profileDbGameId: string }) => void;
  onAnalyzeLichessGame: (game: DashboardLichessGame, meta?: { profileId: string; profileDbGameId: string }) => void;
  onAnalyzeAll?: (type: "local" | "chesscom" | "lichess" | "all") => void;
  onDeleteLocalGame?: (gameId: string) => void;
  onToggleFavoriteLocal?: (gameId: string) => Promise<void>;
  onToggleFavoriteChessCom?: (gameId: string) => Promise<void>;
  onToggleFavoriteLichess?: (gameId: string) => Promise<void>;
  favoriteGames?: FavoriteGame[];
  gameHistoryLimit: number;
  onGameHistoryLimitChange: (limit: number) => void;
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
}

export function GamesHistoryCard({
  profileId,
  selectedOpponentId,
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
}: GamesHistoryCardProps) {
  const { t } = useTranslation();
  const isMobile = useMediaQuery("(max-width: 48em)");

  // Default height in pixels
  const DEFAULT_HEIGHT = 400;
  const MOBILE_MIN_HEIGHT = 800;
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

  // Update height when mobile state changes to ensure minimum height
  useEffect(() => {
    if (isMobile && height < MOBILE_MIN_HEIGHT) {
      setHeight(MOBILE_MIN_HEIGHT);
    }
  }, [isMobile, height]);

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
      const minAllowedHeight = isMobile ? MOBILE_MIN_HEIGHT : MIN_HEIGHT;
      const newHeight = Math.max(minAllowedHeight, Math.min(MAX_HEIGHT, resizeStartHeight.current + deltaY));
      setHeight(newHeight);
    },
    [isResizing, isMobile],
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
        ...(isMobile && { minHeight: `${MOBILE_MIN_HEIGHT}px` }),
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Resize handle at the top */}
      <button
        type="button"
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
          border: "none",
          padding: 0,
        }}
        title="Drag to resize"
        aria-label="Resize card"
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
            profileId={profileId}
            selectedOpponentId={selectedOpponentId}
            gameHistoryLimit={gameHistoryLimit}
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
            eventFilterId={eventFilterId}
            onEventFilterChange={onEventFilterChange}
            eventOptions={eventOptions}
            isLoadingEventOptions={isLoadingEventOptions}
            onEventSearchChange={onEventSearchChange}
            eventSearchValue={eventSearchValue}
            profileDbPath={profileDbPath}
            onOpponentSelected={onOpponentSelected}
            timeControlCategory={timeControlCategory}
            onTimeControlCategoryChange={onTimeControlCategoryChange}
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
      <button
        type="button"
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
          border: "none",
          padding: 0,
        }}
        title="Drag to resize"
        aria-label="Resize card"
      />
    </Card>
  );
}

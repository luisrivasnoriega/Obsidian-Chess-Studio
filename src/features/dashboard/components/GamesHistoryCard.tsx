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
  chessComUsernames?: string[];
  lichessUsernames?: string[];
  isLoadingOnlineGames?: boolean;
  onAnalyzeLocalGame: (game: GameRecord) => void;
  onAnalyzeChessComGame: (
    game: ChessComGameWithEvent,
    meta: { playerColor: "white" | "black"; profileId?: string; profileDbGameId?: string },
  ) => void;
  onAnalyzeLichessGame: (
    game: DashboardLichessGame,
    meta: { playerColor: "white" | "black"; profileId?: string; profileDbGameId?: string },
  ) => void;
  onAnalyzeAll?: (payload: {
    type: "local" | "chesscom" | "lichess" | "chessbase" | "all";
    opponentContains: string | null;
    resultFilter: string | null;
    playerColor: "white" | "black" | null;
    minMoves: number | null;
  }) => void;
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
  chessComUsernames = [],
  lichessUsernames = [],
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
      radius="lg"
      style={{
        height: `${height}px`,
        ...(isMobile && { minHeight: `${MOBILE_MIN_HEIGHT}px` }),
        position: "relative",
        display: "flex",
        flexDirection: "column",
        background:
          "radial-gradient(120% 170% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 14%, transparent) 0%, transparent 62%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 90%, var(--mantine-color-dark-5) 10%), var(--mantine-color-dark-7))",
        borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))",
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
        title={t("features.dashboard.dragToResize", { defaultValue: "Drag to resize" })}
        aria-label={t("features.dashboard.resizeCard", { defaultValue: "Resize card" })}
      />
      <Tabs
        value={activeTab}
        onChange={onTabChange}
        variant="pills"
        styles={{
          list: {
            gap: 6,
            padding: 4,
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 14%, var(--mantine-color-dark-4))",
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 90%, var(--mantine-color-dark-5) 10%), var(--mantine-color-dark-6))",
          },
          tab: {
            borderRadius: 8,
            paddingInline: 14,
            minHeight: 34,
            fontWeight: 600,
            transition: "all 180ms ease",
            color: "var(--mantine-color-gray-4)",
            border: "1px solid transparent",
            "&:hover": {
              color: "var(--mantine-color-gray-1)",
              backgroundColor: "color-mix(in srgb, var(--mantine-color-dark-5) 88%, var(--mantine-color-dark-4) 12%)",
            },
            "&[data-active]": {
              color: "var(--mantine-color-gray-0)",
              border: "1px solid color-mix(in srgb, var(--mantine-color-blue-7) 30%, var(--mantine-color-dark-4))",
              background:
                "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-9) 26%, var(--mantine-color-dark-5) 74%), color-mix(in srgb, var(--mantine-color-cyan-9) 18%, var(--mantine-color-dark-5) 82%))",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06)",
            },
          },
        }}
        style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <Group justify="space-between" align="center" style={{ marginTop: "4px" }}>
          <Tabs.List>
            <Tabs.Tab value="games">{t("features.dashboard.games", { defaultValue: "Games" })}</Tabs.Tab>
            <Tabs.Tab value="favorites">{t("features.dashboard.favorites", { defaultValue: "Favorites" })}</Tabs.Tab>
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
              styles={{
                input: {
                  borderRadius: 10,
                  backgroundColor:
                    "color-mix(in srgb, var(--mantine-color-dark-6) 84%, var(--mantine-color-dark-4) 16%)",
                  borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 14%, var(--mantine-color-dark-4))",
                },
                dropdown: {
                  backgroundColor: "var(--mantine-color-dark-7)",
                  borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 14%, var(--mantine-color-dark-4))",
                },
              }}
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
            chessComUsernames={chessComUsernames}
            lichessUsernames={lichessUsernames}
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
        title={t("features.dashboard.dragToResize", { defaultValue: "Drag to resize" })}
        aria-label={t("features.dashboard.resizeCard", { defaultValue: "Resize card" })}
      />
    </Card>
  );
}

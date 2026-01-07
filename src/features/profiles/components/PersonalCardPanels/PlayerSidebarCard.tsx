import { Badge, Box, Card, Center, Divider, Group, Image, Loader, Select, Stack, Text, Tooltip } from "@mantine/core";
import { IconBolt, IconCircleDot, IconGauge } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { activeProfileIdAtom, sessionsAtom } from "@/state/atoms";
import { analyzePlayerStyle } from "@/utils/playerStyle";
import { getTimeControl } from "@/utils/timeControl";
import LichessLogo from "../LichessLogo";
import DateRangeTabs, { type DateRange } from "./DateRangeTabs";

export type PlatformFilter = "all" | "Chess.com" | "Lichess";
export type TimeControlFilter =
  | "any"
  | "ultra_bullet"
  | "bullet"
  | "blitz"
  | "rapid"
  | "classical"
  | "correspondence"
  | "daily";

const TIME_CONTROL_OPTIONS: Array<{ value: TimeControlFilter; label: string }> = [
  { value: "any", label: "Any" },
  { value: "bullet", label: "Bullet" },
  { value: "blitz", label: "Blitz" },
  { value: "rapid", label: "Rapid" },
  { value: "classical", label: "Classical" },
  { value: "correspondence", label: "Correspondence" },
  { value: "daily", label: "Daily" },
  { value: "ultra_bullet", label: "UltraBullet" },
];

type OpponentEloOption = { value: string; label: string };

export function normalizePlatform(site: string): PlatformFilter | null {
  const lower = site.trim().toLowerCase();
  const condensed = lower.replace(/[^a-z0-9]/g, "");
  if (condensed.includes("chesscom") || /chess\s*\.?\s*com/.test(lower)) return "Chess.com";
  if (condensed.includes("lichess") || lower.includes("lichess")) return "Lichess";
  return null;
}

function PlatformIcon({ platform }: { platform: PlatformFilter }) {
  if (platform === "all") return null;
  
  return (
    <Box
      style={{
        width: 18,
        height: 18,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {platform === "Chess.com" ? (
        <Image
          src="/chesscom.png"
          alt="Chess.com"
          w={18}
          h={18}
          style={{ objectFit: "contain" }}
        />
      ) : (
        <Box style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          <svg viewBox="0 0 50 50" xmlns="http://www.w3.org/2000/svg" style={{ width: 18, height: 18 }}>
            <title>Lichess</title>
            <path
              strokeLinejoin="round"
              fill="currentColor"
              d="M38.956.5c-3.53.418-6.452.902-9.286 2.984C5.534 1.786-.692 18.533.68 29.364 3.493 50.214 31.918 55.785 41.329 41.7c-7.444 7.696-19.276 8.752-28.323 3.084C3.959 39.116-.506 27.392 4.683 17.567 9.873 7.742 18.996 4.535 29.03 6.405c2.43-1.418 5.225-3.22 7.655-3.187l-1.694 4.86 12.752 21.37c-.439 5.654-5.459 6.112-5.459 6.112-.574-1.47-1.634-2.942-4.842-6.036-3.207-3.094-17.465-10.177-15.788-16.207-2.001 6.967 10.311 14.152 14.04 17.663 3.73 3.51 5.426 6.04 5.795 6.756 0 0 9.392-2.504 7.838-8.927L37.4 7.171z"
            />
          </svg>
        </Box>
      )}
    </Box>
  );
}

type PlatformEloSummary = {
  bullet: number;
  blitz: number;
  rapid: number;
};

type PlayerSidebarCardProps = {
  playerName: string;
  info: PlayerGameInfo;
  platform: PlatformFilter;
  onPlatformChange: (value: PlatformFilter) => void;
  timeControl: TimeControlFilter;
  onTimeControlChange: (value: TimeControlFilter) => void;
  opponentEloOptions?: OpponentEloOption[];
  opponentEloBucket?: string;
  onOpponentEloChange?: (value: string) => void;
  dateRange?: DateRange | null;
  onDateRangeChange?: (value: DateRange | null) => void;
  profileId?: string;
  isLoading?: boolean;
  /**
   * When true, the card stretches to full container height.
   * Useful for 2-column layouts where the sidebar should match the panel height.
   */
  fullHeight?: boolean;
};

function formatElo(value: number): string {
  return value > 0 ? String(value) : "-";
}

export default function PlayerSidebarCard({
  playerName,
  info,
  platform,
  onPlatformChange,
  timeControl,
  onTimeControlChange,
  opponentEloOptions,
  opponentEloBucket,
  onOpponentEloChange,
  dateRange,
  onDateRangeChange,
  profileId,
  isLoading = false,
  fullHeight = true,
}: PlayerSidebarCardProps) {
  const { t } = useTranslation();
  const sessions = useAtomValue(sessionsAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const effectiveProfileId = profileId ?? activeProfileId;

  // Check if data is actually loaded
  const hasData = useMemo(() => {
    if (isLoading) return false;
    
    // If we have a profileId, check if we have sessions with account data
    if (effectiveProfileId) {
      const profileSessions = sessions.filter(
        (s) => (s.profileId ?? activeProfileId) === effectiveProfileId,
      );
      
      // If we have sessions, check if they have account data loaded
      if (profileSessions.length > 0) {
        const hasAccountData = profileSessions.some(
          (s) => s.lichess?.account?.perfs || s.chessCom?.stats,
        );
        // If we have sessions but no account data yet, show loading
        if (!hasAccountData) return false;
      }
      
      // If we have profileId but no sessions yet, show loading
      if (profileSessions.length === 0) return false;
    }
    
    // Check if we have site_stats_data (game data)
    // If we have profileId, we might not have game data yet but still show the card
    // with elos from sessions
    if (!info?.site_stats_data || info.site_stats_data.length === 0) {
      // If no profileId, we need game data
      if (!effectiveProfileId) return false;
      // If we have profileId, we can show the card with session elos even without game data
      return true;
    }
    
    return true;
  }, [isLoading, info?.site_stats_data, effectiveProfileId, sessions, activeProfileId]);

  const playerStyle = useMemo(() => analyzePlayerStyle(info), [info]);

  const platformOptions = useMemo(
    () => [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      { value: "Chess.com", label: "Chess.com" },
      { value: "Lichess", label: "Lichess" },
    ],
    [t],
  );

  // Get current elos from active profile sessions instead of historical games
  const platformSummary = useMemo(() => {
    const summary: Record<PlatformFilter, PlatformEloSummary> = {
      all: { bullet: 0, blitz: 0, rapid: 0 },
      "Chess.com": { bullet: 0, blitz: 0, rapid: 0 },
      Lichess: { bullet: 0, blitz: 0, rapid: 0 },
    };

    if (!effectiveProfileId) {
      // Fallback to historical data if no profile ID
      for (const entry of info.site_stats_data ?? []) {
        const normalized = normalizePlatform(entry.site);
        if (!normalized) continue;
        for (const game of entry.data) {
          const speed = getTimeControl(entry.site, game.time_control);
          if (speed !== "bullet" && speed !== "blitz" && speed !== "rapid") continue;
          const elo = typeof game.player_elo === "number" ? game.player_elo : 0;
          summary[normalized][speed] = Math.max(summary[normalized][speed], elo);
        }
      }
      return summary;
    }

    // Get sessions for the active profile
    const profileSessions = sessions.filter(
      (s) => (s.profileId ?? activeProfileId) === effectiveProfileId,
    );

    for (const session of profileSessions) {
      // Lichess elos
      if (session.lichess?.account?.perfs) {
        const perfs = session.lichess.account.perfs;
        if (perfs.bullet?.rating) {
          summary.Lichess.bullet = Math.max(summary.Lichess.bullet, perfs.bullet.rating);
          summary.all.bullet = Math.max(summary.all.bullet, perfs.bullet.rating);
        }
        if (perfs.blitz?.rating) {
          summary.Lichess.blitz = Math.max(summary.Lichess.blitz, perfs.blitz.rating);
          summary.all.blitz = Math.max(summary.all.blitz, perfs.blitz.rating);
        }
        if (perfs.rapid?.rating) {
          summary.Lichess.rapid = Math.max(summary.Lichess.rapid, perfs.rapid.rating);
          summary.all.rapid = Math.max(summary.all.rapid, perfs.rapid.rating);
        }
      }

      // Chess.com elos
      if (session.chessCom?.stats) {
        const stats = session.chessCom.stats;
        if (stats.chess_bullet?.last?.rating) {
          summary["Chess.com"].bullet = Math.max(summary["Chess.com"].bullet, stats.chess_bullet.last.rating);
          summary.all.bullet = Math.max(summary.all.bullet, stats.chess_bullet.last.rating);
        }
        if (stats.chess_blitz?.last?.rating) {
          summary["Chess.com"].blitz = Math.max(summary["Chess.com"].blitz, stats.chess_blitz.last.rating);
          summary.all.blitz = Math.max(summary.all.blitz, stats.chess_blitz.last.rating);
        }
        if (stats.chess_rapid?.last?.rating) {
          summary["Chess.com"].rapid = Math.max(summary["Chess.com"].rapid, stats.chess_rapid.last.rating);
          summary.all.rapid = Math.max(summary.all.rapid, stats.chess_rapid.last.rating);
        }
      }
    }

    return summary;
  }, [info.site_stats_data, sessions, effectiveProfileId, activeProfileId]);

  const platformsToShow = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);

  if (!hasData) {
    return (
      <Card
        withBorder
        radius="md"
        shadow="sm"
        bg="var(--mantine-color-dark-6)"
        h={fullHeight ? "100%" : undefined}
        style={{ overflow: "hidden" }}
      >
        <Stack gap="sm" h="100%" justify="center" align="center" p="md">
          <Loader size="md" />
          <Text size="sm" c="dimmed" ta="center">
            {t("common.loadingGames", { defaultValue: "Loading games..." })}
          </Text>
        </Stack>
      </Card>
    );
  }

  return (
    <Card
      withBorder
      radius="md"
      shadow="sm"
      bg="var(--mantine-color-dark-6)"
      h={fullHeight ? "100%" : undefined}
      style={{ overflow: "hidden" }}
    >
      <Stack gap="sm">
        <Text fz="lg" fw={700} ta="center">
          {playerName}
        </Text>
        <Badge color={playerStyle.color} variant="light" size="lg" mx="auto">
          {t(playerStyle.label)}
        </Badge>
        <Text fz="xs" c="dimmed" ta="center">
          {t(playerStyle.description)}
        </Text>
        <Divider />
        <Stack gap={4}>
          <Text fw={600} fz="sm">
            {t("common.filters", { defaultValue: "Filters" })}
          </Text>
          <Select
            label="Platform"
            data={platformOptions}
            value={platform}
            onChange={(value) => onPlatformChange((value as PlatformFilter) || "all")}
            clearable={false}
            size="xs"
          />
          <Select
            label="Time control"
            data={TIME_CONTROL_OPTIONS}
            value={timeControl}
            onChange={(value) => onTimeControlChange((value as TimeControlFilter) || "any")}
            clearable={false}
            size="xs"
          />
          {opponentEloOptions && opponentEloBucket && onOpponentEloChange && (
            <Select
              label={t("accounts.opponentElo", { defaultValue: "Opponent Elo" })}
              data={opponentEloOptions}
              value={opponentEloBucket}
              onChange={(value) => onOpponentEloChange(value || "all")}
              clearable={false}
              searchable
              size="xs"
            />
          )}
          {dateRange !== undefined && onDateRangeChange && (
            <DateRangeTabs timeRange={dateRange} onTimeRangeChange={(value) => onDateRangeChange(value)} />
          )}
        </Stack>
        <Divider />
        <Stack gap="xs">
          <Text fw={600}>{t("common.elo", { defaultValue: "Elo" })}</Text>
          {platformsToShow.map((site) => {
            const summary = platformSummary[site];
            return (
              <Group key={site} justify="space-between" align="flex-start" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <PlatformIcon platform={site} />
                  <Text fw={600}>{site}</Text>
                </Group>
                <Group gap="xs" wrap="nowrap" style={{ whiteSpace: "nowrap" }}>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Bullet">
                      <span>
                        <IconCircleDot size={14} />
                      </span>
                    </Tooltip>
                    <Text size="sm" fw={700}>
                      {formatElo(summary.bullet)}
                    </Text>
                  </Group>
                  <Text size="sm" c="dimmed">
                    |
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Blitz">
                      <span>
                        <IconBolt size={14} />
                      </span>
                    </Tooltip>
                    <Text size="sm" fw={700}>
                      {formatElo(summary.blitz)}
                    </Text>
                  </Group>
                  <Text size="sm" c="dimmed">
                    |
                  </Text>
                  <Group gap={4} wrap="nowrap">
                    <Tooltip label="Rapid">
                      <span>
                        <IconGauge size={14} />
                      </span>
                    </Tooltip>
                    <Text size="sm" fw={700}>
                      {formatElo(summary.rapid)}
                    </Text>
                  </Group>
                </Group>
              </Group>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}

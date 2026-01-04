import { Badge, Box, Card, Divider, Group, Select, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerGameInfo } from "@/bindings";
import { analyzePlayerStyle } from "@/utils/playerStyle";
import { getTimeControl } from "@/utils/timeControl";
import DateRangeTabs, { DateRange } from "./DateRangeTabs";

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
  const lower = site.toLowerCase();
  if (lower.includes("chess.com")) return "Chess.com";
  if (lower.includes("lichess")) return "Lichess";
  return null;
}

function PlatformIcon({ platform }: { platform: PlatformFilter }) {
  const label = platform === "Chess.com" ? "C" : "L";
  const color = platform === "Chess.com" ? "var(--mantine-color-blue-filled)" : "var(--mantine-color-red-filled)";
  return (
    <Box
      style={{
        width: 18,
        height: 18,
        borderRadius: 4,
        background: color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontSize: 11,
        fontWeight: 700,
      }}
    >
      {label}
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
}: PlayerSidebarCardProps) {
  const { t } = useTranslation();
  const playerStyle = useMemo(() => analyzePlayerStyle(info), [info]);

  const platformOptions = useMemo(
    () => [
      { value: "all", label: t("common.all", { defaultValue: "All" }) },
      { value: "Chess.com", label: "Chess.com" },
      { value: "Lichess", label: "Lichess" },
    ],
    [t],
  );

  const platformSummary = useMemo(() => {
    const summary: Record<PlatformFilter, PlatformEloSummary> = {
      all: { bullet: 0, blitz: 0, rapid: 0 },
      "Chess.com": { bullet: 0, blitz: 0, rapid: 0 },
      Lichess: { bullet: 0, blitz: 0, rapid: 0 },
    };

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
  }, [info.site_stats_data]);

  const platformsToShow = platform === "all" ? (["Chess.com", "Lichess"] as const) : ([platform] as const);

  return (
    <Card withBorder radius="md" shadow="sm" bg="var(--mantine-color-dark-6)" h="100%" style={{ overflow: "hidden" }}>
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
                <Text size="sm" fw={700} style={{ whiteSpace: "nowrap" }}>
                  bullet {formatElo(summary.bullet)} | blitz {formatElo(summary.blitz)} | rapid{" "}
                  {formatElo(summary.rapid)}
                </Text>
              </Group>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}

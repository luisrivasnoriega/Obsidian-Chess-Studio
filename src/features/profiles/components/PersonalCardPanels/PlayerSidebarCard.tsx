import { Badge, Box, Card, Divider, Group, Image, Loader, Select, Stack, Text, Tooltip } from "@mantine/core";
import { IconBolt, IconCircleDot, IconGauge } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PlayerSidebarModel } from "@/bindings/playerStats";
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

function PlatformIcon({ platform }: { platform: Exclude<PlatformFilter, "all"> }) {
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
        <Image src="/chesscom.png" alt="Chess.com" w={18} h={18} style={{ objectFit: "contain" }} />
      ) : (
        <Box
          style={{
            width: 18,
            height: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
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

type PlayerSidebarCardProps = {
  playerName: string;
  model: PlayerSidebarModel | null;
  visiblePlatforms: Array<Exclude<PlatformFilter, "all">>;
  platform: PlatformFilter;
  onPlatformChange: (value: PlatformFilter) => void;
  timeControl: TimeControlFilter;
  onTimeControlChange: (value: TimeControlFilter) => void;
  opponentEloOptions?: OpponentEloOption[];
  opponentEloBucket?: string;
  onOpponentEloChange?: (value: string) => void;
  dateRange?: DateRange | null;
  onDateRangeChange?: (value: DateRange | null) => void;
  extraFilters?: ReactNode;
  profileId?: string;
  isLoading?: boolean;
  /**
   * When true, the card stretches to full container height.
   * Useful for 2-column layouts where the sidebar should match the panel height.
   */
  fullHeight?: boolean;
};

export default function PlayerSidebarCard({
  playerName,
  model,
  visiblePlatforms,
  platform,
  onPlatformChange,
  timeControl,
  onTimeControlChange,
  opponentEloOptions,
  opponentEloBucket,
  onOpponentEloChange,
  dateRange,
  onDateRangeChange,
  extraFilters,
  isLoading = false,
  fullHeight = true,
}: PlayerSidebarCardProps) {
  const { t } = useTranslation();
  const platformOptions = [
    { value: "all", label: t("common.all", { defaultValue: "All" }) },
    { value: "Chess.com", label: "Chess.com" },
    { value: "Lichess", label: "Lichess" },
  ];

  if (isLoading) {
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

  if (!model) {
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
          <Text size="sm" c="dimmed" ta="center">
            {t("common.noData", { defaultValue: "No data" })}
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
        <Badge color={model.style.color} variant="light" size="lg" mx="auto">
          {t(model.style.label)}
        </Badge>
        <Text fz="xs" c="dimmed" ta="center">
          {t(model.style.description)}
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
          {extraFilters}
        </Stack>
        <Divider />
        <Stack gap="xs">
          <Text fw={600}>{t("common.elo", { defaultValue: "Elo" })}</Text>
          {model.elo.map((block) => {
            const platformLabel = block.platform as Exclude<PlatformFilter, "all">;
            return (
              <Stack key={block.platform} gap={6}>
                <Group gap="xs" wrap="nowrap">
                  {(platformLabel === "Chess.com" || platformLabel === "Lichess") && (
                    <PlatformIcon platform={platformLabel} />
                  )}
                  <Text fw={600}>{block.platform}</Text>
                </Group>

                {block.rows.map((row) => (
                  <Group
                    key={`${block.platform}:${row.label}`}
                    justify="space-between"
                    align="flex-start"
                    wrap="nowrap"
                  >
                    <Text size="sm" fw={600} style={{ maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {row.label}
                    </Text>
                    <Group gap="xs" wrap="nowrap" style={{ whiteSpace: "nowrap" }}>
                      <Group gap={4} wrap="nowrap">
                        <Tooltip label="Bullet">
                          <span>
                            <IconCircleDot size={14} />
                          </span>
                        </Tooltip>
                        <Text size="sm" fw={700}>
                          {row.bullet}
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
                          {row.blitz}
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
                          {row.rapid}
                        </Text>
                      </Group>
                    </Group>
                  </Group>
                ))}
              </Stack>
            );
          })}
        </Stack>
      </Stack>
    </Card>
  );
}

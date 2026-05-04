import { BarChart } from "@mantine/charts";
import { Box, Button, Card, Group, Progress, RingProgress, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconFlame, IconPuzzle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { ChartSizeGuard } from "@/components/ChartSizeGuard";

interface PuzzleStats {
  currentStreak: number;
  target: number;
  history: Array<{ day: string; solved: number }>;
}

interface PuzzleStatsCardProps {
  stats: PuzzleStats;
  onStartPuzzles: () => void;
}

export function PuzzleStatsCard({ stats, onStartPuzzles }: PuzzleStatsCardProps) {
  const { t } = useTranslation();
  const safeTarget = Math.max(1, stats.target);
  const streakProgress = Math.max(0, Math.min(100, Math.round((stats.currentStreak / safeTarget) * 100)));
  const solvedThisWeek = stats.history.reduce((sum, item) => sum + Math.max(0, item.solved), 0);

  return (
    <Card
      withBorder
      p="lg"
      radius="lg"
      h="100%"
      style={{
        background:
          "radial-gradient(100% 180% at 0% 0%, color-mix(in srgb, var(--mantine-color-yellow-9) 10%, transparent) 0%, transparent 52%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-7) 90%, var(--mantine-color-dark-5) 10%), var(--mantine-color-dark-7))",
        borderColor: "color-mix(in srgb, var(--mantine-color-yellow-8) 18%, var(--mantine-color-dark-4))",
      }}
    >
      <Group justify="space-between" mb="md">
        <Group gap="xs">
          <ThemeIcon
            radius="md"
            variant="light"
            color="yellow"
            style={{
              border: "1px solid color-mix(in srgb, var(--mantine-color-yellow-7) 30%, transparent)",
            }}
          >
            <IconFlame size={16} />
          </ThemeIcon>
          <Text fw={700}>{t("features.tabs.puzzle.title")}</Text>
        </Group>
        <Button
          size="xs"
          radius="md"
          variant="light"
          onClick={onStartPuzzles}
          leftSection={<IconPuzzle size={16} />}
          style={{
            border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 20%, transparent)",
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-blue-8) 84%, var(--mantine-color-blue-7) 16%), color-mix(in srgb, var(--mantine-color-blue-7) 90%, var(--mantine-color-blue-6) 10%))",
          }}
        >
          {t("features.tabs.puzzle.button")}
        </Button>
      </Group>
      <Group align="center" gap="lg" wrap="wrap">
        <RingProgress
          size={176}
          thickness={13}
          roundCaps
          sections={[{ value: streakProgress, color: "yellow" }]}
          label={
            <Stack gap={0} align="center">
              <ThemeIcon color="yellow" variant="light">
                <IconFlame size={18} />
              </ThemeIcon>
              <Text fw={700}>{stats.currentStreak}</Text>
              <Text size="xs" c="dimmed">
                {t("features.dashboard.dayStreak")}
              </Text>
            </Stack>
          }
        />
        <Box
          style={{
            flex: 1,
            minWidth: 220,
            borderRadius: 12,
            padding: 12,
            border: "1px solid color-mix(in srgb, var(--mantine-color-yellow-8) 14%, var(--mantine-color-dark-4))",
            background:
              "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 94%, var(--mantine-color-yellow-9) 6%), var(--mantine-color-dark-6))",
          }}
        >
          <Group justify="space-between" mb={6}>
            <Text size="sm" c="dimmed">
              {t("features.dashboard.thisWeek")}
            </Text>
            <Text size="sm" fw={700}>
              {solvedThisWeek}
            </Text>
          </Group>
          <Progress
            value={streakProgress}
            color="yellow"
            radius="xl"
            size="sm"
            mb="sm"
            style={{
              backgroundColor: "color-mix(in srgb, var(--mantine-color-dark-5) 86%, var(--mantine-color-dark-4) 14%)",
            }}
          />
          <ChartSizeGuard height={110}>
            <BarChart
              h={110}
              data={stats.history}
              dataKey="day"
              series={[{ name: "solved", color: "yellow.6" }]}
              withLegend={false}
              gridAxis="none"
              xAxisProps={{ hide: true }}
              yAxisProps={{ hide: true }}
              barProps={{ radius: 6 }}
            />
          </ChartSizeGuard>
        </Box>
      </Group>
    </Card>
  );
}

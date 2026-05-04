import {
  ActionIcon,
  Badge,
  Box,
  Card,
  Divider,
  Group,
  Image,
  Progress,
  rem,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { IconAlertTriangle, IconEdit, IconGauge, IconTargetArrow } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import LichessLogo from "@/features/profiles/components/LichessLogo";
import { EditProfileModal } from "./EditProfileModal";

interface RatingHistory {
  classical?: number;
  rapid?: number;
  blitz?: number;
  bullet?: number;
}

interface FidePlayerData {
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
}

interface UserProfileCardProps {
  name: string;
  handle: string;
  title: string;
  ratingHistory: RatingHistory;
  onFideUpdate?: (
    fideId: string,
    fidePlayer: FidePlayerData | null,
    displayName?: string,
    lichessToken?: string,
  ) => void;
  currentFideId?: string;
  fidePlayer?: FidePlayerData | null;
  customName?: string; // Custom name to display
  platform?: "lichess" | "chesscom" | null; // Platform of the main account
  currentLichessToken?: string;
  weekBlunderRate?: number | null;
  previousWeekBlunderRate?: number | null;
  weekAccuracy?: number | null;
  previousWeekAccuracy?: number | null;
  weekAcpl?: number | null;
  previousWeekAcpl?: number | null;
}

export function UserProfileCard({
  name,
  handle,
  title,
  ratingHistory,
  onFideUpdate,
  currentFideId,
  fidePlayer,
  customName,
  platform,
  currentLichessToken,
  weekBlunderRate = null,
  previousWeekBlunderRate = null,
  weekAccuracy = null,
  previousWeekAccuracy = null,
  weekAcpl = null,
  previousWeekAcpl = null,
}: UserProfileCardProps) {
  const { t } = useTranslation();
  const [editModalOpened, setEditModalOpened] = useState(false);

  const handleSave = (
    fideId: string,
    fidePlayer: FidePlayerData | null,
    displayName?: string,
    lichessToken?: string,
  ) => {
    if (onFideUpdate) {
      onFideUpdate(fideId, fidePlayer, displayName, lichessToken);
    }
  };

  // If there's a custom name, use it; otherwise use the original name
  const displayName = customName?.trim() ? customName : name;

  // Determine which title to display (FIDE title has priority if it exists)
  const displayTitle = fidePlayer?.title || title;

  // Determine which ratings to display
  // Priority: Online account ratings (Chess.com/Lichess) > FIDE ratings
  // This ensures that when the main account is from Chess.com or Lichess,
  // we show the actual online ratings, not FIDE ratings
  // Only show classical if platform is Lichess (Chess.com doesn't have classical)
  const displayRatings = {
    classical: platform === "lichess" ? ratingHistory.classical || fidePlayer?.standardRating : undefined,
    rapid: ratingHistory.rapid || fidePlayer?.rapidRating,
    blitz: ratingHistory.blitz || fidePlayer?.blitzRating,
    bullet: ratingHistory.bullet,
  };
  const ratings = useMemo(
    () =>
      [
        {
          key: "classical",
          label: t("chess.timeControl.classical", { defaultValue: "Classical" }),
          color: "teal.5",
          value: displayRatings.classical ?? null,
        },
        {
          key: "rapid",
          label: t("chess.timeControl.rapid", { defaultValue: "Rapid" }),
          color: "cyan.5",
          value: displayRatings.rapid ?? null,
        },
        {
          key: "blitz",
          label: t("chess.timeControl.blitz", { defaultValue: "Blitz" }),
          color: "yellow.6",
          value: displayRatings.blitz ?? null,
        },
        {
          key: "bullet",
          label: t("chess.timeControl.bullet", { defaultValue: "Bullet" }),
          color: "blue.5",
          value: displayRatings.bullet ?? null,
        },
      ].filter(
        (item): item is { key: string; label: string; color: string; value: number } => typeof item.value === "number",
      ),
    [displayRatings.blitz, displayRatings.bullet, displayRatings.classical, displayRatings.rapid, t],
  );

  const topRating = ratings.length > 0 ? Math.max(...ratings.map((entry) => entry.value)) : 0;
  const ratingColsBase = ratings.length <= 1 ? 1 : 2;
  const ratingColsSm = Math.max(1, Math.min(4, ratings.length));
  const previousWeekLabel = t("features.dashboard.previousWeek", { defaultValue: "Previous" });
  const formatPercent = (value: number | null | undefined, decimals = 1): string => {
    if (value == null || !Number.isFinite(value)) return "--";
    const fixed = value.toFixed(decimals);
    return `${fixed.replace(/\.0+$/, "")}%`;
  };
  const formatNumber = (value: number | null | undefined, decimals = 1): string => {
    if (value == null || !Number.isFinite(value)) return "--";
    const fixed = value.toFixed(decimals);
    return fixed.replace(/\.0+$/, "");
  };
  const buildWeekHint = (previousValue: string | number) =>
    `${t("features.dashboard.thisWeek")}\n${previousWeekLabel}: ${previousValue}`;

  const profileMetrics = [
    {
      key: "blunder-rate",
      label: t("features.dashboard.blunderRateLabel", { defaultValue: "Blunder rate" }),
      value: formatPercent(weekBlunderRate, 1),
      hint: buildWeekHint(formatPercent(previousWeekBlunderRate, 1)),
      icon: <IconAlertTriangle size={14} />,
      color: "red",
    },
    {
      key: "accuracy",
      label: t("dashboard.tableHeaders.accuracy", { defaultValue: "Accuracy" }),
      value: formatPercent(weekAccuracy, 1),
      hint: buildWeekHint(formatPercent(previousWeekAccuracy, 1)),
      icon: <IconTargetArrow size={14} />,
      color: "green",
    },
    {
      key: "acpl",
      label: "ACPL",
      value: formatNumber(weekAcpl, 1),
      hint: buildWeekHint(formatNumber(previousWeekAcpl, 1)),
      icon: <IconGauge size={14} />,
      color: "violet",
    },
  ];

  return (
    <>
      <Card
        withBorder
        p="lg"
        radius="lg"
        h="100%"
        style={{
          background:
            "radial-gradient(125% 185% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 16%, transparent) 0%, transparent 56%), linear-gradient(150deg, color-mix(in srgb, var(--mantine-color-dark-7) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
          borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))",
        }}
      >
        <Box>
          <Group gap={6} justify="space-between" wrap="nowrap">
            <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              {platform && (
                <Box
                  style={{
                    width: rem(24),
                    height: rem(24),
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {platform === "lichess" ? (
                    <LichessLogo />
                  ) : (
                    <Image w={rem(24)} h={rem(24)} src="/chesscom.png" alt="chess.com" />
                  )}
                </Box>
              )}
              <Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
                <Text fw={800} fz="lg" truncate>
                  {displayName}
                </Text>
                <Text size="sm" c="dimmed" truncate>
                  {handle}
                </Text>
              </Stack>
            </Group>
            <Group gap="xs" wrap="nowrap">
              {displayTitle && (
                <Badge color="yellow" variant="light" radius="xl">
                  {displayTitle}
                </Badge>
              )}
              <ActionIcon
                variant="subtle"
                size="sm"
                radius="md"
                onClick={() => setEditModalOpened(true)}
                title="Edit profile"
                style={{
                  border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
                  backgroundColor:
                    "color-mix(in srgb, var(--mantine-color-dark-6) 84%, var(--mantine-color-dark-4) 16%)",
                }}
              >
                <IconEdit size={16} />
              </ActionIcon>
            </Group>
          </Group>
        </Box>
        <Divider my="md" />
        <SimpleGrid cols={{ base: 1, sm: 3, md: 3 }} spacing="xs">
          {profileMetrics.map((metric) => (
            <Stack
              key={metric.key}
              gap={3}
              p="xs"
              style={{
                borderRadius: 10,
                border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 12%, var(--mantine-color-dark-4))",
                background:
                  "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 90%, var(--mantine-color-dark-4) 10%), var(--mantine-color-dark-6))",
                minHeight: 76,
              }}
            >
              <Group justify="space-between" wrap="nowrap" gap={4}>
                <Text size="xs" c="dimmed" truncate>
                  {metric.label}
                </Text>
                <ThemeIcon variant="light" color={metric.color} radius="md" size={20}>
                  {metric.icon}
                </ThemeIcon>
              </Group>
              <Text fw={800} fz="lg" lh={1.1} lineClamp={1}>
                {metric.value}
              </Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: "pre-line" }}>
                {metric.hint}
              </Text>
            </Stack>
          ))}
        </SimpleGrid>

        {ratings.length > 0 && (
          <>
            <Divider my="md" />
            <SimpleGrid cols={{ base: ratingColsBase, sm: ratingColsSm }} spacing="xs">
              {ratings.map((rating) => {
                const ratio = topRating > 0 ? Math.round((rating.value / topRating) * 100) : 0;
                return (
                  <Stack
                    key={rating.key}
                    gap={4}
                    p="xs"
                    style={{
                      borderRadius: 10,
                      border:
                        "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 10%, var(--mantine-color-dark-4))",
                      background:
                        "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 92%, var(--mantine-color-dark-5) 8%), var(--mantine-color-dark-6))",
                    }}
                  >
                    <Text size="xs" c={rating.color}>
                      {rating.label}
                    </Text>
                    <Text fw={800} fz="lg" lh={1.1}>
                      {rating.value}
                    </Text>
                    <Progress
                      value={ratio}
                      size="xs"
                      radius="xl"
                      color={rating.color}
                      style={{
                        backgroundColor:
                          "color-mix(in srgb, var(--mantine-color-dark-5) 86%, var(--mantine-color-dark-4) 14%)",
                      }}
                    />
                  </Stack>
                );
              })}
            </SimpleGrid>
          </>
        )}
      </Card>
      <EditProfileModal
        opened={editModalOpened}
        onClose={() => setEditModalOpened(false)}
        onSave={handleSave}
        currentFideId={currentFideId}
        currentDisplayName={customName}
        currentLichessToken={currentLichessToken}
      />
    </>
  );
}

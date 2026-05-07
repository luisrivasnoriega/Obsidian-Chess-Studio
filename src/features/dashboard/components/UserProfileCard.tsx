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
import {
  IconAlertTriangle,
  IconBolt,
  IconEdit,
  IconGauge,
  IconRocket,
  IconStopwatch,
  IconSun,
  IconTargetArrow,
} from "@tabler/icons-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import LichessLogo from "@/features/profiles/components/LichessLogo";
import { EditProfileModal } from "./EditProfileModal";

interface RatingHistory {
  classical?: number;
  rapid?: number;
  blitz?: number;
  bullet?: number;
}

type RatingKey = keyof RatingHistory;
type RatingSource = "lichess" | "chesscom" | "fide";

interface RatingSourceMeta {
  source: RatingSource;
  games: number;
  username?: string;
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
  ratingSources?: Partial<Record<RatingKey, RatingSourceMeta>>;
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
  linkedAccounts?: Array<{ platform: "lichess" | "chesscom"; username: string }>;
  currentLichessToken?: string;
  weekBlunderRate?: number | null;
  previousWeekBlunderRate?: number | null;
  weekAccuracy?: number | null;
  previousWeekAccuracy?: number | null;
  weekAcpl?: number | null;
  previousWeekAcpl?: number | null;
}

interface RatingEntry {
  key: RatingKey;
  label: string;
  color: string;
  accent: string;
  accentSoft: string;
  value: number | null;
  icon: ReactNode;
}

export function UserProfileCard({
  name,
  handle,
  title,
  ratingHistory,
  ratingSources,
  onFideUpdate,
  currentFideId,
  fidePlayer,
  customName,
  platform,
  linkedAccounts = [],
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

  const displayRatings = {
    classical: ratingHistory.classical,
    rapid: ratingHistory.rapid,
    blitz: ratingHistory.blitz,
    bullet: ratingHistory.bullet,
  };

  const accountChips = useMemo(() => {
    const chips = [...linkedAccounts];
    if (chips.length > 0) return chips;
    if (platform && handle.startsWith("@") && handle.length > 1) {
      return [{ platform, username: handle.slice(1) }];
    }
    return [];
  }, [handle, linkedAccounts, platform]);

  const renderPlatformIcon = (value: "lichess" | "chesscom", size = 14) =>
    value === "lichess" ? (
      <Box
        style={{
          width: rem(size),
          height: rem(size),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <LichessLogo />
      </Box>
    ) : (
      <Image w={rem(size)} h={rem(size)} src="/chesscom.png" alt="chess.com" style={{ flexShrink: 0 }} />
    );

  const getSourceLabel = (source: RatingSource): string => {
    if (source === "lichess") return t("features.dashboard.sourceLichess", { defaultValue: "Lichess" });
    if (source === "chesscom") return t("features.dashboard.sourceChessCom", { defaultValue: "Chess.com" });
    return t("features.dashboard.sourceFide", { defaultValue: "FIDE" });
  };

  const ratings = useMemo(() => {
    const entries: RatingEntry[] = [
      {
        key: "classical",
        label: t("features.dashboard.timeControlCards.standard", { defaultValue: "Standard" }),
        color: "indigo.5",
        accent: "#818cf8",
        accentSoft: "rgba(129, 140, 248, 0.15)",
        value: displayRatings.classical ?? null,
        icon: <IconSun size={15} stroke={2.5} />,
      },
      {
        key: "rapid",
        label: t("chess.timeControl.rapid", { defaultValue: "Rapid" }),
        color: "cyan.5",
        accent: "#22d3ee",
        accentSoft: "rgba(34, 211, 238, 0.15)",
        value: displayRatings.rapid ?? null,
        icon: <IconStopwatch size={15} stroke={2.5} />,
      },
      {
        key: "blitz",
        label: t("chess.timeControl.blitz", { defaultValue: "Blitz" }),
        color: "yellow.5",
        accent: "#fde047",
        accentSoft: "rgba(253, 224, 71, 0.15)",
        value: displayRatings.blitz ?? null,
        icon: <IconBolt size={15} stroke={2.7} />,
      },
      {
        key: "bullet",
        label: t("chess.timeControl.bullet", { defaultValue: "Bullet" }),
        color: "red.5",
        accent: "#ff4d4f",
        accentSoft: "rgba(255, 77, 79, 0.16)",
        value: displayRatings.bullet ?? null,
        icon: <IconRocket size={15} stroke={2.5} />,
      },
    ];

    return entries.flatMap((entry) => (typeof entry.value === "number" ? [{ ...entry, value: entry.value }] : []));
  }, [displayRatings.blitz, displayRatings.bullet, displayRatings.classical, displayRatings.rapid, t]);

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
            <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>
              <Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
                <Text fw={800} fz="lg" truncate>
                  {displayName}
                </Text>
                {accountChips.length > 0 && (
                  <Group gap={6} wrap="wrap">
                    {accountChips.map((account) => (
                      <Group
                        key={`${account.platform}:${account.username.toLowerCase()}`}
                        gap={4}
                        wrap="nowrap"
                        px={6}
                        py={2}
                        style={{
                          borderRadius: 999,
                          border:
                            "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))",
                          background:
                            "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 92%, var(--mantine-color-dark-5) 8%), var(--mantine-color-dark-6))",
                          maxWidth: "100%",
                        }}
                      >
                        {renderPlatformIcon(account.platform, 12)}
                        <Text size="xs" c="dimmed" truncate>
                          @{account.username}
                        </Text>
                      </Group>
                    ))}
                  </Group>
                )}
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
                const sourceMeta = ratingSources?.[rating.key];
                const sourceLabel = sourceMeta ? getSourceLabel(sourceMeta.source) : null;
                const sourceDescription =
                  sourceMeta == null
                    ? null
                    : sourceMeta.source === "fide"
                      ? sourceLabel
                      : `${sourceLabel}${sourceMeta.username ? ` · @${sourceMeta.username}` : ""}${
                          sourceMeta.games > 0
                            ? ` · ${t("features.dashboard.ratingGamesCount", {
                                count: sourceMeta.games,
                                defaultValue: "{{count}} games",
                              })}`
                            : ""
                        }`;
                return (
                  <Stack
                    key={rating.key}
                    gap={6}
                    p="sm"
                    style={{
                      borderRadius: 12,
                      border: `1px solid color-mix(in srgb, ${rating.accent} 34%, var(--mantine-color-dark-4))`,
                      background: `radial-gradient(110% 120% at 0% 0%, ${rating.accentSoft} 0%, transparent 52%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 92%, var(--mantine-color-dark-5) 8%), var(--mantine-color-dark-6))`,
                      boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 12px 26px color-mix(in srgb, ${rating.accent} 10%, transparent)`,
                    }}
                  >
                    <Group justify="space-between" align="center" wrap="nowrap" gap={6}>
                      <Group gap={7} wrap="nowrap" style={{ minWidth: 0 }}>
                        <ThemeIcon
                          size={24}
                          radius="xl"
                          variant="filled"
                          color={rating.color}
                          style={{
                            color: "var(--mantine-color-dark-9)",
                            boxShadow: `0 0 18px color-mix(in srgb, ${rating.accent} 34%, transparent)`,
                            flexShrink: 0,
                          }}
                        >
                          {rating.icon}
                        </ThemeIcon>
                        <Text size="xs" fw={800} c={rating.accent} truncate>
                          {rating.label}
                        </Text>
                      </Group>
                      {sourceMeta && sourceMeta.source !== "fide" && renderPlatformIcon(sourceMeta.source, 12)}
                    </Group>
                    <Text fw={850} fz="xl" lh={1.05}>
                      {rating.value}
                    </Text>
                    {sourceDescription && (
                      <Text size="xs" c="dimmed" lineClamp={1}>
                        {sourceDescription}
                      </Text>
                    )}
                    <Progress
                      value={ratio}
                      size="xs"
                      radius="xl"
                      color={rating.accent}
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

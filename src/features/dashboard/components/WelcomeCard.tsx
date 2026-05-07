import { Badge, Box, Card, Group, Image, SimpleGrid, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconBolt, IconStopwatch, IconSun } from "@tabler/icons-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface WelcomeCardProps {
  isFirstOpen: boolean;
  onPlayChess?: () => void;
  playerFirstName?: string;
  playerGender?: "male" | "female";
  compact?: boolean;
  weekGames?: number;
  weekWinRate?: number;
  weekBlunderRate?: number | null;
  weekAccuracy?: number | null;
  weekPuzzleSolved?: number;
  fideInfo?: {
    title?: string;
    standardRating?: number;
    rapidRating?: number;
    blitzRating?: number;
    worldRank?: number;
    nationalRank?: number;
    photo?: string;
    age?: number;
  };
}

export function WelcomeCard({
  isFirstOpen,
  onPlayChess: _onPlayChess,
  playerFirstName,
  playerGender,
  compact = false,
  weekGames: _weekGames = 0,
  weekWinRate: _weekWinRate = 0,
  weekBlunderRate: _weekBlunderRate = null,
  weekAccuracy: _weekAccuracy = null,
  weekPuzzleSolved: _weekPuzzleSolved = 0,
  fideInfo,
}: WelcomeCardProps) {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();
  const [photoUrl, setPhotoUrl] = useState<string | undefined>(undefined);
  const [heroImageSrc, setHeroImageSrc] = useState("/logo.png");
  const isMobile = layout.settings.layoutType === "mobile";
  const isCompact = compact || isMobile;
  const photoSize = isCompact ? 76 : 140;
  const heroImageSize = isCompact ? 120 : 280;

  // Convert file path to URL if needed (for local files)
  // If it's already a URL (http/https) or tauri://, use it directly
  useEffect(() => {
    if (!fideInfo?.photo) {
      setPhotoUrl(undefined);
      return;
    }

    // If it's already a URL (http, https, or tauri://), use it directly
    if (
      fideInfo.photo.startsWith("http://") ||
      fideInfo.photo.startsWith("https://") ||
      fideInfo.photo.startsWith("tauri://") ||
      fideInfo.photo.startsWith("data:") ||
      fideInfo.photo.startsWith("blob:")
    ) {
      setPhotoUrl(fideInfo.photo);
      return;
    }

    try {
      const url = convertFileSrc(fideInfo.photo);
      setPhotoUrl(url);
    } catch {
      setPhotoUrl(fideInfo.photo);
    }
  }, [fideInfo?.photo]);

  const backgroundImageAlt = "Obsidian Chess Studio";

  const handleImageError = () => {
    if (heroImageSrc !== "/chess-play.png") {
      setHeroImageSrc("/chess-play.png");
    }
  };

  const hasFideCompactHighlights = Boolean(
    fideInfo &&
      (fideInfo.title ||
        fideInfo.age ||
        fideInfo.worldRank ||
        fideInfo.nationalRank ||
        fideInfo.standardRating ||
        fideInfo.rapidRating ||
        fideInfo.blitzRating),
  );
  const fideRatingCards = [
    {
      key: "standard",
      label: t("features.dashboard.timeControlCards.standard", { defaultValue: "Standard" }),
      value: fideInfo?.standardRating,
      accent: "#818cf8",
      accentSoft: "rgba(129, 140, 248, 0.15)",
      color: "indigo.5",
      icon: <IconSun size={15} stroke={2.5} />,
    },
    {
      key: "rapid",
      label: t("features.dashboard.editProfile.rapid"),
      value: fideInfo?.rapidRating,
      accent: "#22d3ee",
      accentSoft: "rgba(34, 211, 238, 0.15)",
      color: "cyan.5",
      icon: <IconStopwatch size={15} stroke={2.5} />,
    },
    {
      key: "blitz",
      label: t("features.dashboard.editProfile.blitz"),
      value: fideInfo?.blitzRating,
      accent: "#fde047",
      accentSoft: "rgba(253, 224, 71, 0.15)",
      color: "yellow.5",
      icon: <IconBolt size={15} stroke={2.7} />,
    },
  ];
  // Determine welcome message based on first open, player name, title, and gender
  let welcomeMessage: string;

  if (isFirstOpen) {
    welcomeMessage = t("features.dashboard.welcome.firstOpen");
  } else if (playerFirstName) {
    const genderKey = playerGender === "female" ? "female" : "male";
    // If there's a FIDE title, include it in the greeting
    if (fideInfo?.title) {
      const nameWithTitle = `${fideInfo.title} ${playerFirstName}`;
      welcomeMessage = t(`features.dashboard.welcome.backWithName.${genderKey}`, {
        name: nameWithTitle,
      });
    } else {
      welcomeMessage = t(`features.dashboard.welcome.backWithName.${genderKey}`, {
        name: playerFirstName,
      });
    }
  } else {
    welcomeMessage = t("features.dashboard.welcome.back");
  }

  return (
    <Card
      shadow="sm"
      p={isCompact ? "md" : "lg"}
      radius="lg"
      h="100%"
      withBorder
      style={{
        background:
          "radial-gradient(90% 140% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 18%, transparent) 0%, transparent 62%), linear-gradient(150deg, color-mix(in srgb, var(--mantine-color-dark-7) 88%, var(--mantine-color-dark-5) 12%), var(--mantine-color-dark-7))",
        borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 22%, var(--mantine-color-dark-4))",
      }}
    >
      <Stack gap={isCompact ? "sm" : "lg"} h="100%" justify="space-between">
        <Group
          align={isMobile ? "flex-start" : "center"}
          justify="flex-start"
          wrap={isMobile ? "wrap" : "nowrap"}
          gap={isCompact ? "sm" : "xl"}
        >
          {/* Left column: FIDE profile photo - only show if it exists */}
          {photoUrl && !compact ? (
            <Box
              style={{
                position: "relative",
                borderRadius: "12px",
                overflow: "hidden",
                border: "3px solid var(--mantine-color-blue-6)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                flexShrink: 0,
              }}
            >
              <Image
                src={photoUrl}
                alt="FIDE Profile Photo"
                width={photoSize}
                height={photoSize}
                fit="cover"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </Box>
          ) : null}

          {/* Central column: Information and actions */}
          <Stack gap={isCompact ? "sm" : "md"} style={{ flex: 1, minWidth: 0 }}>
            <Stack gap={4}>
              <Title order={isCompact ? 2 : 1} fw={800}>
                {welcomeMessage}
              </Title>
              <Text size="sm" c="dimmed">
                {t("features.dashboard.welcome.desc")}
              </Text>
            </Stack>

            {/* FIDE Information */}
            {!compact &&
              fideInfo &&
              (fideInfo.title || fideInfo.age || fideInfo.worldRank || fideInfo.nationalRank) && (
                <Group gap="md" wrap="wrap">
                  {fideInfo.title && (
                    <Badge size="lg" color="yellow" variant="light">
                      {fideInfo.title}
                    </Badge>
                  )}
                  {fideInfo.age && (
                    <Badge size="lg" color="blue" variant="light">
                      {fideInfo.age} {t("common.years")}
                    </Badge>
                  )}
                  {fideInfo.worldRank && (
                    <Badge size="lg" color="grape" variant="light">
                      World #{fideInfo.worldRank}
                    </Badge>
                  )}
                  {fideInfo.nationalRank && (
                    <Badge size="lg" color="teal" variant="light">
                      National #{fideInfo.nationalRank}
                    </Badge>
                  )}
                </Group>
              )}

            {/* Ratings FIDE */}
            {!compact && fideInfo && (fideInfo.standardRating || fideInfo.rapidRating || fideInfo.blitzRating) && (
              <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="xs">
                {fideRatingCards
                  .filter((rating) => typeof rating.value === "number")
                  .map((rating) => (
                    <Stack
                      key={rating.key}
                      gap={4}
                      px="sm"
                      py={8}
                      style={{
                        minWidth: 116,
                        borderRadius: 12,
                        border: `1px solid color-mix(in srgb, ${rating.accent} 34%, var(--mantine-color-dark-4))`,
                        background: `radial-gradient(110% 120% at 0% 0%, ${rating.accentSoft} 0%, transparent 52%), linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 92%, var(--mantine-color-dark-5) 8%), var(--mantine-color-dark-6))`,
                        boxShadow: `inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 12px 26px color-mix(in srgb, ${rating.accent} 10%, transparent)`,
                      }}
                    >
                      <Group gap={7} wrap="nowrap">
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
                      <Text fw={850} fz="xl" lh={1.05}>
                        {rating.value}
                      </Text>
                    </Stack>
                  ))}
              </SimpleGrid>
            )}
          </Stack>

          {!isMobile && (
            <Box style={{ flexShrink: 0, marginLeft: "auto" }}>
              <Image
                src={heroImageSrc}
                alt={backgroundImageAlt}
                radius="lg"
                onError={handleImageError}
                width={isCompact ? 92 : heroImageSize}
                height={isCompact ? 92 : heroImageSize}
                fit="contain"
                style={{
                  opacity: isCompact ? 0.9 : 1,
                  filter: isCompact ? "drop-shadow(0 8px 16px rgba(0, 0, 0, 0.35))" : undefined,
                }}
              />
            </Box>
          )}
        </Group>

        {isCompact && (
          <Box
            style={{
              borderRadius: 12,
              border: "1px solid color-mix(in srgb, var(--mantine-color-blue-8) 16%, var(--mantine-color-dark-4))",
              background:
                "linear-gradient(150deg, color-mix(in srgb, var(--mantine-color-dark-6) 92%, var(--mantine-color-dark-4) 8%), var(--mantine-color-dark-6))",
              padding: 12,
            }}
          >
            {hasFideCompactHighlights ? (
              <Stack gap={8}>
                <Group gap={6} wrap="wrap">
                  {fideInfo?.title && (
                    <Badge color="yellow" variant="light" radius="xl">
                      {fideInfo.title}
                    </Badge>
                  )}
                  {fideInfo?.age && (
                    <Badge color="blue" variant="light" radius="xl">
                      {fideInfo.age} {t("common.years")}
                    </Badge>
                  )}
                  {fideInfo?.worldRank && (
                    <Badge color="grape" variant="light" radius="xl">
                      #{fideInfo.worldRank} {t("features.dashboard.welcome.worldRank")}
                    </Badge>
                  )}
                  {fideInfo?.nationalRank && (
                    <Badge color="teal" variant="light" radius="xl">
                      #{fideInfo.nationalRank} {t("features.dashboard.welcome.nationalRank")}
                    </Badge>
                  )}
                </Group>

                <SimpleGrid cols={3} spacing={8}>
                  {fideRatingCards.map((rating) => (
                    <Stack
                      key={rating.key}
                      gap={4}
                      align="center"
                      p={8}
                      style={{
                        borderRadius: 10,
                        border: `1px solid color-mix(in srgb, ${rating.accent} 30%, var(--mantine-color-dark-4))`,
                        background: `radial-gradient(100% 100% at 0% 0%, ${rating.accentSoft} 0%, transparent 58%), color-mix(in srgb, var(--mantine-color-dark-6) 90%, var(--mantine-color-dark-5) 10%)`,
                      }}
                    >
                      <ThemeIcon
                        size={24}
                        radius="xl"
                        variant="filled"
                        color={rating.color}
                        style={{
                          color: "var(--mantine-color-dark-9)",
                          boxShadow: `0 0 16px color-mix(in srgb, ${rating.accent} 34%, transparent)`,
                        }}
                      >
                        {rating.icon}
                      </ThemeIcon>
                      <Text size="xs" fw={800} c={rating.accent} truncate>
                        {rating.label}
                      </Text>
                      <Text fw={850} c="gray.0" lh={1}>
                        {rating.value ?? "--"}
                      </Text>
                    </Stack>
                  ))}
                </SimpleGrid>
              </Stack>
            ) : (
              <Stack gap={4}>
                <Text size="sm" fw={600}>
                  {t("features.dashboard.dailyGoals")}
                </Text>
                <Text size="xs" c="dimmed">
                  {t("features.dashboard.keepStreak")}
                </Text>
              </Stack>
            )}
          </Box>
        )}

        {isMobile && (
          <Box style={{ width: "100%" }}>
            <Image
              src={heroImageSrc}
              alt={backgroundImageAlt}
              radius="lg"
              onError={handleImageError}
              style={{ width: "100%", height: heroImageSize }}
              fit="cover"
            />
          </Box>
        )}
      </Stack>
    </Card>
  );
}

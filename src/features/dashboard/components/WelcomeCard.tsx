import { Badge, Box, Button, Card, Group, Image, Stack, Text, Title } from "@mantine/core";
import { IconChess, IconUpload } from "@tabler/icons-react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { currentThemeIdAtom } from "@/features/themes/state/themeAtoms";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { welcomeCardImageAtom } from "@/state/atoms";

interface WelcomeCardProps {
  isFirstOpen: boolean;
  onPlayChess: () => void;
  onImportGame: () => void;
  playerFirstName?: string;
  playerGender?: "male" | "female";
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
  onPlayChess,
  onImportGame,
  playerFirstName,
  playerGender,
  fideInfo,
}: WelcomeCardProps) {
  const { t } = useTranslation();
  const currentThemeId = useAtomValue(currentThemeIdAtom);
  const { layout } = useResponsiveLayout();
  const [imageError, setImageError] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | undefined>(undefined);
  const [customImageUrl, setCustomImageUrl] = useState<string | undefined>(undefined);
  const [welcomeCardImage, setWelcomeCardImage] = useAtom(welcomeCardImageAtom);
  const isCompact = layout.settings.layoutType === "mobile";
  const photoSize = isCompact ? 96 : 140;
  const heroImageSize = isCompact ? 180 : 280;

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

  // Convert custom image path to URL if needed
  useEffect(() => {
    if (!welcomeCardImage) {
      setCustomImageUrl(undefined);
      return;
    }

    // If it's already a URL (http, https, or tauri://), use it directly
    if (
      welcomeCardImage.startsWith("http://") ||
      welcomeCardImage.startsWith("https://") ||
      welcomeCardImage.startsWith("tauri://") ||
      welcomeCardImage.startsWith("data:") ||
      welcomeCardImage.startsWith("blob:")
    ) {
      setCustomImageUrl(welcomeCardImage);
      return;
    }

    // If it's a relative path (starts with welcome-card-image/), resolve it relative to AppData
    if (welcomeCardImage.startsWith("welcome-card-image/")) {
      // Resolve the path relative to AppData
      import("@tauri-apps/api/path").then(({ resolve, appDataDir }) => {
        appDataDir()
          .then((base) => resolve(base, welcomeCardImage))
          .then((fullPath) => {
            try {
              const url = convertFileSrc(fullPath);
              setCustomImageUrl(url);
            } catch {
              setCustomImageUrl(welcomeCardImage);
            }
          })
          .catch(() => {
            setCustomImageUrl(welcomeCardImage);
          });
      });
      return;
    }

    // Otherwise, treat as absolute path
    try {
      const url = convertFileSrc(welcomeCardImage);
      setCustomImageUrl(url);
    } catch {
      setCustomImageUrl(welcomeCardImage);
    }
  }, [welcomeCardImage]);

  // Determine theme-based background image
  const isAcademiaMaya = currentThemeId === "academia-maya";
  const defaultBackgroundImageSrc = isAcademiaMaya ? "/academia.maya.png" : "/chess-play.png";
  const backgroundImageSrc = customImageUrl || defaultBackgroundImageSrc;
  const backgroundImageAlt = isAcademiaMaya ? "Academia Maya" : "Chess play";

  const handleImageError = () => {
    if (isAcademiaMaya && !imageError) {
      setImageError(true);
    }
  };

  const handleImageClick = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: "Image",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
          },
        ],
      });
      if (selected && typeof selected === "string") {
        // Use the command to copy the image to AppData
        try {
          const relativePath = await invoke<string>("save_welcome_card_image", {
            sourcePath: selected,
          });
          // Save the relative path (e.g., "welcome-card-image/custom-image.png")
          setWelcomeCardImage(relativePath);
        } catch (error) {
          console.error("Error saving image:", error);
        }
      }
    } catch (error) {
      console.error("Error selecting image:", error);
    }
  };

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
    <Card shadow="sm" p={isCompact ? "md" : "lg"} radius="md" withBorder>
      <Stack gap={isCompact ? "md" : "lg"}>
        <Group
          align={isCompact ? "flex-start" : "center"}
          justify="flex-start"
          wrap={isCompact ? "wrap" : "nowrap"}
          gap={isCompact ? "md" : "xl"}
        >
          {/* Left column: FIDE profile photo - only show if it exists */}
          {photoUrl ? (
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
          <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
            <Stack gap={4}>
              <Title order={1} fw={800}>
                {welcomeMessage}
              </Title>
              <Text size="sm" c="dimmed">
                {t("features.dashboard.welcome.desc")}
              </Text>
            </Stack>

            {/* FIDE Information */}
            {fideInfo && (fideInfo.title || fideInfo.age || fideInfo.worldRank || fideInfo.nationalRank) && (
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
            {fideInfo && (fideInfo.standardRating || fideInfo.rapidRating || fideInfo.blitzRating) && (
              <Group gap="xl" align="flex-start" wrap="wrap">
                {fideInfo.standardRating && (
                  <Stack gap={2} align="center">
                    <Text size="xs" c="teal.6" fw={500}>
                      {t("features.dashboard.editProfile.standard")}
                    </Text>
                    <Text fz={{ base: "1.375rem", sm: "1.625rem", md: "1.875rem" }} c="teal.6" fw={700} lh={1}>
                      {fideInfo.standardRating}
                    </Text>
                  </Stack>
                )}
                {fideInfo.rapidRating && (
                  <Stack gap={2} align="center">
                    <Text size="xs" c="teal.6" fw={500}>
                      {t("features.dashboard.editProfile.rapid")}
                    </Text>
                    <Text fz={{ base: "1.375rem", sm: "1.625rem", md: "1.875rem" }} c="teal.6" fw={700} lh={1}>
                      {fideInfo.rapidRating}
                    </Text>
                  </Stack>
                )}
                {fideInfo.blitzRating && (
                  <Stack gap={2} align="center">
                    <Text size="xs" c="yellow.6" fw={500}>
                      {t("features.dashboard.editProfile.blitz")}
                    </Text>
                    <Text fz={{ base: "1.375rem", sm: "1.625rem", md: "1.875rem" }} c="yellow.6" fw={700} lh={1}>
                      {fideInfo.blitzRating}
                    </Text>
                  </Stack>
                )}
              </Group>
            )}

            {/* Action buttons */}
            <Group gap="xs" mt="xs" wrap={isCompact ? "wrap" : "nowrap"}>
              {!isCompact && (
                <Button radius="md" onClick={onPlayChess} leftSection={<IconChess size={18} />} fullWidth={isCompact}>
                  {t("features.dashboard.cards.playChess.button")}
                </Button>
              )}
              <Button
                variant="light"
                radius="md"
                onClick={onImportGame}
                leftSection={<IconUpload size={18} />}
                fullWidth={isCompact}
              >
                {t("features.tabs.importGame.button")}
              </Button>
            </Group>
          </Stack>

          {!isCompact && (
            <Box style={{ flexShrink: 0, marginLeft: "auto" }}>
              <Image
                src={backgroundImageSrc}
                alt={backgroundImageAlt}
                radius="lg"
                onError={handleImageError}
                width={heroImageSize}
                height={heroImageSize}
                fit="contain"
                style={{ cursor: "pointer" }}
                onClick={handleImageClick}
                title={t("features.dashboard.welcome.clickToChangeImage")}
              />
            </Box>
          )}
        </Group>

        {isCompact && (
          <Box style={{ width: "100%" }}>
            <Image
              src={backgroundImageSrc}
              alt={backgroundImageAlt}
              radius="lg"
              onError={handleImageError}
              style={{ width: "100%", height: heroImageSize, cursor: "pointer" }}
              fit="cover"
              onClick={handleImageClick}
              title={t("features.dashboard.welcome.clickToChangeImage")}
            />
          </Box>
        )}
      </Stack>
    </Card>
  );
}

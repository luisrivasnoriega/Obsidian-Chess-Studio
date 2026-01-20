import { Box, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface PanelLoadingStateProps {
  isLoading?: boolean;
  isFetching?: boolean;
  hasData?: boolean;
  message?: string;
}

/**
 * Standardized loading state component for PersonalCard panels.
 * Shows loading indicator whenever isLoading or isFetching is true,
 * providing consistent user feedback across all panels.
 */
export function PanelLoadingState({
  isLoading = false,
  isFetching = false,
  hasData = false,
  message,
}: PanelLoadingStateProps) {
  const { t } = useTranslation();

  // Show loading if either isLoading (initial load) or isFetching (refetch) is true
  if (!isLoading && !isFetching) {
    return null;
  }

  const displayMessage = message ?? t("common.loadingGames", { defaultValue: "Loading games..." });

  // UX:
  // - If we don't have any data yet, show a centered loader (blocking).
  // - If we already have data (refetching), show a small banner (non-blocking).
  if (!hasData) {
    return (
      <Center h="100%" p="md">
        <Stack align="center" gap="md">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            {displayMessage}
          </Text>
        </Stack>
      </Center>
    );
  }

  return (
    <Box p="md" pb={0}>
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          {displayMessage}
        </Text>
      </Group>
    </Box>
  );
}

import type { MantineColor } from "@mantine/core";
import { Button, Card, Group, SimpleGrid, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface QuickAction {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
  color: MantineColor;
}

interface QuickActionsGridProps {
  actions: QuickAction[];
}

export function QuickActionsGrid({ actions }: QuickActionsGridProps) {
  const { t } = useTranslation();

  return (
    <Card
      withBorder
      p="lg"
      radius="md"
      h="100%"
      style={{
        background:
          "radial-gradient(90% 140% at 0% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 16%, transparent) 0%, transparent 55%), linear-gradient(150deg, color-mix(in srgb, var(--mantine-color-dark-7) 86%, var(--mantine-color-dark-5) 14%), var(--mantine-color-dark-7))",
        borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 14%, var(--mantine-color-dark-4))",
      }}
    >
      <SimpleGrid cols={{ base: 1, xs: 2, sm: 2, md: 2, lg: 4, xl: 4 }} spacing="md">
        {actions.map((qa) => (
          <Card
            key={qa.title}
            withBorder
            radius="md"
            p="md"
            style={{
              background:
                "linear-gradient(145deg, color-mix(in srgb, var(--mantine-color-dark-6) 88%, var(--mantine-color-dark-4) 12%), var(--mantine-color-dark-6))",
              borderColor: "color-mix(in srgb, var(--mantine-color-blue-8) 12%, var(--mantine-color-dark-4))",
              minHeight: 172,
            }}
          >
            <Stack gap={8} align="flex-start" h="100%" justify="space-between">
              <Group>
                <ThemeIcon variant="light" color={qa.color} size={42} radius="md">
                  {qa.icon}
                </ThemeIcon>
                <Text fw={600}>{qa.title}</Text>
              </Group>
              <Text size="sm" c="dimmed">
                {qa.description}
              </Text>
              <Button size="sm" variant="light" rightSection={<IconArrowRight size={16} />} onClick={qa.onClick}>
                {t("common.open")}
              </Button>
            </Stack>
          </Card>
        ))}
      </SimpleGrid>
    </Card>
  );
}

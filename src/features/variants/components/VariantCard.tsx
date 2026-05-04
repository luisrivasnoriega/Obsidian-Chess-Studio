import { ActionIcon, Badge, Card, Code, Group, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { IconEdit, IconEye, IconGitBranch, IconSettings, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { VariantInfo } from "../types";

interface VariantCardProps {
  variant: VariantInfo;
  isSelected?: boolean;
  onEdit: (variant: VariantInfo) => void;
  onDelete: (variant: VariantInfo) => void;
  onEditComments: (variant: VariantInfo) => void;
  onConfigure: (variant: VariantInfo) => void;
  onCoverageGraph: (variant: VariantInfo) => void;
}

export function VariantCard({
  variant,
  isSelected,
  onEdit,
  onDelete,
  onEditComments,
  onConfigure,
  onCoverageGraph,
}: VariantCardProps) {
  const { t } = useTranslation();
  const childCount = variant.childLinks?.length ?? 0;

  return (
    <Card
      withBorder
      p="md"
      radius="lg"
      style={{
        cursor: "pointer",
        borderColor: isSelected
          ? "color-mix(in srgb, var(--mantine-color-blue-6) 55%, var(--mantine-color-dark-4))"
          : "color-mix(in srgb, var(--mantine-color-blue-8) 18%, var(--mantine-color-dark-4))",
        borderWidth: isSelected ? 2 : 1,
        background:
          "radial-gradient(120% 170% at 100% 0%, color-mix(in srgb, var(--mantine-color-blue-9) 24%, transparent) 0%, transparent 58%), linear-gradient(155deg, color-mix(in srgb, var(--mantine-color-dark-7) 82%, var(--mantine-color-dark-5) 18%), var(--mantine-color-dark-7))",
      }}
      onClick={() => onEdit(variant)}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <ThemeIcon variant="light" color="blue" radius="md" size={30}>
              <IconGitBranch size={16} />
            </ThemeIcon>
            <Text fw={600} size="sm" truncate style={{ flex: 1 }}>
              {variant.name}
            </Text>
          </Group>
          <Group gap="xs" onClick={(e) => e.stopPropagation()}>
            <Tooltip label={t("common.view", { defaultValue: "View" })}>
              <ActionIcon variant="subtle" color="blue" size="sm" onClick={() => onEdit(variant)}>
                <IconEye size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("features.board.variants.editComments", { defaultValue: "Edit Comments / References" })}>
              <ActionIcon variant="subtle" color="grape" size="sm" onClick={() => onEditComments(variant)}>
                <IconEdit size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("features.board.variants.configureBuild", { defaultValue: "Configure data source" })}>
              <ActionIcon variant="subtle" color="cyan" size="sm" onClick={() => onConfigure(variant)}>
                <IconSettings size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("features.board.variants.coverageGraph", { defaultValue: "Open coverage graph" })}>
              <ActionIcon variant="subtle" color="blue" size="sm" onClick={() => onCoverageGraph(variant)}>
                <IconGitBranch size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
              <ActionIcon variant="subtle" color="red" size="sm" onClick={() => onDelete(variant)}>
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {variant.opening && (
          <Text size="xs" c="dimmed" truncate>
            <Text component="span" fw={500}>
              {t("features.board.variants.opening", { defaultValue: "Opening" })}:
            </Text>{" "}
            {variant.opening}
          </Text>
        )}

        {variant.fen && (
          <Stack gap={2}>
            <Text size="xs" fw={500} c="dimmed">
              {t("features.board.variants.fen", { defaultValue: "FEN" })}:
            </Text>
            <Code fz="xs" style={{ wordBreak: "break-all" }}>
              {variant.fen}
            </Code>
          </Stack>
        )}

        <Group gap="xs" wrap="wrap">
          <Badge variant="dot" color="blue" size="sm">
            {t("features.board.variants.links", { defaultValue: "Links" })}: {childCount + (variant.parentLink ? 1 : 0)}
          </Badge>
          {variant.depth !== null && (
            <Badge variant="light" size="sm">
              {t("features.board.variants.depth", { defaultValue: "Depth" })}: {variant.depth}
            </Badge>
          )}
          {variant.engine && (
            <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
              {variant.engine}
            </Badge>
          )}
          {variant.engineMs !== null && (
            <Badge variant="light" color="orange" size="sm">
              {t("features.board.variants.engineMs", { defaultValue: "Time" })}: {variant.engineMs}ms
            </Badge>
          )}
          {variant.variantsCount !== null && (
            <Badge variant="light" color="blue" size="sm">
              {t("features.board.variants.variantsCount", { defaultValue: "Variants" })}: {variant.variantsCount}
            </Badge>
          )}
          {variant.parentLink ? (
            <Badge variant="outline" color="teal" size="sm">
              {t("features.board.variants.parentLink", { defaultValue: "Parent" })}
            </Badge>
          ) : null}
          {(variant.childLinks?.length ?? 0) > 0 ? (
            <Badge variant="light" color="cyan" size="sm">
              {t("features.board.variants.childLinks", { defaultValue: "Children" })}: {variant.childLinks?.length ?? 0}
            </Badge>
          ) : null}
        </Group>

        {variant.database && (
          <Text size="xs" c="dimmed" truncate>
            <Text component="span" fw={500}>
              {t("features.board.variants.database", { defaultValue: "Database" })}:
            </Text>{" "}
            {variant.database}
          </Text>
        )}

        {variant.comments && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            <Text component="span" fw={500}>
              {t("features.board.variants.comments", { defaultValue: "Comments" })}:
            </Text>{" "}
            {variant.comments}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

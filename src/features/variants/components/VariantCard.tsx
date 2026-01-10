import {
  ActionIcon,
  Badge,
  Card,
  Code,
  Group,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconEdit, IconEye, IconGitBranch, IconTrash } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

type VariantInfo = {
  name: string;
  path: string;
  opening: string | null;
  fen: string | null;
  depth: number | null;
  database: string | null;
  engine: string | null;
  engineMs: number | null;
  variantsCount: number | null;
  comments: string | null;
};

interface VariantCardProps {
  variant: VariantInfo;
  isSelected?: boolean;
  onEdit: (variant: VariantInfo) => void;
  onDelete: (variant: VariantInfo) => void;
  onEditComments: (variant: VariantInfo) => void;
}

export function VariantCard({ variant, isSelected, onEdit, onDelete, onEditComments }: VariantCardProps) {
  const { t } = useTranslation();

  return (
    <Card
      withBorder
      p="md"
      radius="md"
      style={{
        cursor: "pointer",
        borderColor: isSelected ? "var(--mantine-color-blue-6)" : undefined,
        borderWidth: isSelected ? 2 : 1,
      }}
      onClick={() => onEdit(variant)}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <IconGitBranch size="1.2rem" style={{ flexShrink: 0 }} />
            <Text fw={600} size="sm" truncate style={{ flex: 1 }}>
              {variant.name}
            </Text>
          </Group>
          <Group gap="xs" onClick={(e) => e.stopPropagation()}>
            <Tooltip label={t("common.view", { defaultValue: "View" })}>
              <ActionIcon
                variant="subtle"
                color="blue"
                size="sm"
                onClick={() => onEdit(variant)}
              >
                <IconEye size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("features.variants.editComments", { defaultValue: "Edit Comments / References" })}>
              <ActionIcon
                variant="subtle"
                color="grape"
                size="sm"
                onClick={() => onEditComments(variant)}
              >
                <IconEdit size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("common.delete", { defaultValue: "Delete" })}>
              <ActionIcon
                variant="subtle"
                color="red"
                size="sm"
                onClick={() => onDelete(variant)}
              >
                <IconTrash size={16} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {variant.opening && (
          <Text size="xs" c="dimmed" truncate>
            <Text component="span" fw={500}>
              {t("features.variants.opening", { defaultValue: "Opening" })}:
            </Text>{" "}
            {variant.opening}
          </Text>
        )}

        {variant.fen && (
          <Stack gap={2}>
            <Text size="xs" fw={500} c="dimmed">
              {t("features.variants.fen", { defaultValue: "FEN" })}:
            </Text>
            <Code size="xs" style={{ wordBreak: "break-all" }}>
              {variant.fen}
            </Code>
          </Stack>
        )}

        <Group gap="xs" wrap="wrap">
          {variant.depth !== null && (
            <Badge variant="light" size="sm">
              {t("features.variants.depth", { defaultValue: "Depth" })}: {variant.depth}
            </Badge>
          )}
          {variant.engine && (
            <Badge variant="outline" size="sm" style={{ textTransform: "none" }}>
              {variant.engine}
            </Badge>
          )}
          {variant.engineMs !== null && (
            <Badge variant="light" color="orange" size="sm">
              {t("features.variants.engineMs", { defaultValue: "Time" })}: {variant.engineMs}ms
            </Badge>
          )}
          {variant.variantsCount !== null && (
            <Badge variant="light" color="blue" size="sm">
              {t("features.variants.variantsCount", { defaultValue: "Variants" })}: {variant.variantsCount}
            </Badge>
          )}
        </Group>

        {variant.database && (
          <Text size="xs" c="dimmed" truncate>
            <Text component="span" fw={500}>
              {t("features.variants.database", { defaultValue: "Database" })}:
            </Text>{" "}
            {variant.database}
          </Text>
        )}

        {variant.comments && (
          <Text size="xs" c="dimmed" lineClamp={2}>
            <Text component="span" fw={500}>
              {t("features.variants.comments", { defaultValue: "Comments" })}:
            </Text>{" "}
            {variant.comments}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

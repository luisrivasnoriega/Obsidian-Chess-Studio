import { Alert, Center, SimpleGrid, Skeleton, Stack } from "@mantine/core";
import { IconGitBranch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { VariantInfo } from "../types";
import { VariantCard } from "./VariantCard";

interface VariantGridViewProps {
  variants: VariantInfo[];
  isLoading: boolean;
  onEdit: (variant: VariantInfo) => void;
  onDelete: (variant: VariantInfo) => void;
  onEditComments: (variant: VariantInfo) => void;
  onConfigure: (variant: VariantInfo) => void;
  onCoverageGraph: (variant: VariantInfo) => void;
  gridCols: number | { base: number; md?: number; lg?: number };
}

export function VariantGridView({
  variants,
  isLoading,
  onEdit,
  onDelete,
  onEditComments,
  onConfigure,
  onCoverageGraph,
  gridCols,
}: VariantGridViewProps) {
  const { t } = useTranslation();

  if (isLoading) {
    const isMobile = typeof gridCols === "number" ? gridCols === 1 : gridCols.base === 1;

    if (isMobile) {
      return (
        <Stack gap="md">
          <Skeleton h="12rem" />
          <Skeleton h="12rem" />
          <Skeleton h="12rem" />
        </Stack>
      );
    }

    return (
      <SimpleGrid cols={gridCols} spacing={{ base: "md", md: "sm" }}>
        <Skeleton h="12rem" />
        <Skeleton h="12rem" />
        <Skeleton h="12rem" />
        <Skeleton h="12rem" />
      </SimpleGrid>
    );
  }

  if (variants.length === 0) {
    return (
      <Center h="100%">
        <Alert
          title={t("common.noRecordsFound", { defaultValue: "No records found" })}
          color="gray"
          variant="light"
          icon={<IconGitBranch size={20} />}
        >
          {t("features.board.variants.empty", {
            defaultValue: "No variants found. Create a new variant to get started.",
          })}
        </Alert>
      </Center>
    );
  }

  return (
    <SimpleGrid cols={gridCols} spacing={{ base: "md", md: "sm" }}>
      {variants.map((variant) => (
        <VariantCard
          key={variant.path}
          variant={variant}
          onEdit={onEdit}
          onDelete={onDelete}
          onEditComments={onEditComments}
          onConfigure={onConfigure}
          onCoverageGraph={onCoverageGraph}
        />
      ))}
    </SimpleGrid>
  );
}

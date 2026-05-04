import { Alert, Button, Card, Drawer, Group, ScrollArea, SimpleGrid, Stack, Text, ThemeIcon } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconPlus } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useAtom } from "jotai";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader, { type SortState } from "@/components/GenericHeader";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { Route } from "@/routes/engines";
import { enginesAtom } from "@/state/atoms";
import { premiumActionButtonStyles, premiumKpiCardStyle, premiumPanelStyle } from "@/styles/premiumSurface";
import { CloudEngineSettings } from "./components/drawers/CloudEngineSettings";
import { EngineSettings } from "./components/drawers/EngineSettings";
import AddEngine from "./components/modals/AddEngine";
import { EnginesGrid } from "./components/views/EnginesGrid";
import { EnginesTable } from "./components/views/EnginesTable";
import { useEngineFiltering } from "./hooks/useEngineFiltering";

export default function EnginesPage() {
  const { t } = useTranslation();
  const { layout } = useResponsiveLayout();

  const [engines] = useAtom(enginesAtom);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(query, 300);
  const [sortBy, setSortBy] = useState<SortState>({ field: "name", direction: "asc" });
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [isLoading, setIsLoading] = useState(true);

  const { selected } = Route.useSearch();
  const navigate = useNavigate();

  const isMobile = layout.engines.layoutType === "mobile";
  const setSelected = (v: number | null) => {
    // @ts-expect-error
    navigate({ search: { selected: v ?? undefined } });
  };

  const selectedEngine = selected !== undefined ? engines[selected] : null;

  const filteredIndices = useEngineFiltering(engines, debouncedQuery, sortBy);
  const localEngineCount = engines.filter((engine) => engine.type === "local").length;
  const cloudEngineCount = engines.filter((engine) => engine.type !== "local").length;
  const visibleCount = filteredIndices.length;

  useState(() => {
    const timer = setTimeout(() => setIsLoading(false), 100);
    return () => clearTimeout(timer);
  });

  const sortOptions = [
    { value: "name", label: t("common.name", "Name") },
    { value: "elo", label: t("common.elo") },
  ];

  return (
    <>
      <GenericHeader
        title={t("features.engines.title")}
        folder="engines"
        searchPlaceholder={t("features.engines.searchPlaceholder")}
        query={query}
        setQuery={setQuery}
        sortOptions={sortOptions}
        currentSort={sortBy}
        onSortChange={setSortBy}
        viewMode={viewMode}
        setViewMode={setViewMode}
        pageKey="engines"
        actions={
          <Button
            size="xs"
            radius="xl"
            styles={premiumActionButtonStyles}
            leftSection={<IconPlus size="1rem" />}
            onClick={() => setOpened(true)}
          >
            {t("common.addNew")}
          </Button>
        }
      />
      <Stack px="md" pb="md">
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
          <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t("features.engines.kpis.total", "Engines")}
                </Text>
                <Text fw={800} fz="lg">
                  {engines.length}
                </Text>
              </Stack>
              <ThemeIcon variant="light" color="blue" radius="md">
                <IconPlus size={16} />
              </ThemeIcon>
            </Group>
          </Card>
          <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t("features.engines.kpis.visible", "Visible")}
                </Text>
                <Text fw={800} fz="lg">
                  {visibleCount}
                </Text>
              </Stack>
              <ThemeIcon variant="light" color="teal" radius="md">
                <IconPlus size={16} />
              </ThemeIcon>
            </Group>
          </Card>
          <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t("features.engines.kpis.local", "Local")}
                </Text>
                <Text fw={800} fz="lg">
                  {localEngineCount}
                </Text>
              </Stack>
              <ThemeIcon variant="light" color="cyan" radius="md">
                <IconPlus size={16} />
              </ThemeIcon>
            </Group>
          </Card>
          <Card withBorder radius="lg" p="sm" style={premiumKpiCardStyle}>
            <Group justify="space-between" wrap="nowrap">
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t("features.engines.kpis.cloud", "Cloud")}
                </Text>
                <Text fw={800} fz="lg">
                  {cloudEngineCount}
                </Text>
              </Stack>
              <ThemeIcon variant="light" color="grape" radius="md">
                <IconPlus size={16} />
              </ThemeIcon>
            </Group>
          </Card>
        </SimpleGrid>

        <Card withBorder radius="lg" p="sm" style={premiumPanelStyle}>
          <ScrollArea h="calc(100vh - 330px)" offsetScrollbars aria-live="polite">
            {filteredIndices.length === 0 && !isLoading ? (
              <Alert title={t("features.engines.noEnginesFound")} color="gray" variant="light">
                {t("features.engines.noEnginesFoundMessage")}
              </Alert>
            ) : viewMode === "grid" ? (
              <EnginesGrid
                engines={engines}
                filteredIndices={filteredIndices}
                selected={selected}
                setSelected={setSelected}
                isLoading={isLoading}
              />
            ) : (
              <EnginesTable
                engines={engines}
                filteredIndices={filteredIndices}
                selected={selected}
                setSelected={setSelected}
                isLoading={isLoading}
              />
            )}
          </ScrollArea>
        </Card>
      </Stack>
      <Drawer
        opened={selected !== undefined && selectedEngine !== null}
        onClose={() => setSelected(null)}
        position="right"
        size={isMobile ? "100%" : "xl"}
        title={selectedEngine ? selectedEngine.name : ""}
        overlayProps={{ backgroundOpacity: 0.5, blur: 4 }}
      >
        {selectedEngine &&
          selected !== undefined &&
          (selectedEngine.type === "local" ? (
            <EngineSettings selected={selected} setSelected={setSelected} isMobile={isMobile} />
          ) : (
            <CloudEngineSettings selectedEngine={selectedEngine} selected={selected} setSelected={setSelected} />
          ))}
      </Drawer>
      <AddEngine opened={opened} setOpened={setOpened} />
    </>
  );
}

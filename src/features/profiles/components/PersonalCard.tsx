import { ActionIcon, Box, DEFAULT_THEME, Flex, Paper, Select, Tabs, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconInfoCircle } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { PlayerGameInfo } from "@/bindings";
import { DatabaseViewStateContext } from "@/features/databases/components/DatabaseViewStateContext";
import FideInfo from "@/features/databases/components/drawers/FideInfo";
import { sessionsAtom } from "@/state/atoms";
import type { DatabaseViewStore } from "@/state/store/database";
import OpeningsPanel from "./PersonalCardPanels/OpeningsPanel";
import OverviewPanel from "./PersonalCardPanels/OverviewPanel";
import RatingsPanel from "./PersonalCardPanels/RatingsPanel";
import StatsPanel from "./PersonalCardPanels/StatsPanel";

type PlayerTabs = Array<"overview" | "ratings" | "openings" | "stats">;

function PersonalPlayerCard({
  name,
  setName,
  info,
  visibleTabs = ["overview", "ratings", "openings"],
  showPlayerSelector = true,
  profileId,
  isLoading,
}: {
  name: string;
  setName?: (name: string) => void;
  info: PlayerGameInfo;
  visibleTabs?: PlayerTabs;
  showPlayerSelector?: boolean;
  profileId?: string;
  isLoading?: boolean;
}) {
  const { t } = useTranslation();
  const isStackedLayout = useMediaQuery(`(width < ${DEFAULT_THEME.breakpoints.md})`);
  const store = useContext(DatabaseViewStateContext);
  if (!store) {
    throw new Error("DatabaseViewStateContext is missing");
  }
  const activeTab = useStore(store, (s) => s?.players?.activeTab);
  const setActiveTab = useStore(store, (s) => s.setPlayersActiveTab);

  const [opened, setOpened] = useState(false);
  const sessions = useAtomValue(sessionsAtom);
  const players = Array.from(
    new Set(sessions.map((s) => s.player || s.lichess?.username || s.chessCom?.username || "")),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const allowedTabs = useMemo<PlayerTabs>(() => {
    const defaults: PlayerTabs = ["overview", "ratings", "openings", "stats"];
    return defaults.filter((tab) => visibleTabs.includes(tab));
  }, [visibleTabs]);
  const isOpeningsTab = (activeTab ?? allowedTabs[0]) === "openings";
  const isStatsTab = (activeTab ?? allowedTabs[0]) === "stats";
  const showHeaderSelector = !isOpeningsTab && showPlayerSelector && setName != null;

  useEffect(() => {
    if (!allowedTabs.includes((activeTab ?? "overview") as PlayerTabs[number])) {
      setActiveTab(allowedTabs[0] as DatabaseViewStore["players"]["activeTab"]);
    }
  }, [activeTab, allowedTabs, setActiveTab]);

  return (
    <Paper
      h={isStackedLayout ? undefined : "100%"}
      shadow="sm"
      p="md"
      withBorder
      style={{ overflow: isStackedLayout ? "visible" : "hidden", display: "flex", flexDirection: "column" }}
    >
      <FideInfo key={name} opened={opened} setOpened={setOpened} name={name} />
      {!isOpeningsTab && showPlayerSelector && setName && (
        <Box pos="relative">
          {name !== "Stats" && (
            <Tooltip label={t("accounts.personalCard.fideInfo")}>
              <ActionIcon pos="absolute" right={0} onClick={() => setOpened(true)}>
                <IconInfoCircle />
              </ActionIcon>
            </Tooltip>
          )}
          <Flex justify="center" direction="column" gap="xs">
            <Select
              value={name}
              data={players}
              onChange={(e) => setName(e || "")}
              clearable={false}
              fw="bold"
              styles={{
                input: {
                  textAlign: "center",
                  fontSize: "1.25rem",
                },
              }}
            />
          </Flex>
        </Box>
      )}
      {allowedTabs.length > 1 ? (
        <Tabs
          mt={showHeaderSelector ? "xs" : 0}
          keepMounted={false}
          value={activeTab}
          onChange={(v) => setActiveTab(v as DatabaseViewStore["players"]["activeTab"])}
          variant="outline"
          flex={1}
          style={{
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <Tabs.List>
            {allowedTabs.includes("overview") && (
              <Tabs.Tab value="overview">{t("accounts.personalCard.tabs.overview")}</Tabs.Tab>
            )}
            {allowedTabs.includes("ratings") && (
              <Tabs.Tab value="ratings">{t("accounts.personalCard.tabs.ratings")}</Tabs.Tab>
            )}
          {allowedTabs.includes("openings") && (
            <Tabs.Tab value="openings">{t("accounts.personalCard.tabs.openings")}</Tabs.Tab>
          )}
          {allowedTabs.includes("stats") && (
            <Tabs.Tab value="stats">{t("profiles.tabs.stats", { defaultValue: "Stats" })}</Tabs.Tab>
          )}
          </Tabs.List>
          {allowedTabs.includes("overview") && (
            <Tabs.Panel value="overview">
              <OverviewPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
            </Tabs.Panel>
          )}
          {allowedTabs.includes("openings") && (
            <Tabs.Panel
              value="openings"
              style={{ flex: 1, minHeight: 0, overflow: isStackedLayout ? "visible" : "hidden", display: "flex" }}
            >
              <Box style={{ flex: 1, minHeight: 0, overflow: isStackedLayout ? "visible" : "hidden" }}>
                <OpeningsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
              </Box>
            </Tabs.Panel>
          )}
          {allowedTabs.includes("ratings") && (
            <Tabs.Panel value="ratings">
              <RatingsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
            </Tabs.Panel>
          )}
          {allowedTabs.includes("stats") && (
            <Tabs.Panel
              value="stats"
              style={{ flex: 1, minHeight: 0, overflow: isStatsTab ? "visible" : "hidden", display: "flex" }}
            >
              <Box style={{ flex: 1, minHeight: 0, overflow: isStackedLayout ? "visible" : "hidden" }}>
                <StatsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
              </Box>
            </Tabs.Panel>
          )}
        </Tabs>
      ) : (
        <>
          {allowedTabs.includes("overview") && (
            <OverviewPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
          )}
          {allowedTabs.includes("openings") && (
            <Box
              mt={showHeaderSelector ? "xs" : 0}
              style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}
            >
              <OpeningsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
            </Box>
          )}
          {allowedTabs.includes("ratings") && (
            <RatingsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
          )}
          {allowedTabs.includes("stats") && (
            <Box
              mt={showHeaderSelector ? "xs" : 0}
              style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex" }}
            >
              <StatsPanel playerName={name} info={info} profileId={profileId} isLoading={isLoading} />
            </Box>
          )}
        </>
      )}
    </Paper>
  );
}

export default PersonalPlayerCard;

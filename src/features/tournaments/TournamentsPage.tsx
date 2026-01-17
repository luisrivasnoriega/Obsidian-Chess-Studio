import { Box, Tabs } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader from "@/components/GenericHeader";
import { activeProfileIdAtom, profilesAtom } from "@/state/atoms";
import { CreateTournamentForm } from "./components/CreateTournamentForm";
import { TournamentList } from "./components/TournamentList";

export default function TournamentsPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("search");
  const [refreshKey, setRefreshKey] = useState(0);

  const profiles = useAtomValue(profilesAtom);
  const activeProfileId = useAtomValue(activeProfileIdAtom);
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? null,
    [activeProfileId, profiles],
  );
  const accountName = activeProfile?.name ?? null;
  const lichessToken = activeProfile?.lichessToken ?? null;

  useEffect(() => {
    const handleTemplateSaved = () => {
      setRefreshKey((prev) => prev + 1);
    };

    window.addEventListener("tournament-template-saved", handleTemplateSaved);
    return () => {
      window.removeEventListener("tournament-template-saved", handleTemplateSaved);
    };
  }, []);

  useEffect(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  return (
    <>
      <GenericHeader
        title={t("features.sidebar.tournaments", "Tournaments")}
        pageKey="tournaments"
        showViewToggle={false}
      />

      <Box px="md" pb="md">
        <Tabs value={activeTab} onChange={(v) => setActiveTab(v || "search")}>
          <Tabs.List>
            <Tabs.Tab value="search" leftSection={<IconSearch size={16} />}>
              {t("features.tournaments.search", "Search")}
            </Tabs.Tab>
            <Tabs.Tab value="create" leftSection={<IconPlus size={16} />}>
              {t("features.tournaments.create", "Create")}
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="search" pt="md">
            <TournamentList lichessToken={lichessToken} accountName={accountName} key={refreshKey} />
          </Tabs.Panel>

          <Tabs.Panel value="create" pt="md">
            <CreateTournamentForm
              lichessToken={lichessToken}
              accountName={accountName}
              onTemplateSaved={() => {
                setRefreshKey((prev) => prev + 1);
              }}
            />
          </Tabs.Panel>
        </Tabs>
      </Box>
    </>
  );
}

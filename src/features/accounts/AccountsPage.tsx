import { Button, SegmentedControl, Stack } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconUserCircle } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import GenericHeader, { type SortState } from "@/components/GenericHeader";
import Accounts from "./components/Accounts";
import DatabaseDrawer from "./components/drawers/DatabaseDrawer";

function AccountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [databasesOpened, { open: openDatabases, close: closeDatabases }] = useDisclosure(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortState>({ field: "name", direction: "asc" });
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");
  const [isLoading, setIsLoading] = useState(true);
  const [platformFilter, setPlatformFilter] = useState<"all" | "lichess" | "chesscom">("all");
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);

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
        title={t("accounts.title")}
        searchPlaceholder="Search accounts"
        query={query}
        setQuery={setQuery}
        sortOptions={sortOptions}
        currentSort={sortBy}
        onSortChange={setSortBy}
        viewMode={viewMode}
        setViewMode={setViewMode}
        pageKey="accounts"
        filters={
          <SegmentedControl
            size="xs"
            value={platformFilter}
            onChange={(v) => setPlatformFilter(v as "all" | "lichess" | "chesscom")}
            data={[
              { value: "all", label: t("common.all", { defaultValue: "All" }) },
              { value: "lichess", label: "Lichess" },
              { value: "chesscom", label: "Chess.com" },
            ]}
          />
        }
        actions={
          <Button size="xs" variant="default" leftSection={<IconUserCircle size="1rem" />} onClick={() => navigate({ to: "/profiles" })}>
            {t("profiles.title", { defaultValue: "Profiles" })}
          </Button>
        }
      />

      <Stack flex={1} style={{ overflow: "hidden" }} px="md" pb="md">
        <Accounts
          view={viewMode}
          query={query}
          sortBy={sortBy}
          isLoading={isLoading}
          platformFilter={platformFilter}
          onOpenPlayerDatabases={(playerName) => {
            setSelectedPlayer(playerName);
            openDatabases();
          }}
        />
      </Stack>

      <DatabaseDrawer opened={databasesOpened} onClose={closeDatabases} initialPlayer={selectedPlayer ?? undefined} />
    </>
  );
}

export default AccountsPage;

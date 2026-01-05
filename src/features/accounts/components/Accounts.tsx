import { useEffect, useState } from "react";
import type { DatabaseInfo } from "@/bindings";
import type { SortState } from "@/components/GenericHeader";
import { getDatabases } from "@/utils/db";
import AccountCards from "./views/AccountCards";
import AccountsTableView from "./views/AccountsTableView";

function Accounts({
  view,
  query,
  sortBy,
  isLoading = false,
  platformFilter = "all",
  onOpenPlayerDatabases,
}: {
  view: "grid" | "table";
  query: string;
  sortBy: SortState;
  isLoading?: boolean;
  platformFilter?: "all" | "lichess" | "chesscom";
  onOpenPlayerDatabases?: (playerName: string) => void;
}) {
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  useEffect(() => {
    getDatabases().then((dbs) => setDatabases(dbs));
  }, []);

  return (
    <>
      {view === "grid" ? (
        <AccountCards
          databases={databases}
          setDatabases={setDatabases}
          query={query}
          sortBy={sortBy}
          isLoading={isLoading}
          platformFilter={platformFilter}
          onOpenPlayerDatabases={onOpenPlayerDatabases}
        />
      ) : (
        <AccountsTableView
          databases={databases}
          setDatabases={setDatabases}
          query={query}
          sortBy={sortBy}
          isLoading={isLoading}
          platformFilter={platformFilter}
          onOpenPlayerDatabases={onOpenPlayerDatabases}
        />
      )}
    </>
  );
}

export default Accounts;

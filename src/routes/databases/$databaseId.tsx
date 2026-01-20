import { createFileRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { activeDatabaseViewStore } from "@/state/store/database";
import { getDatabases } from "@/utils/db";

const searchSchema = z.object({
  flow: z.enum(["online"]).optional(),
});

export const Route = createFileRoute("/databases/$databaseId")({
  component: lazyRouteComponent(() => import("@/features/databases/DatabaseView")),
  validateSearch: searchSchema,
  beforeLoad: async ({ params }) => {
    const databaseId = params.databaseId;

    const existing = activeDatabaseViewStore.getState().database;
    if (existing?.title === databaseId) {
      return null;
    }

    const databases = await getDatabases();
    const match = databases.find((db) => db.type === "success" && db.title === databaseId);
    if (!match || match.type !== "success") {
      throw redirect({ to: "/databases" });
    }

    activeDatabaseViewStore.getState().setDatabase(match);
    return null;
  },
});

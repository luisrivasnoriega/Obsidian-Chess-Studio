import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";
import { z } from "zod";

const searchSchema = z.object({
  value: z.enum(["add"]).optional(),
  tab: z.enum(["puzzles", "games"]).optional(),
  redirect: z.string().optional(),
});

export const Route = createFileRoute("/databases/")({
  component: lazyRouteComponent(() => import("@/features/databases/DatabasesPage")),
  validateSearch: searchSchema,
});

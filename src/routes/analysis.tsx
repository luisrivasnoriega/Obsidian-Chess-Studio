import { createFileRoute } from "@tanstack/react-router";
import BoardsRouteEntry from "@/features/boards/BoardsRouteEntry";

export const Route = createFileRoute("/analysis")({
  component: () => <BoardsRouteEntry mode="analysis" />,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});


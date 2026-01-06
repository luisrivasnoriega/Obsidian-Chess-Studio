import { createFileRoute } from "@tanstack/react-router";
import BoardsRouteEntry from "@/features/boards/BoardsRouteEntry";

export const Route = createFileRoute("/play")({
  component: () => <BoardsRouteEntry mode="play" />,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});


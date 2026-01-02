import { createFileRoute } from "@tanstack/react-router";
import BoardsRouteEntry from "@/features/boards/BoardsRouteEntry";

export const Route = createFileRoute("/puzzles")({
  component: () => <BoardsRouteEntry mode="puzzles" />,
  loader: ({ context: { loadDirs } }) => loadDirs(),
});


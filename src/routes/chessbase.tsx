import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/chessbase")({
  component: lazyRouteComponent(() => import("@/features/chessbase/ChessbasePage")),
});

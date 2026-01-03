import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/profiles")({
  component: lazyRouteComponent(() => import("@/features/profiles/ProfilesPage")),
});


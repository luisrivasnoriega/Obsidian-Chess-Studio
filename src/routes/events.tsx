import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/events")({
  component: lazyRouteComponent(() => import("@/features/events/EventsPage")),
});

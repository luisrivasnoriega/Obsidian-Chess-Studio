import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/variants")({
  component: lazyRouteComponent(() => import("@/features/variants/VariantsPage")),
});

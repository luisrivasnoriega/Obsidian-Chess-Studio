import { createFileRoute, Outlet } from "@tanstack/react-router";

const RouteComponent = () => <Outlet />;

export const Route = createFileRoute("/learn")({
  component: RouteComponent,
});

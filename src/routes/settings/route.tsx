import { createFileRoute, Outlet } from "@tanstack/react-router";
import { getVersion } from "@tauri-apps/api/app";

const RouteComponent = () => <Outlet />;

export const Route = createFileRoute("/settings")({
  component: RouteComponent,
  loader: async ({ context: { loadDirs } }) => ({
    dirs: await loadDirs(),
    version: await getVersion(),
  }),
});

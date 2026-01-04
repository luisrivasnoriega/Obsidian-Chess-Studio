import { createFileRoute } from "@tanstack/react-router";
import ProfilesRouteEntry from "@/features/profiles/ProfilesRouteEntry";

export const Route = createFileRoute("/profiles")({
  component: () => <ProfilesRouteEntry />,
});


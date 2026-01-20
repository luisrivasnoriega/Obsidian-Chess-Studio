import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/accounts")({
  beforeLoad: () => {
    throw redirect({ to: "/profiles" });
  },
});

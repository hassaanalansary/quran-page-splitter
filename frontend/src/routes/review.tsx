import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/review")({
  beforeLoad: () => {
    throw redirect({ to: "/verify" });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/cut-review")({
  beforeLoad: () => {
    throw redirect({ to: "/finalize" });
  },
});

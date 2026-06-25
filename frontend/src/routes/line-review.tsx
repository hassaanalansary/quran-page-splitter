import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/line-review")({
  beforeLoad: () => {
    throw redirect({ to: "/finalize" });
  },
});

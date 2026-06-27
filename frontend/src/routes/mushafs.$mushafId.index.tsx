import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/mushafs/$mushafId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/mushafs/$mushafId/setup", params });
  },
});

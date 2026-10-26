import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CalibrationEditor } from "@/components/calibration/CalibrationEditor";
import { useMushaf } from "@/lib/api";

type InkSearch = { page: number };

export const Route = createFileRoute("/mushafs/$mushafId/ink")({
  validateSearch: (s: Record<string, unknown>): InkSearch => ({
    page: Math.max(1, Number(s.page) || 1),
  }),
  component: InkStep,
});

/** The Ink step: every blob of ink on a page, its words, PAWs and marks — calibrating
 * a page, and processing the rest after it. Every word's box comes from the ink given
 * to it; nothing is cut by hand. */
function InkStep() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/ink" });
  const { page } = Route.useSearch();
  const navigate = useNavigate({ from: "/mushafs/$mushafId/ink" });
  const { i18n } = useTranslation();
  const { data: mushaf } = useMushaf(mushafId);

  if (!mushaf) return null;
  const pageCount = mushaf.logical_page_count;
  return (
    <CalibrationEditor
      mushafId={mushafId}
      page={page}
      pageCount={pageCount}
      onPageChange={(n) => navigate({ search: { page: Math.max(1, Math.min(pageCount, n)) } })}
      isRTL={i18n.language === "ar"}
    />
  );
}

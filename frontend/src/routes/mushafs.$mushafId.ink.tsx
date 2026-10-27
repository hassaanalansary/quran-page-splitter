import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CalibrationEditor } from "@/components/calibration/CalibrationEditor";
import { useMushaf } from "@/lib/api";

/** The page; `mode` opens the Library; `blob` (snapshot:id) is a fingerprint's source
 * to select, opened from the Library on page `from`. */
type InkSearch = { page: number; mode?: "library"; blob?: string; from?: number };

export const Route = createFileRoute("/mushafs/$mushafId/ink")({
  validateSearch: (s: Record<string, unknown>): InkSearch => ({
    page: Math.max(1, Number(s.page) || 1),
    ...(s.mode === "library" ? { mode: "library" as const } : {}),
    ...(typeof s.blob === "string" && /^[\w-]+:\d+$/.test(s.blob) ? { blob: s.blob } : {}),
    ...(Number(s.from) >= 1 ? { from: Math.floor(Number(s.from)) } : {}),
  }),
  component: InkStep,
});

/** The Ink step: every blob of ink on a page, its words, PAWs and marks — calibrating
 * a page, and processing the rest after it. Every word's box comes from the ink given
 * to it; nothing is cut by hand. */
function InkStep() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/ink" });
  const { page, mode, blob, from } = Route.useSearch();
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
      entry={{ mode, blob, from }}
      onOpenSource={(target, key, origin) =>
        navigate({ search: { page: target, blob: key, from: origin } })
      }
      onBackToLibrary={(origin) => navigate({ search: { page: origin, mode: "library" } })}
    />
  );
}

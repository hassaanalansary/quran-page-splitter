import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** The page is only editable once detection AND review have settled it: the run
 * anchors on the aya ornaments whose positions Review is where you fix. Shared by
 * the cuts and the calibration editors, which have the same prerequisite. */
export function WordsGateNotice({
  mushafId,
  page,
  processed,
}: {
  mushafId: string;
  page: number;
  processed: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-[13px] leading-relaxed text-text-secondary">
          {processed ? t("words.gateUnreviewed", { page }) : t("words.gateUnprocessed", { page })}
        </p>
        <Link
          to={processed ? "/mushafs/$mushafId/review" : "/mushafs/$mushafId/process"}
          params={{ mushafId }}
          search={processed ? { page } : undefined}
          className="rounded-[7px] bg-orange px-3 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-orange-hover"
        >
          {processed ? t("words.gateToReview") : t("words.gateToProcess")}
        </Link>
      </div>
    </div>
  );
}

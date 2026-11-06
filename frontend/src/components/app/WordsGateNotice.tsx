import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** The page is only editable in Ink once detection AND review have settled it: the
 * reading anchors on the aya ornaments whose positions Review is where you fix.
 * A card on the well, edged in gold, with the way to the step that settles it. */
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
      <div
        role="status"
        className="flex max-w-[440px] flex-col gap-2 rounded-card border-s-4 border-gold bg-card p-[18px] shadow-[var(--shadow-card)]"
      >
        <strong className="text-[15px] leading-snug">{t("words.gateTitle", { page })}</strong>
        <span className="text-[12.5px] leading-normal text-ink-2">
          {processed ? t("words.gateUnreviewed", { page }) : t("words.gateUnprocessed", { page })}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-2.5">
          <Link
            to={processed ? "/mushafs/$mushafId/review" : "/mushafs/$mushafId/process"}
            params={{ mushafId }}
            search={processed ? { page } : undefined}
            className="inline-flex h-9 items-center rounded-control bg-lapis px-3.5 text-[13px] font-semibold text-on-lapis no-underline transition-colors hover:bg-lapis/90"
          >
            {processed ? t("words.gateToReview", { page }) : t("words.gateToProcess")}
          </Link>
        </span>
      </div>
    </div>
  );
}

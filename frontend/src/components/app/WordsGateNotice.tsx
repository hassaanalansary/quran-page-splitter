import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

/** The page is only editable in Ink once detection AND review have settled it: the
 * reading anchors on the aya ornaments whose positions Review is where you fix. */
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
        <p className="text-[13px] leading-relaxed text-ink-2">
          {processed ? t("words.gateUnreviewed", { page }) : t("words.gateUnprocessed", { page })}
        </p>
        <Link
          to={processed ? "/mushafs/$mushafId/review" : "/mushafs/$mushafId/process"}
          params={{ mushafId }}
          search={processed ? { page } : undefined}
          className="rounded-[7px] bg-lapis px-3 py-2 text-[12.5px] font-semibold text-on-lapis transition-colors hover:bg-lapis/90"
        >
          {processed ? t("words.gateToReview") : t("words.gateToProcess")}
        </Link>
      </div>
    </div>
  );
}

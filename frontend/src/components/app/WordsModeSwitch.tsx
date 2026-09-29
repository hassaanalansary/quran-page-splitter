import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

const ITEM =
  "flex-1 rounded-[5px] px-3 py-1.5 text-center text-[12px] font-semibold transition-colors";
const ON = "bg-white text-text-primary shadow-sm";
const OFF = "text-text-secondary hover:text-text-primary";

/** The Words step's two editors over the same page: the word cuts, and calibration.
 * Links rather than local state, so the choice survives a reload and the unsaved-
 * edits guard of whichever editor is open sees the switch as leaving it. */
export function WordsModeSwitch({
  mushafId,
  page,
  mode,
}: {
  mushafId: string;
  page: number;
  mode: "cuts" | "calibrate";
}) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("calibration.switchLabel")}
      className="flex gap-1 rounded-md bg-bg-surface p-1"
    >
      <Link
        to="/mushafs/$mushafId/word-cuts"
        params={{ mushafId }}
        search={{ page }}
        aria-current={mode === "cuts" ? "page" : undefined}
        className={`${ITEM} ${mode === "cuts" ? ON : OFF}`}
      >
        {t("calibration.switchCuts")}
      </Link>
      <Link
        to="/mushafs/$mushafId/word-cuts"
        params={{ mushafId }}
        search={{ page, mode: "calibrate" }}
        aria-current={mode === "calibrate" ? "page" : undefined}
        className={`${ITEM} ${mode === "calibrate" ? ON : OFF}`}
      >
        {t("calibration.switchCalibrate")}
      </Link>
    </nav>
  );
}

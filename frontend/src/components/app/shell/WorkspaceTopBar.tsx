import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LanguageButton } from "@/components/app/LanguageSwitcher";
import { MushafStatusBadge } from "@/components/app/MushafStatusBadge";
import { SatrLockup } from "@/components/app/SatrLockup";
import { ThemeButton } from "@/components/app/ThemeSwitcher";
import { UserMenu } from "@/components/app/UserMenu";
import { coordinatesUrl, type MushafDetail } from "@/lib/api";

const QUIET =
  "inline-flex h-[34px] items-center rounded-control border border-rule-2 bg-card px-[11px] text-[13px] font-medium text-ink no-underline transition-colors hover:bg-sheet";

/**
 * The shell's 56 px top bar: the lockup (back to the library), the mushaf as a
 * breadcrumb to its hub with its qiraa and status, then the PDF and JSON, the
 * gallery, theme, language and account. `mushaf` is null while it loads.
 */
export function WorkspaceTopBar({ mushaf }: { mushaf: MushafDetail | null }) {
  const { t } = useTranslation();

  return (
    <header className="flex min-h-14 flex-shrink-0 flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-rule bg-sheet px-[18px] py-2">
      <Link to="/" aria-label={t("shell.allMushafs")} className="flex items-center">
        <SatrLockup size={28} />
      </Link>
      {mushaf && (
        <>
          <span className="text-faint" aria-hidden="true">
            /
          </span>
          <Link
            to="/mushafs/$mushafId"
            params={{ mushafId: mushaf.id }}
            title={t("header.overview")}
            dir="auto"
            className="max-w-[260px] truncate text-[14px] font-semibold text-ink no-underline hover:text-lapis-text"
          >
            {mushaf.name}
          </Link>
          {mushaf.qiraa && (
            <span className="text-[13px] capitalize text-ink-3">{mushaf.qiraa}</span>
          )}
          <MushafStatusBadge mushaf={mushaf} size="md" />
        </>
      )}

      <div className="ms-auto flex flex-wrap items-center gap-1.5">
        {mushaf?.pdf_url && (
          <a href={mushaf.pdf_url} target="_blank" rel="noreferrer" className={QUIET}>
            {t("header.openPdf")}
          </a>
        )}
        {mushaf && (
          <a href={coordinatesUrl(mushaf.id)} download className={QUIET}>
            {t("header.downloadJson")}
          </a>
        )}
        <Link
          to="/gallery"
          className="inline-flex h-[34px] items-center rounded-control px-2.5 text-[13px] font-medium text-ink-2 no-underline transition-colors hover:bg-sunk hover:text-ink"
        >
          {t("gallery.navLink")}
        </Link>
        <ThemeButton size={34} />
        <LanguageButton size={34} />
        <UserMenu size={34} />
      </div>
    </header>
  );
}

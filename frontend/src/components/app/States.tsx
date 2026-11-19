import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { OrnamentStrip } from "@/components/app/Ornament";
import { cn } from "@/lib/utils";

/** A state's buttons: 38 px, primary lapis, secondary outlined. */
export const STATE_PRIMARY =
  "inline-flex h-[38px] cursor-pointer items-center justify-center rounded-control bg-lapis px-4 text-[13.5px] font-semibold text-on-lapis no-underline transition-colors hover:bg-lapis/90";
export const STATE_SECONDARY =
  "inline-flex h-[38px] cursor-pointer items-center justify-center rounded-control border border-rule-2 bg-card px-3.5 text-[13.5px] font-semibold text-ink no-underline transition-colors hover:bg-sheet";

/**
 * An empty screen: it says what goes there and offers the one action that fills
 * it. A dashed sheet card, the icon, a Reem Kufi title, the line under it, then
 * the actions.
 */
export function EmptyState({
  icon,
  title,
  body,
  children,
  className,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-panel border-[1.5px] border-dashed border-rule-2 bg-sheet px-[22px] py-12 text-center",
        className,
      )}
    >
      {icon && <span className="mb-1 text-ink-3">{icon}</span>}
      <strong className="font-display text-[19px] font-semibold leading-tight">{title}</strong>
      {body && <span className="max-w-[360px] text-[13px] leading-normal text-ink-2">{body}</span>}
      {children && <span className="mt-1.5 flex flex-wrap justify-center gap-2">{children}</span>}
    </div>
  );
}

/**
 * Something didn't load: the stop icon, what happened, and the way back. With
 * `tone="gone"` it is a thing that is no longer there (a deleted mushaf), said
 * without alarm.
 */
export function ErrorState({
  title,
  body,
  tone = "error",
  children,
  className,
}: {
  title: string;
  body?: string;
  tone?: "error" | "gone";
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col justify-center gap-2 rounded-panel bg-card px-[22px] py-5 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      <span
        className={`flex h-11 w-11 items-center justify-center rounded-full ${
          tone === "error" ? "bg-stop-wash text-stop-text" : "bg-sunk text-ink-2"
        }`}
      >
        <CircleAlert size={22} aria-hidden="true" />
      </span>
      <strong className="font-display text-[20px] font-semibold leading-tight">{title}</strong>
      {body && <span className="text-[13px] leading-normal text-ink-2">{body}</span>}
      {children && <span className="mt-2 flex flex-wrap gap-2">{children}</span>}
    </div>
  );
}

/** Any bad address: the 404 in gold on deep lapis, under the ornament strip. */
export function NotFoundCard() {
  const { t } = useTranslation();
  return (
    <div className="flex w-full max-w-[420px] flex-col overflow-hidden rounded-panel bg-deep text-on-deep shadow-[var(--shadow-modal)]">
      <OrnamentStrip height={12} />
      <div className="flex flex-col justify-center gap-1.5 px-[22px] pb-6 pt-5">
        <span className="font-display text-[56px] font-bold leading-none text-gold">404</span>
        <strong className="font-display text-[20px] font-semibold">{t("notFound.title")}</strong>
        <span className="text-[13px] leading-normal text-on-deep-2">{t("notFound.body")}</span>
        <span className="mt-2.5">
          <Link
            to="/"
            className="inline-flex h-[38px] items-center rounded-control bg-gold px-4 text-[13.5px] font-semibold text-on-gold no-underline transition-[filter] hover:brightness-105"
          >
            {t("notFound.goHome")}
          </Link>
        </span>
      </div>
    </div>
  );
}

/** A mushaf card while the library loads: the shape of the card, so nothing jumps. */
export function CardSkeleton({ tall = false }: { tall?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="flex animate-pulse flex-col gap-2 rounded-card border border-rule bg-card p-2.5"
    >
      <span className={`rounded-control bg-sunk ${tall ? "h-[190px]" : "h-[150px]"}`} />
      <span className="h-3 w-4/5 rounded bg-sunk" />
      <span className="h-2.5 w-1/2 rounded bg-rule-soft" />
      <span className="mt-1 h-1.5 rounded-[3px] bg-rule-soft" />
      <span className="h-1.5 rounded-[3px] bg-rule-soft" />
    </div>
  );
}

/** The hub while its mushaf loads: the deep band, three counts and a few lines. */
export function HubSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      aria-busy="true"
      aria-label={t("workspace.loadingMushaf")}
      className="flex w-full flex-col"
    >
      <div className="flex animate-pulse flex-col gap-2.5 bg-deep px-7 py-6">
        <span className="h-[18px] w-2/5 rounded bg-white/15" />
        <span className="h-[11px] w-1/4 rounded bg-white/10" />
      </div>
      <div className="mx-auto flex w-full max-w-[1240px] animate-pulse flex-col gap-4 px-7 py-6">
        <div className="grid grid-cols-3 gap-2.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-[54px] rounded-lg bg-card shadow-[inset_0_-16px_0_var(--rule-soft)]"
            />
          ))}
        </div>
        <span className="h-2 rounded bg-sunk" />
        <span className="h-2.5 w-[70%] rounded bg-rule-soft" />
        <span className="h-2.5 w-[55%] rounded bg-rule-soft" />
      </div>
    </div>
  );
}

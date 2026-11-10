import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SatrDialogClose, SatrDialogFrame } from "@/components/app/SatrDialog";
import { API_BASE, getRunLogTail, runLogUrl } from "@/lib/api";

/** How long to wait before asking again once we're level with the file. */
const POLL_MS = 1000;
/** Backoff after a failed poll — a stopped server shouldn't be hammered. */
const RETRY_MS = 3000;
/** Treat "within this many px of the bottom" as following the tail. */
const STICK_PX = 40;

/** Detection's trace, readable while it is still being written.
 *
 * The per-run log is the only place that says *why* a run came out the way it
 * did — every band with its match score, every line, every cut. Polls forward by
 * byte offset rather than re-fetching, so a 600-page run costs one small request
 * per second instead of re-sending megabytes. `enabled` false stops it (a closed
 * dialog). The returned ref goes on the scrolling element: it follows the tail
 * until the reader scrolls up.
 */
function useRunLog({
  mushafId,
  runId,
  live,
  enabled,
}: {
  mushafId: string;
  runId: string;
  live: boolean;
  enabled: boolean;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [behind, setBehind] = useState(false);
  const offsetRef = useRef(0);
  const bodyRef = useRef<HTMLPreElement>(null);
  /** Following the tail? Turns off the moment the reader scrolls up. */
  const stickRef = useRef(true);

  // A fresh start — possibly on a different run — begins from an empty buffer.
  useEffect(() => {
    if (!enabled) return;
    offsetRef.current = 0;
    stickRef.current = true;
    setText("");
    setError(null);
    setBehind(false);
  }, [enabled, runId]);

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();

    async function pump() {
      try {
        const tail = await getRunLogTail(mushafId, runId, offsetRef.current, controller.signal);
        if (stopped) return;
        offsetRef.current = tail.offset;
        if (tail.reset) setText(tail.text);
        else if (tail.text) setText((previous) => previous + tail.text);

        const lagging = tail.offset < tail.size;
        setBehind(lagging);
        setError(null);
        // Still catching up → go straight back for the next chunk. Level with
        // the file → only keep asking while the run can still add to it.
        if (lagging || live) timer = window.setTimeout(pump, lagging ? 0 : POLL_MS);
      } catch (e) {
        if (stopped || controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        if (live) timer = window.setTimeout(pump, RETRY_MS);
      }
    }

    void pump();

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, mushafId, runId, live]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }, []);

  return { text, error, behind, bodyRef, onScroll };
}

/** The "live" chip: green on the log's dark ground, "catching up…" while behind. */
function LiveChip({ behind }: { behind: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-[5px] rounded-pill bg-term-live-wash px-2 py-px font-mono text-[11px] font-semibold text-term-live-text">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-term-live" aria-hidden="true" />
      {behind ? t("process.logCatchingUp") : t("process.logLive")}
    </span>
  );
}

/** The log itself: light text on the terminal's dark ground, in both themes. */
const LOG_BODY =
  "m-0 overflow-auto whitespace-pre bg-term font-mono text-[12px] leading-[1.5] text-on-term";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mushafId: string;
  /** The ProcessingRun id. */
  runId: string;
  /** Its number, for the title, when known. */
  runNumber?: number;
  /** The run is still going, so keep polling after catching up. */
  live: boolean;
};

/** A run's whole log in a dialog: from the Runs tab, from Process once a run has
 * ended, or opened full size from the log docked on the canvas. */
export function RunLogDialog({ open, onOpenChange, mushafId, runId, runNumber, live }: Props) {
  const { t } = useTranslation();
  const { text, error, behind, bodyRef, onScroll } = useRunLog({
    mushafId,
    runId,
    live,
    enabled: open,
  });

  return (
    <SatrDialogFrame open={open} onOpenChange={onOpenChange} width={900}>
      <div className="flex flex-wrap items-center gap-2.5 px-5 pb-2 pt-4">
        <DialogPrimitive.Title className="m-0 font-display text-[20px] font-semibold leading-tight">
          {runNumber != null
            ? t("process.logDialogTitleRun", { n: runNumber })
            : t("process.logDialogTitle")}
        </DialogPrimitive.Title>
        {live && <LiveChip behind={behind} />}
        <span className="ms-auto flex items-center gap-1.5">
          <a
            href={`${API_BASE}${runLogUrl(mushafId, runId)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-control border border-rule-2 bg-card px-3 text-[13px] font-semibold text-ink no-underline transition-colors hover:bg-sheet"
          >
            <Download size={14} aria-hidden="true" />
            {t("process.logDownload")}
          </a>
          <SatrDialogClose />
        </span>
      </div>
      <DialogPrimitive.Description className="m-0 px-5 pb-3 text-[13px] leading-normal text-ink-2">
        {t("process.logLead")}
      </DialogPrimitive.Description>

      {error && (
        <div className="mx-5 mb-3 rounded-lg bg-stop-wash px-3 py-2 text-[12.5px] text-stop-text">
          {error}
        </div>
      )}

      <pre
        ref={bodyRef}
        onScroll={onScroll}
        dir="ltr"
        className={`${LOG_BODY} mx-5 mb-4 h-[55vh] rounded-lg px-3.5 py-3`}
      >
        {text || (error ? "" : t("process.logEmpty"))}
      </pre>
    </SatrDialogFrame>
  );
}

/** The live log, docked along the bottom of the canvas while a run is going:
 * every band, line and cut as it is written. It opens full size in the dialog. */
export function RunLogDock({
  mushafId,
  runId,
  onExpand,
}: {
  mushafId: string;
  runId: string;
  onExpand: () => void;
}) {
  const { t } = useTranslation();
  const { text, error, behind, bodyRef, onScroll } = useRunLog({
    mushafId,
    runId,
    live: true,
    enabled: true,
  });

  return (
    <section
      aria-label={t("process.logDialogTitle")}
      className="absolute inset-x-4 bottom-4 z-20 flex flex-col overflow-hidden rounded-card bg-term text-on-term shadow-[0_12px_32px_rgba(0,0,0,0.25)]"
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-term-rule px-3.5 py-2.5">
        <span className="text-[13px] font-semibold">{t("process.logDialogTitle")}</span>
        <LiveChip behind={behind} />
        <span className="ms-auto text-[12px] text-term-dim max-sm:hidden">
          {t("process.logDockLead")}
        </span>
        <a
          href={`${API_BASE}${runLogUrl(mushafId, runId)}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-7 items-center rounded-control border border-term-edge px-2.5 text-[12px] font-semibold text-on-term no-underline transition-colors hover:bg-white/5"
        >
          {t("process.logDownload")}
        </a>
        <button
          type="button"
          onClick={onExpand}
          aria-label={t("process.logOpenFull")}
          title={t("process.logOpenFull")}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-control border border-term-edge text-on-term transition-colors hover:bg-white/5"
        >
          <Maximize2 size={13} aria-hidden="true" />
        </button>
      </div>
      <pre
        ref={bodyRef}
        onScroll={onScroll}
        dir="ltr"
        className={`${LOG_BODY} h-[168px] px-3.5 pb-3 pt-2.5`}
      >
        {error ? error : text || t("process.logEmpty")}
      </pre>
    </section>
  );
}

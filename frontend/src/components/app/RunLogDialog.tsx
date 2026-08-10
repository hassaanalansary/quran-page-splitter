import { Download, ScrollText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { API_BASE, getRunLogTail, runLogUrl } from "@/lib/api";

/** How long to wait before asking again once we're level with the file. */
const POLL_MS = 1000;
/** Backoff after a failed poll — a stopped server shouldn't be hammered. */
const RETRY_MS = 3000;
/** Treat "within this many px of the bottom" as following the tail. */
const STICK_PX = 40;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mushafId: string;
  runId: string;
  /** The run is still going, so keep polling after catching up. */
  live: boolean;
};

/** The detection trace, readable while it is still being written.
 *
 * The engine's per-page log is the only place that says *why* a page came out
 * the way it did — every band with its match score, every line, every cut. It
 * used to be reachable only as a download link on an aborted run, which is the
 * one case where it is already too late to change anything. Here it is a
 * window onto the run in flight.
 *
 * Polls forward by byte offset rather than re-fetching, so a 600-page run costs
 * one small request per second instead of re-sending megabytes.
 */
export function RunLogDialog({ open, onOpenChange, mushafId, runId, live }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [behind, setBehind] = useState(false);
  const offsetRef = useRef(0);
  const bodyRef = useRef<HTMLPreElement>(null);
  /** Following the tail? Turns off the moment the reader scrolls up. */
  const stickRef = useRef(true);

  // A fresh open — possibly on a different run — starts from an empty buffer.
  useEffect(() => {
    if (!open) return;
    offsetRef.current = 0;
    stickRef.current = true;
    setText("");
    setError(null);
    setBehind(false);
  }, [open, runId]);

  useEffect(() => {
    if (!open) return;

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
  }, [open, mushafId, runId, live]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const onScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText size={18} />
            {t("process.logDialogTitle")}
            {live && (
              <span className="flex items-center gap-1.5 text-[11.5px] font-normal text-text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-orange" />
                {behind ? t("process.logCatchingUp") : t("process.logLive")}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <p className="text-[12.5px] leading-[1.6] text-text-secondary">{t("process.logLead")}</p>

        {error && (
          <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-[12px] text-error">
            {error}
          </div>
        )}

        <pre
          ref={bodyRef}
          onScroll={onScroll}
          dir="ltr"
          className="h-[55vh] overflow-auto rounded-md border border-border bg-bg-surface p-3 font-mono text-[11.5px] leading-[1.55] whitespace-pre text-text-secondary"
        >
          {text || (error ? "" : t("process.logEmpty"))}
        </pre>

        <DialogFooter>
          <Button asChild variant="outline">
            <a href={`${API_BASE}${runLogUrl(mushafId, runId)}`} target="_blank" rel="noreferrer">
              <Download size={14} />
              {t("process.logDownload")}
            </a>
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

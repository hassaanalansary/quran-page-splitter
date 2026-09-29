import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { OctagonX, Play, ScrollText } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { CanvasHelp } from "@/components/app/CanvasHelp";
import { Aside, Field, Hint, Section, StatusLine } from "@/components/app/Panel";
import { ProcessCancelDialog } from "@/components/app/ProcessCancelDialog";
import { RunLogDialog } from "@/components/app/RunLogDialog";
import { TourOverlay } from "@/components/app/tour/TourOverlay";
import { WordRunProgress } from "@/components/app/WordRunProgress";
import { useStepTour, type TourStep } from "@/components/app/tour/useStepTour";
import { PageStage } from "@/components/canvas/PageStage";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  cancelWordDetection,
  isJobRunning,
  isJobSettled,
  pageImageUrl,
  queryKeys,
  startWordDetection,
  useMushaf,
  useProcessedPages,
  useSuras,
  useWordsCoverage,
  useWordsJob,
  useWordsSpan,
  type DetectWordsRequest,
  type ProcessJob,
  type WordSpanGap,
} from "@/lib/api";

export const Route = createFileRoute("/mushafs/$mushafId/word-run")({
  validateSearch: (s: Record<string, unknown>) => ({ page: Math.max(1, Number(s.page) || 1) }),
  component: WordRunPage,
});

/** How much of the mushaf one run covers.
 *
 * Three named cases rather than a pair of ayat and a checkbox, because the three
 * are asked for differently and only one of them is the user's to fill in: a sura
 * run leaves the end to the server (a sura's last aya is not the same number in
 * every riwaya), a mushaf run leaves both ends to it, and only `range` is typed. */
type RunScope = "sura" | "range" | "mushaf";

/**
 * Starting a word run, and watching it — the half of the old Words step that is
 * about the *engine* rather than about a page.
 *
 * Split from correcting the cuts for the same reason Process is split from
 * Review: configuring a run over a whole mushaf and nudging one word's edge on
 * page 161 share a mushaf and nothing else. They are a different job, done at a
 * different time, with a different thing on screen.
 *
 * The canvas is read-only here on purpose. There is nothing to *configure*
 * visually — the span is named in ayat, not drawn — so the page it shows is there
 * to answer "what will this touch", which is what the rail's coverage marks say.
 */
function WordRunPage() {
  const { mushafId } = useParams({ from: "/mushafs/$mushafId/word-run" });
  const { page } = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();

  const { data: mushaf } = useMushaf(mushafId);
  const { data: pages } = useProcessedPages(mushafId);
  const { data: suras } = useSuras(mushaf?.qiraa);
  const { data: coverage } = useWordsCoverage(mushafId);
  const { data: span } = useWordsSpan(mushafId);
  const { data: job } = useWordsJob(mushafId);

  const [scope, setScope] = useState<RunScope>("sura");
  const [fromSura, setFromSura] = useState(1);
  const [fromAya, setFromAya] = useState(1);
  const [toSura, setToSura] = useState(1);
  const [toAya, setToAya] = useState(1);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  /** Breaks the last run started here stepped over. Kept on screen rather than
   * toasted: on a whole-mushaf run this is the list of what was NOT read, and it
   * is the thing to go and fix. Cleared when a new run is asked for. */
  const [gaps, setGaps] = useState<WordSpanGap[]>([]);

  const ayaCountOf = useCallback(
    (n: number) => suras?.find((s) => s.number === n)?.aya_count ?? 1,
    [suras],
  );
  const fromAyaCount = ayaCountOf(fromSura);
  const toAyaCount = ayaCountOf(toSura);

  /** The request this panel is currently describing, or null when it cannot yet.
   *
   * Only `mushaf` can be null, and only until `useWordsSpan` answers: the whole
   * mushaf is the one span this screen does not know the ends of. A mushaf nothing
   * has renumbered has no ends at all, and the button says so rather than sending a
   * request the server would refuse. */
  const request = useMemo((): DetectWordsRequest | null => {
    if (scope === "sura") return { from_sura: fromSura };
    if (scope === "range") {
      return { from_sura: fromSura, from_aya: fromAya, to_sura: toSura, to_aya: toAya };
    }
    if (!span?.start || !span.end) return null;
    return {
      from_sura: span.start.sura,
      from_aya: span.start.aya,
      to_sura: span.end.sura,
      to_aya: span.end.aya,
    };
  }, [scope, fromSura, fromAya, toSura, toAya, span]);

  const runMutation = useMutation({
    mutationFn: () => {
      if (!request) throw new Error(t("words.spanUnknown"));
      return startWordDetection(mushafId, request);
    },
    onSuccess: (result) => {
      // Seed the cache with the job the POST returned so progress shows at once,
      // rather than after the first poll.
      queryClient.setQueryData(queryKeys.wordsJob(mushafId), result.job);
      // Gaps are the one warning worth holding on screen: on a long span they say
      // which part of the mushaf was skipped, and a toast that fades takes the
      // answer with it. The rest still pass through as toasts.
      setGaps(result.gaps);
      result.warnings
        .filter((w) => !result.gaps.some((gap) => w.includes(gap.after) && w.includes(gap.before)))
        .forEach((w) => toast.warning(w));
      toast.info(t("words.runStarted", { lines: result.total_lines }));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t("words.runFailed")),
  });

  // Announce a settled run once, and refresh what it changed.
  //
  // Only a run this page actually watched finish: `/words/job` answers with the
  // most recent run whether or not it is still going, so without the first guard
  // every visit would toast the last run again.
  const watchedRef = useRef<string | null>(null);
  const announcedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job) return;
    if (isJobRunning(job)) {
      watchedRef.current = job.id;
      return;
    }
    if (!isJobSettled(job) || watchedRef.current !== job.id) return;
    if (announcedRef.current === job.id) return;
    announcedRef.current = job.id;
    queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.wordsSpan(mushafId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.activity(mushafId) });
    if (job.state === "completed") toast.success(t("words.runDone", { lines: job.lines_done }));
    else if (job.state === "cancelled")
      toast.info(t("words.runCancelled", { lines: job.lines_done }));
    else if (job.error) toast.error(job.error);
  }, [job, mushafId, queryClient, t]);

  // Show each chunk as it lands on the rail, rather than only the finished run.
  //
  // `word_runs.run` stores a chunk in its own transaction and only *then* ticks
  // `lines_done` — so the counter moving means those rows are committed and
  // readable, once per chunk.
  const progressRef = useRef(-1);
  useEffect(() => {
    if (!job || !isJobRunning(job) || job.lines_done === progressRef.current) return;
    progressRef.current = job.lines_done;
    queryClient.invalidateQueries({ queryKey: queryKeys.wordsCoverage(mushafId) });
  }, [job, mushafId, queryClient]);

  const running = isJobRunning(job);

  const { withWords, clean } = useMemo(() => {
    const rows = coverage?.pages ?? [];
    return {
      withWords: new Set(rows.filter((p) => p.lines_with_words > 0).map((p) => p.page)),
      clean: new Set(rows.filter((p) => p.complete && p.needs_review === 0).map((p) => p.page)),
    };
  }, [coverage]);

  const tourSteps: TourStep[] = [
    { target: "wordrun-scope", title: t("tour.wordRun.t1_title"), body: t("tour.wordRun.t1_body") },
    { target: "wordrun-start", title: t("tour.wordRun.t2_title"), body: t("tour.wordRun.t2_body") },
  ];
  const tour = useStepTour("word-run", tourSteps, !coverage?.pages.length);

  if (!mushaf) return null;
  const logicalCount = mushaf.logical_page_count;
  const settled = job && isJobSettled(job);

  const status = running ? (
    <WordRunProgress job={job!} />
  ) : settled && job.state === "completed" ? (
    <StatusLine tone="success">
      {t("words.runFinishedStatus", { lines: job.lines_done })}
    </StatusLine>
  ) : coverage?.pages.length ? (
    <StatusLine tone="action">{t("words.reviewNextStatus")}</StatusLine>
  ) : (
    <StatusLine>{t("words.notRunStatus")}</StatusLine>
  );

  return (
    <div
      className={`flex ${i18n.language === "ar" ? "flex-row-reverse" : "flex-row"} flex-1 overflow-hidden`}
    >
      <div className="relative flex flex-1 overflow-hidden">
        <PageStage
          imageUrl={pageImageUrl(mushafId, page, mushaf.updated_at)}
          page={page}
          pageCount={logicalCount}
          onPageChange={(n) =>
            navigate({ search: { page: Math.max(1, Math.min(logicalCount, n)) } })
          }
          // The rail's two slots, read as "holds words" and "nothing left to look
          // at" rather than processed/reviewed — the same reuse the cuts page makes.
          processed={withWords}
          reviewed={clean}
        />
        <CanvasHelp
          guideItems={[
            t("guide.wordRun.s1"),
            t("guide.wordRun.s2"),
            t("guide.wordRun.s3"),
            t("guide.wordRun.s4"),
          ]}
          coachText={t("coach.wordRun")}
          onReplayTour={tour.start}
        />
      </div>

      <Aside
        status={status}
        footer={
          <div data-tour="wordrun-start" className="flex flex-col gap-2">
            {running ? (
              <Button
                variant="outline"
                onClick={() => setCancelOpen(true)}
                disabled={job?.cancel_requested}
              >
                <OctagonX size={14} />
                {job?.cancel_requested ? t("words.stopping") : t("words.stopRun")}
              </Button>
            ) : (
              <Button
                disabled={runMutation.isPending || !request}
                onClick={() => {
                  setGaps([]);
                  runMutation.mutate();
                }}
              >
                <Play size={14} />
                {t("words.runButton")}
              </Button>
            )}
            {/* `log_url` rather than the job's mere existence: a run started
                before this feature, or one whose log the retention sweep has
                since deleted, has nothing to open. */}
            {job?.log_url && (
              <Button variant="outline" onClick={() => setLogOpen(true)}>
                <ScrollText size={14} />
                {running ? t("words.logWatch") : t("words.logView")}
              </Button>
            )}
            {/* Only once there is something to correct. Mirrors the Process step's
                "continue to Review", which appears the same way. */}
            {!!coverage?.pages.length && (
              <Button asChild variant="outline">
                <Link to="/mushafs/$mushafId/word-cuts" params={{ mushafId }} search={{ page }}>
                  {t("words.continueCuts")}
                </Link>
              </Button>
            )}
          </div>
        }
      >
        <Section title={t("words.runTitle")} defaultOpen>
          <div data-tour="wordrun-scope" className="flex flex-col gap-3">
            <Field label={t("words.scopeLabel")} info={t("tips.wordsSpan")}>
              <select
                className={selectClass}
                value={scope}
                disabled={running}
                onChange={(e) => {
                  const next = e.target.value as RunScope;
                  setScope(next);
                  // Open the range on the whole of the sura already picked, so
                  // switching to it starts from something valid and shrinks,
                  // rather than from 1:1..1:1 and having to be built up.
                  if (next === "range") {
                    setFromAya(1);
                    setToSura(fromSura);
                    setToAya(ayaCountOf(fromSura));
                  }
                }}
              >
                <option value="sura">{t("words.scopeSura")}</option>
                <option value="range">{t("words.scopeRange")}</option>
                <option value="mushaf">{t("words.scopeMushaf")}</option>
              </select>
            </Field>

            {scope !== "mushaf" && (
              <Field label={scope === "sura" ? t("words.suraLabel") : t("words.fromSura")}>
                <select
                  className={selectClass}
                  value={fromSura}
                  disabled={running}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setFromSura(n);
                    setFromAya(1);
                    // A range can only run forwards. Dragging the start past the
                    // end takes the end with it rather than leaving a span the
                    // server would refuse.
                    if (toSura < n) {
                      setToSura(n);
                      setToAya(ayaCountOf(n));
                    }
                  }}
                >
                  {(suras ?? []).map((s) => (
                    <option key={s.number} value={s.number}>
                      {s.number}. {s.transliteration}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {scope === "range" && (
              <>
                <Field label={t("words.fromAya")}>
                  <input
                    type="number"
                    min={1}
                    max={fromAyaCount}
                    value={fromAya}
                    disabled={running}
                    onChange={(e) => setFromAya(clamp(Number(e.target.value), 1, fromAyaCount))}
                    className={numberClass}
                  />
                </Field>
                <Field label={t("words.toSura")}>
                  <select
                    className={selectClass}
                    value={toSura}
                    disabled={running}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setToSura(n);
                      // Through the end of the sura just picked, which is what
                      // someone choosing a new end sura nearly always means.
                      setToAya(ayaCountOf(n));
                    }}
                  >
                    {(suras ?? [])
                      .filter((s) => s.number >= fromSura)
                      .map((s) => (
                        <option key={s.number} value={s.number}>
                          {s.number}. {s.transliteration}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label={t("words.toAya")}>
                  <input
                    type="number"
                    min={toSura === fromSura ? fromAya : 1}
                    max={toAyaCount}
                    value={toAya}
                    disabled={running}
                    onChange={(e) =>
                      setToAya(
                        clamp(
                          Number(e.target.value),
                          toSura === fromSura ? fromAya : 1,
                          toAyaCount,
                        ),
                      )
                    }
                    className={numberClass}
                  />
                </Field>
              </>
            )}

            {/* What a whole-mushaf run will actually cover. Shown rather than
                assumed to be 1:1 .. 114:6, because a mushaf part way through
                review holds less, and that is the number worth seeing before
                starting something that runs for a quarter of an hour. */}
            {scope === "mushaf" && (
              <Hint tone={span?.start && span.end ? undefined : "warning"}>
                {span?.start && span.end
                  ? t("words.mushafSpan", {
                      from: `${span.start.sura}:${span.start.aya}`,
                      to: `${span.end.sura}:${span.end.aya}`,
                    })
                  : t("words.spanUnknown")}
              </Hint>
            )}
            <p className="text-[10.5px] leading-snug text-text-muted">{t("words.runNote")}</p>
          </div>
        </Section>

        {/* Kept until the next run is asked for. These name the pages the run
            could NOT read, which on a long span is the only place that answer
            exists — a toast would carry it off screen in four seconds. */}
        {gaps.length > 0 && (
          <Hint tone="warning">
            <span className="font-medium">{t("words.gapsTitle", { count: gaps.length })}</span>
            <ul className="mt-1 list-disc ps-4">
              {gaps.map((gap) => (
                <li key={`${gap.after}-${gap.before}`}>
                  {t("words.gapLine", {
                    after: gap.after,
                    afterPage: gap.after_page,
                    before: gap.before,
                    beforePage: gap.before_page,
                  })}
                </li>
              ))}
            </ul>
          </Hint>
        )}

        {!pages?.reviewed.size && <Hint tone="warning">{t("words.runGateHint")}</Hint>}
      </Aside>

      {job?.log_url && (
        <RunLogDialog
          open={logOpen}
          onOpenChange={setLogOpen}
          mushafId={mushafId}
          runId={job.id}
          kind="words"
          live={running}
        />
      )}

      {job && (
        <ProcessCancelDialog
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          job={job}
          onConfirm={() => {
            setCancelOpen(false);
            cancelWordDetection(mushafId).catch(() => toast.error(t("words.cancelFailed")));
          }}
        />
      )}

      <TourOverlay tour={tour} />
    </div>
  );
}

const selectClass =
  "h-8 w-full rounded border border-border-strong bg-white px-2 text-[12px] text-text-primary outline-none focus:border-orange";

const numberClass =
  "h-8 w-full rounded border border-border-strong bg-white px-2 text-[12px] tabular-nums text-text-primary outline-none focus:border-orange";

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
}

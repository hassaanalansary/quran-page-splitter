# Cancellable background processing — what changed and why

Processing used to be a synchronous `POST /process` that the frontend called in a loop,
50 pages at a time. It could not be stopped: aborting the `fetch` does nothing to a
running WSGI view, so the server would keep going and commit its pages anyway.

This document is the record of replacing that. It is written so it is useful twice: to
verify and debug *this* codebase, and to reuse the pattern elsewhere.

---

## 1. The shape of the change

Three layers, each independently useful:

```
core/pipeline.py          steerable engine     should_cancel / on_page_start / on_page_done
        ▲                                       + lazy image source
api/services/processing.py  run orchestration   lazy render, per-page persist, run row lifecycle
        ▲
api/services/jobs.py        job registry        one worker thread, threading.Event, poll state
        ▲
api/views/processing.py     HTTP contract       202 start · GET poll · POST cancel
        ▲
frontend                    no chunking         useProcessJob polls; Stop button
```

The key inversion: **the request no longer owns the run.** It starts it and returns. The
run's state lives in the job registry; the client discovers it by polling.

---

## 2. Cancellation: how it actually works

There is no safe way to kill a thread mid-write, so cancellation is **cooperative**:

1. `POST /process/cancel` sets a `threading.Event` on the job. It returns immediately.
2. `core/pipeline.py` polls that Event once per page — **before pulling the next page**.
3. If set: stop the loop, mark the remaining pages `skipped_cancelled`, return
   `status="cancelled"` with `cancel_at = {page_index, filename}` naming the first page
   that was *not* processed.

Three properties follow, and they're the whole point:

- **Latency is one page**, not 50. Worst case is the remaining time of the page in flight.
- **A cancel costs nothing it can avoid.** Because the check sits before the pull, and
  the image source is a generator, the page it stops on is never rendered and never
  detected.
- **`stopped_on_page` is exactly where to resume.** Everything before it is on disk;
  nothing from it onward was written.

Cancelling is safe for your *data*, but not free: on a long range an accidental click
costs minutes of detection you then have to redo. So the UI confirms first
(`ProcessCancelDialog`) — not as a warning, but as a ledger: pages already saved, pages
not yet done, and the page it would resume from, all on screen before you decide.

### Resuming after a cancel

Yes — and it is the normal way to work now. A cancelled run leaves the database in a
clean, consistent state: pages `rangeStart … stopped_on_page - 1` are fully written;
page `stopped_on_page` and everything after it are untouched (not half-written — the
page is atomic, and the run never even started it).

So "resume" is not a special mechanism. It is just **a new run whose start page is
`stopped_on_page`**, with the same settings. That is exactly what the **Resume from
page N** button does: it sets the start page and leaves everything else alone, so you
press Process again. The sura/aya carry-over is the one thing to keep in mind — the run
resumes from the *stored* start sura/aya, so if you resume mid-mushaf you want the start
position that page actually begins at (the Runs tab's **Resume →** fills this in for you
from the original run).

Nothing about a cancel is destructive or one-way. Cancel at page 200 of 600, look at the
results in Review, change a setting, and continue from 200 — that loop is the reason the
feature exists.

### The abort/cancel distinction

Two ways a run stops early, deliberately kept separate:

| | trigger | `stopped_on_page` | UI |
|---|---|---|---|
| `aborted_line_detection` | the engine failed on a page | the page that **failed** | red, opens the diagnostics dialog |
| `cancelled` | the user | the first page **not started** | neutral, toast only |

If both happen on the same page, **abort wins** — it is the real reason the run stopped,
and it carries diagnostics the user needs. (`test_abort_still_wins_over_a_late_cancel`.)

---

## 3. Lazy PDF rendering

Before: a list comprehension rendered every page in the range up front —
`fitz.open()` once per page, and all the 300-dpi PNGs held in memory at once
(50 pages ≈ 50–200 MB; a whole mushaf would have been unusable).

Now `_render_pages()` is a generator over **one** open document handle:

```python
with pdf.open_document(mushaf.pdf_file.path) as doc:
    images = _render_pages(doc, first_page, page_numbers, overrides, report)
    output = pipeline.run(images, filenames=filenames, should_cancel=..., ...)
```

- **One page in memory at a time**, regardless of range length.
- **One PDF parse** instead of N.
- The render happens inside `next()`, i.e. *after* the pipeline's cancel check — which
  is what makes a cancel free.

Because an iterator can't be measured or sliced, `Pipeline.run` takes `filenames`
separately: cheap metadata stays eager, only the bytes are lazy. Passing a plain list
still works (`filenames=None` materializes it), so nothing else had to change.

---

## 4. Persistence and the run row

Previously the `ProcessingRun` row was created **after** the pipeline finished, and all
pages were written in one transaction at the end. That doesn't survive a run being
stopped part-way, so it was inverted:

1. `_settle_stale_runs(mushaf)` — close out any row left `running` by a crash.
2. Create the row as **`running`**.
3. For each finished page, `on_page_done` writes it **in its own transaction**.
4. When the run settles, update the row's status and emit the activity event.

New statuses (`migration 0012`): `running`, `cancelled`, `interrupted`, alongside
`completed` / `aborted_line_detection` / `error`.

**`interrupted`** is how a crash is confessed rather than hidden: the process that owned
the row is gone, so the next run on that mushaf marks it interrupted. It is safe because
`jobs.ensure_idle` guarantees a mushaf never has two live runs.

---

## 5. What one run now is

The whole requested range is **a single pipeline run**: one tracker, one log file, one
`ProcessingRun` row. This deleted a class of bug rather than fixing it:

- The sura/aya carry-over between chunks is gone — it's just the tracker.
- The `alternate_horizontal_margin` parity trap is gone. The engine anchors the mirror to
  page 1 of the batch; the old client chunking only agreed with the preview because 50
  happens to be **even**. An odd chunk size would have silently mirrored the wrong pages.
  Now `rangeStart` *is* the batch start, so the preview is correct by construction.
- Run history is no longer one row per 50 pages.

---

## 6. HTTP contract

| Method | Path | Meaning |
|---|---|---|
| `POST` | `/api/mushafs/{id}/process` | **202** + `JobOut`. Starts the run, returns at once. **409** if the mushaf already has a run in flight; **400** for a bad range / missing templates. |
| `GET` | `/api/mushafs/{id}/process/job` | `{job: JobOut \| null}` — current or most recent run. |
| `POST` | `/api/mushafs/{id}/process/cancel` | Ask it to stop. **404** if nothing is running. |

`JobOut`: `id, mushaf_id, state, phase, page_range_start/end, total, pages_saved,
current_page, cancel_requested, started_at, ended_at, run_id, log_url, stopped_on_page,
abort_info, error, end_sura, end_aya`.

- `state` — `running` | `completed` | `aborted_line_detection` | `cancelled` | `error`
- `phase` — `starting` | `rendering` | `detecting` | `saving` | `finished`

Two deliberate design choices worth knowing:

- **The poll endpoint touches no database.** It reads the in-memory registry only. A
  1 Hz poll therefore never contends with the worker's SQLite writes. (Cost: an unknown
  mushaf id returns `{job: null}` rather than 404.)
- **The job is keyed by mushaf, not handed out as a token.** That is what lets a page
  reload — or a second tab — find a run already in flight. The client keeps no handle.

---

## 7. Three traps this hit, all reusable

### 7.1 Validation must move ahead of the job

Once you return 202, **nothing can be rejected any more**. `HttpError("templates
required")` raised inside the worker becomes a *failed run*, not a 400 — the user gets
"started!" followed by a failure.

Fix: `processing.preflight()` holds every check that must fail the request, and the view
runs it before registering the job. `process()` still calls it, so a direct call is never
unguarded.

Ordering is a real decision: **busy (409) is checked before payload (400)** — "a run is
already going" is the more useful answer even when the new request is also malformed.

This was caught by a test, not by review. Any sync → async migration has this trap.

### 7.2 A type predicate can narrow the *other* branch to `never`

```ts
// WRONG for this use
function isJobRunning(job: ProcessJob | null | undefined): job is ProcessJob
```

Because the negative branch is `Exclude<ProcessJob | null | undefined, ProcessJob>` =
`null | undefined`, combining it with an earlier `if (!job) return;` leaves `never` — and
every field access errors. TypeScript's aliased-condition narrowing propagates this
through `const running = isJobRunning(job)` too, so it bites in render code as well.

The predicate was lying: a *settled* job is still a `ProcessJob`. Fixed by returning a
plain `boolean` and deriving explicitly-typed values instead:

```ts
const activeJob  = job && !isJobSettled(job) ? job : null;   // ProcessJob | null
const settledJob = job && isJobSettled(job) && announcedJobId === job.id ? job : null;
```

Rule of thumb: only write `x is T` when the false branch genuinely means "not a T".

### 7.3 TanStack Query: `refetchInterval` reading `query.state.data` is circular

Inferring `TData` from `queryFn` while the options object also consumes `TData` makes the
inference circular; TanStack resolves `data` to `never` with no error at the call site —
the failures all appear at the *use* sites, which is very misleading.

```ts
useQuery<ProcessJob | null>({ ... })   // the explicit type argument is required
```

---

## 8. Django threading notes

- `runserver` is threaded by default, so the poll and cancel requests are served while
  the worker runs. Under `--nothreading` it still works: the worker is our own thread, and
  each request is fast.
- **Close the connection.** Each thread gets its own DB connection; the worker calls
  `connections.close_all()` in a `finally`, or a daemon thread would hold a SQLite handle
  open for its lifetime.
- **Tests need an inline mode.** A worker thread can't see data created inside a
  transactional `TestCase` (different connection, uncommitted). `PROCESS_JOBS_INLINE=True`
  runs the job on the calling thread, so a POST settles before it returns. Threading
  itself is covered separately with a *fake runner that never touches the DB*
  (`_Gate`), which is both honest and fast.
- `jobs.start(..., runner=, inline=)` exists purely as that seam. Keeping the seam in the
  production signature (rather than monkeypatching) is what makes the concurrency tests
  readable.

---

## 9. File map

**Backend**

| File | Change |
|---|---|
| `core/pipeline.py` | `should_cancel` / `on_page_start` / `on_page_done` / `filenames`; `cancelled` status + `cancel_at`; `PageOutcome`; `_append_skipped`; log helpers moved to module level so one handler can span a whole run |
| `api/services/pdf.py` | `open_document()` + `render_page_from()`; `render_page()` is now a wrapper |
| `api/services/processing.py` | `preflight()`; lazy `_render_pages()`; run row created up front; per-page persist; `_settle_stale_runs()`; returns `pages_saved` / `stopped_on_page` / `cancel_info` |
| `api/services/jobs.py` | **new** — registry, worker thread, cancel Event, `ensure_idle` |
| `api/views/processing.py` | `POST /process` → 202; `GET /process/job`; `POST /process/cancel` |
| `api/models.py` + `migrations/0012` | `running` / `cancelled` / `interrupted` statuses |
| `api/i18n.py` | `process_already_running`, `no_active_process` |
| `config/settings.py` | `PROCESS_JOBS_INLINE` |
| `api/tests/test_pipeline_control.py` | **new** — 8 tests: cancellation, laziness, progress hooks |
| `api/tests/test_process_jobs.py` | **new** — 19 tests: registry, threading, service, endpoints |

**Frontend**

| File | Change |
|---|---|
| `lib/api/types.ts` | `ProcessJob`, `ProcessJobState/Phase`, `isJobSettled` / `isJobRunning`; `ProcessResult` removed |
| `lib/api/processing.ts` | `startProcess` / `getProcessJob` / `cancelProcess` |
| `lib/api/queries.ts` | `useProcessJob` — polls at 1 s while running, stops when settled |
| `routes/…process.tsx` | chunk loop deleted; job-driven state; Stop button; phase readout; one outcome surface for all four endings |
| `components/app/ProcessConfirmDialog.tsx` | `chunkSize` prop gone |
| `components/app/details/{helpers,RunsTab}.tsx` | new statuses; **off-by-one fix** (below); progress bar from `pages_saved` |
| `lib/lastProcessRequest.ts` | outcome status `cancelled` |
| `i18n/locales/{en,ar}.ts` | phase labels, stop/cancel strings, run-status labels |

### Bug found in passing

`runAbortPage()` in `details/helpers.ts` computed `page_range_start + page_index`, but
`page_index` is **1-based** (`core/pipeline.py` enumerates from 1). The details Runs tab
reported the abort page one too high, and its **Resume** link therefore started one page
late — silently skipping the page that failed. Fixed to `+ page_index - 1`. The Process
page always had this right, so only the Runs tab was affected. `PROJECT_HANDOFF.md`
documented it as 0-based; corrected.

---

## 10. Watching it run, step by step

### Does the existing `launch.json` cope with the worker thread?

Partly. Two things to know before you set a breakpoint:

- **debugpy does debug threads.** A breakpoint inside the worker thread will hit, and the
  Call Stack pane lists every thread so you can switch between them. Nothing extra to
  configure.
- **But it suspends *all* threads when it hits.** So while you are paused inside the
  pipeline, the poll requests are frozen too — the browser will look hung and React Query
  will pile up retries. You cannot watch the UI update while stepping. That is not a bug
  in your setup; it is how the Python debugger works.
- **`runserver` autoreload runs the server in a child process.** The old "Debug Django"
  config keeps the reloader, which makes breakpoints flaky and can drop the session
  mid-run. Added **"Debug Django (no reload)"** for this.

### The configuration that actually answers your question

Reading the mechanism through the browser is the hard way. Two new launch configs run the
*same code* with the HTTP and the polling taken out:

| Config | What it exercises |
|---|---|
| **Debug: processing run (step through)** | `processing.process()` directly, **all on the main thread**. Nothing is suspended behind your back. Prompts for a page range and a cancel-after count, and rolls everything back at the end. |
| **Debug: processing run (worker thread)** | The real thing: a worker thread runs it while the main thread polls and cancels — the browser's behaviour, in a loop you control. |

Both drive `api/management/commands/debug_process.py`, which you can also run directly:

```
uv run python manage.py debug_process --pages 3-8 --cancel-after 2 --rollback
```

It borrows the detection settings (including `bounds`) from the mushaf's most recent run,
so process a few pages from the UI once first.

### Breakpoints, in execution order

Start with **"step through"**, `--pages 3-8 --cancel-after 2`, and put breakpoints here.
This is the whole feature in ten stops:

| # | Where | What you're looking at |
|---|---|---|
| 1 | `services/processing.py` → `preflight()` | The checks that must fail the *request*. Runs before any job exists. |
| 2 | `services/processing.py` → `_settle_stale_runs()` | Orphaned `running` rows from a previous crash being closed. |
| 3 | `services/processing.py` → `ProcessingRun.objects.create(... RUNNING)` | The row exists *before* any page. This is what lets pages be saved one at a time. |
| 4 | `core/pipeline.py` → `for page_index, filename in enumerate(names, start=1)` | Top of the page loop. `names` is the full range; the images are not rendered yet. |
| 5 | `core/pipeline.py` → `if should_cancel is not None and should_cancel()` | **The cancel check.** Step over it and watch it return False, False, then True. |
| 6 | `core/pipeline.py` → `raw_bytes, _ = next(pages_iter)` | Step **into** this. You land inside `_render_pages` in `processing.py` — the generator body runs *now*, on demand. This is why a cancel costs no render. |
| 7 | `services/processing.py` → `_render_pages()` `yield` | One page rendered, one page in memory. Come back here per page. |
| 8 | `core/pipeline.py` → `result = self.processor.process(...)` | The actual detection for this page. Step over unless you want the engine. |
| 9 | `services/processing.py` → `persist()` | The page being written in **its own transaction**, and `saved += 1`. This is the durability. |
| 10 | `core/pipeline.py` → the `cancelled = True` branch | The stop. Inspect `cancel_detail` — `page_index` here is what becomes `stopped_on_page`. |

Then let it run out and read the summary the command prints: `status`, `pages_saved`,
`stopped_on_page`. Check the arithmetic yourself — `stopped_on_page` should be
`page_range_start + pages_saved`, i.e. the first page nobody touched.

### Seeing the threading

Switch to **"worker thread"**. Useful breakpoints there:

- `services/jobs.py` → `start()` — the job being registered, then `threading.Thread(...)`.
  Step over the `.start()` line and notice control returns *immediately*: that is the 202.
- `services/jobs.py` → `request_cancel()` — `job.cancel_event.set()`. One line. Everything
  else is the pipeline noticing.
- `services/jobs.py` → `_execute()`'s `finally` — the job settling, and `connections.close_all()`.
- The command's poll loop — this is literally what `useProcessJob` does at 1 Hz.

Watch the Call Stack pane here: you will see **`MainThread`** (polling) and a second
thread running the pipeline. Set a breakpoint in `persist()` and you will see it hit on
the *worker* thread while the main thread sits in `time.sleep`.

### On the frontend side

`useProcessJob` in `lib/api/queries.ts` is the entire client mechanism. Rather than
breakpoints, open DevTools → Network and filter to `process/job`: you will see one
request per second while running, then the requests **stop** the moment the job settles
(that is `refetchInterval` returning `false`). Cancel is the single `process/cancel` POST
in between.

---

## 11. Manual test checklist

Backend: `uv run python manage.py test api` → **148 tests OK**, ruff + mypy clean.
Frontend: `tsc` clean, eslint 0 errors (6 pre-existing warnings), build OK.
Runtime is yours — here is what to exercise, with what should happen:

**Happy path**
1. Process a short range (3–8). Status cycles `Reading page N…` → `Detecting lines on
   page N…` → `Saving page N…`; the bar advances per page, not per 50.
2. On finish: green status, success toast, "Continue to Review", Runs tab has **one** row
   for the whole range.

**Cancel — the main event**
3. Start 3–200. Hit **Stop** mid-run.
   - A confirmation appears showing pages saved / not done / resume-from. "Keep
     processing" dismisses it and the run carries on untouched.
   - Confirm: button → "Stopping…" immediately and disables.
   - The run ends within *one page*, not one chunk.
   - Neutral (not red) card: "You stopped this run", stopped-before page, N pages saved.
   - Toast, no dialog.
   - **Check the DB/Review**: pages before the stop are all there; the stop page and
     everything after are untouched.
   - **Resume from page N** sets the start page to exactly the first unprocessed page.
4. Runs tab: the row reads **Stopped**, grey, with the bar at the real fraction.
5. Activity feed: "Run #NN stopped — N pages saved".

**Recovery / concurrency**
6. Start a long run, **reload the page**. The Process page should pick the run back up
   with live progress (this is the mushaf-keyed job doing its job).
7. Start a run, navigate to Review, come back. Same.
8. Two tabs on the same mushaf: starting in the second gives a 409 toast, and that tab
   then shows the running job's progress.
9. Start a run and `Ctrl-C` the server. Restart, open Process: no job (expected — memory
   is gone). Start a new run: the orphaned row in the Runs tab flips to **Interrupted**.

**Errors**
10. Delete a template, then Process → immediate **400** toast, no job started, no run row.
11. Range beyond the mushaf → immediate 400 (the client blocks it first).
12. An abort (line mismatch) still opens the diagnostics dialog with debug PNGs and the
    log link, red styling, and Resume from the failing page.

**Worth a look**
13. `alternate_horizontal_margin` on a long range — mirroring should now be correct for
    *every* page, including past page 50 where the old chunking anchored a new batch.
14. Memory during a 500-page run: should stay flat, not climb with range length.

---

## 12. Known limits (by design, worth knowing)

- ~~**Single process.**~~ **Resolved.** Job state moved from a module-level dict into the
  `ProcessJob` table (migration `0015`). Any worker can answer a progress poll, and a
  cancel raised in one process is seen by a worker in another — the cancel is a column the
  pipeline re-reads between pages, not a `threading.Event`.
- **A worker still owns its own thread.** A row outlives a restart, but the *work* does
  not: a deploy kills runs in flight. They no longer look alive forever, though — the
  worker stamps `heartbeat_at` on every progress tick, and any process that notices the
  silence (beyond `JOB_HEARTBEAT_TIMEOUT_SECONDS`, default 300) settles them as
  `interrupted`. Pages already written are intact and the range can be resumed. Removing
  this limit entirely means a real task broker.
- **Concurrency is capped, not queued.** `MAX_CONCURRENT_JOBS` (default 2) and
  `MAX_CONCURRENT_JOBS_PER_USER` (default 1) make a request over the limit **429** rather
  than waiting for a slot. Counted in SQL so the cap holds across processes; a small
  overshoot under a race is harmless and preferable to locking.
- **Only the Process page polls.** A run continues while you are elsewhere; there is just
  no global "processing…" indicator. Easy to add later from `useProcessJob`.
- **A mid-run crash gives no `stopped_on_page`**, so no Resume button — the range and
  `pages_saved` are still on the run row, so resuming manually is possible.
- **One run per mushaf; several mushafs may run at once**, up to the caps above.
- `frontend/dist/` was rebuilt by the verification build. Per the usual workflow, commit
  source only if you'd rather keep dist stale.

# Calibrating one page — a debugging session on paper

This is the session you would have if you put a breakpoint in the calibration view,
pressed **Process** on a page, and stepped through every function until the page's
new draft was saved. Every value quoted below is **real**: it was captured on
2026-10-15 by running `process_page` on **page 15 of mushaf `b9975701`** (مصحف المدينة
قديم جودة عالية) inside a transaction that was rolled back afterwards, so nothing in
the database changed.

Why page 15: it is a draft nobody has edited yet (revision 4, untouched), pages 1–14
before it are confirmed, the *Apply learning* switch is on and the mushaf is Hafs. So
every branch of `process_page` runs: calibration's proposals, the text's small-letter
locks, the learning re-read and the text-typed marks.

Loops are shown **once**: one line, one blob, one DP step. Branches this page did not
take are explained where they would happen, marked *(not hit on page 15)*.

---

## 0. How to run it yourself

### 0.1 The two launch configurations

Added to `.vscode/launch.json` (pick them from the Run and Debug dropdown):

| Configuration | What it runs | Use it for |
|---|---|---|
| **Debug: calibrate one page (step through)** | `manage.py debug_calibrate --page N --rollback` → calls `process_page()` directly, on the main thread | Reading the whole run. Start here. |
| **Debug: calibrate one page (via the job)** | the same with `--via job-inline` → `start_page()` → `jobs.start_words()` → the job runner, still on the main thread | Watching the job bookkeeping too |

Both ask for a page (default 15) and both **roll back** at the end. The command is
[`backend/api/management/commands/debug_calibrate.py`](../backend/api/management/commands/debug_calibrate.py),
the calibration twin of your `debug_process`. It sends the engine's DEBUG trace to
`backend/logs/debug_calibrate.log` rather than to the shared `quran.log` (one page is
about 1,500 lines of trace).

Two things the rollback cannot undo, and both are harmless. First, a line with no
snapshot yet is measured, and its `image.png`/`labels.png` are saved to media. The row
is rolled back but the files stay. On page 15 every snapshot already existed, so
nothing was written. Second, the in-memory caches last until the process ends.

The *via the job* configuration is **refused** on page 15 (`409 already_processed`):
`start_page` will not process a page whose draft still matches its sources. Give it an
unprocessed page (179 or later on this mushaf). The *step through* configuration has
no such check, because it calls `process_page` directly.

### 0.2 If you want the real HTTP path instead

Run **Debug Django (no reload)** and **Debug React Frontend**, open
`/mushafs/b9975701-…/word-cuts?page=179&mode=calibrate`, set a breakpoint in
`process_calibration`, and press Process. Three things to know:

1. **The view returns in milliseconds.** The work runs on a *worker thread*
   (`PROCESS_JOBS_INLINE = False`). Your breakpoints in `process_page` still stop,
   because debugpy follows threads, but they stop *after* the request has already
   answered 202.
2. **It writes for real.** It creates a new draft revision and a `processed`
   revision row.
3. **The heartbeat trap.** The job's `heartbeat_at` is ticked once per line measured,
   and between the readings. If you sit at a breakpoint longer than
   `JOB_HEARTBEAT_TIMEOUT_SECONDS` (300 s), the next poll from the browser runs
   `_settle_dead_jobs` and marks the job **interrupted**. Nothing actually died. The
   run carries on and settles itself at the end. The UI is wrong, not the run.

### 0.3 Breakpoints worth setting

In the order they fire. The § column says where this document covers each one.

| # | Where | Watch | § |
|---|---|---|---|
| 1 | `api/views/calibration.py:202` `process_calibration` | `mushaf_id`, `page_number` | 2 |
| 2 | `api/services/calibration.py:474` `start_page` | `start`, `end`, `review` | 3 |
| 3 | `api/services/calibration.py:612` `process_page` | everything below | 4 |
| 4 | `api/services/calibration_snapshots.py:226` `snapshot_line` | `existing` (reused or measured?) | 5 |
| 5 | `core/word_boundary/ink.py:163` `analyse_line` | `peak`, `top`, `bottom`, `components` | 5.3 |
| 6 | `api/services/calibration.py:525` `_blank_row` | `blobs[i]["proposal"]` | 6 |
| 7 | `api/services/calibration.py:1010` `_read` | `units`, `inks`, `stream` | 8 |
| 8 | `core/word_boundary/span.py:182` `parse_span` | `events`, `states`, `commits` | 9 |
| 9 | `core/word_boundary/alignment.py:244` `_with_body` | `want`, `done`, `options` | 9.2 |
| 10 | `core/word_boundary/span.py:137` `_settle` | `finals`, `best` | 9.4 |
| 11 | `api/services/calibration.py:1352` `_apply_outcome` | `owners`, `row["words"]` | 10 |
| 12 | `api/services/calibration.py:1525` `_small_letters` | `found` | 12 |
| 13 | `api/services/calibration_marks.py:123` `check_rows` | `check.types`, `check.sure` | 15 |
| 14 | `api/services/calibration.py:703` the `transaction.atomic()` in `process_page` | `document`, `prediction`, `frozen` | 17 |

`_advance` and `_with_body` fire once per blob, about a thousand times a page. Make
those breakpoints conditional, for example `ident == 0` or `event.line == 0`.

---

## 1. The map

The whole run on one screen. Read it top to bottom. Each box names its function, and
the numbers are page 15's.

```
 browser ── POST /api/mushafs/{id}/pages/15/calibration/process
   │
   ▼
 process_calibration (view)            returns 202 + the job, at once
   │
   ▼
 start_page ── refuses if already processed ── jobs.start_words ── thread
   │                                                                │
   └──────────────────────────────── run(job) ◄─────────────────────┘
                                       │
                                       ▼
 process_page(mushaf, 15) ──────────────────────────────────────────────────────┐
   │ 1. what to read      _span_for_page → 2:94..2:101                           │
   │                      word_stream    → 123 words  (text, paws, dots, aya, id)│
   │                      _span_lines    → 15 Line rows                          │
   │                      profile_for    → examples from pages 1–14 (12,543)     │
   │                                                                             │
   │ 2. per line (×15)    snapshot_line  → pixels → blobs, measured ONCE, stored │
   │                      _blank_row     → each blob as a dict + its proposal    │
   │                                                                             │
   │ 3. read the span     align_document(text_locks=False)   ← the PREDICTION    │
   │                        └ _read → detect_prepared → parse_span (the DP)      │
   │                        └ _apply_outcome per line → roles, owners, words     │
   │                                                                             │
   │ 4. text says         _place_text_locks → 4 small ۥ/ۦ blobs were "bodies"    │
   │ 5. learning on       align_document(calibration_locks=True) ← the DRAFT     │
   │ 6. people said       _carry_decisions, _keep_legacy_edges (none here)       │
   │ 7. mark types        _apply_text_types → 650 marks typed by the text        │
   │ 8. records           _shown, _frozen_record (the frozen engine, for compare)│
   │ 9. save              CalibrationReview.payload = draft  (revision 4 → 5)    │
   │                      CalibrationRevision(kind=processed) = prediction       │
   └─────────────────────────────────────────────────────────────────────────────┘
   │
   ▼
 jobs.settle(COMPLETED) ── browser poll sees it ── GET …/pages/15/calibration
```

The Django way to say it: the view is a thin controller, and `api/services/calibration.py`
is the service layer. `core/word_boundary/` is a pure library that never touches the ORM.
The service converts between the two: ORM rows become dataclasses on the way in, and
dataclasses become JSON on the way out.

### 1.1 The three coordinate systems

You will see x values change by hundreds between functions. That is because there are
three coordinate systems, and confusing them is the most common way to misread a
value while debugging.

```
   page (the rendered PDF page, ~2480 px wide)
   ┌──────────────────────────────────────────────────────────────┐
   │        line.bbox_x = 573                                     │
   │        ┌──────────── line image (1335 × 139) ─────────────┐  │
   │        │  offset_y = 5                                    │  │
   │        │   ┌────────── tight crop (1335 × 130) ─────────┐ │  │
   │        │   │ the engine works here                      │ │  │
   │        │   └────────────────────────────────────────────┘ │  │
   │        └──────────────────────────────────────────────────┘  │
   └──────────────────────────────────────────────────────────────┘

  tight  ──(+offset_x, +offset_y)──►  image  ──(+bbox_x, +bbox_y)──►  page
```

| Space | Who uses it | Example: blob 35 on line 1 |
|---|---|---|
| **tight** | `Blob` inside the engine; the snapshot's `metadata["blobs"]` | `x=1275, y=33` |
| **image** | `InkComponent`, `WordBox` (the engine adds the offset back once, in `_line_result` / `build_line_boxes`) | `x=1275, y=38` |
| **page** | every dict in the calibration document (`blob["x"]`, `word["start_x"]`) | `x=1848, y=641` |

There are also **three kinds of id**:

| Id | What it is | Unique within |
|---|---|---|
| `blob.label` / `blob["id"]` | the connected-component number from OpenCV | one line |
| `ident` | the blob's position in the span's flat reading order (`span._Event.ident`) | the span. The DP's groups hold these. |
| `word_id` | `quran.Word.id` (1594 = قُلْ, the first word of 2:94) | the Quran |

---

## 2. Stop 1 — the browser and the view

**Frontend.** `CalibrationEditor.tsx:552`, `processMutation`, calls
`processCalibration(mushafId, page)` (`lib/api/calibration.ts:85`):

```
POST /api/mushafs/b9975701-…/pages/15/calibration/process      (no body)
```

On success it puts the returned job into the React Query cache. Then
`useCalibrationJob` (`lib/api/calibration.ts:140`) polls
`GET /api/mushafs/{id}/calibration/job` once a second, for as long as
`isJobRunning(job)`.

**View.** [`api/views/calibration.py:202`](../backend/api/views/calibration.py)

```python
@router.post("/{mushaf_id}/pages/{page_number}/calibration/process", response={202: ProcessOut})
def process_calibration(request, mushaf_id, page_number):
    mushaf = mushaf_service.get_mushaf(mushaf_id, user=current_user(request))   # owner, or 404
    job = calibration_service.start_page(mushaf, page_number, user=current_user(request))
    return 202, {"job": jobs_service.to_dict(job)}
```

It is a django-ninja router, so it works like a DRF `@api_view`. `get_mushaf(..., write=True)`
is the permission check: the owner may write, and everyone else gets a 404 (not a 403,
so a stranger cannot learn that the id exists). The view does nothing else. Step Into
`start_page`.

---

## 3. Stop 2 — `start_page`: refuse early, then start a job

[`api/services/calibration.py:474`](../backend/api/services/calibration.py)

```
start_page
  ├ _span_for_page(mushaf, 15)       → ((2, 94), (2, 101))          see §4.1
  ├ word_runs.preflight(...)         → RunPlan(first_page, last_page, total_lines, …)
  ├ refuse "already_processed" if the stored draft's snapshots AND context are current
  ├ expected = review.revision       → 4   (optimistic lock, checked again at save)
  └ jobs.start_words(mushaf, plan, runner=run, kind=CALIBRATION, current_page=15)
```

* **`preflight`** ([`word_runs.py:146`](../backend/api/services/word_runs.py)) checks
  everything a background job could only fail on later: is a riwaya set, do both ayat
  exist, does the span run forwards. A failure here becomes an HTTP 422, not a failed
  job.
* **The refusal** is why the HTTP path will not re-process page 15. Its draft was made
  from the same snapshots that `_sources_current` finds today.
* **`jobs.start_words`** ([`jobs.py:250`](../backend/api/services/jobs.py)) runs
  `ensure_idle` (409 if the mushaf already has a job of any kind running) and
  `_ensure_capacity` (429 past `MAX_CONCURRENT_JOBS`, 2, or one job per user). It then creates a `ProcessJob` row (`kind="calibration"`,
  `total=plan.total_lines`, `heartbeat_at=now`) and calls `_launch`. `_launch` starts
  a daemon `threading.Thread(target=_execute)`, or runs inline when asked.
* **`_execute`** wraps the runner: any exception becomes `state=error`, and it closes
  the thread's DB connections at the end.
* **`run(job)`**, the closure inside `start_page`, calls `process_page` with two
  callbacks:
  * `progress(count)`, which is `jobs._touch(job.id, phase="detecting", lines_done=count)`
    and ticks the heartbeat;
  * `cancelled()`, which re-reads the `cancel_requested` column. It is a column and not
    a `threading.Event` because the canceller may be another process.

  Afterwards it calls `jobs.settle(COMPLETED or CANCELLED)`.

Everything from here on runs on the worker thread (or on the main thread with
`debug_calibrate`).

---

## 4. Stop 3 — `process_page`: deciding what to read

[`api/services/calibration.py:612`](../backend/api/services/calibration.py). Eight
preparations before any pixel is touched.

### 4.1 `_span_for_page` → `((2, 94), (2, 101))`

It reads every `Segment` on the page's TEXT lines, ordered by
`(line_number, segment_order)`, and takes the first and the last `(sura, aya)`.

* A segment is the part of a line belonging to one aya. Review cut the lines there.
* It refuses `not_reviewed` (422) and `not_numbered` (any segment with a null aya).
  Not knowing an aya would mean guessing where to start, and the whole engine is
  anchored on ayat.

Page 15 starts exactly at 2:94 and ends exactly at 2:101, so **no line of another page
is involved**: `context` will be empty. On a page whose first aya began on the page
before, `_span_lines` would also return that page's lines, and they become read-only
*context* rows (§4.6).

### 4.2 `word_stream` → 123 `WordInput`s

`word_inputs.counting_system_for(mushaf)` follows mushaf → rawi (Hafs) → counting system
(Kufi). Then [`quran/services/words.py:51`](../backend/quran/services/words.py) runs two
range queries, words by id and ayat by `start_word_id`, and walks them together:

```python
WordInput(text="قُلْ",   paws=1, ijam_above=1, ijam_below=0, aya="2:94", id=1594)
WordInput(text="إِن",    paws=2, ijam_above=1, ijam_below=0, aya="2:94", id=1595)
WordInput(text="كَانَتْ", paws=2, ijam_above=2, ijam_below=0, aya="2:94", id=1596)
WordInput(text="لَكُمُ",  paws=1, ijam_above=0, ijam_below=0, aya="2:94", id=1597)
…
WordInput(text="يَعْلَمُونَ", paws=2, ijam_above=1, ijam_below=1, aya="2:101", id=1716)
```

**`paws`** is the number the whole engine depends on: how many separate blobs of letter
ink this spelling *must* print. Arabic letters in `NON_JOINERS` (`ا د ذ ر ز و ة …`)
never join the next letter, so a word breaks after each one
([`core/text/arabic.py:63`](../backend/core/text/arabic.py)):

```
 إِن  → letters "ان"  → ا is a non-joiner → pieces ["ا", "ن"] → paws = 2
 كَانَتْ → "كانت"     → after ا           → ["كا", "نت"]     → paws = 2
 قُلْ → "قل"          → no non-joiner     → ["قل"]           → paws = 1
```

The count was computed when `Word` was seeded, so it is not recomputed here.
`ijam_above/below` are dot groups (`ق` has one group of two dots above). They are
used only for *reporting* (§9.6).

### 4.3 `_span_lines` → 15 `Line` rows

It uses `line_images.locate()` to find the line where 2:94 starts and the line where
2:101 ends. Then it fetches every TEXT line between them, with `segments` and
`erase_strokes` prefetched. Sura headers and besmala lines are left out: they hold no
word of the stream. Page 15's lines, as `(page, line, bbox_x, bbox_y, bbox_w, bbox_h)`:

```
(15, 1, 573, 603, 1335, 139)   (15, 2, 565, 760, 1344, 144) … (15, 15, 563, 2791, 1351, 148)
```

### 4.4 `settings_document` → `{"revision": 9, "experimental": True}`

`experimental` is the *Apply learning to new pages* switch. It changes two things
later: the matcher's gate (§4.5), and a second reading under calibration locks (§13).

### 4.5 `profile_for(mushaf, 15)` → which examples teach this page

[`calibration.py:278`](../backend/api/services/calibration.py)

```
_approved(mushaf, before_page=15)    every CONFIRMED revision of a page < 15  → pages 1..14
config = DEFAULT_CONFIG;  experimental → config["min_distinct_pages"] = 1
signature = sha256({feature_version, config, revision ids})   → "237816abeda4…"
CalibrationProfile.get_or_create(signature)                    (the row records WHICH examples)
_prepared(mushaf, profile)                                     (the matrix is built, then cached)
```

`_prepared` → `_samples` → for every confirmed line, `snapshots.blob_features(snapshot)`
→ `build_prepared` stacks them into one numpy matrix. On page 15 that was **12,543
distinct descriptors (3,308 bodies, 9,235 marks) from pages 1–14**, built in **~9 s**.
Here is where that time goes: each descriptor is computed from that line's stored
`labels.png`. The result is cached in `_PREPARED` by `(mushaf, signature)`, so the
next page with the same approvals skips this step.

"*Strictly before*" is deliberate: a page is never predicted from its own labels. That
is what makes the prediction record an honest test.

### 4.6 `Templates.of`, `_approved_rows`, `earlier`

* `Templates.of(mushaf)` loads the aya-ornament template and the sajda/rub' templates,
  each trimmed to its ink (`prepare_template`). They are only used if a line has to be
  measured.
* `_approved_rows(mushaf, pages_of_lines − {15})` → `{}` here. For a page whose ayat
  begin on a **confirmed** neighbour, this returns that neighbour's approved rows. In
  §5 they are used as-is through `_as_constraint`: every role there becomes
  `explicit`, every allocation `ownership_explicit`. A confirmed page is never re-read,
  only read *around*. *(Not hit on page 15.)*
* `earlier = _review(mushaf, 15)` → the current draft (revision 4).
  `before = {snapshot_id: row}` keeps that draft's rows, so §14 can carry over what a
  person decided on them.

---

## 5. Stop 4 — per line: `snapshot_line`, pixels into blobs

```python
for index, line in enumerate(lines, start=1):                 # 15 iterations; we follow line 1
    if cancelled is not None and cancelled(): return False
    rendered[line.page_id] = line_images._render_page(mushaf, line.page)   # once per page
    snapshot = snapshots.snapshot_line(mushaf, line, rendered[...], templates)
    row = _as_constraint(...) if readonly and approved else _blank_row(snapshot, line, prepared, readonly=...)
    progress(index)                                           # heartbeat
```

### 5.1 Why snapshots exist

A calibration label says "blob **35** of this line is a body". The number 35 is only
meaningful against the exact pixels it was given on. The old word-run path cut lines
at aya boundaries, which renumbers the blobs. Re-processing a page also deletes its
`Line` rows. So each line is measured **once, uncut**, and frozen as a
`CalibrationSnapshot` row holding:

* `image.png`, the line;
* `labels.png`, an RGB picture where each pixel's colour *is* its blob id
  (`id = R + 256·G + 65536·B`). The browser reads it back to hit-test clicks;
* `metadata`, every blob's geometry and evidence, the band, the ornaments.

### 5.2 `snapshot_line` — reuse or measure

[`calibration_snapshots.py:226`](../backend/api/services/calibration_snapshots.py)

```python
fingerprint = source_fingerprint(line)    # sha256 of: pdf sha, pdf page, bbox, type, sura,
                                          #   segments, erase strokes, template PIXELS
existing = CalibrationSnapshot.objects.filter(mushaf=mushaf, fingerprint=fingerprint).first()
if existing: return existing              # ← page 15: every line, created 2026-09-27
```

This works like a content-addressed cache key. Moving a segment in review, drawing an
erase stroke or re-cutting the ornament template changes the fingerprint, and the
line is measured again under a new id. The old draft then reads as **stale**.

On page 15 all 15 lines hit `existing`. To watch a measurement, step into
`extract_line` on an unprocessed page.

### 5.3 `extract_line` → `analyse_line`: what a measurement does

[`calibration_snapshots.py:172`](../backend/api/services/calibration_snapshots.py) →
[`core/word_boundary/ink.py:163`](../backend/core/word_boundary/ink.py). Line 1's
real numbers, from the engine's own trace:

```
 1. _image_for(line, page, None)        crop the page at the line's OWN bbox (not the page
                                        column: a column contains the frame)  → 1335×139 RGBA
    _separators(line, origin, w, 120)   ornament spans from the reviewed segments:
                                        segment.has_separator → (bbox_x - origin, +template w)
                                        line 1: none.  line 2: [(0,128)] closing "2:94"

 2. load_ink        alpha > 40 → boolean mask
    tight crop      first/last inked row & column → 1335×130 at offset (0,5), 26,632 ink px

 3. writing band    profile = ink per row; peak = densest row = 81 (797 px)
                    grow up/down while a row holds ≥ 30 % of the peak (239.1 px)
                    → band y = 61..88  (28 px high)

 4. cv2.connectedComponentsWithStats(tight, connectivity=8)  → 63 blobs, each a Blob(label,x,y,w,h,area)

 5. preferred role, by position only:
       spans the peak row         → "body"
       touches the band           → "mark"
       clear of the band          → "mark-only"
    line 1: 18 body, 6 mark, 39 mark-only

 6. body_score 0..14, evidence that a blob is a letter:
       6 × crosses the peak row
     + 3 × (overlap with band / band height)
     + 3 × (area / median body area)          capped at 1
     + 2 × (height / band height)             capped at 1
     − 4 × lies inside a much bigger blob's box   (a kasra in its ن's bowl)
```

Two blobs from line 1, worked through by hand.

```
 #35  x=1275 y=33  60×73  area 1274   (the ق‍ل of قُلْ)
      spans row 81?  33 ≤ 81 < 106 → yes          6
      band overlap   min(106,89) − max(33,61) = 28, 28/28 = 1     3
      area           1274 / 960 ≥ 1               3
      height         73 / 28 ≥ 1                  2
      nested?        no                          −0
      body_score = 14    →   cost_as_body = 14 − 14 = 0,  cost_as_mark = min(14, 6) = 6

 #36  x=1315 y=33  20×11  area 156    (the two dots of ق, as one blob)
      spans row 81?  no; touches band? bottom 44 < 61 → no → "mark-only"
      area 156/960·3 = 0.49,  height 11/28·2 = 0.79
      nested inside #35's box, and 156 < 0.35 × 1274      −4
      body_score = max(0, round(1.27 − 4)) = 0  →  cost_as_body = 14, cost_as_mark = 0
```

**The score is a price, not a decision.** Every blob can still be read either way. It
costs `cost_as_body` to use it as a letter and `cost_as_mark` to leave it out. The cap
of 6 on `cost_as_mark` (`MAX_UNUSED_COMPONENT_COST`) is the most sensitive number in
the engine: it is what ignoring a body-looking stroke costs. See
`core/word_boundary/calibration.py` for the measurements behind each weight.

```
 7. split_symbols(ink, templates.symbols)     sajda/rub' matched (≥ 0.5) and REMOVED. They
                                              register no span, so they close nothing.
 8. split_separators(ink, ornament)           spans were supplied, so both detectors are skipped.
                                              Blobs whose centre is in a span move to
                                              ink.separators. Line 2: ornament x=0..120,
                                              3 pieces [1, 38, 34] (the ring and its digits).
 9. raster = label_map placed at the offset   → labels.png
    metadata = {bbox, blobs (ALL, incl. ornaments), components (text only), separators,
                separator_spans, separator_ayat, symbols, band, peak, offset_x/y, segments, sura}
```

### 5.4 Page 15's lines as measured

| line | blobs | text | ornament (tight x) | closes | segments |
|---|---|---|---|---|---|
| 1 | 63 | 63 | — | | 2:94 |
| 2 | 59 | 56 | 0..128 | 2:94 | 2:94 |
| 3 | 78 | 78 | — | | 2:95 |
| 4 | 62 | 59 | 1221..1345 | 2:95 | 2:95 · 2:96 |
| 6 | 63 | 60 | 70..198 | 2:96 | 2:96 · 2:97 |
| 9 | 59 | 56 | 1220..1343 | 2:97 | 2:97 · 2:98 |
| 10 | 64 | 61 | 303..431 | 2:98 | 2:98 · 2:99 |
| 11 | 70 | 67 | 0..128 | 2:99 | 2:99 |
| 13 | 55 | 51 | 880..1008 | 2:100 | 2:100 · 2:101 |
| 15 | 54 | 50 | 0..128 | 2:101 | 2:101 |

That makes eight ornaments for eight ayat. Line 4's ornament sits at its **right**
end, which is where an Arabic line *starts*. It closes 2:95, whose words all sat on
line 3, so line 4 *opens* on the ornament.

---

## 6. Stop 5 — `_blank_row`: each blob as the editor will see it

[`calibration.py:525`](../backend/api/services/calibration.py). It turns the snapshot
into the document row the editor edits. Three things happen.

**Coordinates to page space**:
`ox = bbox.x + offset_x = 573`, `oy = bbox.y + offset_y = 608`. So blob 35's tight
`(1275, 33)` becomes `(1848, 641)`, and the band `[61, 88]` becomes `[669, 696]`.

**A first role**: `ornament` or `symbol` if it is one of those, otherwise
`"body" if preferred == "body" else "mark"`. That gives 18 bodies and 45 marks on
line 1. This is only the starting point; the reading in §8 decides.

**Calibration's proposal** (the "learning"):

```python
features = snapshots.blob_features(snapshot)   # per blob: 1,030 numbers
found = predict_prepared(features[ident], prepared)
```

`feature_vector` ([`examples.py:44`](../backend/core/word_boundary/examples.py)) is the
blob's mask resampled onto a 32×32 square (1,024 numbers, aspect preserved), plus 6
geometry numbers relative to the band: width, height, area, ink density, aspect, and
offset from the peak row. Only the 32×32 square is size-free; the geometry keeps
size.

`predict_prepared` ([`examples.py:301`](../backend/core/word_boundary/examples.py)) is
a 5-nearest-neighbours search with a strict **gate**. The *learning* is the five
nearest confirmed examples. It proposes a role only when **all** of these hold:

```
 5 nearest all agree                      else  "mixed_neighbors"
 ≥ 5 of them (min_support)                else  "insufficient_support"
 from ≥ 1 distinct page (experimental)    else  "insufficient_pages"
 the farthest of them < 0.15              else  "too_far"
 the nearest OPPOSITE-role example is
    > 0.10 farther (margin)               else  "insufficient_margin"
    and the ratio farthest/opposite < 0.5 else  "insufficient_ratio"
```

On line 1 the proposals were **13 body, 38 mark, 12 abstained**. Blob 35 abstained
(`too_far, insufficient_ratio`): no confirmed ق‍ل looked close enough. The dot,
blob 36, was proposed `mark` with confidence 0.33.

The row that comes out, abridged:

```python
{"snapshot_id": "4b107adf-…", "line_id": "…", "page_number": 15, "line_number": 1,
 "bbox": {"x": 573, "y": 603, "w": 1335, "h": 139}, "band": [669, 696],
 "readonly": False, "approved": False, "status": None, "reason": None, "words": [],
 "blobs": [
   {"id": 35, "x": 1848, "y": 641, "w": 60, "h": 73, "area": 1274, "body_score": 14,
    "role": "body", "initial_role": "body",
    "explicit": False, "ownership_explicit": False,      # nobody decided anything
    "subtype": "", "subtype_explicit": False, "exception": "",
    "allocations": [], "attention": [], "decision_source": "search",
    "proposed_role": None,
    "proposal": {"role": None, "confidence": 0.0, "reasons": ["too_far", "insufficient_ratio"]}},
   …]}
```

**Time.** This is the slow part of the page: about **5–7 s a line**, roughly 80 of the
run's 105 s. The cost is `blob_features` plus one distance pass against 12,543 × 1,030
numbers for each of ~65 blobs.

Then `process_page` assembles the document:

```python
document = {"page": 15, "start": [2, 94], "end": [2, 101],
            "stream": [asdict(w) for w in stream],        # the 123 words, as dicts
            "profile": {"signature": …, "mode": "shadow", "pages": [1..14], "examples": 12543},
            "lines": [15 rows], "context": [], "issues": []}
```

---

## 7. Stop 6 — the first reading: `align_document(document, text_locks=False)`

[`calibration.py:976`](../backend/api/services/calibration.py). Before stepping in,
know that `process_page` reads the page **up to three times**, and each reading has a
job:

| # | call | locks applied | becomes |
|---|---|---|---|
| 1 | `align_document(text_locks=False)` | none. The engine's own judgement. | `prediction`, the immutable record that is evaluated later |
| 2 | `align_document(calibration_locks=True)` (learning on) or `align_document()` (only if text locks moved ink) | the text's small letters, and calibration's proposals when learning is on | the draft |
| 3 | `align_document(...)` again, only if `_carry_decisions` brought human decisions back | + human decisions | the draft |

`align_document` is a thin loop: run `_read`. If `text_locks` is on, place the text's
locks on the result, and if they disagree with the reading, run `_read` once more
(§13). Reading 1 has `text_locks=False`, so it is a single `_read`.

---

## 8. Stop 7 — `_read`: from document back to engine input

[`calibration.py:1010`](../backend/api/services/calibration.py)

```
result = deepcopy(document)                   the input is never modified
rows   = lines + context, sorted by (page, line)
units  = _fused_units(rows, stream)           → {}  (see below)

for row in rows:                              ×15
    image, ink = snapshots.load(snapshot)     rebuild the LineInk from storage, no measuring
    cut = select_span(ink, metadata, start, end)
    for blob in ink.components:
        _constrain(blob, row's blob dict, …)  copy decisions onto the engine's Blob
stream = [_word(w) for w in result["stream"]] dicts → WordInput
source = WordBoundaryInput(lines=images, words=stream, ijam="report")
aligned = detect_prepared(source, inks)       ← the engine (§9)
```

* **`snapshots.load`** ([`calibration_snapshots.py:272`](../backend/api/services/calibration_snapshots.py))
  decodes `labels.png` back into the tight `label_map` and rebuilds a fresh `Blob` for
  each stored dict. It must be fresh because the engine writes `role` and locks onto
  the blobs it is handed. If two readings shared the objects, one reading's decisions
  would leak into the next.
* **`select_span`** keeps only blobs overlapping a segment of the requested ayat. It
  never splits a blob: one crossing the edge stays whole and is reported in `cut`
  (it gets the `span-boundary` flag later). Page 15's span is exactly the page, so
  `cut = []` everywhere.
* **`_constrain`** ([`calibration.py:1240`](../backend/api/services/calibration.py))
  is where decisions become engine constraints. There is a strict precedence:

  ```
  person decided the role or the owner     → locked_role = role,        lock_source "human"
  else the text named a small letter       → locked_role = text_role,   lock_source "calibration"
  else learning on and a proposal exists   → locked_role = proposed,    lock_source "calibration"
  a person gave the body to a word         → assigned_word_id, paw_count = Σ paws, "human"
  ```

  "human" locks are absolute. "calibration" locks are *provisional*: the engine may
  release them aya by aya (§9.5). In reading 1 nothing is locked. In reading 2,
  **598 marks and 151 bodies** were locked as "calibration".
* **`_fused_units`** handles two words printed touching across a word break. If a
  person allocated one body to two words, those words are sent to the engine as one
  combined `WordInput` (their PAWs and dots added), and split again in
  `_apply_outcome`. This uses union-find over shared blobs. → `{}` on page 15.
  *(Not hit.)*

---

## 9. Stop 8 — inside the engine: `detect_prepared` → `parse_span`

[`core/word_boundary/engine.py:110`](../backend/core/word_boundary/engine.py)

```
_apply_constraints(source, inks)      validates every lock (a bad key raises; it is never dropped)
starts = aya_starts(words)            → [0, 17, 26, 51, 69, 81, 91, 101, 123]
parses, cursor = parse_span(inks, words, aya_starts=starts, ijam="report")
apply_parse_roles(ink, parsed)        per line: commit each blob's role
… three safety nets …
lines = [_line_result(...)]           → WordLine per line, with WordBoxes
```

`aya_starts` lists the word index at which each aya begins, plus an end sentinel: 2:94
is words 0–16, 2:95 is 17–25, and so on.

### 9.1 `_events` — one reading order for the whole span

[`span.py:85`](../backend/core/word_boundary/span.py). Every line's blobs are sorted
right to left by right edge (`parser_events`, `alignment.py:147`). An ornament becomes
an event at its own right edge. Each line ends with a `line-end` event.

```
 page 15 →  965 events = 942 blob  +  8 ornament  +  15 line-end

 line 1:  blob#35(ident 0) blob#36(1) blob#1(2) blob#13(3) blob#63(4) … 63 blobs … line-end
 line 2:  blob(63) … blob(118)  ornament "2:94"  line-end
 line 3:  …
```

`ident` is the blob's position in this flat list, unique across the span. The DP's
groups are made of idents. To read one back, use `by_ident[ident] → (line, Blob)`.

### 9.2 The DP: states, and one step

This is **forced alignment**. The text tells us the sequence of words and how many
blobs each must take, and the DP finds the cheapest way to hand the blobs out in
order. The Django analogy is a ``prefetch_related`` matching child rows to parents in
order, where some rows are noise and every assignment has a price.

A **state** is "where the reading is", and its record is "the best way it got there":

```
 key    = (word_index, blobs_taken_by_current_word, previous_end, current_left)
            which word   how many so far               geometry, for the tie-break tier
 record = ParseRecord(cost, groups=((idents of word 0), (word 1), …),
                      current_group=(idents of the open word), deviations, inversions, …)
 rank   = (cost, deviations, inversions)      compared lexicographically, lowest wins
```

For each blob event, `_advance` ([`alignment.py:196`](../backend/core/word_boundary/alignment.py))
takes every live state and tries two moves:

```
 _with_mark(record, blob)        leave the blob out:  cost += blob.cost_as_mark
 _with_body(record, blob, …)     give it to the current word:  cost += blob.cost_as_body, done += 1
                                   ├ close the word here, if done ≥ max(1, want−2):
                                   │     cost += 20 × |done − want|   (COUNT_WEIGHT)
                                   │     → state (word+1, 0, previous_end=left, None)
                                   └ keep the word open, if done < want+2
                                         → state (word, done, previous_end, current_left)
```

**Real step 1**: blob 35 (ident 0), word 0 = قُلْ (wants 1 PAW). There is one state in,
`(0, 0, None, None)` with cost 0. Three states come out:

```
 (0, 0, None, None)  cost 6   mark  — 35 left out (cost_as_mark 6)
 (1, 0, 1275, None)  cost 0   body, word 0 CLOSED with [35]: 1 of 1 PAW, exact
 (0, 1, None, 1275)  cost 0   body, word 0 still OPEN with [35] (might take one more)
```

**Real step 2**: blob 36 (ident 1), the dot of ق (cost_as_body 14, cost_as_mark 0).
Three states in, six or more out, including:

```
 (1, 0, 1275, None)  cost 0    dot left out — word 0 stays [35]                 ← the right one
 (2, 0, 1315, None)  cost 34   dot read as the WHOLE of word 1 إِن (wants 2, got 1):
                               0 + 14 (body cost) + 20 (one PAW short) = 34,
                               deviations 1, inversions 1 (its left 1315 ≥ previous end 1275)
 (1, 1, 1275, 1315)  cost 14   dot read as the first PAW of إِن, word still open
 (0, 2, None, 1275)  cost 14   dot read as a second PAW of قُلْ (allowed: want+2 = 3)
```

Nothing is ruled out; the wrong readings simply get expensive. Two mechanisms keep
the number of states down:

* **`_merge_record`** keeps one record per key. If two arrivals rank equal, it keeps
  the one with lexicographically smaller `groups` (the one that spends the earliest
  ink), and ORs the role differences into `role_ambiguous_mask`. That mask becomes
  the blue "ambiguous" inset and the `ambiguous` flag.
* **The dominance prune** at the end of `_advance` works per `(word, done, open?)`.
  Only records whose `(cost, deviations)` equals the best survive. Geometry may break
  ties but can never rescue a worse reading.

The state count grows across a line: 1 → 3 → 6 → 9 → 13 → 18 … → 89 at blob 20 →
254 at blob 40 → **679** at line 1's end.

### 9.3 `line-end` — a word cannot cross a line

`_line_end` ([`alignment.py:219`](../backend/core/word_boundary/alignment.py)) keeps
only the states with **no open word** (`done == 0 and not current_group`), and resets
their geometry because a new line starts fresh. Line 1: **679 → 60** states.

Note what it does *not* do: it does not choose. Sixty readings of line 1 survive into
line 2 (for example, "line 1 holds 10 words" and "line 1 holds 9 and the 10th starts
line 2"). This is the 2026-09-25 change. Before it, each line was committed alone, and
a line that came up a blob short could not be paid for by re-reading the line above.

*(Not hit:)* if no state survives a line end, and the stretch holds no constrained
blob, the stretch is committed early with `commit(None, …)`, the frozen fallback.

### 9.4 The ornament — where a reading is finally chosen

The first ornament event is at the left end of line 2, closing "2:94".

```python
declared = aya_ends.get("2:94")                 # → 17: aya 2:94 ends before word 17
commit(_required_end("2:94", aya_ends, entry=0, starts), event_index, absolute=True)
```

`_required_end` ([`span.py:113`](../backend/core/word_boundary/span.py)) **prefers the
label**: the reviewed segment said which aya this ornament closes, so the reading must
end at word 17. Counting from the cursor (`_aya_end_after`) would give the same 17
here; the label only matters once the cursor has drifted.

`commit` → `_settle(states, require_end=17)` ([`span.py:137`](../backend/core/word_boundary/span.py)):

```
 live states                 1,040
 finals (no word open)         187   covering word indices 0 … 114
 anchored (word index == 17)   kept; the others drop
 best rank                   (193, 0, 0)   cost 193, no word off-count, no inversion
 ties at best rank            1   → end_sequences = 1
 chosen groups (idents)      [0] [6,7] [9,11] [17] [21,22,25,26] [29,31,34,39] [41] …  (17 words)
```

The committed reading as the engine's trace prints it (labels, not idents):

```
→ committed words 0..17 over line(s) [0, 1]  cost=193  deviations=0  readings=1
    word 0     قُلْ           paws want 1 got 1      i'jam 1↑/0↓  blobs [35]
    word 1     إِن            paws want 2 got 2      i'jam 1↑/0↓  blobs [41, 56]
    word 2     كَانَتْ        paws want 2 got 2      i'jam 2↑/0↓  blobs [20, 53]
    word 3     لَكُمُ         paws want 1 got 1      i'jam 0↑/0↓  blobs [31]
    word 4     ٱلدَّارُ       paws want 4 got 4      i'jam 0↑/0↓  blobs [39, 30, 38, 55]
    …
    word 16    صَٰدِقِينَ     paws want 2 got 2      i'jam 2↑/1↓  blobs [39, 45]
```

The groups hold **bodies only**. A blob not in any group was left out, so it is a mark
or noise. Marks are not given to words until §10.

After the commit: `entry = 17`, `states = _fresh(17)`. That is one state with
`(17, 0, None, None)` and cost 0: the search restarts from nothing at the next aya.
This is what keeps a mistake in one aya from spreading into the next. An ornament is
**absolute**: if the reading had stopped at, say, word 16, the line
`boundary overrides the cursor: 16 -> 17` would appear, and 2:95 would still start at
word 17.

All eight commits on page 15, reading 1:

| words | lines (0-based) | cost | readings |
|---|---|---|---|
| 0..17 | 0, 1 | 193 | 1 |
| 17..26 | 2 | 114 | 1 |
| 26..51 | 3, 4, 5 | 296 | **2** |
| 51..69 | 5, 6, 7 | 175 | 1 |
| 69..81 | 8, 9 | 127 | **2** |
| 81..91 | 9, 10 | 110 | 1 |
| 91..101 | 11, 12 | 123 | 1 |
| 101..123 | 12, 13, 14 | 233 | 1 |

"readings = 2" means two different readings tied at the best rank (cost and
deviations). One was chosen deterministically, and the lines involved are reported
`2 equal-cost readings`.

### 9.5 Branches of `commit` not hit on page 15

Worth knowing, because they are what you will be stepping through on a hard page:

* **Backward recovery** (`span.py:237`). The label names a boundary *behind* the
  cursor (`require_end < entry`), so the reading over-ran. It withdraws every commit
  past that boundary and rewinds. This stops words being placed twice.
* **Calibration retry** (`span.py:265`). The stretch holds constrained blobs, and no
  reading reaches the ornament. Every *calibration* lock in the stretch is released
  (`locked_role = None`), the stretch is replayed from its start (`replay`), and the
  released labels are reported as `released_locks`. They get the `released-lock`
  flag. Human locks are never released. If that still fails, the result is
  `constraint-conflict`.
* **Budget.** More than `MAX_LIVE_STATES = 4096` live states. With no constraint in
  the stretch, it commits early (`commit(None, …)`) and carries on. With a constraint,
  it waits for the ornament and fails there.
* **Missed boundary.** No final state sits on `require_end`. `_settle` falls back to
  the cheapest final anyway, marked `missed` → `aya-boundary-missed`. A plausible cut
  a reviewer can nudge beats no cut.

### 9.6 `_to_lines` — split the commits back into lines

[`span.py:449`](../backend/core/word_boundary/span.py). A word never crosses a line,
so each group belongs to exactly one line: `by_ident[group[0]][0]` says which. For
each line it collects `word_indices` and `groups` (now as labels), the costs, and its
concerns:

* the commit missed its ornament → `aya-boundary-missed`
* any word off its PAW count → `N word(s) off-count`
* a tie → `2 equal-cost readings`
* `_ijam_ok` → `_required_marks_present`: for each word, are there at least as many
  *left-out* blobs above and below the line, inside the word's span, as it has dot
  groups? If not → `i'jam short` (`, alternatives discarded` when the tie mask was
  set). This only reports; it never changes the reading.

No concern → `exact`, otherwise `scored`. A line with ink but no word is
`unresolved` / `no-parse`, never `exact`.

Reading 1's result: 10 exact, 5 scored. Lines 4, 9 and 10 have
`2 equal-cost readings`. **Lines 5 and 6 have `2 equal-cost readings; i'jam short,
alternatives discarded`**. Keep that in mind for §12.

### 9.7 Back in `detect_prepared`: roles, safety nets, boxes

* `apply_parse_roles` ([`alignment.py:375`](../backend/core/word_boundary/alignment.py))
  sets each blob's role. A locked blob takes its lock. A blob in a committed stretch
  is `body` if it is in a group and `mark` otherwise. Anything else falls back to its
  preferred role.
* There are three safety nets, none triggered on page 15:
  * `words-exhausted`: the cursor reached the end of the stream while lines still
    hold ink. That is drift.
  * `unconsumed-text-span`: the stream did not reach its last word. The last line's
    cuts are withdrawn rather than report a reading of an incomplete span.
  * Any locked body left unplaced → `constraint-conflict`.
* `_line_result` → `build_line_boxes` ([`alignment.py:398`](../backend/core/word_boundary/alignment.py)).
  `attach_marks` gives every mark to the body under its centre (or the nearest body,
  with a 10,000 penalty if none contains it). A word's box spans its bodies **and**
  those marks (your 2026-09-27 rule). This is where the tight crop is undone:
  `+offset_x/+offset_y`, once.

  ```python
  WordBox(index=0, text="قُلْ", aya="2:94", word_id=1594, expected_paws=1,
          components=[35], x=1275, y=5, w=60, h=106, end_x=1275)
  # h=106: from the damma (#1, tight y=0) down to the ق's tail. Marks of #35 → [36, 1, 13]
  ```

`WordBoundaryResult(lines=[15 WordLine], words_consumed=123, complete=True)`.

---

## 10. Stop 9 — back in `_read`: `_apply_outcome`, the engine's answer as a draft

Still in `_read` ([`calibration.py:1084`](../backend/api/services/calibration.py)):

```python
overrides = {word_id: snapshot_id for every word a hand dragged}       → {} here
placed    = every word id the reading put on ANY line                  → all 123
for row, outcome, ink, cut in zip(rows, aligned.lines, inks, cut_by_row):
    if row.get("approved"): continue          # a confirmed neighbour is never rewritten
    fresh = deepcopy(row); _apply_outcome(fresh, outcome, ink, cut, original, overrides, units, placed)
```

[`_apply_outcome`, `calibration.py:1352`](../backend/api/services/calibration.py),
for line 1:

```
1. owners: each body label → its word, from outcome.words[i].components
            35 → 1594 (قُلْ),  41, 56 → 1595 (إِن), …
2. marks follow their body: attach_marks(ink) → 36, 1, 13 → 1594
3. for each blob dict:
     role            ← component.role (unless a person set it explicitly)
     subtype         cleared on a body (unless a person typed it)
     allocations     [{"word_id": owner, "paws": 1 if body else 0}]   (unless a person decided)
     decision_source "human" | "calibration" (locked so) | "search"
     attention       _attention(...)   — see below
4. words: per WordBox → edges from its OWN ink, in page coords (_edges_from_ink):
     {"word_id": 1594, "text": "قُلْ", "aya": "2:94", "expected_paws": 1,
      "start_x": 1908, "end_x": 1848, "override": False, "shared": False}
     start_x = the RIGHT edge (bigger number); end_x = the left edge.
     A hand-dragged word keeps its edges (override); a word dragged on another line is skipped.
5. _fit_words(row): widen any box that leaves its word's own ink outside.
6. status/reason ← outcome's ("partial"/"preview-kept-missing-words" if a word was kept unplaced)
```

Before and after, for line 1's first blobs:

```
 blob 35  role body→body   allocations []→[{1594, paws 1}]   decision_source search
 blob 36  role mark→mark   allocations []→[{1594, paws 0}]
 blob 1   role mark→mark   allocations []→[{1594, paws 0}]
 blob 13  role mark→mark   allocations []→[{1594, paws 0}]
 blob 63  role mark→mark   allocations []→[{1595, paws 0}]   (the kasra of إِن)
```

**`_attention`** ([`calibration.py:1656`](../backend/api/services/calibration.py))
lists the reasons a blob deserves a look. These are signals, not verdicts:

```
 uncertain                   body_score in 6..9 (the contested band)      ┐ answered (dropped) when the
 search-override             the reading's role ≠ the first guess        │ proposal agrees with the
 ambiguous                   a tied reading gave it the other role       ┘ role, or the text decided
 calibration-disagreement    proposal ≠ role
 span-boundary               crosses the span's edge
 constraint-conflict / released-lock
```

Then `_changed_ayas` / `_within` limit a *preview* to the ayat edited. A processing
run passes `affected_ayas=None`, so every row takes its new reading whole.
`result["issues"]` collects the non-exact lines' reasons:

```
issues = ["2 equal-cost readings", "2 equal-cost readings; i'jam short, alternatives discarded"]
```

---

## 11. Stop 10 — `prediction = _record(document, context=True)`

This is a deep copy of the document as reading 1 left it, before the text, the
learning or a person touched it. It is written as the `processed` revision in §17,
and `evaluation` compares the eventual confirmation against it. That is how you can
later measure *what the engine got wrong*.

---

## 12. Stop 11 — the text speaks: `_place_text_locks`

Only for a Hafs mushaf (`_follows_text`). [`calibration.py:1488`](../backend/api/services/calibration.py).

The problem: `بِهِۦ`, `لَهُۥ`. The small waw ۥ and small ya ۦ sit **on** the writing
line, so `analyse_line` calls them bodies. The engine then has one blob too many and
spends it somewhere. The examples cannot help, because squeezed to 32×32 a small waw
*is* a waw. But the text names every one of them.

`_small_letters(row, references)` ([`calibration.py:1525`](../backend/api/services/calibration.py)),
for each word on the row whose text has a line mark (`line_marks(text)`):

```
 pieces = paws(text)                  the word's pieces, right to left
 own    = the word's bodies in this reading, right to left
 anchor = own[piece holding the letter before the small one]
 candidate = the first on-line ink LEFT of the anchor
 accept if  area ≤ 0.4 × median body area  and  gap ≤ band height
 else the "other way round" case: the word's own last body is small and the body to its
      right belongs to another word → that body was the small letter
 skip if a person said it is a letter, or gave it to another word
```

Real result, reading 1:

```
 line 5  blob 63 → word 1636   (بِمُزَحْزِحِهِۦ)    was role "body"
 line 7  blob 60 → word 1651                       was "body"
 line 9  blob 45 → word 1668                       was "body"
 line 12 blob 61 → word 1688                       was "body"
 moved = {"2:96", "2:97", "2:98", "2:100"}       the ayat whose reading must change
```

Each blob gets `text_role="mark"` and `text_word=<id>`. In the engine trace of
reading 1 you can see what went wrong on line 5:

```
word 42  بِمُزَحْزِحِهِۦ  blobs [59, 61, 55]
word 43  مِنَ            blobs [63]          ← the small ya of word 42, spent as the next word
```

The word مِنَ was placed at the end of line 5 using the previous word's small ya. On
line 6 every word then took its neighbour's ink, and that is the
`i'jam short, alternatives discarded` on lines 5 and 6.

---

## 13. Stop 12 — the learning re-read: `align_document(calibration_locks=True)`

`experimental` is on, so:

```python
document["profile"]["mode"] = "experimental"
document = align_document(mushaf, document, calibration_locks=True)     # text_locks defaults True
```

(Had learning been off, `elif reread:` would run `align_document(mushaf, document)`
with only the text locks.)

This time `_constrain` locks, per blob:

```
 text_role set                      → locked_role "mark", lock_source "calibration"   (the 4 above)
 proposed_role set (learning on)    → locked_role = proposal,  "calibration"
 → 598 marks + 151 bodies locked, of 942 blobs
```

A locked blob has only one move in `_advance`. A locked mark skips `_with_body`, and a
locked body skips `_with_mark`. So the search is smaller: **peak 1,260 live states →
411**, and **4.17 s → 0.63 s**.

What changed in the reading:

| commit | reading 1 | reading 2 |
|---|---|---|
| words 26..51 (lines 4–6) | cost 296, **2 readings** | cost **309**, 1 reading |
| words 69..81 (lines 9–10) | cost 127, **2 readings** | cost **132**, 1 reading |

```
 reading 1:  line 5 = words 33..43 (11)    line 6 = words 44..51 (8)
 reading 2:  line 5 = words 33..42 (10)    line 6 = words 43..51 (9)     ← مِنَ moved to line 6

 reading 2, line 6:
   word 43  مِنَ          blobs [47]
   word 44  ٱلْعَذَابِ    blobs [39, 33, 36, 53]
   word 45  أَن           blobs [16, 49]
   word 46  يُعَمَّرَ     blobs [51]
```

The cost went *up* (296 → 309). The locks forced readings the free search found
dearer, but those readings agree with the text and with the examples. **All 15 lines
are now `exact`**, and `issues = []`.

Inside this `align_document`, `_place_text_locks` runs again on the new reading. It
found the four small letters again, plus one more on line 9 (blob 46 → word 1667)
that it had not found in reading 1's words. Every one is already a mark of its
own word, so `moved = []` and there is **no third reading**. Each such blob is
finished by `_finish_text_lock`: `decision_source "text"`, its engine doubts dropped,
`subtype "smallLetter"`, `subtype_source "text"`.

---

## 14. Stop 13 — what people already decided: `_carry_decisions`, `_keep_legacy_edges`

[`calibration.py:727`](../backend/api/services/calibration.py). For each row whose
`snapshot_id` was in the previous draft (same snapshot means same pixels and the same
blob ids), it copies back:

* `exception`, `subtype`, `subtype_explicit`, always;
* an explicit role → `role`, `explicit`, `decision_source "human"`;
* explicit allocations (dropping word ids outside the new span);
* dragged words (`override`) → `row["words"]`.

If anything was carried, the page is read once more so that the reading respects it.

Page 15's revision-4 draft had no decisions on it (it was processed by the batch and
never opened). So `carried = False`, there was no extra reading, and
`_hand_made(...)` found **0 lines** with cuts corrected in the old word editor.
*(Not hit.)* If there had been some, `_overlay_cuts` would put each cut on the row as
an `override` and hand the undecided ink to the word whose cut it sits in.

---

## 15. Stop 14 — the text types the marks: `_apply_text_types`

[`calibration.py:2191`](../backend/api/services/calibration.py) →
[`calibration_marks.check_rows`](../backend/api/services/calibration_marks.py) →
[`mark_check.check_word`](../backend/core/word_boundary/mark_check.py).

```
_page_marks(rows)           every mark on the page with its 1,030-number descriptor → 691 marks
build_type_index(...)       typed marks of every OTHER confirmed page + those typed here
                            → 9,184 groups, 24 types
check_rows(rows, stream, marks, index, ijam=True)
   per word: text_marks(text)    what the text says this word carries, letter by letter
             letter_positions    where each letter roughly sits (spread over its bodies)
             FoundMark per mark  x, lane (above/line/below), matcher scores per type
             check_word          Hungarian assignment: ink marks ↔ text slots, least cost
apply_text_types(rows, checks)   untyped marks the text SURELY names get that type
```

One real word, قُلْ (word 1594), on line 1:

```
 text_marks("قُلْ") →
     ijamDot  above  letter 0 (ق)  pieces 2       (two dots, may print as 1 or 2 blobs)
     damma    above  letter 0
     sukun    above  letter 1 (ل)
 ink marks the reading gave it → 36, 1, 13
 assignment cost = lane mismatch + 0.6 × |x − letter's x| / word width + how unlike the type
 → types {36: "ijamDot", 1: "damma", 13: "sukun"}   missing [] extra []   clean ✓
 sure = {36, 1, 13}   (the word fits, and the examples are not sure of another type)
```

A type the text names is **sure** only if the word is clean (nothing missing, nothing
extra) and the matcher does not prefer another type by more than 0.2. Even then,
`check_rows` takes it back if the examples are *sure* of a different type they know.
Page 15: **123 words checked, 120 clean, 654 of 691 marks sure → 650 typed by the
text** (`subtype_source "text"`, `subtype_explicit False`). The other 4 sure ones are
the small letters, which their lock already typed.

---

## 16. Stop 15 — the two side records: `_shown`, `_frozen_record`

* **`_shown(document)`** ([`calibration.py:813`](../backend/api/services/calibration.py))
  is a compact copy of the draft as the reviewer will first see it: each blob's role,
  subtype, `by_text`, `text_lock`, `look`, and each word's fitted edges.
  `manage.py calibration_report` diffs the confirmation against it to say what the
  reviewer changed. Page 15: **6 blobs ask for a look**.
* **`_frozen_record`** ([`calibration.py:937`](../backend/api/services/calibration.py))
  runs the *frozen* engine on its old path for comparison:
  `word_inputs.prepare_engine_input` → `line_images.line_images` (re-renders the PDF,
  cuts the first/last line at the aya boundary, records `origin_x`) → `detect_words`.
  That call measures every line afresh (`analyse_line`, `split_symbols`,
  `split_separators`), which is where the ink trace in `debug_calibrate.log` comes
  from, and then calls the same `detect_prepared`. It keeps this page's lines in page
  coordinates (`box.right + origin_x`). It is wrapped in `try/except`: an evaluation
  aid must never cost you the page. On page 15 it matches reading 1 line for line
  (10 exact, 5 scored), as it should: no locks, same pixels.

`cancelled()` is checked one last time here.

---

## 17. Stop 16 — the save

[`calibration.py:703`](../backend/api/services/calibration.py)

```python
with transaction.atomic():
    review, _ = CalibrationReview.objects.select_for_update().get_or_create(mushaf=mushaf, page_number=15)
    if review.revision != expected_revision:      # 4 == 4. Someone saved meanwhile → 409 stale_revision
        _refuse("stale_revision")
    review.revision += 1                          # → 5
    document["legacy_lines"] = review.payload.get("legacy_lines", [])
    document["processed_revision"] = 5            # the batch's "touched?" test compares to this
    review.payload = document                     # THE DRAFT — what GET …/calibration returns
    review.save(...)
    CalibrationRevision.objects.create(review=review, number=5, kind=PROCESSED,
        payload={**prediction, "frozen": frozen, "shown": shown})       # immutable
    activity.emit(mushaf, CALIBRATION_PROCESSED, {...})
return True
```

`select_for_update` plus the revision check is an optimistic lock, the same idea as an
ETag. The draft is mutable (every save overwrites `payload`). Revisions are immutable,
and only three kinds are written: `processed` (this one), each confirmation, and
archived hand cuts.

What landed, for the first row:

```python
{"line_number": 1, "status": "exact", "reason": None,
 "words": [{"word_id": 1594, "text": "قُلْ", "start_x": 1908, "end_x": 1848, …}, …10 words],
 "blobs": [ …,
   {"id": 36, "role": "mark", "subtype": "ijamDot", "subtype_source": "text",
    "decision_source": "calibration",      # it was locked by its proposal in reading 2
    "proposal": {"role": "mark", "confidence": 0.3302, "reasons": []},
    "allocations": [{"word_id": 1594, "paws": 0}], "attention": [], …}, …]}
```

The page's final draft has 15 lines, all exact, with 10/7/9/7/10/9/10/7/7/7/8/8/8/9/7
words: 123 in total.

---

## 18. Stop 17 — the job settles, the editor reloads

Back in `start_page`'s `run`: `jobs.settle(job.id, COMPLETED, pages_saved=1)`. The
browser's next poll sees a settled job, and `CalibrationEditor` invalidates the page's
query. That fetches:

```
GET /api/mushafs/{id}/pages/15/calibration  → page_calibration → calibration_service.page_document
```

`page_document` ([`calibration.py:385`](../backend/api/services/calibration.py)) deep
copies the payload and runs `_fit_words` on every row. It adds `settings` and `words`
(the stored `LineWord` cuts, through `word_coordinates.page_words`) and the snapshot
image URLs. It then computes `stale` (the snapshots no longer match the lines) and
`context_stale` (a neighbour changed). The result goes out as a plain `JsonResponse`;
it is not validated by a schema, because a page holds ~1,000 blobs.

---

## 19. Where the 105 seconds went

| Phase | seconds | why |
|---|---|---|
| `profile_for` (examples from pages 1–14) | ~9 | descriptors for every confirmed line, from their rasters. Cached after. |
| 15 × (`snapshot_line` + `_blank_row`) | ~83 | snapshots were reused, so nearly all of this is `blob_features` + `predict_prepared` per blob |
| reading 1 (no locks) | ~4.5 | peak 1,260 live states |
| `_place_text_locks` + reading 2 (locks) | ~1 | peak 411 states |
| `_apply_text_types` | ~2.2 | type index + Hungarian per word |
| `_frozen_record` | ~5 | re-renders the page and re-measures every line |
| save | <0.2 | |

If calibration processing ever needs to be faster, the place is the proposal loop in
`_blank_row`, not the DP.

---

## 20. Cheat sheet: a blob dict, field by field

| Field | Set by | Meaning |
|---|---|---|
| `id` | snapshot | CC label, unique within the line |
| `x, y, w, h, area` | snapshot | page coordinates |
| `body_score` | `analyse_line` | 0..14 evidence of a letter body |
| `initial_role` | `_blank_row` | the band's first guess, never changed |
| `role` | `_apply_outcome` | what the reading made of it (or a person) |
| `explicit` | a person | the role is a hard lock |
| `ownership_explicit` | a person | the allocations are hard |
| `allocations` | `_apply_outcome` / a person | `[{word_id, paws}]`, paws 0 for a mark |
| `proposal`, `proposed_role` | `_blank_row` | calibration's 5-NN answer, or the reasons it abstained |
| `decision_source` | `_apply_outcome` | human / calibration / text / search |
| `text_role`, `text_word` | `_place_text_locks` | the text says this is a small letter of that word |
| `subtype`, `subtype_source`, `subtype_explicit` | person / text / examples | the mark's type |
| `attention` | `_attention` | why the editor asks for a look |
| `exception` | a person | mixed / broken / fused / uncertain |

And a word dict: `word_id, text, aya, expected_paws, start_x (RIGHT edge), end_x (left
edge), override (dragged), shared (a fused unit's member)`.

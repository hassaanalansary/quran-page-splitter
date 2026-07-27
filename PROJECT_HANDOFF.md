# Quran Page Splitter — Project Handoff

> **⚠ 2026-07 update — read `.claude` memory `django-refactor-state` first.** Since this
> doc was written: reference-data **seed refactor** (`reference_data.json`, qiraat now
> seeded — `a53db7c`), a large **frontend UX overhaul** (guide modals + coach on each
> canvas, custom guided tour, pinned `StatusLine`, `InfoTip`s, letterbox-aware crop,
> "variable area" rename, always-RTL page nav, zoom-to-pointer) committed page-by-page
> (`39d2a43`→`34aa745`). **The "Frontend flow" / component sections below predate that
> overhaul — trust `git log` + current code.** Backend architecture/API/data-model here
> is still accurate.
>
> Definitive state-of-the-project reference. Backend **and** frontend are built —
> the details landing page, the whole-mushaf **Review** editor, and the **Finalize**
> line-cut editor. Branch: `refactor/django-backend`. Green: backend 121 tests / mypy /
> ruff; frontend tsc / eslint / build.

---

## 1. What this is (purpose)

A **local desktop-style tool** that turns scanned/printed **Mushaf (Quran) pages**
(uploaded as a **PDF**) into assets for **image-based Mushaf apps** (downstream
consumer: "mushaf-imad"). Two outputs:

1. **Per-aya coordinates** — bounding box of each aya on each page (for
   highlighting, audio sync, verse navigation). Downloadable as one JSON document
   (`GET /api/mushafs/{id}/coordinates`, schema `aya-bbox/v1`).
2. **Transparent line PNGs** — each page cut into individual line images so an app
   can lay lines out responsively (scale to width, fill height) instead of
   stretching one full-page image.

Why images not fonts: printed calligraphy is context-dependent and justified in
ways text engines can't reproduce. Images preserve the exact printed layout.

---

## 2. Architecture

- **Backend**: Django 6 + **Django Ninja** REST API, SQLite, `pymupdf` (render),
  `opencv`/`numpy`/`pillow` (CV engine). Package-managed by **uv**.
- **Frontend**: React 19 + Vite 7, **TanStack Router** (file-based) + **React
  Query**, Tailwind 4, Radix/shadcn UI, sonner toasts. Package-managed by **npm**.
- **Serving**: single-origin in production — Django serves the built SPA
  (`frontend/dist`) + `/api` + `/media` (`backend/config/spa.py`). In dev, Vite
  (`:5173`) proxies `/api` + `/media` → Django (`:8000`).
- **Layering (enforced)**: view (schema) → service (ORM + orchestration) → `core`
  (pure CV engine, no Django/ORM). Views never touch the ORM; `core` never imports
  Django.

Multi-mushaf, DB-backed: every processed mushaf persists; nothing is wiped between
runs. Pages are **rendered on demand** from the stored PDF (never stored as files;
only a small cover thumbnail is cached — see Mushaf.thumbnail). Every meaningful
mutation also writes an **ActivityEvent** (per-mushaf audit feed on the details page).

---

## 3. Repo layout & dev commands

```
backend/
  config/     settings.py (.env via django-environ), urls.py (/admin, /api, /media, SPA catch-all), spa.py, wsgi.py
  api/
    api.py    NinjaAPI + routers;  models.py;  common.py (RectSchema);  validators.py;  admin.py
    views/    counting_systems, qiraat, suras, mushafs, pages, processing, finalize  (THIN; Ninja schemas co-located)
    services/ pdf, mushaf, coordinates, editing, export, processing, suras, qiraat, counting_system, activity
    management/commands/seed_suras.py
    migrations/ 0001..0009
    tests/    per-area + helpers.py (make_pdf_bytes, make_png_bytes, MediaTestCase, bare_mushaf)
  core/       pure engine: line_detector, aya_separator, page_processor, pipeline, builder,
              coordinate_exporter, sura_header, cut_review, template_matching, quran_metadata, image_utils, …
    data/     reference_data.json  (committed snapshot: counting systems, qiraat, suras, aya counts — seeded)
frontend/
  src/routes/       index (home), mushafs.$mushafId (workspace layout + step nav),
                    mushafs.$mushafId.index (DETAILS landing page), .setup .templates .process .review .finalize
  src/components/
    app/            Panel (Aside/PanelCard/Section/Field/Hint), CreateMushafDialog, MushafHeader (shared top bar)
    app/details/    DetailsRail, OverviewTab, PagesTab, RunsTab, ExportTab, SettingsTab, helpers
    canvas/         PageStage, PageCanvas, ChevronNav, PageJump, ZoomControl, ToolToggle, RectInputs, PageRail,
                    CropPreview, TemplatePreview, FilmstripViewer, CroppableImage, ReviewCanvas, ReviewEditCanvas, FinalizeCanvas
    ui/             shadcn components (Radix)
  src/lib/api/      http, types, mushafs, pages, suras, qiraat, processing, queries (React Query hooks + queryKeys)
  src/lib/          image (cropUrlToBlob), templateDraft (in-memory template-capture store)
```

```bash
# backend (from backend/)
uv sync
cp .env.dist .env                        # SECRET_KEY etc.; a dev default is built in
uv run python manage.py migrate
uv run python manage.py seed_suras       # reference data (see §4)
uv run python manage.py runserver 8000   # API at /api, docs at /api/docs

uv run ruff check .
uv run python -m mypy .                   # invoke via `python -m` (mypy.EXE fails on the space in the path)
uv run python manage.py test api          # builds schema from models; migrations disabled under test

# frontend (from frontend/)
npm install
npm run dev        # Vite :5173 (proxies /api,/media → :8000)
npm run build      # → frontend/dist (what Django serves in prod)
npx tsc --noEmit ; npx eslint .
```

Green baseline (last verified 2026-07-05): **119 backend tests, ruff, mypy (clean —
80 source files); frontend tsc + eslint (0 errors) + build.**

---

## 4. Data model (`backend/api/models.py`)

`mushaf → page → line → segment`, plus `template`, `processing_run`, `erase_stroke`,
`activity_event`, and reference tables. `BaseModel` gives UUID PK + timestamps
(reference tables use int PKs). Media: PDFs → `media/mushafs/`, templates →
`media/templates/`, thumbnails → `media/thumbnails/`, line PNGs → `media/lines/`.

- **CountingSystem** (int PK): `name`, `name_arabic`. The schools of aya numbering
  (kufi, basri, dimashqi, makki, madani-first, madani-last).
- **Qiraa** (int PK, `db_table="qiraa"`): `name`, `name_arabic`, `description`,
  `counting_system`(FK). ~20 qiraat seeded/managed by the user; each follows one
  counting system (Hafs → kufi).
- **Sura** (int PK): `number`, `name_arabic`, `transliteration`.
- **SuraAyaCount**: `sura`(FK), `counting_system`(FK), `count`. Unique
  `(sura, counting_system)`. Aya counts are **per counting system** (not per qiraa).
- **Mushaf**: `name`(unique), `pdf_file`, **`pdf_original_name`** (filename as
  uploaded; the stored file is renamed to its hash), `pdf_sha256`, `pdf_page_count`,
  `first_quran_pdf_page`, `last_quran_pdf_page`, `qiraa`(FK, SET_NULL),
  `thumbnail`(ImageField — cover render of physical page 1, for the home grid).
- **Template**: `mushaf`(FK), `type`(`sura_header`|`aya_separator`), `image`,
  `ignore_rects`(JSON `{x,y,w,h}` relative to the template crop, or `{}`). Unique
  `(mushaf, type)`.
- **ProcessingRun**: `mushaf`(FK), `settings`(JSON, incl. bounds), `page_range_start/end`,
  `status`(`running`|`completed`|`aborted_line_detection`|`cancelled`|`error`|`interrupted`),
  `abort_info` (JSON string, engine abort detail: `page_index` is 1-based into the batch →
  aborted logical page = `page_range_start + page_index - 1`).
  The row is created **up front** as `running` and settled at the end, so each page can be
  persisted as it lands; a row left `running` by a crash is marked `interrupted` by the next
  run on that mushaf (`services/processing._settle_stale_runs`).
- **Page**: `mushaf`(FK), `page_number`(logical), `source_pdf_page`(null),
  `last_run`(FK null), `bbox_x/y/w/h`, `reviewed`(bool — set True on review-save,
  reset False on (re)process). A Page row exists **iff** the page has data.
- **Line**: `page`(FK), `line_number`, `type`(`text`|`sura_header`|`besmella`),
  `sura`(FK null), `line_png`(set on export), `bbox_x/y/w/h`.
- **Segment**: `line`(FK), `segment_order`(1-based, right→left), `bbox_x`, `bbox_w`
  (y/h inherited from line), `has_separator`, `aya_number`(derived).
- **EraseStroke**: `line`(FK), `brush_size`, `points`(JSON `[[x,y],…]`).
- **ActivityEvent**: `mushaf`(FK), `type`(`mushaf_created`|`bounds_set`|
  `template_saved`|`run_finished`|`review_saved`|`lines_exported`), `payload`(JSON).
  Emitted by the services at their commit points (`services/activity.py`):
  create, bounds actually changed, template upsert, run persisted (with
  `run_number`, `pages_saved`, `abort_page`), **first** review of a page since its
  last processing, line export. Feeds the details-page Activity panel.

**Reference-data seeding** (`services/suras.py` → `seed_suras`): upserts **counting
systems, qiraat, suras and per-counting-system aya counts** from one committed snapshot,
**`backend/api/data/reference_data.json`**, each row by its natural key (counting
systems/qiraat by `name`, suras by `number`; `update_or_create` bootstraps a fresh/test
DB, never clobbers existing rows). Regenerate it from a filled DB with
**`python manage.py export_reference_data`**. This is what seeds the qiraat the mushaf
picker needs.

---

## 5. API reference (contract the frontend codes against)

Base `/api` (Ninja). Interactive docs `/api/docs`. UUIDs are strings.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/counting-systems` | `[{name, name_arabic}]`, case-insensitive name order |
| GET | `/api/qiraat?lang=ar` | `[{name, counting_system}]` (labels switch to Arabic with `lang=ar`), case-insensitive name order |
| GET | `/api/suras?qiraa=hafs` | `[{number, name_arabic, transliteration, aya_count}]`; qiraa lookup is **case-insensitive**, aya_count from the qiraa's counting system |
| GET | `/api/mushafs?qiraa=…` | `[MushafOut]` newest-first (annotated counts, `thumbnail_url`); optional case-insensitive qiraa filter |
| POST | `/api/mushafs` | multipart `pdf,name,qiraa,first_quran_pdf_page,last_quran_pdf_page` → `201 {mushaf, warnings:{duplicate_file}}`; dup name → 409; captures `pdf_original_name`, generates the cover thumbnail |
| GET | `/api/mushafs/{id}` | **`MushafDetailOut`** = MushafOut + `counting_system{name,name_arabic,total_ayat}\|null`, `pdf_url`, `pdf_file_size`, `pdf_original_name` |
| PATCH | `/api/mushafs/{id}` | name / qiraa / bounds (bounds locked once pages exist → 409) |
| DELETE | `/api/mushafs/{id}` | `204` |
| GET | `/api/mushafs/{id}/stats` | `{lines_cut, segments, ayat_found, sura_headers, besmella_lines, exported_pngs}` (ayat_found = segments with `has_separator`) |
| GET | `/api/mushafs/{id}/runs` | `[{id, run_number(oldest=1), created_at, status, page_range_start/end, pages_saved, settings, abort_info\|null}]`, newest first |
| GET | `/api/mushafs/{id}/activity?limit=50` | `[{id, type, payload, created_at}]`, newest first (limit clamped 1..200) |
| GET | `/api/mushafs/{id}/coordinates` | aya-coordinates JSON **attachment**: `{schema:"aya-bbox/v1", mushaf:{id,name,qiraa,pages}, pages:[{page, ayas:[{sura, aya, rects:[{x,y,w,h}]}]}]}` — rects per aya grouped across segments/lines in reading order |
| POST | `/api/mushafs/{id}/thumbnail` | regenerate the cover thumbnail → `MushafDetailOut` |
| GET | `/api/mushafs/{id}/templates` | `[TemplateOut]` (rehydrate the editor on revisit) |
| PUT | `/api/mushafs/{id}/templates/{type}` | multipart; **`image` optional** (omit to update only the ignore region); `ignore_x/y/w/h` all-or-nothing → `TemplateOut {id,type,image_url,ignore_rects}` |
| GET | `/api/mushafs/{id}/pages/{n}/image` | `image/png` — logical page `n`, rendered on demand |
| GET | `/api/mushafs/{id}/pages` | **extended summaries**: `[{page_number, reviewed, source_pdf_page(resolved), lines, ayat, segments, has_header, suras:[{number,transliteration,name_arabic}]}]` |
| GET / POST | `/api/mushafs/{id}/pages/{n}` | `PageDataOut` (empty if unprocessed; each line carries `erase_strokes`; `bbox` = the page's text column via `coordinates.page_column`) / save (aya recomputed server-side; first save since processing emits `review_saved`) |
| GET | `/api/mushafs/{id}/review-data` | whole-document review payload: `{start:{sura,aya}, pages:[{…PageDataOut, reviewed, run_start:{sura,aya}\|null}]}`. `start` = logical **page 1's** entry state; `run_start` = each page's processing-run start (the island seed; null for manual pages) |
| POST | `/api/mushafs/{id}/pages/bulk` | `{pages:[{page_number,bbox,lines}], reviewed_pages:[int]}` → one transaction: rewrites pages (**creates** rows for manual pages; does NOT flip reviewed), flags `reviewed_pages`; **stores sura/aya VERBATIM — no `renumber_from` (the client owns numbering)**; range `review_saved` payload `{page_start,page_end,count}`; returns fresh `review-data` |
| POST | `/api/mushafs/{id}/pages/{n}/finalize` | cut layer `{lines:[{line_number, bbox_override?, erase_strokes[]}]}` → persists erase strokes + a **Y/H-only** line bbox override (X/W untouched = content extent from segments); returns `PageDataOut` |
| POST | `/api/mushafs/{id}/pages/{n}/export-lines` | writes transparent line PNGs, each cropped to the page **column** (`coordinates.page_column`: the real crop box, else the union of line boxes for manual pages) → white→transparent → erase strokes punched out |
| POST | `/api/mushafs/{id}/process` | **202** — start the CV pipeline over a page range in a background job and return it at once (`JobOut`). 409 if this mushaf already has a run in flight; 400 for a bad range / missing templates (checked synchronously, since nothing can be rejected once the job is registered) |
| GET | `/api/mushafs/{id}/process/job` | `{job: JobOut\|null}` — the mushaf's current or most recent run. The client's poll; keyed by mushaf, so a reload finds a run in flight |
| POST | `/api/mushafs/{id}/process/cancel` | ask the running job to stop at the next page boundary (404 if none). Returns immediately; pages already written stay written |

`MushafOut = {id, name, qiraa, pdf_page_count, first_quran_pdf_page,
last_quran_pdf_page, logical_page_count, processed_page_count,
reviewed_page_count, thumbnail_url, created_at, updated_at}`.

**Media URLs**: use the `_media_url()` helper (leading-slash absolute path) —
`MEDIA_URL="media/"` makes raw `FieldFile.url` relative, which breaks in the SPA.

---

## 6. Frontend — details landing page + the 5-step flow

Routing: **Home → Mushaf Details (`/mushafs/:id`) → Setup → Templates → Process →
Review → Finalize**. Home cards open the **details page**; the create dialog still
drops a fresh mushaf straight into Setup. Every mushaf page (the details hub + the five
steps) shares one top bar — **`MushafHeader`** (`components/app/MushafHeader.tsx`):
breadcrumb → hub, status pill, a **status-aware 5-step nav** (done ✓ / current / to-do),
and Continue / PDF / JSON actions. `mushafs.$mushafId.tsx` (workspace layout) renders it
for the step routes and passes the index child through as a bare `<Outlet/>`; the details
hub renders `MushafHeader` itself.

- **Home** (`index.tsx`): thumbnail-card grid (cover from `thumbnail_url`), status
  badge via `mushafStatus()` — `empty`/`partial`/`processed`/`completed` (completed =
  all pages reviewed), + a dashed add-card → `CreateMushafDialog` (real qiraa
  dropdown fed by `GET /api/qiraat`).
- **Details** (`mushafs.$mushafId.index.tsx` + `components/app/details/`): the
  chosen "enhanced Cockpit" Claude-Design layout —
  - **Chrome**: the shared **`MushafHeader`** (above) — breadcrumb, status pill, 5-step
    nav, **Continue →** CTA (derives the next step: Templates → Process → Review(first
    unreviewed page, deep-linked `?page=N`) → Finalize; fresh mushaf → Setup), `PDF ↗`
    (`pdf_url`), `JSON ↓` (coordinates download).
  - **Rail** (282px): cover, name, qiraa + counting (`Kufan · 6236`),
    processed/reviewed progress bars, ayat/lines/PNGs stat trio, template
    thumbnails (+ Edit →), Record kv (range, logical pages, original filename,
    size, uploaded, short id), per-page **coverage map**.
  - **Tabs**: `Overview` (clickable 5-cell pipeline strip, Activity feed from
    `/activity`, "Detected so far" stats, abort-warning w/ Resume), `Pages`
    (filter chips, client-sortable table w/ Arabic sura names + header badge,
    totals footer, Open → Review `?page=N`), `Runs` (cards: settings kv, outcome
    bar, abort_info, Resume), `Export` ("Export all lines" loops
    `POST export-lines` with progress; reviewed-only variant; JSON download card;
    review-completeness warning), `Settings` (name/qiraa PATCH form, Quran range
    locked-once-processed, thumbnail Regenerate, danger zone: Reprocess = link to
    Process, Delete).
  - Derivations live in `components/app/details/helpers.ts` (pipeline states,
    continue target, activity formatting, run abort page).
- **Setup** (`.setup`): the **`FilmstripViewer`** (peeking-neighbour filmstrip, whoosh
  jumps, floating page-jump, compact page rail, auto-advance to last after marking
  first). Marks `first_quran_pdf_page`/`last_quran_pdf_page` → PATCH. Bounds lock once
  processed.
- **Templates** (`.templates`): 3 columns — **`PageStage`** canvas | **center
  workspace** (`TemplatePreview` large preview + `RectInputs` X/Y/W/H + Capture button)
  | **per-target cards** (each target its own card: thumbnail, saved indicator, Re-crop,
  Add/Edit-ignore, Save). Fetches saved templates (`useTemplates`) and merges; captures
  persist across in-app navigation via `lib/templateDraft.ts`. Ignore preview shows the
  captured parent template with a **red box** + validation.
- **Process** (`.process`): `PageStage` (crop `bounds`) | panel of collapsible
  `Section`s (Bounds w/ `CropPreview`+`RectInputs`, Page range, Starting position with
  the sura/aya selects, Detection settings). **Starts a background job and polls it**
  (`useProcessJob`, 1 s while running) — no client-side chunking: the whole range is one
  pipeline run. Live phase/page readout, a **Stop** button, and one outcome surface for
  completed / aborted / cancelled / failed, each with Resume from `stopped_on_page`.
- **Review** (`.review`, takes `?page=N`): a **whole-mushaf editing session** built on
  **`ReviewEditCanvas`** (interactive: drag/resize line boxes with 8 handles, double-click a
  text line to add an aya separator, drag the red separator bars; ToolToggle/ZoomControl/
  ChevronNav/PageJump/PageRail). Loads once via `GET /review-data` into a client store holding
  **ALL logical pages 1..N** — blank/unprocessable pages are editable (manual processing; saving
  a manual page creates its `Page` row). **The client OWNS numbering** (`lib/review/{model,
  recompute}.ts`): sura/aya are derived per **island** — a page whose previous page has no lines
  is a *gap* that stops propagation, and each island seeds from that page's `run_start` (page 1
  uses `start`), so the first processed page after a gap begins at its processing start (not
  renumbered from 1). Sura headers carry an **editable explicit sura anchor** (dropdown; anchoring
  a header resets the running aya to 1); aya then counts up one per separator — there is no manual
  aya field (add a header to reset, add separators to count). `bulk_save` stores the client's
  numbers **verbatim** (no server renumber). Per-qiraa aya-count overflow warnings. Undo/redo
  (Ctrl+Z/Y, 500 ms coalescing; **history+index are ONE state object** updated functionally, so
  rapid drags can't corrupt the pointer), free page nav, dirty + reviewed-pending tracking,
  `useBlocker` leave-guard. **Mark reviewed → next** is **client-only** (marks the page + its
  ending sura's span reviewed in the store, instant nav — persisted later). **Save changes** is
  **fire-and-forget** (POSTs dirty pages' data + pending review flags, patches the baseline on
  success, never rebuilds the store so in-flight edits survive). The review-data query has its
  **own key** (`["review-data", id]`, `refetchOnWindowFocus:false`) and the store builds **once
  per mushaf** (`builtForRef`) so refetches/invalidations never wipe edits; the canvas image URL
  is un-cache-busted (stable). Right `Aside`: line list (+ add Text/Sura/Besmella) and a
  selected-line editor (type, **sura dropdown** for headers, bbox via `RectInputs`,
  segments/separators merge/remove, delete).
- **Finalize** (`.finalize`, takes `?page=N`): the **`FinalizeCanvas`** line-cut editor.
  Each line is composited **independently** from its own source crop (near-white →
  transparent + its own erase strokes) and **stacked**, so it renders exactly as it
  exports and erasing one line never touches another. Tools: **Select** (drag a line's
  top/bottom edge to trim Y/H — X/W are the shared page column) / **Erase** (hold Shift;
  brush + undo/clear) / **Hand** (hold Space); White / Dark (white-ink) / Grid
  backgrounds; a drag-time **magnifier lens**; Ctrl+Z/Y undo-redo. The route owns the
  editable model + dirty/`useBlocker` guard; **Save cuts** (`finalizePage`, Y/H-only,
  sends the whole page) and **Save & export page** (`exportLines` → thumbnails); bulk
  export stays in the details Export tab. Manual front pages (no crop box) get a derived
  column server-side (`coordinates.page_column`) so they render + export at uniform width.

**Canvas component library** (`components/canvas/`, all reusable): `PageStage`
(zoomable/pannable page + toolbar + `ChevronNav` + `PageJump` + `PageRail`),
`PageCanvas`, `PageRail`, `CropPreview`, `TemplatePreview`, `FilmstripViewer` +
`CroppableImage` (Setup only), `ReviewCanvas` (read-only overlay), `ReviewEditCanvas`
(Review editor), `FinalizeCanvas` (Finalize stacked line-cut editor).

State: React Query for all server state (`lib/api/queries.ts` — `queryKeys`,
`useMushaf(s)` (detail shape), `useTemplates`, `useProcessedPages` (sets) /
`usePageSummaries` (full rows, same cache entry), `useRuns`, `useStats`,
`useActivity`, `useQiraat`, `useSuras`, `usePage`).

Fonts: Outfit (sans) + Syne (display) + **Amiri** (`font-arabic`, for Arabic names
and the ۝ glyph) — loaded in `index.html`, mapped in `styles.css` `@theme`.

---

## 7. Done & verified

- Django serves the SPA single-origin + `/media`; home redesign; page `reviewed` flag.
- Counting-system reference-model refactor (service/seed from `reference_data.json`;
  `/api/suras` correct: Hafs→Kufan 286, Warsh→Madani 285); `GET /api/counting-systems`
  + `GET /api/qiraat` (`lang=ar`) + qiraa filter on the mushaf list.
- Cover thumbnails on the mushaf list (`thumbnail_url`; backfilled) + regenerate endpoint.
- Setup filmstrip; crop steps on a single **zoomable** canvas (select/hand/space tools,
  numeric crop, chevron nav, floating page-jump); Templates rehydrate + large preview +
  per-target cards; compact page rail w/ processed/reviewed indicators on all steps.
- **Qiraa picker** in `CreateMushafDialog` (real dropdown from `/api/qiraat`).
- **Mushaf Details landing page** (2026-07-02, per the Claude-Design "enhanced
  Cockpit" handoff): chrome/rail/5 tabs as in §6, plus the backend that feeds it —
  runs/stats/activity endpoints, ActivityEvent emission, coordinates JSON export,
  extended page summaries, `pdf_original_name` (migration 0009, applied to dev DB).
- **Whole-mushaf Review editor**, **Finalize line-cut editor**, **Runs settings + re-run**,
  and the **unified `MushafHeader`** (2026-07-03..05) — all as described in §6 — plus the
  **core besmella / sura-header engine rename** finished (mypy-green). All committed (§9);
  green at 119 backend tests, ruff, mypy; frontend tsc, eslint, vite build.

---

## 8. Known issues / pending / gaps

- **User runtime pass pending** on the details page (backend + frontend are only
  statically verified; the user does all live testing).
- **Activity feed starts empty** for mushafs that existed before migration 0009
  (real event table — events record from now on; no backfill).
- **Coverage map** renders one 6px cell per logical page (500+ divs for a full
  mushaf) — fine locally; cap/virtualize if it ever feels heavy.
- **Manual pages carry a 1×1 placeholder bbox** (the review model's `DEFAULT_BBOX`), so the
  finalize/export line-cut column is **derived** from the union of the line boxes
  (`coordinates.page_column`), not the stored bbox. Fine; if you'd rather freeze a manual
  page's column, compute the union once in `bulk_save` and store it.
- **Finalize perf**: the stacked canvas re-composites all line crops per frame (cheap for
  ~15 lines); if a page ever has many lines, cache the per-line offscreen by strokes sig.
- **Templates**: resizable center/settings panels still not implemented (shipped a
  wider preview instead); possible "Add ignore" enable/disable edge case vs a
  fetched-but-not-recropped parent.
- **CORS**: `django-cors-headers` present in settings/pyproject — wiring may still be
  in progress (user-owned).
- **Runs tab** has no "full audit log" view — the Overview Activity feed (limit 50)
  serves that role for now.

---

## 9. Commit state

Branch `refactor/django-backend`. **Working tree clean — everything committed, no
co-author lines.** History (newest first):

- `fa7b0a4` feat(frontend): unified mushaf header across the hub and step pages
- `5e46e97` feat(frontend): show run settings + re-run from a run
- `54f1fa0` feat(frontend): finalize line-cut editor (stacked WYSIWYG canvas)
- `c38fb63` feat(backend): finalize cut layer — erase strokes + derived line-cut column
- `b997964` refactor(core): besmella/sura-header engine rename (now mypy-green)
- `ad8769b` feat(frontend): interactive whole-mushaf review editor
- `1d7f41c` feat(backend): whole-mushaf review-data + verbatim bulk page-save
- `7e09ac0` feat(frontend): mushaf details landing page (cockpit)
- `2cdf07d` feat(backend): mushaf details endpoints, activity feed, sura-header locator rename

**Smoke tests (user-run, live):**
- **Finalize** on a processed page → lines render stacked as they'll export; **Select** +
  drag a top/bottom edge trims Y/H (X/W stay the shared column); **Erase** (hold Shift) an
  intruding descender changes only that line; **Dark** bg shows white ink; the magnifier
  lens appears on drag; **Ctrl+Z/Y**; **Save & export page** → thumbnails match the canvas
  and are uniform width. Open the two manual front pages → they now render + export.
- **Runs** tab → each card shows its full settings; **Re-run with these settings** /
  **Resume** opens Process prefilled (`?run=<id>` [+ `?from=`]).
- **Header** → the same top bar on the hub + every step; ✓ / current step states; the
  mushaf name links back to the hub.

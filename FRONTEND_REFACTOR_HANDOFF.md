# Refactor Handoff — Backend done, Frontend next

> Context document for a fresh Claude Code session. The **backend refactor is
> complete**; the next task is **rewiring the React frontend** to the new
> PDF-based, DB-backed Django Ninja API. Read this in full before touching the
> frontend. Branch: `refactor/django-backend`.

---

## 1. Where things stand (TL;DR)

- The backend was rewritten from a **single-workspace FastAPI app** to a
  **multi-mushaf Django + Django Ninja API** backed by SQLite. Steps 1–6 of the
  plan are done, committed, and green (`ruff`, `mypy`, 64 tests).
- The user uploads a **PDF** now (not pre-cropped page images). Pages are
  rendered **on demand** from the stored PDF. Every processed Mushaf persists in
  the DB; nothing is wiped between runs.
- The **frontend has NOT been touched** — it still targets the old FastAPI
  endpoints (`/upload/`, `/api/review/*`, `/api/cut-review/*`) and the old
  image-batch flow. **That is the job: rewire it to the new API + flow.**
- One backend chore is still pending on the user's side: `makemigrations` +
  `migrate` + `seed_suras` (tests don't need migrations; running the app does).

---

## 2. Project vision (why this exists)

A local tool that turns scanned/printed **Mushaf (Quran) pages** into assets for
**image-based Mushaf apps** (the downstream consumer is "mushaf-imad"):

1. **Per-aya coordinates** — bounding box of each aya on each page (for
   highlighting, audio sync, verse navigation).
2. **Transparent line PNGs** — each page cut into individual line images, so an
   app can lay lines out responsively (lines scale to width; vertical gaps fill
   the height) instead of stretching one full-page image.

Why images not fonts: printed Mushaf calligraphy is context-dependent and
justified in ways text engines can't reproduce. Images preserve the exact layout.

---

## 3. The architectural pivot (old → new)

| | Old (FastAPI) | New (Django + Ninja) |
| --- | --- | --- |
| Server | `backend/server.py` (deleted) | Django app `backend/config/` + `backend/api/` |
| Input | batch of cropped page **images** | a single **PDF** per mushaf |
| Page source | uploaded image files | **rendered on demand** from the PDF by number |
| State | global flat files (`results/`, `results.json`, …), wiped each run | **DB rows** per mushaf; nothing wiped |
| Mushafs | one at a time | **many**, listed/managed |
| Coordinates | nested JSON files | normalized `Page`/`Line`/`Segment` tables |

The detection **engine** (`backend/core/`) was kept and made pure (no web
framework, no ORM); it operates on PIL images and returns plain dicts.

---

## 4. Locked design decisions (read these — they were deliberate)

- **Logical page numbering + PDF offset.** A `Page.page_number` is the *logical*
  Quran page (1-based). The mushaf stores `first_quran_pdf_page` /
  `last_quran_pdf_page` (the PDF physical indices where the Quran content
  starts/ends). Render index = `source_pdf_page` (per-page override, usually
  null) **or** `first_quran_pdf_page + page_number - 1`. Front/back matter falls
  outside the bounds. **Upload UX must let the user mark the first & last Quran
  page in the PDF preview.**
- **Lazy pages.** A `Page` row exists **iff** the page has data ("processed").
  The viewer should walk logical pages `1..logical_page_count`, render each from
  the PDF, and overlay DB data only when a page returns rows.
- **Detection settings are pipeline inputs, not stored config.** They are sent
  with each `/process` call and only *logged* per run (`processing_run.settings`).
  The reusable per-mushaf assets are the **templates** and the **per-page crop**.
- **Segments are edited directly** — there is no separator-cut / anchor layer.
  Aya numbers are **derived** and recomputed forward (server-side) on every page
  save. The frontend sends segment structure (geometry + `has_separator`); it
  does **not** compute aya numbers.
- **Revert = reprocess.** No "original vs corrected" snapshot; the stored PDF +
  settings make machine output reproducible.
- **Spelling:** the basmala line type is canonically **`besmella`** in the DB/API
  (the engine emits `"basmala"`; it's translated on persistence). Line types are
  `text | sura_header | besmella`.
- **Qiraa:** canonical `Sura` table + per-qiraa `SuraAyaCount`; a `Qiraa` table;
  each mushaf has a qiraa. Aya counts are per-qiraa.
- **Processing is synchronous** — a full mushaf is processed in **chunks** (e.g.
  50 pages) since one request runs the CV pipeline inline.
- **Mushaf identity = name** (unique; duplicate name → HTTP 409). The same PDF
  under a different name is allowed and flagged via `warnings.duplicate_file`.

---

## 5. Data model (`backend/api/models.py`)

`mushaf → page → line → segment`, plus `template`, `processing_run`,
`erase_stroke`, and reference tables `sura` / `sura_aya_count` / `qiraa`.
UUID PKs + timestamps via a `BaseModel` (reference tables use int PKs).

- **Mushaf**: `name` (unique), `pdf_file`, `pdf_sha256`, `pdf_page_count`,
  `first_quran_pdf_page`, `last_quran_pdf_page`, `qiraa`(FK).
- **Template**: `mushaf`(FK), `type` (`sura_header`|`aya_separator`), `image`,
  `ignore_rects` (JSON `{x,y,w,h}` or `{}`). Unique `(mushaf, type)`.
- **ProcessingRun**: `mushaf`(FK), `settings` (JSON), `page_range_start/end`,
  `status` (`completed`|`aborted_line_detection`|`error`), `abort_info`.
- **Page**: `mushaf`(FK), `page_number` (logical), `source_pdf_page` (null),
  `last_run`(FK null), `bbox_x/y/w/h`. Unique `(mushaf, page_number)`.
- **Line**: `page`(FK), `line_number`, `type`, `sura`(FK→Sura, null),
  `line_png` (set on export, null), `bbox_x/y/w/h`.
- **Segment**: `line`(FK), `segment_order` (1-based, right→left), `bbox_x`,
  `bbox_w` (y/h inherited from the line), `has_separator`, `aya_number`.
- **EraseStroke**: `line`(FK), `brush_size`, `points` (JSON `[[x,y],…]`).
- **Sura**: `number`(pk), `name_arabic`, `transliteration`.
  **SuraAyaCount**: `sura`(FK), `qiraa`(FK), `count`, unique `(sura, qiraa)`.
  **Qiraa**: `name` (unique), `description`. Seeded by `manage.py seed_suras`.

Media: PDFs → `media/mushafs/`, templates → `media/templates/`, line PNGs →
`media/lines/`. Page images are never stored (rendered on demand).

---

## 6. API reference (this is the contract the frontend codes against)

Base: `/api` (Django Ninja). Interactive docs at `/api/docs`. UUIDs are strings.

### Reference data
- `GET /api/suras?qiraa=hafs` → `[{number, name_arabic, transliteration, aya_count}]`

### Mushafs
- `GET /api/mushafs` → `[MushafOut]`
- `POST /api/mushafs` (multipart) → `201 {mushaf: MushafOut, warnings: {duplicate_file: bool}}`
  - fields: `pdf` (file), `name`, `qiraa` (name str|null), `first_quran_pdf_page` (int, default 1), `last_quran_pdf_page` (int|null → defaults to pdf_page_count)
  - duplicate `name` → `409`
- `GET /api/mushafs/{id}` → `MushafOut`
- `DELETE /api/mushafs/{id}` → `204`

`MushafOut = {id, name, qiraa, pdf_page_count, first_quran_pdf_page,
last_quran_pdf_page, logical_page_count, processed_page_count, created_at,
updated_at}`

### Templates
- `PUT /api/mushafs/{id}/templates/{type}` (multipart), `type ∈ {sura_header, aya_separator}`
  - fields: `image` (file), `ignore_x/ignore_y/ignore_w/ignore_h` (int|null, all-or-nothing)
  - → `TemplateOut {id, type, image_url, ignore_rects}`

### Page image
- `GET /api/mushafs/{id}/pages/{n}/image` → `image/png` (logical page `n`, rendered)

### Process
- `POST /api/mushafs/{id}/process` (JSON) → `ProcessOut`
  - body: `{page_range_start, page_range_end, start_sura(1–114), start_aya,
    bounds:{x,y,w,h}, padding=4, expected_lines=15, sura_header_slots=1,
    sura_header_threshold=0.6, max_sura_headers=3, match_threshold=0.5,
    alternate_horizontal_margin=false, prefer_acceleration=true}`
  - `ProcessOut = {run_id, status, pages_processed, start_sura, start_aya,
    end_sura, end_aya, results:[…per-page dicts…], abort_info:{…}|null}`
  - On a line-count mismatch the batch aborts at that page (`status =
    aborted_line_detection`); only completed pages are persisted.

### Review (per page)
- `GET /api/mushafs/{id}/pages/{n}` → `PageDataOut` (empty `lines:[]`, `bbox:null` if unprocessed)
- `POST /api/mushafs/{id}/pages/{n}` (JSON `PageSaveIn`) → `PageDataOut` (re-numbered)

```
PageDataOut = {page_number, bbox:{x,y,w,h}|null, lines:[LineSchema]}
PageSaveIn  = {bbox:{x,y,w,h}, lines:[LineSchema]}
LineSchema  = {id?, line_number, type:"text"|"sura_header"|"besmella",
               sura_number|null, bbox_x, bbox_y, bbox_w, bbox_h,
               segments:[SegmentSchema]}
SegmentSchema = {id?, segment_order, bbox_x, bbox_w, has_separator,
                 aya_number|null, sura_number|null}
```
Note: line/segment bboxes use **flat** `bbox_x/bbox_y/bbox_w/bbox_h` (segments
only `bbox_x`/`bbox_w`). On save, aya numbers are recomputed server-side — the
values you send are ignored; what's derived from `has_separator` + the seed wins.

### Finalize + export (per page)
- `POST /api/mushafs/{id}/pages/{n}/finalize` (JSON) → `PageDataOut`
  - body: `{lines:[{line_number, bbox_override:{x,y,w,h}|null,
    erase_strokes:[{brush_size, points:[[x,y],…]}]}]}`
- `POST /api/mushafs/{id}/pages/{n}/export-lines` → `{page_number, exported, lines:[{line_number, line_png(url)}]}`

---

## 7. Backend code map

```
backend/
  config/        settings.py (.env via django-environ; MIGRATION_MODULES disables api migrations in tests), urls.py (mounts /api)
  api/
    api.py       NinjaAPI + router registration
    models.py    the schema above
    common.py    RectSchema {x,y,w,h}
    validators.py page-range / bounds checks
    views/       suras, mushafs, processing, pages, finalize  (THIN; schemas co-located here)
    services/    pdf, mushaf, processing, coordinates, editing, export  (ALL ORM + wiring lives here)
    management/commands/seed_suras.py
    tests/       per-area; helpers.py (make_pdf_bytes, make_png_bytes, MediaTestCase, bare_mushaf)
  core/          pure engine (line_detector, aya_separator, page_processor, pipeline, builder, coordinate_exporter, protected_bands, template_matching, quran_metadata, image_utils, …)
```

Layering rule (enforced): **view (schema) → service (ORM + orchestration) → core
(pure)**. Views never touch the ORM; `core` never imports Django/Ninja.

Key service functions for the frontend's mental model:
- `services/mushaf.py`: create/list/get/delete, `upsert_template`, `render_page_image`.
- `services/processing.py`: `process(...)` (render range → run pipeline → persist).
- `services/coordinates.py`: `page_to_dict` (read), `write_coords_to_page` (engine→rows), `renumber_from` (forward aya recompute).
- `services/editing.py`: `get_page_data`, `save_page`, `save_finalize`.
- `services/export.py`: `export_lines`.

---

## 8. Dev commands & gotchas

```bash
cd backend
uv sync
cp .env.dist .env                     # SECRET_KEY etc.; a dev default is built in
uv run python manage.py makemigrations # PENDING (user does this)
uv run python manage.py migrate
uv run python manage.py seed_suras
uv run python manage.py runserver      # API at /api, docs at /api/docs

# checks
uv run ruff check .
uv run python -m mypy .                # NOTE: invoke via `python -m`; the mypy.EXE
                                       # launcher fails on this repo path (has a space)
uv run python manage.py test api       # builds schema from models (no migrations needed)
```

- Tests disable migrations for `api` (`MIGRATION_MODULES` under `if "test" in
  sys.argv`), so the suite runs without migration files.
- The frontend dev proxy already forwards `/api` → `localhost:8000`
  (`frontend/vite.config.ts`); drop the stale `/upload/` proxy entry.

---

## 9. The frontend task

Rewire the existing React SPA from the old image-upload/flat-file flow to the new
PDF/mushaf/DB API. Conceptual flow to build:

1. **Home / mushaf list** — `GET /api/mushafs`; show each with
   `processed_page_count / logical_page_count`. "New mushaf" → upload PDF.
2. **Create mushaf** — `POST /api/mushafs` with the PDF + name + qiraa. Then a
   **PDF preview with navigation** to mark `first_quran_pdf_page` /
   `last_quran_pdf_page` (these can be set at create or via a later edit). Render
   preview pages via `GET …/pages/{n}/image` once created.
3. **Templates** — crop `sura_header` and `aya_separator` from a rendered page
   (+ optional ignore rects) → `PUT …/templates/{type}`.
4. **Process** — pick a logical page range + start sura/aya + crop `bounds` +
   detection settings → `POST …/process`. Handle the abort case.
5. **Review** — page-by-page: render `…/pages/{n}/image` as the canvas, overlay
   line/segment boxes from `GET …/pages/{n}`, let the user edit boxes / types /
   separators, `POST` back. Remember: aya numbers come back recomputed.
6. **Finalize + export** — eraser strokes + bbox overrides (`…/finalize`), then
   `…/export-lines`.

The old client-side aya renumbering (`lib/verify/recompute.ts`) is now **server
authoritative** — the frontend just renders what `GET/POST …/pages/{n}` returns.

---

## 10. Current frontend structure (what exists today)

- **Stack**: React 19, Vite 7, **TanStack Router** (file-based, `src/routes/`),
  **TanStack React Query**, TailwindCSS 4, **Radix UI** (shadcn-style components
  in `src/components/ui/`), react-hook-form + zod, sonner, lucide.
- **Routes** (`src/routes/`): `index` (→ `/upload`), `upload`, `verify`,
  `finalize`, plus `review`, `cut-review`, `line-review`.
- **API clients** (`src/lib/api/`) — all target the OLD backend, **must be
  rewritten**:
  - `raqam.ts` — `RAQAM_API_BASE`, `uploadBatch()` (multipart image batch +
    crop targets + settings → `POST /upload/`), `Settings`/`Rect`/`TargetName`
    types, `cropImageToBlob`, `naturalSort`.
  - `review.ts` — `/api/review/{status,results,save}` + `pageImageUrl`.
  - `cutReview.ts` — `/api/cut-review/{status,results,save,export}`.
- **Upload UI** (`src/components/upload/`): `AppHeader`, `FileStrip`,
  `PageCanvas` (draw/zoom/pan crop rectangles — **reusable** for template
  cropping & bounds), `CropPreviewPane`, `RightPanel` (settings form).
- **Verify UI** (`src/components/verify/PageReview.tsx`) + `lib/verify/`
  (`types.ts`, `recompute.ts` — the now-obsolete client-side renumbering).
- `src/lib/data/suras.ts` — local sura list (can switch to `GET /api/suras`).

Much of the **canvas/crop/zoom/pan machinery and the Radix UI kit is reusable**;
the data layer (API clients + flow + types) is what changes.

---

## 11. Pointers

- **Backend README**: `README.md` (architecture, workflow, API, data model).
- **Full backend design + DBML**: `~/.claude/plans/drifting-brewing-dongarra.md`.
- **API contract**: live at `/api/docs` once the server runs.
- This branch: `refactor/django-backend` (backend work committed here).

When in doubt about a response shape, run the backend (`runserver` after the
pending migrate+seed) and check `/api/docs`, or read the matching
`backend/api/views/*.py` schema (schemas are co-located with their views).

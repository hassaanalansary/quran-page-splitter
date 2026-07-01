# Quran Page Splitter — Project Handoff

> Definitive state-of-the-project reference (supersedes the historical
> `FRONTEND_REFACTOR_HANDOFF.md`). Backend **and** frontend are now built. Branch:
> `refactor/django-backend`. Read §9 for what's uncommitted / pending.

---

## 1. What this is (purpose)

A **local desktop-style tool** that turns scanned/printed **Mushaf (Quran) pages**
(uploaded as a **PDF**) into assets for **image-based Mushaf apps** (downstream
consumer: "mushaf-imad"). Two outputs:

1. **Per-aya coordinates** — bounding box of each aya on each page (for
   highlighting, audio sync, verse navigation).
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
only a small cover thumbnail is cached — see Mushaf.thumbnail).

---

## 3. Repo layout & dev commands

```
backend/
  config/     settings.py (.env via django-environ), urls.py (/admin, /api, /media, SPA catch-all), spa.py, wsgi.py
  api/
    api.py    NinjaAPI + routers;  models.py;  common.py (RectSchema);  validators.py;  admin.py
    views/    suras, mushafs, pages, processing, finalize  (THIN; Ninja schemas co-located)
    services/ pdf, mushaf, coordinates, editing, export, processing, suras  (ALL ORM + wiring)
    management/commands/seed_suras.py
    migrations/ 0001..0008
    tests/    per-area + helpers.py (make_pdf_bytes, make_png_bytes, MediaTestCase, bare_mushaf)
  core/       pure engine: line_detector, aya_separator, page_processor, pipeline, builder,
              coordinate_exporter, protected_bands, template_matching, quran_metadata, image_utils, …
  aya_count_per_path.json  (repo root: per-counting-system aya counts, seeded into SuraAyaCount)
frontend/
  src/routes/       index (home), mushafs.$mushafId (layout + step nav), .setup .templates .process .review .finalize
  src/components/
    app/            Panel (Aside/PanelCard/Section/Field/Hint), CreateMushafDialog
    canvas/         PageStage, PageCanvas, ChevronNav, PageJump, ZoomControl, ToolToggle, RectInputs,
                    PageRail, CropPreview, TemplatePreview, FilmstripViewer, CroppableImage, ReviewCanvas
    ui/             shadcn components (Radix)
  src/lib/api/      http, types, mushafs, pages, suras, processing, queries (React Query hooks + queryKeys)
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

Green baseline (last verified this session): **76 backend tests, ruff, mypy; frontend tsc + eslint (0 errors) + build.**

---

## 4. Data model (`backend/api/models.py`)

`mushaf → page → line → segment`, plus `template`, `processing_run`, `erase_stroke`,
and reference tables. `BaseModel` gives UUID PK + timestamps (reference tables use
int PKs). Media: PDFs → `media/mushafs/`, templates → `media/templates/`, thumbnails
→ `media/thumbnails/`, line PNGs → `media/lines/`.

- **CountingSystem** (int PK): `name`, `name_arabic`. The schools of aya numbering
  (kufi, basri, dimashqi, makki, madani-first, madani-last).
- **Qiraa** (int PK, `db_table="qiraa"`): `name`, `name_arabic`, `description`,
  `counting_system`(FK). ~20 qiraat seeded/managed by the user; each follows one
  counting system (Hafs → kufi).
- **Sura** (int PK): `number`, `name_arabic`, `transliteration`.
- **SuraAyaCount**: `sura`(FK), `counting_system`(FK), `count`. Unique
  `(sura, counting_system)`. Aya counts are **per counting system** (not per qiraa).
- **Mushaf**: `name`(unique), `pdf_file`, `pdf_sha256`, `pdf_page_count`,
  `first_quran_pdf_page`, `last_quran_pdf_page`, `qiraa`(FK, SET_NULL),
  `thumbnail`(ImageField — cover render of physical page 1, for the home grid).
- **Template**: `mushaf`(FK), `type`(`sura_header`|`aya_separator`), `image`,
  `ignore_rects`(JSON `{x,y,w,h}` relative to the template crop, or `{}`). Unique
  `(mushaf, type)`.
- **ProcessingRun**: `mushaf`(FK), `settings`(JSON, incl. bounds), `page_range_start/end`,
  `status`(`completed`|`aborted_line_detection`|`error`), `abort_info`.
- **Page**: `mushaf`(FK), `page_number`(logical), `source_pdf_page`(null),
  `last_run`(FK null), `bbox_x/y/w/h`, `reviewed`(bool — set True on review-save,
  reset False on (re)process). A Page row exists **iff** the page has data.
- **Line**: `page`(FK), `line_number`, `type`(`text`|`sura_header`|`besmella`),
  `sura`(FK null), `line_png`(set on export), `bbox_x/y/w/h`.
- **Segment**: `line`(FK), `segment_order`(1-based, right→left), `bbox_x`, `bbox_w`
  (y/h inherited from line), `has_separator`, `aya_number`(derived).
- **EraseStroke**: `line`(FK), `brush_size`, `points`(JSON `[[x,y],…]`).

**Reference-data seeding** (`services/suras.py` → `seed_suras`): sura names from
`core.quran_metadata`; per-counting-system aya counts from **`aya_count_per_path.json`**
(repo root), mapping each JSON slug (kufi, basri, …) to a CountingSystem by **Arabic
name** (get_or_create — bootstraps a fresh/test DB, never clobbers existing rows).
CountingSystem/Qiraa taxonomy is otherwise owned by the user.

---

## 5. API reference (contract the frontend codes against)

Base `/api` (Ninja). Interactive docs `/api/docs`. UUIDs are strings.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/suras?qiraa=hafs` | `[{number, name_arabic, transliteration, aya_count}]`; qiraa lookup is **case-insensitive**, aya_count from the qiraa's counting system |
| GET | `/api/mushafs` | `[MushafOut]` newest-first (annotated counts, `thumbnail_url`) |
| POST | `/api/mushafs` | multipart `pdf,name,qiraa,first_quran_pdf_page,last_quran_pdf_page` → `201 {mushaf, warnings:{duplicate_file}}`; dup name → 409; generates the cover thumbnail |
| GET / DELETE | `/api/mushafs/{id}` | `MushafOut` / `204` |
| PATCH | `/api/mushafs/{id}` | name / qiraa / bounds (bounds locked once pages exist) |
| GET | `/api/mushafs/{id}/templates` | **`[TemplateOut]`** (rehydrate the editor on revisit) |
| PUT | `/api/mushafs/{id}/templates/{type}` | multipart; **`image` optional** (omit to update only the ignore region); `ignore_x/y/w/h` all-or-nothing → `TemplateOut {id,type,image_url,ignore_rects}` |
| GET | `/api/mushafs/{id}/pages/{n}/image` | `image/png` — logical page `n`, rendered on demand |
| GET | `/api/mushafs/{id}/pages` | **`[{page_number, reviewed}]`** — processed-page summaries (page-rail indicator) |
| GET / POST | `/api/mushafs/{id}/pages/{n}` | `PageDataOut` (empty if unprocessed) / save (aya numbers recomputed server-side) |
| POST | `/api/mushafs/{id}/pages/{n}/finalize` | erase strokes + bbox overrides |
| POST | `/api/mushafs/{id}/pages/{n}/export-lines` | writes transparent line PNGs |
| POST | `/api/mushafs/{id}/process` | run the CV pipeline over a page range; synchronous, chunked (frontend loops 50 pages/call); may abort at a line-count mismatch |

`MushafOut = {id, name, qiraa, pdf_page_count, first_quran_pdf_page,
last_quran_pdf_page, logical_page_count, processed_page_count,
reviewed_page_count, thumbnail_url, created_at, updated_at}`.

**Media URLs**: use the `_media_url()` helper (leading-slash absolute path) —
`MEDIA_URL="media/"` makes raw `FieldFile.url` relative, which breaks in the SPA.

---

## 6. Frontend — the 6-step flow & canvas library

Flow: **Home → Setup → Templates → Process → Review → Finalize**. `mushafs.$mushafId.tsx`
is the layout (breadcrumb + step nav); each step is a sibling route.

- **Home** (`index.tsx`): thumbnail-card grid (cover from `thumbnail_url`), status
  badge via `mushafStatus()` — `empty`/`partial`/`processed`/`completed` (completed =
  all pages reviewed), + a dashed add-card → `CreateMushafDialog`.
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
  the sura/aya selects, Detection settings). Loops the pipeline in 50-page chunks;
  handles the abort case.
- **Review** (`.review`) / **Finalize** (`.finalize`): **`ReviewCanvas`** (page image +
  selectable line/segment overlays + aya labels). Review edits line types / separators /
  sura and POSTs back (aya numbers recomputed). Finalize does erase + export.

**Canvas component library** (`components/canvas/`, all reusable):
- `PageStage` — composer: zoomable/pannable single page + toolbar (`ToolToggle`
  select/hand + Space-hold, `ZoomControl` 50/100/200/Fit + Ctrl-wheel) + `ChevronNav`
  + floating `PageJump` + status bar + `PageRail`. Optional `crop` (draggable rect) +
  `onNatural` + `processed`/`reviewed` sets.
- `PageCanvas` — the zoom/pan/crop surface (uses `use-space-pan`, `use-ctrl-wheel-zoom`).
- `PageRail` — compact numbered rail (first…current±3…last); optional processed
  (navy bar) / reviewed (green bar) indicators. Added to `PageStage` and `ReviewCanvas`.
- `CropPreview` — exact magnified region via canvas `drawImage`.
- `TemplatePreview` — large template/ignore preview (red box for ignore + validation).
- `FilmstripViewer` + `CroppableImage` — Setup's peeking filmstrip (kept only for Setup).
- `ReviewCanvas` — read-only overlay viewer for review/finalize.

State: React Query for all server state (`lib/api/queries.ts` — `queryKeys`,
`useMushaf(s)`, `useTemplates`, `useProcessedPages`, `useSuras`, `usePage`).

---

## 7. Done & verified

- Django serves the SPA single-origin + `/media`; home redesign; page `reviewed` flag.
- Counting-system reference-model refactor landed (service/seed from
  `aya_count_per_path.json`; `/api/suras` correct: Hafs→Kufan 286, Warsh→Madani 285).
- Cover thumbnails on the mushaf list (`thumbnail_url`; backfilled).
- Setup filmstrip (verified live). Crop steps reworked to a single **zoomable** canvas
  with select/hand/space tools, numeric crop, chevron nav, floating page-jump.
- Templates enhancement: GET templates + fetch-on-load, large `TemplatePreview` with
  ignore red-box + validation, per-target cards, draft persistence, auto-absolute image
  URLs, optional-image PUT. Capture → Save → backend persist → reload shows saved:
  **verified end-to-end via API + DOM eval** this session.
- Compact page rail added to Templates/Process/Review/Finalize; processed/reviewed
  indicator wired on Process/Review/Finalize (`/api/mushafs/{id}/pages`).

---

## 8. Known issues / pending / gaps

- **Uncommitted**: everything after commit `4b98e8b` is in the working tree (thumbnail +
  migration 0008, crop-canvas rework, templates enhancement, page rail + processed
  indicator, plus the user's model/settings/CORS edits). Needs a commit — see §9.
- **Qiraa picker**: `CreateMushafDialog` still hardcodes `qiraa: ["hafs"]`. There are
  ~20 qiraat in the DB and **no `GET /api/qiraat` endpoint** — add one + a real dropdown.
- **Templates resizable panels**: user wanted the center/settings panels resizable;
  shipped a **wider** `TemplatePreview` (320→400px) as the safe option (`resizable.tsx`
  exists if we revisit). A possible small bug to confirm: "Add ignore" enable/disable
  vs a fetched-but-not-recropped parent (design says re-crop to edit).
- **Review/Finalize navigation**: the compact rail is added; the full filmstrip-style
  nav (chevrons + floating jump) was **not** ported to `ReviewCanvas` (still Prev/Next
  top bar).
- **CORS**: the user added `django-cors-headers` (settings.py / pyproject) — likely for
  a separate frontend host; wiring may be in progress.
- **Verification tooling**: the Claude preview MCP was flaky all session (screenshot
  timeouts, disconnects) — much was verified via `preview_eval` (DOM) + `curl` + tests
  instead. Port 5173 is often held by the user's own `vite dev`.

---

## 9. Uncommitted work — how to land it

Working tree (branch `refactor/django-backend`) has a large, coherent batch. Suggested
commit split (backend + frontend), after a full green check (`manage.py test api`,
ruff, mypy; `tsc`, `eslint`, `build`):

- **Backend**: `models.py` (+ migration 0008 thumbnail; the user's CountingSystem/Qiraa
  edits), `services/{mushaf,editing,processing}.py`, `views/{mushafs,pages}.py`,
  `config/settings.py` (CORS), `pyproject.toml`/`uv.lock`, tests. Feature: templates GET
  + optional-image PUT + absolute URLs; cover thumbnail; processed-pages endpoint.
- **Frontend**: new `components/canvas/{PageStage,PageCanvas,ChevronNav,PageJump,
  ZoomControl,ToolToggle,RectInputs,PageRail,TemplatePreview}.tsx`, `lib/templateDraft.ts`,
  recovered `hooks/use-space-pan.ts` + `use-ctrl-wheel-zoom.ts`; edits to the routes,
  `CropPreview`, `ReviewCanvas`, `lib/api/*`. Feature: crop-canvas rework + templates
  enhancement + page rail + processed indicator.

> Note: the user has been editing the backend concurrently (Qiraa int PK, CountingSystem,
> CORS) and a couple of frontend files (`RectInputs`, `CroppableImage`) — reconcile,
> don't blind-revert. `git status` is the source of truth.

**End-to-end smoke test**: create a mushaf (PDF) → Setup mark first/last → Templates
capture+save sura_header & aya_separator (+ ignore) → Process a small range → Review a
page + save → Finalize + export. Confirm the page rail shows the processed indicator on
Process/Review/Finalize, and Templates rehydrates saved templates on revisit.

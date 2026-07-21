# Quran Page Splitter — Complete Project Context

> A single, self-contained reference describing **every meaningful part** of this
> project: its purpose, architecture, data model, the computer-vision engine, the
> API contract, the frontend, the numbering model, tooling, conventions, and known
> gaps. Written so that any engineer — or any AI model — can pick up the project
> cold and reason about it accurately without re-reading the whole codebase.
>
> **Current state (verified from source):** branch `refactor/django-backend`, HEAD
> `0dfebc7` (*feat(frontend): mirrored preview for alternate-margin pages*), working
> tree clean. Backend **and** frontend are fully built. Quality gates green: **120
> backend tests** (13 files), `ruff`, `mypy` (django-stubs plugin); frontend `tsc`,
> `eslint`, Vite `build`.
>
> Companion docs already in the repo: [`README.md`](README.md) (user-facing intro +
> tuning guide) and [`PROJECT_HANDOFF.md`](PROJECT_HANDOFF.md) (dated handoff notes).
> Where they disagree with this file, **this file and the code win** — notably
> `README.md`'s "frontend being rewired" status line is stale (the SPA is complete).

---

## Table of contents

1. [What this is & why it exists](#1-what-this-is--why-it-exists)
2. [High-level architecture](#2-high-level-architecture)
3. [Technology stack](#3-technology-stack)
4. [Repository layout](#4-repository-layout)
5. [Domain glossary](#5-domain-glossary)
6. [Data model](#6-data-model)
7. [The core CV engine (`backend/core/`)](#7-the-core-cv-engine-backendcore)
8. [The service layer (`backend/api/services/`)](#8-the-service-layer-backendapiservices)
9. [The numbering model (the subtle part)](#9-the-numbering-model-the-subtle-part)
10. [HTTP API reference](#10-http-api-reference)
11. [Frontend architecture](#11-frontend-architecture)
12. [The 5-step workflow + details hub](#12-the-5-step-workflow--details-hub)
13. [Build, run, and test](#13-build-run-and-test)
14. [Invariants & conventions](#14-invariants--conventions)
15. [Known issues, gaps & legacy code](#15-known-issues-gaps--legacy-code)
16. [File-by-file index](#16-file-by-file-index)

---

## 1. What this is & why it exists

**Quran Page Splitter** is a **local, desktop-style web tool** that converts a
scanned/printed **Mushaf (Quran) PDF** into machine-usable assets for
**image-based Mushaf applications** (the intended downstream consumer is a project
referred to as *"mushaf-imad"*).

### The problem

Digital Qurans rendered with **fonts** cannot faithfully reproduce a printed
Mushaf. Printed Quranic calligraphy is context-dependent (one letter takes many
shapes depending on position) and is **visually justified** to align both edges of
every line in ways text engines cannot replicate. A faithful font would require a
unique glyph for every character instance on every page — enormous and still
imperfect.

The **image-based approach** sidesteps this: display the actual scanned pages,
preserving every calligraphic detail. But to make those images *interactive*
(highlight an aya, jump to a verse, sync audio) an app needs two derived assets,
which this tool produces:

1. **Per-aya coordinates** — the bounding box(es) of each aya on each page.
   Downloadable as one JSON document (`GET /api/mushafs/{id}/coordinates`, schema
   **`aya-bbox/v1`**).
2. **Transparent line PNGs** — each page cut into individual line images with the
   white background made transparent. This also solves a **responsive-layout**
   problem: instead of stretching one full-page image (which distorts or leaves
   dead space when the window resizes), an app lays out each line as its own image,
   scales lines uniformly to the window width, and absorbs leftover vertical space
   in the gaps between lines — so the page always fills the screen undistorted.

### Design ethos

- **Multi-mushaf, DB-backed.** Every processed mushaf persists; nothing is wiped
  between runs. Results accumulate.
- **Render on demand.** Page images are always rendered from the stored PDF at
  request time (300 DPI) and **never stored as files**. Only a small cover
  thumbnail (≈50 DPI) is cached per mushaf.
- **Human-in-the-loop.** Automatic detection is imperfect; the tool provides rich
  **Review** and **Finalize** editors to correct the output before export.
- **Reproducible.** The stored PDF + a run's logged settings make any page's
  machine output reproducible by re-processing.

---

## 2. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  React 19 SPA (Vite 7)   ── TanStack Router + React Query, Tailwind 4 │
│  Home → Details hub → Setup → Templates → Process → Review → Finalize │
└───────────────┬─────────────────────────────────────────────────────┘
                │  fetch  /api (JSON + multipart),  /media (files)
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Django 6 + Django-Ninja API           (single WSGI app, SQLite)     │
│                                                                        │
│   views/  ── thin; parse & return Ninja/Pydantic schemas only          │
│      │                                                                  │
│   services/ ── the ONLY layer that touches the ORM; orchestrates       │
│      │         DB ⇄ engine; serializes to plain dicts                   │
│      ▼                                                                  │
│   core/   ── pure CV engine: PIL/NumPy/OpenCV in, plain dicts out.     │
│              No Django, no ORM, no I/O (unless given explicit paths).  │
└─────────────────────────────────────────────────────────────────────┘
```

### Serving model

- **Production (single origin):** run only Django. It serves the Vite-built SPA
  from `frontend/dist` (`config/spa.py`), plus `/api` and `/media`. The URLconf
  matches `/admin`, `/api`, `/media` first, then a **catch-all** returns real files
  from `dist` or falls back to `index.html` for client routes (traversal-guarded).
- **Development:** Vite dev server on `:5173` proxies `/api` and `/media` →
  Django on `:8000` (see `frontend/vite.config.ts`). Two processes.

### The enforced layering rule

**view → service → core.** Views never touch the ORM. `core` never imports Django
or the ORM. Services are the only meeting point of the two. This is a hard
architectural invariant (see [§14](#14-invariants--conventions)).

### Auditing

Every meaningful mutation also writes an **`ActivityEvent`** at its commit point
(`services/activity.py`), feeding a per-mushaf audit feed on the details page.

---

## 3. Technology stack

### Backend (`backend/`, package-managed by **uv**, Python ≥ 3.13)

| Dependency | Version | Role |
| --- | --- | --- |
| `django` | ≥ 6.0.6 | Web framework, ORM, admin, migrations |
| `django-ninja` | ≥ 1.6.2 | Fast REST API with Pydantic schemas + `/api/docs` |
| `django-environ` | ≥ 0.14 | `.env` config (`SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`) |
| `django-cors-headers` | ≥ 4.7 | CORS (`CORS_ALLOW_ALL_ORIGINS = True`) |
| `pymupdf` (`fitz`) | ≥ 1.27 | PDF page count + on-demand page rendering to PNG |
| `opencv-python-headless` | ≥ 4.11 | Thresholding, template matching, OpenCL accel |
| `numpy` | ≥ 2.4 | Projection profiles, valley detection, array math |
| `pillow` | ≥ 12 | Image crop / composite / transparency |

Dev tools: **`mypy`** (with `django-stubs` plugin, strict-ish: `disallow_untyped_defs`,
`check_untyped_defs`, `warn_return_any`), **`ruff`** (line length 120; rules
F/E/W/I/UP/B/SIM/RUF), `django-watchfiles`. Database is **SQLite** (`db.sqlite3`).

> mypy must be invoked as `uv run python -m mypy .` (the `mypy.exe` launcher trips
> over the space in the repo path `Programing materials`).

### Frontend (`frontend/`, package-managed by **npm**, React 19)

| Dependency | Role |
| --- | --- |
| `react` 19 + `react-dom` | UI |
| `vite` 7 + `@vitejs/plugin-react` | Build/dev server |
| `@tanstack/react-router` (file-based, plugin generates `routeTree.gen.ts`) | Routing |
| `@tanstack/react-query` | All server state (caching, invalidation) |
| `tailwindcss` 4 (`@tailwindcss/vite`) | Styling via a token-based `@theme` |
| Radix UI primitives + **shadcn/ui** (in `components/ui/`) | Accessible components |
| `lucide-react` | Icons |
| `sonner` | Toasts |
| `react-hook-form` + `zod` + `@hookform/resolvers` | Forms (create dialog) |
| `recharts`, `embla-carousel`, `vaul`, `cmdk`, `date-fns` | Misc UI (mostly shadcn deps) |

Fonts (loaded in `index.html` from Google Fonts, mapped in `styles.css @theme`):
**Outfit** (`--font-sans`), **Syne** (`--font-display`), **Amiri**
(`--font-arabic`, for Arabic sura names and the ۝ glyph).

---

## 4. Repository layout

```
quran-page-splitter/
├── README.md                 User-facing intro, workflow, tuning guide
├── PROJECT_HANDOFF.md        Dated handoff notes (predates a few commits)
├── PROJECT_CONTEXT.md        ← this file
├── counting-systems.json     Reference doc of counting systems (NOT auto-consumed)
├── openapi.json              A generated OpenAPI dump (static snapshot, ~31 KB)
├── data/                     Sample scanned pages (e.g. almadinah-kabir-azraq/*.png)
│                               — legacy CLI-era fixtures, not used by the web app
│
├── backend/
│   ├── pyproject.toml        Deps, ruff, mypy, django-stubs config
│   ├── .env.dist             Copy → .env (SECRET_KEY, DEBUG, ALLOWED_HOSTS)
│   ├── manage.py, db.sqlite3
│   ├── media/                Uploaded PDFs, template crops, thumbnails, line PNGs, run_debug/
│   ├── logs/                 quran.log (rotating) + runs/<token>.log (per run)
│   │
│   ├── config/
│   │   ├── settings.py       Apps, middleware (GZip, CORS, Ninja file-fix), logging, media, SQLite
│   │   ├── urls.py           /admin, /api, /media, SPA catch-all (order matters)
│   │   ├── spa.py            Serve frontend/dist + index.html fallback (traversal-guarded)
│   │   └── wsgi.py / asgi.py
│   │
│   ├── api/                  The Django app (Ninja API)
│   │   ├── api.py            NinjaAPI instance + router registration
│   │   ├── models.py         ALL tables (see §6)
│   │   ├── admin.py          Django-admin registrations
│   │   ├── common.py         Shared schemas: RectSchema, EraseStrokeSchema
│   │   ├── validators.py     Page/range/bounds validation → HttpError
│   │   ├── migrations/       0001..0011
│   │   ├── management/commands/seed_suras.py   → services.suras.seed_reference_data()
│   │   ├── views/            THIN endpoints (Ninja schemas co-located):
│   │   │     counting_systems, qiraat, suras, mushafs, processing, pages, finalize
│   │   ├── services/         ORM + orchestration:
│   │   │     mushaf, processing, coordinates, editing, export, pdf,
│   │   │     activity, suras, qiraat, counting_system
│   │   └── tests/            120 tests + helpers.py
│   │
│   └── core/                 PURE engine (no Django/ORM):
│         config.py           Crop/Detection/Processing/Export config dataclasses
│         context.py          BBox, LineResult, SegmentResult, PageContext, QuranTracker
│         image_utils.py      binarize, find_content_bbox, clean_image, make_transparent
│         line_cutter.py      split_by_valleys (projection-valley line detection)
│         line_detector.py    LineDetector: crop, header protection, region allocation
│         sura_header.py      SuraHeaderLocator (pre-split header template matching)
│         aya_separator.py    AyaSeparatorProcessor (in-line separator matching → segments)
│         template_matching.py  TemplateSpec, match_template, locate_x_matches, masks
│         opencv_accel.py     CPU vs OpenCL (UMat) backend switch (OPENCV_ACCEL env)
│         coordinate_exporter.py  track_positions (sura/aya) + collect_page_coordinates
│         page_processor.py   Orchestrates one page: detect→split→track→export/collect
│         pipeline.py         Iterates pages, holds QuranTracker, handles abort, logs
│         builder.py          Factory: assemble configs + pipeline
│         quran_metadata.py   Static 114-sura table (number, Arabic name, translit, aya_count)
│         review.py, cut_review.py   ⚠ LEGACY CLI file-based helpers (see §15)
│
└── frontend/
    ├── package.json, vite.config.ts, tsconfig.json, eslint.config.js, components.json
    ├── index.html            Root div + Google Fonts
    └── src/
        ├── main.tsx, router.tsx (QueryClient + Router), routeTree.gen.ts (generated)
        ├── styles.css         Design tokens (oklch), Tailwind @theme, shadcn mapping
        ├── routes/            File-based routes (see §12):
        │     __root.tsx, index.tsx,
        │     mushafs.$mushafId.tsx (workspace layout),
        │     mushafs.$mushafId.index.tsx (details hub),
        │     .setup .templates .process .review .finalize
        ├── components/
        │     app/             Panel, MushafHeader, CreateMushafDialog, AbortDiagnostics,
        │                      details/ (DetailsRail, OverviewTab, PagesTab, RunsTab,
        │                               ExportTab, SettingsTab, helpers.ts)
        │     canvas/          PageStage, PageCanvas, PageRail, ChevronNav, PageJump,
        │                      ZoomControl, ToolToggle, RectInputs, CropPreview,
        │                      TemplatePreview, CroppableImage, FilmstripViewer,
        │                      ReviewCanvas, ReviewEditCanvas, FinalizeCanvas
        │     ui/              shadcn/Radix components
        ├── hooks/             use-ctrl-wheel-zoom, use-space-pan, use-mobile
        └── lib/
              api/             http, types, mushafs, pages, suras, qiraat, processing,
                               queries (React Query hooks + queryKeys), index (barrel)
              review/          model.ts (edit store), recompute.ts (client numbering)
              image.ts         cropUrlToBlob
              templateDraft.ts In-memory template-capture store (survives in-app nav)
              utils.ts         cn() classname helper
```

---

## 5. Domain glossary

| Term | Meaning |
| --- | --- |
| **Mushaf** | A physical copy/edition of the Quran (here: one uploaded PDF). Plural *Masahef*. |
| **Qiraa** (qiraat) | A recitation school (e.g. *Hafs*, *Warsh*). ~20 exist; each follows one counting system. |
| **Counting system** | A school of **aya numbering** (Kufan/kufi, Basran/basri, Dimashqi, Makki, Madani-first, Madani-last). Aya counts differ **per counting system**, *not* per qiraa. Hafs → kufi (6236 ayat total). |
| **Sura** | A chapter (114 total). Has a number, Arabic name, transliteration, and per-counting-system aya count. |
| **Aya** | A verse. Numbered within its sura. |
| **Besmella** | The "﷽" opening line of a sura (bismillah). Modeled as a line **type**. |
| **Sura header** | The ornamental band containing a sura's title/name. A line **type**; protected from line-splitting. |
| **Aya separator** | The end-of-aya ornament (۝, often with the aya number inside). Detected inside text lines to cut segments. |
| **Logical page** | The 1-based Quran page number. Logical page 1 = `first_quran_pdf_page`. Front/back matter is excluded. |
| **Physical / source PDF page** | The 1-based page index inside the actual PDF file. Mapping: `first_quran_pdf_page + logical - 1`, unless overridden per page by `source_pdf_page`. |
| **Line** | A detected horizontal band on a page: `text`, `sura_header`, or `besmella`. |
| **Slot** | A layout "line slot." A sura header may occupy multiple slots but is still one crop. `expected_lines` counts slots. |
| **Segment** | A horizontal piece of a text line between separator cuts. Ordered **right→left** (Arabic reading). One aya may span multiple segments/lines. |
| **Bounds / crop box** | The main text rectangle on a page (excludes margins/decoration). Line detection runs inside it. |
| **Ignore rect** | A rectangle *inside a template crop* to mask out during matching (e.g. the variable aya number inside a separator). |

---

## 6. Data model

All in `backend/api/models.py`. `BaseModel` gives every domain table a **UUID PK**
+ `created_at`/`updated_at`. Reference tables use small-int PKs. Relationship spine:

```
Mushaf ─┬─< Template            (unique per mushaf+type)
        ├─< ProcessingRun ─< (Page.last_run, SET_NULL)
        ├─< Page ─< Line ─┬─< Segment
        │                 └─< EraseStroke
        └─< ActivityEvent

Reference: CountingSystem ─< Qiraa,  Sura ─< SuraAyaCount >─ CountingSystem
Mushaf.qiraa → Qiraa (SET_NULL);  Line.sura → Sura (SET_NULL)
```

### Reference tables (int PK, user/seed-owned)

- **`CountingSystem`** — `name`, `name_arabic` (both unique). The aya-numbering schools.
- **`Qiraa`** (`db_table="qiraa"`) — `name`, `name_arabic`, `description`,
  `counting_system` (FK). ~20 seeded/managed by the user; each maps to one counting system.
- **`Sura`** (`db_table="sura"`, PK = `number` 1..114) — `name_arabic`, `transliteration`.
- **`SuraAyaCount`** — `sura` (FK), `counting_system` (FK), `count`. **Unique
  `(sura, counting_system)`.** Aya counts are per counting system.

### Domain tables (UUID PK)

- **`Mushaf`** (`db_table="mushaf"`) — `name` (unique), `pdf_file` (→ `media/mushafs/`),
  `pdf_original_name` (as uploaded; the stored file is renamed to `<sha256>.pdf`),
  `pdf_sha256`, `pdf_page_count`, `thumbnail` (→ `media/thumbnails/`, cover render of
  physical page 1), `first_quran_pdf_page` (default 1), `last_quran_pdf_page`,
  `qiraa` (FK SET_NULL).
- **`Template`** (`db_table="template"`) — `mushaf` (FK), `type`
  (`sura_header` | `aya_separator`), `image` (→ `media/templates/`), `ignore_rects`
  (JSON `{x,y,w,h}` **relative to the template crop**, or `{}`). **Unique `(mushaf, type)`.**
- **`ProcessingRun`** (`db_table="processing_run"`) — `mushaf` (FK),
  `settings` (JSON: padding, expected_lines, sura_header_slots, sura_header_threshold,
  max_sura_headers, match_threshold, alternate_horizontal_margin, prefer_acceleration,
  start_sura, start_aya, **bounds**), `page_range_start`, `page_range_end`,
  `status` (`completed` | `aborted_line_detection` | `error`), `abort_info`
  (**TextField** storing a JSON string of the engine abort detail, or `""`),
  `log_path` (relative to `settings.LOG_DIR`, the per-run detailed log; migration 0011).
- **`Page`** (`db_table="page"`) — `mushaf` (FK), `page_number` (logical),
  `source_pdf_page` (nullable per-page override), `last_run` (FK SET_NULL),
  `bbox_x/y/w/h` (the crop column; nullable), `reviewed` (bool — set True on review
  save, reset False on (re)process). **Unique `(mushaf, page_number)`.**
  **Invariant: a Page row exists iff the page has data** (i.e. "processed").
- **`Line`** (`db_table="line"`, `ordering=("line_number",)`) — `page` (FK),
  `line_number`, `type` (`text` | `sura_header` | `besmella`), `sura` (FK SET_NULL),
  `line_png` (→ `media/lines/`, set on export), `bbox_x/y/w/h`.
- **`Segment`** (`db_table="segment"`, `ordering=("segment_order",)`) — `line` (FK),
  `segment_order` (1-based, **right→left**), `bbox_x`, `bbox_w` (y/h inherited from
  the line), `has_separator`, `aya_number` (derived).
- **`EraseStroke`** (`db_table="erase_stroke"`) — `line` (FK), `brush_size` (default 12),
  `points` (JSON `[[x,y],…]` in page-pixel space).
- **`ActivityEvent`** (`db_table="activity_event"`) — `mushaf` (FK),
  `type` (`mushaf_created` | `bounds_set` | `template_saved` | `run_finished` |
  `review_saved` | `lines_exported`), `payload` (JSON, keyed by type).

### Media layout (`backend/media/`, served at `/media/`)

`mushafs/<sha>.pdf` · `templates/<type>.png` · `thumbnails/<sha>_thumb.png` ·
`lines/<mushaf>_p####_l##.png` · `run_debug/<token>/…` (per-line abort debug PNGs).
Page images are **not** stored — rendered on demand at 300 DPI.

### Reference-data seeding (`services/suras.py::seed_reference_data`, idempotent)

- Reads one committed snapshot, **`backend/api/data/reference_data.json`**, and upserts
  **counting systems, qiraat, suras and per-counting-system aya counts** — every row by
  its natural key (counting systems/qiraat by `name`, suras by `number`;
  `update_or_create` bootstraps a fresh/test DB, never clobbers existing rows). This is
  what gives a fresh DB its qiraat (the mushaf picker needs them).
- Regenerate the snapshot from a filled DB with **`python manage.py export_reference_data`**,
  then commit it. `counting-systems.json` at the repo root is documentation, **not**
  consumed by the seeder.

---

## 7. The core CV engine (`backend/core/`)

Pure Python: PIL/NumPy/OpenCV in, plain dicts out. No Django, no ORM. Writes files
only when handed explicit `output_path`/`log_path`. This is the heart of the tool.

### 7.0 Data structures (`context.py`)

- **`BBox`** — `left/top/right/bottom` with `width`, `height`, `as_xywh()`,
  `as_slice()` (returns numpy `(row_slice, col_slice)` for **zero-copy** views).
- **`SegmentResult`** — `bbox`, `has_separator`, `sura_number?`, `aya_number?`, `is_continuation`.
- **`LineResult`** — `bbox`, `line_index` (1-based), `slot_count`, `is_sura`,
  `is_besmella`, `segments[]`, plus sura fields populated by the tracker.
- **`PageContext`** — everything for one page: source PIL `image`, `grey` + `binary`
  arrays (computed once), `crop_box`, `lines[]`, and detection diagnostics
  (`detected_headers`, `text_regions`). Accessors return **zero-copy numpy views**;
  PIL crops are deferred to export time.
- **`QuranTracker`** — cross-page numbering state: `current_sura`, `current_aya`,
  `pending_besmella`. `advance_sura()` (→ next sura, aya=1, flag besmella),
  `advance_aya()`. Created once per run and threaded through every page.

### 7.1 Pipeline stages (order of operations)

For each page, `PageProcessor.process` runs:

**Stage 1 — Detect lines (`line_detector.py` + `line_cutter.py` + `sura_header.py`).**

1. **Crop.** Compute the crop rectangle from `bounds`. If
   `alternate_horizontal_margin` is on **and** the page index is even, the crop is
   **mirrored horizontally** (`crop_x = img_w - (x + w)`) — for editions where facing
   pages mirror their inner/outer margins. (The frontend previews this flip; parity
   is anchored to the batch's first page — see [§12 Process](#step-3--process).)
2. **Protect sura headers first (`SuraHeaderLocator.locate`).** `TM_CCOEFF_NORMED`
   template-match the sura-header template across the cropped grey; keep the highest-
   scoring peaks ≥ threshold, deduped by a `~1.75×template_height` minimum vertical
   gap, capped at `max_sura_headers`. Each becomes a protected band of `slot_count`
   slots. This runs *before* line splitting so ornamental headers are never split as
   text.
3. **Allocate remaining slots.** `text_slots = expected_lines − Σ header slots`.
   The non-header vertical ranges are found (`_content_regions`), tiny regions
   dropped, and the remaining `text_slots` are distributed across regions
   **proportionally to their content height**.
4. **Valley split (`split_by_valleys`).** Within each region, split into exactly N
   line boxes by the **horizontal projection profile**: sum ink per row on the
   cleaned binary, smooth with a 75-px moving average, find local minima, score each
   by **topographic prominence** (`min(left wall, right wall) − valley depth`), and
   pick the `N−1` most prominent valleys subject to a minimum separation
   (`0.8 × nominal line height`). No global threshold or min-height parameter —
   the answer is read directly from each page's ink distribution. Header bands are
   re-inserted and all bands sorted top→bottom.

   > **Abort condition:** if `Σ slot_count` over detected lines ≠ `expected_lines`
   > (or zero lines), the page fails with `line_count_mismatch` / `no_lines`. The
   > processor saves per-line debug PNGs, attaches page-coordinate diagnostics
   > (headers with scores, text regions, each line's box+slots), and the pipeline
   > **aborts the rest of the batch** (remaining pages marked `skipped_batch_abort`).

**Stage 2 — Split aya segments (`aya_separator.py`).** For each non-header,
non-besmella line: compute the tight content bbox; if the content is "short"
(narrower than `short_line_ratio = 0.98` of the line), restrict detection to the
content region. Template-match the **aya-separator** template across the line
(`locate_x_matches`, `TM_CCOEFF_NORMED`, dedup by `min_gap`), then cut at the
**left edge** of each separator so the ornament stays with the aya it terminates.
Segments are created **right→left**; slivers below `min_segment_width` are dropped.

**Stage 3 — Track sura/aya (`coordinate_exporter.py::track_positions`).** Walk lines
left-to-right-in-index-order, mutating the `QuranTracker`:
- **Sura header:** advance to the next sura **only if `current_aya != 1`** (at batch
  start `start_aya==1` means the first header marks the *current* sura, not the
  next); tighten the header bbox to its content (±10 px). Sets `pending_besmella`.
- **Besmella:** the **first line after a sura header that has no separator** is
  reclassified as besmella (there is *no* besmella template; it is inferred here).
  If that line *does* have a separator, it is treated as normal text.
- **Text:** assign `current_sura`/`current_aya` to each segment; a segment with a
  separator **completes** the aya (then `advance_aya()`), one without is a
  **continuation**. Warns if `current_aya` exceeds the sura's expected max.

**Stage 4 — Export/collect.** The web flow sets `export_images=False`,
`export_coordinates=True`, so it calls `collect_page_coordinates` → a JSON-able
dict of the page's crop box + per-line data (type, sura/aya, `separator_cuts`,
per-segment bboxes). Text-line bboxes use the **union of segment extents** (avoids
empty horizontal margins). Detection padding is re-added as breathing room.
(The `export_images=True` path — writing named PNGs directly — exists for the CLI
lineage but is unused by the API.)

### 7.2 Template matching & acceleration

- **`template_matching.py`** — `make_template_spec` converts a PIL template to a
  grayscale array and (optionally) an ignore **mask**. `match_template` runs
  `TM_CCOEFF_NORMED`; `locate_x_matches` reduces a match map to x-positions of
  separators; `match_template` for headers keeps the full 2-D score map.
- **`opencv_accel.py`** — chooses CPU vs **OpenCL (`cv2.UMat`)** from the
  `OPENCV_ACCEL` env var (`auto`/`cpu`/`opencl`). Because OpenCL `matchTemplate`
  doesn't support masks, when `prefer_acceleration` is on the ignore region is
  **filled with the template's mean** instead of masked (keeps the fast path); when
  off, the true mask is used on CPU. Selection is logged once at pipeline start.

### 7.3 Config dataclasses (`config.py`) and the factory (`builder.py`)

`CropConfig(x,y,w,h)`, `ProcessingConfig(alternate_horizontal_margin)`,
`DetectionConfig(padding, sura_header_slots, sura_header_threshold=0.90,
besmella_threshold=0.70, max_sura_headers=3)`, `ExportConfig(export_images,
export_coordinates, start_sura, start_aya, expected_lines=15)`. `builder.init_configs`
+ `build_pipeline` assemble a `LineDetector` + `AyaSeparatorProcessor` +
`SuraHeaderLocator` into a `Pipeline`. (Note `besmella_threshold` is defined but the
current flow infers besmella positionally, not by template.)

> ⚠ **Default drift to be aware of.** Threshold defaults differ by layer:
> `DetectionConfig.sura_header_threshold=0.90` and `AyaSeparatorConfig.match_threshold=0.35`
> (dataclass defaults), vs `builder.init_configs` (`0.60`) vs the API `ProcessIn`
> schema (`sura_header_threshold=0.6`, `match_threshold=0.5`) vs the frontend
> `DEFAULT_PROCESS_SETTINGS` (`0.9` / `0.35`). The **request values win** at runtime;
> the dataclass defaults only apply if a caller omits them.

---

## 8. The service layer (`backend/api/services/`)

The only layer that touches the ORM. Serializes to plain dicts so views and engine
stay decoupled from models.

- **`pdf.py`** (pure, no ORM) — `sha256_of`, `page_count`, `render_page(path, index,
  dpi=300)` (via `fitz`), and **`logical_to_pdf_index(first, page_number, override)`**
  (the logical→physical mapping; `override` = per-page `source_pdf_page`).

- **`mushaf.py`** — mushaf CRUD + templates + thumbnail + stats, all ORM-annotated to
  avoid N+1. `create_mushaf` (hash + page count, unique name → 409, dup-file warning,
  cover thumbnail, `mushaf_created` event), `update_mushaf` (PATCH semantics; **bounds
  are locked once any page exists** → 409), `get_mushaf_detail` (adds counting-system
  total + pdf url/size/name), `upsert_template` (image optional to edit only the
  ignore region), `render_page_image` (on-demand PNG), `mushaf_stats`,
  `regenerate_thumbnail`, `list_mushafs` (optional case-insensitive qiraa filter).

- **`processing.py`** — the **only place ORM meets the pure engine**. Loads the two
  required templates, builds the pipeline from request settings, renders the page
  range, runs the pipeline **outside** any transaction, then in **one atomic block**:
  creates the `ProcessingRun`, writes each coordinate page via
  `coordinates.write_coords_to_page`, and emits `run_finished`. Writes a per-run log
  to `logs/runs/<token>.log` and abort-debug PNGs to `media/run_debug/<token>/`
  (their `/media/...` URLs are attached to `abort_info.debug_images`). Also
  `list_runs` (chronological `run_number`, parses `abort_info` back from JSON) and
  `run_log_file` (path-validated log fetch).

- **`coordinates.py`** — ORM ⇄ coordinate mapping. `write_coords_to_page` (engine dict
  → Page/Line/Segment rows, replacing prior rows; clears `reviewed`), `page_to_dict`
  (rows → editor dict; flat bbox fields; includes each line's `erase_strokes`),
  **`page_column`** (the uniform-width crop column: the stored crop box, else the
  **union of line boxes** for manual pages), and **`renumber_from`** (server-side
  forward renumbering — see [§9](#9-the-numbering-model-the-subtle-part)).

- **`editing.py`** — the review/finalize orchestration:
  - `get_page_data` / `list_pages` (extended per-page summaries with sura lists).
  - `save_page` — single-page save; rewrites rows then **`renumber_from`**; emits
    `review_saved` on the first review since processing.
  - `save_finalize` — applies the cut layer: a **Y/H-only** line bbox override (X/W
    untouched = content extent) + erase strokes. Never renumbers.
  - **`review_data`** — the whole-document payload for the Review session. Built with
    3 flat `.values()` queries (pages, lines, only `has_separator` segments as cuts)
    → a **slim** shape: each page has `bbox` (the column), `reviewed`, `run_start`
    (the run's start sura/aya = the island seed), and lines carrying only
    type/sura/bbox/`cuts[]`. `start` = logical page 1's entry state.
  - **`bulk_save`** — persist edited pages + review flags in one transaction. **Stores
    sura/aya VERBATIM (no `renumber_from`)** because the review client owns numbering.
    Data writes do **not** flip `reviewed`; only `reviewed_pages` does. Emits a single
    or range `review_saved`. Returns fresh `review_data`.

- **`export.py`** — `export_lines` renders the page, crops each line to the page
  **column** (`coordinates.page_column`), makes white→transparent, punches erase
  strokes out of the alpha, saves to `media/lines/`, records `line_png`, emits
  `lines_exported`. `coordinates_json` assembles the downloadable **`aya-bbox/v1`**
  document (one entry per aya per page in reading order; an aya's rects are its
  segments' boxes with x/w from the segment and y/h from its line).

- **`activity.py`** — `emit` (write one event) + `list_events` (newest-first, limit
  clamped 1..200).

- **`suras.py` / `qiraat.py` / `counting_system.py`** — reference-data reads +
  `seed_reference_data` (see [§6](#6-data-model)).

---

## 9. The numbering model (the subtle part)

Aya numbers are **derived, never manually typed**. There are **two** derivation
paths that must stay behaviorally identical:

### A. Server-side, single-page save (`coordinates.renumber_from`)

Used by `POST /pages/{n}` (`save_page`). Seeds from the previous consecutive page's
**exit state** (or the page's run `start_sura`/`start_aya` for the first page), then
walks forward through consecutive pages recomputing sura/aya, **stopping at a
page-number gap or once a page yields no change** (convergence). Rules:
- a `sura_header` does `sura += 1; aya = 1` **only when `aya != 1`**;
- a `text` segment takes the running aya; `has_separator` increments it.

### B. Client-side, whole-mushaf Review (`frontend/src/lib/review/recompute.ts`)

Used by the Review session; `bulk_save` then stores the result **verbatim**. It is a
**faithful port** of the server rule with two additions:

- **Island seeding.** A page starts a new "island" when it's page 1 **or** the
  previous page has no lines (a gap breaks propagation). At an island start the
  running counter resets to the page's **`run_start`** seed (page 1 uses the document
  `start`). So the first processed page *after a gap* begins where its processing run
  specified — not carried across the gap, not renumbered from 1.
- **Explicit sura anchor on headers.** A `sura_header` line may carry an editable
  `sura` anchor (a dropdown). Anchoring resets the running sura to that value and
  `aya = 1`; otherwise it auto-advances (only when `aya != 1`). There is **no manual
  aya field** — add a header to reset, add separators to count.

The client also derives per-qiraa **overflow warnings** (aya exceeds the sura's
count for the current qiraa) and **boundary warnings** (a header advanced while the
previous sura ended at the wrong aya). Segment geometry is derived from line bbox +
separator cuts (`deriveGeometry`), never stored — mirroring the engine's right→left
cut semantics.

> **Why two paths?** Single-page editing is cheap to renumber server-side. The
> whole-mushaf editor needs instant, offline-feeling numbering across hundreds of
> pages with manual anchors and islands, so it owns the computation and the server
> trusts it. Keep `recompute.ts` and `coordinates.py::renumber_from` in sync.

---

## 10. HTTP API reference

Base `/api` (Django Ninja). Interactive docs at `/api/docs`. UUIDs are strings.
Media URLs use a leading-slash absolute path helper (`_media_url`) because
`MEDIA_URL="media/"` would otherwise make `FieldFile.url` relative and break in the SPA.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/counting-systems` | `[{name, name_arabic}]`, case-insensitive name order |
| GET | `/api/qiraat?lang=ar` | `[{name, counting_system}]`; `lang=ar` switches labels to Arabic |
| GET | `/api/suras?qiraa=hafs` | `[{number, name_arabic, transliteration, aya_count}]`; qiraa case-insensitive; count from its counting system (null if none) |
| GET | `/api/mushafs?qiraa=…` | `[MushafOut]` newest-first (annotated counts, `thumbnail_url`); optional qiraa filter |
| POST | `/api/mushafs` | multipart `pdf` + `{name, qiraa?, first_quran_pdf_page=1, last_quran_pdf_page?}` → `201 {mushaf, warnings:{duplicate_file}}`; dup name → 409 |
| GET | `/api/mushafs/{id}` | **`MushafDetailOut`** = MushafOut + `counting_system{name,name_arabic,total_ayat}|null`, `pdf_url`, `pdf_file_size`, `pdf_original_name` |
| PATCH | `/api/mushafs/{id}` | name / qiraa / bounds (only sent fields; bounds locked once pages exist → 409) |
| DELETE | `/api/mushafs/{id}` | `204` (cascades) |
| GET | `/api/mushafs/{id}/stats` | `{lines_cut, segments, ayat_found, sura_headers, besmella_lines, exported_pngs}` (ayat_found = segments with a separator) |
| GET | `/api/mushafs/{id}/runs` | `[RunOut]` newest-first (`run_number` oldest=1, `pages_saved`, `settings`, `abort_info|null`, `log_url|null`) |
| GET | `/api/mushafs/{id}/runs/{run_id}/log` | the run's detailed log file as `text/plain` (404 if missing/foreign) |
| GET | `/api/mushafs/{id}/activity?limit=50` | `[{id, type, payload, created_at}]`, newest-first (limit 1..200) |
| GET | `/api/mushafs/{id}/coordinates` | **`aya-bbox/v1`** JSON **attachment** (per-aya rects in reading order) |
| POST | `/api/mushafs/{id}/thumbnail` | regenerate cover thumbnail → `MushafDetailOut` |
| GET | `/api/mushafs/{id}/templates` | `[TemplateOut]` (rehydrate the editor) |
| PUT | `/api/mushafs/{id}/templates/{type}` | multipart; **`image` optional** (omit to update only the ignore region); `ignore_x/y/w/h` all-or-nothing → `TemplateOut` |
| GET | `/api/mushafs/{id}/pages/{n}/image` | `image/png` — logical page `n`, rendered on demand |
| GET | `/api/mushafs/{id}/pages` | extended summaries `[{page_number, reviewed, source_pdf_page, lines, ayat, segments, has_header, suras[]}]` |
| GET / POST | `/api/mushafs/{id}/pages/{n}` | `PageDataOut` (empty lines if unprocessed) / save one page (server renumbers forward; first save emits `review_saved`) |
| GET | `/api/mushafs/{id}/review-data` | whole-document slim payload `{start, pages:[ReviewPage]}` — hand-serialized `JsonResponse` (skips Pydantic re-validation for speed) |
| POST | `/api/mushafs/{id}/pages/bulk` | `{pages:[{page_number,bbox,lines}], reviewed_pages:[int]}` → one transaction; **verbatim numbering**; returns fresh review-data |
| POST | `/api/mushafs/{id}/pages/{n}/finalize` | cut layer `{lines:[{line_number, bbox_override?, erase_strokes[]}]}` → Y/H-only override + strokes → `PageDataOut` |
| POST | `/api/mushafs/{id}/pages/{n}/export-lines` | write transparent line PNGs (cropped to the column, white→transparent, strokes punched) → `ExportOut` |
| POST | `/api/mushafs/{id}/process` | run the CV pipeline over a page range; **synchronous**, chunked by the client (50 pages/call); may abort on a line-count mismatch |

`MushafOut = {id, name, qiraa, pdf_page_count, first_quran_pdf_page,
last_quran_pdf_page, logical_page_count, processed_page_count, reviewed_page_count,
thumbnail_url, created_at, updated_at}`.

**Cross-cutting middleware:** `GZipMiddleware` (the review-data payload is large),
`corsheaders` (all origins), and Ninja's `fix_request_files_middleware` (so files
can be read on PUT/PATCH, not just POST).

---

## 11. Frontend architecture

### Routing & state

- **File-based routing** via `@tanstack/react-router`; the plugin generates
  `routeTree.gen.ts` from `src/routes/*`. `router.tsx` wires a `QueryClient` into
  router context; `__root.tsx` provides `QueryClientProvider` + `<Toaster/>` + 404/error boundaries.
- **All server state is React Query** (`lib/api/queries.ts`). Shared `queryKeys`
  factory; hooks: `useMushaf(s)`, `useTemplates`, `useProcessedPages`/`usePageSummaries`
  (same cache entry, different `select`), `useRuns`, `useStats`, `useActivity`,
  `useQiraat`/`useSuras` (`staleTime: Infinity`), `usePage`.
- **`lib/api/`** mirrors the backend contract: `types.ts` is a hand-maintained
  TypeScript mirror of the Ninja schemas (bbox on lines/segments is **flat**
  `bbox_x/y/w/h`; page/template bounds use nested `{x,y,w,h}` `Rect`); `http.ts` has
  `apiGet/apiJson/apiForm/apiDelete`, the `ApiError` class (carries HTTP status), and
  `mediaUrl`/`API_BASE` (overridable via `VITE_API_BASE_URL`).

### Design system (`styles.css`)

Light-only, token-based. Design tokens are **oklch** CSS variables (`--navy`,
`--orange`, `--success/warning/error`, text/border/bg ramps, shadows), mapped into
both shadcn semantic names and Raqam-specific utility colors through Tailwind 4's
`@theme inline`. Radii and a dot-grid canvas backdrop (`.raqam-canvas-grid`) are
tokens too. Codename in the CSS header: **"Raqam."**

### Notable client-state patterns

- **Review store built once per mushaf.** The review-data query has its **own key**
  (`["review-data", id]`, `refetchOnWindowFocus:false`); the editing store is built
  exactly once (`builtForRef`) so later refetches/invalidations never wipe in-flight
  edits. Undo/redo history **and index live in one state object** updated
  *functionally*, so rapid drag events can't corrupt the pointer (500 ms coalescing).
- **Fire-and-forget saves.** Review "Save changes" POSTs dirty pages + pending review
  flags, then reconciles only cleanly round-tripped pages from the server response
  (a page edited mid-save stays local + dirty). "Mark reviewed → next" is
  **client-only** (instant nav; persisted later).
- **Leave guards.** Review and Finalize use `useBlocker` + `beforeunload` to confirm
  before discarding unsaved edits.

---

## 12. The 5-step workflow + details hub

Navigation: **Home → Mushaf Details (`/mushafs/:id`) → Setup → Templates → Process →
Review → Finalize.** Every mushaf page shares one top bar, **`MushafHeader`**
(breadcrumb → hub, status pill, a **status-aware 5-step nav** with done ✓ / current /
to-do markers, and `Continue →` / `PDF ↗` / `JSON ↓` actions). The workspace layout
(`mushafs.$mushafId.tsx`) renders the header for the step routes and passes the index
child through as a bare `<Outlet/>`; the details hub renders `MushafHeader` itself.

### Home (`index.tsx`)

Thumbnail-card grid (cover from `thumbnail_url`, falling back to an on-demand page-1
render), a status badge via `mushafStatus()` (`empty`/`partial`/`processed`/
`completed` — completed = all pages reviewed), per-card delete, and a dashed
**add-card** → `CreateMushafDialog` (real qiraa dropdown fed by `GET /api/qiraat`).

### Details hub (`mushafs.$mushafId.index.tsx` + `components/app/details/`)

The "enhanced Cockpit" layout: **`MushafHeader`** with a derived **Continue →** CTA
(Templates → Process → Review(first unreviewed, deep-linked `?page=N`) → Finalize;
fresh mushaf → Setup), a **282 px rail** (`DetailsRail`: cover, name, qiraa +
counting, processed/reviewed progress, stat trio, template thumbnails, record kv,
per-page coverage map), and **5 tabs**: `Overview` (clickable pipeline strip +
Activity feed + abort-warning with Resume), `Pages` (filter/sort table, sura names,
Open → Review), `Runs` (settings kv, outcome, `abort_info`, Resume/Re-run), `Export`
("Export all lines" loops `export-lines` with progress; JSON download; completeness
warning), `Settings` (name/qiraa PATCH, bounds locked-once-processed, thumbnail
regenerate, danger zone). Derivations live in `details/helpers.ts` (`pipelineSteps`,
`continueTarget`, `runAbortPage`, activity formatting).

### Step 1 — Setup (`.setup`)

The **`FilmstripViewer`** (peeking-neighbour filmstrip, floating page-jump). Mark
`first_quran_pdf_page` / `last_quran_pdf_page` → PATCH (auto-advances to the last
page after marking the first). **Bounds lock once any page is processed.**

### Step 2 — Templates (`.templates`)

Three columns: **`PageStage`** canvas | center workspace (`TemplatePreview` large
preview + `RectInputs` X/Y/W/H + Capture) | per-target cards (each: thumbnail, saved
indicator, Re-crop, Add/Edit-ignore, Save). Captures are cropped client-side
(`cropUrlToBlob`) and persist across in-app navigation via **`lib/templateDraft.ts`**
(in-memory). Ignore regions are validated to sit inside the parent crop; saved
ignore rects are stored **relative to the crop**. Fetched templates rehydrate via
`useTemplates`.

### Step 3 — Process (`.process`)

`PageStage` (draw the crop `bounds`) + a center bounds preview + a settings panel
(Bounds, Page range, Starting position with sura/aya selects, collapsible Detection
settings: padding, expected lines, header slots/threshold, max headers, aya
threshold, **alternate margins**, **prefer acceleration**). Loops the pipeline in
**50-page chunks**, threading each chunk's `end_sura`/`end_aya` into the next start.
On abort it shows `AbortDiagnostics` (the per-line debug PNGs + a link to the run
log). Optional `?run=<id>` pre-fills from a stored run; `?from=<page>` overrides the
start (Resume). The **alternate-margin flip is previewed** exactly as the engine
applies it (parity anchored to `rangeStart`; chunk size 50 is even so parity holds).

### Step 4 — Review (`.review?page=N`)

The whole-mushaf editing session on **`ReviewEditCanvas`** (drag/resize line boxes
with 8 handles, double-click a text line to add a separator, drag the red separator
bars, magnifier lens on drag). Loads once via `GET /review-data` into a client store
holding **ALL logical pages 1..N** — blank/unprocessable pages are editable (manual
processing; saving a manual page creates its `Page` row). **The client owns
numbering** (islands + header sura anchors + separator-derived aya; see [§9](#9-the-numbering-model-the-subtle-part)).
Undo/redo (Ctrl+Z/Y), free page nav, dirty + reviewed-pending tracking, `useBlocker`
guard. Right `Aside`: line list (+ add Text/Sura/Besmella) and a selected-line editor
(type, sura dropdown for headers, bbox via `RectInputs`, segment/separator
merge/remove, delete). Per-qiraa overflow/boundary warnings with a jump-to-next-warning
button. "Mark reviewed → next" marks the page **and its ending sura's span** reviewed
(client-only); "Save changes" is fire-and-forget `bulk_save`.

### Step 5 — Finalize (`.finalize?page=N`)

The **`FinalizeCanvas`** line-cut editor. Each line is composited **independently**
from its own source crop (near-white → transparent + its own erase strokes) and
**stacked**, so it renders exactly as it exports and erasing one line never touches
another. Tools: **Select** (drag a line's top/bottom edge to trim Y/H — X/W are the
shared page column), **Erase** (hold Shift; brush + undo/clear), **Hand** (hold
Space); White/Dark(white-ink)/Grid backgrounds; a drag-time magnifier; Ctrl+Z/Y. The
route owns the editable model + dirty/`useBlocker` guard. **Save cuts** (`finalizePage`,
Y/H-only, whole page) and **Save & export page** (`exportLines` → thumbnails). Bulk
export lives in the details Export tab. Manual front pages (no crop box) get a derived
column server-side so they render + export at uniform width.

### Canvas component library (`components/canvas/`, all reusable)

`PageStage` (zoomable/pannable page + toolbar + `ChevronNav` + `PageJump` +
`PageRail`), `PageCanvas`, `PageRail` (processed/reviewed indicators), `CropPreview`,
`TemplatePreview`, `FilmstripViewer` + `CroppableImage` (Setup), `ReviewCanvas`
(read-only overlay), `ReviewEditCanvas` (Review editor), `FinalizeCanvas` (stacked
line-cut editor), plus `RectInputs`, `ZoomControl`, `ToolToggle`, `PageJump`.

---

## 13. Build, run, and test

### Backend (from `backend/`)

```bash
uv sync
cp .env.dist .env                        # SECRET_KEY etc. (a dev default is built in)
uv run python manage.py migrate
uv run python manage.py seed_suras       # reference data (idempotent)
uv run python manage.py runserver 8000   # API at /api, docs at /api/docs, admin at /admin

uv run ruff check .
uv run python -m mypy .                   # NOTE: python -m (path has a space)
uv run python manage.py test api          # builds schema from models; migrations disabled under test
```

Optional env: `OPENCV_ACCEL=auto|cpu|opencl` selects the OpenCV compute backend.
Under tests, `MIGRATION_MODULES = {"api": None}` disables migrations (schema built
from models). Logging: console (INFO) + rotating `logs/quran.log` (DEBUG) + a per-run
`logs/runs/<token>.log`.

### Frontend (from `frontend/`)

```bash
npm install
npm run dev        # Vite :5173, proxies /api,/media → :8000
npm run build      # → frontend/dist (what Django serves in production)
npx tsc --noEmit   # type-check
npx eslint .       # lint
npm run format     # prettier
```

### Test coverage (backend, 120 tests / 13 files)

`test_mushaf` (28), `test_pages` (20), `test_views` (16), `test_validators` (10),
`test_finalize` (6), `test_pdf` (6), `test_suras` (6), `test_activity` (5),
`test_coordinates` (5), `test_export` (5), `test_processing` (5), `test_qiraat` (5),
`test_renumber` (3). Helpers (`tests/helpers.py`): `make_pdf_bytes`, `make_png_bytes`,
`MediaTestCase`, `bare_mushaf`. (No automated frontend test suite; the user does live
runtime testing — Claude runs static checks only.)

---

## 14. Invariants & conventions

These are load-bearing. Violating them silently breaks things.

1. **Layering.** views (schemas only) → services (ORM + orchestration) → core (pure).
   Views never import models; core never imports Django. `processing.py` is the sole
   ORM↔engine bridge.
2. **A `Page` row exists iff the page has data.** "Processed page count" = `Page`
   rows. Manual review pages create rows on save.
3. **Logical vs physical pages.** Logical page 1 = `first_quran_pdf_page`. Physical =
   `first_quran_pdf_page + logical − 1`, unless a page has a `source_pdf_page` override.
   Always map via `pdf.logical_to_pdf_index`.
4. **Bounds are immutable once processed** (would desync stored pages' logical↔physical
   mapping). Revert = reprocess.
5. **Numbering is derived, never typed.** Keep `recompute.ts` (client) and
   `renumber_from` (server) behaviorally identical. `bulk_save` trusts the client;
   `save_page` renumbers server-side.
6. **Segments store only x/w** (y/h inherited from the line); order is **right→left**;
   a separator belongs to the aya on its right and **completes** it.
7. **Finalize overrides are Y/H-only.** X/W always come from the page column
   (`coordinates.page_column`), so all line PNGs share width and left edge.
8. **Media URLs need a leading slash.** Use the `_media_url` helper (backend) /
   `mediaUrl` (frontend); raw `FieldFile.url` is relative and breaks in the SPA.
9. **Every mutation emits an `ActivityEvent`** at its commit point.
10. **`reference_data.json` (`backend/api/data/`) seeds every reference table** by natural
    key (`name` / `number`); regenerate it via `manage.py export_reference_data`.
    `counting-systems.json` is documentation only.
11. **Ninja `response=` schemas re-validate output.** `review-data` and `bulk-save`
    deliberately hand-serialize with `JsonResponse` to skip that on the large payload.

---

## 15. Known issues, gaps & legacy code

- **`core/review.py` and `core/cut_review.py` are LEGACY CLI-era helpers.** They read
  local `results.json` / `corrected_results.json` / `results/pages/*` files from disk
  — a **file-based** review workflow that predates the DB-backed web app. The web flow
  does **not** use them for review/finalize (that path is `services/editing.py` +
  `coordinates.py`). The *only* live coupling is `services/export.py` importing the
  pure helper `core.cut_review._apply_eraser_stroke` (draw an erase stroke into an
  alpha channel). Treat the rest of those two modules as vestigial; don't extend them.
- **`README.md` status is stale.** Its "frontend being rewired / consumed directly via
  `/api/docs`" note predates the finished SPA. The 5-step React app is complete.
- **`PROJECT_HANDOFF.md` predates a few commits** (magnifier lens, slim review payload,
  per-run logging + `log_path`, unified header, mirrored alternate-margin preview) and
  says 119 tests; the current count is **120**.
- **Threshold default drift** across layers (see [§7.3](#73-config-dataclasses-configpy-and-the-factory-builderpy)) — request values win, but the mismatch is a footgun.
- **Processing is synchronous.** A full mushaf is processed by the client looping
  50-page chunks. No background/async queue yet.
- **Manual pages carry a 1×1 placeholder bbox**, so their finalize/export column is
  **derived** from the union of line boxes. Fine; could be frozen in `bulk_save` if desired.
- **Activity feed starts empty** for mushafs created before the event table existed
  (migration 0009); no backfill.
- **Coverage map** renders one small cell per logical page (500+ divs for a full
  mushaf) — fine locally; virtualize if it ever feels heavy.
- **Finalize perf** re-composites all line crops per frame (cheap for ~15 lines).
- **`besmella_threshold`** exists in `DetectionConfig` but the pipeline infers besmella
  positionally (first separator-less line after a header), not by template match.
- **No auth.** The tool assumes a trusted single-user/local context (Django admin
  aside). Don't expose it publicly without adding authentication.
- **Roadmap ideas** (from README): background processing, per-mushaf qiraa aya-count
  overrides, manual aya anchors.

---

## 16. File-by-file index

**Backend — `config/`:** `settings.py` (apps, GZip+CORS+Ninja-file middleware,
logging, media, SQLite) · `urls.py` (route order: admin/api/media/SPA) · `spa.py`
(dist serving) · `wsgi.py`/`asgi.py`.

**Backend — `api/`:** `api.py` (router registration) · `models.py` (all tables) ·
`common.py` (`RectSchema`, `EraseStrokeSchema`) · `validators.py` (bounds/page/range) ·
`admin.py`.

**Backend — `api/views/`:** `mushafs.py` (CRUD, templates, page image, stats,
activity, coordinates, thumbnail) · `pages.py` (page read/save, summaries, review-data,
bulk) · `processing.py` (process, runs, run log) · `finalize.py` (finalize, export-lines) ·
`suras.py`, `qiraat.py`, `counting_systems.py`.

**Backend — `api/services/`:** `mushaf.py`, `processing.py` (ORM↔engine bridge),
`coordinates.py` (mapping + `renumber_from`), `editing.py` (save/finalize/review-data/
bulk_save), `export.py` (line PNGs + aya-bbox JSON), `pdf.py` (render/hash/index),
`activity.py`, `suras.py`/`qiraat.py`/`counting_system.py`.

**Backend — `core/`:** `context.py` (data structures) · `config.py` (configs) ·
`image_utils.py` (binarize/content-bbox/transparent) · `line_cutter.py` (valley split) ·
`line_detector.py` (crop + header protection + slot allocation) · `sura_header.py`
(header locator) · `aya_separator.py` (segment splitter) · `template_matching.py` ·
`opencv_accel.py` (CPU/OpenCL) · `coordinate_exporter.py` (track_positions + collect) ·
`page_processor.py` (per-page orchestration + abort diagnostics) · `pipeline.py`
(batch loop + logging) · `builder.py` (factory) · `quran_metadata.py` (114-sura table) ·
`review.py`/`cut_review.py` (legacy).

**Frontend — `src/lib/`:** `api/types.ts` (contract mirror) · `api/http.ts` ·
`api/queries.ts` (React Query) · `api/{mushafs,pages,processing,suras,qiraat,index}.ts` ·
`review/model.ts` (edit store) · `review/recompute.ts` (client numbering) · `image.ts` ·
`templateDraft.ts` · `utils.ts`.

**Frontend — `src/routes/`:** `__root.tsx` · `index.tsx` (home) ·
`mushafs.$mushafId.tsx` (workspace layout) · `mushafs.$mushafId.index.tsx` (details hub) ·
`.setup` · `.templates` · `.process` · `.review` · `.finalize`.

**Frontend — `src/components/`:** `app/` (`MushafHeader`, `Panel`, `CreateMushafDialog`,
`AbortDiagnostics`, `details/*` + `helpers.ts`) · `canvas/*` (the reusable canvas
library) · `ui/*` (shadcn) · `hooks/*`.

---

*End of PROJECT_CONTEXT.md — a snapshot of the codebase at HEAD `0dfebc7`. When the
code and this document disagree, trust the code and update this file.*

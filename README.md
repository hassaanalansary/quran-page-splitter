# Quran Page Splitter

Digital Quran applications that render text with fonts cannot fully reproduce
the experience of reading a printed Mushaf. The core problem is that the written
Mushaf is a handcrafted calligraphic work: a single Arabic letter can take
different shapes depending on its position and context on the page, and lines are
visually justified to align at both edges in a way that text layout engines
cannot replicate. Implementing a faithful font requires encoding a unique glyph
for every character instance on every page, which is an enormous undertaking and
still falls short of the original.

The image-based approach sidesteps this entirely: applications display scanned
or photographed pages as-is, preserving every calligraphic detail and the exact
visual layout the reader knows from the printed copy. To make those images
interactive — highlighting an aya, jumping to a verse, playing audio in sync
with the text — the application needs two things: the bounding box of each aya
on each page, and the page cut into individual line images.

Serving whole page images also creates a responsive layout problem. If the page
is a single image, resizing the application window either stretches it or leaves
dead space. The solution is to display each line as its own image and let the
application adjust the spacing between lines to fill the available height. The
lines themselves scale uniformly to the window width, and the vertical gaps
absorb the remaining space, so the page always fills the screen without
distortion at any window size.

Quran Page Splitter produces both. It ingests a Mushaf **PDF**, renders pages on
demand, automatically detects lines and aya boundaries, lets the user review and
correct the output, and exports per-aya coordinates and transparent line PNGs
ready to be consumed by a Mushaf application. Every processed Mushaf is **stored
in a database**, so results accumulate instead of being overwritten.

## What It Does

- Stores an uploaded Mushaf **PDF** once and renders any page on demand by number.
- Processes a chosen **range of pages** with template + tuning settings.
- Crops each page to the main Mushaf text region.
- Detects line bands using horizontal projection valleys.
- Protects detected sura headers before line splitting so ornamental headers are
  not split as ordinary text.
- Detects aya separator ornaments inside text lines using template matching.
- Tracks sura and aya numbering across pages.
- Persists every page's lines/segments as queryable rows (no flat files).
- Lets the user review and correct coordinates per page; aya numbering is
  recomputed automatically.
- Lets the user paint eraser masks and export transparent line PNGs.

## Architecture

- **`backend/core/`** — the pure detection engine (binarize, crop, line
  detection, header protection, aya-separator matching, sura/aya tracking). No
  web framework, no database; operates on PIL images and returns plain dicts.
- **`backend/api/`** — a Django app exposing a **Django Ninja** API. Thin views
  call **service functions**, which are the only layer that touches the ORM and
  wires the engine to stored data (`api/services/`).
- **Database** — SQLite by default. Each Mushaf, its templates, processing runs,
  pages, lines, segments, and erase strokes are rows.
- **Media** — the source PDF, template crops, and exported line PNGs live under
  `MEDIA_ROOT` (`backend/media/`); the DB stores their paths. Page images are
  **rendered on demand** from the PDF and never stored.

> The React frontend in `frontend/` is currently being rewired to this API; for
> now the backend is consumed directly (e.g. via the interactive docs at
> `/api/docs`).

## Requirements

- Python `>= 3.13`
- [`uv`](https://docs.astral.sh/uv/)
- (Frontend, pending) Node.js

## Install & Run

```bash
cd backend
uv sync

# Configure environment (SECRET_KEY etc.). A safe dev default is built in.
cp .env.dist .env            # then edit as needed

uv run python manage.py migrate
uv run python manage.py seed_suras      # qiraat, suras, per-qiraa aya counts
uv run python manage.py runserver
```

- API root: `http://localhost:8000/api/`
- Interactive docs (OpenAPI): `http://localhost:8000/api/docs`

## Workflow (via the API)

1. **Create a Mushaf** — `POST /api/mushafs` (multipart) with the PDF, a unique
   `name`, the qiraa, and the PDF page where the Quran starts/ends
   (`first_quran_pdf_page` / `last_quran_pdf_page`). Logical page 1 maps to
   `first_quran_pdf_page`; front/back matter falls outside the bounds.
2. **Set templates** — `PUT /api/mushafs/{id}/templates/{type}` for both
   `sura_header` and `aya_separator` (a cropped image, plus an optional ignore
   rectangle). These are stored and reused across runs.
3. **Preview pages** — `GET /api/mushafs/{id}/pages/{n}/image` renders logical
   page `n` from the PDF.
4. **Process** — `POST /api/mushafs/{id}/process` with a page range, the
   starting `sura`/`aya`, the crop `bounds`, and detection settings. The engine
   runs and the resulting lines/segments are persisted; a `ProcessingRun` logs
   the settings. A line-count mismatch aborts the batch at that page.
5. **Review** — `GET /api/mushafs/{id}/pages/{n}` returns a page's coordinates
   (empty if not yet processed); `POST` the edited page back to save it. Aya
   numbers are **derived** and recomputed forward across pages on save.
6. **Finalize & export** — `POST /api/mushafs/{id}/pages/{n}/finalize` stores
   line bbox overrides + eraser strokes; `POST …/export-lines` writes the final
   transparent line PNGs and records their paths.

Tip: a full Mushaf is processed in chunks (e.g. 50 pages at a time) since
processing is synchronous.

## API Reference

| Endpoint                                          | Method     | Purpose                                            |
| ------------------------------------------------- | ---------- | -------------------------------------------------- |
| `/api/suras?qiraa=hafs`                           | GET        | Canonical suras + aya counts for a qiraa.          |
| `/api/mushafs`                                    | GET / POST | List / create (upload PDF; name collision → 409).  |
| `/api/mushafs/{id}`                               | GET / DELETE | Detail / delete (cascades).                      |
| `/api/mushafs/{id}/templates/{type}`              | PUT        | Upsert a `sura_header` or `aya_separator` template.|
| `/api/mushafs/{id}/pages/{n}/image`               | GET        | Render logical page `n` (PNG).                     |
| `/api/mushafs/{id}/process`                       | POST       | Process a page range and persist rows.             |
| `/api/mushafs/{id}/pages/{n}`                     | GET / POST | Read / save page coordinates.                      |
| `/api/mushafs/{id}/pages/{n}/finalize`            | POST       | Save bbox overrides + erase strokes.               |
| `/api/mushafs/{id}/pages/{n}/export-lines`        | POST       | Export transparent line PNGs.                      |

## Processing Inputs

The `/process` body carries the crop, templates (already stored), and tuning.

| Crop target            | Required | Meaning                                                                            |
| ---------------------- | -------- | ---------------------------------------------------------------------------------- |
| `bounds`               | Yes      | The main text area; the detector ignores margins outside it.                       |
| `sura_header`          | Yes      | Template crop of a sura header ornament (a stored template).                       |
| `aya_separator`        | Yes      | Template crop of one aya separator ornament (a stored template).                   |
| `*_ignore`             | No       | A rectangle inside a template to ignore during matching (e.g. a variable number).  |

| Setting                     | Default | Meaning                                                                 |
| --------------------------- | ------- | ----------------------------------------------------------------------- |
| `padding`                   | `4`     | Extra pixels above/below detected line boxes.                           |
| `expected_lines`            | `15`    | Expected line slots per page; a mismatch aborts the batch.              |
| `sura_header_slots`         | `1`     | Line slots a sura header occupies.                                      |
| `sura_header_threshold`     | `0.60`  | Template-match threshold for sura headers.                              |
| `max_sura_headers`          | `3`     | Maximum sura headers expected on a page.                                |
| `match_threshold`           | `0.50`  | Template-match threshold for aya separators.                            |
| `alternate_horizontal_margin` | `false` | Mirror the `bounds` crop on alternate (facing) pages.                 |
| `prefer_acceleration`       | `true`  | Use OpenCL-accelerated matching when available.                         |
| `start_sura` / `start_aya`  | —       | Sura/aya at the first processed page (edition-specific).                |

## How Detection Works

1. Binarize the page.
2. Crop to `bounds`.
3. Find protected sura header bands using the `sura_header` template.
4. Split remaining regions into the expected number of line slots via valley
   detection over the horizontal ink projection.
5. Detect aya separator positions inside non-header lines using the
   `aya_separator` template.
6. Split text lines right-to-left at separator cuts.
7. Track sura and aya numbers.

Aya separator semantics: segment order is right-to-left; a separator belongs to
the aya on its right; a segment with a separator **completes** the current aya,
one without is a **continuation**.

## Data Model

`mushaf` → `page` → `line` → `segment`, plus `template`, `processing_run`,
`erase_stroke`, and the reference tables `sura` / `sura_aya_count` (keyed by
`qiraa`). Highlights:

- `page.page_number` is the **logical** Quran page; the PDF page is
  `source_pdf_page` or `first_quran_pdf_page + page_number - 1`.
- A `page` row exists **iff** the page has data ("processed").
- `segment` stores only `bbox_x` / `bbox_w` (vertical extent is inherited from
  the line) plus `has_separator` and a derived `aya_number`.
- Line type is `text`, `sura_header`, or `besmella` (the engine's `basmala` is
  translated to this canonical spelling on persistence).
- Detection settings are **not** authoritative config — they are pipeline inputs,
  logged per run in `processing_run.settings` for audit.

## Numbering & Editing

Segments are edited **directly** (no separator-cut or anchor layer). Aya numbers
are derived from the segment structure and recomputed forward across consecutive
pages whenever a page is saved, seeded from the previous page's end or the run's
`start_sura`/`start_aya`. To revert a page to the machine output, reprocess it —
the stored PDF + settings make it reproducible.

## Tuning Guide

- **Wrong line count** — confirm `expected_lines`, raise `sura_header_slots` if a
  header spans multiple rows, and check `bounds`.
- **Missed / false sura headers** — adjust `sura_header_threshold`, crop the
  template more tightly, or define a `sura_header` ignore rectangle.
- **Missed / false aya separators** — adjust `match_threshold`, crop the
  separator template tightly, or ignore the inner aya number.
- **Empty horizontal margins** — text line boxes use the union of segment boxes;
  adjust line `bbox` in review if needed.

## Development

```bash
cd backend
uv run ruff check .
uv run python -m mypy .            # invoke via `python -m` to avoid launcher issues
uv run python manage.py test api   # builds the schema from the models
```

The test suite disables migrations for the `api` app (`MIGRATION_MODULES` under
`if "test" in sys.argv`), so tests run from the models directly and don't depend
on migration files. mypy uses the `django-stubs` plugin.

## Status / Roadmap

- Backend + API: **done** (mushaf management, PDF rendering, processing,
  review, finalize, export).
- Frontend: being rewired from the old image-upload SPA to this PDF-based API.
- Possible future work: background processing for full-Mushaf runs;
  per-mushaf qiraa aya-count overrides; manual aya anchors.

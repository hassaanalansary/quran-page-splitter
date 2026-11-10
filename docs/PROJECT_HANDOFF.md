# Quran Page Splitter — Project Handoff

The developer reference: how the project is laid out, what it stores, what the API
offers and the conventions it follows. How the two engines work, step by step on a
real page, is in [ENGINES_FLOW.md](ENGINES_FLOW.md); the full data export is in
[EXPORT_FORMAT.md](EXPORT_FORMAT.md). Where this page and the code disagree, the code
and `git log` win.

---

## 1. What this is

A web tool that turns a printed **Mushaf**, uploaded as a **PDF**, into assets for
**image-based Mushaf apps**: the lines, ayat and words of every page located on the
page image, every mark typed, and each page cut into transparent line PNGs that an
app can lay out responsively. Images rather than fonts, because printed calligraphy
is context-dependent and justified in ways a text engine cannot reproduce.

In the interface the tool is called **SATR** (سَطْر).

---

## 2. Architecture

- **Backend**: Django 6 + **Django Ninja**, PostgreSQL (`DATABASE_URL`; SQLite when it
  is unset), `pymupdf` to render pages, `opencv` / `numpy` / `pillow` for the engines,
  `django-allauth` (headless) for accounts. Managed with **uv**.
- **Frontend**: React 19 + Vite 7, **TanStack Router** (file-based) + **React Query**,
  Tailwind 4, Radix / shadcn UI, sonner toasts. Managed with **npm**.
- **Serving**: one origin in production. Django serves the built SPA
  (`frontend/dist`, `config/spa.py`), `/api`, `/media` and allauth's `/_allauth`. In
  development Vite (`:5173`) proxies `/api`, `/media`, `/_allauth` and `/accounts` to
  Django (`:8000`).
- **Layering**: view (Ninja schemas) → service (ORM and orchestration) → `core` (the
  engines). Views never touch the ORM; `core` never imports Django.
- **Auth**: session cookie (`django_auth`) on every router by default, with CSRF on
  unsafe methods. The reference-data routers and the gallery opt out (`auth=None`).
  The SPA drives allauth over JSON at `/_allauth/browser/v1/*`; allauth renders no
  HTML of its own (`HEADLESS_ONLY`).
- **Jobs**: long runs (line processing, word processing, batches) are `ProcessJob`
  rows run on a daemon thread and polled by the browser every second. One job per
  mushaf at a time (409 otherwise), a cap on concurrent jobs overall and per user
  (`MAX_CONCURRENT_JOBS`, `MAX_CONCURRENT_JOBS_PER_USER`), a heartbeat on every
  progress tick, and a job silent for `JOB_HEARTBEAT_TIMEOUT_SECONDS` (300) is marked
  `interrupted`. Cancelling sets a column that the worker reads between units.
- **Pages are rendered on demand** from the stored PDF and never stored; only a
  cover thumbnail is cached. Every meaningful change writes an `ActivityEvent`.

---

## 3. Repo layout

```
backend/
  config/      settings.py (.env via django-environ), urls.py, spa.py, logging
  accounts/    the User model (email is the identifier, no username)
  quran/       the Quran text and reference data: models, seed data, read-only views
  api/
    api.py     NinjaAPI and router registration
    models.py  mushafs, pages, lines, jobs, calibration, activity
    views/     mushafs, pages, processing, finalize, calibration, gallery, bundles (thin)
    services/  the only layer that touches the ORM (see below)
    management/commands/   see §10
    tests/
  core/        the engines, no Django
    page_detection/   the line engine: crop, sura headers, lines, aya ornaments, numbering
    word_boundary/    the word engine: ink, ornaments, alignment (span.py), library, mark check
    text/             what the Uthmani text says a word prints: PAWs, marks, pause signs
    imaging/          template matching and image helpers
frontend/
  src/routes/        file-based routes (see §7)
  src/components/    app/ (shell, details hub, dialogs, auth), canvas/, calibration/, ui/
  src/lib/           api/ (fetchers + React Query hooks), calibration/, review/, auth/, theme, prefs
  src/i18n/locales/  en.ts and ar.ts (every string in both)
docs/          ENGINES_FLOW.md, EXPORT_FORMAT.md, this page
```

The services, grouped:

| area | modules |
| --- | --- |
| mushafs and pages | `mushaf`, `pdf`, `editing`, `coordinates`, `line_images`, `activity` |
| line engine | `processing`, `run_logs`, `jobs` |
| word engine | `calibration` (process / save / confirm / preview), `calibration_snapshots`, `calibration_marks`, `calibration_library`, `calibration_batch`, `calibration_progress`, `word_inputs`, `word_runs` (preflight), `word_coordinates` (writes `LineWord`) |
| exports and sharing | `export` (line PNGs), `data_export` (`mushaf-export/v2`), `bundle` (`mushaf-work/v2`), `cloning`, `gallery` |

---

## 4. Dev commands and conventions

```bash
# backend (from backend/)
uv sync
cp .env.dist .env                          # SECRET_KEY is required: there is no fallback
uv run python manage.py migrate
uv run python manage.py seed_quran         # reference data, the word list, the aya maps
uv run python manage.py runserver 8000     # API at /api, docs at /api/docs

uv run ruff check .
uv run python -m mypy .                    # through python -m (mypy.EXE fails on the space in the path)
uv run python manage.py test --parallel 4  # ~700 tests, on the Postgres test database

# frontend (from frontend/)
npm install
npm run dev            # Vite :5173
npx tsc --noEmit
npm run lint
npm run build          # → frontend/dist
```

- **Tests** use the Postgres test database: never two runs at once, and a run that
  was killed leaves the database behind, so the next one needs `--noinput`.
- **Strings**: every UI string goes in both `en.ts` and `ar.ts`. `t()` is type-checked
  against `en` only, so a key missing from `ar.ts` falls back to English silently.
- **Line endings**: the working tree is CRLF (`core.autocrlf=true`).
- **Routes**: `routeTree.gen.ts` is generated; a `foo.index.tsx` needs a `foo.tsx`
  layout, or every `/foo` URL 404s.
- **Secrets** are in `backend/.env`, which is committed; `.env.dist` lists the keys with placeholders.
- **Code style** applies to new and touched code. Older modules are converted when a
  task reaches them.
  - A function name says what it does to what: verb + object + qualifier
    (`mark_silent_jobs_interrupted`, `record_job_progress`).
  - No generic names: `run`, `start`, `get`, `process`, `to_dict`, `helpers`, `utils`.
  - No leading-underscore functions. A helper that only makes sense inside one function
    is inlined; any other gets a real name and a home module.
  - One module, one job. Its docstring says where it sits in the flow, and its entry
    points come first, in call order.
  - A use case is one function whose body is the list of steps.
  - No closures that hide inputs: a job runner reads its inputs from the job row.
  - Import the function you call, not a module alias.

---

## 5. Data model

`BaseModel` gives a UUID primary key and timestamps; the reference tables use integer keys.

**`quran`** (reference data, seeded by `seed_quran`)

| model | what it is |
| --- | --- |
| `CountingSystem` | a school of aya numbering (kufi, basri, dimashqi, makki, madani-first, madani-last) |
| `Qiraa` | a reading, following one counting system |
| `Rawi` | a transmitter (Hafs an Asim, ...): what a mushaf is printed in, and what the API calls `qiraa` on the wire |
| `Sura`, `SuraAyaCount` | the suras, and their aya counts per counting system |
| `Word` | one word of the Uthmani text, numbered from 1 across the Quran; nothing in it depends on a counting system |
| `Aya` | where an aya starts, in one counting system |

**`accounts`**: `User` (email, no username).

**`api`**

| model | what it is |
| --- | --- |
| `Mushaf` | `owner`, `rawi`, `name` (unique per owner), the PDF (stored once as `pdfs/<sha>.pdf`), the Quran's first and last PDF page, `thumbnail`, `visibility` (`private` / `published`) and `published_at`, `ijam_mode`, `export_uniform_size`, `description`, `duplicated_from` |
| `Template` | one per mushaf and type: `sura_header`, `aya_separator`, `sajda`, `rub_hizb`; an image and optional ignore rectangles |
| `ProcessingRun` | one line-engine run: settings, page range, status, abort detail, log |
| `ProcessJob` | the live state of a background job: `kind` (`detection`, `calibration`, `calibration_batch`; `words` only for history), `state`, `phase`, progress, heartbeat, cancel flag |
| `Page` | a logical page with data: its crop box, `reviewed`, the run that made it |
| `Line` | `line_number`, `type` (`text` / `sura_header` / `besmella`), `sura`, its box, its exported PNG |
| `Segment` | a stretch of a line up to an aya ornament: `bbox_x`, `bbox_w`, `has_separator`, the derived `aya_number` |
| `EraseStroke` | a brush stroke erased from a line's PNG |
| `LineWord` | a confirmed word box on a line: `word_id`, `position` (reading order), `start_x` (right edge), `end_x` (left edge). Written when a page is confirmed (and by a bundle import); this is the product the exports read |
| `CalibrationSnapshot` | the immutable measurement of one line: its fingerprint, `image.png`, `labels.png` and the blobs' metadata. Reused while the line's sources are unchanged |
| `CalibrationReview` | one per page in the word engine: the draft (`payload`), `revision`, `confirmed_revision` |
| `CalibrationRevision` | immutable records of a page: `processed` (the engine's own reading, the prediction record) and `confirmed` (an approval, the only source of examples); `legacy` for history |
| `CalibrationSettings` | per mushaf: the library's comparison and LIMIT |
| `CalibrationProfile` | the recipe behind a prediction: the hash of the approvals and settings it was made from |
| `LibraryCheck` | a person looked at one example of the library and found it right |
| `ActivityEvent` | the per-mushaf audit feed (created, bounds set, template saved, run finished, review saved, lines exported, calibration processed / saved / confirmed / evaluated, ...) |

Media live under `backend/media/`: per mushaf in `mushafs/<id>/`, but the PDF stays
shared in `pdfs/<sha>.pdf` on purpose (duplicates of a mushaf share one file).

---

## 6. API

Base `/api`, interactive docs at `/api/docs`. `{id}` is a mushaf's UUID, `{n}` a
logical page number.

**Reference data and gallery (no session needed)**

| method | path | what it does |
| --- | --- | --- |
| GET | `/counting-systems`, `/qiraat`, `/suras` | reference data |
| GET | `/gallery`, `/gallery/{id}` | the published mushafs |
| GET | `/gallery/{id}/coordinates`, `/lines.zip`, `/export.zip` | a published mushaf's downloads |
| POST | `/gallery/{id}/duplicate` | copy a published mushaf into your own (signed in) |

**Mushafs**

| method | path | what it does |
| --- | --- | --- |
| GET / POST | `/mushafs` | your mushafs / create one (multipart, with the PDF) |
| GET / PATCH / DELETE | `/mushafs/{id}` | detail / edit / delete |
| GET | `/mushafs/{id}/stats`, `/activity` | counts, the activity feed |
| POST | `/mushafs/{id}/thumbnail` | regenerate the cover |
| POST | `/mushafs/{id}/publish`, `/unpublish` | show it in the gallery, or not |
| GET / PUT | `/mushafs/{id}/templates`, `/templates/{type}` | the templates |
| GET | `/mushafs/{id}/pages/{n}/image` | page `n`, rendered from the PDF |

**Lines (line engine, review, finalize)**

| method | path | what it does |
| --- | --- | --- |
| POST | `/mushafs/{id}/process` | start the line engine over a page range (202, a job) |
| GET / POST | `/mushafs/{id}/process/job`, `/process/cancel` | poll / stop it |
| GET | `/mushafs/{id}/runs`, `/runs/{run}/log`, `/runs/{run}/log/tail` | past runs and their logs |
| GET | `/mushafs/{id}/pages`, `/review-data` | page summaries, the whole-mushaf review payload |
| GET / POST | `/mushafs/{id}/pages/{n}` | one page's lines and segments |
| POST | `/mushafs/{id}/pages/bulk` | save many reviewed pages in one transaction |
| POST | `/mushafs/{id}/pages/{n}/finalize` | erase strokes and line trims |
| POST | `/mushafs/{id}/pages/{n}/export-lines` | write the page's line PNGs |

**Ink (word engine)**: under `/mushafs/{id}`

| method | path | what it does |
| --- | --- | --- |
| GET | `/calibration/pages`, `/calibration/readiness`, `/calibration/evaluation` | every page's state, the readiness meter, the evaluation |
| GET / PUT | `/pages/{n}/calibration` | the page's draft / save it (optionally `realign`) |
| POST | `/pages/{n}/calibration/process` | process the page (202, a job) |
| POST | `/pages/{n}/calibration/preview` | the draft with these edits, read again; stores nothing |
| POST | `/pages/{n}/calibration/confirm` | approve the page: writes its words, makes it an example |
| POST | `/pages/{n}/calibration/types` | type suggestions and doubts for the marks; stores nothing |
| GET | `/pages/{n}/calibration/evaluation` | the page's readings side by side |
| GET / POST | `/pages/{n}/calibration/library`, `/library/members`, `/library/compare` | the library that answers for the page |
| PUT / DELETE | `/calibration/library/checks` | mark library examples as looked at |
| POST | `/calibration/batch` | process a range of pages in one job |
| GET / POST | `/calibration/job`, `/calibration/cancel` | poll / stop the page or batch job |
| PUT | `/calibration/settings` | the library's comparison and LIMIT |

**Exports and bundles**

| method | path | what it does |
| --- | --- | --- |
| GET | `/mushafs/{id}/coordinates` | aya coordinates, `aya-bbox/v1` |
| GET | `/mushafs/{id}/lines.zip` | every exported line PNG |
| GET | `/mushafs/{id}/export.zip` | the full data export, `mushaf-export/v2` ([EXPORT_FORMAT.md](EXPORT_FORMAT.md)) |
| GET | `/mushafs/{id}/bundle` | the work bundle, `mushaf-work/v2`: the work without the PDF, which it names by its hash |
| POST | `/bundles/inspect` | which of your mushafs a bundle belongs to |
| POST | `/mushafs/{id}/import` | apply a bundle (refused unless the mushaf was built from the same PDF) |

---

## 7. Frontend

Routes (`src/routes/`):

| route | what it is |
| --- | --- |
| `/` | your mushafs |
| `/gallery`, `/gallery/:id` | the public gallery |
| `/auth/login`, `/signup`, `/forgot`, `/reset/:key`, `/verify-email/:key` | accounts |
| `/mushafs/:id` | the mushaf's hub: Overview, Pages, Runs, Export and Settings tabs, with the publish and bundle panels |
| `/mushafs/:id/setup` | **Setup**: the Quran's first and last PDF page |
| `/mushafs/:id/templates` | **Templates**: sura header, aya ornament, sajda and rub' signs |
| `/mushafs/:id/process` | **Process**: the line engine, as a job |
| `/mushafs/:id/review` | **Review**: lines, separators and sura headers, the whole mushaf in one session |
| `/mushafs/:id/finalize` | **Lines**: trim and erase lines, export the PNGs (the route kept its old name) |
| `/mushafs/:id/ink` | **Ink**: the word engine, page by page or in a batch (`CalibrationEditor`) |

`mushafs.$mushafId.tsx` is the workspace layout with the six-step header. The shell
(`TopBar`, `UserMenu`, `LanguageSwitcher`, `ThemeSwitcher`) follows the SATR design:
light, dark or system theme, English or Arabic (right to left). Server state is all
React Query (`lib/api/*`).

---

## 8. The two engines

**Line engine** (`core/page_detection`, run by `services/processing` as a `detection`
job): crop each page to its bounds, find the sura headers by template matching, split
the rest into the expected number of lines at the valleys of the row sums, find the
aya ornaments in each line, split it into segments, and number every sura and aya
with a forward walk. A line-count mismatch aborts the run at that page. The pages are
then corrected in Review, where the client owns the numbering.

**Word engine** (`core/word_boundary`, run by `services/calibration`):

1. **Process a page** (`calibration` job): snapshot every line of the page's ayat
   (`CalibrationSnapshot`), give each blob a first-guess role, read the page once with
   no help (stored as the `processed` revision, the prediction record), add the
   text's locks (small waw and ya) and the library's prices and read it again, let the
   text type the marks, and store the draft (`CalibrationReview.payload`).
2. **Review**: edits are decisions (roles, owners, types, erases). *Preview* reads the
   touched ayat again without storing; *Accept* and *Save* store the draft.
3. **Confirm**: writes the page's `LineWord` rows and an immutable `confirmed`
   revision. Only confirmed pages are examples.
4. **The library**: built from the confirmed pages other than the page being read
   (never its own), recorded by a `CalibrationProfile`. It proposes body or mark for
   every blob with a confidence, prices the reading accordingly, and guesses the mark
   types the text leaves open.
5. **Batch** (`calibration_batch` job): process a range of pages once the readiness
   meter says the learning has settled; the pages are then reviewed in any order.

[ENGINES_FLOW.md](ENGINES_FLOW.md) walks both engines on page 1 of a real mushaf, then
page 2 with page 1 as the library.

---

## 9. Sharing

- **Gallery**: a published mushaf can be browsed and downloaded by anyone, and
  duplicated by any signed-in user (`services/cloning`, the same writer as a bundle
  import). A duplicate shares the original's PDF file.
- **Bundle** (`mushaf-work/v2`, reads v1): a mushaf's work (bounds, lines, segments,
  sura assignments, erase strokes, templates) as a zip, without the PDF. Import checks
  the PDF's hash.

---

## 10. Management commands

| command | what it does |
| --- | --- |
| `seed_quran` | seed everything the `quran` app owns: reference data, the word list, the aya maps |
| `seed_suras` | the reference data alone (counting systems, qiraat, suras, aya counts) |
| `export_reference_data` | write `reference_data.json` from a filled database |
| `build_aya_boundaries` | rebuild the aya-map seed from the vendored dataset (developer tool) |
| `debug_process`, `debug_calibrate` | run the line engine / process one page in the foreground, for a debugger |
| `calibration_report` | how each confirmed page went (read-only) |
| `restart_calibration` | start a mushaf's word-engine work again, after backing it up |
| `retype_from_text` | retype marks typed by an old name (dry run unless `--apply`) |
| `renumber_mushafs` | rewrite every line's sura and segment's aya from one forward walk |
| `relayout_media` | move media into the per-mushaf layout |

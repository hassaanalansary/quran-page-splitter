# Quran Page Splitter (SATR)

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
interactive (highlighting an aya or a word, jumping to a verse, playing audio in
sync with the text) the application needs to know where everything is on the
page, and it needs the page cut into individual line images.

Serving whole page images also creates a responsive layout problem. If the page
is a single image, resizing the application window either stretches it or leaves
dead space. The solution is to display each line as its own image and let the
application adjust the spacing between lines to fill the available height. The
lines themselves scale uniformly to the window width, and the vertical gaps
absorb the remaining space, so the page always fills the screen without
distortion at any window size.

Quran Page Splitter produces all of that. It ingests a Mushaf **PDF**, renders
pages on demand, detects the lines and the aya boundaries, then the words, their
letter pieces and their marks, lets a person review and correct every step, and
exports the coordinates and transparent line PNGs ready for a Mushaf application.
In its interface the tool is called **SATR** (سَطْر).

## What it does

- Stores an uploaded Mushaf PDF once and renders any page on demand.
- **Line engine:** crops each page to its text, protects the sura headers, splits
  the rest into lines, finds the aya-end ornaments in each line and numbers every
  sura and aya across pages.
- **Word engine:** splits each line into its connected pieces of ink, decides which
  are letters and which are marks, and aligns them to the words of the Quran text
  by counting the pieces each word must print. The first pages are reviewed and
  confirmed by hand; every confirmed page feeds a library of shapes that improves
  the pages after it, and the rest of the mushaf can then be processed in one batch.
- Types every mark (fatha, kasra, shadda, sukun, dots, pause signs, ...) from the
  Quran text and from the shapes already confirmed.
- Lets the user trim and erase each line and export transparent line PNGs.
- Exports aya coordinates (`aya-bbox/v1`), the line PNGs (`lines.zip`), and a full
  data export with every word, blob and per-line pixel map
  (`mushaf-export/v2`, see [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md)).
- Accounts (email and password, or Google), private mushafs per user, and a public
  gallery where a published mushaf can be browsed, downloaded and duplicated.
- A portable work bundle to move a mushaf's work between installs.
- English and Arabic interface, light and dark themes.

## The steps

Each mushaf goes through six steps, in this order:

1. **Setup**: mark the PDF pages where the Quran starts and ends.
2. **Templates**: cut a sura header and an aya-end ornament from the pages (and,
   optionally, the sajda and rub' al-hizb signs).
3. **Process**: run the line engine over a page range, as a background job.
4. **Review**: correct the lines, the aya separators and the sura headers.
5. **Lines**: trim and erase each line, and export the line PNGs.
6. **Ink**: run the word engine. Process a page, review it, confirm it, and go to
   the next; once the learning has settled, process the rest in one batch.

How both engines work, step by step, is in [docs/ENGINES_FLOW.md](docs/ENGINES_FLOW.md).

## Architecture

- **`backend/`**: Django 6 with a **Django Ninja** API.
  - `config/`: settings (read from `.env`), URLs, and the view that serves the built SPA.
  - `accounts/`: the user model (the email is the identifier).
  - `quran/`: the Quran text and reference data (counting systems, qiraat, rawis,
    suras, ayat, words) and its read-only API.
  - `api/`: mushafs, pages, processing, calibration, exports, gallery. Thin views
    call service functions (`api/services/`), the only layer that touches the ORM.
  - `core/`: the engines, with no Django in them: `page_detection/` (lines and
    ayat), `word_boundary/` (words, letters and marks), `text/` (what the Quran
    text says each word prints), `imaging/`.
- **`frontend/`**: React 19, Vite 7, TanStack Router and React Query, Tailwind 4.
- **Database**: PostgreSQL through `DATABASE_URL` (SQLite when it is not set).
- **Media**: the PDFs, template crops, snapshots and exported PNGs live under
  `backend/media/`. Page images are rendered from the PDF on demand.
- **Jobs**: line processing and word processing run as background jobs that the
  browser polls. A **Celery worker** runs them, with Redis as the queue; without
  Redis they run on a thread of the web process. When every worker slot is busy, a
  job waits its turn and the screen says how many are ahead of it. One job per
  mushaf at a time, and a job whose worker stops reporting is marked interrupted.
  See `backend/api/services/jobs/__init__.py` for the flow.

In development Vite (`:5173`) proxies `/api`, `/media` and the sign-in paths to
Django (`:8000`). In production nginx serves the built SPA and `/media`, and passes
the rest to Django, behind Traefik for HTTPS: see [DEPLOY.md](DEPLOY.md).

## Run it with Docker (Linux)

The usual way. Docker runs Django, the Celery worker, Postgres 18 and Redis; Vite
runs on your machine.

You need Docker Engine with the Compose plugin, [`just`](https://just.systems),
and Node.js with npm.

```bash
just build                   # once, and again when backend/uv.lock changes
just up                      # starts everything; Django migrates on start
just manage seed_quran       # once: reference data, the word list, the aya maps
just manage createsuperuser  # once, for /admin
```

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173
```

| Command | What it does |
| --- | --- |
| `just` | lists every recipe |
| `just logs` / `just logs celeryworker` | follow the logs |
| `just psql` | `psql` on the database, inside its container |
| `just redis-cli` | `redis-cli`, inside its container |
| `just manage <command>` | a `manage.py` command, such as `shell` or `migrate` |
| `just shell` | bash in the Django container |
| `just test` | the backend tests, in the container |
| `just check` | ruff and mypy, in the container |
| `just dump-db quran.dump` | dump the database to a file |
| `just restore-db quran.dump` | **replace** the database with a dump (`pg_dump -Fc`), then migrate |
| `just flower` | a page showing the worker and its tasks, on `:5555` |
| `just down` | stop everything; `just prune` also deletes the database |

- The database also answers on `localhost:5433`, and Redis on `localhost:6380`,
  for any client you like. The user, password and database are in
  `.envs/.local/.postgres`.
- Values in `.envs/.local/` win over `backend/.env` inside the containers.
- The containers run as you, so files under `backend/media` and `backend/logs`
  belong to you.
- The worker restarts when you save a `.py` file. A job it was running stops at
  its next page and can be resumed from there.

To bring an existing database across, dump it where it lives with
`pg_dump -Fc -d <database> -f quran.dump`, then run `just restore-db quran.dump`.
Copy `backend/media/` across by hand: git does not carry it.

Production is a separate stack: [DEPLOY.md](DEPLOY.md).

## Run it without Docker

You need Python `>= 3.13` with [`uv`](https://docs.astral.sh/uv/), Node.js and
npm, and PostgreSQL (recommended; SQLite works without it).

```bash
cd backend
uv sync
cp .env.dist .env            # then set SECRET_KEY (required) and DATABASE_URL
uv run python manage.py migrate
uv run python manage.py seed_quran   # reference data, the word list, the aya maps
uv run python manage.py runserver 8000
```

```bash
cd frontend
npm install
npm run dev                  # http://localhost:5173
```

Jobs then run on a thread of the web process, so there is no queue: a job that
finds every slot busy is refused. To run them in a worker as Docker does, start
Redis, set `JOB_RUNNER=celery` and `CELERY_BROKER_URL` in `backend/.env`, and
start a worker beside `runserver`:

```bash
cd backend
uv run celery -A config worker --loglevel info --concurrency 2
```

- Interactive API docs: `http://localhost:8000/api/docs`
- Google sign-in needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

## Development

```bash
cd backend
uv run ruff check .
uv run python -m mypy .                          # through python -m: the path has spaces
uv run python manage.py test --parallel 4        # Postgres test database
```

```bash
cd frontend
npx tsc --noEmit
npm run lint
npm run build                # → frontend/dist, which Django serves without Docker
```

## Documentation

- [docs/ENGINES_FLOW.md](docs/ENGINES_FLOW.md): the line engine and the word
  engine, step by step, on a real page.
- [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md): the full data export
  (`mushaf-export/v2`).
- [docs/PROJECT_HANDOFF.md](docs/PROJECT_HANDOFF.md): the developer reference
  (layout, data model, API, conventions).
- [DEPLOY.md](DEPLOY.md): running the production stack on a server.

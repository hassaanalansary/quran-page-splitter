# Celery + Docker: handoff

The plan is [plans/celery-and-docker.md](plans/celery-and-docker.md). This file is the live status: what is done, what was checked, and what was not.

## Status

Last updated: 2026-11-10.

| # | Phase | State | Checks run |
|---|---|---|---|
| 0 | Plan, this doc, the code style rules in `PROJECT_HANDOFF.md` §4 | done | none needed |
| 1 | Reorganize the job system (no behaviour change) | not started | |
| 2 | Jobs described by their row | not started | |
| 3 | Celery | not started | |
| 4 | The real queue | not started | |
| 5 | Frontend | not started | |
| 6 | Docker | not started | |
| 7 | Docs | not started | |

## Not verified

Nothing is built yet. Each phase adds a line here for every check that could not be run, with the reason.

- The Docker files will be written without being run. Their first real run is on the owner's machine (plan §9).

## For whoever continues

1. Read the plan, then this file.
2. Work on `feature/celery-and-docker`. One commit per phase. Push the branch; do not open a pull request.
3. Follow the plan's §8 (rules for the builder) and §4.1 (code style).
4. `backend/.env` is committed and may point `DATABASE_URL` at a Postgres on localhost. Set `DATABASE_URL` in the environment to use another one.
5. At the end of each phase, update the table above and the "Not verified" list.

"""The job system: long work that a request starts and a worker thread finishes.

Processing a page range takes seconds per page, and minutes to hours for a whole
mushaf, so the request only starts the work. The ``ProcessJob`` row is the state both
sides share, and it describes the whole job: its ``kind`` names the runner and its
``params`` hold the runner's inputs. The worker is handed the job's id and nothing
else. It writes its progress to the row, the browser polls the row, and a cancel is a
column that the worker reads between pages.

::

    browser        request (web process)                  worker thread
    POST ────────▶ start_…_job                 kinds/
                   ├ refuse_if_…  (409 / 429)  admission
                   ├ create_queued_job         creation    state = queued, params = {…}
                   └ dispatch_job ── job id ─────────────▶ execute_job          execution
    ◀── 202, the job                                       ├ claim_queued_job   claiming
    GET poll ────▶ find_latest_job_of_mushaf   queries     │    queued → running
                   └ serialize_job             serializers ├ load_job_runner    runner_registry
    cancel ──────▶ request_job_cancellation    cancellation├ run_…_job          kinds/
                   ├ queued:  cancelled at once            │  ├ record_job_progress
                   └ running: sets the flag                │  └ is_job_cancellation_requested
                                                           └ record_job_outcome progress

The modules, in the order a job meets them:

``kinds/``           one file per kind of job, holding both halves: ``start_…_job`` (the
                     request) and ``run_…_job`` (the worker)
``admission``        the rules that refuse a job before it exists
``creation``         writes the job's row, in the ``queued`` state
``dispatch``         hands the job's id to whatever runs it: the request itself, or a thread
``execution``        claims the job, runs it, and makes sure it settles, whatever happens
``claiming``         ``queued`` → ``running``, for one worker only
``runner_registry``  which ``run_…_job`` belongs to which kind
``progress``         the worker's writes to the row: progress ticks and the final outcome
``cancellation``     cancels a queued job at once, and flags a running one
``dead_jobs``        marks jobs that nothing will finish as ``interrupted``
``queries``          finds jobs for the pollers and for the rules above
``states``           which states are final
``serializers``      the row as the API returns it

Import the function you call from the module that holds it. This file exports nothing.
"""

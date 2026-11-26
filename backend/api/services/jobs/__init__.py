"""The job system: long work that a request starts and a worker finishes.

Processing a page range takes seconds per page, and minutes to hours for a whole
mushaf, so the request only starts the work. The ``ProcessJob`` row is the state both
sides share, and it describes the whole job: its ``kind`` names the runner and its
``params`` hold the runner's inputs. The worker is handed the job's id and nothing
else. It writes its progress to the row, the browser polls the row, and a cancel is a
column that the worker reads between pages.

::

    browser        request (web process)             redis      Celery worker (a child process)
    POST ────────▶ start_…_job              kinds/
                   ├ refuse_if_…  (409/429) admission
                   ├ create_queued_job      creation             state = queued, params = {…}
                   └ dispatch_job ─ on commit ─▶ [queue] ─▶ run_job_task(job id)   api/tasks.py
    ◀── 202, the job                                        └ execute_job          execution
    GET poll ────▶ find_latest_job_of_mushaf   queries         ├ claim_queued_job  claiming
                   └ serialize_job             serializers     │    queued → running
    cancel ──────▶ request_job_cancellation    cancellation    ├ load_job_runner   runner_registry
                   ├ queued:  cancelled at once                ├ run_…_job         kinds/
                   └ running: sets the flag                    │  ├ record_job_progress
                                                               │  └ is_job_cancellation_requested
                                                               └ record_job_outcome  progress

That is ``JOB_RUNNER=celery``. With ``thread``, ``dispatch_job`` starts a thread of the
web process that calls ``execute_job``. With ``inline`` it calls ``execute_job`` itself.
Everything from ``execute_job`` down is the same in all three.

The modules, in the order a job meets them:

``kinds/``           one file per kind of job, holding both halves: ``start_…_job`` (the
                     request) and ``run_…_job`` (the worker)
``admission``        the rules that refuse a job before it exists
``creation``         writes the job's row, in the ``queued`` state
``dispatch``         hands the job's id to whatever runs it: Celery, a thread, or the request
``api/tasks.py``     the Celery task: it calls ``execute_job``
``execution``        claims the job, runs it, and makes sure it settles, whatever happens
``claiming``         ``queued`` → ``running``, for one worker only
``runner_registry``  which ``run_…_job`` belongs to which kind
``progress``         the worker's writes to the row: progress ticks and the final outcome
``cancellation``     cancels a queued job at once, and flags a running one
``worker_events``    what a Celery worker does for its jobs when it starts and when it stops
``dead_jobs``        marks jobs that nothing will finish as ``interrupted``
``queries``          finds jobs for the pollers and for the rules above
``states``           which states are final
``serializers``      the row as the API returns it

Import the function you call from the module that holds it. This file exports nothing.
"""

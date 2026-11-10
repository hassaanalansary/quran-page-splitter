"""The job system: long work that a request starts and a worker thread finishes.

Processing a page range takes seconds per page, and minutes to hours for a whole
mushaf, so the request only starts the work. The ``ProcessJob`` row is the state both
sides share: the worker writes it, the browser polls it, and a cancel is a column
that the worker reads between pages.

::

    browser        request (web process)                  worker thread
    POST ────────▶ start_…_job                 kinds/
                   ├ refuse_if_…  (409 / 429)  admission
                   ├ create_queued_job         creation
                   └ dispatch_job ───────────────────────▶ execute_job          execution
    ◀── 202, the job                                       ├ run_…_job          kinds/
    GET poll ────▶ find_latest_job_of_mushaf   queries     │  ├ record_job_progress
                   └ serialize_job             serializers │  └ is_job_cancellation_requested
    cancel ──────▶ request_job_cancellation    cancellation└ record_job_outcome progress

The modules, in the order a job meets them:

``kinds/``          one file per kind of job, holding both halves: ``start_…_job`` (the
                    request) and ``run_…_job`` (the worker)
``admission``       the rules that refuse a job before it exists
``creation``        writes the job's row
``dispatch``        hands the job to whatever runs it: the request itself, or a thread
``execution``       runs the job and makes sure it settles, whatever happens
``progress``        the worker's writes to the row: progress ticks and the final outcome
``cancellation``    the cancel flag: setting it and reading it
``dead_jobs``       marks jobs whose worker went silent as ``interrupted``
``queries``         finds jobs for the pollers and for the rules above
``states``          which states are final
``serializers``     the row as the API returns it

Import the function you call from the module that holds it. This file exports nothing.
"""

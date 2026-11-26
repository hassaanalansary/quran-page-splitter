"""One module per kind of job. Each holds both halves of its kind, so one kind reads
top to bottom in one place: ``start_…_job`` is what the request calls, and
``run_…_job`` is what the worker runs.

``detection``           the line engine over a range of pages
``calibration_page``    the word engine over one page, for review
``calibration_batch``   the word engine over a range of pages, one after another
"""

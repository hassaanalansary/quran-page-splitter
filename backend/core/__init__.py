"""The engines, and the things they share. No Django anywhere below this line.

Nothing in ``core`` imports Django, opens a database, or reads a setting. It is
handed its inputs and returns data — which is what lets the same code run from a
command line over a directory of PNGs and from inside a web request over rows,
without knowing which it is. ``api.services`` is the only place the two meet.

    imaging/         pixels, and nothing that knows what the picture is
    text/            the Quran as text: letters, words, suras — no pixels
    page_detection/  a rendered page → its lines and aya segments
    word_boundary/   line images + the words they hold → where each word ends
    trace.py         give one run its own log file

**Two engines, two shapes.** ``word_boundary`` is handed a ``WordBoundaryInput``
and answers with a ``WordBoundaryResult``, touching nothing shared — so its
internals are genuinely private and its package is a contract. ``page_detection``
is a *pipeline*: each stage reads what the last one wrote onto one ``PageContext``
and adds to it. That is why it is one package of steps rather than several
packages of engines, and the difference is worth keeping straight before splitting
anything else out.

**They talk through ``logging``, and configure none of it.** Every engine narrates
what it is doing and decides nothing about where that goes; the caller attaches a
handler (``trace.setup_file_logging``, or ``api.services.run_logs``) or attaches
nothing and pays only a level check. That is what makes a run's trace readable in
the browser, on a terminal, and in a file, from one implementation.

``imaging`` and ``text`` are shared on purpose and stay thin. The test for whether
something belongs in ``imaging`` is whether it needs to know what the picture *is*
— if it does, it belongs to an engine.
"""

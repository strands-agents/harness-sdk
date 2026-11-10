"""Capture stalled live-test workers before the terminal driver's timeout."""

import faulthandler
import gc
import os
import sys
import traceback
from pathlib import Path
from threading import Timer
from types import AsyncGeneratorType, CoroutineType


def dump_async_frames():
    print("Suspended async frames:", file=trace)
    for obj in gc.get_objects():
        frame = None
        if isinstance(obj, CoroutineType):
            frame = obj.cr_frame
        elif isinstance(obj, AsyncGeneratorType):
            frame = obj.ag_frame
        if frame is not None:
            traceback.print_stack(frame, limit=1, file=trace)
    trace.flush()


if Path(sys.argv[0]).name == "worker.py":
    trace_path = Path(os.environ["STRANDS_CLI_TEST_STATE_PATH"]).with_suffix(".python-trace.log")
    trace = trace_path.open("w")
    faulthandler.dump_traceback_later(60, file=trace)
    timer = Timer(61, dump_async_frames)
    timer.daemon = True
    timer.start()

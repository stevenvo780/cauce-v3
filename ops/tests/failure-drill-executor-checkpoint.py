from __future__ import annotations

import json
import linecache
import os
import pathlib
import runpy
import signal
import sys

executor, checkpoint = map(pathlib.Path, sys.argv[1:3])
source = executor.parent / 'fleet_executor_container.py'
os.umask(0o077)


def pause_before_start(frame, event, _argument):
    if event == 'line' and frame.f_code.co_name == 'ensure_container' \
            and pathlib.Path(frame.f_code.co_filename) == source \
            and linecache.getline(str(source), frame.f_lineno).lstrip().startswith("docker('start',"):
        observed = frame.f_locals['observed']
        if observed['State']['Running'] or observed['State']['Status'] != 'created':
            raise RuntimeError('checkpoint requires an actual created container')
        checkpoint.write_text(json.dumps({'executor_pid': os.getpid(), 'container_id': observed['Id'],
            'status': observed['State']['Status'], 'source_line': frame.f_lineno}))
        os.kill(os.getpid(), signal.SIGSTOP)
    return pause_before_start


sys.path.insert(0, str(executor.parent))
sys.argv = [str(executor), *sys.argv[3:]]
sys.settrace(pause_before_start)
runpy.run_path(str(executor), run_name='__main__')

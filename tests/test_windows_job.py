"""A scheduled-task child must not survive the supervisor's Job handle."""
import os
import subprocess
import sys

import pytest


@pytest.mark.skipif(os.name != "nt", reason="Windows-only process containment")
def test_worker_is_killed_when_job_handle_closes():
    from atelier.windows_job import KillOnCloseJob
    child = subprocess.Popen(
        [sys.executable, "-c", "import time;time.sleep(60)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    job = None
    try:
        job = KillOnCloseJob(child)
        assert child.poll() is None
        job.close()
        child.wait(timeout=5)
        assert child.poll() is not None
    finally:
        if job is not None:
            job.close()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)

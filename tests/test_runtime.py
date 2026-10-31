"""Fail-safe singleton semantics across processes."""
import subprocess
import sys
from pathlib import Path

import pytest

from atelier.runtime import AlreadyRunning, exclusive_instance


def test_instance_guard_rejects_second_owner(tmp_path):
    lock = tmp_path / "bot.lock"
    with exclusive_instance(lock):
        with pytest.raises(AlreadyRunning):
            with exclusive_instance(lock):
                pytest.fail("concurrent poller started")
    with exclusive_instance(lock):
        pass


def test_instance_guard_denies_second_process_and_recovers(tmp_path):
    lock = tmp_path / "bot.lock"
    cmd = [
        sys.executable, "-c",
        "from atelier.runtime import exclusive_instance; "
        "from pathlib import Path; "
        f"with_placeholder={str(lock)!r}; "
        "ctx=exclusive_instance(with_placeholder); "
        "ctx.__enter__(); ctx.__exit__(None,None,None)"
    ]
    with exclusive_instance(lock):
        rejected = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        assert rejected.returncode != 0
        assert "AlreadyRunning" in rejected.stderr
    acquired = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    assert acquired.returncode == 0, acquired.stderr

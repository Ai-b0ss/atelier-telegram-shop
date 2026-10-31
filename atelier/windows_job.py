"""Windows Job Object: worker dies if its supervising process is terminated.

Task Scheduler stops the parent but normally leaves Python descendants alive.
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE prevents orphaned polling consumers.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import subprocess


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IOCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimits),
        ("IoInfo", _IOCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class KillOnCloseJob:
    def __init__(self, process: subprocess.Popen):
        if os.name != "nt":
            raise RuntimeError("Windows Job Objects require Windows")
        k = ctypes.WinDLL("kernel32", use_last_error=True)
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
        ]
        k.SetInformationJobObject.restype = wintypes.BOOL
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        self._kernel = k
        self._handle = k.CreateJobObjectW(None, None)
        if not self._handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        try:
            limits = _ExtendedLimits()
            limits.BasicLimitInformation.LimitFlags = 0x2000
            if not k.SetInformationJobObject(
                self._handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
            ):
                raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
            if not k.AssignProcessToJobObject(
                self._handle, wintypes.HANDLE(int(process._handle))
            ):
                raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
        except BaseException:
            self.close()
            raise

    def close(self):
        if self._handle:
            self._kernel.CloseHandle(self._handle)
            self._handle = None

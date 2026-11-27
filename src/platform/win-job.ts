// src/platform/win-job.ts — Native Windows Job Object helper via bun:ffi.
// Guarantees full process-tree termination (including detached grandchildren)
// when a compute job is cancelled, times out, or closes.
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface WindowsJobHandle {
  terminate: () => void;
  close: () => void;
}

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// PROCESS_TERMINATE (0x0001) | PROCESS_SET_QUOTA (0x0100)
const PROCESS_JOB_ACCESS = 0x0101;

type Kernel32Api = ReturnType<typeof loadKernel32>;
let cachedKernel32: Kernel32Api | null | undefined;

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.bool,
    },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
  });
}

function getKernel32(): Kernel32Api | null {
  if (process.platform !== "win32") return null;
  if (cachedKernel32 !== undefined) return cachedKernel32;
  try {
    cachedKernel32 = loadKernel32();
  } catch {
    cachedKernel32 = null;
  }
  return cachedKernel32;
}

/**
 * Attaches a Windows process PID to a fresh Job Object configured with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Returns null on non-Windows or if the
 * OS denies assignment (e.g. restricted nested job), allowing fallback to taskkill.
 */
export function attachWindowsJobObject(pid: number): WindowsJobHandle | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const k32 = getKernel32();
  if (!k32) return null;

  let hJob: ReturnType<Kernel32Api["symbols"]["CreateJobObjectW"]> | null = null;
  let hProc: ReturnType<Kernel32Api["symbols"]["OpenProcess"]> | null = null;
  let closed = false;

  try {
    hJob = k32.symbols.CreateJobObjectW(null, null);
    if (!hJob) return null;

    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on x64 Windows;
    // BasicLimitInformation.LimitFlags sits at byte offset 16.
    const info = new Uint8Array(144);
    new DataView(info.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    if (!k32.symbols.SetInformationJobObject(hJob, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(info), info.byteLength)) {
      k32.symbols.CloseHandle(hJob);
      return null;
    }

    hProc = k32.symbols.OpenProcess(PROCESS_JOB_ACCESS, false, pid);
    if (!hProc) {
      k32.symbols.CloseHandle(hJob);
      return null;
    }

    const assigned = k32.symbols.AssignProcessToJobObject(hJob, hProc);
    k32.symbols.CloseHandle(hProc);
    hProc = null;

    if (!assigned) {
      k32.symbols.CloseHandle(hJob);
      return null;
    }

    const jobHandle = hJob;
    return {
      terminate: () => {
        if (closed) return;
        try {
          k32.symbols.TerminateJobObject(jobHandle, 1);
        } catch {
          /* best effort */
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          k32.symbols.CloseHandle(jobHandle);
        } catch {
          /* best effort */
        }
      },
    };
  } catch {
    if (hProc) {
      try { k32.symbols.CloseHandle(hProc); } catch { /* ignore */ }
    }
    if (hJob) {
      try { k32.symbols.CloseHandle(hJob); } catch { /* ignore */ }
    }
    return null;
  }
}

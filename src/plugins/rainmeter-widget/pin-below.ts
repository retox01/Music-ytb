// Best-effort "keep this window behind every other window" support.
//
// Electron has no cross-platform equivalent of Win32's HWND_BOTTOM, and adding a native
// FFI dependency (koffi/ffi-napi/node-window-manager) just for this would complicate
// electron-builder packaging on every OS, so none is added here. Instead:
// - Windows: a tiny inline C# P/Invoke (Add-Type) run through powershell.exe calls
//   user32.dll SetWindowPos(HWND_BOTTOM). No shell string-building with variable data:
//   the script text itself is a static constant, and the only variable data (the window
//   handle) crosses into the process as a separate execFile argument, never concatenated
//   into the script source.
// - Linux: wmctrl, falling back to xdotool; both addressed by window id (not ":ACTIVE:"
//   or title matching), so the right window is targeted even when it isn't focused.
// - macOS: not implemented (best-effort only, not a priority target for this plugin).
//
// Nothing here keeps the window behind permanently: Windows/X11 restack it to a normal
// z-order as soon as it (or the desktop) is activated again, so the caller must
// re-apply this on an interval for as long as "widget mode" is active (same approach
// used by wallpaper-style apps such as Wallpaper Engine or Lively Wallpaper on Windows).

import { execFile } from 'node:child_process';

import is from 'electron-is';

import type { BrowserWindow } from 'electron';

const WINDOWS_PIN_BELOW_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace RainmeterWidget -Name NativeWindow -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'
$hwnd = [IntPtr]::new([int64]$args[0])
$HWND_BOTTOM = [IntPtr]::new(1)
$SWP_NOMOVE = 0x2
$SWP_NOSIZE = 0x1
$SWP_NOACTIVATE = 0x10
[RainmeterWidget.NativeWindow]::SetWindowPos($hwnd, $HWND_BOTTOM, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE)) | Out-Null
`;

// Electron's getNativeWindowHandle() returns a Buffer holding the raw platform handle
// (HWND on Windows, X11 Window/XID on Linux), as a pointer-sized little-endian integer.
function readNativeHandle(win: BrowserWindow): bigint | null {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0);
  if (buf.length >= 4) return BigInt(buf.readUInt32LE(0));
  return null;
}

function pinWindowsBelow(win: BrowserWindow) {
  const handle = readNativeHandle(win);
  if (handle === null || handle <= 0n) return; // refuse to shell out with a bogus handle

  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      WINDOWS_PIN_BELOW_SCRIPT,
      handle.toString(), // passed as its own argv entry, never interpolated into the script
    ],
    (error) => {
      if (error) {
        console.warn(
          '[rainmeter-widget] failed to pin window below (Windows):',
          error.message,
        );
      }
    },
  );
}

let loggedLinuxUnavailable = false;

function pinLinuxBelow(win: BrowserWindow) {
  const handle = readNativeHandle(win);
  if (handle === null) return;

  execFile(
    'wmctrl',
    ['-i', '-r', `0x${handle.toString(16)}`, '-b', 'add,below'],
    (wmctrlError) => {
      if (!wmctrlError) return;

      execFile(
        'xdotool',
        ['windowstate', '--window', handle.toString(), '--below', 'add'],
        (xdotoolError) => {
          if (xdotoolError && !loggedLinuxUnavailable) {
            loggedLinuxUnavailable = true;
            console.warn(
              '[rainmeter-widget] neither wmctrl nor xdotool is available; "pin behind" is disabled on this system.',
            );
          }
        },
      );
    },
  );
}

const PIN_BELOW_INTERVAL_MS = 2500;

/**
 * Starts (re-)applying the "pin behind other windows" effect on an interval.
 * Returns the interval handle, or null if the platform isn't supported (macOS).
 */
export function startPinBelow(win: BrowserWindow): NodeJS.Timeout | null {
  const apply = () => {
    if (is.windows()) pinWindowsBelow(win);
    else if (is.linux()) pinLinuxBelow(win);
    // macOS: no equivalent implemented, see file header.
  };

  if (!is.windows() && !is.linux()) return null;

  apply();
  return setInterval(apply, PIN_BELOW_INTERVAL_MS);
}

export function stopPinBelow(timer: NodeJS.Timeout | null) {
  if (timer) clearInterval(timer);
}

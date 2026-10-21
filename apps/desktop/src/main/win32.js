'use strict';
// 少量 Win32 调用（koffi 预编译 FFI，无需编译器）：全屏/演示检测、鼠标左键状态、窗口沉到底层（桌面组件）
let api = null;
let failed = false;

function load() {
  if (api || failed) return api;
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const user32 = koffi.load('user32.dll');
    api = {
      SHQueryUserNotificationState: shell32.func('long __stdcall SHQueryUserNotificationState(_Out_ int *state)'),
      GetAsyncKeyState: user32.func('short __stdcall GetAsyncKeyState(int vKey)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
    };
  } catch (e) {
    failed = true;
    console.warn('[win32] koffi 不可用：', e.message);
  }
  return api;
}

// QUNS_BUSY=2 全屏应用；QUNS_RUNNING_D3D_FULL_SCREEN=3；QUNS_PRESENTATION_MODE=4
let fsCache = { at: 0, v: false, pending: false };
function isFullscreen() {
  if (process.platform !== 'win32') return false;
  if (fsCache.pending || Date.now() - fsCache.at < 10_000) return fsCache.v;
  const a = load();
  fsCache.at = Date.now();
  if (!a) return fsCache.v;
  const out = [0];
  fsCache.pending = true;
  try {
    // Shell 查询可能等待别的窗口。只在后台查询一次，主进程使用最近结果。
    a.SHQueryUserNotificationState.async(out, (err, result) => {
      if (!err && result === 0) fsCache.v = out[0] === 2 || out[0] === 3 || out[0] === 4;
      fsCache.at = Date.now();
      fsCache.pending = false;
    });
  } catch (e) {
    fsCache.pending = false;
    console.warn('[win32] 全屏检测失败：', e.message);
  }
  return fsCache.v;
}

function isLeftButtonDown() {
  const a = load();
  if (!a) return null;
  return (a.GetAsyncKeyState(0x01) & 0x8000) !== 0;
}

/** 把窗口放到 Z 序最底层（在其他程序窗口之后、桌面图标之上），不激活、不移动 */
async function sendToBottom(win) {
  const a = load();
  if (!a || !win || win.isDestroyed()) return false;
  try {
    const buf = win.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
    const HWND_BOTTOM = 1n;
    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_ASYNCWINDOWPOS = 0x4000;
    // 在后台调用并让 Windows 异步投递给窗口线程，避免失焦时互相等待。
    return await new Promise((resolve) => a.SetWindowPos.async(
      hwnd, HWND_BOTTOM, 0, 0, 0, 0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
      (err, ok) => resolve(!err && !!ok)
    ));
  } catch (e) {
    console.warn('[win32] SetWindowPos 失败：', e.message);
    return false;
  }
}

module.exports = { isFullscreen, isLeftButtonDown, sendToBottom };

// Loaded before either UI entry point, in the renderer's main world.
(() => {
  const report = (kind, message, stack = '', source = '', line = 0) => {
    try { window.pa?.reportError?.({ kind, message: String(message || '').slice(0, 2000), stack: String(stack || '').slice(0, 6000), source, line }); } catch { /* Reporting must not recurse into more errors. */ }
  };
  window.addEventListener('error', event => report('error', event.message || '资源加载失败', event.error?.stack, event.filename || event.target?.src || '', event.lineno), true);
  window.addEventListener('unhandledrejection', event => report('unhandledrejection', event.reason?.message || event.reason, event.reason?.stack));
})();

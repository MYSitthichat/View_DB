// hooks/useBridge.js — typed wrapper around the Wails runtime bridge.
// Centralises the runtime check and the runtime error message so every
// call site doesn't have to repeat it.

/**
 * Call an exported method on the bound Go struct (DesktopApp).
 * Throws a descriptive Error when the runtime is not ready or the
 * method does not exist on the bridge object.
 */
export async function callBridge(method, ...args) {
  const fn = typeof window !== 'undefined'
    ? window?.go?.main?.DesktopApp?.[method]
    : null;
  if (!fn) {
    throw new Error(`Bridge method not available: ${method}`);
  }
  return fn(...args);
}

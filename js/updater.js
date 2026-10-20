// Service worker registration, version check and Force Update.

const CURRENT = self.TERRA_VERSION;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  } catch (err) {
    console.warn('Service worker registration failed:', err);
    return null;
  }
}

// Fetches version.js straight from the server (bypassing every cache) and
// compares it with the running build. Returns null when offline.
export async function checkForUpdate() {
  try {
    const res = await fetch(`version.js?versioncheck=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const latest = (await res.text()).match(/TERRA_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null;
    return { current: CURRENT, latest, available: Boolean(latest && latest !== CURRENT) };
  } catch {
    return null;
  }
}

// Drops the service worker and every app cache, installs a fresh service
// worker, then reloads. The new worker downloads every app file past the
// browser's HTTP cache (GitHub Pages lets files sit there for 10 minutes), so
// the page can't start from a mix of old and new files. Server settings in
// localStorage are not touched.
export async function reloadFresh() {
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  }
  if ('caches' in self) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('terra-client-')).map((k) => caches.delete(k)));
  }
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      await Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(resolve, 15000))]);
    } catch { /* reload anyway: the network is still used */ }
  }
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('v', Date.now().toString(36));
  location.replace(url.toString());
}

// Force Update. Refuses when the server is unreachable so an offline iPad
// never loses its shell.
export async function forceUpdate() {
  const check = await checkForUpdate();
  if (!check) {
    return { ok: false, reason: 'Can’t reach the server. Staying on the current version so the app keeps working offline.' };
  }
  await reloadFresh();
  return { ok: true };
}

// The page's markup carries the version it belongs to (<meta name="terra-version">).
// After an update, an installed app can open the old cached index.html with the
// new scripts, which then fail on markup they don't find. True when that
// happened and a fresh reload has been started. Tries once per version, so a
// page that stays stale shows the error banner instead of looping.
export function recoverStalePage() {
  const page = document.querySelector('meta[name="terra-version"]')?.content ?? null;
  if (page === CURRENT) return false;
  const key = 'terra.staleReload';
  try {
    if (sessionStorage.getItem(key) === CURRENT) return false;
    sessionStorage.setItem(key, CURRENT);
  } catch { /* no storage: reload once anyway */ }
  reloadFresh();
  return true;
}
export const APP_VERSION = CURRENT;

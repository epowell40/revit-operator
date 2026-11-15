export const STALE_BROWSER_MESSAGE = 'Operator was updated. Your draft is preserved. Refresh this page before sending; the current task will not be restarted.';
export async function assertLoadedBrowserFresh(loadedIdentity, fetcher = fetch) {
  const response = await fetcher('/api/browser-asset-identity', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not check the Operator version. Your draft is preserved; try again when connected.');
  const current = await response.json();
  if (!loadedIdentity || current.identity !== loadedIdentity) {
    throw Object.assign(new Error(STALE_BROWSER_MESSAGE), { code: 'SIDECAR_BROWSER_STALE', request_dispatched: false });
  }
}

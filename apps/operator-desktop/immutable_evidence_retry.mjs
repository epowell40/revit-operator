// Only for replaying the same serialized content-addressed evidence-store
// request. Never apply this classification to native actions or model calls.
export function immutableEvidenceRetryReason(error) {
  if (error?.name === 'AbortError') return null;
  if ([502, 503, 504].includes(error?.status)) return `HTTP_${error.status}`;
  if (error?.name === 'TypeError' && error?.message === 'fetch failed')
    return String(error?.cause?.code || 'unknown').replace(/[^A-Za-z0-9_]/g, '').slice(0, 80);
  return null;
}

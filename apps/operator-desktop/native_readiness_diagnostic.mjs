// Preserve a useful cause from the guarded discovery read without exposing
// filesystem paths, receipt contents, command lines or credentials.
const FILE_CAUSES = new Map([
  ['ENOENT', 'file or parent directory is missing'],
  ['EACCES', 'access denied'], ['EPERM', 'operation denied'],
  ['EBUSY', 'file is busy'], ['EIO', 'filesystem read failed'],
  ['EMFILE', 'process file-handle limit reached'],
  ['ENFILE', 'system file-handle limit reached']
]);
const GUARDED_CAUSES = new Map([
  ['receipt changed while it was read', 'file changed during the guarded read'],
  ['not a regular file', 'receipt is not a regular file'],
  ['path escaped LOCALAPPDATA', 'receipt path is outside LOCALAPPDATA'],
  ['LOCALAPPDATA is a reparse point', 'LOCALAPPDATA is a reparse point'],
  ['reparse traversal', 'receipt path traverses a reparse point']
]);

export function nativeReadinessFailureMessage(error) {
  const message = `${error?.message || error || ''}`.slice(0, 600);
  if (error?.code !== 'NATIVE_TRANSPORT_DISCOVERY_UNAVAILABLE') return message;
  const code = error.cause?.code;
  const detail = FILE_CAUSES.has(code)
    ? `${code}: ${FILE_CAUSES.get(code)}`
    : GUARDED_CAUSES.get(error.cause?.message);
  return detail ? `${message} Cause: ${detail}.` : message;
}

export function nativeReadinessHealthDetail(health) {
  let failure;
  try { failure = JSON.parse(health?.revit_bridge?.error); } catch { return ''; }
  if (!/^(?:REVIT_CONTEXT_HOST_|NATIVE_TRANSPORT_)[A-Z_]{1,70}$/.test(failure?.code ?? '')) return '';
  const knownDetails = [...FILE_CAUSES].map(([code, text]) => `${code}: ${text}`)
    .concat([...GUARDED_CAUSES.values()]);
  const message = typeof failure.error === 'string' ? failure.error : '';
  const detail = knownDetails.find(value => message.endsWith(`Cause: ${value}.`));
  return ` Local Revit check: ${failure.code}.${detail ? ` Cause: ${detail}.` : ''}`;
}

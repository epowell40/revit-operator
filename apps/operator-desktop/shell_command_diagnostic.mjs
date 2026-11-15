// Diagnostic only. Admission remains with the caller's existing shell policy.
export function nonAllowlistedShellCommandMessage(token) {
  return `Shell command contains a non-allowlisted command: ${token || 'unknown'}. ` +
    'This shell checks | and ; as command separators even inside quotes. ' +
    'If you intended regex alternation as data, use separate -match conditions joined by -or. ' +
    'Keep the query within the existing permitted commands; do not retry the same rejected syntax.';
}

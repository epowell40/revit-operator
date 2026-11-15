/** Detect a request to launch the application, not an action in its existing UI. */
export function affirmativeRevitLaunchIntent(userText) {
  const text = String(userText || '').trim();
  if (!text) return null;
  const matches = text.matchAll(/\b(?:open|launch|start|run)\b(?:\s+(?:the|a|autodesk)){0,2}\s+revit(?:\s*(20[2-3]\d))?\b/gi);
  for (const match of matches) {
    const matchStart = match.index ?? 0;
    const localPrefix = text.slice(Math.max(0, matchStart - 32), matchStart);
    const suffix = text.slice(matchStart + match[0].length);
    // Possession and UI-object nouns name an action inside Revit. They do not
    // authorize opening another process, potentially in a different version.
    if (/^(?:['’]s\b|\s+(?:(?:print|export|import|save(?:\s+as)?|open|warning|error|properties)\s+)?(?:dialog|dialogue|menu|window|pane|palette|settings|command)\b)/i.test(suffix)) continue;
    const clausePrefix = text.slice(0, matchStart).split(/[.!?;\r\n]|\bbut\b|\bhowever\b/i).at(-1) || '';
    if (/\b(?:do\s+not|don't|dont|never|avoid|not)\b/i.test(clausePrefix)) continue;
    const verb = /^\s*(open|launch|start|run)\b/i.exec(match[0])?.[1]?.toLowerCase() || '';
    if (verb === 'open' && /(?:\b(?:the|this|that|my|your|our|an?)|\b(?:in|inside|within|from|on|using|use|inspect|query|against|for)(?:\s+(?:the|this|that|my|your|our|an?))?)\s+(?:already\s+|currently\s+)?$/i.test(localPrefix)) continue;
    if (/\b(?:do\s+not|don't|dont|never|avoid|not)\s*$/i.test(localPrefix)) continue;
    if (/\bwithout\s+(?:opening|launching|starting|running)?\s*$/i.test(localPrefix)) continue;
    return { version: match[1] || '' };
  }
  return null;
}

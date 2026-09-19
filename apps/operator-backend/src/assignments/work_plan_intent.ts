/** Ordinary single edits keep their existing latency. Broad reconstruction and
 * explicitly repeated room/system work retain their declared scope. */
export function requiresDurableWorkPlan(text: string): boolean {
  const broad = /\b(?:whole|entire|all|every|each|multiple|both|several)\b/i.test(text);
  const scope = /\b(?:area|floor|rooms?|units?|systems?|branches|spaces|zones|ductwork|devices)\b/i.test(text);
  const action = /\b(?:rebuild|reconstruct|redraw|draft|lay\s+out|layout|populate|route|create|place|restore)\b/i.test(text);
  return broad && scope && action;
}

/** Display identity only. Action controls still obtain their own fresh native read. */
export async function refreshAssignmentDisplayContext(state, fetchHealth, contextFromHealth, {cachedOnly=false}={}) {
  // A background poll may join an explicit read, never the reverse.
  if (cachedOnly && state.assignmentRevitContextRefresh) return state.assignmentRevitContextRefresh;
  const key=cachedOnly?'assignmentRevitContextCachedRefresh':'assignmentRevitContextRefresh';
  if (state[key]) return state[key];
  const revision=(state.assignmentRevitContextRequestRevision??0)+1;
  state.assignmentRevitContextRequestRevision=revision;
  const request=(async()=>{
    let context=null;
    try { context=contextFromHealth(await fetchHealth(cachedOnly?'/api/revit/health?prefer_cached=1':'/api/revit/health')); }
    catch { /* Missing display identity never grants execution authority. */ }
    // A late cached response must not replace an explicit, newer observation.
    if (state.assignmentRevitContextRequestRevision===revision) state.assignmentRevitContext=context;
    return context;
  })();
  state[key]=request;
  try { return await request; }
  finally { if(state[key]===request) state[key]=null; }
}

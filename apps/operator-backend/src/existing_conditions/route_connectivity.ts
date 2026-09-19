import type { ExistingConditionsElement, ExistingConditionsSnapshot } from "./model_contract.js";

export function withoutAbstractedRoutes(snapshot: ExistingConditionsSnapshot, keys: ReadonlySet<string>): ExistingConditionsSnapshot {
  return {
    ...snapshot,
    elements: snapshot.elements.filter(e => !keys.has(e.key)),
    connections: snapshot.connections.filter(e => !keys.has(e.a) && !keys.has(e.b)),
    open_connector_count: 0
  };
}

/** Compare native physical components through plan-space probes. Native segment
 * splits are immaterial; a gap, disconnected fitting, or cross-system join is not. */
export function physicalRouteConnectivity(
  truth: ExistingConditionsSnapshot,
  candidate: ExistingConditionsSnapshot,
  truthRouteKeys: ReadonlySet<string>,
  candidateRouteKeys: ReadonlySet<string>,
  anchors: readonly { truth_key: string; candidate_key: string }[],
  toleranceFt: number
): number {
  const components = (snapshot: ExistingConditionsSnapshot) => {
    const parent = new Map(snapshot.elements.map(e => [e.key, e.key]));
    const root = (key: string): string => {
      const p = parent.get(key);
      if (p === undefined || p === key) return key;
      const r = root(p); parent.set(key, r); return r;
    };
    for (const edge of snapshot.connections) {
      if ((edge.kind ?? "physical") === "physical" && parent.has(edge.a) && parent.has(edge.b)) parent.set(root(edge.a), root(edge.b));
    }
    return new Map(snapshot.elements.map(e => [e.key, root(e.key)]));
  };
  const truthComponents = components(truth), candidateComponents = components(candidate);
  const truthRoutes = truth.elements.filter(e => truthRouteKeys.has(e.key));
  const candidateRoutes = candidate.elements.filter(e => candidateRouteKeys.has(e.key));
  const correspondences: Array<[string, string]> = anchors.map(p => [p.truth_key, p.candidate_key]);
  const probe = (source: ExistingConditionsElement[], target: ExistingConditionsElement[], reverse: boolean): boolean => {
    for (const element of source) {
      if (!element.endpoints) return false;
      const [a,b] = element.endpoints;
      for (const t of [0.1, 0.5, 0.9]) {
        const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
        let best: ExistingConditionsElement | undefined, distance=Infinity;
        for (const other of target) {
          if (!other.endpoints || other.discipline !== element.discipline) continue;
          const [c,d]=other.endpoints, dx=d.x-c.x, dy=d.y-c.y;
          const u=Math.max(0,Math.min(1,((x-c.x)*dx+(y-c.y)*dy)/(dx*dx+dy*dy || 1)));
          const current=Math.hypot(x-c.x-u*dx,y-c.y-u*dy);
          if(current<distance){distance=current;best=other;}
        }
        if (!best || distance>toleranceFt) return false;
        correspondences.push(reverse ? [best.key,element.key] : [element.key,best.key]);
      }
    }
    return true;
  };
  if (!truthRoutes.length || !candidateRoutes.length || !probe(truthRoutes,candidateRoutes,false) || !probe(candidateRoutes,truthRoutes,true)) return 0;
  // A component must correspond to exactly one component in each direction.
  // This rejects splitting a continuous source as well as joining separate runs.
  const forward=new Map<string,string>(), backward=new Map<string,string>();
  for(const [t,c] of correspondences){
    const tc=truthComponents.get(t),cc=candidateComponents.get(c);
    if(!tc || !cc || (forward.has(tc)&&forward.get(tc)!==cc) || (backward.has(cc)&&backward.get(cc)!==tc)) return 0;
    forward.set(tc,cc);backward.set(cc,tc);
  }
  const disciplines=new Set(candidateRoutes.map(e=>e.discipline));
  for(const element of candidate.elements){
    if(element.kind==="fitting" && disciplines.has(element.discipline) && !backward.has(candidateComponents.get(element.key)!)) return 0;
  }
  if(candidate.open_connector_count>truth.open_connector_count) return 0;
  return 1;
}

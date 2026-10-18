/** One transport deadline for the outer abort timer and between-turn runner.
 * Only a trusted, canonical remaining-work projection can extend the base;
 * its separately frozen ceiling stays absolute. This grants no work authority. */
export function createExecutionDeadlineV2(input: {
  maxWallMs: number; maxWallCeilingMs?: number;
  remainingWorkMs?: () => number; now?: () => number;
}): { remainingMs: () => number; arm: (controller: AbortController) => () => void } {
  const now=input.now??Date.now,started=now();let last=started;
  const ceiling=input.remainingWorkMs&&input.maxWallCeilingMs!==undefined?input.maxWallCeilingMs:input.maxWallMs;
  const hard=Number.isFinite(ceiling)&&ceiling>=0?ceiling:0;
  const remainingMs=()=>{
    if(!Number.isFinite(input.maxWallMs)||input.maxWallMs<=0)return 0;
    const at=now();if(!Number.isFinite(started)||!Number.isFinite(at)||at<last)return 0;last=at;
    const elapsed=at-started;let work=input.maxWallMs-elapsed;
    try{if(input.remainingWorkMs)work=input.remainingWorkMs();}catch{return 0;}
    return Number.isFinite(work)?Math.max(0,Math.min(hard-elapsed,work)):0;
  };
  const arm=(controller:AbortController)=>{
    let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
    const dispose=()=>{disposed=true;if(timer!==undefined)clearTimeout(timer);timer=undefined;controller.signal.removeEventListener('abort',dispose);};
    const schedule=(left:number)=>{timer=setTimeout(check,Math.max(1,Math.min(2_147_483_647,Math.ceil(left))));timer.unref?.();};
    const check=()=>{timer=undefined;if(disposed||controller.signal.aborted){dispose();return;}const left=remainingMs();if(left<=0){controller.abort('experiment_wall_limit');dispose();}else schedule(left);};
    if(controller.signal.aborted)return dispose;
    controller.signal.addEventListener('abort',dispose,{once:true});schedule(remainingMs());return dispose;
  };
  return {remainingMs,arm};
}

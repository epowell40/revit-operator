import { createHash } from 'node:crypto';
import { AssignmentJournalV2, reduceAssignmentEventsV2, type AssignmentEventV2 } from '../domain/assignment-kernel/index.js';

/** Reuses validated reducer state only after comparing freshly read canonical
 * events. Neither timestamps nor versions are cache authority. Raw native
 * observations remain in the durable journal. */
export function createContentVerifiedJournalV2(options: {maxEntries?:number; maxBytes?:number} = {}) {
  const maxEntries=options.maxEntries??8, maxBytes=options.maxBytes??64*1024*1024;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256||!Number.isSafeInteger(maxBytes)||maxBytes<1)
    throw new Error('journal_cache_bounds_invalid');
  const entries=new Map<string,{journal:AssignmentJournalV2;bytes:number;eventCount:number;textLength:number}>();
  let bytes=0;
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  function retain(text:string,journal:AssignmentJournalV2,eventCount:number) {
    const key=digest(text), previous=entries.get(key);
    if(previous){bytes-=previous.bytes;entries.delete(key);}
    const size=Buffer.byteLength(text)+Buffer.byteLength(journal.serializedSnapshot());
    if(size>maxBytes)return;
    entries.set(key,{journal:journal.fork(),bytes:size,eventCount,textLength:text.length});bytes+=size;
    while(entries.size>maxEntries||bytes>maxBytes){const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
  }
  return {
    open(events:readonly AssignmentEventV2[]) {
      // Durable history is stricter than idempotent delivery: duplicate entries
      // must retain the original reducer's rejection, even on a cache hit.
      const ids=new Set(events.map(event=>event.event_id));
      if(ids.size!==events.length)
        reduceAssignmentEventsV2(events);
      // Exact JSON preserves order, duplicates and every payload field.
      let text=JSON.stringify(events);
      const key=digest(text), cached=entries.get(key);
      let journal:AssignmentJournalV2;
      if(cached)journal=cached.journal.fork();
      else {
        // Another writer can persist a few events between reads. Verify the
        // ENTIRE previously validated prefix against fresh bytes, then reduce
        // the new tail through the same journal checks. IDs, versions and file
        // timestamps alone never authorize reuse. Limit incremental work: a
        // large tail uses ordinary cold replay, preserving the memory budget.
        const prefix=[...entries].sort((a,b)=>b[1].eventCount-a[1].eventCount).find(([key,entry])=>
          entry.eventCount<events.length&&events.length-entry.eventCount<=32
          &&text[entry.textLength-1]===','&&digest(text.slice(0,entry.textLength-1)+']')===key);
        if(prefix){
          journal=prefix[1].journal.fork();
          for(const event of events.slice(prefix[1].eventCount))journal.append(event);
        }else journal=new AssignmentJournalV2(events);
      }
      if(cached){entries.delete(key);entries.set(key,cached);}
      else if(events.length)retain(text,journal,events.length);
      return {
        snapshot:()=>journal.snapshot(),
        append(event:AssignmentEventV2) {
          const snapshot=journal.append(event);
          // Idempotent delivery does not append duplicate persisted history.
          // Failed disk commits still require the next read to match bytes.
          if(!ids.has(event.event_id)){
            text=text.slice(0,-1)+(text.length>2?',':'')+JSON.stringify(event)+']';
            ids.add(event.event_id);
          }
          retain(text,journal,ids.size);
          return snapshot;
        }
      };
    },
    reset(){entries.clear();bytes=0;},
    stats(){return {entries:entries.size,bytes};}
  };
}

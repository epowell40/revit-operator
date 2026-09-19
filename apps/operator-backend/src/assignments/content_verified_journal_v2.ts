import { createHash } from 'node:crypto';
import { AssignmentJournalV2, reduceAssignmentEventsV2, type AssignmentEventV2 } from '../domain/assignment-kernel/index.js';

/** Reuses validated reducer state only after comparing freshly read canonical
 * events. Neither timestamps nor versions are cache authority. Raw native
 * observations remain in the durable journal. */
export function createContentVerifiedJournalV2(options: {maxEntries?:number; maxBytes?:number} = {}) {
  const maxEntries=options.maxEntries??8, maxBytes=options.maxBytes??64*1024*1024;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256||!Number.isSafeInteger(maxBytes)||maxBytes<1)
    throw new Error('journal_cache_bounds_invalid');
  const entries=new Map<string,{journal:AssignmentJournalV2;bytes:number}>();
  let bytes=0;
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  function retain(text:string,journal:AssignmentJournalV2) {
    const key=digest(text), previous=entries.get(key);
    if(previous){bytes-=previous.bytes;entries.delete(key);}
    const size=Buffer.byteLength(text)+Buffer.byteLength(JSON.stringify(journal.snapshot()));
    if(size>maxBytes)return;
    entries.set(key,{journal:journal.fork(),bytes:size});bytes+=size;
    while(entries.size>maxEntries||bytes>maxBytes){const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
  }
  return {
    open(events:readonly AssignmentEventV2[]) {
      // Durable history is stricter than idempotent delivery: duplicate entries
      // must retain the original reducer's rejection, even on a cache hit.
      if(new Set(events.map(event=>event.event_id)).size!==events.length)
        reduceAssignmentEventsV2(events);
      // Exact JSON preserves order, duplicates and every payload field.
      let text=JSON.stringify(events);
      const key=digest(text), cached=entries.get(key);
      const journal=cached?cached.journal.fork():new AssignmentJournalV2(events);
      if(cached){entries.delete(key);entries.set(key,cached);}
      else if(events.length)retain(text,journal);
      return {
        snapshot:()=>journal.snapshot(),
        append(event:AssignmentEventV2) {
          const snapshot=journal.append(event);
          // Exact next persisted array, including a duplicate replay. A failed
          // disk commit cannot authorize reuse: the next read must match bytes.
          text=text.slice(0,-1)+(text.length>2?',':'')+JSON.stringify(event)+']';
          retain(text,journal);
          return snapshot;
        }
      };
    },
    reset(){entries.clear();bytes=0;},
    stats(){return {entries:entries.size,bytes};}
  };
}

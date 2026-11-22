import { AssignmentJournalV2, reduceAssignmentEventsV2, type AssignmentEventV2 } from '../domain/assignment-kernel/index.js';

/** Reuse validated reducer state only after comparing ALL freshly read canonical
 * events. Neither IDs, timestamps nor versions are cache authority. */
export function createContentVerifiedJournalV2(options: {maxEntries?:number; maxBytes?:number} = {}) {
  const maxEntries=options.maxEntries??8, maxBytes=options.maxBytes??64*1024*1024;
  if(!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>256||!Number.isSafeInteger(maxBytes)||maxBytes<1)
    throw new Error('journal_cache_bounds_invalid');
  type Entry = {journal:AssignmentJournalV2;bytes:number;eventCount:number;eventBytes:number};
  const entries=new Map<number,Entry>();
  let bytes=0, sequence=0;
  function retain(journal:AssignmentJournalV2,eventCount:number,eventBytes:number) {
    const size=eventBytes+Buffer.byteLength(journal.serializedSnapshot());
    if(size>maxBytes)return;
    entries.set(++sequence,{journal:journal.fork(),bytes:size,eventCount,eventBytes});bytes+=size;
    while(entries.size>maxEntries||bytes>maxBytes){const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
  }
  return {
    open(events:readonly AssignmentEventV2[]) {
      // Persisted duplicates retain the strict cold reducer rejection.
      const ids=new Set(events.map(event=>event.event_id));
      if(ids.size!==events.length)reduceAssignmentEventsV2(events);
      // Compare private immutable events, including unknown fields, to the full
      // fresh prefix. This avoids serializing/hashing multi-megabyte accepted
      // history at every native admission and provider-state transition.
      const prefix=[...entries].sort((a,b)=>b[1].eventCount-a[1].eventCount).find(([,entry])=>
        entry.eventCount<=events.length&&events.length-entry.eventCount<=32
        &&entry.journal.matchesHistoryPrefix(events));
      let journal:AssignmentJournalV2, eventBytes:number;
      if(prefix){
        journal=prefix[1].journal.fork();eventBytes=prefix[1].eventBytes;
        for(const event of events.slice(prefix[1].eventCount)){
          journal.append(event);eventBytes+=1+Buffer.byteLength(JSON.stringify(event));
        }
        if(prefix[1].eventCount===events.length){entries.delete(prefix[0]);entries.set(prefix[0],prefix[1]);}
        else retain(journal,events.length,eventBytes);
      }else{
        journal=new AssignmentJournalV2(events);
        eventBytes=Buffer.byteLength(JSON.stringify(events));
        if(events.length)retain(journal,events.length,eventBytes);
      }
      return {
        snapshot:()=>journal.snapshot(),
        append(event:AssignmentEventV2) {
          const snapshot=journal.append(event);
          // A failed append never replaces a validated entry. A failed disk
          // commit must still match the old freshly read history on next open.
          if(!ids.has(event.event_id)){
            eventBytes+=(ids.size?1:0)+Buffer.byteLength(JSON.stringify(event));
            ids.add(event.event_id);retain(journal,ids.size,eventBytes);
          }
          return snapshot;
        }
      };
    },
    reset(){entries.clear();bytes=0;},
    stats(){return {entries:entries.size,bytes};}
  };
}

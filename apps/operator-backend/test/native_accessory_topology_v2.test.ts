import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeAccessoryTopologyV2} from '../src/verification/native_accessory_topology_v2.js';

// Synthetic native-shaped graph contracts, not evidence of a live placement.
import {fixture} from './native_accessory_topology.fixtures.js';
const run=(f:ReturnType<typeof fixture>)=>nativeAccessoryTopologyV2(f.before,f.after,f.hosts,f.placed,f.added,f.typeId,f.kind);
for(const kind of ['duct','pipe'] as const)for(const keep of ['start','end','neither'] as const)
  test(`${kind}: ${keep} ID retention, two native accessories use endpoints and reciprocal ports`,()=>{
    const f=fixture(kind,2,keep),r=run(f);assert.ok(r);assert.equal(r.runs.length,1);assert.deepEqual(r.runs[0]!.accessoryIds,f.placed);
    assert.equal(r.runs[0]!.segmentIds.length,3);
  });
test('supports coincident accessory ports without inventing a removed duct length',()=>assert.ok(run(fixture('pipe',1,'end',true))));
test('fifty accessories remain bounded and fully consumed',()=>assert.equal(run(fixture('duct',50))?.runs[0]?.accessoryIds.length,50));
test('computed flow and derived flow direction changes are not physical topology equality',()=>{
  const f=fixture();for(const e of f.after.results)for(const c of e.connectors){c.flow=300;c.direction='Out';}assert.ok(run(f));
});
for(const [name,damage] of Object.entries({
  'wrong port diameter':(f:any)=>{f.after.results.find((r:any)=>r.id===200).connectors[0].size={kind:'round',radiusFt:.5,diameterFt:1};},
  'unreciprocated connection':(f:any)=>{const e=f.after.results.find((r:any)=>r.id===200);e.connectors[0].physicalConnectedTo[0].connectorId=99;},
  'host span lost':(f:any)=>{f.after.results.find((r:any)=>r.id===101).connectors[1].origin=[9,0,0];},
  'accessory off centerline':(f:any)=>{f.after.results.find((r:any)=>r.id===200).connectors[1].origin[1]=.1;},
  'wrong accessory type':(f:any)=>{f.after.results.find((r:any)=>r.id===200).typeId=999;},
  'remote port geometry changed':(f:any)=>{f.after.results.find((r:any)=>r.id===50).connectors[1].origin[0]=12;},
  'remote basis rotated':(f:any)=>{f.after.results.find((r:any)=>r.id===50).connectors[1].coordinateSystem.basisZ=[0,1,0];},
  'unreported new physical owner':(f:any)=>{f.added.pop();},
  'unconsumed placement':(f:any)=>{f.placed.push(999);f.added.push(999);},
  'wrong host':(f:any)=>{f.hosts=[40];},
  'truncated graph':(f:any)=>{f.after.connectorScanTruncatedElementCount=1;},
  'unknown physical refs':(f:any)=>{f.after.unknownPhysicalConnectorCount=1;},
  'reference read failure':(f:any)=>{f.after.results[0].connectors[0].referenceReadErrorCount=1;},
  'malformed numbers':(f:any)=>{f.after.results[0].connectors[0].origin[0]=NaN;},
  'no placements':(f:any)=>{f.placed=[];},
  'duplicate scope':(f:any)=>{f.hosts=[10,10];},
  'wrong domain':(f:any)=>{f.kind='pipe';},
}))test(`rejects ${name}`,()=>{const f=fixture();damage(f);assert.equal(run(f),null);});
test('rectangular native schema retains both dimensions',()=>{
  const f=fixture();for(const scan of [f.before,f.after])for(const e of scan.results)for(const c of e.connectors){
    c.shape='Rectangular';c.size={kind:'rect',widthFt:1,heightFt:.5};}
  assert.ok(run(f));f.after.results[1].connectors[0].size.heightFt=.75;assert.equal(run(f),null);
});
test('malformed top level fails closed',()=>assert.equal(nativeAccessoryTopologyV2(null,null,[1],[2],[2],3,'duct'),null));
function merge(first:ReturnType<typeof fixture>,second:ReturnType<typeof fixture>){
  for(const scan of [second.before,second.after])for(const e of scan.results){e.id+=1000;
    for(const p of e.connectors){p.origin[1]+=20;for(const refs of [p.connectedTo,p.physicalConnectedTo])for(const r of refs){r.ownerId+=1000;r.origin[1]+=20;}}}
  first.before=first.scan([...first.before.results,...second.before.results]);first.after=first.scan([...first.after.results,...second.after.results]);
  first.hosts.push(...second.hosts.map(n=>n+1000));first.placed.push(...second.placed.map(n=>n+1000));first.added.push(...second.added.map(n=>n+1000));return first;
}
test('two independent target runs preserve their own native far peers',()=>{
  const f=merge(fixture('duct',2,'end'),fixture('duct',1,'start'));assert.equal(run(f)?.runs.length,2);
});
test('an untouched requested host remains explicitly untouched, not fabricated as completed',()=>{
  const f=merge(fixture(),fixture('duct',0));assert.deepEqual(run(f)?.untouchedHostIds,[1010]);assert.equal(run(f)?.runs.length,1);
});
test('preserves an existing remote noncoincident side tap but refuses changing its geometry',()=>{
  const f=fixture();
  for(const s of [f.before,f.after]){
    const remote=f.owner(70,'OST_DuctTerminal',170,12,13),right=s.results.find((r:any)=>r.id===50)!;
    // A pre-existing native physical side tap with separate stored origins.
    f.connect(right,1,remote,0);s.results.push(remote);f.scan(s.results);
    Object.assign(s,f.scan(s.results));
  }
  assert.ok(run(f));f.after.results.find((r:any)=>r.id===70)!.connectors[0].origin[0]+=1;assert.equal(run(f),null);
});
test('retains an equipment electrical port while checking new HVAC connections',()=>{
  const f=fixture();for(const s of [f.before,f.after]){
    const e=s.results.find((r:any)=>r.id===40)!;e.category='OST_MechanicalEquipment';
    const p=structuredClone(e.connectors[0]);p.connectorId=7;p.domain='DomainElectrical';p.shape='Invalid';p.size=null;e.connectors.push(p);
    for(const other of s.results)for(const c of other.connectors)for(const refs of [c.connectedTo,c.physicalConnectedTo])for(const r of refs)
      if(r.ownerId===40)r.ownerCategory=e.category;
    Object.assign(s,f.scan(s.results));
  }
  assert.ok(run(f));f.after.results.find((r:any)=>r.id===40)!.connectors[2].domain='DomainPiping';assert.equal(run(f),null);
});

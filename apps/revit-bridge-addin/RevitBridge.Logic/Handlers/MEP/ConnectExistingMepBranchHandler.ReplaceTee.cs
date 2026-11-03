using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Events;
using Autodesk.Revit.DB.Mechanical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed partial class ConnectExistingMepBranchHandler
    {
        // Keep both old main ducts (and their tags). Replace only the tee with a
        // straight bridge and native takeoff inside one rollback-capable group.
        private static object HandleTeeReplacement(UIApplication app, Document doc, Params p, Action enterNativeScope)
        {
            if (!string.Equals(p.kind,"duct",StringComparison.OrdinalIgnoreCase) || !p.verify ||
                !p.teeElementId.HasValue || !p.secondMainElementId.HasValue ||
                !p.expectedTakeoffTypeId.HasValue || p.expectedTakeoffTypeId<=0 ||
                p.originToleranceFt>0.01 || p.worksetId.HasValue || !string.IsNullOrWhiteSpace(p.worksetName))
                throw new ArgumentException("replace_tee_with_takeoff requires duct, verify=true, teeElementId, secondMainElementId, a loaded expectedTakeoffTypeId and tolerance <=0.01 ft. Workset is inherited from the retained main.");
            var ids=new[]{p.mainElementId,p.secondMainElementId.Value,p.branchElementId,p.teeElementId.Value};
            if(ids.Any(id=>id<=0)||ids.Distinct().Count()!=4)
                throw new ArgumentException("Replacement requires four distinct positive existing element IDs.");
            var first=doc.GetElement(ElementIdCompat.Create(p.mainElementId)) as Duct;
            var second=doc.GetElement(ElementIdCompat.Create(p.secondMainElementId.Value)) as Duct;
            var branch=doc.GetElement(ElementIdCompat.Create(p.branchElementId)) as MEPCurve;
            var tee=doc.GetElement(ElementIdCompat.Create(p.teeElementId.Value)) as FamilyInstance;
            if(first==null||second==null||branch==null||tee==null||tee.MEPModel is not MechanicalFitting mechanical||mechanical.PartType.ToString()!="Tee")
                throw new ArgumentException("Replacement requires two existing rigid ducts, a rigid/flex branch and a native mechanical Tee.");
            GuardCurveKind(branch,"duct","branchElementId",allowFlex:true);
            if(ids.Select(id=>doc.GetElement(ElementIdCompat.Create(id))).Any(e=>e.Pinned||e.GroupId!=ElementId.InvalidElementId))
                throw new ArgumentException("Pinned or grouped junction members cannot be replaced.");
            var symbol=doc.GetElement(ElementIdCompat.Create(p.expectedTakeoffTypeId.Value)) as FamilySymbol;
            if(symbol==null||ElementIdCompat.GetValue(symbol.Category.Id)!=(long)BuiltInCategory.OST_DuctFitting)
                throw new ArgumentException("expectedTakeoffTypeId must identify a loaded duct fitting FamilySymbol.");
            var ports=MepRoutingUtil.GetConnectors(tee);
            if(ports.Count!=3||ports.Any(c=>c.ConnectorType!=ConnectorType.End||c.Shape!=ConnectorProfileType.Round||c.Domain!=Domain.DomainHvac||PhysicalConnectorReferences(c).Count!=1))
                throw new ArgumentException("The tee must have exactly three physically connected round HVAC end connectors.");
            Connector Peer(long ownerId)
            {var peers=ports.SelectMany(PhysicalConnectorReferences).Where(c=>ElementIdCompat.GetValue(c.Owner.Id)==ownerId).ToList();
                if(peers.Count!=1)throw new ArgumentException("Each requested neighbor must connect exactly once to this tee.");return peers[0];}
            var a=Peer(p.mainElementId);var b=Peer(p.secondMainElementId.Value);var c=Peer(p.branchElementId);
            long NativeId(Connector x)=>MepSystemUtil.TryGetNativeConnectorId(x,out var id)?id:throw new InvalidOperationException("Stable native connector IDs are required.");
            var aid=NativeId(a);var bid=NativeId(b);var cid=NativeId(c);
            if(p.branchConnectorId.HasValue&&p.branchConnectorId!=cid)throw new ArgumentException("branchConnectorId no longer identifies the tee connection.");
            if(p.expectedBranchOriginXyz!=null&&(!HasPoint(p.expectedBranchOriginXyz)||c.Origin.DistanceTo(ToXyz(p.expectedBranchOriginXyz))>p.originToleranceFt))
                throw new ArgumentException("The guarded branch origin changed.");
            // Peer connector direction points into the gap; reverse it to obtain
            // the direction of each retained run away from the removed fitting.
            BranchPoint3d Point(XYZ v)=>new BranchPoint3d(v.X,v.Y,v.Z);
            var plan=TeeTakeoffReplacementGeometry.Plan(Point(a.Origin),Point(b.Origin),Point(c.Origin),
                Point(-a.CoordinateSystem.BasisZ),Point(-b.CoordinateSystem.BasisZ),a.Radius*2,b.Radius*2,c.Radius*2,
                doc.Application.ShortCurveTolerance,p.originToleranceFt);
            var ac=(first.Location as LocationCurve)?.Curve as Line;var bc=(second.Location as LocationCurve)?.Curve as Line;
            if(ac==null||bc==null||first.GetTypeId()!=second.GetTypeId()||first.ReferenceLevel?.Id!=second.ReferenceLevel?.Id||
                first.CreatedPhaseId!=second.CreatedPhaseId||first.DemolishedPhaseId!=second.DemolishedPhaseId||
                first.WorksetId!=second.WorksetId||first.MEPSystem==null||second.MEPSystem==null||first.MEPSystem.Id!=second.MEPSystem.Id)
                throw new ArgumentException("Retained runs must be straight and share duct type, level, phase, workset and native system.");
            var systemType=first.MEPSystem.GetTypeId();var ductType=first.GetTypeId();var level=first.ReferenceLevel!.Id;
            var originA=a.Origin;var originB=b.Origin;var originC=c.Origin;
            var diameterFt=a.Radius*2;
            var allBefore=ids.ToDictionary(id=>id,id=>CapturePhysicalConnections(doc.GetElement(ElementIdCompat.Create(id))));
            var retainedBefore=ids.Take(3).ToDictionary(id=>id,id=>allBefore[id].Where(e=>e.ConnectedOwnerId!=p.teeElementId.Value).ToList());
            var metadata=ids.Take(3).ToDictionary(id=>id,id=>ReplacementMetadata(doc.GetElement(ElementIdCompat.Create(id))));
            var geometry=ids.Take(3).ToDictionary(id=>id,id=>ReplacementCurvePoints(doc.GetElement(ElementIdCompat.Create(id))));
            var oldPorts=ids.Take(3).ToDictionary(id=>id,id=>MepRoutingUtil.GetConnectors(doc.GetElement(ElementIdCompat.Create(id)))
                .ToDictionary(NativeId,x=>x.Origin));
            var scheduleIds=new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule)).Cast<ViewSchedule>()
                .Where(v=>!v.IsTemplate&&!v.IsTitleblockRevisionSchedule).Select(v=>ElementIdCompat.GetValue(v.Id)).OrderBy(x=>x).ToArray();
            if(scheduleIds.Length>32)throw new InvalidOperationException("Replacement schedule preservation exceeds bound.");
            var teeUniqueId=tee.UniqueId;
            var preservationBefore=TeeTakeoffReplacementObservation.Read(doc,ids,Array.Empty<long>(),scheduleIds,new[]{p.expectedTakeoffTypeId.Value});
            var beforeTypes=preservationBefore.GetProperty("types").EnumerateArray().Select(r=>r.GetProperty("elementId").GetInt64()).ToArray();
            var deletedScope=TeeTakeoffDependentClosure.RequireDeletion(p.teeElementId.Value,tee.UniqueId,preservationBefore.GetProperty("centerlines"),
                new[]{p.teeElementId.Value}.Concat(preservationBefore.GetProperty("centerlines").EnumerateArray()
                    .Where(r=>r.GetProperty("parentId").GetInt64()==p.teeElementId.Value).Select(r=>r.GetProperty("elementId").GetInt64())));
            JsonElement? preservationAfter=null;
            var created=new List<long>();var addedScope=new List<long>();var modifiedScope=new List<long>();
            long? bridgeId=null,takeoffId=null;var deletedTeeConfirmed=false;
            var failures=new OperatorNativeFailureGuard();var verified=false;var rollbackVerified=false;
            Connector Current(long owner,long connector)=>MepRoutingUtil.GetConnectors(doc.GetElement(ElementIdCompat.Create(owner)))
                .Single(x=>MepSystemUtil.TryGetNativeConnectorId(x,out var id)&&id==connector);
            void VerifyOwners(bool replaced)
            {
                foreach(var id in ids.Take(3))
                {
                    var owner=doc.GetElement(ElementIdCompat.Create(id))??throw new InvalidOperationException("A retained duct disappeared.");
                    if(ReplacementMetadata(owner)!=metadata[id])throw new InvalidOperationException("Retained owner type/system/phase/workset/size changed.");
                    if(FindMissingPhysicalConnections(owner,replaced?retainedBefore[id]:allBefore[id],p.originToleranceFt).Count!=0)
                        throw new InvalidOperationException("A retained far connection changed.");
                    var points=ReplacementCurvePoints(owner);var before=geometry[id];
                    if(points.Count!=before.Count)throw new InvalidOperationException("Retained branch control-point inventory changed.");
                    for(var i=0;i<points.Count;i++)
                    {
                        var selectedEnd=id==p.branchElementId&&(i==0||i==points.Count-1)&&before[i].DistanceTo(originC)<=p.originToleranceFt;
                        if(!selectedEnd||!replaced){if(points[i].DistanceTo(before[i])>p.originToleranceFt)throw new InvalidOperationException("Retained curve geometry changed.");}
                        else if(points[i].DistanceTo(originC)>plan.BranchOffsetFt+p.originToleranceFt)
                            throw new InvalidOperationException("Takeoff displaced the branch beyond the original junction envelope.");
                    }
                    foreach(var port in oldPorts[id])
                    {
                        if(!(replaced&&id==p.branchElementId&&port.Key==cid)&&Current(id,port.Key).Origin.DistanceTo(port.Value)>p.originToleranceFt)
                            throw new InvalidOperationException("A retained connector moved.");
                        var isReplacedEnd=replaced&&((id==p.mainElementId&&port.Key==aid)||(id==p.secondMainElementId&&port.Key==bid)||(id==p.branchElementId&&port.Key==cid));
                        if(!isReplacedEnd)
                        {
                            var expected=allBefore[id].Where(e=>e.ConnectorId==port.Key).Select(e=>$"{e.ConnectedOwnerId}:{e.ConnectedConnectorId}").OrderBy(x=>x).ToArray();
                            var actual=PhysicalConnectorReferences(Current(id,port.Key)).Select(e=>$"{ElementIdCompat.GetValue(e.Owner.Id)}:{NativeId(e)}").OrderBy(x=>x).ToArray();
                            if(!expected.SequenceEqual(actual))throw new InvalidOperationException("A retained far connector gained or lost a physical peer.");
                        }
                    }
                    if(!MepRoutingUtil.GetConnectors(owner).Select(NativeId).OrderBy(x=>x).SequenceEqual(oldPorts[id].Keys.OrderBy(x=>x)))
                        throw new InvalidOperationException("A retained owner gained or lost a connector.");
                }
            }
            void VerifyReplacement()
            {
                if(doc.GetElement(ElementIdCompat.Create(p.teeElementId.Value))!=null)throw new InvalidOperationException("Original tee still exists.");
                var bridge=doc.GetElement(ElementIdCompat.Create(bridgeId!.Value)) as Duct??throw new InvalidOperationException("Bridge is missing.");
                var fitting=doc.GetElement(ElementIdCompat.Create(takeoffId!.Value))??throw new InvalidOperationException("Takeoff is missing.");
                ReadFamilyType(fitting,out var family,out var type);GuardExpectedTakeoffIdentity(p,ElementIdCompat.GetValue(fitting.GetTypeId()),family,type);
                var ends=MepRoutingUtil.GetConnectors(bridge).Where(x=>x.ConnectorType==ConnectorType.End).ToList();
                var line=(bridge.Location as LocationCurve)?.Curve as Line;
                if(line==null||line.GetEndPoint(0).DistanceTo(originA)>p.originToleranceFt||line.GetEndPoint(1).DistanceTo(originB)>p.originToleranceFt||
                    ReplacementMetadata(bridge)!=metadata[p.mainElementId])
                    throw new InvalidOperationException("The bridge changed required geometry, size, type, level, phase, system type or workset. "+
                        (line==null?"bridgeLine=unavailable; ":FormattableString.Invariant(
                            $"bridgeStartErrorFt={line.GetEndPoint(0).DistanceTo(originA):R}; bridgeEndErrorFt={line.GetEndPoint(1).DistanceTo(originB):R}; reverseStartErrorFt={line.GetEndPoint(1).DistanceTo(originA):R}; reverseEndErrorFt={line.GetEndPoint(0).DistanceTo(originB):R}; toleranceFt={p.originToleranceFt:R}; "))+
                        InlineAccessoryMetadataDiagnostic.Describe(metadata[p.mainElementId],ReplacementMetadata(bridge)));
                if(ends.Count!=2||!PhysicalConnectedOwnerIds(Current(p.mainElementId,aid)).SequenceEqual(new[]{bridgeId.Value})||
                    !PhysicalConnectedOwnerIds(Current(p.secondMainElementId.Value,bid)).SequenceEqual(new[]{bridgeId.Value})||
                    !PhysicalConnectedOwnerIds(Current(p.branchElementId,cid)).SequenceEqual(new[]{takeoffId.Value}))
                    throw new InvalidOperationException("Requested main/branch reciprocal connections were not established.");
                var bridgePeers=MepRoutingUtil.GetConnectors(bridge).SelectMany(PhysicalConnectedOwnerIds).Distinct().OrderBy(x=>x).ToArray();
                var takeoffPeers=MepRoutingUtil.GetConnectors(fitting).SelectMany(PhysicalConnectedOwnerIds).Distinct().OrderBy(x=>x).ToArray();
                if(!bridgePeers.SequenceEqual(new[]{p.mainElementId,p.secondMainElementId.Value,takeoffId.Value}.OrderBy(x=>x))||
                    !takeoffPeers.SequenceEqual(new[]{bridgeId.Value,p.branchElementId}.OrderBy(x=>x))||
                    MepRoutingUtil.GetConnectors(bridge).Any(x=>PhysicalConnectorReferences(x).Count!=1)||
                    MepRoutingUtil.GetConnectors(fitting).Count!=2||MepRoutingUtil.GetConnectors(fitting).Any(x=>PhysicalConnectorReferences(x).Count!=1))
                    throw new InvalidOperationException("Replacement graph has missing or unexpected physical connections.");
                VerifyOwners(true);
            }
            var childInventory=new OperatorNativeChangeInventory(doc);
            void Changed(object sender,DocumentChangedEventArgs e)=>childInventory.Observe(()=>e.GetDocument(),
                ()=>e.GetAddedElementIds().Select(ElementIdCompat.GetValue),()=>e.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                ()=>e.GetDeletedElementIds().Select(ElementIdCompat.GetValue));
            enterNativeScope();
            Dictionary<string,object?> execution;
            app.Application.DocumentChanged+=Changed;
            try { execution=NativeAtomicTransactionGroup.Execute(app,doc,"Replace Tee With Takeoff",()=>
            {
                using(var tx=new Transaction(doc,"Replace Tee With Takeoff"))
                {
                    if(tx.Start()!=TransactionStatus.Started)throw new InvalidOperationException("Replacement transaction did not start.");
                    NativeNonInteractiveFailureHandling.Configure(tx,failures);
                    var deleted=doc.Delete(tee.Id).Select(ElementIdCompat.GetValue).ToArray();
                    TeeTakeoffDependentClosure.RequireDeletion(p.teeElementId.Value,teeUniqueId,preservationBefore.GetProperty("centerlines"),deleted);
                    deletedTeeConfirmed=true;
                    doc.Regenerate();
                    var bridge=Duct.Create(doc,systemType,ductType,level,originA,originB);bridgeId=ElementIdCompat.GetValue(bridge.Id);created.Add(bridgeId.Value);
                    bridge.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM).Set(diameterFt);
                    bridge.CreatedPhaseId=first.CreatedPhaseId;bridge.DemolishedPhaseId=first.DemolishedPhaseId;
                    if(doc.IsWorkshared)bridge.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM).Set(ElementIdCompat.GetValue(first.WorksetId));
                    doc.Regenerate();
                    Connector BridgeEnd(XYZ point)=>MepRoutingUtil.GetConnectors(bridge).Single(x=>x.ConnectorType==ConnectorType.End&&x.Origin.DistanceTo(point)<=p.originToleranceFt);
                    Current(p.mainElementId,aid).ConnectTo(BridgeEnd(originA));
                    Current(p.secondMainElementId.Value,bid).ConnectTo(BridgeEnd(originB));doc.Regenerate();
                    var fitting=doc.Create.NewTakeoffFitting(Current(p.branchElementId,cid),bridge)??throw new InvalidOperationException("Revit did not create the takeoff.");
                    takeoffId=ElementIdCompat.GetValue(fitting.Id);created.Add(takeoffId.Value);
                    if(fitting.GetTypeId()!=symbol.Id){var changed=fitting.ChangeTypeId(symbol.Id);if(changed!=ElementId.InvalidElementId&&changed!=fitting.Id)throw new InvalidOperationException("Takeoff type change replaced its native identity.");}
                    fitting.CreatedPhaseId=first.CreatedPhaseId;fitting.DemolishedPhaseId=first.DemolishedPhaseId;
                    if(doc.IsWorkshared)fitting.get_Parameter(BuiltInParameter.ELEM_PARTITION_PARAM).Set(ElementIdCompat.GetValue(first.WorksetId));
                    // New duct system metadata may not resolve until child
                    // commit. The unchanged full check below still runs inside
                    // the outer group, before preservation and assimilation.
                    doc.Regenerate();
                    if(tx.Commit()!=TransactionStatus.Committed)throw new InvalidOperationException("Replacement child transaction did not commit.");
                }
                if(!childInventory.Exhaustive)throw new InvalidOperationException("Replacement child change inventory is incomplete.");
                var childReceipt=childInventory.CommittedReceipt();
                VerifyReplacement();
                var after=TeeTakeoffReplacementObservation.Read(doc,ids.Take(3).Concat(created).ToArray(),deletedScope,scheduleIds,beforeTypes);
                var currentBridge=doc.GetElement(ElementIdCompat.Create(bridgeId!.Value));
                var currentTakeoff=doc.GetElement(ElementIdCompat.Create(takeoffId!.Value));
                addedScope.AddRange(TeeTakeoffDependentClosure.RequireAdded(bridgeId.Value,currentBridge.UniqueId,takeoffId.Value,currentTakeoff.UniqueId,
                    after.GetProperty("centerlines"),childReceipt.AddedElementIds));
                var preservationStage="transition";long[]? covered=null;
                try
                {
                    covered=TeeTakeoffPreservation.RequireTransition(preservationBefore,after,p.teeElementId.Value,bridgeId.Value,takeoffId.Value,ids.Take(3).ToArray());
                    var collateral=TeeCollateralPreservation.RequireUnchanged(preservationBefore.GetProperty("collateral"),after.GetProperty("collateral"),
                        childReceipt.ModifiedElementIds.Except(covered).ToArray(),covered.Concat(deletedScope).Distinct().ToArray());
                    covered=covered.Concat(collateral).ToArray();
                    preservationStage="footprint";
                    TeeTakeoffPreservation.RequireFootprint(addedScope,deletedScope,covered,childReceipt.AddedElementIds,childReceipt.DeletedElementIds,childReceipt.ModifiedElementIds);
                }
                catch(InvalidOperationException error)
                {
                    // Explanation only: keep the failed state out of the success
                    // receipt and preserve the same outer-group rollback.
                    var detail=TeeTakeoffPreservationDiagnostic.Describe(preservationStage,preservationBefore,after,JsonSerializer.SerializeToElement(new{
                        teeId=p.teeElementId.Value,bridgeId=bridgeId.Value,fittingId=takeoffId.Value,retainedIds=ids.Take(3).ToArray(),
                        expectedAddedIds=addedScope,expectedDeletedIds=deletedScope,addedIds=childReceipt.AddedElementIds,
                        deletedIds=childReceipt.DeletedElementIds,modifiedIds=childReceipt.ModifiedElementIds,allowedModifiedIds=covered}));
                    throw new InvalidOperationException(error.Message+" "+detail,error);
                }
                // Leave room inside the existing retained-evidence byte bound
                // for the transaction, guarded geometry and physical references.
                if(System.Text.Encoding.UTF8.GetByteCount(preservationBefore.GetRawText())+System.Text.Encoding.UTF8.GetByteCount(after.GetRawText())>1500000
                    ||System.Text.Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(new{
                        retained=retainedBefore.ToDictionary(x=>x.Key.ToString(),x=>x.Value.Select(DescribePhysicalConnection).ToArray()),metadata,
                        curves=geometry.ToDictionary(x=>x.Key.ToString(),x=>x.Value.Select(ToPoint).ToArray())}))>250000)
                    throw new InvalidOperationException("Replacement proof exceeds the existing retained-evidence bound; atomic rollback required.");
                modifiedScope.AddRange(childReceipt.ModifiedElementIds);
                preservationAfter=after;verified=true;
                return new Dictionary<string,object?>{["success"]=true};
            },()=>addedScope.Count>0?addedScope:created,()=>modifiedScope,p.dryRun?NativeTransactionDisposition.Rollback:NativeTransactionDisposition.Commit,
                ()=>deletedTeeConfirmed?deletedScope:Array.Empty<long>()); }
            finally { app.Application.DocumentChanged-=Changed; }
            var receipt=(OperatorNativeTransactionReceipt)execution["transaction"]!;
            if(receipt.Status=="rolled_back")
            {
                try{VerifyOwners(false);rollbackVerified=deletedScope.All(id=>doc.GetElement(ElementIdCompat.Create(id))!=null)
                    &&created.Concat(addedScope).All(id=>doc.GetElement(ElementIdCompat.Create(id))==null)
                    &&preservationBefore.GetRawText()==TeeTakeoffReplacementObservation.Read(doc,ids,Array.Empty<long>(),scheduleIds,new[]{p.expectedTakeoffTypeId.Value}).GetRawText();}
                catch{rollbackVerified=false;}
            }
            var success=execution["success"] is bool ok&&ok&&verified&&(receipt.CommittedValue==true||p.dryRun&&rollbackVerified);
            return new {success,status=success?(p.dryRun?"DryRunReady":"Replaced"):"Blocked",connectionMode="replace_tee_with_takeoff",dryRun=p.dryRun,
                teeElementId=p.teeElementId,mainElementId=p.mainElementId,secondMainElementId=p.secondMainElementId,branchElementId=p.branchElementId,
                mainConnectorId=aid,secondMainConnectorId=bid,branchConnectorId=cid,branchConnector=DescribeReplacementBefore(cid,originC),
                retainedConnections=retainedBefore.ToDictionary(x=>x.Key.ToString(),x=>x.Value.Select(DescribePhysicalConnection).ToArray()),
                retainedOwnerMetadata=metadata,retainedCurvePoints=geometry.ToDictionary(x=>x.Key.ToString(),x=>x.Value.Select(ToPoint).ToArray()),
                bridgeStart=ToPoint(originA),bridgeEnd=ToPoint(originB),branchOffsetFt=plan.BranchOffsetFt,
                createdBridgeId=receipt.CommittedValue==true?bridgeId:null,createdFittingId=receipt.CommittedValue==true?takeoffId:null,
                previewCreatedIds=p.dryRun?created.ToArray():Array.Empty<long>(),transaction=receipt,changeTracking=execution["changeTracking"],
                applied=receipt.CommittedValue,rollbackVerified,error=execution.TryGetValue("error",out var error)?error:null,
                capturedFailures=failures.Failures,postChildCommitVerified=verified,preservationBefore,preservationAfter};
        }

        private static object DescribeReplacementBefore(long id,XYZ origin)=>new{connectorId=id,connectorIdBasis="revit_native_connector_id",origin=ToPoint(origin)};
        private static List<XYZ> ReplacementCurvePoints(Element owner)=>owner is FlexDuct flex?flex.Points.ToList():
            (owner.Location as LocationCurve)?.Curve is Line line?new List<XYZ>{line.GetEndPoint(0),line.GetEndPoint(1)}:
            throw new InvalidOperationException("Retained owner has unsupported curve geometry.");
        private static string ReplacementMetadata(Element owner)
        {
            var curve=owner as MEPCurve;
            return JsonSerializer.Serialize(new {type=ElementIdCompat.GetValue(owner.GetTypeId()),phase=ElementIdCompat.GetValue(owner.CreatedPhaseId),
                demolished=ElementIdCompat.GetValue(owner.DemolishedPhaseId),workset=ElementIdCompat.GetValue(owner.WorksetId),
                systemType=curve?.MEPSystem==null?(long?)null:ElementIdCompat.GetValue(curve.MEPSystem.GetTypeId()),
                level=curve?.ReferenceLevel==null?(long?)null:ElementIdCompat.GetValue(curve.ReferenceLevel.Id),
                diameter=owner.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)?.AsDouble()});
        }
    }
}

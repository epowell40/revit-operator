using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TeeTakeoffDependentClosureTests
    {
        // Retained104 IDs are the actual rejected deletion set. Parent-bound
        // rows here model the native dependency reader, not a live API claim.
        private static object Center(long id=1404063,long parent=1404060,string parentUid="tee-uid",
            string className="Autodesk.Revit.DB.Element",long category=-2008066,string[]? schemas=null)
            => new {elementId=id,uniqueId="center-"+id,parentId=parent,parentUniqueId=parentUid,
                className,categoryId=category,schemaGuids=schemas??Array.Empty<string>(),
                parameters=Array.Empty<object>(),parentParameters=Array.Empty<object>()};
        private static JsonElement Rows(params object[] rows)=>JsonSerializer.SerializeToElement(rows);

        [Fact] public void Retained104DeletionNeedsExactNativeParentBoundCenterline()
        {
            var actual=new[]{1404060L,1404063L};
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffReplacementGeometry.RequireOnlyRequestedDeletion(1404060,actual));
            Assert.Equal(actual,TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(Center()),actual));
            Assert.Throws<InvalidOperationException>(()=>TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(),actual));
        }

        [Fact] public void NeighborTagForeignParentAndUntrustedProfileCannotBeExempted()
        {
            var actual=new[]{1404060L,1404063L};
            foreach(var row in new[]{Center(parent:7),Center(parentUid:"stale"),Center(className:"Autodesk.Revit.DB.IndependentTag"),
                Center(category:-2008010),Center(schemas:new[]{"custom-data"}),Center(id:1404060)})
                Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(row),actual));
            Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(Center(),Center()),actual));
            Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(Center()),new[]{1404060L,1404063L,1404061L}));
        }

        [Fact] public void MissingDuplicateAndAdditionalCandidatesStillRollBack()
        {
            foreach(var ids in new[]{Array.Empty<long>(),new[]{1404063L},new[]{1404060L},new[]{1404060L,1404063L,1404063L},new[]{-1L,1404060L,1404063L}})
                Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireDeletion(1404060,"tee-uid",Rows(Center()),ids));
            Assert.Equal(new[]{10L},TeeTakeoffDependentClosure.RequireDeletion(10,"t",Rows(),new[]{10L}));
        }

        [Fact] public void CreatedInventoryIncludesOnlyBothPhysicalOwnersAndTheirNativeDependents()
        {
            var centers=Rows(Center(21,20,"bridge"),Center(31,30,"fitting"),Center(41,40,"retained"));
            var expected=new[]{20L,21L,30L,31L};
            Assert.Equal(expected,TeeTakeoffDependentClosure.RequireAdded(20,"bridge",30,"fitting",centers,new[]{31L,20L,30L,21L}));
            Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireAdded(20,"bridge",30,"fitting",centers,new[]{20L,21L,30L,31L,41L}));
            Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireAdded(20,"stale",30,"fitting",centers,expected));
            Assert.ThrowsAny<Exception>(()=>TeeTakeoffDependentClosure.RequireAdded(20,"bridge",20,"bridge",Rows(),new[]{20L}));
        }
    }
}

using System.Linq;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class OperatorScheduleFocusAssociationTests
    {
        private static OperatorScheduleFocusAssociation Row() => new OperatorScheduleFocusAssociation
        { scheduleId = 101, scheduleUniqueId = "schedule", instanceId = 102, instanceUniqueId = "placement", sheetId = 41, sheetUniqueId = "sheet" };
        [Fact] public void ExactSingleNativePlacementIsNavigationOnly()
        {
            var row = Row(); Assert.Same(row, OperatorScheduleFocusAssociation.Unique(41, 101, new[] { row }));
        }
        [Theory]
        [InlineData("foreign-sheet")][InlineData("foreign-definition")][InlineData("missing-uid")]
        [InlineData("invalid-id")][InlineData("definition-as-placement")][InlineData("duplicate")][InlineData("bounded")][InlineData("empty")]
        public void UnavailableAndAmbiguousPlacementsNeverResolve(string reason)
        {
            var row = Row(); var rows = new[] { row };
            if(reason=="foreign-sheet")row.sheetId=42;
            if(reason=="foreign-definition")row.scheduleId=103;
            if(reason=="missing-uid")row.instanceUniqueId="";
            if(reason=="invalid-id")row.instanceId=0;
            if(reason=="definition-as-placement")row.instanceId=101;
            if(reason=="duplicate")rows=new[]{row,Row()};
            if(reason=="bounded")rows=Enumerable.Range(0,201).Select(_=>Row()).ToArray();
            if(reason=="empty")rows=new OperatorScheduleFocusAssociation[0];
            Assert.Null(OperatorScheduleFocusAssociation.Unique(41,101,rows));
        }
    }
}

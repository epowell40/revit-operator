using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeApiSearchScoreTests
    {
        [Theory]
        [InlineData("blank")]
        [InlineData("zzzznonexistentmethodqxv")]
        [InlineData("___")]
        public void RetainedNonmatchingKeynoteMethodCannotPassQueryFilteringFromPriorityAlone(string query)
            => Assert.Equal(0, NativeApiSearchScore.Compute(query, "GetDefaultNameForKeynoteLegend",
                "Autodesk.Revit.DB.ViewSchedule", "string ViewSchedule.GetDefaultNameForKeynoteLegend(Document document)",
                "autodesk.revit.db.viewschedule getdefaultnameforkeynotelegend document", 86, true));

        [Theory]
        [InlineData(0, false)]
        [InlineData(100, false)]
        [InlineData(0, true)]
        [InlineData(100, true)]
        public void RankingHintsNeverCreateLexicalEligibility(int priority, bool callable)
            => Assert.Equal(0, NativeApiSearchScore.Compute("absent", "GetValue", "Example.Widget",
                "double Widget.GetValue()", "example.widget getvalue", priority, callable));

        [Fact]
        public void PositiveNameTypeSignatureAndParameterMatchesKeepTheirExistingRelativeScores()
        {
            Assert.Equal(170, NativeApiSearchScore.Compute("blank", "get_ShowBlankLine", "Autodesk.Revit.DB.ScheduleSortGroupField",
                "bool ScheduleSortGroupField.get_ShowBlankLine()", "autodesk.revit.db.schedulesortgroupfield get_showblankline", 86, true));
            Assert.Equal(100, NativeApiSearchScore.Compute("viewschedule", "GetValue", "Autodesk.Revit.DB.ViewSchedule",
                "bool GetValue()", "autodesk.revit.db.viewschedule getvalue", 86, true));
            Assert.Equal(90, NativeApiSearchScore.Compute("document", "Create", "Example.Widget",
                "Widget Create(Document doc)", "example.widget create document", 86, true));
            Assert.Equal(40, NativeApiSearchScore.Compute("xyz", "Move", "Example.Widget", "void Move(point)",
                "example.widget move autodesk.revit.db.xyz", 86, true));
        }

        [Fact]
        public void MatchedMembersCanUsePriorityAndCallableAsRankingHintsWithoutChangingEligibility()
        {
            var ordinary = NativeApiSearchScore.Compute("move", "Move", "Widget", "void Move()", "widget move", 0, false);
            Assert.True(ordinary > 0);
            Assert.Equal(ordinary + 32, NativeApiSearchScore.Compute("move", "Move", "Widget", "void Move()", "widget move", 86, true));
            Assert.Equal(ordinary, NativeApiSearchScore.Compute(" MOVE ", "Move", "Widget", "void Move()", "widget move", 0, false));
        }

        [Fact]
        public void ExistingPartialTokenSearchStillFindsRelevantMembers()
            => Assert.True(NativeApiSearchScore.Compute("keynote document", "GetDefaultNameForKeynoteLegend",
                "Autodesk.Revit.DB.ViewSchedule", "string ViewSchedule.GetDefaultNameForKeynoteLegend(Document document)",
                "autodesk.revit.db.viewschedule getdefaultnameforkeynotelegend document", 86, true) > 0);
    }
}

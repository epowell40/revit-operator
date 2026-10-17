using System;
using System.Collections.Generic;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class ScheduleRowHeightPolicyTests
    {
        [Theory]
        [InlineData("{\"rowHeights\":[{\"section\":\"Body\",\"rowNumber\":1,\"heightFeet\":0.0008333333333333334}]}", true)]
        [InlineData("{\"rowHeights\":[{\"rowNumber\":1,\"heightFeet\":0.1}]}", true)]
        [InlineData("{\"rowHeights\":[{\"section\":\" body \",\"rowNumber\":0,\"heightFeet\":0.1}]}", true)]
        [InlineData("{\"rowHeights\":[{\"section\":\"Header\",\"rowNumber\":1,\"heightFeet\":0.1}]}", false)]
        [InlineData("{\"rowHeights\":[{\"section\":\"Body\",\"heightFeet\":0.1}]}", false)]
        [InlineData("{\"rowHeights\":[{\"section\":\"Body\",\"rowNumber\":null,\"heightFeet\":0.1}]}", false)]
        public void StandardBodyCellRefusalPrecedesTransaction(string json, bool expected)
        { using var d = JsonDocument.Parse(json); Assert.Equal(expected, ScheduleRowHeightPolicy.HasUnsupportedExplicitBodyRow(d.RootElement)); }
        [Theory]
        [InlineData("[{\"status\":\"Applied\",\"heightFeet\":0.1,\"afterHeightFeet\":0.1}]", true)]
        [InlineData("[{\"status\":\"Failed\",\"reason\":\"This operation is forbidden for cells in standard schedule body sections.\",\"heightFeet\":0.0008333333333333334}]", false)]
        [InlineData("[{\"status\":\"Applied\",\"heightFeet\":0.1,\"afterHeightFeet\":0.2}]", false)]
        [InlineData("[{\"status\":\"Applied\",\"heightFeet\":0.1}]", false)]
        [InlineData("[{\"status\":\"Skipped\"}]", false)]
        [InlineData("[{\"status\":true}]", false)]
        [InlineData("[{\"status\":\"Applied\",\"heightFeet\":0,\"afterHeightFeet\":0}]", false)]
        [InlineData("[]", false)]
        [InlineData("[{\"status\":\"Applied\",\"heightFeet\":0.1,\"afterHeightFeet\":0.1},{\"status\":\"Failed\"}]", false)]
        public void FailedOrUnobservedRowsCannotReachSuccessfulCommit(string json, bool expected)
        { using var d = JsonDocument.Parse(json); if (expected) ScheduleRowHeightPolicy.RequireAppliedRows(d.RootElement); else Assert.Throws<InvalidOperationException>(() => ScheduleRowHeightPolicy.RequireAppliedRows(d.RootElement)); }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        [InlineData("Started", "unknown")]
        public void RejectedRowUsesObservedTransactionSettlementWithoutReplay(string rollbackStatus, string effect)
        {
            // Actual149 native row result: the former handler swallowed this failure and committed.
            using var rows = JsonDocument.Parse("[{\"section\":\"body\",\"rowNumber\":1,\"status\":\"Failed\",\"beforeHeightFeet\":0.013888888888888888,\"heightFeet\":0.0008333333333333334,\"reason\":\"This operation is forbidden for cells in standard schedule body sections.\"}]");
            int mutations = 0, commits = 0, rollbacks = 0;
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => { commits++; return "Committed"; },
                () => { rollbacks++; return rollbackStatus; }, () => "Started",
                () => { mutations++; ScheduleRowHeightPolicy.RequireAppliedRows(rows.RootElement); return new Dictionary<string, object?>(); },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 41L }));
            Assert.Equal(1, mutations); Assert.Equal(0, commits); Assert.Equal(1, rollbacks);
            Assert.Equal(false, result["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/configure-schedule").EffectState);
        }
    }
}

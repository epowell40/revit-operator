using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorNativeTransactionExecutionTests
    {
        [Theory]
        [InlineData("RolledBack", "none", true)]
        [InlineData("Pending", "unknown", false)]
        public void ExactThinRotatePreviewRequiresObservedRollbackAndRetainsOnlyTransientEvidence(string status, string effect, bool previewRetained)
        {
            // Exact native payload: thin-session-events.jsonl event 201077,
            // opv2_b67ffaaaac981ebac19ad7466343ab8658a373efbe0bca484939ade8926a33b0.
            var historical = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "reset-reference-rotate-preview-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "preview", "POST", "/revit/rotate-elements").EffectState);
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit"),
                () => status, () => status, () => historical, () => throw new Exception("must not create commit receipt"),
                disposition: NativeTransactionDisposition.Rollback);
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]);
            Assert.Empty(receipt.ModifiedElementIds);
            Assert.Empty(receipt.AddedElementIds);
            Assert.Equal(previewRetained, response.ContainsKey("snapshots"));
            Assert.Equal(previewRetained, response["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "preview", "POST", "/revit/rotate-elements").EffectState);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void ExactBaselineRotateResponseOnlySettlesFromObservedNativeStatus(string status, string effect)
        {
            // Retained inline native payload from reset-reference/baseline-session-events.jsonl,
            // event 200977 (the baseline stopped after this physically completed rotation).
            var historical = JsonSerializer.Deserialize<Dictionary<string, object?>>(
                File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "reset-reference-rotate-unsettled.json")))!;
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", "/revit/rotate-elements").EffectState);
            int edits = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => throw new Exception("must not retry settlement"), () => status,
                () => { edits++; return historical; }, () => OperatorNativeTransactionReceipt.Committed(new[] { 1542959L }));
            Assert.Equal(1, edits);
            using var wire = JsonDocument.Parse(JsonSerializer.Serialize(OperatorAttemptSuccessfulSettlement.Attach(
                response, "apply", "POST", "/revit/rotate-elements", assignmentId: "assignment", attemptId: "attempt", runId: "run", generation: 1)));
            var settlement = wire.RootElement.GetProperty("canonical_attempt_settlement");
            Assert.Equal(effect, settlement.GetProperty("effect_state").GetString());
            Assert.Equal("attempt", settlement.GetProperty("attempt_id").GetString());
            Assert.Equal(status == "Committed", response.ContainsKey("rotatedIds"));
        }

        [Theory]
        [InlineData("/revit/rotate-elements", "RolledBack", "none", true)]
        [InlineData("/revit/move-elements", "RolledBack", "none", true)]
        [InlineData("/revit/rotate-elements", "Pending", "unknown", false)]
        [InlineData("/revit/move-elements", "Pending", "unknown", false)]
        [InlineData("/revit/rotate-elements", "Committed", "applied", false)]
        public void IntentionalPreviewUsesActualRollbackAndNeverCommits(string route, string rollbackStatus, string effect, bool success)
        {
            int edits = 0, rollbackCalls = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("preview must not commit"),
                () => { rollbackCalls++; return rollbackStatus; }, () => rollbackStatus,
                () => { edits++; return new Dictionary<string, object?> { ["snapshots"] = new[] { new { rotationDegrees = 180 } } }; },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 42L }), disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, edits); Assert.Equal(1, rollbackCalls);
            Assert.Equal(success, response["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "preview", "POST", route).EffectState);
            Assert.Equal(rollbackStatus != "Pending", response.ContainsKey("snapshots"));
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Started", "unknown")]
        [InlineData("Pending", "unknown")]
        public void PreviewRollbackExceptionUsesObservedStatusWithoutRepeatingRollback(string observed, string effect)
        {
            int rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit"),
                () => { rollbacks++; throw new Exception("rollback response failed"); }, () => observed,
                () => new Dictionary<string, object?> { ["snapshots"] = new[] { 42 } },
                () => throw new Exception("must not declare commit"), disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, response["success"]);
            Assert.False(response.ContainsKey("snapshots"));
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "preview", "POST", "/revit/move-elements").EffectState);
        }

        [Fact]
        public void NativeIdentityEnumerationFailurePreservesCommitAndAlreadyCapturedChanges()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?>(), () => OperatorNativeTransactionReceipt.Committed(new[] { 41L }),
                nativeCreatedElements: () => throw new Exception("created identities unavailable"), nativeModifiedElements: () => new[] { 42L });
            Assert.Equal(false, response["success"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal(new[] { "element_id:41", "element_id:42" }, settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void PostCommitReadbackFailurePreservesBothCommitAndOriginalError()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("commit response failed"),
                () => throw new Exception("must not roll back"), () => "Committed", () => new Dictionary<string, object?>(),
                () => OperatorNativeTransactionReceipt.Committed(new[] { 42L }));
            OperatorNativeTransactionExecution.ReadCommitted(response, () => throw new Exception("location readback failed"));
            Assert.Contains("commit response failed", Assert.IsType<string>(response["error"]));
            Assert.Contains("location readback failed", Assert.IsType<string>(response["error"]));
            Assert.Equal(true, response["applied"]); Assert.Equal(false, response["verified"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/rotate-elements").EffectState);
        }

        [Fact]
        public void CommittedMutationSurvivesInventoryFailureWithoutRepeatingEdit()
        {
            int edits = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("must not roll back a committed edit"), () => "Committed",
                () => { edits++; return new Dictionary<string, object?>(); },
                () => throw new Exception("inventory unavailable"), nativeModifiedElements: () => new[] { 1542959L });
            Assert.Equal(1, edits);
            Assert.Equal(false, response["success"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/rotate-elements");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Contains("element_id:1542959", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void BestEffortFailureDoesNotBecomeTaskSuccessWhenTransactionCommits()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?> { ["success"] = false, ["movedIds"] = new[] { 42L },
                    ["skipped"] = new[] { new { id = 43L, reason = "Pinned" } } },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 42L }));
            Assert.Equal(false, response["success"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
            Assert.DoesNotContain("element_id:43", settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void FamilyPlacementReportsPersistedCreationOnlyAfterCommit(string status, string effect)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => "RolledBack", () => status,
                () => new Dictionary<string, object?> { ["status"] = "Placed", ["id"] = 1543001L },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                () => new[] { 1543001L });
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-family-instance");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(status == "Committed", settlement.AffectedTargetIdentities.Contains("element_id:1543001"));
            if (status != "Committed") Assert.False(result.ContainsKey("id"));
        }
        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        public void WrapperMatchedInventoryFlowsThroughTransactionSettlement(string status, string effect)
        {
            var document = new string(new[] { 'o', 'p', 'e', 'n' });
            var inventory = new OperatorNativeChangeInventory(document);
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () =>
                {
                    inventory.Observe(() => new string(document.ToCharArray()),
                        () => new long[] { 1542917 }, () => new long[] { 9946 }, () => new long[] { 70 });
                    return status;
                }, () => "RolledBack", () => status, () => new Dictionary<string, object?>(), inventory.CommittedReceipt);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/create-view");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(status == "Committed", settlement.AffectedTargetIdentities.Contains("element_id:9946"));
            Assert.Equal(status == "Committed", settlement.AffectedTargetIdentities.Contains("element_id:70"));
            Assert.Equal(1, inventory.DistinctWrapperMatchCount);
        }

        [Fact]
        public void HistoricalSheetDuplicateBooleanSuccessCannotEstablishCommit()
        {
            var historical = new { ok = true, dryRun = false, applied = true, verified = true,
                plan = new { sourceSheetId = 1420963, sourceSheetNumber = "M000", option = "views_and_detailing", newNumber = "TEMP-M000" },
                sheet = new { id = 1542977, number = "TEMP-M000", name = "COVER SHEET - WORKING COPY", viewportCount = 2, scheduleCount = 1 } };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "apply", "POST", "/revit/duplicate-sheet").EffectState);
        }

        [Theory]
        [InlineData("/revit/duplicate-sheet", "Committed", "applied", true)]
        [InlineData("/revit/duplicate-sheet", "RolledBack", "none", false)]
        [InlineData("/revit/duplicate-sheet", "Pending", "unknown", false)]
        [InlineData("/revit/create-drafting-view", "Committed", "applied", true)]
        [InlineData("/revit/create-drafting-view", "RolledBack", "none", false)]
        [InlineData("/revit/create-drafting-view", "Pending", "unknown", false)]
        [InlineData("/revit/create-sheet", "Committed", "applied", true)]
        [InlineData("/revit/create-sheet", "RolledBack", "none", false)]
        [InlineData("/revit/create-view", "Committed", "applied", true)]
        [InlineData("/revit/create-view", "Pending", "unknown", false)]
        public void SheetAndViewReadbackRunsOnlyAfterNativeCommit(string route, string status, string effect, bool verified)
        {
            int edits = 0, reads = 0;
            var created = new HashSet<long>();
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status, () => "RolledBack", () => status,
                () => { edits++; created.Add(1542977); created.Add(1542978); return new Dictionary<string, object?>(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()), () => created);
            OperatorNativeTransactionExecution.ReadCommitted(response, () => { reads++; return new Dictionary<string, object?>
                { ["sheet"] = new { id = 1542977, number = "TEMP-M000", viewportCount = 2, scheduleCount = 1 } }; });
            Assert.Equal(1, edits);
            Assert.Equal(verified ? 1 : 0, reads);
            Assert.Equal(verified, response["ok"]);
            Assert.Equal(verified, response["verified"]);
            Assert.Equal(verified, response.ContainsKey("sheet"));
            if (status == "Pending") Assert.Null(response["applied"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", route);
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(verified, settlement.AffectedTargetIdentities.Contains("element_id:1542977"));
            Assert.DoesNotContain("element_id:1420963", settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void CommittedSheetReadbackFailurePreservesEffectWithoutRepeatingEdit(bool commitThrows)
        {
            int edits = 0, reads = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => commitThrows ? throw new InvalidOperationException("Commit response failed") : "Committed",
                () => throw new InvalidOperationException("Committed work must not be rolled back"), () => "Committed",
                () => { edits++; return new Dictionary<string, object?>(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542977L }, Array.Empty<long>(), Array.Empty<long>()));
            var receipt = response["transaction"];
            OperatorNativeTransactionExecution.ReadCommitted(response, () => { reads++; throw new InvalidOperationException("Sheet readback unavailable"); });
            Assert.Equal(1, edits); Assert.Equal(1, reads);
            Assert.Same(receipt, response["transaction"]);
            Assert.Equal(true, response["applied"]);
            Assert.Equal(false, response["ok"]); Assert.Equal(false, response["verified"]); Assert.Equal(false, response["success"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-sheet").EffectState);
        }

        [Fact]
        public void ConvertedPlaceholderAndRenamedViewKeepModifiedIdentitySeparateFromCreated()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?>(),
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                () => new[] { 1542978L }, () => new[] { 1420963L });
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(response["transaction"]);
            Assert.Equal(new[] { 1420963L }, receipt.ModifiedElementIds);
            Assert.Equal(new[] { 1542978L }, receipt.AddedElementIds);
            Assert.DoesNotContain(1420963L, receipt.AddedElementIds);
        }

        [Fact]
        public void ReadbackCannotMintOrOverwriteNativeTransactionAuthority()
        {
            Assert.Throws<InvalidOperationException>(() => OperatorNativeTransactionExecution.ReadCommitted(
                new Dictionary<string, object?> { ["applied"] = true }, () => new Dictionary<string, object?>()));
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?>(), () => OperatorNativeTransactionReceipt.Committed(Array.Empty<long>()));
            var receipt = response["transaction"];
            OperatorNativeTransactionExecution.ReadCommitted(response, () => new Dictionary<string, object?> { ["transaction"] = OperatorNativeTransactionReceipt.NotStarted() });
            Assert.Same(receipt, response["transaction"]); Assert.Equal(false, response["verified"]);
            Assert.Equal(true, response["applied"]); Assert.Equal(false, response["success"]);
        }

        private static Dictionary<string, object?> CopyResult() => new Dictionary<string, object?>
        { ["viewId"] = 1542917L, ["name"] = "M-COORDINATION COPY", ["sourceViewId"] = 1363433L, ["withDetailing"] = true };

        [Theory]
        [InlineData("RolledBack", false, "none")]
        [InlineData("Pending", false, "unknown")]
        [InlineData("RolledBack", true, "unknown")]
        public void VisibilityCategoryRejectionSettlesOnlyFromNativeRollback(string rollbackStatus, bool rollbackThrows, string effect)
        {
            int mutations = 0, rollbacks = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("A rejected category must not commit."),
                () => { rollbacks++; if (rollbackThrows) throw new Exception("rollback failed"); return rollbackStatus; },
                () => "Started",
                () => { mutations++; throw new InvalidOperationException("Category 'Rooms' cannot be hidden in view 'L4'."); },
                () => throw new Exception("A rejection must not publish a committed receipt."));
            Assert.Equal(1, mutations);
            Assert.Equal(1, rollbacks);
            Assert.Equal(false, response["success"]);
            Assert.StartsWith("Category 'Rooms' cannot be hidden in view 'L4'.", Assert.IsType<string>(response["error"]));
            Assert.False(response.ContainsKey("view"));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("Committed", false, "applied", true)]
        [InlineData("Committed", true, "applied", false)]
        [InlineData("RolledBack", false, "none", false)]
        [InlineData("Pending", false, "unknown", false)]
        public void VisibilityReadbackRequiresCommitAndNeverPromotesRequestedIdentity(string commitStatus, bool commitThrows, string effect, bool success)
        {
            int mutations = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => commitThrows ? throw new Exception("commit response failed") : commitStatus,
                () => throw new Exception("Must not roll back an already settled commit."), () => commitStatus,
                () => { mutations++; return new Dictionary<string, object?> {
                    ["status"] = "Success", ["view"] = new { id = 1363433L, scale = 96 } }; },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                nativeModifiedElements: () => new[] { 1363433L });
            Assert.Equal(1, mutations);
            Assert.Equal(success, response["success"]);
            Assert.Equal(commitStatus == "Committed", response.ContainsKey("view"));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(commitStatus == "Committed", settlement.AffectedTargetIdentities.Contains("element_id:1363433"));
        }

        [Fact]
        public void UnchangedNativeViewReadbackDoesNotMintModifiedIdentity()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack",
                () => "Committed", () => new Dictionary<string, object?> { ["view"] = new { id = 1363433L, scale = 96 } },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                nativeModifiedElements: () => Array.Empty<long>());
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void HistoricalVisibilityExceptionOrSuccessWithoutReceiptRemainsUnknown()
        {
            foreach (var response in new object[] {
                new { status = "Success", view = new { id = 1363433L } },
                new { success = false, error = "Category 'Rooms' cannot be hidden in view 'L4'." } })
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/visibility").EffectState);
        }

        [Theory]
        [InlineData("Committed", "applied", true)]
        [InlineData("RolledBack", "none", false)]
        [InlineData("Pending", "unknown", false)]
        public void NativeCommitStatusSurvivesHandlerToSettlementBoundary(string status, string effect, bool success)
        {
            int edits = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => throw new Exception("unexpected rollback"), () => status,
                () => { edits++; return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542917L, 1542918L }, new[] { 1363433L }, Array.Empty<long>()));
            Assert.Equal(1, edits);
            Assert.Equal(success, response["success"]);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view");
            Assert.Equal(effect, settlement.EffectState);
            if (success)
            {
                Assert.Contains("element_id:1542917", settlement.AffectedTargetIdentities);
                Assert.Contains("element_id:1542918", settlement.AffectedTargetIdentities);
                using var wire = JsonDocument.Parse(JsonSerializer.Serialize(response));
                Assert.Equal(2, wire.RootElement.GetProperty("transaction").GetProperty("added_element_ids").GetArrayLength());
            }
        }

        [Theory]
        [InlineData("Started", "RolledBack", "none", 1)]
        [InlineData("Started", "Pending", "unknown", 1)]
        [InlineData("Committed", "RolledBack", "applied", 0)]
        [InlineData("Pending", "RolledBack", "unknown", 0)]
        public void CommitExceptionUsesNativeStatusWithoutReplay(string currentStatus, string rollbackStatus, string effect, int rollbacks)
        {
            int edits = 0, rollbackCalls = 0;
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("commit response failed"),
                () => { rollbackCalls++; return rollbackStatus; }, () => currentStatus,
                () => { edits++; return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 1542917L }, Array.Empty<long>(), Array.Empty<long>()));
            Assert.Equal(1, edits);
            Assert.Equal(rollbacks, rollbackCalls);
            Assert.Equal(false, response["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view").EffectState);
        }

        [Fact]
        public void NameFailureRollsBackAndRollbackFailureCannotClaimNoEffect()
        {
            foreach (var failRollback in new[] { false, true })
            {
                var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit"),
                    () => failRollback ? throw new Exception("rollback failed") : "RolledBack", () => "Started",
                    () => throw new Exception("name already exists"),
                    () => throw new Exception("must not produce commit receipt"));
                Assert.StartsWith("name already exists", Assert.IsType<string>(response["error"]));
                Assert.Equal(failRollback ? "unknown" : "none",
                    OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view").EffectState);
            }
        }

        [Fact]
        public void HistoricalDuplicateSuccessWithoutReceiptStaysUnknown()
        {
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                new { status = "Success", viewId = 1543005L, name = "OPERATOR HANDOFF CHECK", created = true },
                "apply", "POST", "/revit/create-drafting-view").EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                new { success = true, viewId = 1542917L, name = "M-COORDINATION COPY" },
                "apply", "POST", "/revit/duplicate-view").EffectState);
        }

        [Theory]
        [InlineData("Committed", "applied", true)]
        [InlineData("RolledBack", "none", false)]
        [InlineData("Pending", "unknown", false)]
        public void NativeCreatedIdentitySurvivesWithoutDocumentChangedEvidence(string status, string effect, bool retained)
        {
            var createdByNativeApi = new HashSet<long>();
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => "RolledBack", () => status,
                () => { createdByNativeApi.Add(1542917); createdByNativeApi.Add(1542918); return CopyResult(); },
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), Array.Empty<long>()),
                () => createdByNativeApi);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/duplicate-view");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(retained, settlement.AffectedTargetIdentities.Contains("element_id:1542917"));
            Assert.Equal(retained, settlement.AffectedTargetIdentities.Contains("element_id:1542918"));
            Assert.DoesNotContain("element_id:1363433", settlement.AffectedTargetIdentities);
        }
    }
}

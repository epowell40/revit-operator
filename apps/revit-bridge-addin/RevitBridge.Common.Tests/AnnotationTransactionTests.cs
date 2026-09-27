using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class AnnotationTransactionTests
    {
        [Fact]
        public void TextNoteMoveReadsFiniteNativeAnchorBeforeGenericLocationAndPersistedReadback()
        {
            string? source = Environment.GetEnvironmentVariable("MOVE_ELEMENTS_BEFORE_SOURCE");
            source = string.IsNullOrEmpty(source) ? null : File.ReadAllText(source);
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/MoveElementsHandler.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            var snapshot = source!.Substring(source.IndexOf("private static object SnapshotLocation", StringComparison.Ordinal));
            var textStart = snapshot.IndexOf("e is TextNote textNote", StringComparison.Ordinal);
            Assert.True(textStart >= 0, "Text notes with no generic location or model bounding box need their native Coord.");
            var genericStart = snapshot.IndexOf("e.Location is LocationPoint", StringComparison.Ordinal);
            Assert.True(textStart < genericStart);
            var textBranch = snapshot.Substring(textStart, genericStart - textStart);
            Assert.Contains("textNote.Coord", textBranch);
            Assert.Contains("kind = \"TextAnchor\"", textBranch);
            Assert.Contains("pointXyz = coordinates", textBranch);
            Assert.Contains("coordinates.All(value => !double.IsNaN(value) && !double.IsInfinity(value))", textBranch);
            Assert.Contains("if (requireKnown) throw", textBranch);
            Assert.Contains("return new { kind = \"Unknown\" }", textBranch);
            Assert.DoesNotContain("get_BoundingBox", textBranch);
            Assert.Contains("beforeById[id] = SnapshotLocation(e)", source);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted(response", source);
            Assert.Contains("SnapshotLocation(element, requireKnown: true)", source);
            Assert.Contains("response.Remove(\"snapshots\")", source);
        }

        [Fact]
        public void CommittedTextMoveRetainsTypedAnchorReadbackWithoutPromotingItToLocationPoint()
        {
            var before = new { kind = "TextAnchor", pointXyz = new[] { 2d, 3d, 0d } };
            var after = new { kind = "TextAnchor", pointXyz = new[] { 2d, 1d, 0d } };
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("committed move must not roll back"), () => "Committed",
                () => new Dictionary<string, object?> { ["movedIds"] = new[] { 41L } },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 41L }));
            OperatorNativeTransactionExecution.ReadCommitted(response, () => new Dictionary<string, object?>
                { ["snapshots"] = new[] { new { id = 41L, before, after } } });
            using var wire = JsonDocument.Parse(JsonSerializer.Serialize(response));
            var snapshot = wire.RootElement.GetProperty("snapshots")[0];
            Assert.Equal("TextAnchor", snapshot.GetProperty("before").GetProperty("kind").GetString());
            Assert.Equal("TextAnchor", snapshot.GetProperty("after").GetProperty("kind").GetString());
            Assert.Equal(1d, snapshot.GetProperty("after").GetProperty("pointXyz")[1].GetDouble());
            Assert.Equal(true, response["verified"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements").EffectState);
        }

        [Fact]
        public void UnavailableTextAnchorReadbackPreservesCommitWithoutReturningTransientSnapshots()
        {
            var response = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("committed move must not roll back"), () => "Committed",
                () => new Dictionary<string, object?> { ["movedIds"] = new[] { 41L }, ["snapshots"] = new[] { new { kind = "Unknown" } } },
                () => OperatorNativeTransactionReceipt.Committed(new[] { 41L }));
            response.Remove("snapshots");
            OperatorNativeTransactionExecution.ReadCommitted(response, () => throw new InvalidOperationException("Native text-note coordinate readback is unavailable."));
            Assert.Equal(false, response["success"]);
            Assert.Equal(false, response["verified"]);
            Assert.False(response.ContainsKey("snapshots"));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/move-elements");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Contains("element_id:41", settlement.AffectedTargetIdentities);
        }

        private static Dictionary<string, object?> HistoricalTagPreview()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "unit407-tag-elements-preview-unsettled.json")));
            return JsonSerializer.Deserialize<Dictionary<string, object?>>(fixture.RootElement.GetProperty("raw_result").GetRawText())!;
        }

        [Fact]
        public void ExactTenDuctTagPlanNeedsNativeNotStartedProofAndNeverClaimsExecutedPreview()
        {
            var historical = HistoricalTagPreview();
            Assert.Equal(10, ((JsonElement)historical["plannedToTag"]!).GetInt32());
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(historical, "preview", "POST", "/revit/tag-elements").EffectState);
            var result = TagNativeStages.CompleteNativeStages(historical, Array.Empty<Dictionary<string, object?>>());
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal("not_started", receipt.Status); Assert.False(receipt.CommittedValue); Assert.Empty(receipt.AffectedElementIds);
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/tag-elements");
            Assert.Equal("none", settlement.EffectState); Assert.Equal("native_transaction", settlement.EffectAuthority);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void TagRepairTrialUsesObservedRollbackAndDropsTransientIdsWhenUnsettled(string nativeStatus, string effect)
        {
            var stage = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("preview cannot commit"),
                () => nativeStatus, () => nativeStatus, () => new Dictionary<string, object?> { ["previewExecuted"] = true, ["after"] = new { x = 4 } },
                () => throw new Exception("no preview commit inventory"), disposition: NativeTransactionDisposition.Rollback);
            var result = TagNativeStages.CompleteNativeStages(stage, new[] { stage });
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/tag-elements").EffectState);
            Assert.Empty(Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]).AffectedElementIds);
            Assert.Equal(nativeStatus == "RolledBack", result.ContainsKey("after"));
        }

        [Theory]
        [InlineData("RolledBack", "applied", "CommittedWithErrors")]
        [InlineData("Pending", "unknown", "UnknownEffect")]
        public void FamilyImportCommitSurvivesLaterTagFailureWithoutInventingAWholeRequestRollback(string lastStatus, string effect, string status)
        {
            var family = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?>(), () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 201L, 202L }, new[] { 203L }, Array.Empty<long>()));
            var tags = OperatorNativeTransactionExecution.Execute(() => "Started", () => throw new Exception("must not commit failed tags"),
                () => lastStatus, () => "Started", () => throw new Exception("tag visibility or creation failed"), () => throw new Exception("no tag commit"));
            var result = TagNativeStages.CompleteNativeStages(new { status = "Failed", success = false }, new[] { family, tags });
            Assert.Equal(status, result["status"]); Assert.Equal(false, result["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/tag-elements").EffectState);
            Assert.Contains(201L, Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]).AffectedElementIds);
        }

        [Fact]
        public void PartialTagCommitIncludesFamilyVisibilityActivationAndUnreportedCreatedTagThroughReadbackFailure()
        {
            var stage = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed",
                () => new Dictionary<string, object?> { ["tagIds"] = new[] { 301L }, ["errorCount"] = 1, ["success"] = false },
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 301L, 302L }, new[] { 401L, 402L }, new[] { 501L, 502L }));
            OperatorNativeTransactionExecution.ReadCommitted(stage, () => throw new Exception("post-commit readback failed"));
            var result = TagNativeStages.CompleteNativeStages(stage, new[] { stage });
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(new[] { 301L, 302L }, receipt.AddedElementIds);
            Assert.Equal(new[] { 401L, 402L }, receipt.ModifiedElementIds);
            Assert.Equal(new[] { 501L, 502L }, receipt.DeletedElementIds);
            Assert.Equal("CommittedWithErrors", result["status"]);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/tag-elements").EffectState);
        }

        [Theory]
        [InlineData("Pending")]
        [InlineData("committed")]
        [InlineData("rolled_back")]
        [InlineData("not_started")]
        public void UnsettledOrUnprovedFamilyStageCannotStartTagWrites(string status)
        {
            var stage = new Dictionary<string, object?> { ["success"] = false, ["transaction"] = OperatorNativeTransactionReceipt.Unknown(status) };
            Assert.Throws<InvalidOperationException>(() => TagNativeStages.RequireSettledPrefix(new[] { stage }));
            var result = TagNativeStages.CompleteNativeStages(new { status = "Failed", success = false }, new[] { stage });
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/tag-elements").EffectState);
        }

        [Fact]
        public void FamilyCleanupRemovesDependentTransientTagFromCommittedFallbackInventory()
        {
            var created = new HashSet<long>();
            var stage = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed", () => "RolledBack", () => "Committed", () =>
            {
                created.Add(302L); // Native tag creation succeeded before geometry readback failed.
                foreach (var deleted in new[] { 201L, 202L, 302L }) created.Remove(deleted);
                return new Dictionary<string, object?> { ["tagIds"] = Array.Empty<long>(), ["success"] = false };
            }, () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), Array.Empty<long>(), new[] { 201L, 202L }),
                () => created);
            var result = TagNativeStages.CompleteNativeStages(stage, new[] { stage });
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Empty(receipt.AddedElementIds);
            Assert.DoesNotContain(302L, receipt.AffectedElementIds);
            Assert.Equal(new[] { 201L, 202L }, receipt.DeletedElementIds);
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/tag-elements").EffectState);
        }

        [Fact]
        public void TagPlanningAndAllTargetDocumentWritesUseObservedNativeStageReceipts()
        {
            string? source = Environment.GetEnvironmentVariable("TAG_ELEMENTS_BEFORE_SOURCE");
            source = string.IsNullOrEmpty(source) ? null : File.ReadAllText(source);
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge.Logic/Handlers/TagElementsHandler.cs");
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            Assert.Contains("NativeMutationPreflightBoundary.Execute", source!);
            Assert.Contains("NativeSingleTransaction.Execute", source!);
            Assert.Contains("previewExecuted = false", source!);
            Assert.Contains("CompleteNativeStages", source!);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted", source!);
            Assert.Contains("NativeTransactionDisposition.Rollback", source!);
            Assert.DoesNotContain("new Transaction(doc,", source!);
            Assert.DoesNotContain("new Transaction(targetDoc,", source!);
            Assert.Contains("nativeCreated.Add(ElementIdCompat.GetValue(tag.Id))", source!);
            Assert.Contains("TagNativeStages.RequireSettledPrefix(stages);", source!);
            Assert.Contains("foreach (var deleted in doc.Delete(tagFamilyResolution.FamilyId ?? tagFamilyResolution.TypeId!))", source!);
        }

        private static Dictionary<string, object?> Historical()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory,
                "Fixtures", "scope-information-detail-curves-unsettled.json")));
            return JsonSerializer.Deserialize<Dictionary<string, object?>>(fixture.RootElement.GetProperty("raw_result").GetRawText())!;
        }

        [Fact]
        public void ExactSevenCurveSuccessWithoutTransactionRemainsUnknown()
        {
            var result = Historical();
            Assert.Equal(7, ((JsonElement)result["createdCount"]!).GetInt32());
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/draw-detail-curves");
            Assert.Equal("unknown", settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("Committed", "applied")]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void ExactCurvePayloadNeedsActualNativeSettlement(string status, string effect)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => status,
                () => throw new Exception("do not infer or retry rollback"), () => status, Historical,
                () => OperatorNativeTransactionReceipt.CommittedChanges(Array.Empty<long>(), new[] { 1363433L }, Array.Empty<long>()),
                nativeCreatedElements: () => Enumerable.Range(1543049, 7).Select(id => (long)id));
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/draw-detail-curves");
            Assert.Equal(effect, settlement.EffectState);
            if (status == "Committed")
            {
                Assert.Equal(8, settlement.AffectedTargetIdentities.Count);
                Assert.Contains("element_id:1543049", settlement.AffectedTargetIdentities);
                Assert.Contains("element_id:1363433", settlement.AffectedTargetIdentities);
            }
            else Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Theory]
        [InlineData("RolledBack", "none", true)]
        [InlineData("Pending", "unknown", false)]
        public void ExecutedDetailPreviewRetainsPredictionOnlyAfterObservedRollback(string status, string effect, bool retains)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("preview must not commit"), () => status, () => status,
                () => new Dictionary<string, object?> { ["createdCount"] = 7, ["previewExecuted"] = true },
                () => throw new Exception("preview has no committed inventory"),
                nativeCreatedElements: () => throw new Exception("transient IDs cannot become applied IDs"),
                disposition: NativeTransactionDisposition.Rollback);
            Assert.Equal(retains, result.ContainsKey("createdCount"));
            Assert.Empty(Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]).AffectedElementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/draw-detail-curves").EffectState);
        }

        [Theory]
        [InlineData("create")]
        [InlineData("repair")]
        [InlineData("create_type")]
        public void TextPlanningDoesNotClaimAnExecutedPreview(string action)
        {
            var result = new { status = "Dry Run", action, dryRun = true, previewExecuted = false,
                applied = false, transaction = OperatorNativeTransactionReceipt.NotStarted() };
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "preview", "POST", "/revit/create-text");
            Assert.Equal("none", settlement.EffectState);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void CreatedTypeAndNotePlusModifiedExistingTypeRemainSeparateNativeFacts()
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started", () => "Committed",
                () => throw new Exception("must not roll back a commit"), () => "Committed",
                () => new Dictionary<string, object?>(),
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 101L }, new[] { 104L }, Array.Empty<long>()),
                nativeCreatedElements: () => new[] { 101L, 102L }, nativeModifiedElements: () => new[] { 103L });
            OperatorNativeTransactionExecution.ReadCommitted(result, () => throw new Exception("note readback unavailable after commit"));
            var receipt = Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]);
            Assert.Equal(new[] { 101L, 102L }, receipt.AddedElementIds);
            Assert.Equal(new[] { 103L, 104L }, receipt.ModifiedElementIds);
            Assert.Equal(false, result["success"]);
            Assert.Equal("CommittedWithErrors", OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"));
            Assert.Equal("applied", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-text").EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void FailedPartialAnnotationBatchCannotPublishCreatedIds(string rollbackStatus, string effect)
        {
            var result = OperatorNativeTransactionExecution.Execute(() => "Started",
                () => throw new Exception("failed geometry must not commit"), () => rollbackStatus, () => "Started",
                () => throw new Exception("second annotation failed after first was created"),
                () => throw new Exception("no committed inventory"), nativeCreatedElements: () => new[] { 101L });
            Assert.Empty(Assert.IsType<OperatorNativeTransactionReceipt>(result["transaction"]).AffectedElementIds);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/draw-detail-curves").EffectState);
        }

        [Fact]
        public void ValidationFailureBeforeNativeEntryIsNotAnUnknownWrite()
        {
            var result = NativeMutationPreflightBoundary.Execute(_ => throw new InvalidOperationException("View not found."));
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-text").EffectState);
        }

        // This wiring regression complements executable runner/classifier cases;
        // it cannot qualify Revit geometry or replace a real handler replay.
        [Theory]
        [InlineData("RevitBridge.Logic/Handlers/Drafting/DrawDetailCurvesHandler.cs")]
        [InlineData("RevitBridge.Logic/Handlers/CreateTextNoteHandler.cs")]
        [InlineData("RevitBridge/Handlers/CreateTextNoteHandler.cs")]
        public void EveryAnnotationWriteUsesSharedNativeSettlement(string relative)
        {
            string? source = null;
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null && source == null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, relative);
                    if (File.Exists(file)) { source = File.ReadAllText(file); break; }
                }
            Assert.NotNull(source);
            Assert.Contains("NativeMutationPreflightBoundary.Execute", source!);
            Assert.Contains("NativeSingleTransaction.Execute", source!);
            Assert.Contains("enterNativeScope();", source!);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted", source!);
            Assert.DoesNotContain("new Transaction(", source!);
            if (relative == "RevitBridge.Logic/Handlers/CreateTextNoteHandler.cs")
            {
                Assert.Contains("public bool dryRun { get; set; }", source!);
                Assert.Contains("if (p.dryRun)", source!);
                Assert.Contains("previewExecuted = false", source!);
                Assert.Contains("OperatorNativeTransactionReceipt.NotStarted()", source!);
            }
        }
    }
}

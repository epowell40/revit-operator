using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.IO;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorAttemptSettlementTests
    {
        [Fact]
        public void C138BlockedInteriorTeeWithOuterAndChildRollbackIsKnownNoEffect()
        {
            const string path = "/revit/existing-conditions-mep-draft-workflow";
            var raw = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "c138-registered-branch-blocked-rollback.json"));
            var exact = JsonNode.Parse(raw)!;
            var result = OperatorAttemptSuccessfulSettlement.Classify(exact, "preview", "POST", path);
            Assert.Equal("none", result.EffectState);
            Assert.Equal("verified_native_rollback", result.EffectReason);
            Assert.Empty(result.AffectedTargetIdentities);

            void Reject(Action<JsonNode> change)
            {
                var changed = JsonNode.Parse(raw)!;
                change(changed);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "preview", "POST", path).EffectState);
            }
            Reject(x => x["rollbackVerified"] = false);
            Reject(x => x["transactionGroupRolledBack"] = false);
            Reject(x => x["residualCreatedElementIds"] = new JsonArray(1543424));
            Reject(x => x["failedOperation"]!["response"]!["rolledBack"] = false);
            Reject(x => x["failedOperation"]!["response"]!["createdBranchElementIds"] = new JsonArray(1543426));
            Reject(x => x["failedOperation"]!["path"] = "/revit/create-mep-route");
            Reject(x => x["failedOperation"]!["response"]!["error"] = "different failure");
            Reject(x => x["operations"] = new JsonArray(JsonValue.Create("unexpected")));
        }

        [Fact]
        public void C114RegisteredRoutePreflightNotStartedIsKnownNoEffect()
        {
            const string path = "/revit/existing-conditions-mep-draft-workflow";
            var raw = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "c114-registered-stage-preflight-not-started.json"));
            var exact = JsonNode.Parse(raw)!;
            var result = OperatorAttemptSuccessfulSettlement.Classify(exact, "preview", "POST", path);
            Assert.Equal("none", result.EffectState);
            Assert.Equal("native_transaction_not_started", result.EffectReason);
            Assert.Equal("native_transaction", result.EffectAuthority);
            Assert.True(result.RequestDispatched);

            void Reject(Action<JsonNode> change)
            {
                var changed = JsonNode.Parse(raw)!;
                change(changed);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "preview", "POST", path).EffectState);
            }
            Reject(x => x["rollbackVerified"] = false);
            Reject(x => x["residualCreatedElementIds"] = new JsonArray(1543240));
            Reject(x => x["failedOperation"]!["response"]!["transaction"]!["status"] = "committed");
            Reject(x => x["failedOperation"]!["response"]!["transaction"]!["affected_element_ids"] = new JsonArray(1543240));
            Reject(x => x["failedOperation"]!["response"]!["error"] = "different failure");
        }

        [Fact]
        public void C109BlockedStageWithVerifiedRollbackHasNoPersistentEffect()
        {
            const string path = "/revit/existing-conditions-mep-draft-workflow";
            var raw = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", "c109-registered-stage-blocked-rollback.json"));
            var exact = JsonNode.Parse(raw)!;
            var result = OperatorAttemptSuccessfulSettlement.Classify(exact, "preview", "POST", path);
            Assert.Equal("none", result.EffectState);
            Assert.Equal("verified_native_rollback", result.EffectReason);
            Assert.True(result.RequestDispatched);
            Assert.Empty(result.AffectedTargetIdentities);

            void Reject(Action<JsonNode> change)
            {
                var changed = JsonNode.Parse(raw)!;
                change(changed);
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(changed, "preview", "POST", path).EffectState);
            }
            Reject(x => x["rollbackVerified"] = false);
            Reject(x => x["transactionGroupRolledBack"] = false);
            Reject(x => x["residualCreatedElementIds"] = new JsonArray(1543184));
            Reject(x => x["createdElementIds"] = new JsonArray(1543184));
            Reject(x => x["failedOperation"]!["response"]!["transaction"]!["status"] = "committed");
            Reject(x => x["failedOperation"]!["response"]!["transaction"]!["committed"] = true);
            Reject(x => x["failedOperation"]!["response"]!["error"] = "different failure");
            Reject(x => x["failedOperation"]!["response"]!["dryRun"] = true);
            Reject(x => x["failedOperation"]!["actionKey"] = "unrelated-route");
            Reject(x => x["failedOperation"]!["path"] = "/revit/unrelated");
        }

        [Fact]
        public void ExistingConditionsStageRollbackAndCommitRequireMatchingNativeReceipt()
        {
            const string path = "/revit/existing-conditions-mep-draft-workflow";
            var preview = new
            {
                schema = "operator.existing_conditions_mep_draft_workflow.v1",
                status = "DryRunReady", dryRun = true, transactionGroupRolledBack = true,
                rollbackVerified = true, atomic = true, error = (string?)null,
                residualCreatedElementIds = Array.Empty<long>(), createdElementIds = Array.Empty<long>(),
                transientCreatedElementIds = new[] { 101L, 102L }, operationCount = 1
            };
            var applied = new
            {
                schema = "operator.existing_conditions_mep_draft_workflow.v1",
                status = "Applied", dryRun = false, transactionGroupRolledBack = false,
                rollbackVerified = true, atomic = true, error = (string?)null,
                residualCreatedElementIds = Array.Empty<long>(), createdElementIds = new[] { 101L, 102L },
                transientCreatedElementIds = Array.Empty<long>(), operationCount = 1
            };
            var previewSettlement = OperatorAttemptSuccessfulSettlement.Classify(preview, "preview", "POST", path);
            var applySettlement = OperatorAttemptSuccessfulSettlement.Classify(applied, "apply", "POST", path);
            Assert.Equal("none", previewSettlement.EffectState);
            Assert.Equal("verified_native_rollback", previewSettlement.EffectReason);
            Assert.Equal("applied", applySettlement.EffectState);
            Assert.Equal("native_transaction_committed", applySettlement.EffectReason);
            Assert.Contains("element_id:101", applySettlement.AffectedTargetIdentities);
            foreach (var invalid in new object[]
            {
                new { preview.schema, preview.status, preview.dryRun, preview.transactionGroupRolledBack,
                    rollbackVerified = false, preview.atomic, preview.error, preview.residualCreatedElementIds,
                    preview.createdElementIds, preview.transientCreatedElementIds, preview.operationCount },
                new { preview.schema, preview.status, preview.dryRun, preview.transactionGroupRolledBack,
                    preview.rollbackVerified, preview.atomic, preview.error,
                    residualCreatedElementIds = new[] { 101L }, preview.createdElementIds,
                    preview.transientCreatedElementIds, preview.operationCount },
                new { applied.schema, applied.status, applied.dryRun, applied.transactionGroupRolledBack,
                    applied.rollbackVerified, applied.atomic, applied.error, applied.residualCreatedElementIds,
                    createdElementIds = Array.Empty<long>(), applied.transientCreatedElementIds, applied.operationCount }
            }) Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(invalid, "preview", "POST", path).EffectState);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(preview, "preview", "POST", "/revit/unrelated").EffectState);
        }

        [Fact]
        public void ScheduleCellNoMatchAndDryRunCarryDistinctNoEffectTransactionReceipts()
        {
            var noMatch = new { status = "Not Found", applied = false,
                transaction = OperatorNativeTransactionReceipt.NotStarted() };
            var preview = new { status = "Dry Run", dryRun = true, applied = false,
                transaction = OperatorNativeTransactionReceipt.RolledBack(System.Array.Empty<long>()) };
            var noMatchSettlement = OperatorAttemptSuccessfulSettlement.Classify(noMatch, "preview", "POST", "/revit/update-schedule-cell");
            var previewSettlement = OperatorAttemptSuccessfulSettlement.Classify(preview, "preview", "POST", "/revit/update-schedule-cell");
            Assert.Equal("none", noMatchSettlement.EffectState);
            Assert.Equal("native_transaction_not_started", noMatchSettlement.EffectReason);
            Assert.Equal("none", previewSettlement.EffectState);
            Assert.Equal("verified_native_rollback", previewSettlement.EffectReason);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                new { noMatch.status, noMatch.applied }, "preview", "POST", "/revit/update-schedule-cell").EffectState);
        }
        [Fact]
        public void ConfigureSchedulePlanAndCommitHaveDistinctNativeEffectAuthority()
        {
            var plan = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Dry Run", dryRun = true,
                transaction = OperatorNativeTransactionReceipt.NotStarted()
            }, "preview", "POST", "/revit/configure-schedule");
            var committed = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Success", dryRun = false,
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 1488968L })
            }, "apply", "POST", "/revit/configure-schedule");
            Assert.Equal("none", plan.EffectState);
            Assert.Equal("native_transaction_not_started", plan.EffectReason);
            Assert.Equal("applied", committed.EffectState);
            Assert.Equal("native_transaction", committed.EffectAuthority);
            Assert.Contains("element_id:1488968", committed.AffectedTargetIdentities);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new { status = "Success", dryRun = false },
                "apply", "POST", "/revit/configure-schedule").EffectState);
        }
        [Fact]
        public void ExistingTagRepairNeedsNativeTransactionTruthForApplyAndRollback()
        {
            var legacy = new { status = "Repaired", dryRun = false, changed = true,
                before = new { tagId = 1492043L }, after = new { tagId = 1492043L } };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(
                legacy, "apply", "POST", "/revit/tag-elements").EffectState);

            var applied = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                legacy.status, legacy.dryRun, legacy.changed, legacy.before, legacy.after,
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 1492043L })
            }, "apply", "POST", "/revit/tag-elements");
            Assert.Equal("applied", applied.EffectState);
            Assert.Contains("element_id:1492043", applied.AffectedTargetIdentities);

            var preview = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Dry Run", dryRun = true, changed = true,
                transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 1492043L })
            }, "preview", "POST", "/revit/tag-elements");
            Assert.Equal("none", preview.EffectState);
            Assert.Equal("native_rollback", preview.EffectAuthority);
        }
        [Fact]
        public void MissingCreateSimilarHostPreservesNoWriteAtNativeSettlementBoundary()
        {
            var result = HostedPlacementPreflight.CheckHost(false, "OneLevelBased", 1464223, null)!;
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-similar-from-instance");
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("native_transaction", settlement.EffectAuthority);
            result.Remove("transaction");
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/create-similar-from-instance").EffectState);
        }
        [Theory]
        [InlineData(true, "none", "native_rollback")]
        [InlineData(false, "unknown", "native_host")]
        public void AtomicNetworkOuterRollbackOverridesCommittedChild(bool confirmed, string effect, string authority)
        {
            var workflow = new {
                status = confirmed ? "BlockedRolledBack" : "BlockedRollbackFailed",
                atomicRollbackSucceeded = confirmed,
                mainApply = new { status = "Applied", transaction = OperatorNativeTransactionReceipt.Committed(new[] { 1543000L }) },
                branchResults = new[] { new { status = "Blocked", code = "branch_segment_too_short" } },
                transaction = OperatorNativeTransactionReceipt.FromAtomicGroupRollback(confirmed)
            };
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(workflow, "apply", "POST", "/revit/mep-branch-network-workflow");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(authority, settlement.EffectAuthority);
            Assert.Empty(settlement.AffectedTargetIdentities);
            var legacy = new { workflow.status, workflow.atomicRollbackSucceeded, workflow.mainApply, workflow.branchResults };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(legacy, "apply", "POST", "/revit/mep-branch-network-workflow").EffectState);
        }

        [Fact]
        public void AtomicNetworkCommitNeedsTopLevelTransactionReceipt()
        {
            var createdIds = new[] { 1542939L, 1542942L, 1542945L };
            var workflow = new
            {
                status = "AppliedNetworkVerified",
                workflowMode = "apply",
                atomicCommitSucceeded = true,
                created = new { allModelIds = createdIds },
                transaction = OperatorNativeTransactionReceipt.Committed(createdIds)
            };
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(workflow, "apply", "POST", "/revit/mep-branch-network-workflow");
            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal("native_transaction", settlement.EffectAuthority);
            foreach (var id in createdIds)
                Assert.Contains($"element_id:{id}", settlement.AffectedTargetIdentities);
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(new
            {
                workflow.status, workflow.workflowMode, workflow.atomicCommitSucceeded, workflow.created
            }, "apply", "POST", "/revit/mep-branch-network-workflow").EffectState);
        }

        [Theory]
        [InlineData("RolledBack", "none", "native_rollback")]
        [InlineData("Committed", "applied", "native_transaction")]
        [InlineData("Pending", "unknown", "native_host")]
        [InlineData("Error", "unknown", "native_host")]
        public void RouteWorkflowUsesObservedTransactionStatusInsteadOfRollbackProse(string nativeStatus, string effect, string authority)
        {
            var stage = new { status = "Blocked", error = "Selected duct type created shape 'round', but requested size/ductShape requires 'rectangular'.",
                dryRun = true, rolledBack = true, createdElementIds = Array.Empty<long>(),
                transaction = OperatorNativeTransactionReceipt.FromObservedStatus(nativeStatus, new[] { 42L }) };
            var workflow = new { status = "Blocked", workflowMode = "applyRequested", dryRun = stage, applyResult = (object?)null,
                transaction = OperatorNativeTransactionReceipt.LastAttemptedStage(stage, null, false) };
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(workflow, "apply", "POST", "/revit/mep-route-workflow");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(authority, settlement.EffectAuthority);
        }

        [Fact]
        public void TrialRollbackCannotHideAnUnknownOrCommittedApply()
        {
            var preview = new { transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L }) };
            foreach (var apply in new object?[] { null, new { status = "Applied" }, new { transaction = OperatorNativeTransactionReceipt.Unknown("Pending") } })
            {
                var workflow = new { transaction = OperatorNativeTransactionReceipt.LastAttemptedStage(preview, apply, true) };
                Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(workflow, "apply", "POST", "/revit/mep-route-workflow").EffectState);
            }
            var committed = new { transaction = OperatorNativeTransactionReceipt.Committed(new[] { 43L }) };
            var applied = OperatorAttemptSuccessfulSettlement.Classify(new {
                transaction = OperatorNativeTransactionReceipt.LastAttemptedStage(preview, committed, true)
            }, "apply", "POST", "/revit/mep-route-workflow");
            Assert.Equal("applied", applied.EffectState);
            Assert.Contains("element_id:43", applied.AffectedTargetIdentities);
            Assert.DoesNotContain("element_id:42", applied.AffectedTargetIdentities);
            var oldFailure = new { status = "Blocked", dryRun = new { rolledBack = true }, applyResult = (object?)null };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(oldFailure, "apply", "POST", "/revit/mep-route-workflow").EffectState);
        }

        [Fact]
        public void ExactQueuedCancellationSurvivesDeadlineMappingAsNoDispatchForMutation()
        {
            var deadline = OperatorActionDeadlinePolicy.Resolve("POST", "/revit/set-parameter", "high");
            var failure = OperatorCourierFailureClassifier.Classify(deadline.ClassifyCancellation(
                new RevitEventCanceledBeforeDispatchException("queued-mutation-1"), "queued-mutation-1"));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(failure, "apply", "POST", "/revit/set-parameter");
            Assert.False(settlement.RequestDispatched);
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("revit_action_deadline_elapsed_before_dispatch", settlement.EffectReason);
        }

        [Fact]
        public void PreDispatchFailureIsAuthoritativeNone()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorToolUserErrorException(
                    "Typed confirmation is required.",
                    "confirmation_required",
                    requiredConfirm: "confirm",
                    confirmReceived: "wrong",
                    hint: "Confirm the exact mutation."));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(failure, "apply", "POST", "/revit/move-elements");

            Assert.False(settlement.RequestDispatched);
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("schema_validator", settlement.EffectAuthority);
        }

        [Fact]
        public void CorrectableTextConfirmationRejectionIsNoEffectAndRetryable()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorToolUserErrorException(
                    "TextNote edit requires typed confirmation.",
                    "bulk_confirm_required",
                    requiredConfirm: "APPLY 1 TEXT NOTE CHANGE",
                    confirmReceived: ""));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(
                failure, "apply", "POST", "/revit/replace-text-note");

            Assert.True(failure.Retryable);
            Assert.False(settlement.RequestDispatched);
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("schema_validator", settlement.EffectAuthority);
            Assert.Equal("bulk_confirm_required", settlement.EffectReason);
        }

        [Fact]
        public void PostDispatchTimeoutIsUnknownAndNotRetryable()
        {
            var failure = OperatorCourierFailureClassifier.Classify(
                new OperatorActionDeadlineExceededException("model_mutation", 85_000, "attempt-1"));
            var settlement = OperatorAttemptFailureSettlement.FromFailure(failure, "apply", "POST", "/revit/move-elements");

            Assert.True(settlement.RequestDispatched);
            Assert.Equal("unknown", settlement.EffectState);
            Assert.False(failure.Retryable);
        }

        [Fact]
        public void NativeTransactionCommitAndRollbackProduceDifferentTruth()
        {
            var committed = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "committed", committed = true, modified_element_ids = new[] { 42L } }
            }, "apply", "POST", "/revit/native-api-mutation-ops");
            var rolledBack = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "rolled_back", committed = false, modified_element_ids = new[] { 42L } }
            }, "preview", "POST", "/revit/native-api-mutation-ops");

            Assert.Equal("applied", committed.EffectState);
            Assert.Equal("native_transaction", committed.EffectAuthority);
            Assert.Contains("element_id:42", committed.AffectedTargetIdentities);
            Assert.Equal("none", rolledBack.EffectState);
            Assert.Equal("native_rollback", rolledBack.EffectAuthority);
        }

        [Fact]
        public void UnprovenMutationSuccessRemainsUnknown()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(
                new { status = "Moved", rolledBack = false },
                "apply", "POST", "/revit/move-elements");

            Assert.True(settlement.RequestDispatched);
            Assert.Equal("unknown", settlement.EffectState);
            Assert.Equal("native_host", settlement.EffectAuthority);
        }

        [Fact]
        public void NativeNotStartedTransactionIsAuthoritativeNoEffect()
        {
            var noEffect = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status = "not_started", committed = false, modified_element_ids = new long[0] }
            }, "apply", "POST", "/revit/replace-text-note");

            Assert.Equal("none", noEffect.EffectState);
            Assert.Equal("native_transaction", noEffect.EffectAuthority);
            Assert.Equal("native_transaction_not_started", noEffect.EffectReason);
        }

        [Fact]
        public void TextNoteTransactionReceiptFactoriesPreserveCommittedRollbackAndNoEffectTruth()
        {
            var committed = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 42L })
            }, "apply", "POST", "/revit/replace-text-note");
            var preview = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L })
            }, "preview", "POST", "/revit/replace-text-note");
            var unchanged = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = OperatorNativeTransactionReceipt.NotStarted(new[] { 42L })
            }, "apply", "POST", "/revit/set-text-note-text");

            Assert.Equal("applied", committed.EffectState);
            Assert.Equal("none", preview.EffectState);
            Assert.Equal("none", unchanged.EffectState);
            Assert.Contains("element_id:42", committed.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterPreviewRollbackIsAuthoritativeNoEffect()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Dry Run",
                dryRun = true,
                changedCount = 1,
                transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L })
            }, "preview", "POST", "/revit/set-parameter");

            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("native_rollback", settlement.EffectAuthority);
            Assert.Equal("verified_native_rollback", settlement.EffectReason);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void ViewPlanWithoutTransactionIsNotACompletedRollbackPreview()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Dry Run", dryRun = true, previewExecuted = false,
                plan = new { action = "create_floor_plan", name = "M-LEVEL 2 COORDINATION" },
                transaction = OperatorNativeTransactionReceipt.NotStarted()
            }, "preview", "POST", "/revit/create-view");
            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("native_transaction", settlement.EffectAuthority);
            Assert.Equal("native_transaction_not_started", settlement.EffectReason);
            Assert.Empty(settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterApplyCommitIsAuthoritativeApplied()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Applied and Verified",
                dryRun = false,
                changedCount = 1,
                transaction = OperatorNativeTransactionReceipt.Committed(new[] { 42L })
            }, "apply", "POST", "/revit/set-parameter");

            Assert.Equal("applied", settlement.EffectState);
            Assert.Equal("native_transaction", settlement.EffectAuthority);
            Assert.Contains("element_id:42", settlement.AffectedTargetIdentities);
        }

        [Fact]
        public void GenericParameterNoChangeAndPreconditionRollbackRemainRetrySafe()
        {
            foreach (var response in new object[]
            {
                new { status = "No Change Required", transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L }) },
                new { status = "Precondition Failed", transaction = OperatorNativeTransactionReceipt.RolledBack(new[] { 42L }) }
            })
            {
                var settlement = OperatorAttemptSuccessfulSettlement.Classify(response, "apply", "POST", "/revit/set-parameter");
                Assert.Equal("none", settlement.EffectState);
                Assert.Equal("native_rollback", settlement.EffectAuthority);
            }
        }

        [Fact]
        public void GenericParameterMutationWithoutTransactionTruthRemainsUnknown()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Applied and Verified",
                dryRun = false,
                changedCount = 1,
                changedElementIds = new[] { 42L }
            }, "apply", "POST", "/revit/set-parameter");

            Assert.Equal("unknown", settlement.EffectState);
            Assert.Equal("native_handler_returned_without_authoritative_settlement", settlement.EffectReason);
        }

        [Fact]
        public void UnrelatedReadIgnoresPresentationTransactionFieldsAndRemainsNoEffect()
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                status = "Inventory Complete",
                transaction = new { status = "committed", committed = true, modified_element_ids = new[] { 42L } }
            }, "read", "POST", "/revit/find-text-notes");

            Assert.Equal("none", settlement.EffectState);
            Assert.Equal("read_has_no_persistent_effect", settlement.EffectReason);
        }

        [Theory]
        [InlineData("committed", false)]
        [InlineData("rolled_back", true)]
        [InlineData("pending", false)]
        public void ContradictoryOrUnrecognizedTransactionSettlementRemainsUnknown(string status, bool committed)
        {
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(new
            {
                transaction = new { status, committed, modified_element_ids = new[] { 42L } }
            }, "apply", "POST", "/revit/replace-text-note");

            Assert.Equal("unknown", settlement.EffectState);
        }

        [Theory]
        [InlineData("offset_orthogonal")]
        [InlineData("offset_dogleg45")]
        [InlineData("size_transition")]
        public void ReroutePlanningRequiresNativeNotStartedReceipt(string operation)
        {
            const string route = "/revit/reroute-mep-route-segment";
            var oldPlan = new { status = "Dry Run", dryRun = true, operation, plan = new { ApplySupported = true } };
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(oldPlan, "preview", "POST", route).EffectState);
            foreach (var status in new[] { "Dry Run", "Blocked" })
            {
                var payload = new { status, dryRun = true, operation, previewExecuted = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(), plan = oldPlan.plan };
                var result = OperatorAttemptSuccessfulSettlement.Classify(payload, "preview", "POST", route);
                Assert.Equal("none", result.EffectState);
                Assert.Equal("native_transaction", result.EffectAuthority);
                Assert.Equal("native_transaction_not_started", result.EffectReason);
            }
        }

        [Theory]
        [InlineData("RolledBack", false, "applied")]
        [InlineData("RolledBack", true, "applied")]
        [InlineData("Pending", false, "unknown")]
        [InlineData("Started", true, "unknown")]
        public void RerouteVisualStageCannotEraseCommittedRouteOrHideUnsettledEffects(string observed, bool captureFails, string effect)
        {
            var routeReceipt = OperatorNativeTransactionReceipt.CommittedChanges(new[] { 52L }, System.Array.Empty<long>(), new[] { 42L });
            var status = "Uninitialized";
            var rollbacks = 0;
            var visual = OperatorNativeTransactionExecution.Execute(
                () => status = "Started", () => throw new System.Exception("unexpected commit"),
                () => { rollbacks++; if (observed == "Started") throw new System.Exception("rollback failed"); return status = observed; },
                () => status,
                () => captureFails ? throw new System.Exception("capture failed") : new Dictionary<string, object?>(),
                () => throw new System.Exception("unexpected committed visual inventory"),
                disposition: NativeTransactionDisposition.Rollback);
            var visualReceipt = (OperatorNativeTransactionReceipt)visual["transaction"]!;
            var finalReceipt = visualReceipt.Status == "rolled_back" || visualReceipt.Status == "not_started"
                ? routeReceipt : OperatorNativeTransactionReceipt.Unknown("visual_stage_unsettled", routeReceipt.AffectedElementIds);
            var payload = new { success = !captureFails && effect == "applied", transaction = finalReceipt,
                nativeStages = new { route = routeReceipt, visual } };
            var settlement = OperatorAttemptSuccessfulSettlement.Classify(payload, "apply", "POST", "/revit/reroute-mep-route-segment");
            Assert.Equal(effect, settlement.EffectState);
            Assert.Equal(1, rollbacks);
            Assert.Equal("committed", routeReceipt.Status);
            Assert.Equal(new[] { 42L, 52L }, routeReceipt.AffectedElementIds);
            if (captureFails) Assert.False((bool)visual["success"]!);
        }

        [Fact]
        public void AttachedEnvelopeCarriesAssignmentFenceAndCannotBeSpoofedByHandler()
        {
            var attached = OperatorAttemptSuccessfulSettlement.Attach(
                new Dictionary<string, object?>
                {
                    ["status"] = "ok",
                    ["canonical_attempt_settlement"] = new { effect_state = "applied" }
                },
                "read", "GET", "/revit/context",
                "assignment-1", "attempt-1", "run-1", 7, "sha256:action", "sha256:target");
            using var document = JsonDocument.Parse(JsonSerializer.Serialize(attached));
            var settlement = document.RootElement.GetProperty("canonical_attempt_settlement");

            Assert.Equal(1, document.RootElement.EnumerateObject().Count(property => property.Name == "canonical_attempt_settlement"));
            Assert.Equal("assignment-1", settlement.GetProperty("assignment_id").GetString());
            Assert.Equal(7, settlement.GetProperty("generation").GetInt32());
            Assert.Equal("none", settlement.GetProperty("effect_state").GetString());
        }
    }
}

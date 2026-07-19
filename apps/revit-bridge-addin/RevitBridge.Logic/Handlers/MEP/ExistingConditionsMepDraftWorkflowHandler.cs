using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed class ExistingConditionsMepDraftWorkflowHandler : IRequestHandler
    {
        public sealed class ElementReference
        {
            public string created_by_action { get; set; } = "";
            public string output { get; set; } = "created";
            public int? index { get; set; }
        }

        private sealed class OperationOutput
        {
            public List<long> CreatedElementIds { get; set; } = new List<long>();
            public List<long> RouteSegmentElementIds { get; set; } = new List<long>();
            public List<long> RouteStartElementIds { get; set; } = new List<long>();
            public List<long> RouteEndElementIds { get; set; } = new List<long>();
            public List<long> SplitMainStartElementIds { get; set; } = new List<long>();
            public List<long> SplitMainEndElementIds { get; set; } = new List<long>();
        }

        private sealed class OperationReceipt
        {
            public string ActionKey { get; set; } = "";
            public string Path { get; set; } = "";
            public List<long> ElementIds { get; set; } = new List<long>();
            public OperationOutput Output { get; set; } = new OperationOutput();
            public object Response { get; set; } = new object();
        }

        public sealed class PriorActionOutput
        {
            public string action_key { get; set; } = "";
            public List<long>? created_element_ids { get; set; }
            public List<long>? route_segment_element_ids { get; set; }
            public List<long>? route_start_element_ids { get; set; }
            public List<long>? route_end_element_ids { get; set; }
            public List<long>? split_main_start_element_ids { get; set; }
            public List<long>? split_main_end_element_ids { get; set; }
        }

        public sealed class DeferredBody
        {
            public ElementReference? host_element { get; set; }
            public ElementReference? source_element { get; set; }
            public ElementReference? main_element { get; set; }
            public ElementReference? target_element { get; set; }
            public List<ElementReference>? target_elements { get; set; }
            public List<ElementReference>? element_ids { get; set; }
            public List<long>? existing_element_ids { get; set; }
            public long? source_element_id { get; set; }
            public string? create_system_type { get; set; }
            public long? panel_element_id { get; set; }
            public ElementReference? panel_element { get; set; }
            public long? target_element_id { get; set; }
            public int? required_connection_count { get; set; }
            public List<ElementReference>? fixture_elements { get; set; }
            public List<long>? fixture_element_ids { get; set; }
            public bool? require_downstream_vent { get; set; }
            public ElementReference? tag_element { get; set; }
        }

        public sealed class Operation
        {
            public string action_key { get; set; } = "";
            public string path { get; set; } = "";
            public List<string>? depends_on { get; set; }
            public JsonElement? apply_body { get; set; }
            public DeferredBody? deferred_body { get; set; }
            public int expected_created_min { get; set; } = 0;
            public int expected_created_max { get; set; } = 0;
        }

        public sealed class Params
        {
            public string inputFingerprintSha256 { get; set; } = "";
            public string stageKey { get; set; } = "";
            public List<PriorActionOutput>? priorActionOutputs { get; set; }
            public List<Operation> operations { get; set; } = new List<Operation>();
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
            public int maximumCreatedElements { get; set; } = 100;
            public long? targetViewId { get; set; }
            public bool applyTargetViewPhase { get; set; } = false;
            public bool requireAllCreatedElementsVisibleInTargetView { get; set; } = false;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.operations == null || p.operations.Count == 0)
                throw new InvalidOperationException("operations_are_required");
            var inputFingerprint = Clean(p.inputFingerprintSha256).ToLowerInvariant();
            if (inputFingerprint.Length != 64 || inputFingerprint.Any(character => !Uri.IsHexDigit(character)))
                throw new InvalidOperationException("inputFingerprintSha256_must_be_sha256");
            if (p.maximumCreatedElements < 1 || p.maximumCreatedElements > 500)
                throw new InvalidOperationException("maximumCreatedElements_must_be_between_1_and_500");

            var priorOutputs = new Dictionary<string, OperationOutput>(StringComparer.OrdinalIgnoreCase);
            foreach (var prior in p.priorActionOutputs ?? new List<PriorActionOutput>())
            {
                var priorKey = Clean(prior.action_key);
                if (string.IsNullOrWhiteSpace(priorKey) || priorOutputs.ContainsKey(priorKey))
                    throw new InvalidOperationException("prior_action_output_keys_must_be_unique_and_nonempty");
                priorOutputs[priorKey] = new OperationOutput
                {
                    CreatedElementIds = NormalizeElementIds(prior.created_element_ids),
                    RouteSegmentElementIds = NormalizeElementIds(prior.route_segment_element_ids),
                    RouteStartElementIds = NormalizeElementIds(prior.route_start_element_ids),
                    RouteEndElementIds = NormalizeElementIds(prior.route_end_element_ids),
                    SplitMainStartElementIds = NormalizeElementIds(prior.split_main_start_element_ids),
                    SplitMainEndElementIds = NormalizeElementIds(prior.split_main_end_element_ids)
                };
            }

            var keys = p.operations.Select(operation => Clean(operation.action_key)).ToList();
            if (keys.Any(string.IsNullOrWhiteSpace) || keys.Distinct(StringComparer.OrdinalIgnoreCase).Count() != keys.Count)
                throw new InvalidOperationException("operation_action_keys_must_be_unique_and_nonempty");
            if (keys.Any(priorOutputs.ContainsKey))
                throw new InvalidOperationException("operation_action_keys_must_not_duplicate_prior_outputs");
            var knownKeys = new HashSet<string>(priorOutputs.Keys, StringComparer.OrdinalIgnoreCase);
            knownKeys.UnionWith(keys);
            foreach (var operation in p.operations)
            {
                foreach (var dependency in operation.depends_on ?? new List<string>())
                {
                    if (!knownKeys.Contains(Clean(dependency)))
                        throw new InvalidOperationException($"unknown_operation_dependency:{operation.action_key}:{dependency}");
                }
            }

            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            foreach (var prior in priorOutputs)
            {
                var createdIds = new HashSet<long>(prior.Value.CreatedElementIds);
                var specializedIds = prior.Value.RouteSegmentElementIds
                    .Concat(prior.Value.RouteStartElementIds)
                    .Concat(prior.Value.RouteEndElementIds)
                    .Concat(prior.Value.SplitMainStartElementIds)
                    .Concat(prior.Value.SplitMainEndElementIds)
                    .Distinct()
                    .ToList();
                if (specializedIds.Any(id => !createdIds.Contains(id)))
                    throw new InvalidOperationException($"prior_action_output_not_subset_of_created:{prior.Key}");
                var missingIds = createdIds
                    .Where(id => doc.GetElement(ElementIdCompat.Create(id)) == null)
                    .OrderBy(id => id)
                    .ToList();
                if (missingIds.Count > 0)
                    throw new InvalidOperationException(
                        $"prior_action_output_elements_missing:{prior.Key}:{string.Join(",", missingIds)}"
                    );
            }
            View? targetView = null;
            Phase? targetViewPhase = null;
            if (p.targetViewId.HasValue && p.targetViewId.Value > 0)
            {
                targetView = doc.GetElement(ElementIdCompat.Create(p.targetViewId.Value)) as View
                    ?? throw new InvalidOperationException($"target_view_not_found:{p.targetViewId.Value}");
                var phaseId = targetView.get_Parameter(BuiltInParameter.VIEW_PHASE)?.AsElementId()
                    ?? ElementId.InvalidElementId;
                if (phaseId != ElementId.InvalidElementId)
                    targetViewPhase = doc.GetElement(phaseId) as Phase;
            }
            if ((p.applyTargetViewPhase || p.requireAllCreatedElementsVisibleInTargetView) && targetView == null)
                throw new InvalidOperationException("targetViewId_is_required_for_target_view_acceptance");
            if (p.applyTargetViewPhase && targetViewPhase == null)
                throw new InvalidOperationException($"target_view_phase_not_resolved:{p.targetViewId}");

            var outputs = new Dictionary<string, OperationOutput>(priorOutputs, StringComparer.OrdinalIgnoreCase);
            var receipts = new List<OperationReceipt>();
            OperationReceipt? failedReceipt = null;
            var allCreatedIds = new HashSet<long>();
            var phaseAdjustedElementIds = new List<long>();
            var phaseSkippedElementIds = new List<long>();
            var visibleCreatedElementIds = new List<long>();
            var invisibleCreatedElementIds = new List<long>();
            string? workflowFailure = null;
            var transactionGroupRolledBack = false;
            using (var group = new TransactionGroup(doc, p.dryRun
                ? "Existing Conditions MEP Draft (Dry Run)"
                : "Existing Conditions MEP Draft"))
            {
                group.Start();
                try
                {
                    foreach (var operation in p.operations)
                    {
                        foreach (var dependency in operation.depends_on ?? new List<string>())
                        {
                            if (!outputs.ContainsKey(dependency))
                                throw new InvalidOperationException($"operation_dependency_not_completed:{operation.action_key}:{dependency}");
                        }

                        var requestJson = BuildRequest(operation, outputs, p.verify, doc);
                        var handler = ResolveHandler(operation.path);
                        var response = handler.Handle(app, requestJson).GetAwaiter().GetResult();
                        using var responseDocument = JsonDocument.Parse(JsonSerializer.Serialize(response));
                        var responseJson = responseDocument.RootElement.Clone();
                        var output = ExtractOperationOutput(operation.path, responseJson);
                        var createdIds = output.CreatedElementIds;
                        if (ResponseFailed(operation.path, responseJson, operation.apply_body, operation.deferred_body, out var failure))
                        {
                            foreach (var id in createdIds) allCreatedIds.Add(id);
                            failedReceipt = new OperationReceipt
                            {
                                ActionKey = operation.action_key,
                                Path = operation.path,
                                ElementIds = createdIds,
                                Output = output,
                                Response = response
                            };
                            throw new InvalidOperationException($"operation_failed:{operation.action_key}:{failure}");
                        }
                        if (operation.expected_created_min < 0
                            || operation.expected_created_max < operation.expected_created_min
                            || createdIds.Count < operation.expected_created_min
                            || createdIds.Count > operation.expected_created_max)
                        {
                            throw new InvalidOperationException(
                                $"operation_created_count_mismatch:{operation.action_key}:expected={operation.expected_created_min}..{operation.expected_created_max}:actual={createdIds.Count}"
                            );
                        }
                        outputs[operation.action_key] = output;
                        foreach (var id in createdIds) allCreatedIds.Add(id);
                        if (allCreatedIds.Count > p.maximumCreatedElements)
                            throw new InvalidOperationException($"maximum_created_elements_exceeded:{allCreatedIds.Count}>{p.maximumCreatedElements}");
                        receipts.Add(new OperationReceipt
                        {
                            ActionKey = operation.action_key,
                            Path = operation.path,
                            ElementIds = createdIds,
                            Output = output,
                            Response = response
                        });
                    }

                    if (p.applyTargetViewPhase && targetViewPhase != null)
                    {
                        using (var phaseTransaction = new Transaction(doc, "Apply Target View Phase"))
                        {
                            phaseTransaction.Start();
                            foreach (var id in allCreatedIds.OrderBy(value => value))
                            {
                                var element = doc.GetElement(ElementIdCompat.Create(id));
                                if (element == null) throw new InvalidOperationException($"created_element_missing_before_phase_assignment:{id}");
                                // View-specific elements (for example DetailCurves used as
                                // explicitly provisional plan markers) inherit visibility
                                // from their owner view rather than a model Created Phase.
                                // Revit can expose PHASE_CREATED on these elements while
                                // refusing to retain a write, so phase acceptance must defer
                                // to the separate target-view visibility gate.
                                if (element.ViewSpecific)
                                {
                                    phaseSkippedElementIds.Add(id);
                                    continue;
                                }
                                var phaseParameter = element.get_Parameter(BuiltInParameter.PHASE_CREATED);
                                if (phaseParameter == null)
                                {
                                    phaseSkippedElementIds.Add(id);
                                    continue;
                                }
                                if (phaseParameter.IsReadOnly)
                                    throw new InvalidOperationException($"created_element_phase_is_read_only:{id}");
                                var targetPhaseId = targetViewPhase.Id;
                                if (ElementIdCompat.GetValue(phaseParameter.AsElementId()) != ElementIdCompat.GetValue(targetPhaseId))
                                    phaseParameter.Set(targetPhaseId);
                                if (ElementIdCompat.GetValue(phaseParameter.AsElementId()) != ElementIdCompat.GetValue(targetPhaseId))
                                    throw new InvalidOperationException($"created_element_phase_readback_mismatch:{id}");
                                phaseAdjustedElementIds.Add(id);
                            }
                            doc.Regenerate();
                            phaseTransaction.Commit();
                        }
                    }

                    if (targetView != null)
                    {
                        var visibleIds = new HashSet<long>(
                            new FilteredElementCollector(doc, targetView.Id)
                                .WhereElementIsNotElementType()
                                .ToElementIds()
                                .Select(ElementIdCompat.GetValue)
                        );
                        visibleCreatedElementIds = allCreatedIds.Where(visibleIds.Contains).OrderBy(id => id).ToList();
                        invisibleCreatedElementIds = allCreatedIds.Where(id => !visibleIds.Contains(id)).OrderBy(id => id).ToList();
                        if (p.requireAllCreatedElementsVisibleInTargetView && invisibleCreatedElementIds.Count > 0)
                            throw new InvalidOperationException(
                                $"created_elements_not_visible_in_target_view:{string.Join(",", invisibleCreatedElementIds)}"
                            );
                    }

                    if (p.dryRun)
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                    else group.Assimilate();
                }
                catch (Exception ex)
                {
                    workflowFailure = ex.Message;
                    if (group.GetStatus() == TransactionStatus.Started)
                    {
                        group.RollBack();
                        transactionGroupRolledBack = true;
                    }
                }
            }

            var residualCreatedIds = transactionGroupRolledBack
                ? allCreatedIds.Where(id => doc.GetElement(ElementIdCompat.Create(id)) != null).OrderBy(id => id).ToList()
                : new List<long>();
            var rollbackVerified = !transactionGroupRolledBack || residualCreatedIds.Count == 0;
            if (!rollbackVerified && string.IsNullOrWhiteSpace(workflowFailure))
                workflowFailure = "transaction_group_rollback_left_created_elements";

            return Task.FromResult<object>(new
            {
                schema = "operator.existing_conditions_mep_draft_workflow.v1",
                inputFingerprintSha256 = inputFingerprint,
                stageKey = Clean(p.stageKey),
                priorActionOutputCount = priorOutputs.Count,
                status = string.IsNullOrWhiteSpace(workflowFailure) ? (p.dryRun ? "DryRunReady" : "Applied") : "Blocked",
                dryRun = p.dryRun,
                transactionGroupRolledBack,
                rollbackVerified,
                residualCreatedElementIds = residualCreatedIds,
                atomic = rollbackVerified,
                error = workflowFailure,
                targetView = targetView == null ? null : new
                {
                    id = ElementIdCompat.GetValue(targetView.Id),
                    name = targetView.Name,
                    phaseId = targetViewPhase == null ? (long?)null : ElementIdCompat.GetValue(targetViewPhase.Id),
                    phaseName = targetViewPhase?.Name
                },
                targetViewAcceptance = targetView == null ? null : new
                {
                    applyTargetViewPhase = p.applyTargetViewPhase,
                    requireAllCreatedElementsVisible = p.requireAllCreatedElementsVisibleInTargetView,
                    phaseAdjustedElementIds,
                    phaseSkippedElementIds,
                    visibleCreatedElementIds,
                    invisibleCreatedElementIds,
                    passed = invisibleCreatedElementIds.Count == 0
                },
                operationCount = receipts.Count,
                createdElementIds = transactionGroupRolledBack
                    ? new List<long>()
                    : allCreatedIds.OrderBy(id => id).ToList(),
                transientCreatedElementIds = transactionGroupRolledBack
                    ? allCreatedIds.OrderBy(id => id).ToList()
                    : new List<long>(),
                failedOperation = failedReceipt == null ? null : new
                {
                    actionKey = failedReceipt.ActionKey,
                    path = failedReceipt.Path,
                    createdElementIds = transactionGroupRolledBack ? new List<long>() : failedReceipt.ElementIds,
                    transientCreatedElementIds = transactionGroupRolledBack ? failedReceipt.ElementIds : new List<long>(),
                    response = failedReceipt.Response
                },
                operations = receipts.Select(receipt => new
                {
                    actionKey = receipt.ActionKey,
                    path = receipt.Path,
                    createdElementIds = transactionGroupRolledBack ? new List<long>() : receipt.ElementIds,
                    transientCreatedElementIds = transactionGroupRolledBack ? receipt.ElementIds : new List<long>(),
                    response = receipt.Response
                }).ToList(),
                operationOutputs = receipts.Select(receipt => new
                {
                    action_key = receipt.ActionKey,
                    created_element_ids = receipt.Output.CreatedElementIds,
                    route_segment_element_ids = receipt.Output.RouteSegmentElementIds,
                    route_start_element_ids = receipt.Output.RouteStartElementIds,
                    route_end_element_ids = receipt.Output.RouteEndElementIds,
                    split_main_start_element_ids = receipt.Output.SplitMainStartElementIds,
                    split_main_end_element_ids = receipt.Output.SplitMainEndElementIds
                }).ToList()
            });
        }

        private static List<long> NormalizeElementIds(IEnumerable<long>? values)
        {
            return (values ?? Enumerable.Empty<long>())
                .Where(value => value > 0)
                .Distinct()
                .OrderBy(value => value)
                .ToList();
        }

        private static string BuildRequest(
            Operation operation,
            IReadOnlyDictionary<string, OperationOutput> outputs,
            bool verify,
            Document doc)
        {
            var path = NormalizePath(operation.path);
            if (path == "/revit/place-families" && operation.deferred_body?.host_element != null)
            {
                var hostIds = ResolveReference(operation.deferred_body.host_element, outputs, operation.action_key, "host_element");
                if (hostIds.Count != 1)
                    throw new InvalidOperationException($"host_element_reference_must_resolve_one_id:{operation.action_key}:found={hostIds.Count}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var placementBody = JsonSerializer.Deserialize<PlaceFamiliesHandler.PlacementRequest>(operation.apply_body.Value.GetRawText())
                    ?? throw new InvalidOperationException($"place_families_body_invalid:{operation.action_key}");
                if (placementBody.instances == null || placementBody.instances.Count == 0)
                    throw new InvalidOperationException($"place_families_instances_required:{operation.action_key}");
                foreach (var instance in placementBody.instances) instance.hostElementId = hostIds[0];
                placementBody.dryRun = false;
                return JsonSerializer.Serialize(placementBody);
            }
            if (path == "/revit/connect-mep-elements")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var sourceIds = ResolveReference(deferred.source_element, outputs, operation.action_key, "source_element");
                if (sourceIds.Count != 1)
                    throw new InvalidOperationException($"source_element_reference_must_resolve_one_id:{operation.action_key}:found={sourceIds.Count}");
                var targetIds = ResolveReferences(deferred.target_elements, outputs, operation.action_key, "target_elements");
                if (targetIds.Count == 0)
                    throw new InvalidOperationException($"target_element_references_resolved_empty:{operation.action_key}");
                return JsonSerializer.Serialize(new
                {
                    sourceElementId = sourceIds[0],
                    targetElementIds = targetIds,
                    toleranceFt = 0.5,
                    sizeToleranceFt = 0.01,
                    requiredConnectionCount = deferred.required_connection_count ?? targetIds.Count,
                    dryRun = false,
                    verify
                });
            }
            if (path == "/revit/assign-electrical-circuit")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var elementIds = (deferred.existing_element_ids ?? new List<long>())
                    .Where(id => id > 0)
                    .Concat(deferred.element_ids == null || deferred.element_ids.Count == 0
                        ? new List<long>()
                        : ResolveReferences(deferred.element_ids, outputs, operation.action_key, "element_ids"))
                    .Distinct()
                    .ToList();
                if (elementIds.Count == 0)
                    throw new InvalidOperationException($"electrical_member_references_resolved_empty:{operation.action_key}");
                var missingExistingIds = (deferred.existing_element_ids ?? new List<long>())
                    .Where(id => id > 0 && doc.GetElement(ElementIdCompat.Create(id)) == null)
                    .Distinct()
                    .ToList();
                if (missingExistingIds.Count > 0)
                    throw new InvalidOperationException($"electrical_existing_member_ids_missing:{operation.action_key}:{string.Join(",", missingExistingIds)}");
                var createNew = string.Equals(deferred.create_system_type, "PowerCircuit", StringComparison.OrdinalIgnoreCase);
                if (!createNew && (!deferred.source_element_id.HasValue || deferred.source_element_id.Value <= 0))
                    throw new InvalidOperationException($"source_element_id_required:{operation.action_key}");
                if (createNew && deferred.source_element_id.HasValue)
                    throw new InvalidOperationException($"new_circuit_cannot_use_source_element_id:{operation.action_key}");
                if (deferred.panel_element_id.HasValue && deferred.panel_element != null)
                    throw new InvalidOperationException($"panel_element_id_and_reference_are_mutually_exclusive:{operation.action_key}");
                long? panelElementId = deferred.panel_element_id;
                if (deferred.panel_element != null)
                {
                    var panelIds = ResolveReference(deferred.panel_element, outputs, operation.action_key, "panel_element");
                    if (panelIds.Count != 1)
                        throw new InvalidOperationException($"panel_element_reference_must_resolve_one_id:{operation.action_key}:found={panelIds.Count}");
                    panelElementId = panelIds[0];
                }
                return JsonSerializer.Serialize(new
                {
                    elementIds,
                    sourceElementId = createNew ? null : deferred.source_element_id,
                    createSystemType = createNew ? "PowerCircuit" : null,
                    panelElementId,
                    dryRun = false,
                    confirm = true,
                    parameterOnlyFallback = false
                });
            }
            if (path == "/revit/tag-elements")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var elementIds = ResolveReference(deferred.tag_element, outputs, operation.action_key, "tag_element");
                if (elementIds.Count != 1)
                    throw new InvalidOperationException($"tag_element_reference_must_resolve_one_id:{operation.action_key}:found={elementIds.Count}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var tagBody = JsonSerializer.Deserialize<RevitBridge.Logic.Handlers.TagElementsHandler.TagRequest>(operation.apply_body.Value.GetRawText())
                    ?? throw new InvalidOperationException($"tag_elements_body_invalid:{operation.action_key}");
                tagBody.elementIds = elementIds;
                tagBody.dryRun = false;
                return JsonSerializer.Serialize(tagBody);
            }
            if (path == "/revit/create-pipe-between-connectors")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var sourceIds = ResolveReference(deferred.source_element, outputs, operation.action_key, "source_element");
                if (sourceIds.Count != 1)
                    throw new InvalidOperationException($"source_element_reference_must_resolve_one_id:{operation.action_key}:found={sourceIds.Count}");
                if (deferred.target_element_id.HasValue && deferred.target_element != null)
                    throw new InvalidOperationException($"target_element_id_and_reference_are_mutually_exclusive:{operation.action_key}");
                long targetElementId;
                if (deferred.target_element != null)
                {
                    var targetIds = ResolveReference(deferred.target_element, outputs, operation.action_key, "target_element");
                    if (targetIds.Count != 1)
                        throw new InvalidOperationException($"target_element_reference_must_resolve_one_id:{operation.action_key}:found={targetIds.Count}");
                    targetElementId = targetIds[0];
                }
                else if (deferred.target_element_id.HasValue && deferred.target_element_id.Value > 0)
                {
                    targetElementId = deferred.target_element_id.Value;
                }
                else throw new InvalidOperationException($"target_element_id_or_reference_required:{operation.action_key}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var bridgeBody = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                    ?? new Dictionary<string, object>();
                bridgeBody["sourceElementId"] = sourceIds[0];
                bridgeBody["targetElementId"] = targetElementId;
                bridgeBody["dryRun"] = false;
                bridgeBody["verify"] = verify;
                return JsonSerializer.Serialize(bridgeBody);
            }
            if (path == "/revit/audit-plumbing-fixture-services")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var fixtureIds = (deferred.fixture_element_ids ?? new List<long>()).Where(id => id > 0)
                    .Concat(deferred.fixture_elements == null || deferred.fixture_elements.Count == 0
                        ? new List<long>()
                        : ResolveReferences(deferred.fixture_elements, outputs, operation.action_key, "fixture_elements"))
                    .Distinct()
                    .ToList();
                if (fixtureIds.Count == 0)
                    throw new InvalidOperationException($"fixture_element_ids_required:{operation.action_key}");
                // Persist the runtime-resolved ids so the post-operation downstream
                // topology gate verifies the same newly placed fixtures sent to the audit.
                deferred.fixture_element_ids = fixtureIds;
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var auditBody = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                    ?? new Dictionary<string, object>();
                auditBody["fixtureElementIds"] = fixtureIds;
                return JsonSerializer.Serialize(auditBody);
            }
            if (path == "/revit/connect-mep-branch" && operation.deferred_body?.main_element != null)
            {
                var mainIds = ResolveReference(operation.deferred_body.main_element, outputs, operation.action_key, "main_element");
                if (mainIds.Count != 1)
                    throw new InvalidOperationException($"main_element_reference_must_resolve_one_id:{operation.action_key}:found={mainIds.Count}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var branchBody = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                    ?? new Dictionary<string, object>();
                branchBody["mainElementId"] = mainIds[0];
                branchBody["dryRun"] = false;
                branchBody["verify"] = verify;
                branchBody["visualVerify"] = false;
                return JsonSerializer.Serialize(branchBody);
            }

            if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
            var body = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                ?? new Dictionary<string, object>();
            if (path == "/revit/mep-route-workflow")
            {
                body["apply"] = true;
                body["visualVerify"] = false;
                body["verify"] = verify;
            }
            else if (path == "/revit/connect-mep-branch")
            {
                body["dryRun"] = false;
                body["verify"] = verify;
                body["visualVerify"] = false;
            }
            else
            {
                body["dryRun"] = false;
                body["includePreviewImage"] = false;
            }
            return JsonSerializer.Serialize(body);
        }

        private static IRequestHandler ResolveHandler(string rawPath)
        {
            switch (NormalizePath(rawPath))
            {
                case "/revit/mep-route-workflow": return new MepRouteWorkflowHandler();
                case "/revit/place-families": return new PlaceFamiliesHandler();
                case "/revit/place-family-instance-on-host": return new PlaceFamilyInstanceOnHostHandler();
                case "/revit/connect-mep-elements": return new ConnectMepElementsHandler();
                case "/revit/create-pipe-between-connectors": return new CreatePipeBetweenConnectorsHandler();
                case "/revit/connect-mep-branch": return new ConnectMepBranchHandler();
                case "/revit/audit-plumbing-fixture-services": return new PlumbingFixtureServicesAuditHandler();
                case "/revit/assign-electrical-circuit": return new AssignElectricalCircuitHandler();
                case "/revit/draw-detail-curves": return new RevitBridge.Logic.Handlers.Drafting.DrawDetailCurvesHandler();
                case "/revit/tag-elements": return new RevitBridge.Logic.Handlers.TagElementsHandler();
                default: throw new InvalidOperationException($"unsupported_mep_draft_operation_path:{rawPath}");
            }
        }

        private static List<long> ResolveReference(
            ElementReference? reference,
            IReadOnlyDictionary<string, OperationOutput> outputs,
            string actionKey,
            string label)
        {
            if (reference == null || string.IsNullOrWhiteSpace(reference.created_by_action))
                throw new InvalidOperationException($"{label}_reference_required:{actionKey}");
            if (!outputs.TryGetValue(reference.created_by_action, out var output))
                throw new InvalidOperationException($"{label}_reference_unresolved:{actionKey}:{reference.created_by_action}");
            switch (Clean(reference.output).ToLowerInvariant())
            {
                case "":
                case "created": return output.CreatedElementIds.Distinct().ToList();
                case "route_segment":
                    if (!reference.index.HasValue || reference.index.Value < 0 || reference.index.Value >= output.RouteSegmentElementIds.Count)
                        throw new InvalidOperationException($"{label}_reference_route_segment_index_invalid:{actionKey}:{reference.index}");
                    return new List<long> { output.RouteSegmentElementIds[reference.index.Value] };
                case "route_start": return output.RouteStartElementIds.Distinct().ToList();
                case "route_end": return output.RouteEndElementIds.Distinct().ToList();
                case "split_main_start": return output.SplitMainStartElementIds.Distinct().ToList();
                case "split_main_end": return output.SplitMainEndElementIds.Distinct().ToList();
                default: throw new InvalidOperationException($"{label}_reference_output_invalid:{actionKey}:{reference.output}");
            }
        }

        private static List<long> ResolveReferences(
            List<ElementReference>? references,
            IReadOnlyDictionary<string, OperationOutput> outputs,
            string actionKey,
            string label)
        {
            if (references == null || references.Count == 0)
                throw new InvalidOperationException($"{label}_references_required:{actionKey}");
            return references
                .SelectMany(reference => ResolveReference(reference, outputs, actionKey, label))
                .Distinct()
                .ToList();
        }

        private static OperationOutput ExtractOperationOutput(string rawPath, JsonElement response)
        {
            var path = NormalizePath(rawPath);
            if (path == "/revit/mep-route-workflow" && response.TryGetProperty("applyResult", out var applyResult))
            {
                var segmentIds = ReadLongArray(applyResult, "createdElementIds");
                var fittingIds = ReadLongArray(applyResult, "createdFittingIds");
                return new OperationOutput
                {
                    CreatedElementIds = segmentIds.Concat(fittingIds).Distinct().ToList(),
                    RouteSegmentElementIds = segmentIds,
                    RouteStartElementIds = segmentIds.Count > 0 ? new List<long> { segmentIds[0] } : new List<long>(),
                    RouteEndElementIds = segmentIds.Count > 0 ? new List<long> { segmentIds[segmentIds.Count - 1] } : new List<long>()
                };
            }
            if (path == "/revit/place-families")
                return new OperationOutput { CreatedElementIds = ReadLongArray(response, "elementIds") };
            if (path == "/revit/place-family-instance-on-host")
            {
                var id = ReadLong(response, "elementId");
                return new OperationOutput { CreatedElementIds = id > 0 ? new List<long> { id } : new List<long>() };
            }
            if (path == "/revit/draw-detail-curves")
                return new OperationOutput { CreatedElementIds = ReadLongArray(response, "detailCurveIds") };
            if (path == "/revit/tag-elements")
                return new OperationOutput { CreatedElementIds = ReadLongArray(response, "tagIds") };
            if (path == "/revit/create-pipe-between-connectors")
                return new OperationOutput { CreatedElementIds = ReadLongArray(response, "createdElementIds") };
            if (path == "/revit/connect-mep-branch")
            {
                var mainId = response.TryGetProperty("main", out var main) ? ReadLong(main, "id") : 0;
                var splitIds = ReadLongArray(response, "splitMainSegmentIds").Where(id => id != mainId);
                var branchIds = ReadLongArray(response, "createdBranchElementIds");
                var fittingIds = ReadLongArray(response, "createdFittingIds");
                return new OperationOutput
                {
                    CreatedElementIds = splitIds.Concat(branchIds).Concat(fittingIds).Distinct().ToList(),
                    RouteStartElementIds = branchIds.Count > 0 ? new List<long> { branchIds[0] } : new List<long>(),
                    RouteEndElementIds = branchIds.Count > 0 ? new List<long> { branchIds[branchIds.Count - 1] } : new List<long>(),
                    SplitMainStartElementIds = ReadLong(response, "splitMainStartSegmentId") is var startId && startId > 0
                        ? new List<long> { startId }
                        : new List<long>(),
                    SplitMainEndElementIds = ReadLong(response, "splitMainEndSegmentId") is var endId && endId > 0
                        ? new List<long> { endId }
                        : new List<long>()
                };
            }
            if (path == "/revit/assign-electrical-circuit")
            {
                var systemId = ReadLong(response, "createdElectricalSystemId");
                return new OperationOutput { CreatedElementIds = systemId > 0 ? new List<long> { systemId } : new List<long>() };
            }
            return new OperationOutput();
        }

        private static bool ResponseFailed(string rawPath, JsonElement response, JsonElement? applyBody, DeferredBody? deferred, out string reason)
        {
            reason = "";
            if (response.ValueKind != JsonValueKind.Object)
            {
                reason = "response_not_object";
                return true;
            }
            var error = ReadString(response, "error");
            if (!string.IsNullOrWhiteSpace(error))
            {
                reason = error;
                return true;
            }
            var status = ReadString(response, "status");
            if (status.IndexOf("block", StringComparison.OrdinalIgnoreCase) >= 0
                || status.IndexOf("fail", StringComparison.OrdinalIgnoreCase) >= 0
                || status.IndexOf("error", StringComparison.OrdinalIgnoreCase) >= 0
                || status.IndexOf("invalid", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                reason = status;
                return true;
            }
            if (response.TryGetProperty("failedCount", out var failedCount)
                && failedCount.ValueKind == JsonValueKind.Number
                && failedCount.TryGetInt32(out var failures)
                && failures > 0)
            {
                reason = $"failedCount={failures}";
                return true;
            }
            if (NormalizePath(rawPath) == "/revit/tag-elements")
            {
                var errorCount = ReadLong(response, "errorCount");
                var taggedCount = ReadLong(response, "taggedCount");
                if (errorCount > 0 || taggedCount != 1)
                {
                    reason = $"tag_elements_incomplete:tagged={taggedCount}:errors={errorCount}";
                    return true;
                }
                if (!ExactTagTypeReadbackMatches(response, applyBody, out reason))
                    return true;
            }
            if (response.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
            {
                foreach (var result in results.EnumerateArray())
                {
                    if (result.ValueKind == JsonValueKind.Object
                        && result.TryGetProperty("ok", out var ok)
                        && ok.ValueKind == JsonValueKind.False)
                    {
                        reason = "result_ok_false";
                        return true;
                    }
                }
            }
            if (NormalizePath(rawPath) == "/revit/audit-plumbing-fixture-services" && deferred?.require_downstream_vent == true)
            {
                var requiredFixtureIds = (deferred.fixture_element_ids ?? new List<long>()).Where(id => id > 0).Distinct().ToList();
                if (requiredFixtureIds.Count == 0)
                {
                    reason = "downstream_vent_verification_fixture_ids_missing";
                    return true;
                }
                if (!response.TryGetProperty("fixtures", out var fixtures) || fixtures.ValueKind != JsonValueKind.Array)
                {
                    reason = "downstream_vent_verification_fixtures_missing";
                    return true;
                }
                foreach (var fixtureId in requiredFixtureIds)
                {
                    var fixture = fixtures.EnumerateArray().FirstOrDefault(item => ReadLong(item, "elementId") == fixtureId);
                    if (fixture.ValueKind != JsonValueKind.Object
                        || !fixture.TryGetProperty("connectors", out var connectors)
                        || connectors.ValueKind != JsonValueKind.Array)
                    {
                        reason = $"downstream_vent_fixture_missing:{fixtureId}";
                        return true;
                    }
                    var verified = connectors.EnumerateArray().Any(connector =>
                    {
                        if (!string.Equals(ReadString(connector, "pipeSystemType"), "Sanitary", StringComparison.OrdinalIgnoreCase)) return false;
                        if (!connector.TryGetProperty("ventContinuation", out var continuation) || continuation.ValueKind != JsonValueKind.Object) return false;
                        return continuation.TryGetProperty("found", out var found) && found.ValueKind == JsonValueKind.True
                            && continuation.TryGetProperty("complete", out var complete) && complete.ValueKind == JsonValueKind.True
                            && continuation.TryGetProperty("truncated", out var truncated) && truncated.ValueKind == JsonValueKind.False;
                    });
                    if (!verified)
                    {
                        reason = $"downstream_vent_not_verified:{fixtureId}";
                        return true;
                    }
                }
            }
            return false;
        }

        private static bool ExactTagTypeReadbackMatches(JsonElement response, JsonElement? applyBody, out string reason)
        {
            reason = "";
            if (!applyBody.HasValue || applyBody.Value.ValueKind != JsonValueKind.Object)
            {
                reason = "tag_elements_request_missing";
                return false;
            }

            var expectedFamily = ReadString(applyBody.Value, "tagFamilyName");
            var expectedType = ReadString(applyBody.Value, "tagTypeName");
            if (string.IsNullOrWhiteSpace(expectedFamily) || string.IsNullOrWhiteSpace(expectedType))
            {
                reason = "tag_elements_exact_type_required";
                return false;
            }
            if (!response.TryGetProperty("tags", out var tags) || tags.ValueKind != JsonValueKind.Array || tags.GetArrayLength() != 1)
            {
                reason = "tag_elements_readback_missing";
                return false;
            }

            var tag = tags.EnumerateArray().First();
            var actualFamily = ReadString(tag, "tagFamilyName");
            var actualType = ReadString(tag, "tagTypeName");
            if (!string.Equals(actualFamily, expectedFamily, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(actualType, expectedType, StringComparison.OrdinalIgnoreCase))
            {
                reason = $"tag_elements_type_mismatch:expected={expectedFamily}:{expectedType}:actual={actualFamily}:{actualType}";
                return false;
            }
            return true;
        }

        private static List<long> ReadLongArray(JsonElement node, string propertyName)
        {
            if (node.ValueKind != JsonValueKind.Object
                || !node.TryGetProperty(propertyName, out var value)
                || value.ValueKind != JsonValueKind.Array) return new List<long>();
            return value.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out _))
                .Select(item => item.GetInt64())
                .Where(id => id > 0)
                .Distinct()
                .ToList();
        }

        private static long ReadLong(JsonElement node, string propertyName)
        {
            if (node.ValueKind == JsonValueKind.Object
                && node.TryGetProperty(propertyName, out var value)
                && value.ValueKind == JsonValueKind.Number
                && value.TryGetInt64(out var result)) return result;
            return 0;
        }

        private static string ReadString(JsonElement node, string propertyName)
        {
            if (node.ValueKind == JsonValueKind.Object
                && node.TryGetProperty(propertyName, out var value)
                && value.ValueKind == JsonValueKind.String) return value.GetString() ?? "";
            return "";
        }

        private static string NormalizePath(string value)
        {
            var result = Clean(value).ToLowerInvariant();
            return result.StartsWith("/") ? result : "/" + result;
        }

        private static string Clean(string? value) => (value ?? "").Trim();
    }
}

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
        }

        private sealed class OperationOutput
        {
            public List<long> CreatedElementIds { get; set; } = new List<long>();
            public List<long> RouteStartElementIds { get; set; } = new List<long>();
            public List<long> RouteEndElementIds { get; set; } = new List<long>();
        }

        private sealed class OperationReceipt
        {
            public string ActionKey { get; set; } = "";
            public string Path { get; set; } = "";
            public List<long> ElementIds { get; set; } = new List<long>();
            public object Response { get; set; } = new object();
        }

        public sealed class DeferredBody
        {
            public ElementReference? source_element { get; set; }
            public List<ElementReference>? target_elements { get; set; }
            public List<ElementReference>? element_ids { get; set; }
            public long? source_element_id { get; set; }
            public long? target_element_id { get; set; }
            public int? required_connection_count { get; set; }
            public List<long>? fixture_element_ids { get; set; }
            public bool? require_downstream_vent { get; set; }
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
            public List<Operation> operations { get; set; } = new List<Operation>();
            public bool dryRun { get; set; } = true;
            public bool verify { get; set; } = true;
            public int maximumCreatedElements { get; set; } = 100;
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

            var keys = p.operations.Select(operation => Clean(operation.action_key)).ToList();
            if (keys.Any(string.IsNullOrWhiteSpace) || keys.Distinct(StringComparer.OrdinalIgnoreCase).Count() != keys.Count)
                throw new InvalidOperationException("operation_action_keys_must_be_unique_and_nonempty");
            var knownKeys = new HashSet<string>(keys, StringComparer.OrdinalIgnoreCase);
            foreach (var operation in p.operations)
            {
                foreach (var dependency in operation.depends_on ?? new List<string>())
                {
                    if (!knownKeys.Contains(Clean(dependency)))
                        throw new InvalidOperationException($"unknown_operation_dependency:{operation.action_key}:{dependency}");
                }
            }

            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var outputs = new Dictionary<string, OperationOutput>(StringComparer.OrdinalIgnoreCase);
            var receipts = new List<OperationReceipt>();
            var allCreatedIds = new HashSet<long>();
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

                        var requestJson = BuildRequest(operation, outputs, p.verify);
                        var handler = ResolveHandler(operation.path);
                        var response = handler.Handle(app, requestJson).GetAwaiter().GetResult();
                        using var responseDocument = JsonDocument.Parse(JsonSerializer.Serialize(response));
                        var responseJson = responseDocument.RootElement.Clone();
                        if (ResponseFailed(operation.path, responseJson, operation.deferred_body, out var failure))
                            throw new InvalidOperationException($"operation_failed:{operation.action_key}:{failure}");
                        var output = ExtractOperationOutput(operation.path, responseJson);
                        var createdIds = output.CreatedElementIds;
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
                            Response = response
                        });
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
                status = string.IsNullOrWhiteSpace(workflowFailure) ? (p.dryRun ? "DryRunReady" : "Applied") : "Blocked",
                dryRun = p.dryRun,
                transactionGroupRolledBack,
                rollbackVerified,
                residualCreatedElementIds = residualCreatedIds,
                atomic = rollbackVerified,
                error = workflowFailure,
                operationCount = receipts.Count,
                createdElementIds = transactionGroupRolledBack
                    ? new List<long>()
                    : allCreatedIds.OrderBy(id => id).ToList(),
                transientCreatedElementIds = transactionGroupRolledBack
                    ? allCreatedIds.OrderBy(id => id).ToList()
                    : new List<long>(),
                operations = receipts.Select(receipt => new
                {
                    actionKey = receipt.ActionKey,
                    path = receipt.Path,
                    createdElementIds = transactionGroupRolledBack ? new List<long>() : receipt.ElementIds,
                    transientCreatedElementIds = transactionGroupRolledBack ? receipt.ElementIds : new List<long>(),
                    response = receipt.Response
                }).ToList()
            });
        }

        private static string BuildRequest(
            Operation operation,
            IReadOnlyDictionary<string, OperationOutput> outputs,
            bool verify)
        {
            var path = NormalizePath(operation.path);
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
                var elementIds = ResolveReferences(deferred.element_ids, outputs, operation.action_key, "element_ids");
                if (elementIds.Count == 0)
                    throw new InvalidOperationException($"electrical_member_references_resolved_empty:{operation.action_key}");
                if (!deferred.source_element_id.HasValue || deferred.source_element_id.Value <= 0)
                    throw new InvalidOperationException($"source_element_id_required:{operation.action_key}");
                return JsonSerializer.Serialize(new
                {
                    elementIds,
                    sourceElementId = deferred.source_element_id.Value,
                    dryRun = false,
                    confirm = true,
                    parameterOnlyFallback = false
                });
            }
            if (path == "/revit/create-pipe-between-connectors")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var sourceIds = ResolveReference(deferred.source_element, outputs, operation.action_key, "source_element");
                if (sourceIds.Count != 1)
                    throw new InvalidOperationException($"source_element_reference_must_resolve_one_id:{operation.action_key}:found={sourceIds.Count}");
                if (!deferred.target_element_id.HasValue || deferred.target_element_id.Value <= 0)
                    throw new InvalidOperationException($"target_element_id_required:{operation.action_key}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var bridgeBody = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                    ?? new Dictionary<string, object>();
                bridgeBody["sourceElementId"] = sourceIds[0];
                bridgeBody["targetElementId"] = deferred.target_element_id.Value;
                bridgeBody["dryRun"] = false;
                bridgeBody["verify"] = verify;
                return JsonSerializer.Serialize(bridgeBody);
            }
            if (path == "/revit/audit-plumbing-fixture-services")
            {
                var deferred = operation.deferred_body ?? throw new InvalidOperationException($"deferred_body_required:{operation.action_key}");
                var fixtureIds = (deferred.fixture_element_ids ?? new List<long>()).Where(id => id > 0).Distinct().ToList();
                if (fixtureIds.Count == 0)
                    throw new InvalidOperationException($"fixture_element_ids_required:{operation.action_key}");
                if (!operation.apply_body.HasValue || operation.apply_body.Value.ValueKind != JsonValueKind.Object)
                    throw new InvalidOperationException($"apply_body_required:{operation.action_key}");
                var auditBody = JsonSerializer.Deserialize<Dictionary<string, object>>(operation.apply_body.Value.GetRawText())
                    ?? new Dictionary<string, object>();
                auditBody["fixtureElementIds"] = fixtureIds;
                return JsonSerializer.Serialize(auditBody);
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
                case "route_start": return output.RouteStartElementIds.Distinct().ToList();
                case "route_end": return output.RouteEndElementIds.Distinct().ToList();
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
                    RouteEndElementIds = branchIds.Count > 0 ? new List<long> { branchIds[branchIds.Count - 1] } : new List<long>()
                };
            }
            return new OperationOutput();
        }

        private static bool ResponseFailed(string rawPath, JsonElement response, DeferredBody? deferred, out string reason)
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

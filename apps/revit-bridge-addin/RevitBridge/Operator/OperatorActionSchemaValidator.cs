using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using RevitBridge.Common;

namespace RevitBridge.Operator
{
    internal static class OperatorActionSchemaValidator
    {
        public static void ValidateOrThrow(OperatorActionCall action)
        {
            if (!TryValidate(action, out var error, out var userError))
            {
                if (userError != null) throw userError;
                throw new InvalidOperationException(error ?? "Invalid action body.");
            }
        }

        private static bool TryValidate(OperatorActionCall action, out string? error, out Exception? userError)
        {
            error = null;
            userError = null;
            var method = (action.Method ?? "").Trim().ToUpperInvariant();
            var path = (action.Path ?? "").Trim();

            JsonElement? body = ToJsonElement(action.Body);

            if (method == "GET")
            {
                if (body.HasValue && body.Value.ValueKind != JsonValueKind.Null)
                {
                    error = "GET actions must not include a body.";
                    return false;
                }
                return true;
            }

            if (method != "POST")
            {
                error = $"Unsupported method: {method}";
                return false;
            }

            if (string.Equals(path, "/ui/open", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "ui.open body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "url", maxLen: 2048, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "title", maxLen: 200, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "width", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "height", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "allowedMessageTypes", maxCount: 64, maxLen: 120, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "allowedBackendPaths", maxCount: 64, maxLen: 240, out error)) return false;

                if (obj.Value.TryGetProperty("allowedActions", out var actions) && actions.ValueKind != JsonValueKind.Null)
                {
                    if (actions.ValueKind != JsonValueKind.Array)
                    {
                        error = "allowedActions must be an array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var item in actions.EnumerateArray())
                    {
                        count++;
                        if (count > 64)
                        {
                            error = "allowedActions too large.";
                            return false;
                        }

                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "allowedActions items must be objects.";
                            return false;
                        }

                        if (!ValidateRequiredString(item, "method", maxLen: 8, out error)) return false;
                        if (!ValidateRequiredString(item, "path", maxLen: 240, out error)) return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/ui/close", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "ui.close body must be an object.";
                    return false;
                }

                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "target", maxLen: 16, out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/import-zippybim-geometry", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "import-zippybim-geometry body must be an object.";
                    return false;
                }

                var raw = obj.Value.GetRawText();
                if (raw.Length > 15_000_000)
                {
                    error = "import-zippybim-geometry body is too large.";
                    return false;
                }

                if (ContainsBannedPathOverride(obj.Value, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourcePath", maxLen: 512, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "levelId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "importWalls", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "importVectorUnderlay", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "disableWallJoins", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "importDoors", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (!obj.Value.TryGetProperty("geometry", out var geom) || geom.ValueKind != JsonValueKind.Object)
                {
                    error = "import-zippybim-geometry.geometry must be an object.";
                    return false;
                }

                if (!geom.TryGetProperty("elements", out var elements) || elements.ValueKind != JsonValueKind.Array)
                {
                    error = "import-zippybim-geometry.geometry.elements must be an array.";
                    return false;
                }

                var count = 0;
                foreach (var item in elements.EnumerateArray())
                {
                    count++;
                    if (count > 25000)
                    {
                        error = "import-zippybim-geometry.geometry.elements is too large.";
                        return false;
                    }

                    if (item.ValueKind != JsonValueKind.Object)
                    {
                        error = "import-zippybim-geometry.geometry.elements items must be objects.";
                        return false;
                    }

                    if (!ValidateRequiredString(item, "element", maxLen: 32, out error)) return false;
                }

                return true;
            }

            // Generic guards for all POST bodies.
            if (body.HasValue && body.Value.ValueKind == JsonValueKind.Object)
            {
                var raw = body.Value.GetRawText();
                if (raw.Length > 120_000)
                {
                    error = "Action body is too large.";
                    return false;
                }

                if (ContainsBannedPathOverride(body.Value, out error)) return false;
            }

            if (string.Equals(path, "/revit/export-image", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewId?: number, imageSize?: number }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-image body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (obj.Value.TryGetProperty("folder", out _))
                    {
                        error = "export-image: overriding output folder is not allowed.";
                        return false;
                    }
                    if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/capture-screenshare", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { includeContext?: bool }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "capture-screenshare body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalBool(obj.Value, "includeContext", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/batch-job", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "batch-job body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "job_type", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "title", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "task_prompt", maxLen: 4000, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scope_description", maxLen: 2000, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "work_item_hint", maxLen: 800, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "success_checks", maxCount: 20, maxLen: 240, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "require_approval", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "preview_count", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max_items", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "per_item_max_rounds", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/batch-control", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "batch-control body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "job_id", maxLen: 120, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "operation", maxLen: 32, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/tool-search", StringComparison.OrdinalIgnoreCase))
            {
                // { query, group?, risk?, method?, max? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "tool-search body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "query", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "group", maxLen: 80, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "risk", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "method", maxLen: 8, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/tool-doc", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/tool-examples", StringComparison.OrdinalIgnoreCase))
            {
                // { method, path }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = $"{path} body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "method", maxLen: 8, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "path", maxLen: 200, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/native-api-catalog", StringComparison.OrdinalIgnoreCase))
            {
                // { query?, namespacePrefix?, typeContains?, risk?, offset?, limit? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "native-api-catalog body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "query", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "namespacePrefix", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "typeContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "risk", maxLen: 16, out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "offset", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "limit", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/native-api-search", StringComparison.OrdinalIgnoreCase))
            {
                // { query, namespacePrefix?, risk?, max? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "native-api-search body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "query", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "namespacePrefix", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "risk", maxLen: 16, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/native-api-call", StringComparison.OrdinalIgnoreCase))
            {
                // { memberId, target?, args?:[], dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "native-api-call body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "memberId", maxLen: 400, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "target", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (obj.Value.TryGetProperty("args", out var argsEl) && argsEl.ValueKind != JsonValueKind.Null && argsEl.ValueKind != JsonValueKind.Array)
                {
                    error = "native-api-call.args must be an array.";
                    return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/native-api-policy", StringComparison.OrdinalIgnoreCase))
            {
                // { profile?, maxRisk?, allowMutating?, blockFreezeRisk?, maxResults?, maxInvocationParams? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "native-api-policy body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "profile", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "maxRisk", maxLen: 16, out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "allowMutating", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "blockFreezeRisk", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "maxResults", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "maxInvocationParams", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/self-test", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { include_export_image?: bool, include_rooms?: bool }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "self-test body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalBool(obj.Value, "include_export_image", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_rooms", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/state-snapshot", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { include_dialogs?, include_selection_details?, include_sheet_viewports?, include_all_views_index?, include_warnings_summary?, include_warnings_detail?, include_element_bboxes?, max_items? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "state-snapshot body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalBool(obj.Value, "include_dialogs", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_selection_details", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_sheet_viewports", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_all_views_index", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_warnings_summary", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_warnings_detail", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "include_element_bboxes", out error)) return false;

                    if (obj.Value.TryGetProperty("max_items", out var mi) && mi.ValueKind != JsonValueKind.Null)
                    {
                        if (mi.ValueKind != JsonValueKind.Number || !mi.TryGetInt32(out var mv))
                        {
                            error = "state-snapshot.max_items must be an integer.";
                            return false;
                        }
                        if (mv < 1 || mv > 500)
                        {
                            error = "state-snapshot.max_items out of range.";
                            return false;
                        }
                    }
                }
                return true;
            }
            if (string.Equals(path, "/revit/regenerate", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { refreshActiveView?: bool }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "regenerate body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalBool(obj.Value, "refreshActiveView", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/computer-use-observe", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "computer-use-observe body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalBool(obj.Value, "includeScreenshot", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "screenshotMaxSidePx", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "maxDialogs", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "onlyModal", out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "titleContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "dialogIdContains", maxLen: 200, out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/computer-use-act", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "computer-use-act body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "button", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "buttonText", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "buttonIndex", out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "interactionMode", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalComputerUseInteractionMode(obj.Value, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "cursorRestoreMode", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalComputerUseCursorRestoreMode(obj.Value, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "titleContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "dialogIdContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "includeScreenshotAfter", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "screenshotMaxSidePx", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "waitForDialogMs", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/computer-use-guard", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "computer-use-guard body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "button", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "buttonText", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "buttonIndex", out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "interactionMode", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalComputerUseInteractionMode(obj.Value, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "cursorRestoreMode", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalComputerUseCursorRestoreMode(obj.Value, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "titleContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "dialogIdContains", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "messageContains", maxLen: 400, out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "maxTriggers", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "ttlMs", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "includeScreenshotAfter", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "screenshotMaxSidePx", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/open-model", StringComparison.OrdinalIgnoreCase))
            {
                // { filePath: string, audit?: bool, detach?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "open-model body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "filePath", maxLen: 512, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "audit", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "detach", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/save-as", StringComparison.OrdinalIgnoreCase))
            {
                // { filePath:string, overwrite?, compact?, maximumBackups?, saveAsCentral?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "save-as body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "filePath", maxLen: 512, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "overwrite", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "compact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "saveAsCentral", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("maximumBackups", out var mb) && mb.ValueKind != JsonValueKind.Null)
                {
                    if (mb.ValueKind != JsonValueKind.Number || !mb.TryGetInt32(out var v))
                    {
                        error = "save-as.maximumBackups must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 20)
                    {
                        error = "save-as.maximumBackups out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/sync", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { comment?: string, compact?: bool }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "sync body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "comment", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "compact", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/worksets", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "list"|"create"|"set_active", name?, worksetId?, worksetName?, activateAfterCreate?, max?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "worksets body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 24, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "worksetId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "worksetName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "activateAfterCreate", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var actionName = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (actionName == "setactive") actionName = "set_active";
                }

                if (actionName != "list" && actionName != "create" && actionName != "set_active")
                {
                    error = "worksets.action must be 'list', 'create', or 'set_active'.";
                    return false;
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "worksets.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "worksets.max out of range.";
                        return false;
                    }
                }

                if (actionName == "create")
                {
                    if (!obj.Value.TryGetProperty("name", out var nameEl) ||
                        nameEl.ValueKind != JsonValueKind.String ||
                        string.IsNullOrWhiteSpace(nameEl.GetString()))
                    {
                        error = "worksets.create requires non-empty name.";
                        return false;
                    }
                }

                if (actionName == "set_active")
                {
                    var hasId = obj.Value.TryGetProperty("worksetId", out var idEl) && idEl.ValueKind != JsonValueKind.Null;
                    var hasName = obj.Value.TryGetProperty("worksetName", out var wsNameEl) &&
                                  wsNameEl.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrWhiteSpace(wsNameEl.GetString());
                    if (!hasId && !hasName)
                    {
                        error = "worksets.set_active requires worksetId or worksetName.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/project-parameters", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "list"|"create"|"validate_required", name?, categoryNames?, instanceBinding?, parameterGroup?, dataType?, visible?, userModifiable?, rebindIfExists?, query?, max?, dryRun?, requiredParameters?, requiredParameterNames? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "project-parameters body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 24, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categoryNames", maxCount: 200, maxLen: 120, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "instanceBinding", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterGroup", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "dataType", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "visible", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "userModifiable", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "rebindIfExists", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 120, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "requiredParameters", maxCount: 200, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "requiredParameterNames", maxCount: 200, maxLen: 128, out error)) return false;

                var actionName = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                }

                if (actionName != "list" && actionName != "create" && actionName != "validate_required")
                {
                    error = "project-parameters.action must be 'list', 'create', or 'validate_required'.";
                    return false;
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "project-parameters.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "project-parameters.max out of range.";
                        return false;
                    }
                }

                if (actionName == "create")
                {
                    if (!obj.Value.TryGetProperty("name", out var nameEl) ||
                        nameEl.ValueKind != JsonValueKind.String ||
                        string.IsNullOrWhiteSpace(nameEl.GetString()))
                    {
                        error = "project-parameters.create requires non-empty name.";
                        return false;
                    }

                    if (!obj.Value.TryGetProperty("categoryNames", out var catEl) || catEl.ValueKind != JsonValueKind.Array)
                    {
                        error = "project-parameters.create requires categoryNames array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var x in catEl.EnumerateArray())
                    {
                        count++;
                        if (count > 200)
                        {
                            error = "project-parameters.categoryNames too large.";
                            return false;
                        }
                        if (x.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(x.GetString()))
                        {
                            error = "project-parameters.categoryNames must contain non-empty strings.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("dataType", out var dt) && dt.ValueKind == JsonValueKind.String)
                    {
                        var t = (dt.GetString() ?? "").Trim().ToLowerInvariant();
                        if (t == "yes_no" || t == "yes/no") t = "yesno";
                        if (t == "multiline" || t == "multilinetext") t = "multiline_text";

                        if (t != "text" && t != "yesno" && t != "integer" && t != "number" && t != "url" && t != "multiline_text")
                        {
                            error = "project-parameters.dataType must be text|yesno|integer|number|url|multiline_text.";
                            return false;
                        }
                    }
                }

                if (actionName == "validate_required")
                {
                    var hasCategoryNames = obj.Value.TryGetProperty("categoryNames", out var catEl) &&
                                           catEl.ValueKind == JsonValueKind.Array &&
                                           catEl.GetArrayLength() > 0;
                    if (!hasCategoryNames)
                    {
                        error = "project-parameters.validate_required requires categoryNames array.";
                        return false;
                    }

                    var hasRequiredParameters = obj.Value.TryGetProperty("requiredParameters", out var req) &&
                                                req.ValueKind == JsonValueKind.Array &&
                                                req.GetArrayLength() > 0;
                    var hasRequiredAliases = obj.Value.TryGetProperty("requiredParameterNames", out var reqAlias) &&
                                             reqAlias.ValueKind == JsonValueKind.Array &&
                                             reqAlias.GetArrayLength() > 0;
                    if (!hasRequiredParameters && !hasRequiredAliases)
                    {
                        error = "project-parameters.validate_required requires requiredParameters (or requiredParameterNames).";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/purge-unused", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "analyze"|"purge", maxPreview?, maxDelete?, dryRun?, apply?, confirm? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "purge-unused body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 24, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;

                if (obj.Value.TryGetProperty("maxPreview", out var mp) && mp.ValueKind != JsonValueKind.Null)
                {
                    if (mp.ValueKind != JsonValueKind.Number || !mp.TryGetInt32(out var v))
                    {
                        error = "purge-unused.maxPreview must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 1000)
                    {
                        error = "purge-unused.maxPreview out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxDelete", out var md) && md.ValueKind != JsonValueKind.Null)
                {
                    if (md.ValueKind != JsonValueKind.Number || !md.TryGetInt32(out var v))
                    {
                        error = "purge-unused.maxDelete must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 20000)
                    {
                        error = "purge-unused.maxDelete out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    // Accept common compatibility forms and coerce in handler:
                    // string, boolean (true=>yes), or numeric.
                    if (confirm.ValueKind != JsonValueKind.String &&
                        confirm.ValueKind != JsonValueKind.True &&
                        confirm.ValueKind != JsonValueKind.False &&
                        confirm.ValueKind != JsonValueKind.Number)
                    {
                        error = "purge-unused.confirm must be a string, boolean, or number.";
                        return false;
                    }
                    var s = confirm.ValueKind == JsonValueKind.String
                        ? BulkConfirmUtil.Normalize(confirm.GetString())
                        : (confirm.ValueKind == JsonValueKind.True ? "yes" : (confirm.ValueKind == JsonValueKind.False ? "" : BulkConfirmUtil.Normalize(confirm.GetRawText())));
                    if (s.Length > 80)
                    {
                        error = "purge-unused.confirm is too long.";
                        return false;
                    }
                }

                var actionName = "analyze";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (actionName == "list") actionName = "analyze";
                }

                if (actionName != "analyze" && actionName != "purge")
                {
                    error = "purge-unused.action must be 'analyze' or 'purge'.";
                    return false;
                }

                // Purge requires explicit apply=true (otherwise dry-run).
                if (actionName == "purge")
                {
                    var apply = obj.Value.TryGetProperty("apply", out var applyEl) &&
                                (applyEl.ValueKind == JsonValueKind.True || applyEl.ValueKind == JsonValueKind.False) &&
                                applyEl.GetBoolean();
                    var dryRun = obj.Value.TryGetProperty("dryRun", out var dr) &&
                                 (dr.ValueKind == JsonValueKind.True || dr.ValueKind == JsonValueKind.False) &&
                                 dr.GetBoolean();

                    if (apply && !dryRun && obj.Value.TryGetProperty("maxDelete", out var mx) && mx.ValueKind == JsonValueKind.Number && mx.TryGetInt32(out var count) && count > 25)
                    {
                        var expected = BulkConfirmUtil.ExpectedDeleteElements(count);
                        var gotRaw = obj.Value.TryGetProperty("confirm", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "") : "";
                        if (!BulkConfirmUtil.EqualsNormalized(gotRaw, expected))
                        {
                            var gotNorm = BulkConfirmUtil.Normalize(gotRaw);
                            userError = new OperatorToolUserErrorException(
                                message: "Bulk purge requires typed confirmation.",
                                code: "bulk_confirm_required",
                                requiredConfirm: expected,
                                confirmReceived: gotNorm,
                                maxChangesPerCall: 10,
                                hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                            error = userError.Message;
                            return false;
                        }
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/transfer-view-templates", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "list_source"|"import", sourcePath, templateNames?, exact?, include3D?, includeSchedules?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "transfer-view-templates body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 24, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 512, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "templateNames", maxCount: 500, maxLen: 180, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "include3D", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSchedules", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    var actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (actionName == "list") actionName = "list_source";
                    if (actionName != "list_source" && actionName != "import")
                    {
                        error = "transfer-view-templates.action must be 'list_source' or 'import'.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/export-view-frame", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewId?: number, imageSize?: number, includeMapping?: boolean }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-view-frame body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (obj.Value.TryGetProperty("folder", out _))
                    {
                        error = "export-view-frame: overriding output folder is not allowed.";
                        return false;
                    }
                    if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "includeMapping", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/export-view-region", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: { viewId?: number, imageMaxSizePx?: number, imageSize?: number, includeMapping?: boolean, fileName?: string, region: {...} }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "export-view-region body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "imageMaxSizePx", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeMapping", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fileName", maxLen: 180, out error)) return false;

                if (!obj.Value.TryGetProperty("region", out var region) || region.ValueKind == JsonValueKind.Null)
                {
                    error = "export-view-region.region is required.";
                    return false;
                }
                if (region.ValueKind != JsonValueKind.Object)
                {
                    error = "export-view-region.region must be an object.";
                    return false;
                }

                if (!region.TryGetProperty("mode", out var modeProp) || modeProp.ValueKind != JsonValueKind.String)
                {
                    error = "export-view-region.region.mode must be a string.";
                    return false;
                }
                var mode = (modeProp.GetString() ?? "").Trim();
                if (mode.Equals("focusElements", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredLongArray(region, "focusElementIds", maxCount: 200, out error)) return false;
                    if (region.TryGetProperty("marginFt", out var mf) && mf.ValueKind != JsonValueKind.Null)
                    {
                        if (mf.ValueKind != JsonValueKind.Number || !mf.TryGetDouble(out _))
                        {
                            error = "export-view-region.region.marginFt must be a number.";
                            return false;
                        }
                    }
                    return true;
                }
                if (mode.Equals("center", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredNumber(region, "centerX", out error)) return false;
                    if (!ValidateRequiredNumber(region, "centerY", out error)) return false;
                    if (!ValidateRequiredNumber(region, "halfWidth", out error)) return false;
                    if (!ValidateRequiredNumber(region, "halfHeight", out error)) return false;
                    return true;
                }

                error = "export-view-region.region.mode must be 'focusElements' or 'center'.";
                return false;
            }

            if (string.Equals(path, "/revit/export-visible-elements", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewId?:number, imageSize?:number, includeMapping?:bool, categories?:string[], excludeCategories?:string[], includeGeometry?:bool, limit?:int }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-visible-elements body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (obj.Value.TryGetProperty("folder", out _))
                    {
                        error = "export-visible-elements: overriding output folder is not allowed.";
                        return false;
                    }
                    if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                    if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "includeMapping", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "includeGeometry", out error)) return false;
                    if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                    if (!ValidateOptionalStringArray(obj.Value, "excludeCategories", maxCount: 100, maxLen: 96, out error)) return false;

                    if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                    {
                        if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                        {
                            error = "export-visible-elements.limit must be an integer.";
                            return false;
                        }
                        if (v < 1 || v > 2000)
                        {
                            error = "export-visible-elements.limit out of range.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/highlight-and-export", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: { elementIds?: number[], highlightGroups?: [{elementIds:[...],overrideStyle?:{...}}], labels?:[{text,pointXyz:[x,y,z]}], imageSize?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "highlight-and-export body must be an object.";
                    return false;
                }
                if (obj.Value.TryGetProperty("folder", out _))
                {
                    error = "highlight-and-export: overriding output folder is not allowed.";
                    return false;
                }

                var hasGroups = obj.Value.TryGetProperty("highlightGroups", out var groups) && groups.ValueKind != JsonValueKind.Null;
                if (hasGroups)
                {
                    if (groups.ValueKind != JsonValueKind.Array)
                    {
                        error = "highlight-and-export.highlightGroups must be an array.";
                        return false;
                    }
                    var groupCount = 0;
                    foreach (var g in groups.EnumerateArray())
                    {
                        groupCount++;
                        if (groupCount > 10)
                        {
                            error = "highlight-and-export.highlightGroups too large.";
                            return false;
                        }
                        if (g.ValueKind != JsonValueKind.Object)
                        {
                            error = "highlight-and-export.highlightGroups items must be objects.";
                            return false;
                        }
                        if (!ValidateRequiredLongArray(g, "elementIds", maxCount: 200, out error)) return false;
                        if (g.TryGetProperty("overrideStyle", out var os) && os.ValueKind != JsonValueKind.Null)
                        {
                            if (os.ValueKind != JsonValueKind.Object)
                            {
                                error = "highlight-and-export.highlightGroups.overrideStyle must be an object.";
                                return false;
                            }
                            if (!ValidateOptionalInt(os, "lineWeight", out error)) return false;
                            if (!ValidateOptionalInt(os, "r", out error)) return false;
                            if (!ValidateOptionalInt(os, "g", out error)) return false;
                            if (!ValidateOptionalInt(os, "b", out error)) return false;
                        }
                    }
                }
                else
                {
                    if (!ValidateRequiredLongArray(obj.Value, "elementIds", maxCount: 200, out error)) return false;
                }

                if (obj.Value.TryGetProperty("labels", out var labels) && labels.ValueKind != JsonValueKind.Null)
                {
                    if (labels.ValueKind != JsonValueKind.Array)
                    {
                        error = "highlight-and-export.labels must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var l in labels.EnumerateArray())
                    {
                        count++;
                        if (count > 30)
                        {
                            error = "highlight-and-export.labels too large.";
                            return false;
                        }
                        if (l.ValueKind != JsonValueKind.Object)
                        {
                            error = "highlight-and-export.labels items must be objects.";
                            return false;
                        }
                        if (!ValidateRequiredString(l, "text", maxLen: 200, out error)) return false;
                        if (!l.TryGetProperty("pointXyz", out var pt) || pt.ValueKind != JsonValueKind.Array)
                        {
                            error = "highlight-and-export.labels.pointXyz must be an array.";
                            return false;
                        }
                        var n = 0;
                        foreach (var v in pt.EnumerateArray())
                        {
                            n++;
                            if (n > 3) break;
                            if (v.ValueKind != JsonValueKind.Number || !v.TryGetDouble(out _))
                            {
                                error = "highlight-and-export.labels.pointXyz must be numeric.";
                                return false;
                            }
                        }
                        if (n < 3)
                        {
                            error = "highlight-and-export.labels.pointXyz must have 3 numbers.";
                            return false;
                        }
                    }
                }

                if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/pick-at-pixel", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: { frameId: string, xPx: number, yPx: number, includeCategories?: string[], excludeCategories?: string[], prefer?: string, maxHits?: number, ...legacy }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "pick-at-pixel body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "frameId", maxLen: 128, out error)) return false;
                if (!ValidateRequiredInt(obj.Value, "xPx", out error)) return false;
                if (!ValidateRequiredInt(obj.Value, "yPx", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxCandidates", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxHits", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "searchRadiusModel", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeLinked", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "preferViewLevel", out error)) return false;

                if (!ValidateOptionalString(obj.Value, "prefer", maxLen: 32, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 50, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeCategories", maxCount: 50, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "excludeCategories", maxCount: 50, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "preferCategories", maxCount: 50, maxLen: 96, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/activate-view", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: { viewId:number } with compatibility aliases { targetViewId?|sheetId?|id? } and query-based resolution.
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "activate-view body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "targetViewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "id", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewType", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;

                var hasTarget =
                    (obj.Value.TryGetProperty("viewId", out var viewIdEl) && viewIdEl.ValueKind != JsonValueKind.Null) ||
                    (obj.Value.TryGetProperty("targetViewId", out var targetEl) && targetEl.ValueKind != JsonValueKind.Null) ||
                    (obj.Value.TryGetProperty("sheetId", out var sheetEl) && sheetEl.ValueKind != JsonValueKind.Null) ||
                    (obj.Value.TryGetProperty("id", out var idEl) && idEl.ValueKind != JsonValueKind.Null) ||
                    (obj.Value.TryGetProperty("viewName", out var nameEl) && nameEl.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(nameEl.GetString())) ||
                    (obj.Value.TryGetProperty("query", out var queryEl) && queryEl.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(queryEl.GetString()));

                if (!hasTarget)
                {
                    error = "activate-view requires viewId (aliases accepted: targetViewId, sheetId, id) or viewName/query.";
                    return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/rooms", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: { action:"list"|"detail", levelName?: string, roomIds?: number[], roomNumber?: string, max?: number, viewId?: number, includeBoundaryElementIds?: bool, spatialKindPreference?:"auto"|"room"|"space" }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "rooms body must be an object.";
                    return false;
                }
                if (!obj.Value.TryGetProperty("action", out var act) || act.ValueKind != JsonValueKind.String)
                {
                    error = "rooms.action must be a string.";
                    return false;
                }
                var a = (act.GetString() ?? "").Trim().ToLowerInvariant();
                if (a != "list" && a != "detail")
                {
                    error = "rooms.action must be 'list' or 'detail'.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "roomIds", maxCount: 500, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeBoundaryElementIds", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "spatialKindPreference", maxLen: 32, out error)) return false;

                if (obj.Value.TryGetProperty("spatialKindPreference", out var sk) && sk.ValueKind == JsonValueKind.String)
                {
                    var spatialKind = (sk.GetString() ?? "").Trim().ToLowerInvariant();
                    if (spatialKind != "auto" && spatialKind != "room" && spatialKind != "space")
                    {
                        error = "rooms.spatialKindPreference must be 'auto', 'room', or 'space'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "rooms.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "rooms.max out of range.";
                        return false;
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/renumber-rooms", StringComparison.OrdinalIgnoreCase))
            {
                // { levelNameContains?, startNumber?, increment?, digits?, prefix?, suffix?, nameContains?, max?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "renumber-rooms body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "levelNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "startNumber", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "increment", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "digits", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "prefix", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "suffix", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "nameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("startNumber", out var startNumber) && startNumber.ValueKind != JsonValueKind.Null)
                {
                    if (startNumber.ValueKind != JsonValueKind.Number || !startNumber.TryGetInt32(out var n) || n < 0)
                    {
                        error = "renumber-rooms.startNumber must be an integer >= 0.";
                        return false;
                    }
                }
                if (obj.Value.TryGetProperty("increment", out var increment) && increment.ValueKind != JsonValueKind.Null)
                {
                    if (increment.ValueKind != JsonValueKind.Number || !increment.TryGetInt32(out var n) || n < 1)
                    {
                        error = "renumber-rooms.increment must be an integer >= 1.";
                        return false;
                    }
                }
                if (obj.Value.TryGetProperty("digits", out var digits) && digits.ValueKind != JsonValueKind.Null)
                {
                    if (digits.ValueKind != JsonValueKind.Number || !digits.TryGetInt32(out var n) || n < 1 || n > 12)
                    {
                        error = "renumber-rooms.digits must be an integer in range [1,12].";
                        return false;
                    }
                }
                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v) || v < 1 || v > 10000)
                    {
                        error = "renumber-rooms.max must be an integer in range [1,10000].";
                        return false;
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/find-duplicate-marks", StringComparison.OrdinalIgnoreCase))
            {
                // { categoryName?, parameterName?, viewId?, includeEmpty?, maxGroups? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "find-duplicate-marks body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEmpty", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxGroups", out error)) return false;

                if (obj.Value.TryGetProperty("maxGroups", out var mg) && mg.ValueKind != JsonValueKind.Null)
                {
                    if (mg.ValueKind != JsonValueKind.Number || !mg.TryGetInt32(out var v) || v < 1 || v > 5000)
                    {
                        error = "find-duplicate-marks.maxGroups must be an integer in range [1,5000].";
                        return false;
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/mep-workflows", StringComparison.OrdinalIgnoreCase))
            {
                // Consolidated HVAC workflow wrappers.
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "mep-workflows body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "sourceElementIds", maxCount: 20000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sourceCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 96, out error)) return false;

                if (!ValidateOptionalString(obj.Value, "name", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scheduleName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "levelId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "templateName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "tagUpdatedElements", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagTypeNameContains", maxLen: 160, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "onlyTagUntagged", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "addTagLeader", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "tagOffsetFeet", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "slopeParameterNames", maxCount: 20, maxLen: 128, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "minSlope", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "maxSlope", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "slopeTolerance", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "paddingFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "sectionWidthFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "sectionHeightFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "sectionDepthFeet", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxSections", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "symbolName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "startOffsetFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "endOffsetFeet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "idempotencyToleranceFeet", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sourceViewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "startElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "endElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "equipmentElementId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "terminalElementIds", maxCount: 20000, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "equipmentElementIds", maxCount: 20000, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ductTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ductSize", maxLen: 64, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxBranches", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElbowsPerBranch", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "maxLengthFeet", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "createSpaceTags", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "annotateEquipment", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "x", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "y", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "z", out error)) return false;

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "mep-workflows.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 50000)
                    {
                        error = "mep-workflows.max out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxSections", out var ms) && ms.ValueKind != JsonValueKind.Null)
                {
                    if (ms.ValueKind != JsonValueKind.Number || !ms.TryGetInt32(out var v))
                    {
                        error = "mep-workflows.maxSections must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 200)
                    {
                        error = "mep-workflows.maxSections out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxBranches", out var mb) && mb.ValueKind != JsonValueKind.Null)
                {
                    if (mb.ValueKind != JsonValueKind.Number || !mb.TryGetInt32(out var v))
                    {
                        error = "mep-workflows.maxBranches must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "mep-workflows.maxBranches out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxElbowsPerBranch", out var me) && me.ValueKind != JsonValueKind.Null)
                {
                    if (me.ValueKind != JsonValueKind.Number || !me.TryGetInt32(out var v))
                    {
                        error = "mep-workflows.maxElbowsPerBranch must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 20)
                    {
                        error = "mep-workflows.maxElbowsPerBranch out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("parameterWrites", out var writesEl) && writesEl.ValueKind != JsonValueKind.Null)
                {
                    if (writesEl.ValueKind != JsonValueKind.Array)
                    {
                        error = "mep-workflows.parameterWrites must be an array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var item in writesEl.EnumerateArray())
                    {
                        count++;
                        if (count > 200)
                        {
                            error = "mep-workflows.parameterWrites supports at most 200 entries.";
                            return false;
                        }
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "mep-workflows.parameterWrites[] entries must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "parameterName", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "value", maxLen: 256, out error)) return false;
                    }
                }

                var actionName = "audit_duct_slope";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    if (actionEl.ValueKind != JsonValueKind.String)
                    {
                        error = "mep-workflows.action must be a string.";
                        return false;
                    }
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                }

                var validAction =
                    actionName == "set_duct_parameter_set" ||
                    actionName == "set_params" ||
                    actionName == "set_duct_parameters" ||
                    actionName == "audit_duct_slope" ||
                    actionName == "check_duct_slope" ||
                    actionName == "duct_slope" ||
                    actionName == "create_duct_fitting_schedule" ||
                    actionName == "duct_fitting_schedule" ||
                    actionName == "create_fitting_schedule" ||
                    actionName == "create_mechanical_plan" ||
                    actionName == "mechanical_plan" ||
                    actionName == "create_plan" ||
                    actionName == "create_coordination_3d_view" ||
                    actionName == "coordination_3d" ||
                    actionName == "create_coordination_view" ||
                    actionName == "create_sections_along_ducts" ||
                    actionName == "sections_along_ducts" ||
                    actionName == "create_sections" ||
                    actionName == "place_family_along_ducts" ||
                    actionName == "place_along_ducts" ||
                    actionName == "place_hangers_along_ducts" ||
                    actionName == "connect_elements_with_duct" ||
                    actionName == "connect_duct" ||
                    actionName == "connect_elements" ||
                    actionName == "connect_elements_with_elbow" ||
                    actionName == "connect_with_elbow" ||
                    actionName == "add_elbow" ||
                    actionName == "connect_elements_with_transition" ||
                    actionName == "connect_with_transition" ||
                    actionName == "add_transition" ||
                    actionName == "connect_elements_with_flex" ||
                    actionName == "connect_with_flex" ||
                    actionName == "add_flex" ||
                    actionName == "route_terminals_to_equipment" ||
                    actionName == "route_duct_system" ||
                    actionName == "route_to_terminals" ||
                    actionName == "place_equipment_and_connect" ||
                    actionName == "place_equipment_route" ||
                    actionName == "place_ahu_and_route" ||
                    actionName == "create_riser_offset" ||
                    actionName == "riser_offset" ||
                    actionName == "create_offset" ||
                    actionName == "ensure_spaces_and_tag" ||
                    actionName == "ensure_spaces" ||
                    actionName == "spaces_and_tags" ||
                    actionName == "create_hvac_schematic" ||
                    actionName == "hvac_schematic" ||
                    actionName == "create_schematic" ||
                    actionName == "duplicate_3d_with_section_box" ||
                    actionName == "duplicate_3d_section_box" ||
                    actionName == "duplicate_3d_with_section" ||
                    actionName == "create_dependent_with_crop" ||
                    actionName == "dependent_with_crop" ||
                    actionName == "create_dependent_crop";
                if (!validAction)
                {
                    error = "mep-workflows.action is invalid.";
                    return false;
                }

                var normalizedAction = actionName switch
                {
                    "set_params" => "set_duct_parameter_set",
                    "set_duct_parameters" => "set_duct_parameter_set",
                    "check_duct_slope" => "audit_duct_slope",
                    "duct_slope" => "audit_duct_slope",
                    "duct_fitting_schedule" => "create_duct_fitting_schedule",
                    "create_fitting_schedule" => "create_duct_fitting_schedule",
                    "mechanical_plan" => "create_mechanical_plan",
                    "create_plan" => "create_mechanical_plan",
                    "coordination_3d" => "create_coordination_3d_view",
                    "create_coordination_view" => "create_coordination_3d_view",
                    "sections_along_ducts" => "create_sections_along_ducts",
                    "create_sections" => "create_sections_along_ducts",
                    "place_along_ducts" => "place_family_along_ducts",
                    "place_hangers_along_ducts" => "place_family_along_ducts",
                    "connect_duct" => "connect_elements_with_duct",
                    "connect_elements" => "connect_elements_with_duct",
                    "connect_with_elbow" => "connect_elements_with_elbow",
                    "add_elbow" => "connect_elements_with_elbow",
                    "connect_with_transition" => "connect_elements_with_transition",
                    "add_transition" => "connect_elements_with_transition",
                    "connect_with_flex" => "connect_elements_with_flex",
                    "add_flex" => "connect_elements_with_flex",
                    "route_duct_system" => "route_terminals_to_equipment",
                    "route_to_terminals" => "route_terminals_to_equipment",
                    "place_equipment_route" => "place_equipment_and_connect",
                    "place_ahu_and_route" => "place_equipment_and_connect",
                    "riser_offset" => "create_riser_offset",
                    "create_offset" => "create_riser_offset",
                    "ensure_spaces" => "ensure_spaces_and_tag",
                    "spaces_and_tags" => "ensure_spaces_and_tag",
                    "hvac_schematic" => "create_hvac_schematic",
                    "create_schematic" => "create_hvac_schematic",
                    "duplicate_3d_section_box" => "duplicate_3d_with_section_box",
                    "duplicate_3d_with_section" => "duplicate_3d_with_section_box",
                    "dependent_with_crop" => "create_dependent_with_crop",
                    "create_dependent_crop" => "create_dependent_with_crop",
                    _ => actionName
                };

                if (normalizedAction == "set_duct_parameter_set")
                {
                    var hasWrites = obj.Value.TryGetProperty("parameterWrites", out var w) &&
                                    w.ValueKind == JsonValueKind.Array &&
                                    w.GetArrayLength() > 0;
                    var hasSystemType = obj.Value.TryGetProperty("systemTypeName", out var st) &&
                                        st.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(st.GetString());
                    if (!hasWrites && !hasSystemType)
                    {
                        error = "mep-workflows.set_duct_parameter_set requires parameterWrites and/or systemTypeName.";
                        return false;
                    }
                }

                if (normalizedAction == "place_family_along_ducts")
                {
                    var hasSymbol = obj.Value.TryGetProperty("symbolName", out var sn) &&
                                    sn.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(sn.GetString());
                    if (!hasSymbol)
                    {
                        error = "mep-workflows.place_family_along_ducts requires symbolName.";
                        return false;
                    }
                }

                if (normalizedAction == "connect_elements_with_duct" ||
                    normalizedAction == "connect_elements_with_elbow" ||
                    normalizedAction == "connect_elements_with_transition" ||
                    normalizedAction == "connect_elements_with_flex" ||
                    normalizedAction == "create_riser_offset")
                {
                    var hasStart = obj.Value.TryGetProperty("startElementId", out var s) && s.ValueKind == JsonValueKind.Number;
                    var hasEnd = obj.Value.TryGetProperty("endElementId", out var e) && e.ValueKind == JsonValueKind.Number;
                    var hasPairSource = obj.Value.TryGetProperty("sourceElementIds", out var ids) &&
                                        ids.ValueKind == JsonValueKind.Array &&
                                        ids.GetArrayLength() >= 2;
                    if ((!hasStart || !hasEnd) && !hasPairSource)
                    {
                        error = "mep-workflows connect/riser actions require startElementId+endElementId or at least two sourceElementIds.";
                        return false;
                    }
                }

                if (normalizedAction == "route_terminals_to_equipment")
                {
                    var hasEquipment = obj.Value.TryGetProperty("equipmentElementId", out var eq) &&
                                       eq.ValueKind == JsonValueKind.Number;
                    if (!hasEquipment)
                    {
                        error = "mep-workflows.route_terminals_to_equipment requires equipmentElementId.";
                        return false;
                    }
                }

                if (normalizedAction == "place_equipment_and_connect")
                {
                    var hasSymbol = obj.Value.TryGetProperty("symbolName", out var sn) &&
                                    sn.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(sn.GetString());
                    var hasX = obj.Value.TryGetProperty("x", out var xx) && xx.ValueKind == JsonValueKind.Number;
                    var hasY = obj.Value.TryGetProperty("y", out var yy) && yy.ValueKind == JsonValueKind.Number;
                    if (!hasSymbol || !hasX || !hasY)
                    {
                        error = "mep-workflows.place_equipment_and_connect requires symbolName, x, and y.";
                        return false;
                    }
                }

                if (normalizedAction == "ensure_spaces_and_tag")
                {
                    var hasLevelName = obj.Value.TryGetProperty("levelName", out var ln) &&
                                       ln.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(ln.GetString());
                    var hasLevelId = obj.Value.TryGetProperty("levelId", out var lid) && lid.ValueKind == JsonValueKind.Number;
                    if (!hasLevelName && !hasLevelId)
                    {
                        error = "mep-workflows.ensure_spaces_and_tag requires levelName or levelId.";
                        return false;
                    }
                }

                if (normalizedAction == "create_dependent_with_crop")
                {
                    var hasSourceView = obj.Value.TryGetProperty("sourceViewId", out var sv) && sv.ValueKind == JsonValueKind.Number;
                    if (!hasSourceView)
                    {
                        error = "mep-workflows.create_dependent_with_crop requires sourceViewId.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/arch-workflows", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "arch-workflows body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "elementIds", maxCount: 20000, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "firstElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "secondElementId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 24, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "typeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sourceTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourceTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "levelId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "structural", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "heightFeet", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "wallTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "wallTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "floorTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "floorTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ceilingTypeName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "ceilingTypeId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "symbolName", maxLen: 160, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "count", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingX", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingY", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingZ", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copy", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 160, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "x", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "y", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "z", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTypesWithDependencies", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxDelete", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "createTags", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "closeLoop", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "lockConstraint", out error)) return false;

                // polyline: [{x,y,z?}]
                if (obj.Value.TryGetProperty("polyline", out var poly) && poly.ValueKind != JsonValueKind.Null)
                {
                    if (poly.ValueKind != JsonValueKind.Array)
                    {
                        error = "arch-workflows.polyline must be an array.";
                        return false;
                    }
                    var c = 0;
                    foreach (var pt in poly.EnumerateArray())
                    {
                        c++;
                        if (c > 5000)
                        {
                            error = "arch-workflows.polyline too large.";
                            return false;
                        }
                        if (pt.ValueKind != JsonValueKind.Object)
                        {
                            error = "arch-workflows.polyline[] entries must be objects.";
                            return false;
                        }
                        if (!ValidateRequiredNumber(pt, "x", out error)) return false;
                        if (!ValidateRequiredNumber(pt, "y", out error)) return false;
                        if (!ValidateOptionalNumber(pt, "z", out error)) return false;
                    }
                }

                foreach (var pointKey in new[] { "planeOrigin", "planeNormal", "p1", "p2", "cutVec" })
                {
                    if (!obj.Value.TryGetProperty(pointKey, out var pt) || pt.ValueKind == JsonValueKind.Null) continue;
                    if (pt.ValueKind != JsonValueKind.Object)
                    {
                        error = $"arch-workflows.{pointKey} must be an object.";
                        return false;
                    }
                    if (!ValidateRequiredNumber(pt, "x", out error)) return false;
                    if (!ValidateRequiredNumber(pt, "y", out error)) return false;
                    if (!ValidateOptionalNumber(pt, "z", out error)) return false;
                }

                // placements: [{hostElementId?,x,y,z,rotationDegrees?,align...}]
                if (obj.Value.TryGetProperty("placements", out var placements) && placements.ValueKind != JsonValueKind.Null)
                {
                    if (placements.ValueKind != JsonValueKind.Array)
                    {
                        error = "arch-workflows.placements must be an array.";
                        return false;
                    }
                    var c = 0;
                    foreach (var pl in placements.EnumerateArray())
                    {
                        c++;
                        if (c > 5000)
                        {
                            error = "arch-workflows.placements too large.";
                            return false;
                        }
                        if (pl.ValueKind != JsonValueKind.Object)
                        {
                            error = "arch-workflows.placements[] entries must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalLong(pl, "hostElementId", out error)) return false;
                        if (!ValidateRequiredNumber(pl, "x", out error)) return false;
                        if (!ValidateRequiredNumber(pl, "y", out error)) return false;
                        if (!ValidateRequiredNumber(pl, "z", out error)) return false;
                        if (!ValidateOptionalNumber(pl, "rotationDegrees", out error)) return false;
                        if (!ValidateOptionalLong(pl, "alignToElementId", out error)) return false;
                        if (!ValidateOptionalString(pl, "alignSourceSide", maxLen: 24, out error)) return false;
                        if (!ValidateOptionalString(pl, "alignTargetSide", maxLen: 24, out error)) return false;
                        if (!ValidateOptionalString(pl, "alignAxis", maxLen: 24, out error)) return false;
                    }
                }

                var actionName = "";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    if (actionEl.ValueKind != JsonValueKind.String)
                    {
                        error = "arch-workflows.action must be a string.";
                        return false;
                    }
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                }

                var normalizedAction = actionName switch
                {
                    "create_walls" => "create_walls_from_polyline",
                    "walls_from_polyline" => "create_walls_from_polyline",
                    "swap_type_in_view" => "swap_family_type_in_view",
                    "swap_family_type" => "swap_family_type_in_view",
                    "group_and_place" => "create_model_group_and_place",
                    "create_group_and_place" => "create_model_group_and_place",
                    "array" => "array_elements",
                    "copy_array" => "array_elements",
                    "mirror" => "mirror_elements",
                    "copy" => "copy_same_place",
                    "create_ref_plane" => "create_reference_plane",
                    "reference_plane" => "create_reference_plane",
                    "purge_line_patterns" => "purge_duplicate_line_patterns",
                    "purge_duplicate_patterns" => "purge_duplicate_line_patterns",
                    "create_floor" => "create_floor_from_walls",
                    "create_ceiling" => "create_ceiling_in_room",
                    "create_rooms" => "create_rooms_and_tags",
                    "room_separation_lines" => "create_room_separation_lines",
                    _ => actionName
                };

                var validAction = normalizedAction == "create_walls_from_polyline" ||
                                  normalizedAction == "change_wall_type" ||
                                  normalizedAction == "join_wall_geometry" ||
                                  normalizedAction == "place_hosted_instances" ||
                                  normalizedAction == "swap_family_type_in_view" ||
                                  normalizedAction == "create_model_group_and_place" ||
                                  normalizedAction == "array_elements" ||
                                  normalizedAction == "mirror_elements" ||
                                  normalizedAction == "copy_same_place" ||
                                  normalizedAction == "create_reference_plane" ||
                                  normalizedAction == "purge_duplicate_line_patterns" ||
                                  normalizedAction == "create_floor_from_walls" ||
                                  normalizedAction == "create_ceiling_in_room" ||
                                  normalizedAction == "create_rooms_and_tags" ||
                                  normalizedAction == "create_room_separation_lines";
                if (!validAction)
                {
                    error = "arch-workflows.action is invalid.";
                    return false;
                }

                if (normalizedAction == "create_walls_from_polyline")
                {
                    var hasPolyline = obj.Value.TryGetProperty("polyline", out var polyEl) &&
                                      polyEl.ValueKind == JsonValueKind.Array &&
                                      polyEl.GetArrayLength() >= 2;
                    if (!hasPolyline)
                    {
                        error = "arch-workflows.create_walls_from_polyline requires polyline with at least two points.";
                        return false;
                    }
                }

                if (normalizedAction == "place_hosted_instances")
                {
                    var hasSymbol = obj.Value.TryGetProperty("symbolName", out var sn) &&
                                    sn.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(sn.GetString());
                    var hasPlacements = obj.Value.TryGetProperty("placements", out var pls) &&
                                        pls.ValueKind == JsonValueKind.Array &&
                                        pls.GetArrayLength() > 0;
                    if (!hasSymbol || !hasPlacements)
                    {
                        error = "arch-workflows.place_hosted_instances requires symbolName and placements.";
                        return false;
                    }
                }

                if (normalizedAction == "array_elements")
                {
                    var hasIds = obj.Value.TryGetProperty("elementIds", out var ids) &&
                                 ids.ValueKind == JsonValueKind.Array &&
                                 ids.GetArrayLength() > 0;
                    var hasCount = obj.Value.TryGetProperty("count", out var c) &&
                                   c.ValueKind == JsonValueKind.Number &&
                                   c.TryGetInt32(out var cv) &&
                                   cv >= 2;
                    if (!hasIds || !hasCount)
                    {
                        error = "arch-workflows.array_elements requires elementIds and count>=2.";
                        return false;
                    }
                }

                if (normalizedAction == "create_floor_from_walls")
                {
                    var hasIds = obj.Value.TryGetProperty("elementIds", out var ids) &&
                                 ids.ValueKind == JsonValueKind.Array &&
                                 ids.GetArrayLength() >= 3;
                    if (!hasIds)
                    {
                        error = "arch-workflows.create_floor_from_walls requires elementIds with at least three walls.";
                        return false;
                    }
                }

                if (normalizedAction == "create_ceiling_in_room")
                {
                    var hasRoomId = obj.Value.TryGetProperty("roomId", out var rid) &&
                                    rid.ValueKind == JsonValueKind.Number;
                    var hasRoomNumber = obj.Value.TryGetProperty("roomNumber", out var rn) &&
                                        rn.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(rn.GetString());
                    if (!hasRoomId && !hasRoomNumber)
                    {
                        error = "arch-workflows.create_ceiling_in_room requires roomId or roomNumber.";
                        return false;
                    }
                }

                if (normalizedAction == "create_rooms_and_tags")
                {
                    var hasPolyline = obj.Value.TryGetProperty("polyline", out var polyEl) &&
                                      polyEl.ValueKind == JsonValueKind.Array &&
                                      polyEl.GetArrayLength() >= 1;
                    var hasLevel = obj.Value.TryGetProperty("levelId", out var lid) && lid.ValueKind == JsonValueKind.Number ||
                                   obj.Value.TryGetProperty("levelName", out var ln) && ln.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(ln.GetString());
                    if (!hasPolyline || !hasLevel)
                    {
                        error = "arch-workflows.create_rooms_and_tags requires polyline and levelId|levelName.";
                        return false;
                    }
                }

                if (normalizedAction == "create_room_separation_lines")
                {
                    var hasPolyline = obj.Value.TryGetProperty("polyline", out var polyEl) &&
                                      polyEl.ValueKind == JsonValueKind.Array &&
                                      polyEl.GetArrayLength() >= 2;
                    var hasView = obj.Value.TryGetProperty("viewId", out var viewEl) &&
                                  viewEl.ValueKind == JsonValueKind.Number;
                    if (!hasPolyline || !hasView)
                    {
                        error = "arch-workflows.create_room_separation_lines requires viewId and polyline with at least two points.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/airflow-qa", StringComparison.OrdinalIgnoreCase))
            {
                // Consolidated HVAC/MEP QA endpoint with action dispatch.
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "airflow-qa body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "designationParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "flowParameterNames", maxCount: 50, maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "applyTypeChanges", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "setFlowAfterTypeChange", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "setFlowParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeInRange", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "toleranceCfm", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "sourceElementIds", maxCount: 20000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sourceCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sinkCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 64, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "scheduledFlowParameterNames", maxCount: 50, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sinkFlowParameterNames", maxCount: 50, maxLen: 128, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxHops", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "mismatchToleranceCfm", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "applyScheduledFlowUpdate", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scheduledFlowWriteParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourcePath", maxLen: 512, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "range", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumberColumn", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "applyRoomParameterUpdates", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSummaryParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includePressureClassification", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "pressureColumn", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "placeAirTerminalsFromSpreadsheet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "maxDeviceCfm", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "minDeviceSeparationFeet", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "preferGridIntersections", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "strictGridIntersections", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "existingDeviceClearanceFeet", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "clashCategoryNames", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "replaceAutoPlacedElements", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "tagPlacedAirTerminals", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagTypeNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "onlyTagUntagged", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "addTagLeader", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "tagOffsetFeet", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "applyPressureFilledRegions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "clearPressureRegionsForUnregulated", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "pressureFillTransparencyPercent", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "positiveColorHex", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "negativeColorHex", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "baselineModel", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "baselineLinkNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "targetModel", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "targetLinkNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "outletCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "outletTypeParameterNames", maxCount: 50, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "outletIncludeKeywords", maxCount: 100, maxLen: 64, out error)) return false;
                if (obj.Value.TryGetProperty("terminalPlacementSpecs", out var terminalSpecsEl) && terminalSpecsEl.ValueKind != JsonValueKind.Null)
                {
                    if (terminalSpecsEl.ValueKind != JsonValueKind.Array)
                    {
                        error = "airflow-qa.terminalPlacementSpecs must be an array.";
                        return false;
                    }
                    int specCount = 0;
                    foreach (var item in terminalSpecsEl.EnumerateArray())
                    {
                        specCount++;
                        if (specCount > 100)
                        {
                            error = "airflow-qa.terminalPlacementSpecs supports at most 100 entries.";
                            return false;
                        }
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "airflow-qa.terminalPlacementSpecs[] entries must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "label", maxLen: 64, out error)) return false;
                        if (!ValidateOptionalString(item, "columnName", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "familyName", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "familyNameContains", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "typeName", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "typeNameContains", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "flowParameterName", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalNumber(item, "maxCfmPerDevice", out error)) return false;
                        if (!ValidateOptionalNumber(item, "minSeparationFeet", out error)) return false;
                    }
                }

                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    if (actionEl.ValueKind != JsonValueKind.String)
                    {
                        error = "airflow-qa.action must be a string.";
                        return false;
                    }

                    var actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    var okAction =
                        actionName == "audit_air_devices" ||
                        actionName == "air_device" ||
                        actionName == "air_device_type_audit" ||
                        actionName == "audit_connected_flow" ||
                        actionName == "connected_flow" ||
                        actionName == "terminal_connected_flow" ||
                        actionName == "reconcile_air_balance_sheet" ||
                        actionName == "air_balance" ||
                        actionName == "reconcile_air_balance" ||
                        actionName == "layout_air_terminals_from_sheet" ||
                        actionName == "layout_from_sheet" ||
                        actionName == "place_air_terminals_from_sheet" ||
                        actionName == "air_balance_layout" ||
                        actionName == "tag_airflow_terminals" ||
                        actionName == "tag_terminals" ||
                        actionName == "tag_air_terminals" ||
                        actionName == "apply_pressure_regions_from_sheet" ||
                        actionName == "pressure_regions" ||
                        actionName == "apply_pressure_regions" ||
                        actionName == "audit_medical_gas_outlets" ||
                        actionName == "medical_gas" ||
                        actionName == "medical_gas_outlet_audit";
                    if (!okAction)
                    {
                        error = "airflow-qa.action is invalid.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/room-contents", StringComparison.OrdinalIgnoreCase))
            {
                // { roomNumber:string, categories?:string[], includeKeywords?:string[], excludeKeywords?:string[], includeLinked?:bool, mode?:"auto"|"roomAware"|"geometry", verticalScope?:"room"|"plenum"|"room+plenum", spatialKindPreference?:"auto"|"room"|"space", plenumMaxZ?:number, systemClassification?:string, includeConnectedOutsideRoom?:bool, limit?:int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "room-contents body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "spatialKindPreference", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeLinked", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeKeywords", maxCount: 100, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "excludeKeywords", maxCount: 100, maxLen: 128, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "plenumMaxZ", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeConnectedOutsideRoom", out error)) return false;

                if (obj.Value.TryGetProperty("mode", out var mode) && mode.ValueKind == JsonValueKind.String)
                {
                    var m = (mode.GetString() ?? "").Trim();
                    if (!m.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !m.Equals("roomAware", StringComparison.OrdinalIgnoreCase) &&
                        !m.Equals("geometry", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "room-contents.mode must be 'auto', 'roomAware', or 'geometry'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "room-contents.verticalScope must be 'room', 'plenum', or 'room+plenum'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("spatialKindPreference", out var sk) && sk.ValueKind == JsonValueKind.String)
                {
                    var s = (sk.GetString() ?? "").Trim();
                    if (!s.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !s.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !s.Equals("space", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "room-contents.spatialKindPreference must be 'auto', 'room', or 'space'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "room-contents.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 200000)
                    {
                        error = "room-contents.limit out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/find-elements", StringComparison.OrdinalIgnoreCase))
            {
                // { viewId?:number, sheetNumber?:string, includeSheetElements?:bool, includeViewportElements?:bool, sheetRegions?:[{minU,minV,maxU,maxV}], regionPaddingFt?:number, category?:string, categories?:string[], typeNameContains?:string, familyNameContains?:string, nameContains?:string, markContains?:string, limit?:int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "find-elements body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSheetElements", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeViewportElements", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "regionPaddingFt", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "nameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "markContains", maxLen: 128, out error)) return false;

                if (obj.Value.TryGetProperty("sheetRegions", out var regions) && regions.ValueKind != JsonValueKind.Null)
                {
                    if (regions.ValueKind != JsonValueKind.Array)
                    {
                        error = "find-elements.sheetRegions must be an array.";
                        return false;
                    }
                    var n = 0;
                    foreach (var region in regions.EnumerateArray())
                    {
                        n++;
                        if (n > 200)
                        {
                            error = "find-elements.sheetRegions too large.";
                            return false;
                        }
                        if (region.ValueKind != JsonValueKind.Object)
                        {
                            error = "find-elements.sheetRegions items must be objects.";
                            return false;
                        }
                        if (!ValidateRequiredNumber(region, "minU", out error)) return false;
                        if (!ValidateRequiredNumber(region, "minV", out error)) return false;
                        if (!ValidateRequiredNumber(region, "maxU", out error)) return false;
                        if (!ValidateRequiredNumber(region, "maxV", out error)) return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "find-elements.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "find-elements.limit out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/trace-connected-network", StringComparison.OrdinalIgnoreCase))
            {
                // { startElementId:number, systemName?:string, inferSystemFromStart?:bool, includeDucts?:bool, includeFittings?:bool, includeAccessories?:bool, includeTerminals?:bool, includeEquipment?:bool, includeOtherCategories?:bool, maxElements?:int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "trace-connected-network body must be an object.";
                    return false;
                }

                if (!ValidateRequiredLong(obj.Value, "startElementId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "inferSystemFromStart", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtBranchFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtTransitions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeDucts", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeAccessories", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEquipment", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeOtherCategories", out error)) return false;

                if (obj.Value.TryGetProperty("maxHops", out var hops) && hops.ValueKind != JsonValueKind.Null)
                {
                    if (hops.ValueKind != JsonValueKind.Number || !hops.TryGetInt32(out var v))
                    {
                        error = "trace-connected-network.maxHops must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "trace-connected-network.maxHops out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("excludeElementIds", out var ex) && ex.ValueKind != JsonValueKind.Null)
                {
                    if (ex.ValueKind != JsonValueKind.Array)
                    {
                        error = "trace-connected-network.excludeElementIds must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in ex.EnumerateArray())
                    {
                        count++;
                        if (count > 20000)
                        {
                            error = "trace-connected-network.excludeElementIds too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                        {
                            error = "trace-connected-network.excludeElementIds must be an array of integers.";
                            return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("stopAtElementIds", out var st) && st.ValueKind != JsonValueKind.Null)
                {
                    if (st.ValueKind != JsonValueKind.Array)
                    {
                        error = "trace-connected-network.stopAtElementIds must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in st.EnumerateArray())
                    {
                        count++;
                        if (count > 20000)
                        {
                            error = "trace-connected-network.stopAtElementIds too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                        {
                            error = "trace-connected-network.stopAtElementIds must be an array of integers.";
                            return false;
                        }
                    }
                }

                if (!ValidateOptionalStringArray(obj.Value, "stopAtCategories", maxCount: 50, maxLen: 96, out error)) return false;

                if (obj.Value.TryGetProperty("maxElements", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "trace-connected-network.maxElements must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 50000)
                    {
                        error = "trace-connected-network.maxElements out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/find-elements-by-parameter", StringComparison.OrdinalIgnoreCase))
            {
                // { category?:string, categories?:string[], parameterName|parameter|paramName:string, op:"equals"|"contains" (aliases accepted), value:string, systemName?:string, viewId?:number, limit?:int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "find-elements-by-parameter body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameter", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "paramName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;

                var hasParameterName =
                    (obj.Value.TryGetProperty("parameterName", out var pn) && pn.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(pn.GetString())) ||
                    (obj.Value.TryGetProperty("parameter", out var pAlias) && pAlias.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(pAlias.GetString())) ||
                    (obj.Value.TryGetProperty("paramName", out var pnAlias) && pnAlias.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(pnAlias.GetString()));

                var hasPredicates = false;
                if (obj.Value.TryGetProperty("predicates", out var predicatesEl) && predicatesEl.ValueKind != JsonValueKind.Null)
                {
                    if (predicatesEl.ValueKind != JsonValueKind.Array || predicatesEl.GetArrayLength() < 1 || predicatesEl.GetArrayLength() > 8)
                    {
                        error = "find-elements-by-parameter.predicates must contain 1 to 8 items.";
                        return false;
                    }
                    foreach (var predicate in predicatesEl.EnumerateArray())
                    {
                        if (predicate.ValueKind != JsonValueKind.Object || !ValidateRequiredString(predicate, "parameterName", maxLen: 128, out error) || !ValidateRequiredString(predicate, "value", maxLen: 256, out error)) return false;
                        if (predicate.TryGetProperty("op", out var predicateOp) && predicateOp.ValueKind != JsonValueKind.Null && (predicateOp.ValueKind != JsonValueKind.String || (!(predicateOp.GetString() ?? "").Equals("equals", StringComparison.OrdinalIgnoreCase) && !(predicateOp.GetString() ?? "").Equals("contains", StringComparison.OrdinalIgnoreCase))))
                        {
                            error = "find-elements-by-parameter predicate op must be 'equals' or 'contains'.";
                            return false;
                        }
                    }
                    hasPredicates = true;
                }

                if (!hasPredicates && !ValidateRequiredString(obj.Value, "value", maxLen: 256, out error)) return false;
                if (obj.Value.TryGetProperty("matchMode", out var matchModeEl) && matchModeEl.ValueKind != JsonValueKind.Null && (matchModeEl.ValueKind != JsonValueKind.String || (!(matchModeEl.GetString() ?? "").Equals("any", StringComparison.OrdinalIgnoreCase) && !(matchModeEl.GetString() ?? "").Equals("all", StringComparison.OrdinalIgnoreCase))))
                {
                    error = "find-elements-by-parameter.matchMode must be 'any' or 'all'.";
                    return false;
                }

                if (!hasParameterName && !hasPredicates)
                {
                    error = "find-elements-by-parameter requires parameterName or predicates.";
                    return false;
                }

                if (obj.Value.TryGetProperty("op", out var opEl) && opEl.ValueKind != JsonValueKind.Null)
                {
                    if (opEl.ValueKind != JsonValueKind.String)
                    {
                        error = "find-elements-by-parameter.op must be a string.";
                        return false;
                    }
                    var opv = (opEl.GetString() ?? "").Trim();
                    var isEqualsAlias =
                        opv.Equals("equals", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("equal", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("eq", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("==", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("=", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("is", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("exact", StringComparison.OrdinalIgnoreCase);
                    var isContainsAlias =
                        opv.Equals("contains", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("contain", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("has", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("include", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("includes", StringComparison.OrdinalIgnoreCase) ||
                        opv.Equals("like", StringComparison.OrdinalIgnoreCase);
                    if (!isEqualsAlias && !isContainsAlias)
                    {
                        error = "find-elements-by-parameter.op must be 'equals' or 'contains' (aliases like 'eq' and 'has' are accepted).";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "find-elements-by-parameter.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 20000)
                    {
                        error = "find-elements-by-parameter.limit out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/update-parameter-by-query", StringComparison.OrdinalIgnoreCase))
            {
                // { category?, categories?, matchStartsWith?, matchContains?, matchParameterNames?, familyNameContains?, typeNameContains?, parameterName, value, onlyWhenBlank?, dryRun?, apply?, confirm?, limit? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "update-parameter-by-query body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchStartsWith", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchContains", maxLen: 256, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "matchParameterNames", maxCount: 20, maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyNameContains", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeNameContains", maxLen: 256, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "parameterName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "value", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "onlyWhenBlank", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    if (confirm.ValueKind != JsonValueKind.String && confirm.ValueKind != JsonValueKind.True && confirm.ValueKind != JsonValueKind.False)
                    {
                        error = "update-parameter-by-query.confirm must be a string or boolean compatibility value.";
                        return false;
                    }
                    var s = BulkConfirmUtil.Normalize(confirm.ValueKind == JsonValueKind.String ? confirm.GetString() : confirm.GetRawText());
                    if (s.Length > 80)
                    {
                        error = "update-parameter-by-query.confirm is too long.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "update-parameter-by-query.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "update-parameter-by-query.limit out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/update-panel-parameter", StringComparison.OrdinalIgnoreCase))
            {
                // { scheduleQuery?|panelName?|panelNamePattern?|matchExact?, matchStartsWith?, matchContains?, exact?, max?, parameterName|requestedParameterName|parameterSemantic, value, onlyWhenBlank?, targetScope?, samplePanelName?, includeWritableFields?, preflightOnly?, dryRun?, apply?, confirm? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "update-panel-parameter body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "scheduleQuery", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchStartsWith", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchContains", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "panelName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "panelNamePattern", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchExact", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "requestedParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterSemantic", maxLen: 128, out error)) return false;
                var hasParameterName =
                    (obj.Value.TryGetProperty("parameterName", out var parameterNameEl) && parameterNameEl.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(parameterNameEl.GetString())) ||
                    (obj.Value.TryGetProperty("requestedParameterName", out var requestedParameterNameEl) && requestedParameterNameEl.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(requestedParameterNameEl.GetString())) ||
                    (obj.Value.TryGetProperty("parameterSemantic", out var parameterSemanticEl) && parameterSemanticEl.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(parameterSemanticEl.GetString()));
                if (!hasParameterName)
                {
                    error = "update-panel-parameter requires parameterName (aliases accepted: requestedParameterName, parameterSemantic).";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "value", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "onlyWhenBlank", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "targetScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "samplePanelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeWritableFields", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "preflightOnly", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("targetScope", out var scopeEl) && scopeEl.ValueKind == JsonValueKind.String)
                {
                    var scope = (scopeEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (!(scope == "auto" || scope == "panel" || scope == "schedule"))
                    {
                        error = "update-panel-parameter.targetScope must be 'auto', 'panel', or 'schedule'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    if (confirm.ValueKind != JsonValueKind.String)
                    {
                        error = "update-panel-parameter.confirm must be a string.";
                        return false;
                    }
                    var s = BulkConfirmUtil.Normalize(confirm.GetString());
                    if (s.Length > 80)
                    {
                        error = "update-panel-parameter.confirm is too long.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "update-panel-parameter.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "update-panel-parameter.max out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/ducts-by-spatial-scope", StringComparison.OrdinalIgnoreCase))
            {
                // { roomNumber, systemClassification?, sizeFrom?, verticalScope?, includeCategories?, roomMode?, includeConnectedOutsideRoom?, limit? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "ducts-by-spatial-scope body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "roomNumber", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sizeFrom", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeCategories", maxCount: 20, maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomMode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeConnectedOutsideRoom", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "limit", out error)) return false;

                if (obj.Value.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "ducts-by-spatial-scope.verticalScope must be 'room', 'plenum', or 'room+plenum'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("roomMode", out var rm) && rm.ValueKind == JsonValueKind.String)
                {
                    var r = (rm.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("roomAware", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("geometry", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "ducts-by-spatial-scope.roomMode must be 'auto', 'roomAware', or 'geometry'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "ducts-by-spatial-scope.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 200000)
                    {
                        error = "ducts-by-spatial-scope.limit out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/sync-connected-sizes", StringComparison.OrdinalIgnoreCase))
            {
                // { startElementId?:number, elementIds?:number[], mode?:string, dryRun?:bool, resolveTypeDriven?:string, maxElements?:int, confirm?:string }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "sync-connected-sizes body must be an object.";
                    return false;
                }

                var hasStart = obj.Value.TryGetProperty("startElementId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind != JsonValueKind.Null;
                if (!hasStart && !hasIds)
                {
                    error = "sync-connected-sizes requires startElementId or elementIds.";
                    return false;
                }
                if (hasStart && (sid.ValueKind != JsonValueKind.Number || !sid.TryGetInt64(out _)))
                {
                    error = "sync-connected-sizes.startElementId must be an integer.";
                    return false;
                }
                if (hasIds)
                {
                    if (eids.ValueKind != JsonValueKind.Array)
                    {
                        error = "sync-connected-sizes.elementIds must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in eids.EnumerateArray())
                    {
                        count++;
                        if (count > 20000)
                        {
                            error = "sync-connected-sizes.elementIds too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                        {
                            error = "sync-connected-sizes.elementIds must be an array of integers.";
                            return false;
                        }
                    }
                }

                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "resolveTypeDriven", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 64, out error)) return false;

                if (obj.Value.TryGetProperty("resolveTypeDriven", out var rtd) && rtd.ValueKind == JsonValueKind.String)
                {
                    var r = (rtd.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("skip", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "sync-connected-sizes.resolveTypeDriven must be 'auto', 'duplicate', or 'skip'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxElements", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "sync-connected-sizes.maxElements must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 50000)
                    {
                        error = "sync-connected-sizes.maxElements out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resize-duct-run", StringComparison.OrdinalIgnoreCase))
            {
                // { startElementId:number, targetDiameter?:string, targetDiameterFt?:number, systemName?:string, inferSystemFromStart?:bool, scope?:string, stopAtBranchFittings?:bool, stopAtTransitions?:bool, includeTerminals?:bool, includeEquipment?:bool, maxElements?:int, dryRun?:bool, confirm?:string }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resize-duct-run body must be an object.";
                    return false;
                }

                if (!ValidateRequiredLong(obj.Value, "startElementId", out error)) return false;

                var hasTargetDiameter = obj.Value.TryGetProperty("targetDiameter", out var td) && td.ValueKind != JsonValueKind.Null;
                var hasTargetFt = obj.Value.TryGetProperty("targetDiameterFt", out var tdf) && tdf.ValueKind != JsonValueKind.Null;
                if (!hasTargetDiameter && !hasTargetFt)
                {
                    error = "resize-duct-run requires targetDiameter or targetDiameterFt.";
                    return false;
                }
                if (hasTargetDiameter && !ValidateRequiredString(obj.Value, "targetDiameter", maxLen: 64, out error)) return false;
                if (hasTargetFt && !ValidateOptionalNumber(obj.Value, "targetDiameterFt", out error)) return false;

                if (!ValidateOptionalString(obj.Value, "systemName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "inferSystemFromStart", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtBranchFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtTransitions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEquipment", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "eliminateTransitions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 64, out error)) return false;

                if (obj.Value.TryGetProperty("scope", out var sc) && sc.ValueKind != JsonValueKind.Null)
                {
                    if (sc.ValueKind != JsonValueKind.String)
                    {
                        error = "resize-duct-run.scope must be a string.";
                        return false;
                    }
                    var s = (sc.GetString() ?? "").Trim();
                    if (!s.Equals("run", StringComparison.OrdinalIgnoreCase) && !s.Equals("selectedOnly", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-duct-run.scope must be 'run' or 'selectedOnly'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxElements", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "resize-duct-run.maxElements must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 50000)
                    {
                        error = "resize-duct-run.maxElements out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resize-ducts-by-scope", StringComparison.OrdinalIgnoreCase))
            {
                // { scope:{type,...}, toDiameter, systemClassification?, fromDiameter?, includeFittings?, includeTerminals?, scopeMode?, stopAtBranchFittings?, stopAtTransitions?, verify?, dryRun?, confirm?, maxElements? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resize-ducts-by-scope body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.Object)
                {
                    error = "resize-ducts-by-scope.scope is required and must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(scope, "type", maxLen: 24, out error)) return false;
                var scopeType = (scope.GetProperty("type").GetString() ?? "").Trim().ToLowerInvariant();
                if (scopeType != "equipment" && scopeType != "room" && scopeType != "view")
                {
                    error = "resize-ducts-by-scope.scope.type must be 'equipment', 'room', or 'view'.";
                    return false;
                }

                if (scopeType == "equipment")
                {
                    if (!ValidateRequiredString(scope, "mark", maxLen: 128, out error)) return false;
                }
                else if (scopeType == "room")
                {
                    if (!ValidateRequiredString(scope, "roomNumber", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(scope, "plenumTopLevelName", maxLen: 128, out error)) return false;
                    var verticalForScope = "plenum";
                    if (obj.Value.TryGetProperty("verticalScope", out var vsForScope) && vsForScope.ValueKind == JsonValueKind.String)
                    {
                        verticalForScope = (vsForScope.GetString() ?? "").Trim();
                    }
                    if (!verticalForScope.Equals("room", StringComparison.OrdinalIgnoreCase))
                    {
                        var hasTop = scope.TryGetProperty("plenumTopLevelName", out var top) &&
                                     top.ValueKind == JsonValueKind.String &&
                                     !string.IsNullOrWhiteSpace(top.GetString());
                        if (!hasTop)
                        {
                            error = "resize-ducts-by-scope.scope.plenumTopLevelName is required for room scope when verticalScope is plenum.";
                            return false;
                        }
                    }
                }
                else
                {
                    if (!ValidateRequiredLong(scope, "viewId", out error)) return false;
                }

                if (!ValidateRequiredString(obj.Value, "toDiameter", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fromDiameter", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scopeMode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomMode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEquipment", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtBranchFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtTransitions", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "resolveTypeDriven", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "eliminateTransitions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "verify", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElements", out error)) return false;

                if (obj.Value.TryGetProperty("roomMode", out var rm) && rm.ValueKind == JsonValueKind.String)
                {
                    var r = (rm.GetString() ?? "").Trim();
                    if (!r.Equals("geometry", StringComparison.OrdinalIgnoreCase) && !r.Equals("roomAware", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-by-scope.roomMode must be 'geometry' or 'roomAware'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) && !v.Equals("plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-by-scope.verticalScope must be 'room' or 'plenum'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("resolveTypeDriven", out var rtd) && rtd.ValueKind == JsonValueKind.String)
                {
                    var r = (rtd.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("skip", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-by-scope.resolveTypeDriven must be 'auto', 'duplicate', or 'skip'.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resize-ducts-in-room", StringComparison.OrdinalIgnoreCase))
            {
                // { roomNumber, roomMode?, verticalScope?, plenumTopLevelName?, systemClassification?, sizeFrom?, sizeTo, includeFittings?, includeTerminals?, includeEquipment?, stopAtBranchFittings?, resolveTypeDriven?, eliminateTransitions?, verify?, dryRun?, confirm?, maxElements? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resize-ducts-in-room body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "sizeTo", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomMode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "plenumTopLevelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sizeFrom", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEquipment", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "stopAtBranchFittings", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "resolveTypeDriven", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "eliminateTransitions", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "verify", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElements", out error)) return false;

                if (obj.Value.TryGetProperty("roomMode", out var rm) && rm.ValueKind == JsonValueKind.String)
                {
                    var r = (rm.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("geometry", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("roomAware", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-in-room.roomMode must be 'auto', 'geometry', or 'roomAware'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-in-room.verticalScope must be 'room', 'plenum', 'auto', or 'room+plenum'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("resolveTypeDriven", out var rtd) && rtd.ValueKind == JsonValueKind.String)
                {
                    var r = (rtd.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("skip", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ducts-in-room.resolveTypeDriven must be 'auto', 'duplicate', or 'skip'.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resize-ductwork-by-scope", StringComparison.OrdinalIgnoreCase))
            {
                // { scope:{roomNumber,verticalScope?,roomMode?},systemClassification?,sizeFrom?,sizeTo,includeFittings?,includeTerminals?,resolveTypeDriven?,repairContinuity?,continuityMaxGapFt?,continuityMaxRepairs?,verify?,dryRun?,confirm?,maxElements? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resize-ductwork-by-scope body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.Object)
                {
                    error = "resize-ductwork-by-scope.scope is required and must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(scope, "roomNumber", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(scope, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(scope, "roomMode", maxLen: 32, out error)) return false;

                if (scope.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ductwork-by-scope.scope.verticalScope must be 'room', 'plenum', or 'room+plenum'.";
                        return false;
                    }
                }

                if (scope.TryGetProperty("roomMode", out var rm) && rm.ValueKind == JsonValueKind.String)
                {
                    var r = (rm.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("roomAware", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("geometry", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ductwork-by-scope.scope.roomMode must be 'auto', 'roomAware', or 'geometry'.";
                        return false;
                    }
                }

                if (!ValidateRequiredString(obj.Value, "sizeTo", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sizeFrom", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeFittings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "resolveTypeDriven", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "repairContinuity", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "continuityMaxGapFt", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "continuityMaxRepairs", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "verify", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElements", out error)) return false;

                if (obj.Value.TryGetProperty("resolveTypeDriven", out var rtd) && rtd.ValueKind == JsonValueKind.String)
                {
                    var r = (rtd.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("duplicate", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("skip", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "resize-ductwork-by-scope.resolveTypeDriven must be 'auto', 'duplicate', or 'skip'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("continuityMaxGapFt", out var cmg) && cmg.ValueKind != JsonValueKind.Null)
                {
                    if (cmg.ValueKind != JsonValueKind.Number || !cmg.TryGetDouble(out var v))
                    {
                        error = "resize-ductwork-by-scope.continuityMaxGapFt must be a number.";
                        return false;
                    }
                    if (v <= 0 || v > 50)
                    {
                        error = "resize-ductwork-by-scope.continuityMaxGapFt out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("continuityMaxRepairs", out var cmr) && cmr.ValueKind != JsonValueKind.Null)
                {
                    if (cmr.ValueKind != JsonValueKind.Number || !cmr.TryGetInt32(out var iv))
                    {
                        error = "resize-ductwork-by-scope.continuityMaxRepairs must be an integer.";
                        return false;
                    }
                    if (iv < 0 || iv > 64)
                    {
                        error = "resize-ductwork-by-scope.continuityMaxRepairs out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/repair-duct-continuity-by-scope", StringComparison.OrdinalIgnoreCase))
            {
                // { scope:{roomNumber,verticalScope?,roomMode?},systemClassification?,includeTerminals?,verify?,dryRun?,maxGapFt?,maxRepairs?,maxElements? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "repair-duct-continuity-by-scope body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("scope", out var scope) || scope.ValueKind != JsonValueKind.Object)
                {
                    error = "repair-duct-continuity-by-scope.scope is required and must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(scope, "roomNumber", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(scope, "verticalScope", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(scope, "roomMode", maxLen: 32, out error)) return false;

                if (scope.TryGetProperty("verticalScope", out var vs) && vs.ValueKind == JsonValueKind.String)
                {
                    var v = (vs.GetString() ?? "").Trim();
                    if (!v.Equals("room", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("plenum", StringComparison.OrdinalIgnoreCase) &&
                        !v.Equals("room+plenum", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "repair-duct-continuity-by-scope.scope.verticalScope must be 'room', 'plenum', or 'room+plenum'.";
                        return false;
                    }
                }

                if (scope.TryGetProperty("roomMode", out var rm) && rm.ValueKind == JsonValueKind.String)
                {
                    var r = (rm.GetString() ?? "").Trim();
                    if (!r.Equals("auto", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("roomAware", StringComparison.OrdinalIgnoreCase) &&
                        !r.Equals("geometry", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "repair-duct-continuity-by-scope.scope.roomMode must be 'auto', 'roomAware', or 'geometry'.";
                        return false;
                    }
                }

                if (!ValidateOptionalString(obj.Value, "systemClassification", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTerminals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "verify", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "maxGapFt", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxRepairs", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElements", out error)) return false;

                if (obj.Value.TryGetProperty("maxGapFt", out var mg) && mg.ValueKind != JsonValueKind.Null)
                {
                    if (mg.ValueKind != JsonValueKind.Number || !mg.TryGetDouble(out var v))
                    {
                        error = "repair-duct-continuity-by-scope.maxGapFt must be a number.";
                        return false;
                    }
                    if (v <= 0 || v > 50)
                    {
                        error = "repair-duct-continuity-by-scope.maxGapFt out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxRepairs", out var mr) && mr.ValueKind != JsonValueKind.Null)
                {
                    if (mr.ValueKind != JsonValueKind.Number || !mr.TryGetInt32(out var iv))
                    {
                        error = "repair-duct-continuity-by-scope.maxRepairs must be an integer.";
                        return false;
                    }
                    if (iv < 0 || iv > 64)
                    {
                        error = "repair-duct-continuity-by-scope.maxRepairs out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/get-connectors", StringComparison.OrdinalIgnoreCase))
            {
                // { elementIds:number[], includeAllRefs?:bool, includeCoordinateSystem?:bool, maxConnectorsPerElement?:int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "get-connectors body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "elementIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeAllRefs", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeCoordinateSystem", out error)) return false;

                if (obj.Value.TryGetProperty("maxConnectorsPerElement", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "get-connectors.maxConnectorsPerElement must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 512)
                    {
                        error = "get-connectors.maxConnectorsPerElement out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/align-room-tops-to-ceilings", StringComparison.OrdinalIgnoreCase))
            {
                // { roomNumbers?:string[], levelNameContains?:string, maxRooms?:int, dryRun?:bool, behavior?:string, toleranceFt?:number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "align-room-tops-to-ceilings body must be an object.";
                    return false;
                }
                if (!ValidateOptionalStringArray(obj.Value, "roomNumbers", maxCount: 5000, maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "toleranceFt", out error)) return false;

                if (obj.Value.TryGetProperty("maxRooms", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "align-room-tops-to-ceilings.maxRooms must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 20000)
                    {
                        error = "align-room-tops-to-ceilings.maxRooms out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("behavior", out var b) && b.ValueKind == JsonValueKind.String)
                {
                    var bv = (b.GetString() ?? "").Trim();
                    if (!bv.Equals("allOrNothing", StringComparison.OrdinalIgnoreCase) && !bv.Equals("bestEffort", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "align-room-tops-to-ceilings.behavior must be 'allOrNothing' or 'bestEffort'.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/delete", StringComparison.OrdinalIgnoreCase))
            {
                // { ids: number[], dryRun?: boolean, apply?: boolean, confirm?: string }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "delete body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "ids", maxCount: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    if (confirm.ValueKind != JsonValueKind.String)
                    {
                        error = "delete.confirm must be a string.";
                        return false;
                    }
                    var s = BulkConfirmUtil.Normalize(confirm.GetString());
                    if (s.Length > 80)
                    {
                        error = "delete.confirm is too long.";
                        return false;
                    }
                }

                // Bulk delete requires typed confirmation when applying.
                try
                {
                    var ids = obj.Value.GetProperty("ids");
                    var count = ids.ValueKind == JsonValueKind.Array ? ids.GetArrayLength() : 0;
                    var dryRun = obj.Value.TryGetProperty("dryRun", out var dr) && (dr.ValueKind == JsonValueKind.True || dr.ValueKind == JsonValueKind.False) && dr.GetBoolean();
                    var apply = !(obj.Value.TryGetProperty("apply", out var ap) && (ap.ValueKind == JsonValueKind.True || ap.ValueKind == JsonValueKind.False) && ap.GetBoolean() == false);

                    if (apply && !dryRun && count > 25)
                    {
                        var expected = BulkConfirmUtil.ExpectedDeleteElements(count);
                        var gotRaw = obj.Value.TryGetProperty("confirm", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "") : "";
                        if (!BulkConfirmUtil.EqualsNormalized(gotRaw, expected))
                        {
                            var gotNorm = BulkConfirmUtil.Normalize(gotRaw);
                            userError = new OperatorToolUserErrorException(
                                message: "Bulk delete requires typed confirmation.",
                                code: "bulk_confirm_required",
                                requiredConfirm: expected,
                                confirmReceived: gotNorm,
                                maxChangesPerCall: 10,
                                hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                            error = userError.Message;
                            return false;
                        }
                    }
                }
                catch
                {
                    // best effort; handler will still enforce
                }

                return true;
            }

            if (string.Equals(path, "/revit/move-elements", StringComparison.OrdinalIgnoreCase))
            {
                // { ids: number[], mode: "vector"|"fromTo", ... , dryRun?: bool, behavior?: string, options?: { failOnPinned?: bool, unpinIfAllowed?: bool } }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "move-elements body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "ids", maxCount: 200, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "mode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;

                var mode = (obj.Value.GetProperty("mode").GetString() ?? "").Trim();
                if (mode.Equals("vector", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredNumber(obj.Value, "vectorX", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "vectorY", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "vectorZ", out error)) return false;
                }
                else if (mode.Equals("fromTo", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredNumber(obj.Value, "fromX", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "fromY", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "fromZ", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "toX", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "toY", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "toZ", out error)) return false;
                }
                else
                {
                    error = "move-elements.mode must be 'vector' or 'fromTo'.";
                    return false;
                }

                if (obj.Value.TryGetProperty("options", out var options) && options.ValueKind != JsonValueKind.Null)
                {
                    if (options.ValueKind != JsonValueKind.Object)
                    {
                        error = "move-elements.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalBool(options, "failOnPinned", out error)) return false;
                    if (!ValidateOptionalBool(options, "unpinIfAllowed", out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/rotate-elements", StringComparison.OrdinalIgnoreCase))
            {
                // { ids: number[], angleDegrees:number, axis:{mode:"zThroughPoint",pointX,pointY,pointZ}, dryRun?:bool, behavior?:string, options?:{...} }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "rotate-elements body must be an object.";
                    return false;
                }

                if (!ValidateRequiredLongArray(obj.Value, "ids", maxCount: 200, out error)) return false;
                if (!ValidateRequiredNumber(obj.Value, "angleDegrees", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;

                if (!obj.Value.TryGetProperty("axis", out var axis) || axis.ValueKind != JsonValueKind.Object)
                {
                    error = "rotate-elements.axis must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(axis, "mode", maxLen: 32, out error)) return false;
                var mode = (axis.GetProperty("mode").GetString() ?? "").Trim();
                if (mode.Equals("zThroughPoint", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredNumber(axis, "pointX", out error)) return false;
                    if (!ValidateRequiredNumber(axis, "pointY", out error)) return false;
                    if (!ValidateRequiredNumber(axis, "pointZ", out error)) return false;
                }
                else
                {
                    error = "rotate-elements.axis.mode must be 'zThroughPoint'.";
                    return false;
                }

                if (obj.Value.TryGetProperty("options", out var options) && options.ValueKind != JsonValueKind.Null)
                {
                    if (options.ValueKind != JsonValueKind.Object)
                    {
                        error = "rotate-elements.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalBool(options, "failOnPinned", out error)) return false;
                    if (!ValidateOptionalBool(options, "unpinIfAllowed", out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/align-elements", StringComparison.OrdinalIgnoreCase))
            {
                // { sourceElementId:number, source:{kind:"face",side}, targetElementId:number, target:{kind:"face",side}, axis:"viewX"|"viewY", viewId?:number, dryRun?:bool, behavior?:string, options?:{...} }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "align-elements body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "sourceElementId", out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "targetElementId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "axis", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;

                if (!obj.Value.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.Object)
                {
                    error = "align-elements.source must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(source, "kind", maxLen: 16, out error)) return false;
                if (!ValidateRequiredString(source, "side", maxLen: 16, out error)) return false;

                if (!obj.Value.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.Object)
                {
                    error = "align-elements.target must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(target, "kind", maxLen: 16, out error)) return false;
                if (!ValidateRequiredString(target, "side", maxLen: 16, out error)) return false;

                if (obj.Value.TryGetProperty("options", out var options) && options.ValueKind != JsonValueKind.Null)
                {
                    if (options.ValueKind != JsonValueKind.Object)
                    {
                        error = "align-elements.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalBool(options, "failOnPinned", out error)) return false;
                    if (!ValidateOptionalNumber(options, "minAbsNormalDot", out error)) return false;
                    if (!ValidateOptionalNumber(options, "zeroToleranceFt", out error)) return false;
                    if (!ValidateOptionalBool(options, "exportPreviewImage", out error)) return false;
                    if (!ValidateOptionalInt(options, "previewImageSize", out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/measure-gap", StringComparison.OrdinalIgnoreCase))
            {
                // { sourceElementId:number, source:{kind:"face",side}, targetElementId:number, target:{kind:"face",side}, axis:"viewX"|"viewY", viewId?:number, options?:{...} }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "measure-gap body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "sourceElementId", out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "targetElementId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "axis", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;

                if (!obj.Value.TryGetProperty("source", out var source) || source.ValueKind != JsonValueKind.Object)
                {
                    error = "measure-gap.source must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(source, "kind", maxLen: 16, out error)) return false;
                if (!ValidateRequiredString(source, "side", maxLen: 16, out error)) return false;

                if (!obj.Value.TryGetProperty("target", out var target) || target.ValueKind != JsonValueKind.Object)
                {
                    error = "measure-gap.target must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(target, "kind", maxLen: 16, out error)) return false;
                if (!ValidateRequiredString(target, "side", maxLen: 16, out error)) return false;

                if (obj.Value.TryGetProperty("options", out var options) && options.ValueKind != JsonValueKind.Null)
                {
                    if (options.ValueKind != JsonValueKind.Object)
                    {
                        error = "measure-gap.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalNumber(options, "minAbsNormalDot", out error)) return false;
                    if (!ValidateOptionalNumber(options, "zeroToleranceFt", out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/room-align-wall-to-nearest-column", StringComparison.OrdinalIgnoreCase))
            {
                // { roomNumber:string, wallSide:"left"|"right"|"top"|"bottom", columnSearchRadiusFt?:number, viewId?:number, dryRun?:bool, options?:{...} }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "room-align-wall-to-nearest-column body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "wallSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "columnSearchRadiusFt", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("options", out var options) && options.ValueKind != JsonValueKind.Null)
                {
                    if (options.ValueKind != JsonValueKind.Object)
                    {
                        error = "room-align-wall-to-nearest-column.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalBool(options, "failOnPinned", out error)) return false;
                    if (!ValidateOptionalNumber(options, "minAbsNormalDot", out error)) return false;
                    if (!ValidateOptionalNumber(options, "zeroToleranceFt", out error)) return false;
                    if (!ValidateOptionalBool(options, "exportPreviewImage", out error)) return false;
                    if (!ValidateOptionalInt(options, "previewImageSize", out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/set-parameter", StringComparison.OrdinalIgnoreCase))
            {
                // { changes: [{ elementId, parameterName, value }], dryRun?: boolean, apply?: boolean, confirm?: string, excludeElementIds?: number[] }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "set-parameter body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("changes", out var changes) || changes.ValueKind == JsonValueKind.Null)
                {
                    error = "set-parameter.changes is required.";
                    return false;
                }
                if (changes.ValueKind != JsonValueKind.Array)
                {
                    error = "set-parameter.changes must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var ch in changes.EnumerateArray())
                {
                    count++;
                    if (count > 100)
                    {
                        error = "set-parameter.changes too large.";
                        return false;
                    }
                    if (ch.ValueKind != JsonValueKind.Object)
                    {
                        error = "set-parameter.changes items must be objects.";
                        return false;
                    }
                    if (!ValidateRequiredLong(ch, "elementId", out error)) return false;
                    if (!ValidateRequiredString(ch, "parameterName", maxLen: 128, out error)) return false;
                    if (!ValidateRequiredString(ch, "value", maxLen: 256, out error)) return false;
                }

                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("excludeElementIds", out var ex) && ex.ValueKind != JsonValueKind.Null)
                {
                    if (ex.ValueKind != JsonValueKind.Array)
                    {
                        error = "set-parameter.excludeElementIds must be an array.";
                        return false;
                    }
                    var n = 0;
                    foreach (var item in ex.EnumerateArray())
                    {
                        n++;
                        if (n > 200)
                        {
                            error = "set-parameter.excludeElementIds too large.";
                            return false;
                        }
                        if (item.ValueKind != JsonValueKind.Number || !item.TryGetInt64(out _))
                        {
                            error = "set-parameter.excludeElementIds must be an array of integers.";
                            return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    if (confirm.ValueKind != JsonValueKind.String)
                    {
                        error = "set-parameter.confirm must be a string.";
                        return false;
                    }
                    var s = BulkConfirmUtil.Normalize(confirm.GetString());
                    if (s.Length > 80)
                    {
                        error = "set-parameter.confirm is too long.";
                        return false;
                    }
                }

                // Bulk set-parameter requires typed confirmation when applying.
                try
                {
                    var changesCount = changes.GetArrayLength();
                    var dryRun = obj.Value.TryGetProperty("dryRun", out var dr) && (dr.ValueKind == JsonValueKind.True || dr.ValueKind == JsonValueKind.False) && dr.GetBoolean();
                    var apply = !(obj.Value.TryGetProperty("apply", out var ap) && (ap.ValueKind == JsonValueKind.True || ap.ValueKind == JsonValueKind.False) && ap.GetBoolean() == false);

                    if (apply && !dryRun && changesCount > 25)
                    {
                        var expected = BulkConfirmUtil.ExpectedApplyChanges(changesCount);
                        var gotRaw = obj.Value.TryGetProperty("confirm", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "") : "";
                        if (!BulkConfirmUtil.EqualsNormalized(gotRaw, expected))
                        {
                            var gotNorm = BulkConfirmUtil.Normalize(gotRaw);
                            userError = new OperatorToolUserErrorException(
                                message: "Bulk parameter edit requires typed confirmation.",
                                code: "bulk_confirm_required",
                                requiredConfirm: expected,
                                confirmReceived: gotNorm,
                                maxChangesPerCall: 10,
                                hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                            error = userError.Message;
                            return false;
                        }
                    }
                }
                catch
                {
                    // best effort; handler will still enforce
                }
                return true;
            }

            if (string.Equals(path, "/revit/create-sheet", StringComparison.OrdinalIgnoreCase))
            {
                // { name?, number?, titleBlockId?, titleBlockName?, referenceSheetNumber?, placeholder?, convertPlaceholderSheetId? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-sheet body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "number", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleBlockId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "titleBlockName", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "referenceSheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "placeholder", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "convertPlaceholderSheetId", out error)) return false;

                var hasConvert = obj.Value.TryGetProperty("convertPlaceholderSheetId", out var convertEl) &&
                                 convertEl.ValueKind != JsonValueKind.Null;
                var hasPlaceholder = obj.Value.TryGetProperty("placeholder", out var placeholderEl) &&
                                     placeholderEl.ValueKind == JsonValueKind.True;
                if (hasConvert && hasPlaceholder)
                {
                    error = "create-sheet cannot set placeholder:true with convertPlaceholderSheetId.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-sheets", StringComparison.OrdinalIgnoreCase))
            {
                // { sheets?:[{name?,number?,titleBlockId?,titleBlockName?,referenceSheetNumber?,placeholder?,convertPlaceholderSheetId?}], sourceCsvPath?, csvDelimiter?, titleBlockIdDefault?:number, titleBlockNameDefault?, referenceSheetNumberDefault?, behavior?:string, dryRun?:bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-sheets body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "sourceCsvPath", maxLen: 320, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "csvDelimiter", maxLen: 16, out error)) return false;

                var hasCsvPath = obj.Value.TryGetProperty("sourceCsvPath", out var csvPathEl) &&
                                 csvPathEl.ValueKind == JsonValueKind.String &&
                                 !string.IsNullOrWhiteSpace(csvPathEl.GetString());

                var hasSheets = obj.Value.TryGetProperty("sheets", out var sheets) && sheets.ValueKind == JsonValueKind.Array;
                if (!hasSheets && !hasCsvPath)
                {
                    error = "create-sheets requires sheets[] or sourceCsvPath.";
                    return false;
                }

                if (obj.Value.TryGetProperty("sheets", out sheets) && sheets.ValueKind != JsonValueKind.Null)
                {
                    if (sheets.ValueKind != JsonValueKind.Array)
                    {
                        error = "create-sheets.sheets must be an array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var s in sheets.EnumerateArray())
                    {
                        count++;
                        if (count > 200)
                        {
                            error = "create-sheets.sheets too large.";
                            return false;
                        }
                        if (s.ValueKind != JsonValueKind.Object)
                        {
                            error = "create-sheets.sheets items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(s, "name", maxLen: 200, out error)) return false;
                        if (!ValidateOptionalString(s, "number", maxLen: 64, out error)) return false;
                        if (!ValidateOptionalLong(s, "titleBlockId", out error)) return false;
                        if (!ValidateOptionalString(s, "titleBlockName", maxLen: 200, out error)) return false;
                        if (!ValidateOptionalString(s, "referenceSheetNumber", maxLen: 64, out error)) return false;
                        if (!ValidateOptionalBool(s, "placeholder", out error)) return false;
                        if (!ValidateOptionalLong(s, "convertPlaceholderSheetId", out error)) return false;

                        var hasConvert = s.TryGetProperty("convertPlaceholderSheetId", out var convertEl) &&
                                         convertEl.ValueKind != JsonValueKind.Null;
                        var hasPlaceholder = s.TryGetProperty("placeholder", out var placeholderEl) &&
                                             placeholderEl.ValueKind == JsonValueKind.True;
                        if (hasConvert && hasPlaceholder)
                        {
                            error = "create-sheets.sheets[] cannot set placeholder:true with convertPlaceholderSheetId.";
                            return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("csvDelimiter", out var delimiterEl) &&
                    delimiterEl.ValueKind == JsonValueKind.String)
                {
                    var delimiter = (delimiterEl.GetString() ?? "").Trim();
                    if (delimiter.Length > 0 &&
                        !(delimiter.Equals("comma", StringComparison.OrdinalIgnoreCase) ||
                          delimiter.Equals("tab", StringComparison.OrdinalIgnoreCase) ||
                          delimiter.Equals("semicolon", StringComparison.OrdinalIgnoreCase) ||
                          delimiter.Equals("pipe", StringComparison.OrdinalIgnoreCase) ||
                          delimiter.Length == 1))
                    {
                        error = "create-sheets.csvDelimiter must be comma|tab|semicolon|pipe or a single character.";
                        return false;
                    }
                }
                if (!ValidateOptionalLong(obj.Value, "titleBlockIdDefault", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "titleBlockNameDefault", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "referenceSheetNumberDefault", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/place-view", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetId?|sheetNumber?|sheetQuery?, sheetExact?, viewId?|viewName?|viewQuery?, viewExact?, x?, y?, moveIfAlreadyPlaced?, avoidOverlap?, lockViewport?, viewportTypeId?|viewportTypeName?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "place-view body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "sheetId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetQuery", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "sheetExact", out error)) return false;

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewQuery", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "viewExact", out error)) return false;

                if (!ValidateOptionalNumber(obj.Value, "x", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "y", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "moveIfAlreadyPlaced", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "avoidOverlap", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "lockViewport", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewportTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewportTypeName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasSheetId = obj.Value.TryGetProperty("sheetId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasSheetNumber = obj.Value.TryGetProperty("sheetNumber", out var sn) &&
                                     sn.ValueKind == JsonValueKind.String &&
                                     !string.IsNullOrWhiteSpace(sn.GetString());
                var hasSheetQuery = obj.Value.TryGetProperty("sheetQuery", out var sq) &&
                                    sq.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(sq.GetString());
                if (!hasSheetId && !hasSheetNumber && !hasSheetQuery)
                {
                    error = "place-view requires sheetId, sheetNumber, or sheetQuery.";
                    return false;
                }

                var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                var hasViewName = obj.Value.TryGetProperty("viewName", out var vn) &&
                                  vn.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrWhiteSpace(vn.GetString());
                var hasViewQuery = obj.Value.TryGetProperty("viewQuery", out var vq) &&
                                   vq.ValueKind == JsonValueKind.String &&
                                   !string.IsNullOrWhiteSpace(vq.GetString());
                if (!hasViewId && !hasViewName && !hasViewQuery)
                {
                    error = "place-view requires viewId, viewName, or viewQuery.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/place-views", StringComparison.OrdinalIgnoreCase))
            {
                // { placements:[{sheetId?|sheetNumber?|sheetQuery?,sheetExact?,viewId?|viewName?|viewQuery?,viewExact?,x?,y?,moveIfAlreadyPlaced?,avoidOverlap?,lockViewport?,viewportTypeId?|viewportTypeName?}], behavior?:string, dryRun?:bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "place-views body must be an object.";
                    return false;
                }
                if (!obj.Value.TryGetProperty("placements", out var placements) || placements.ValueKind != JsonValueKind.Array)
                {
                    error = "place-views.placements must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var pl in placements.EnumerateArray())
                {
                    count++;
                    if (count > 200)
                    {
                        error = "place-views.placements too large.";
                        return false;
                    }
                    if (pl.ValueKind != JsonValueKind.Object)
                    {
                        error = "place-views.placements items must be objects.";
                        return false;
                    }
                    if (!ValidateOptionalLong(pl, "sheetId", out error)) return false;
                    if (!ValidateOptionalString(pl, "sheetNumber", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(pl, "sheetQuery", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalBool(pl, "sheetExact", out error)) return false;

                    if (!ValidateOptionalLong(pl, "viewId", out error)) return false;
                    if (!ValidateOptionalString(pl, "viewName", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalString(pl, "viewQuery", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalBool(pl, "viewExact", out error)) return false;

                    if (!ValidateOptionalNumber(pl, "x", out error)) return false;
                    if (!ValidateOptionalNumber(pl, "y", out error)) return false;
                    if (!ValidateOptionalBool(pl, "moveIfAlreadyPlaced", out error)) return false;
                    if (!ValidateOptionalBool(pl, "avoidOverlap", out error)) return false;
                    if (!ValidateOptionalBool(pl, "lockViewport", out error)) return false;
                    if (!ValidateOptionalLong(pl, "viewportTypeId", out error)) return false;
                    if (!ValidateOptionalString(pl, "viewportTypeName", maxLen: 128, out error)) return false;

                    var hasSheetId = pl.TryGetProperty("sheetId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasSheetNumber = pl.TryGetProperty("sheetNumber", out var sn) &&
                                         sn.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(sn.GetString());
                    var hasSheetQuery = pl.TryGetProperty("sheetQuery", out var sq) &&
                                        sq.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(sq.GetString());
                    if (!hasSheetId && !hasSheetNumber && !hasSheetQuery)
                    {
                        error = "place-views.placements[] requires sheetId, sheetNumber, or sheetQuery.";
                        return false;
                    }

                    var hasViewId = pl.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                    var hasViewName = pl.TryGetProperty("viewName", out var vn) &&
                                      vn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(vn.GetString());
                    var hasViewQuery = pl.TryGetProperty("viewQuery", out var vq) &&
                                       vq.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(vq.GetString());
                    if (!hasViewId && !hasViewName && !hasViewQuery)
                    {
                        error = "place-views.placements[] requires viewId, viewName, or viewQuery.";
                        return false;
                    }
                }
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/align-viewports", StringComparison.OrdinalIgnoreCase))
            {
                // { referenceSheetId?|referenceSheetNumber?|referenceSheetQuery?,referenceViewportId?, sheetIds?|sheetNumbers?|sheetNumberPrefix?|sheetQuery?|viewportIds?, primaryOnly?, viewNameContains?, mode?, anchorStrategy?, alignTo?, horizontal?, vertical?, offsetX?, offsetY?, modelAnchor?, modelAnchorElementId?, modelAnchorElementPoint?, dryRun?, options? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "align-viewports body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "referenceSheetId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "referenceSheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "referenceSheetQuery", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "referenceViewportId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "sheetIds", maxCount: 200, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sheetNumbers", maxCount: 200, maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumberPrefix", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetQuery", maxLen: 160, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "viewportIds", maxCount: 500, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "primaryOnly", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewNameContains", maxLen: 160, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "anchorStrategy", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "alignTo", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "horizontal", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "vertical", maxLen: 32, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "offsetX", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "offsetY", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "modelAnchorElementId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "modelAnchorElementPoint", maxLen: 32, out error)) return false;

                if (obj.Value.TryGetProperty("modelAnchor", out var ma) && ma.ValueKind != JsonValueKind.Null)
                {
                    if (ma.ValueKind != JsonValueKind.Object)
                    {
                        error = "align-viewports.modelAnchor must be an object.";
                        return false;
                    }
                    if (!ValidateRequiredNumber(ma, "x", out error)) return false;
                    if (!ValidateRequiredNumber(ma, "y", out error)) return false;
                    if (!ValidateRequiredNumber(ma, "z", out error)) return false;
                }

                if (obj.Value.TryGetProperty("options", out var opts) && opts.ValueKind != JsonValueKind.Null)
                {
                    if (opts.ValueKind != JsonValueKind.Object)
                    {
                        error = "align-viewports.options must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalBool(opts, "failOnPinned", out error)) return false;
                    if (!ValidateOptionalBool(opts, "unpinIfAllowed", out error)) return false;
                    if (!ValidateOptionalBool(opts, "boundaryCheck", out error)) return false;
                    if (!ValidateOptionalString(opts, "boundaryPolicy", maxLen: 32, out error)) return false;
                    if (!ValidateOptionalNumber(opts, "boundaryMarginInches", out error)) return false;
                }

                // If explicitly in modelAnchor mode, allow the handler's default referenceCropCenter
                // anchor derivation; only explicit/element strategies require their matching source.
                try
                {
                    var m = obj.Value.TryGetProperty("mode", out var mm) && mm.ValueKind == JsonValueKind.String ? (mm.GetString() ?? "") : "";
                    if (m.Equals("modelAnchor", StringComparison.OrdinalIgnoreCase))
                    {
                        var strategy = obj.Value.TryGetProperty("anchorStrategy", out var st) && st.ValueKind == JsonValueKind.String ? (st.GetString() ?? "") : "";
                        var hasAnchorObj = obj.Value.TryGetProperty("modelAnchor", out var ao) && ao.ValueKind == JsonValueKind.Object;
                        var hasAnchorEl = obj.Value.TryGetProperty("modelAnchorElementId", out var eid) && eid.ValueKind == JsonValueKind.Number;
                        if (strategy.Equals("explicit", StringComparison.OrdinalIgnoreCase) && !hasAnchorObj)
                        {
                            error = "align-viewports: anchorStrategy=explicit requires modelAnchor.";
                            return false;
                        }
                        if (strategy.Equals("element", StringComparison.OrdinalIgnoreCase) && !hasAnchorEl)
                        {
                            error = "align-viewports: anchorStrategy=element requires modelAnchorElementId.";
                            return false;
                        }
                    }
                }
                catch { }

                return true;
            }

            if (string.Equals(path, "/revit/visibility", StringComparison.OrdinalIgnoreCase))
            {
                // { viewId?, action?, categoryName?|categoryNames?, templateName?, scale?, detailLevel?, discipline?, phaseId?|phaseName?, phaseFilterId?|phaseFilterName?, elementIds?, underlayLevelId?|underlayLevelName?, underlayTopLevelId?|underlayTopLevelName?, boxMin?, boxMax?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "visibility body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "action", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categoryNames", maxCount: 200, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "templateName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "filterId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "filterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "filterVisible", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "lineWeight", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "linePatternId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "linePatternName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "r", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "g", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "b", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ruleParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ruleOperator", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ruleValue", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "ruleCaseSensitive", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "detailLevel", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "discipline", maxLen: 32, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "phaseId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "phaseName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "phaseFilterId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "phaseFilterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "elementIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "underlayLevelId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "underlayLevelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "underlayTopLevelId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "underlayTopLevelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "underlayOrientation", maxLen: 32, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "scopeBoxId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scopeBoxName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeLinkedModels", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "linkedModelInstanceId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "linkedModelId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "revitLinkInstanceId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "linkedModelName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "revitLinkName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "linkName", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("boxMin", out var bmin) && bmin.ValueKind != JsonValueKind.Null)
                {
                    if (bmin.ValueKind != JsonValueKind.Object) { error = "visibility.boxMin must be an object."; return false; }
                    if (!ValidateRequiredNumber(bmin, "x", out error)) return false;
                    if (!ValidateRequiredNumber(bmin, "y", out error)) return false;
                    if (!ValidateRequiredNumber(bmin, "z", out error)) return false;
                }

                if (obj.Value.TryGetProperty("boxMax", out var bmax) && bmax.ValueKind != JsonValueKind.Null)
                {
                    if (bmax.ValueKind != JsonValueKind.Object) { error = "visibility.boxMax must be an object."; return false; }
                    if (!ValidateRequiredNumber(bmax, "x", out error)) return false;
                    if (!ValidateRequiredNumber(bmax, "y", out error)) return false;
                    if (!ValidateRequiredNumber(bmax, "z", out error)) return false;
                }

                if (obj.Value.TryGetProperty("scale", out var sc) && sc.ValueKind != JsonValueKind.Null)
                {
                    if (sc.ValueKind != JsonValueKind.Number || !sc.TryGetInt32(out var sv))
                    {
                        error = "visibility.scale must be an integer.";
                        return false;
                    }
                    if (sv < 1 || sv > 1000)
                    {
                        error = "visibility.scale out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("annotationCropMarginFeet", out var acm) && acm.ValueKind != JsonValueKind.Null)
                {
                    if (acm.ValueKind != JsonValueKind.Number || !acm.TryGetDouble(out var av) || av < 0 || av > 10)
                    {
                        error = "visibility.annotationCropMarginFeet must be a number in range [0,10].";
                        return false;
                    }
                }

                if (!ValidateOptionalBool(obj.Value, "annotationCropActive", out error)) return false;

                var visibilityAction = "get";
                if (obj.Value.TryGetProperty("action", out var act) && act.ValueKind == JsonValueKind.String)
                {
                    visibilityAction = (act.GetString() ?? "").Trim().ToLowerInvariant();
                }

                var valid = visibilityAction == "get" ||
                            visibilityAction == "set_template" ||
                            visibilityAction == "hide_category" ||
                            visibilityAction == "show_category" ||
                            visibilityAction == "set_scale" ||
                            visibilityAction == "set_detail_level" ||
                            visibilityAction == "set_discipline" ||
                            visibilityAction == "set_phase" ||
                            visibilityAction == "set_phase_filter" ||
                            visibilityAction == "set_section_box" ||
                            visibilityAction == "clear_section_box" ||
                            visibilityAction == "set_crop_box" ||
                            visibilityAction == "clear_crop_box" ||
                            visibilityAction == "set_scope_box" ||
                            visibilityAction == "clear_scope_box" ||
                            visibilityAction == "set_underlay" ||
                            visibilityAction == "clear_underlay" ||
                            visibilityAction == "set_category_override" ||
                            visibilityAction == "clear_category_override" ||
                            visibilityAction == "apply_view_filter" ||
                            visibilityAction == "create_view_filter" ||
                            visibilityAction == "remove_view_filter" ||
                            visibilityAction == "clear_filter_override" ||
                            visibilityAction == "isolate_elements_temp" ||
                            visibilityAction == "isolate_categories_temp" ||
                            visibilityAction == "clear_temp_hide_isolate" ||
                            visibilityAction == "reveal_hidden_on" ||
                            visibilityAction == "reveal_hidden_off" ||
                            visibilityAction == "hide_elements" ||
                            visibilityAction == "unhide_elements";
                if (!valid)
                {
                    error = "visibility.action must be get|set_template|hide_category|show_category|set_scale|set_detail_level|set_discipline|set_phase|set_phase_filter|set_section_box|clear_section_box|set_crop_box|clear_crop_box|set_scope_box|clear_scope_box|set_underlay|clear_underlay|set_category_override|clear_category_override|apply_view_filter|create_view_filter|remove_view_filter|clear_filter_override|isolate_elements_temp|isolate_categories_temp|clear_temp_hide_isolate|reveal_hidden_on|reveal_hidden_off|hide_elements|unhide_elements.";
                    return false;
                }

                if (visibilityAction == "hide_category" || visibilityAction == "show_category")
                {
                    var hasCategory = obj.Value.TryGetProperty("categoryName", out var cn) &&
                                      cn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(cn.GetString());
                    if (!hasCategory)
                    {
                        error = "visibility.hide/show requires categoryName.";
                        return false;
                    }
                }

                if (visibilityAction == "set_scale")
                {
                    var hasScale = obj.Value.TryGetProperty("scale", out var scv) && scv.ValueKind != JsonValueKind.Null;
                    if (!hasScale)
                    {
                        error = "visibility.set_scale requires scale.";
                        return false;
                    }
                }

                if (visibilityAction == "set_detail_level")
                {
                    var hasDetailLevel = obj.Value.TryGetProperty("detailLevel", out var dl) &&
                                         dl.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(dl.GetString());
                    if (!hasDetailLevel)
                    {
                        error = "visibility.set_detail_level requires detailLevel.";
                        return false;
                    }
                }

                if (visibilityAction == "set_discipline")
                {
                    var hasDiscipline = obj.Value.TryGetProperty("discipline", out var dp) &&
                                        dp.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(dp.GetString());
                    if (!hasDiscipline)
                    {
                        error = "visibility.set_discipline requires discipline.";
                        return false;
                    }
                }

                if (visibilityAction == "set_phase")
                {
                    var hasPhaseId = obj.Value.TryGetProperty("phaseId", out var pid) && pid.ValueKind != JsonValueKind.Null;
                    var hasPhaseName = obj.Value.TryGetProperty("phaseName", out var pname) &&
                                       pname.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(pname.GetString());
                    if (!hasPhaseId && !hasPhaseName)
                    {
                        error = "visibility.set_phase requires phaseId or phaseName.";
                        return false;
                    }
                }

                if (visibilityAction == "set_phase_filter")
                {
                    var hasPhaseFilterId = obj.Value.TryGetProperty("phaseFilterId", out var pfid) && pfid.ValueKind != JsonValueKind.Null;
                    var hasPhaseFilterName = obj.Value.TryGetProperty("phaseFilterName", out var pfname) &&
                                             pfname.ValueKind == JsonValueKind.String &&
                                             !string.IsNullOrWhiteSpace(pfname.GetString());
                    if (!hasPhaseFilterId && !hasPhaseFilterName)
                    {
                        error = "visibility.set_phase_filter requires phaseFilterId or phaseFilterName.";
                        return false;
                    }
                }

                if (visibilityAction == "set_section_box")
                {
                    var hasMin = obj.Value.TryGetProperty("boxMin", out var minObj) && minObj.ValueKind == JsonValueKind.Object;
                    var hasMax = obj.Value.TryGetProperty("boxMax", out var maxObj) && maxObj.ValueKind == JsonValueKind.Object;
                    if (!hasMin || !hasMax)
                    {
                        error = "visibility.set_section_box requires boxMin and boxMax.";
                        return false;
                    }
                }

                if (visibilityAction == "set_crop_box")
                {
                    var hasMin = obj.Value.TryGetProperty("boxMin", out var minObj) && minObj.ValueKind == JsonValueKind.Object;
                    var hasMax = obj.Value.TryGetProperty("boxMax", out var maxObj) && maxObj.ValueKind == JsonValueKind.Object;
                    if (!hasMin || !hasMax)
                    {
                        error = "visibility.set_crop_box requires boxMin and boxMax.";
                        return false;
                    }
                }

                if (visibilityAction == "set_underlay")
                {
                    var hasLevelId = obj.Value.TryGetProperty("underlayLevelId", out var lid) && lid.ValueKind != JsonValueKind.Null;
                    var hasLevelName = obj.Value.TryGetProperty("underlayLevelName", out var lname) &&
                                       lname.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(lname.GetString());
                    if (!hasLevelId && !hasLevelName)
                    {
                        error = "visibility.set_underlay requires underlayLevelId or underlayLevelName.";
                        return false;
                    }

                    if (obj.Value.TryGetProperty("underlayOrientation", out var uo) && uo.ValueKind == JsonValueKind.String)
                    {
                        var v = (uo.GetString() ?? "").Trim().ToLowerInvariant();
                        if (!(v == "look_down" || v == "lookdown" || v == "down" || v == "look_up" || v == "lookup" || v == "up"))
                        {
                            error = "visibility.underlayOrientation must be look_down or look_up.";
                            return false;
                        }
                    }
                }

                if (visibilityAction == "set_category_override" || visibilityAction == "clear_category_override")
                {
                    var hasCategory = obj.Value.TryGetProperty("categoryName", out var cn) &&
                                      cn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(cn.GetString());
                    if (!hasCategory)
                    {
                        error = "visibility.category override requires categoryName.";
                        return false;
                    }
                }

                if (visibilityAction == "set_category_override")
                {
                    var hasWeight = obj.Value.TryGetProperty("lineWeight", out var lw) && lw.ValueKind != JsonValueKind.Null;
                    var hasPatternId = obj.Value.TryGetProperty("linePatternId", out var lpid) && lpid.ValueKind != JsonValueKind.Null;
                    var hasPatternName = obj.Value.TryGetProperty("linePatternName", out var lpn) &&
                                         lpn.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(lpn.GetString());
                    var anyPattern = hasPatternId || hasPatternName;
                    if (hasWeight)
                    {
                        if (lw.ValueKind != JsonValueKind.Number || !lw.TryGetInt32(out var w) || w < 1 || w > 16)
                        {
                            error = "visibility.lineWeight must be an integer in range [1,16].";
                            return false;
                        }
                    }

                    var hasR = obj.Value.TryGetProperty("r", out var rv) && rv.ValueKind != JsonValueKind.Null;
                    var hasG = obj.Value.TryGetProperty("g", out var gv) && gv.ValueKind != JsonValueKind.Null;
                    var hasB = obj.Value.TryGetProperty("b", out var bv) && bv.ValueKind != JsonValueKind.Null;
                    var anyRgb = hasR || hasG || hasB;
                    if (anyRgb && !(hasR && hasG && hasB))
                    {
                        error = "visibility.set_category_override requires r, g, b together.";
                        return false;
                    }

                    if (hasR && hasG && hasB)
                    {
                        if (!rv.TryGetInt32(out var r) || !gv.TryGetInt32(out var g) || !bv.TryGetInt32(out var b) ||
                            r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
                        {
                            error = "visibility color channels r,g,b must be integers in range [0,255].";
                            return false;
                        }
                    }

                    if (!hasWeight && !anyPattern && !anyRgb)
                    {
                        error = "visibility.set_category_override requires lineWeight and/or linePatternId|linePatternName and/or r,g,b.";
                        return false;
                    }
                }

                if (visibilityAction == "set_scope_box")
                {
                    var hasScopeId = obj.Value.TryGetProperty("scopeBoxId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasScopeName = obj.Value.TryGetProperty("scopeBoxName", out var sname) &&
                                       sname.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(sname.GetString());
                    if (!hasScopeId && !hasScopeName)
                    {
                        error = "visibility.set_scope_box requires scopeBoxId or scopeBoxName.";
                        return false;
                    }
                }

                if (visibilityAction == "apply_view_filter" ||
                    visibilityAction == "remove_view_filter" ||
                    visibilityAction == "clear_filter_override")
                {
                    var hasFilterId = obj.Value.TryGetProperty("filterId", out var fid) && fid.ValueKind != JsonValueKind.Null;
                    var hasFilterName = obj.Value.TryGetProperty("filterName", out var fname) &&
                                        fname.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(fname.GetString());
                    if (!hasFilterId && !hasFilterName)
                    {
                        error = "visibility view-filter actions require filterId or filterName.";
                        return false;
                    }
                }

                if (visibilityAction == "apply_view_filter")
                {
                    var hasWeight = obj.Value.TryGetProperty("lineWeight", out var lw) && lw.ValueKind != JsonValueKind.Null;
                    if (hasWeight)
                    {
                        if (lw.ValueKind != JsonValueKind.Number || !lw.TryGetInt32(out var w) || w < 1 || w > 16)
                        {
                            error = "visibility.lineWeight must be an integer in range [1,16].";
                            return false;
                        }
                    }

                    var hasR = obj.Value.TryGetProperty("r", out var rv) && rv.ValueKind != JsonValueKind.Null;
                    var hasG = obj.Value.TryGetProperty("g", out var gv) && gv.ValueKind != JsonValueKind.Null;
                    var hasB = obj.Value.TryGetProperty("b", out var bv) && bv.ValueKind != JsonValueKind.Null;
                    var anyRgb = hasR || hasG || hasB;
                    if (anyRgb && !(hasR && hasG && hasB))
                    {
                        error = "visibility.apply_view_filter requires r, g, b together.";
                        return false;
                    }
                    if (hasR && hasG && hasB)
                    {
                        if (!rv.TryGetInt32(out var r) || !gv.TryGetInt32(out var g) || !bv.TryGetInt32(out var b) ||
                            r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255)
                        {
                            error = "visibility color channels r,g,b must be integers in range [0,255].";
                            return false;
                        }
                    }
                }

                if (visibilityAction == "create_view_filter")
                {
                    var hasFilterName = obj.Value.TryGetProperty("filterName", out var fn) &&
                                        fn.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(fn.GetString());
                    if (!hasFilterName)
                    {
                        error = "visibility.create_view_filter requires filterName.";
                        return false;
                    }

                    var hasCategory = obj.Value.TryGetProperty("categoryName", out var cn) &&
                                      cn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(cn.GetString());
                    var hasCategoryNames = obj.Value.TryGetProperty("categoryNames", out var cns) &&
                                           cns.ValueKind == JsonValueKind.Array &&
                                           cns.GetArrayLength() > 0;
                    if (!hasCategory && !hasCategoryNames)
                    {
                        error = "visibility.create_view_filter requires categoryName or categoryNames.";
                        return false;
                    }

                    var hasRuleParameter = obj.Value.TryGetProperty("ruleParameterName", out var rp) &&
                                           rp.ValueKind == JsonValueKind.String &&
                                           !string.IsNullOrWhiteSpace(rp.GetString());
                    if (!hasRuleParameter)
                    {
                        error = "visibility.create_view_filter requires ruleParameterName.";
                        return false;
                    }
                }

                if (visibilityAction == "isolate_elements_temp" ||
                    visibilityAction == "hide_elements" ||
                    visibilityAction == "unhide_elements")
                {
                    var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) &&
                                        eids.ValueKind == JsonValueKind.Array &&
                                        eids.GetArrayLength() > 0;
                    if (!hasElementIds)
                    {
                        error = "visibility element actions require elementIds.";
                        return false;
                    }
                }

                if (visibilityAction == "isolate_categories_temp")
                {
                    var hasCategory = obj.Value.TryGetProperty("categoryName", out var cn) &&
                                      cn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(cn.GetString());
                    var hasCategoryNames = obj.Value.TryGetProperty("categoryNames", out var cns) &&
                                           cns.ValueKind == JsonValueKind.Array &&
                                           cns.GetArrayLength() > 0;
                    if (!hasCategory && !hasCategoryNames)
                    {
                        error = "visibility.isolate_categories_temp requires categoryName or categoryNames.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/datums", StringComparison.OrdinalIgnoreCase))
            {
                // { action?, viewId?, datumType?, datumIds?, nameContains?, max?, scopeBoxId?, scopeBoxName?, bubbleVisible?, bubbleEnd?, p1?, p2?, elevation?, name?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "datums body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 48, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "datumType", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "datumIds", maxCount: 1000, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "nameContains", maxLen: 200, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "scopeBoxId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scopeBoxName", maxLen: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "bubbleVisible", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "bubbleEnd", maxLen: 16, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "elevation", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 120, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (obj.Value.TryGetProperty("p1", out var p1) && p1.ValueKind != JsonValueKind.Null)
                {
                    if (p1.ValueKind != JsonValueKind.Object) { error = "datums.p1 must be an object."; return false; }
                    if (!ValidateRequiredNumber(p1, "x", out error)) return false;
                    if (!ValidateRequiredNumber(p1, "y", out error)) return false;
                    if (!ValidateOptionalNumber(p1, "z", out error)) return false;
                }
                if (obj.Value.TryGetProperty("p2", out var p2) && p2.ValueKind != JsonValueKind.Null)
                {
                    if (p2.ValueKind != JsonValueKind.Object) { error = "datums.p2 must be an object."; return false; }
                    if (!ValidateRequiredNumber(p2, "x", out error)) return false;
                    if (!ValidateRequiredNumber(p2, "y", out error)) return false;
                    if (!ValidateOptionalNumber(p2, "z", out error)) return false;
                }

                var datumAction = "list";
                if (obj.Value.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String)
                {
                    datumAction = (av.GetString() ?? "").Trim().ToLowerInvariant();
                    if (datumAction == "get") datumAction = "list";
                }

                var validAction =
                    datumAction == "list" ||
                    datumAction == "set_scope_box" ||
                    datumAction == "clear_scope_box" ||
                    datumAction == "set_bubble_visibility" ||
                    datumAction == "create_grid" ||
                    datumAction == "create_level";
                if (!validAction)
                {
                    error = "datums.action must be list|get|set_scope_box|clear_scope_box|set_bubble_visibility|create_grid|create_level.";
                    return false;
                }

                if (obj.Value.TryGetProperty("datumType", out var dv) && dv.ValueKind == JsonValueKind.String)
                {
                    var datumType = (dv.GetString() ?? "").Trim().ToLowerInvariant();
                    if (datumType.Length > 0 &&
                        datumType != "grid" &&
                        datumType != "grids" &&
                        datumType != "level" &&
                        datumType != "levels" &&
                        datumType != "all" &&
                        datumType != "any")
                    {
                        error = "datums.datumType must be grid|level|all.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mv) && mv.ValueKind != JsonValueKind.Null)
                {
                    if (mv.ValueKind != JsonValueKind.Number || !mv.TryGetInt32(out var max) || max < 1 || max > 1000)
                    {
                        error = "datums.max must be an integer in range [1,1000].";
                        return false;
                    }
                }

                if (datumAction == "set_scope_box")
                {
                    var hasScopeBoxId = obj.Value.TryGetProperty("scopeBoxId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasScopeBoxName = obj.Value.TryGetProperty("scopeBoxName", out var sname) &&
                                          sname.ValueKind == JsonValueKind.String &&
                                          !string.IsNullOrWhiteSpace(sname.GetString());
                    if (!hasScopeBoxId && !hasScopeBoxName)
                    {
                        error = "datums.set_scope_box requires scopeBoxId or scopeBoxName.";
                        return false;
                    }
                }

                if (datumAction == "set_bubble_visibility")
                {
                    var hasBubbleVisible = obj.Value.TryGetProperty("bubbleVisible", out var bv) && bv.ValueKind != JsonValueKind.Null;
                    if (!hasBubbleVisible)
                    {
                        error = "datums.set_bubble_visibility requires bubbleVisible.";
                        return false;
                    }

                    var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                    if (!hasViewId)
                    {
                        error = "datums.set_bubble_visibility requires viewId.";
                        return false;
                    }
                }

                if (datumAction == "create_grid")
                {
                    var hasP1 = obj.Value.TryGetProperty("p1", out var p1v) && p1v.ValueKind == JsonValueKind.Object;
                    var hasP2 = obj.Value.TryGetProperty("p2", out var p2v) && p2v.ValueKind == JsonValueKind.Object;
                    if (!hasP1 || !hasP2)
                    {
                        error = "datums.create_grid requires p1 and p2.";
                        return false;
                    }
                }

                if (datumAction == "create_level")
                {
                    var hasElevation = obj.Value.TryGetProperty("elevation", out var ev) && ev.ValueKind != JsonValueKind.Null;
                    if (!hasElevation)
                    {
                        error = "datums.create_level requires elevation.";
                        return false;
                    }
                }

                var requiresSelection =
                    datumAction == "set_scope_box" ||
                    datumAction == "clear_scope_box" ||
                    datumAction == "set_bubble_visibility";
                if (requiresSelection)
                {
                    var hasDatumIds = obj.Value.TryGetProperty("datumIds", out var ids) &&
                                      ids.ValueKind == JsonValueKind.Array &&
                                      ids.GetArrayLength() > 0;
                    var hasNameFilter = obj.Value.TryGetProperty("nameContains", out var nc) &&
                                        nc.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(nc.GetString());
                    var hasDatumType = obj.Value.TryGetProperty("datumType", out var dt) &&
                                       dt.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(dt.GetString());
                    var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                    if (!hasDatumIds && !hasNameFilter && !hasDatumType && !hasViewId)
                    {
                        error = "datums mutation actions require a selector: datumIds, nameContains, datumType, or viewId.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("bubbleEnd", out var be) && be.ValueKind == JsonValueKind.String)
                {
                    var bubbleEnd = (be.GetString() ?? "").Trim().ToLowerInvariant();
                    if (bubbleEnd.Length > 0 &&
                        bubbleEnd != "start" &&
                        bubbleEnd != "end" &&
                        bubbleEnd != "both" &&
                        bubbleEnd != "end0" &&
                        bubbleEnd != "end1")
                    {
                        error = "datums.bubbleEnd must be start|end|both.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/renumber-sheets", StringComparison.OrdinalIgnoreCase))
            {
                // { changes:[{sheetId,newNumber?,newName?}], behavior?:string, dryRun?:bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "renumber-sheets body must be an object.";
                    return false;
                }
                if (!obj.Value.TryGetProperty("changes", out var changes) || changes.ValueKind != JsonValueKind.Array)
                {
                    error = "renumber-sheets.changes must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var ch in changes.EnumerateArray())
                {
                    count++;
                    if (count > 500)
                    {
                        error = "renumber-sheets.changes too large.";
                        return false;
                    }
                    if (ch.ValueKind != JsonValueKind.Object)
                    {
                        error = "renumber-sheets.changes items must be objects.";
                        return false;
                    }
                    if (!ValidateRequiredLong(ch, "sheetId", out error)) return false;
                    if (!ValidateOptionalString(ch, "newNumber", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(ch, "newName", maxLen: 200, out error)) return false;
                }
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/sync-sheet-names", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetIds:[...], force?:bool, dryRun?:bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "sync-sheet-names body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "sheetIds", maxCount: 500, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "force", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/create-text", StringComparison.OrdinalIgnoreCase))
            {
                // { action?:"create"|"list_types"|"create_type", viewId?, x?, y?, text?, typeId?|typeName?, newTypeName?, baseTypeId?|baseTypeName?, fontName?, textSize?, bold?, italic?, allowExisting?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-text body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 32, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "x", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "y", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "text", maxLen: 2000, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "typeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "newTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "baseTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "baseTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fontName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "textSize", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "bold", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "italic", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "allowExisting", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var createTextAction = "create";
                if (obj.Value.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String)
                {
                    createTextAction = (av.GetString() ?? "").Trim().ToLowerInvariant();
                }

                if (createTextAction != "create" && createTextAction != "list_types" && createTextAction != "create_type")
                {
                    error = "create-text.action must be create|list_types|create_type.";
                    return false;
                }

                if (createTextAction == "create")
                {
                    if (!ValidateRequiredNumber(obj.Value, "x", out error)) return false;
                    if (!ValidateRequiredNumber(obj.Value, "y", out error)) return false;
                    if (!ValidateRequiredString(obj.Value, "text", maxLen: 2000, out error)) return false;
                }

                if (createTextAction == "create_type")
                {
                    if (!ValidateRequiredString(obj.Value, "newTypeName", maxLen: 140, out error)) return false;
                    if (obj.Value.TryGetProperty("textSize", out var sz) && sz.ValueKind == JsonValueKind.Number)
                    {
                        if (!sz.TryGetDouble(out var v) || v <= 0 || v > 10_000)
                        {
                            error = "create-text.textSize must be a positive number.";
                            return false;
                        }
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/import-drawing-spec", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath, viewId?, viewName?, textTypeName?, columns?, columnWidthInches?, columnHeightInches?, gutterInches?, marginInches?, startXInches?, startYInches?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "import-drawing-spec body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "textTypeName", maxLen: 140, out error)) return false;

                if (!ValidateOptionalInt(obj.Value, "columns", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "columnWidthInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "columnHeightInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "gutterInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "marginInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "startXInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "startYInches", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                return true;
            }

            if (string.Equals(path, "/revit/import-excel-table", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath, sheetName?, range, viewId?, viewName?, textTypeName?, lineStyleName?, cellWidthInches?, cellHeightInches?, marginInches?, startXInches?, startYInches?, sheetNumber?, sheetViewId?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "import-excel-table body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetName", maxLen: 120, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "range", maxLen: 40, out error)) return false;

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "textTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "lineStyleName", maxLen: 140, out error)) return false;

                if (!ValidateOptionalNumber(obj.Value, "cellWidthInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "cellHeightInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "marginInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "startXInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "startYInches", out error)) return false;

                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                return true;
            }

            if (string.Equals(path, "/revit/export-elements-xlsx", StringComparison.OrdinalIgnoreCase))
            {
                // { elementIds:number[], parameterNames:string[], outputFolder?, fileName?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "export-elements-xlsx body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "elementIds", maxCount: 2000, out error)) return false;

                if (!obj.Value.TryGetProperty("parameterNames", out var pnames) || pnames.ValueKind != JsonValueKind.Array)
                {
                    error = "export-elements-xlsx.parameterNames must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var pn in pnames.EnumerateArray())
                {
                    count++;
                    if (count > 100)
                    {
                        error = "export-elements-xlsx.parameterNames too large.";
                        return false;
                    }
                    if (pn.ValueKind != JsonValueKind.String)
                    {
                        error = "export-elements-xlsx.parameterNames must be an array of strings.";
                        return false;
                    }
                    if (((pn.GetString() ?? "").Trim()).Length > 128)
                    {
                        error = "export-elements-xlsx.parameterNames item too long.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("outputFolder", out var of) && of.ValueKind != JsonValueKind.Null)
                {
                    if (of.ValueKind != JsonValueKind.String)
                    {
                        error = "export-elements-xlsx.outputFolder must be a string.";
                        return false;
                    }
                    if (((of.GetString() ?? "").Trim()).Length > 520)
                    {
                        error = "export-elements-xlsx.outputFolder is too long.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("fileName", out var fn) && fn.ValueKind != JsonValueKind.Null)
                {
                    if (fn.ValueKind != JsonValueKind.String)
                    {
                        error = "export-elements-xlsx.fileName must be a string.";
                        return false;
                    }
                    var s = fn.GetString() ?? "";
                    if (s.IndexOf('/') >= 0 || s.IndexOf('\\') >= 0)
                    {
                        error = "export-elements-xlsx.fileName must not contain paths.";
                        return false;
                    }
                    if (s.Length > 180)
                    {
                        error = "export-elements-xlsx.fileName is too long.";
                        return false;
                    }
                }

                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/import-elements-xlsx-updates", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath, sheetName?, range, idColumn?, behavior?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "import-elements-xlsx-updates body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetName", maxLen: 120, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "range", maxLen: 40, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "idColumn", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "behavior", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/create-drafting-view", StringComparison.OrdinalIgnoreCase))
            {
                // { name, scale?, allowExisting? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-drafting-view body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "name", maxLen: 140, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "scale", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "allowExisting", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/create-view", StringComparison.OrdinalIgnoreCase))
            {
                // { action?, name?, levelId?|levelName?, planType?, perspective?, sourceViewId?, calloutType?, sectionHeight?, sectionDepth?, elevationIndex?, p1?, p2?, eye?, target?, up?, templateId?|templateName?, scale?, detailLevel?, discipline?, viewIds?, nameContains?, prefix?, suffix?, findText?, replaceText?, exact?, max?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-view body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 140, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "levelId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 120, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "planType", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "perspective", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sourceViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "calloutType", maxLen: 32, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "sectionHeight", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "sectionDepth", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "elevationIndex", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "templateId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "templateName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "detailLevel", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "discipline", maxLen: 32, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "viewIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "nameContains", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "prefix", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "suffix", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "findText", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "replaceText", maxLen: 140, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("p1", out var p1) && p1.ValueKind != JsonValueKind.Null)
                {
                    if (p1.ValueKind != JsonValueKind.Object) { error = "create-view.p1 must be an object."; return false; }
                    if (!ValidateRequiredNumber(p1, "x", out error)) return false;
                    if (!ValidateRequiredNumber(p1, "y", out error)) return false;
                    if (!ValidateOptionalNumber(p1, "z", out error)) return false;
                }
                if (obj.Value.TryGetProperty("p2", out var p2) && p2.ValueKind != JsonValueKind.Null)
                {
                    if (p2.ValueKind != JsonValueKind.Object) { error = "create-view.p2 must be an object."; return false; }
                    if (!ValidateRequiredNumber(p2, "x", out error)) return false;
                    if (!ValidateRequiredNumber(p2, "y", out error)) return false;
                    if (!ValidateOptionalNumber(p2, "z", out error)) return false;
                }
                if (obj.Value.TryGetProperty("eye", out var eye) && eye.ValueKind != JsonValueKind.Null)
                {
                    if (eye.ValueKind != JsonValueKind.Object) { error = "create-view.eye must be an object."; return false; }
                    if (!ValidateRequiredNumber(eye, "x", out error)) return false;
                    if (!ValidateRequiredNumber(eye, "y", out error)) return false;
                    if (!ValidateOptionalNumber(eye, "z", out error)) return false;
                }
                if (obj.Value.TryGetProperty("target", out var target) && target.ValueKind != JsonValueKind.Null)
                {
                    if (target.ValueKind != JsonValueKind.Object) { error = "create-view.target must be an object."; return false; }
                    if (!ValidateRequiredNumber(target, "x", out error)) return false;
                    if (!ValidateRequiredNumber(target, "y", out error)) return false;
                    if (!ValidateOptionalNumber(target, "z", out error)) return false;
                }
                if (obj.Value.TryGetProperty("up", out var up) && up.ValueKind != JsonValueKind.Null)
                {
                    if (up.ValueKind != JsonValueKind.Object) { error = "create-view.up must be an object."; return false; }
                    if (!ValidateRequiredNumber(up, "x", out error)) return false;
                    if (!ValidateRequiredNumber(up, "y", out error)) return false;
                    if (!ValidateOptionalNumber(up, "z", out error)) return false;
                }

                var createViewAction = "create_floor_plan";
                if (obj.Value.TryGetProperty("action", out var a) && a.ValueKind == JsonValueKind.String)
                {
                    createViewAction = (a.GetString() ?? "").Trim().ToLowerInvariant();
                }

                if (createViewAction == "floor_plan") createViewAction = "create_floor_plan";
                if (createViewAction == "3d") createViewAction = "create_3d";
                if (createViewAction == "dependent") createViewAction = "create_dependent";
                if (createViewAction == "callout") createViewAction = "create_callout";
                if (createViewAction == "section") createViewAction = "create_section";
                if (createViewAction == "elevation") createViewAction = "create_elevation";
                if (createViewAction == "camera") createViewAction = "create_camera";
                if (createViewAction == "drafting") createViewAction = "create_drafting";
                if (createViewAction == "legend") createViewAction = "create_legend";
                if (createViewAction == "view_template") createViewAction = "create_view_template";

                if (!(createViewAction == "create_floor_plan" || createViewAction == "create_3d" || createViewAction == "create_dependent" || createViewAction == "create_callout" || createViewAction == "create_section" || createViewAction == "create_elevation" || createViewAction == "create_camera" || createViewAction == "create_drafting" || createViewAction == "create_legend" || createViewAction == "create_view_template" || createViewAction == "rename_batch"))
                {
                    error = "create-view.action must be create_floor_plan, create_3d, create_dependent, create_callout, create_section, create_elevation, create_camera, create_drafting, create_legend, create_view_template, or rename_batch.";
                    return false;
                }

                if (obj.Value.TryGetProperty("scale", out var sc) && sc.ValueKind != JsonValueKind.Null)
                {
                    if (sc.ValueKind != JsonValueKind.Number || !sc.TryGetInt32(out var v))
                    {
                        error = "create-view.scale must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2400)
                    {
                        error = "create-view.scale out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("sectionHeight", out var sh) && sh.ValueKind != JsonValueKind.Null)
                {
                    if (sh.ValueKind != JsonValueKind.Number || !sh.TryGetDouble(out var d) || d <= 0 || d > 10000)
                    {
                        error = "create-view.sectionHeight must be a positive number <= 10000.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("sectionDepth", out var sd) && sd.ValueKind != JsonValueKind.Null)
                {
                    if (sd.ValueKind != JsonValueKind.Number || !sd.TryGetDouble(out var d) || d <= 0 || d > 10000)
                    {
                        error = "create-view.sectionDepth must be a positive number <= 10000.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("elevationIndex", out var ei) && ei.ValueKind != JsonValueKind.Null)
                {
                    if (ei.ValueKind != JsonValueKind.Number || !ei.TryGetInt32(out var idx) || idx < 0 || idx > 3)
                    {
                        error = "create-view.elevationIndex must be an integer in range [0,3].";
                        return false;
                    }
                }

                if (createViewAction == "create_floor_plan")
                {
                    var hasLevelId = obj.Value.TryGetProperty("levelId", out var lid) && lid.ValueKind != JsonValueKind.Null;
                    var hasLevelName = obj.Value.TryGetProperty("levelName", out var lname) &&
                                       lname.ValueKind == JsonValueKind.String &&
                                       !string.IsNullOrWhiteSpace(lname.GetString());
                    if (!hasLevelId && !hasLevelName)
                    {
                        error = "create-view(create_floor_plan) requires levelId or levelName.";
                        return false;
                    }

                    if (obj.Value.TryGetProperty("planType", out var pt) && pt.ValueKind == JsonValueKind.String)
                    {
                        var val = (pt.GetString() ?? "").Trim().ToLowerInvariant();
                        if (!(val == "floor" || val == "ceiling" || val == "engineering" || val == "structural"))
                        {
                            error = "create-view.planType must be floor, ceiling, engineering, or structural.";
                            return false;
                        }
                    }
                }

                if (createViewAction == "create_dependent")
                {
                    var hasSource = obj.Value.TryGetProperty("sourceViewId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    if (!hasSource)
                    {
                        error = "create-view(create_dependent) requires sourceViewId.";
                        return false;
                    }
                }

                if (createViewAction == "create_callout")
                {
                    var hasSource = obj.Value.TryGetProperty("sourceViewId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    if (!hasSource)
                    {
                        error = "create-view(create_callout) requires sourceViewId.";
                        return false;
                    }

                    var hasP1 = obj.Value.TryGetProperty("p1", out var p1v) && p1v.ValueKind == JsonValueKind.Object;
                    var hasP2 = obj.Value.TryGetProperty("p2", out var p2v) && p2v.ValueKind == JsonValueKind.Object;
                    if (!hasP1 || !hasP2)
                    {
                        error = "create-view(create_callout) requires p1 and p2 objects.";
                        return false;
                    }

                    if (obj.Value.TryGetProperty("calloutType", out var ct) && ct.ValueKind == JsonValueKind.String)
                    {
                        var val = (ct.GetString() ?? "").Trim().ToLowerInvariant();
                        if (!(val == "detail" || val == "section"))
                        {
                            error = "create-view.calloutType must be detail or section.";
                            return false;
                        }
                    }
                }

                if (createViewAction == "create_section")
                {
                    var hasP1 = obj.Value.TryGetProperty("p1", out var p1v) && p1v.ValueKind == JsonValueKind.Object;
                    var hasP2 = obj.Value.TryGetProperty("p2", out var p2v) && p2v.ValueKind == JsonValueKind.Object;
                    if (!hasP1 || !hasP2)
                    {
                        error = "create-view(create_section) requires p1 and p2 objects.";
                        return false;
                    }
                }

                if (createViewAction == "create_elevation")
                {
                    var hasSource = obj.Value.TryGetProperty("sourceViewId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    if (!hasSource)
                    {
                        error = "create-view(create_elevation) requires sourceViewId.";
                        return false;
                    }

                    var hasP1 = obj.Value.TryGetProperty("p1", out var p1v) && p1v.ValueKind == JsonValueKind.Object;
                    if (!hasP1)
                    {
                        error = "create-view(create_elevation) requires p1 object.";
                        return false;
                    }
                }

                if (createViewAction == "create_camera")
                {
                    var hasEye = obj.Value.TryGetProperty("eye", out var eyeObj) && eyeObj.ValueKind == JsonValueKind.Object;
                    var hasTarget = obj.Value.TryGetProperty("target", out var targetObj) && targetObj.ValueKind == JsonValueKind.Object;
                    if (!hasEye || !hasTarget)
                    {
                        error = "create-view(create_camera) requires eye and target objects.";
                        return false;
                    }
                }

                if (createViewAction == "rename_batch")
                {
                    var hasViewIds = obj.Value.TryGetProperty("viewIds", out var ids) &&
                                     ids.ValueKind == JsonValueKind.Array &&
                                     ids.GetArrayLength() > 0;
                    var hasNameContains = obj.Value.TryGetProperty("nameContains", out var nameContains) &&
                                          nameContains.ValueKind == JsonValueKind.String &&
                                          !string.IsNullOrWhiteSpace(nameContains.GetString());
                    if (!hasViewIds && !hasNameContains)
                    {
                        error = "create-view(rename_batch) requires viewIds or nameContains.";
                        return false;
                    }

                    var hasPrefix = obj.Value.TryGetProperty("prefix", out var prefix) &&
                                    prefix.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(prefix.GetString());
                    var hasSuffix = obj.Value.TryGetProperty("suffix", out var suffix) &&
                                    suffix.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(suffix.GetString());
                    var hasFind = obj.Value.TryGetProperty("findText", out var findText) &&
                                  findText.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrEmpty(findText.GetString());
                    if (!hasPrefix && !hasSuffix && !hasFind)
                    {
                        error = "create-view(rename_batch) requires prefix, suffix, or findText.";
                        return false;
                    }

                    if (obj.Value.TryGetProperty("max", out var maxV) && maxV.ValueKind != JsonValueKind.Null)
                    {
                        if (maxV.ValueKind != JsonValueKind.Number || !maxV.TryGetInt32(out var max) || max < 1 || max > 5000)
                        {
                            error = "create-view.max must be an integer in range [1,5000].";
                            return false;
                        }
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/draw-detail-curves", StringComparison.OrdinalIgnoreCase))
            {
                // { viewId, frameId?, lineStyleName?, lineStyleCreate?, curves, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "draw-detail-curves body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "frameId", maxLen: 80, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "lineStyleName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("lineStyleCreate", out var lsc) && lsc.ValueKind != JsonValueKind.Null)
                {
                    if (lsc.ValueKind != JsonValueKind.Object)
                    {
                        error = "draw-detail-curves.lineStyleCreate must be an object.";
                        return false;
                    }
                    if (!ValidateRequiredString(lsc, "name", maxLen: 140, out error)) return false;
                    if (!ValidateOptionalInt(lsc, "lineWeight", out error)) return false;
                    if (!ValidateOptionalInt(lsc, "r", out error)) return false;
                    if (!ValidateOptionalInt(lsc, "g", out error)) return false;
                    if (!ValidateOptionalInt(lsc, "b", out error)) return false;
                    if (!ValidateOptionalString(lsc, "linePatternName", maxLen: 140, out error)) return false;
                }

                if (!obj.Value.TryGetProperty("curves", out var curves) || curves.ValueKind != JsonValueKind.Array)
                {
                    error = "draw-detail-curves.curves must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var el in curves.EnumerateArray())
                {
                    count++;
                    if (count > 2500) { error = "draw-detail-curves.curves too large."; return false; }
                    if (el.ValueKind != JsonValueKind.Object) { error = "draw-detail-curves.curves items must be objects."; return false; }
                    if (!ValidateRequiredString(el, "kind", maxLen: 32, out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/link-cad", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath, sheetNumber?, sheetViewId?, placement?, link?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "link-cad body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "placement", maxLen: 24, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "link", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasSheetViewId = obj.Value.TryGetProperty("sheetViewId", out var svid) && svid.ValueKind == JsonValueKind.Number && svid.TryGetInt64(out var svidV) && svidV > 0;
                var hasSheetNumber = obj.Value.TryGetProperty("sheetNumber", out var sn) && sn.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(sn.GetString());
                if (!hasSheetViewId && !hasSheetNumber)
                {
                    error = "link-cad requires sheetViewId or sheetNumber.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/place-image", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath, viewId?, sheetNumber?, sheetViewId?, placement?, xInches?, yInches?, widthInches?, heightInches?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "place-image body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "placement", maxLen: 24, out error)) return false;

                if (!ValidateOptionalNumber(obj.Value, "xInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "yInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "widthInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "heightInches", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind == JsonValueKind.Number && vid.TryGetInt64(out var vidV) && vidV > 0;
                var hasSheetViewId = obj.Value.TryGetProperty("sheetViewId", out var svid) && svid.ValueKind == JsonValueKind.Number && svid.TryGetInt64(out var svidV) && svidV > 0;
                var hasSheetNumber = obj.Value.TryGetProperty("sheetNumber", out var sn) && sn.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(sn.GetString());
                if (!hasViewId && !hasSheetViewId && !hasSheetNumber)
                {
                    error = "place-image requires viewId, sheetViewId, or sheetNumber.";
                    return false;
                }

                var hasX = obj.Value.TryGetProperty("xInches", out var x) && x.ValueKind == JsonValueKind.Number;
                var hasY = obj.Value.TryGetProperty("yInches", out var y) && y.ValueKind == JsonValueKind.Number;
                if (hasX != hasY)
                {
                    error = "place-image requires both xInches and yInches when specifying a point.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/place-pdf-underlay", StringComparison.OrdinalIgnoreCase))
            {
                // { sourcePath?, sourceUrl?, sourceFileName?, viewId?, viewName?, sheetNumber?, sheetViewId?, pageNumber?, placement?, xInches?, yInches?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "place-pdf-underlay body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "sourcePath", maxLen: 520, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourceUrl", maxLen: 2048, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourceFileName", maxLen: 260, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "pageNumber", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "placement", maxLen: 24, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "xInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "yInches", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasX = obj.Value.TryGetProperty("xInches", out var x) && x.ValueKind == JsonValueKind.Number;
                var hasY = obj.Value.TryGetProperty("yInches", out var y) && y.ValueKind == JsonValueKind.Number;
                if (hasX != hasY)
                {
                    error = "place-pdf-underlay requires both xInches and yInches when specifying a point.";
                    return false;
                }

                var hasSourcePath = obj.Value.TryGetProperty("sourcePath", out var sourcePathProp) && sourcePathProp.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(sourcePathProp.GetString());
                var hasSourceUrl = obj.Value.TryGetProperty("sourceUrl", out var sourceUrlProp) && sourceUrlProp.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(sourceUrlProp.GetString());
                if (!hasSourcePath && !hasSourceUrl)
                {
                    error = "place-pdf-underlay requires sourcePath or sourceUrl.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-filled-region", StringComparison.OrdinalIgnoreCase))
            {
                // { action?:"create"|"list_types"|"create_type", viewId?, frameId?, typeId?|typeName?, newTypeName?, sourceTypeId?|sourceTypeName?, fillPatternName?, allowExisting?, loops?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-filled-region body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 32, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "frameId", maxLen: 80, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "typeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "newTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sourceTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourceTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fillPatternName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "allowExisting", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var frAction = "create";
                if (obj.Value.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String)
                {
                    frAction = (av.GetString() ?? "").Trim().ToLowerInvariant();
                }

                if (frAction != "create" && frAction != "list_types" && frAction != "create_type")
                {
                    error = "create-filled-region.action must be create|list_types|create_type.";
                    return false;
                }

                if (frAction == "create")
                {
                    if (!ValidateRequiredLong(obj.Value, "viewId", out error)) return false;
                    if (!obj.Value.TryGetProperty("loops", out var loops) || loops.ValueKind != JsonValueKind.Array)
                    {
                        error = "create-filled-region.loops must be an array.";
                        return false;
                    }
                }

                if (frAction == "create_type")
                {
                    if (!ValidateRequiredString(obj.Value, "newTypeName", maxLen: 140, out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-revision-cloud", StringComparison.OrdinalIgnoreCase))
            {
                // { viewId, frameId?, points, revisionId?, closed?, tagCreatedCloud?, tagHasLeader?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-revision-cloud body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "frameId", maxLen: 80, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "revisionId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "closed", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "tagCreatedCloud", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "tagHasLeader", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (!obj.Value.TryGetProperty("points", out var pts) || pts.ValueKind != JsonValueKind.Array)
                {
                    error = "create-revision-cloud.points must be an array.";
                    return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/keynotes", StringComparison.OrdinalIgnoreCase))
            {
                // { action?, viewId?, elementIds?, categoryNames?, keynoteValue?, max?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "keynotes body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "elementIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categoryNames", maxCount: 200, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "keynoteValue", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var m) || m < 1 || m > 5000)
                    {
                        error = "keynotes.max must be an integer in range [1,5000].";
                        return false;
                    }
                }

                var keynoteAction = "list_tags";
                if (obj.Value.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String)
                {
                    keynoteAction = (av.GetString() ?? "").Trim().ToLowerInvariant();
                }

                var validAction = keynoteAction == "list_tags" ||
                                  keynoteAction == "list_elements_missing_keynote" ||
                                  keynoteAction == "set_element_keynote";
                if (!validAction)
                {
                    error = "keynotes.action must be list_tags|list_elements_missing_keynote|set_element_keynote.";
                    return false;
                }

                if (keynoteAction == "list_elements_missing_keynote")
                {
                    var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind == JsonValueKind.Array && eids.GetArrayLength() > 0;
                    var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                    var hasCategories = obj.Value.TryGetProperty("categoryNames", out var cns) && cns.ValueKind == JsonValueKind.Array && cns.GetArrayLength() > 0;
                    if (!hasElementIds && !hasViewId && !hasCategories)
                    {
                        error = "keynotes.list_elements_missing_keynote requires elementIds, viewId, or categoryNames.";
                        return false;
                    }
                }

                if (keynoteAction == "set_element_keynote")
                {
                    var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind == JsonValueKind.Array && eids.GetArrayLength() > 0;
                    if (!hasElementIds)
                    {
                        error = "keynotes.set_element_keynote requires elementIds.";
                        return false;
                    }
                    var hasValue = obj.Value.TryGetProperty("keynoteValue", out var kv) &&
                                   kv.ValueKind == JsonValueKind.String &&
                                   !string.IsNullOrWhiteSpace(kv.GetString());
                    if (!hasValue)
                    {
                        error = "keynotes.set_element_keynote requires keynoteValue.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/tag-elements", StringComparison.OrdinalIgnoreCase))
            {
                // { viewId?|viewName?, elementIds?|categoryNames?, categoryTagTypeMap?, tagTypeId?|tagTypeName?|tagFamilyName?, onlyUntagged?, addLeader?, orientation?, offsetX?, offsetY?, placementMode?, placementProfile?, tagWidthPaperInches?, tagHeightPaperInches?, clearancePaperInches?, maxRepairAttempts?, autoLoadTagFamily?, tagFamilySourceProjectPath?, tagFamilySourceCategory?, tagFamilySourceFamilyName?, tagFamilySourceTypeName?, generatedTagFamilyName?, generatedTagContentProfile?, inspectTagFamilyElements?, max?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "tag-elements body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "viewName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "elementIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categoryNames", maxCount: 200, maxLen: 120, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "tagTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagTypeName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagFamilyName", maxLen: 140, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "onlyUntagged", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "addLeader", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "orientation", maxLen: 24, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "offsetX", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "offsetY", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "tagWidthPaperInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "tagHeightPaperInches", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "clearancePaperInches", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "placementMode", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "placementProfile", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "autoLoadTagFamily", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagFamilySourceProjectPath", maxLen: 1024, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagFamilySourceCategory", maxLen: 120, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagFamilySourceFamilyName", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "tagFamilySourceTypeName", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "generatedTagFamilyName", maxLen: 120, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "generatedTagContentProfile", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "inspectTagFamilyElements", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("placementMode", out var placementMode) && placementMode.ValueKind == JsonValueKind.String)
                {
                    var value = (placementMode.GetString() ?? "").Trim().ToLowerInvariant();
                    if (value.Length > 0 && value != "offset" && value != "geometry_aware")
                    {
                        error = "tag-elements.placementMode must be offset|geometry_aware.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("placementProfile", out var placementProfile) && placementProfile.ValueKind == JsonValueKind.String)
                {
                    var value = (placementProfile.GetString() ?? "").Trim().ToLowerInvariant();
                    if (value.Length > 0 && value != "auto" && value != "mep" && value != "electrical" && value != "architectural")
                    {
                        error = "tag-elements.placementProfile must be auto|mep|electrical|architectural.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("generatedTagContentProfile", out var contentProfile) && contentProfile.ValueKind == JsonValueKind.String)
                {
                    var value = (contentProfile.GetString() ?? "").Trim().ToLowerInvariant();
                    if (value.Length > 0 && value != "none" && value != "airflow_only")
                    {
                        error = "tag-elements.generatedTagContentProfile must be none|airflow_only.";
                        return false;
                    }
                }

                foreach (var boundedNumber in new[] { "tagWidthPaperInches", "tagHeightPaperInches", "clearancePaperInches" })
                {
                    if (!obj.Value.TryGetProperty(boundedNumber, out var number) || number.ValueKind == JsonValueKind.Null) continue;
                    if (!number.TryGetDouble(out var numeric) || double.IsNaN(numeric) || double.IsInfinity(numeric) || numeric < 0 || numeric > 4)
                    {
                        error = $"tag-elements.{boundedNumber} must be a finite number from 0 to 4.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxRepairAttempts", out var repairAttempts) && repairAttempts.ValueKind != JsonValueKind.Null)
                {
                    if (repairAttempts.ValueKind != JsonValueKind.Number || !repairAttempts.TryGetInt32(out var attempts) || attempts < 1 || attempts > 180)
                    {
                        error = "tag-elements.maxRepairAttempts must be an integer from 1 to 180.";
                        return false;
                    }
                }

                var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind == JsonValueKind.Array && eids.GetArrayLength() > 0;
                var hasCategoryNames = obj.Value.TryGetProperty("categoryNames", out var cns) && cns.ValueKind == JsonValueKind.Array && cns.GetArrayLength() > 0;
                if (!hasElementIds && !hasCategoryNames)
                {
                    error = "tag-elements requires elementIds and/or categoryNames.";
                    return false;
                }

                if (obj.Value.TryGetProperty("orientation", out var orientation) && orientation.ValueKind == JsonValueKind.String)
                {
                    var value = (orientation.GetString() ?? "").Trim().ToLowerInvariant();
                    if (value.Length > 0 && value != "horizontal" && value != "vertical")
                    {
                        error = "tag-elements.orientation must be horizontal|vertical.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var max) && max.ValueKind != JsonValueKind.Null)
                {
                    if (max.ValueKind != JsonValueKind.Number || !max.TryGetInt32(out var mv))
                    {
                        error = "tag-elements.max must be an integer.";
                        return false;
                    }
                    if (mv < 1 || mv > 5000)
                    {
                        error = "tag-elements.max out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("categoryTagTypeMap", out var map) && map.ValueKind != JsonValueKind.Null)
                {
                    if (map.ValueKind != JsonValueKind.Array)
                    {
                        error = "tag-elements.categoryTagTypeMap must be an array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var item in map.EnumerateArray())
                    {
                        count++;
                        if (count > 200)
                        {
                            error = "tag-elements.categoryTagTypeMap too large.";
                            return false;
                        }
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "tag-elements.categoryTagTypeMap items must be objects.";
                            return false;
                        }

                        if (!ValidateRequiredString(item, "categoryName", maxLen: 120, out error)) return false;
                        if (!ValidateOptionalLong(item, "tagTypeId", out error)) return false;
                        if (!ValidateOptionalString(item, "tagTypeName", maxLen: 140, out error)) return false;
                        if (!ValidateOptionalString(item, "tagFamilyName", maxLen: 140, out error)) return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/export-pdf", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewIds?: number[], fileName?: string, combine?, outputFolder?, baseFileName?, perSheetFileNameTemplate?, colorMode?, dryRun?/preflight?, selector? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-pdf body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "sheetQuery", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "sheetNumberPrefix", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "sheetGroup", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "semanticSheetGroup", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "printSetName", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "printSetExact", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "all", out error)) return false;
                    if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                    {
                        if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                        {
                            error = "export-pdf.max must be an integer.";
                            return false;
                        }
                        if (v < 1 || v > 2000)
                        {
                            error = "export-pdf.max out of range.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("viewIds", out var viewIds))
                    {
                        if (viewIds.ValueKind != JsonValueKind.Array)
                        {
                            error = "export-pdf.viewIds must be an array.";
                            return false;
                        }

                        foreach (var el in viewIds.EnumerateArray())
                        {
                            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                            {
                                error = "export-pdf.viewIds must be an array of integers.";
                                return false;
                            }
                        }
                    }

                    if (obj.Value.TryGetProperty("fileName", out var fn) && fn.ValueKind != JsonValueKind.Null)
                    {
                        if (fn.ValueKind != JsonValueKind.String)
                        {
                            error = "export-pdf.fileName must be a string.";
                            return false;
                        }

                        var s = fn.GetString() ?? "";
                        if (!IsSafeFileName(s))
                        {
                            error = "export-pdf.fileName must be a safe filename (no paths).";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("baseFileName", out var bfn) && bfn.ValueKind != JsonValueKind.Null)
                    {
                        if (bfn.ValueKind != JsonValueKind.String)
                        {
                            error = "export-pdf.baseFileName must be a string.";
                            return false;
                        }
                        var s = bfn.GetString() ?? "";
                        if (!IsSafeFileName(s))
                        {
                            error = "export-pdf.baseFileName must be a safe filename (no paths).";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("outputFolder", out var of) && of.ValueKind != JsonValueKind.Null)
                    {
                        if (of.ValueKind != JsonValueKind.String)
                        {
                            error = "export-pdf.outputFolder must be a string.";
                            return false;
                        }
                        var s = (of.GetString() ?? "").Trim();
                        if (s.Length > 520)
                        {
                            error = "export-pdf.outputFolder is too long.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("perSheetFileNameTemplate", out var pst) && pst.ValueKind != JsonValueKind.Null)
                    {
                        if (pst.ValueKind != JsonValueKind.String)
                        {
                            error = "export-pdf.perSheetFileNameTemplate must be a string.";
                            return false;
                        }
                        var s = pst.GetString() ?? "";
                        if (s.IndexOf('/') >= 0 || s.IndexOf('\\') >= 0)
                        {
                            error = "export-pdf.perSheetFileNameTemplate must not contain paths.";
                            return false;
                        }
                        if (s.Length > 240)
                        {
                            error = "export-pdf.perSheetFileNameTemplate is too long.";
                            return false;
                        }
                    }

                    if (!ValidateOptionalBool(obj.Value, "combine", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "preflight", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "preflightOnly", out error)) return false;

                    if (obj.Value.TryGetProperty("colorMode", out var cm) && cm.ValueKind != JsonValueKind.Null)
                    {
                        if (cm.ValueKind != JsonValueKind.String)
                        {
                            error = "export-pdf.colorMode must be a string.";
                            return false;
                        }
                        var s = (cm.GetString() ?? "").Trim();
                        if (!(string.Equals(s, "Color", StringComparison.OrdinalIgnoreCase) ||
                              string.Equals(s, "Grayscale", StringComparison.OrdinalIgnoreCase) ||
                              string.Equals(s, "BlackLine", StringComparison.OrdinalIgnoreCase)))
                        {
                            error = "export-pdf.colorMode must be Color|Grayscale|BlackLine.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("selector", out var sel) && sel.ValueKind != JsonValueKind.Null)
                    {
                        if (sel.ValueKind != JsonValueKind.Object)
                        {
                            error = "export-pdf.selector must be an object.";
                            return false;
                        }
                        if (!ValidateOptionalString(sel, "semanticGroup", maxLen: 64, out error)) return false;
                        if (sel.TryGetProperty("semanticGroups", out var semanticGroups) && semanticGroups.ValueKind != JsonValueKind.Null)
                        {
                            if (semanticGroups.ValueKind != JsonValueKind.Array)
                            {
                                error = "export-pdf.selector.semanticGroups must be an array.";
                                return false;
                            }
                            foreach (var item in semanticGroups.EnumerateArray())
                            {
                                if (item.ValueKind != JsonValueKind.String)
                                {
                                    error = "export-pdf.selector.semanticGroups must be strings.";
                                    return false;
                                }
                            }
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/print", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or export-pdf selection fields plus printerName/print settings. dryRun defaults true in the handler.
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "print body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalString(obj.Value, "sheetQuery", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "sheetNumberPrefix", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "sheetGroup", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "semanticSheetGroup", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "printSetName", maxLen: 200, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "printerName", maxLen: 260, out error)) return false;
                    if (!ValidateOptionalString(obj.Value, "printToFileName", maxLen: 520, out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "printSetExact", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "all", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "preflight", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "preflightOnly", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "printIndividually", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "collate", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "reverseOrder", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "printToFile", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "combinedFile", out error)) return false;

                    if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                    {
                        if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                        {
                            error = "print.max must be an integer.";
                            return false;
                        }
                        if (v < 1 || v > 2000)
                        {
                            error = "print.max out of range.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("copies", out var copies) && copies.ValueKind != JsonValueKind.Null)
                    {
                        if (copies.ValueKind != JsonValueKind.Number || !copies.TryGetInt32(out var v))
                        {
                            error = "print.copies must be an integer.";
                            return false;
                        }
                        if (v < 1 || v > 99)
                        {
                            error = "print.copies out of range.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("viewIds", out var viewIds))
                    {
                        if (viewIds.ValueKind != JsonValueKind.Array)
                        {
                            error = "print.viewIds must be an array.";
                            return false;
                        }

                        foreach (var el in viewIds.EnumerateArray())
                        {
                            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                            {
                                error = "print.viewIds must be an array of integers.";
                                return false;
                            }
                        }
                    }

                    if (obj.Value.TryGetProperty("selector", out var sel) && sel.ValueKind != JsonValueKind.Null)
                    {
                        if (sel.ValueKind != JsonValueKind.Object)
                        {
                            error = "print.selector must be an object.";
                            return false;
                        }
                        if (!ValidateOptionalString(sel, "semanticGroup", maxLen: 64, out error)) return false;
                        if (sel.TryGetProperty("semanticGroups", out var semanticGroups) && semanticGroups.ValueKind != JsonValueKind.Null)
                        {
                            if (semanticGroups.ValueKind != JsonValueKind.Array)
                            {
                                error = "print.selector.semanticGroups must be an array.";
                                return false;
                            }
                            foreach (var item in semanticGroups.EnumerateArray())
                            {
                                if (item.ValueKind != JsonValueKind.String)
                                {
                                    error = "print.selector.semanticGroups must be strings.";
                                    return false;
                                }
                            }
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/export-images", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewIds?: number[], selector?, imageSize?, outputFolder?, fileNameTemplate?, dryRun? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-images body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (obj.Value.TryGetProperty("viewIds", out var viewIds))
                    {
                        if (viewIds.ValueKind != JsonValueKind.Array)
                        {
                            error = "export-images.viewIds must be an array.";
                            return false;
                        }
                        var count = 0;
                        foreach (var el in viewIds.EnumerateArray())
                        {
                            count++;
                            if (count > 2000)
                            {
                                error = "export-images.viewIds too large.";
                                return false;
                            }
                            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                            {
                                error = "export-images.viewIds must be an array of integers.";
                                return false;
                            }
                        }
                    }

                    if (!ValidateOptionalInt(obj.Value, "imageSize", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                    if (obj.Value.TryGetProperty("outputFolder", out var of) && of.ValueKind != JsonValueKind.Null)
                    {
                        if (of.ValueKind != JsonValueKind.String)
                        {
                            error = "export-images.outputFolder must be a string.";
                            return false;
                        }
                        if (((of.GetString() ?? "").Trim()).Length > 520)
                        {
                            error = "export-images.outputFolder is too long.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("fileNameTemplate", out var tpl) && tpl.ValueKind != JsonValueKind.Null)
                    {
                        if (tpl.ValueKind != JsonValueKind.String)
                        {
                            error = "export-images.fileNameTemplate must be a string.";
                            return false;
                        }
                        var s = tpl.GetString() ?? "";
                        if (s.IndexOf('/') >= 0 || s.IndexOf('\\') >= 0)
                        {
                            error = "export-images.fileNameTemplate must not contain paths.";
                            return false;
                        }
                        if (s.Length > 240)
                        {
                            error = "export-images.fileNameTemplate is too long.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("selector", out var sel) && sel.ValueKind != JsonValueKind.Null)
                    {
                        if (sel.ValueKind != JsonValueKind.Object)
                        {
                            error = "export-images.selector must be an object.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/export-dwg", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { viewIds?: number[], selector?, outputFolder?, baseFileName?, dryRun? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-dwg body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (obj.Value.TryGetProperty("viewIds", out var viewIds))
                    {
                        if (viewIds.ValueKind != JsonValueKind.Array)
                        {
                            error = "export-dwg.viewIds must be an array.";
                            return false;
                        }
                        var count = 0;
                        foreach (var el in viewIds.EnumerateArray())
                        {
                            count++;
                            if (count > 2000)
                            {
                                error = "export-dwg.viewIds too large.";
                                return false;
                            }
                            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                            {
                                error = "export-dwg.viewIds must be an array of integers.";
                                return false;
                            }
                        }
                    }

                    if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                    if (obj.Value.TryGetProperty("outputFolder", out var of) && of.ValueKind != JsonValueKind.Null)
                    {
                        if (of.ValueKind != JsonValueKind.String)
                        {
                            error = "export-dwg.outputFolder must be a string.";
                            return false;
                        }
                        if (((of.GetString() ?? "").Trim()).Length > 520)
                        {
                            error = "export-dwg.outputFolder is too long.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("baseFileName", out var bfn) && bfn.ValueKind != JsonValueKind.Null)
                    {
                        if (bfn.ValueKind != JsonValueKind.String)
                        {
                            error = "export-dwg.baseFileName must be a string.";
                            return false;
                        }
                        var s = bfn.GetString() ?? "";
                        if (!IsSafeFileName(s))
                        {
                            error = "export-dwg.baseFileName must be a safe filename (no paths).";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("selector", out var sel) && sel.ValueKind != JsonValueKind.Null)
                    {
                        if (sel.ValueKind != JsonValueKind.Object)
                        {
                            error = "export-dwg.selector must be an object.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/export-ifc", StringComparison.OrdinalIgnoreCase))
            {
                // Allow: null or { fileName?, outputFolder?, viewId?, dryRun? }
                if (!IsNullOrObject(body, out var obj))
                {
                    error = "export-ifc body must be an object.";
                    return false;
                }
                if (obj.HasValue)
                {
                    if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                    if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                    if (obj.Value.TryGetProperty("fileName", out var fn) && fn.ValueKind != JsonValueKind.Null)
                    {
                        if (fn.ValueKind != JsonValueKind.String)
                        {
                            error = "export-ifc.fileName must be a string.";
                            return false;
                        }
                        var s = fn.GetString() ?? "";
                        if (s.IndexOf('/') >= 0 || s.IndexOf('\\') >= 0)
                        {
                            error = "export-ifc.fileName must not contain paths.";
                            return false;
                        }
                        if (s.Length > 180)
                        {
                            error = "export-ifc.fileName is too long.";
                            return false;
                        }
                    }

                    if (obj.Value.TryGetProperty("outputFolder", out var of) && of.ValueKind != JsonValueKind.Null)
                    {
                        if (of.ValueKind != JsonValueKind.String)
                        {
                            error = "export-ifc.outputFolder must be a string.";
                            return false;
                        }
                        if (((of.GetString() ?? "").Trim()).Length > 520)
                        {
                            error = "export-ifc.outputFolder is too long.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/get-element-summary", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "get-element-summary body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;

                // Preferred: elementIds. Back-compat: ids.
                if (obj.Value.TryGetProperty("elementIds", out var _) && obj.Value.GetProperty("elementIds").ValueKind != JsonValueKind.Null)
                {
                    if (!ValidateRequiredLongArray(obj.Value, "elementIds", maxCount: 500, out error)) return false;
                    return true;
                }

                if (obj.Value.TryGetProperty("ids", out var _) && obj.Value.GetProperty("ids").ValueKind != JsonValueKind.Null)
                {
                    if (!ValidateRequiredLongArray(obj.Value, "ids", maxCount: 500, out error)) return false;
                    return true;
                }

                error = "get-element-summary requires elementIds (or legacy ids).";
                return false;
            }

            if (string.Equals(path, "/revit/get-parameters", StringComparison.OrdinalIgnoreCase))
            {
                const string getParamsExample = "{\"elementIds\":[12345],\"names\":[\"Sheet Name\"]}";
                const string getParamsCategoryExample = "{\"categories\":[\"OST_ElectricalEquipment\"],\"includeStringParameters\":true,\"offset\":0,\"limit\":500}";
                const string getParamsModelExample = "{\"allModelInstances\":true,\"includeStringParameters\":true,\"valueContains\":\"-G-\",\"writableOnly\":true,\"offset\":0,\"limit\":500}";
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "get-parameters body must be an object at $. Examples: " + getParamsExample + " or " + getParamsCategoryExample;
                    return false;
                }

                var hasElementId = obj.Value.TryGetProperty("elementId", out var eid) && eid.ValueKind != JsonValueKind.Null;
                var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind != JsonValueKind.Null;
                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 20, maxLen: 96, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "allModelInstances", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeStringParameters", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "valueContains", maxLen: 256, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "caseSensitive", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "writableOnly", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeEmpty", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "offset", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "limit", out error)) return false;
                var hasCategory = obj.Value.TryGetProperty("category", out var category) &&
                                  category.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrWhiteSpace(category.GetString());
                var hasCategories = obj.Value.TryGetProperty("categories", out var categories) &&
                                    categories.ValueKind == JsonValueKind.Array &&
                                    categories.GetArrayLength() > 0;
                var hasIdSelector = hasElementId || hasElementIds;
                var hasCategorySelector = hasCategory || hasCategories;
                var hasAllModelSelector = obj.Value.TryGetProperty("allModelInstances", out var allModel) && allModel.ValueKind == JsonValueKind.True;

                if (!hasIdSelector && !hasCategorySelector && !hasAllModelSelector)
                {
                    error = "get-parameters requires $.elementId, $.elementIds, $.category, $.categories, or $.allModelInstances:true. Examples: " + getParamsExample + ", " + getParamsCategoryExample + ", or " + getParamsModelExample;
                    return false;
                }

                if ((hasIdSelector ? 1 : 0) + (hasCategorySelector ? 1 : 0) + (hasAllModelSelector ? 1 : 0) > 1)
                {
                    error = "get-parameters accepts exactly one selector: elementId/elementIds, category/categories, or allModelInstances:true.";
                    return false;
                }

                if (hasAllModelSelector)
                {
                    var hasValueFilter = obj.Value.TryGetProperty("valueContains", out var valueFilter) &&
                                         valueFilter.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrEmpty(valueFilter.GetString());
                    var hasNameFilter = obj.Value.TryGetProperty("names", out var exactNames) &&
                                        exactNames.ValueKind == JsonValueKind.Array &&
                                        exactNames.GetArrayLength() > 0;
                    if (!hasValueFilter && !hasNameFilter)
                    {
                        error = "get-parameters with allModelInstances:true requires a non-empty literal valueContains filter or at least one exact parameter name. Example: " + getParamsModelExample;
                        return false;
                    }
                    var stringsOnly = obj.Value.TryGetProperty("includeStringParameters", out var stringFilter) && stringFilter.ValueKind == JsonValueKind.True;
                    if (!stringsOnly)
                    {
                        error = "get-parameters with allModelInstances:true requires includeStringParameters:true. Example: " + getParamsModelExample;
                        return false;
                    }
                }

                if (hasElementId)
                {
                    if (!TryReadLongFlexible(eid, out _))
                    {
                        error = "$.elementId must be an integer (or integer string). Received " +
                                JsonKindLabel(eid) + " " + JsonValuePreview(eid) +
                                ". Example: {\"elementId\":12345}";
                        return false;
                    }
                }

                if (hasElementIds)
                {
                    if (eids.ValueKind == JsonValueKind.Array)
                    {
                        var count = 0;
                        foreach (var el in eids.EnumerateArray())
                        {
                            count++;
                            if (count > 500)
                            {
                                error = "get-parameters.elementIds too large (max 500).";
                                return false;
                            }
                            if (!TryReadLongFlexible(el, out _))
                            {
                                error = "$.elementIds[" + (count - 1) + "] must be an integer (or integer string). Received " +
                                        JsonKindLabel(el) + " " + JsonValuePreview(el) +
                                        ". Example: " + getParamsExample;
                                return false;
                            }
                        }
                    }
                    else if (!TryReadLongFlexible(eids, out _))
                    {
                        error = "$.elementIds must be an integer (or integer string) or an array of integers. Received " +
                                JsonKindLabel(eids) + " " + JsonValuePreview(eids) +
                                ". Example: " + getParamsExample;
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("names", out var names) && names.ValueKind != JsonValueKind.Null)
                {
                    if (names.ValueKind != JsonValueKind.Array)
                    {
                        error = "$.names must be an array of strings. Received " +
                                JsonKindLabel(names) + " " + JsonValuePreview(names) +
                                ". Example: " + getParamsExample;
                        return false;
                    }
                    var count = 0;
                    foreach (var el in names.EnumerateArray())
                    {
                        count++;
                        if (count > 50)
                        {
                            error = "get-parameters.names too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.String)
                        {
                            error = "$.names[" + (count - 1) + "] must be a string. Received " +
                                    JsonKindLabel(el) + " " + JsonValuePreview(el) +
                                    ". Example: " + getParamsExample;
                            return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("offset", out var offset) && offset.ValueKind != JsonValueKind.Null)
                {
                    if (!offset.TryGetInt32(out var value) || value < 0 || value > 1000000)
                    {
                        error = "get-parameters.offset must be an integer from 0 through 1000000.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var limit) && limit.ValueKind != JsonValueKind.Null)
                {
                    if (!limit.TryGetInt32(out var value) || value < 1 || value > 5000)
                    {
                        error = "get-parameters.limit must be an integer from 1 through 5000; category reads are safely paged at no more than 500 items per response.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resolve-room-wall", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resolve-room-wall body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "side", maxLen: 16, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxWalls", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSegments", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/pick-candidate-cluster", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "pick-candidate-cluster body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "frameId", maxLen: 128, out error)) return false;
                if (!ValidateRequiredInt(obj.Value, "xPx", out error)) return false;
                if (!ValidateRequiredInt(obj.Value, "yPx", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "excludeCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "hostCategories", maxCount: 50, maxLen: 96, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "searchRadiusFt", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxTargets", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxHosts", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "preferHostedTargets", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/project-point-to-host-frame", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "project-point-to-host-frame body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "hostElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "alongHostOffsetFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetChainageFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetNormalizedChainage", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/audit-hosted-instance-placement", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "audit-hosted-instance-placement body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLongArray(obj.Value, "elementIds", maxCount: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "hostCategories", maxCount: 50, maxLen: 96, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "hostSearchRadiusFt", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxNearbyHosts", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/place-family-instance-on-host", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "place-family-instance-on-host body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "sourceElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "familySymbolId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "symbolName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "hostElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "referenceElementId", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "alongHostOffsetFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetChainageFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetNormalizedChainage", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "elevationFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "elevationDeltaFt", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "matchOrientationFromSource", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "orientationSourceElementId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyRotation", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyFacingHandState", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "parameterNamesToCopy", maxCount: 100, maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includePreviewImage", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "previewViewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "previewImageSize", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "focusPaddingFt", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "label", maxLen: 128, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/create-similar-from-instance", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-similar-from-instance body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "exemplarElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "hostElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "referenceElementId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "parameterNamesToCopy", maxCount: 100, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringMap(obj.Value, "parameterOverrides", maxCount: 100, maxKeyLen: 128, maxValueLen: 512, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "matchElectricalCircuitFromSource", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "requireElectricalCircuitMatch", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "matchOrientationFromSource", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "orientationSourceElementId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyRotation", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyFacingHandState", out error)) return false;
                if (!ValidateOptionalNumberArray(obj.Value, "alongHostOffsetsFt", maxCount: 128, out error)) return false;
                if (!ValidateOptionalPlacementsArray(obj.Value, "placements", maxCount: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includePreviewImage", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "previewViewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "previewImageSize", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "focusPaddingFt", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/adjust-hosted-instance-on-host", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "adjust-hosted-instance-on-host body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "elementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "roomId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "roomSide", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "orientationSourceElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "electricalCircuitSourceElementId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "matchOrientationFromSource", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "matchElectricalCircuitFromSource", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "requireElectricalCircuitMatch", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyRotation", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyFacingHandState", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "alongHostDeltaFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetChainageFt", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "targetNormalizedChainage", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "rotateToHostRelativeDegrees", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includePreviewImage", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "previewViewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "previewImageSize", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "focusPaddingFt", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "label", maxLen: 128, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/create-family-instance", StringComparison.OrdinalIgnoreCase))
            {
                // { familyName?, symbolName?|typeName?, levelName?, viewId?, sheetNumber?, x,y,z,count?,spacingX?,spacingY?,spacingZ?,rotationDegrees?,dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-family-instance body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "symbolName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "levelName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "x", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "y", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "z", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingX", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingY", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "spacingZ", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "rotationDegrees", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasSymbolName = obj.Value.TryGetProperty("symbolName", out var sn) &&
                                    sn.ValueKind == JsonValueKind.String &&
                                    !string.IsNullOrWhiteSpace(sn.GetString());
                var hasTypeName = obj.Value.TryGetProperty("typeName", out var tn) &&
                                  tn.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrWhiteSpace(tn.GetString());
                if (!hasSymbolName && !hasTypeName)
                {
                    error = "create-family-instance requires symbolName (or alias typeName).";
                    return false;
                }

                if (obj.Value.TryGetProperty("count", out var count) && count.ValueKind != JsonValueKind.Null)
                {
                    if (count.ValueKind != JsonValueKind.Number || !count.TryGetInt32(out var v))
                    {
                        error = "create-family-instance.count must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 200)
                    {
                        error = "create-family-instance.count out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/list-element-types", StringComparison.OrdinalIgnoreCase))
            {
                // { action?:list|rename_types|purge_unused_in_family, ... }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "list-element-types body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 32, out error)) return false;
                var actionName = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind == JsonValueKind.String)
                {
                    actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                }
                if (actionName != "list" && actionName != "rename_types" && actionName != "purge_unused_in_family")
                {
                    error = "list-element-types.action must be list|rename_types|purge_unused_in_family.";
                    return false;
                }

                var hasCategory = obj.Value.TryGetProperty("category", out var cat) && cat.ValueKind != JsonValueKind.Null;
                var hasCategories = obj.Value.TryGetProperty("categories", out var cats) && cats.ValueKind != JsonValueKind.Null;

                if (actionName == "list" && !hasCategory && !hasCategories)
                {
                    error = "list-element-types requires category (or categories).";
                    return false;
                }

                if (hasCategory)
                {
                    if (cat.ValueKind != JsonValueKind.String)
                    {
                        error = "list-element-types.category must be a string.";
                        return false;
                    }
                    if (((cat.GetString() ?? "").Trim()).Length > 96)
                    {
                        error = "list-element-types.category is too long.";
                        return false;
                    }
                }

                if (hasCategories)
                {
                    if (cats.ValueKind != JsonValueKind.Array)
                    {
                        error = "list-element-types.categories must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in cats.EnumerateArray())
                    {
                        count++;
                        if (count > 20)
                        {
                            error = "list-element-types.categories too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.String)
                        {
                            error = "list-element-types.categories must be an array of strings.";
                            return false;
                        }
                    }
                }

                if (!ValidateOptionalString(obj.Value, "exactName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "nameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyNameContains", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeParameters", maxCount: 5, maxLen: 80, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "cacheBust", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exportCsv", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "outputFolder", maxLen: 520, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fileName", maxLen: 220, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "searchPattern", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "replaceWith", maxLen: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "regexIgnoreCase", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("cacheMaxAgeSeconds", out var age) && age.ValueKind != JsonValueKind.Null)
                {
                    if (age.ValueKind != JsonValueKind.Number || !age.TryGetInt32(out var v))
                    {
                        error = "list-element-types.cacheMaxAgeSeconds must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 3600)
                    {
                        error = "list-element-types.cacheMaxAgeSeconds out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "list-element-types.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "list-element-types.limit out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxEdits", out var maxEdits) && maxEdits.ValueKind != JsonValueKind.Null)
                {
                    if (maxEdits.ValueKind != JsonValueKind.Number || !maxEdits.TryGetInt32(out var v))
                    {
                        error = "list-element-types.maxEdits must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "list-element-types.maxEdits out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxDelete", out var maxDelete) && maxDelete.ValueKind != JsonValueKind.Null)
                {
                    if (maxDelete.ValueKind != JsonValueKind.Number || !maxDelete.TryGetInt32(out var v))
                    {
                        error = "list-element-types.maxDelete must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "list-element-types.maxDelete out of range.";
                        return false;
                    }
                }

                if (actionName == "rename_types")
                {
                    var hasFamilyName = obj.Value.TryGetProperty("familyName", out var famEl) &&
                                        famEl.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(famEl.GetString());
                    if (!hasFamilyName)
                    {
                        error = "list-element-types.rename_types requires familyName.";
                        return false;
                    }

                    var hasSearchPattern = obj.Value.TryGetProperty("searchPattern", out var patEl) &&
                                           patEl.ValueKind == JsonValueKind.String &&
                                           !string.IsNullOrWhiteSpace(patEl.GetString());
                    if (!hasSearchPattern)
                    {
                        error = "list-element-types.rename_types requires searchPattern.";
                        return false;
                    }
                }

                if (actionName == "purge_unused_in_family")
                {
                    var hasFamilyName = obj.Value.TryGetProperty("familyName", out var famEl) &&
                                        famEl.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(famEl.GetString());
                    if (!hasFamilyName)
                    {
                        error = "list-element-types.purge_unused_in_family requires familyName.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/resolve-element-type", StringComparison.OrdinalIgnoreCase))
            {
                // { category: string | categories: string[], typeName: string, familyName?: string, exact?: bool, limit?: int, includeParameters?: string[], cacheBust?: bool, cacheMaxAgeSeconds?: int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "resolve-element-type body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 20, maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "typeName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "includeParameters", maxCount: 5, maxLen: 80, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "cacheBust", out error)) return false;

                var hasTypeName = obj.Value.TryGetProperty("typeName", out var tn) && tn.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(tn.GetString());
                var hasName = obj.Value.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(n.GetString());
                if (!hasTypeName && !hasName)
                {
                    error = "resolve-element-type requires typeName (or alias name).";
                    return false;
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "resolve-element-type.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "resolve-element-type.limit out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("cacheMaxAgeSeconds", out var age) && age.ValueKind != JsonValueKind.Null)
                {
                    if (age.ValueKind != JsonValueKind.Number || !age.TryGetInt32(out var v))
                    {
                        error = "resolve-element-type.cacheMaxAgeSeconds must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 3600)
                    {
                        error = "resolve-element-type.cacheMaxAgeSeconds out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/change-element-type", StringComparison.OrdinalIgnoreCase))
            {
                // { elementId?: number, elementIds?: number[], typeId?: number, newTypeId?: number, typeName?: string, category?: string, familyName?: string, dryRun?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "change-element-type body must be an object.";
                    return false;
                }

                var hasElementId = obj.Value.TryGetProperty("elementId", out var eid) && eid.ValueKind != JsonValueKind.Null;
                var hasElementIds = obj.Value.TryGetProperty("elementIds", out var eids) && eids.ValueKind != JsonValueKind.Null;
                if (!hasElementId && !hasElementIds)
                {
                    error = "change-element-type requires elementId (or elementIds).";
                    return false;
                }
                if (hasElementId)
                {
                    if (eid.ValueKind != JsonValueKind.Number || !eid.TryGetInt64(out _))
                    {
                        error = "change-element-type.elementId must be an integer.";
                        return false;
                    }
                }
                if (hasElementIds)
                {
                    if (eids.ValueKind != JsonValueKind.Array)
                    {
                        error = "change-element-type.elementIds must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in eids.EnumerateArray())
                    {
                        count++;
                        if (count > 500)
                        {
                            error = "change-element-type.elementIds too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                        {
                            error = "change-element-type.elementIds must be an array of integers.";
                            return false;
                        }
                    }
                }

                var hasTypeId = obj.Value.TryGetProperty("typeId", out var tid) && tid.ValueKind != JsonValueKind.Null;
                var hasNewTypeId = obj.Value.TryGetProperty("newTypeId", out var ntid) && ntid.ValueKind != JsonValueKind.Null;
                var hasTypeName = obj.Value.TryGetProperty("typeName", out var tn) && tn.ValueKind != JsonValueKind.Null;

                if (!hasTypeId && !hasNewTypeId && !hasTypeName)
                {
                    error = "change-element-type requires typeId (or newTypeId) or typeName.";
                    return false;
                }

                if (hasTypeId && (tid.ValueKind != JsonValueKind.Number || !tid.TryGetInt64(out _)))
                {
                    error = "change-element-type.typeId must be an integer.";
                    return false;
                }
                if (hasNewTypeId && (ntid.ValueKind != JsonValueKind.Number || !ntid.TryGetInt64(out _)))
                {
                    error = "change-element-type.newTypeId must be an integer.";
                    return false;
                }
                if (hasTypeName)
                {
                    if (tn.ValueKind != JsonValueKind.String)
                    {
                        error = "change-element-type.typeName must be a string.";
                        return false;
                    }
                    if (((tn.GetString() ?? "").Trim()).Length > 128)
                    {
                        error = "change-element-type.typeName is too long.";
                        return false;
                    }
                }

                if (!ValidateOptionalString(obj.Value, "category", maxLen: 96, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "cacheBust", out error)) return false;
                if (obj.Value.TryGetProperty("cacheMaxAgeSeconds", out var age) && age.ValueKind != JsonValueKind.Null)
                {
                    if (age.ValueKind != JsonValueKind.Number || !age.TryGetInt32(out var v))
                    {
                        error = "change-element-type.cacheMaxAgeSeconds must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 3600)
                    {
                        error = "change-element-type.cacheMaxAgeSeconds out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/duplicate-element-type", StringComparison.OrdinalIgnoreCase))
            {
                // { sourceTypeId:number, newTypeName:string, dryRun?:bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "duplicate-element-type body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "sourceTypeId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newTypeName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/set-type-parameters", StringComparison.OrdinalIgnoreCase))
            {
                // { typeId?:number, typeIds?:number[], changes:[{parameterName,value}], dryRun?:bool, confirm?:string }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "set-type-parameters body must be an object.";
                    return false;
                }
                if (!ValidateOptionalLong(obj.Value, "typeId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "typeIds", maxCount: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 64, out error)) return false;

                var hasTypeId = obj.Value.TryGetProperty("typeId", out var typeIdEl) && typeIdEl.ValueKind != JsonValueKind.Null;
                var hasTypeIds = obj.Value.TryGetProperty("typeIds", out var typeIdsEl) && typeIdsEl.ValueKind == JsonValueKind.Array && typeIdsEl.GetArrayLength() > 0;
                if (!hasTypeId && !hasTypeIds)
                {
                    error = "set-type-parameters requires typeId or typeIds.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("changes", out var ch) || ch.ValueKind != JsonValueKind.Array)
                {
                    error = "set-type-parameters.changes is required and must be an array.";
                    return false;
                }
                var count = 0;
                foreach (var el in ch.EnumerateArray())
                {
                    count++;
                    if (count > 250)
                    {
                        error = "set-type-parameters.changes too large.";
                        return false;
                    }
                    if (el.ValueKind != JsonValueKind.Object)
                    {
                        error = "set-type-parameters.changes must be an array of objects.";
                        return false;
                    }
                    if (!ValidateRequiredString(el, "parameterName", maxLen: 128, out error)) return false;
                    if (!ValidateRequiredString(el, "value", maxLen: 2000, out error)) return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/plan-family-evolution", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/apply-family-evolution", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "family evolution body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "instanceId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "expectedUniqueId", maxLen: 256, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "expectedFamilyName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "expectedTypeName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newFamilyName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newTypeName", maxLen: 128, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "width", maxLen: 64, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "depth", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "expectedMark", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "widthParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "depthParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familySavePath", maxLen: 1024, out error)) return false;
                if (obj.Value.TryGetProperty("clearance", out var clearance) &&
                    clearance.ValueKind != JsonValueKind.Null && clearance.ValueKind != JsonValueKind.Object)
                {
                    error = "family evolution clearance must be an object.";
                    return false;
                }
                if (string.Equals(path, "/revit/apply-family-evolution", StringComparison.OrdinalIgnoreCase))
                {
                    if (!ValidateRequiredString(obj.Value, "planHash", maxLen: 128, out error)) return false;
                    if (!ValidateRequiredString(obj.Value, "confirm", maxLen: 128, out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/read-family-evolution", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "read-family-evolution body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "instanceId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "widthParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "depthParameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "lineStyleName", maxLen: 128, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/duplicate-type-and-swap-instance", StringComparison.OrdinalIgnoreCase))
            {
                // { instanceId:number, newTypeName:string, typeParamChanges?:[{parameterName,value}], dryRun?:bool, confirm?:string }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "duplicate-type-and-swap-instance body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "instanceId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newTypeName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 64, out error)) return false;

                if (obj.Value.TryGetProperty("typeParamChanges", out var ch) && ch.ValueKind != JsonValueKind.Null)
                {
                    if (ch.ValueKind != JsonValueKind.Array)
                    {
                        error = "duplicate-type-and-swap-instance.typeParamChanges must be an array.";
                        return false;
                    }

                    var count = 0;
                    foreach (var el in ch.EnumerateArray())
                    {
                        count++;
                        if (count > 250)
                        {
                            error = "duplicate-type-and-swap-instance.typeParamChanges too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.Object)
                        {
                            error = "duplicate-type-and-swap-instance.typeParamChanges must be an array of objects.";
                            return false;
                        }
                        if (!ValidateRequiredString(el, "parameterName", maxLen: 128, out error)) return false;
                        if (!ValidateRequiredString(el, "value", maxLen: 2000, out error)) return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/quantify", StringComparison.OrdinalIgnoreCase))
            {
                // QuantifyRequest:
                // {
                //   intent: "count"|"list"|"count_and_list",
                //   categories: ["OST_Doors", ...],
                //   filters?: { level?: string, keywords_include?: string[], keywords_exclude?: string[] },
                //   group_by?: ["Level"|"Room"|"Type"],
                //   room_resolution?: boolean
                // }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "quantify body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("intent", out var intentEl) || intentEl.ValueKind != JsonValueKind.String)
                {
                    error = "quantify.intent is required.";
                    return false;
                }
                var intent = (intentEl.GetString() ?? "").Trim().ToLowerInvariant();
                if (intent != "count" && intent != "list" && intent != "count_and_list")
                {
                    error = "quantify.intent must be 'count', 'list', or 'count_and_list'.";
                    return false;
                }

                if (obj.Value.TryGetProperty("scope", out var scopeEl) && scopeEl.ValueKind != JsonValueKind.Null)
                {
                    if (scopeEl.ValueKind != JsonValueKind.String)
                    {
                        error = "quantify.scope must be a string.";
                        return false;
                    }
                    var scope = (scopeEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (scope.Length > 16)
                    {
                        error = "quantify.scope too long.";
                        return false;
                    }
                    if (scope != "" && scope != "host" && scope != "links" && scope != "both")
                    {
                        error = "quantify.scope must be 'host', 'links', or 'both'.";
                        return false;
                    }
                }

                if (!obj.Value.TryGetProperty("categories", out var cats) || cats.ValueKind != JsonValueKind.Array)
                {
                    error = "quantify.categories is required and must be an array.";
                    return false;
                }
                var catCount = 0;
                foreach (var c in cats.EnumerateArray())
                {
                    catCount++;
                    if (catCount > 10)
                    {
                        error = "quantify.categories too large.";
                        return false;
                    }
                    if (c.ValueKind != JsonValueKind.String)
                    {
                        error = "quantify.categories must be an array of strings.";
                        return false;
                    }
                    var s = (c.GetString() ?? "").Trim();
                    if (s.Length == 0 || s.Length > 64)
                    {
                        error = "quantify.categories entries must be non-empty and reasonably sized.";
                        return false;
                    }
                    if (!s.StartsWith("OST_", StringComparison.OrdinalIgnoreCase))
                    {
                        error = "quantify.categories must use BuiltInCategory names like 'OST_Doors'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("filters", out var filters) && filters.ValueKind != JsonValueKind.Null)
                {
                    if (filters.ValueKind != JsonValueKind.Object)
                    {
                        error = "quantify.filters must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalString(filters, "level", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalStringArray(filters, "keywords_include", maxCount: 20, maxLen: 80, out error)) return false;
                    if (!ValidateOptionalStringArray(filters, "keywords_exclude", maxCount: 20, maxLen: 80, out error)) return false;

                    if (filters.TryGetProperty("parameters", out var parameters) && parameters.ValueKind != JsonValueKind.Null)
                    {
                        if (parameters.ValueKind != JsonValueKind.Array)
                        {
                            error = "quantify.filters.parameters must be an array.";
                            return false;
                        }
                        var count = 0;
                        foreach (var el in parameters.EnumerateArray())
                        {
                            count++;
                            if (count > 20)
                            {
                                error = "quantify.filters.parameters too large.";
                                return false;
                            }
                            if (el.ValueKind != JsonValueKind.Object)
                            {
                                error = "quantify.filters.parameters items must be objects.";
                                return false;
                            }
                            if (!ValidateOptionalString(el, "param", maxLen: 128, out error)) return false;
                            if (!ValidateOptionalString(el, "value", maxLen: 256, out error)) return false;
                            if (!ValidateOptionalString(el, "op", maxLen: 32, out error)) return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("group_by", out var gb) && gb.ValueKind != JsonValueKind.Null)
                {
                    if (gb.ValueKind != JsonValueKind.Array)
                    {
                        error = "quantify.group_by must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var el in gb.EnumerateArray())
                    {
                        count++;
                        if (count > 3)
                        {
                            error = "quantify.group_by too large.";
                            return false;
                        }
                        if (el.ValueKind != JsonValueKind.String)
                        {
                            error = "quantify.group_by must be an array of strings.";
                            return false;
                        }
                    }
                }

                if (!ValidateOptionalBool(obj.Value, "room_resolution", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/quantify-visualize", StringComparison.OrdinalIgnoreCase))
            {
                // { resultSetId: string, mode: "highlight"|"isolate"|"new_view"|"clear"|"forget", viewId?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "quantify-visualize body must be an object.";
                    return false;
                }

                if (!obj.Value.TryGetProperty("resultSetId", out var rs) || rs.ValueKind != JsonValueKind.String)
                {
                    error = "quantify-visualize.resultSetId is required.";
                    return false;
                }
                var rsid = (rs.GetString() ?? "").Trim();
                if (rsid.Length == 0 || rsid.Length > 64)
                {
                    error = "quantify-visualize.resultSetId invalid.";
                    return false;
                }

                if (obj.Value.TryGetProperty("mode", out var modeEl) && modeEl.ValueKind != JsonValueKind.Null)
                {
                    if (modeEl.ValueKind != JsonValueKind.String)
                    {
                        error = "quantify-visualize.mode must be a string.";
                        return false;
                    }
                    var mode = (modeEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (mode.Length > 32)
                    {
                        error = "quantify-visualize.mode too long.";
                        return false;
                    }
                    if (mode != "" && mode != "highlight" && mode != "isolate" && mode != "new_view" && mode != "clear" && mode != "forget")
                    {
                        error = "quantify-visualize.mode invalid.";
                        return false;
                    }
                }

                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/views", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "views body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "action", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "viewIds", maxCount: 64, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "levelNames", maxCount: 32, maxLen: 160, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "viewTypes", maxCount: 32, maxLen: 80, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "disciplines", maxCount: 16, maxLen: 80, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "viewNames", maxCount: 32, maxLen: 160, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "nameContainsAny", maxCount: 32, maxLen: 160, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "semanticGroups", maxCount: 8, maxLen: 80, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTemplates", out error)) return false;
                var viewsAction = obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind == JsonValueKind.String
                    ? (actionEl.GetString() ?? "").Trim().ToLowerInvariant()
                    : "list";
                if (viewsAction != "list" && viewsAction != "count")
                {
                    error = "views.action must be 'list' or 'count'.";
                    return false;
                }
                if (obj.Value.TryGetProperty("offset", out var offsetEl) && offsetEl.ValueKind != JsonValueKind.Null &&
                    (offsetEl.ValueKind != JsonValueKind.Number || !offsetEl.TryGetInt32(out var offset) || offset < 0 || offset > 200000))
                {
                    error = "views.offset must be an integer from 0 through 200000.";
                    return false;
                }
                if (obj.Value.TryGetProperty("limit", out var limitEl) && limitEl.ValueKind != JsonValueKind.Null &&
                    (limitEl.ValueKind != JsonValueKind.Number || !limitEl.TryGetInt32(out var limit) || limit < 1 || limit > 500))
                {
                    error = "views.limit must be an integer from 1 through 500.";
                    return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/sheets", StringComparison.OrdinalIgnoreCase))
            {
                // list:   { action?: "list", query?: string, sheetNumberPrefix?: string, exact?: bool, offset?: int, limit?: int, all?: bool, max?: int }
                // detail: { action: "detail", sheetNumber?|sheetId?|viewId?|query?, includePlacedViews?, includeViewports?, includeTitleBlocks? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "sheets body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumberPrefix", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "all", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includePlacedViews", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeViewports", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeTitleBlocks", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSchedules", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeViewportGeometry", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSheetOutline", out error)) return false;

                var sheetsAction = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    sheetsAction = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (!(sheetsAction == "list" || sheetsAction == "detail" || sheetsAction == "count"))
                    {
                        error = "sheets.action must be 'list', 'count', or 'detail'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("offset", out var off) && off.ValueKind != JsonValueKind.Null)
                {
                    if (off.ValueKind != JsonValueKind.Number || !off.TryGetInt32(out var v))
                    {
                        error = "sheets.offset must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 200000)
                    {
                        error = "sheets.offset out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "sheets.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "sheets.limit out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "sheets.max must be an integer.";
                        return false;
                    }
                    if (v < 0)
                    {
                        error = "sheets.max must be >= 0.";
                        return false;
                    }
                }

                if (sheetsAction == "detail")
                {
                    var hasSheetNumber = obj.Value.TryGetProperty("sheetNumber", out var sn) &&
                                         sn.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(sn.GetString());
                    var hasSheetId = obj.Value.TryGetProperty("sheetId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasViewId = obj.Value.TryGetProperty("viewId", out var vid) && vid.ValueKind != JsonValueKind.Null;
                    var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                                   q.ValueKind == JsonValueKind.String &&
                                   !string.IsNullOrWhiteSpace(q.GetString());

                    if (!hasSheetNumber && !hasSheetId && !hasViewId && !hasQuery)
                    {
                        error = "sheets(detail) requires sheetNumber, sheetId, viewId, or query.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-schedule", StringComparison.OrdinalIgnoreCase))
            {
                // { name|scheduleName, category|categoryName?, kind?, sourceScheduleId?|sourceQuery?|sourceExact?, fields?|addFields?, includeLinkedFiles?, filterBySheet?, reuseIfExists?, placeOnSheet?, placeOnActiveSheet?, placeOnActiveSheetX?, placeOnActiveSheetY?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-schedule body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "scheduleName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "category", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "categoryName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "kind", maxLen: 40, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sourceScheduleId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "sourceQuery", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "sourceExact", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "fields", maxCount: 200, maxLen: 128, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "addFields", maxCount: 200, maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeLinkedFiles", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "filterBySheet", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "reuseIfExists", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "placeOnActiveSheet", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "placeOnActiveSheetX", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "placeOnActiveSheetY", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasName = obj.Value.TryGetProperty("name", out var n) &&
                              n.ValueKind == JsonValueKind.String &&
                              !string.IsNullOrWhiteSpace(n.GetString());
                var hasScheduleName = obj.Value.TryGetProperty("scheduleName", out var sn) &&
                                      sn.ValueKind == JsonValueKind.String &&
                                      !string.IsNullOrWhiteSpace(sn.GetString());
                if (!hasName && !hasScheduleName)
                {
                    error = "create-schedule requires name or scheduleName.";
                    return false;
                }

                var kind = "regular";
                if (obj.Value.TryGetProperty("kind", out var kindEl) && kindEl.ValueKind != JsonValueKind.Null)
                {
                    kind = (kindEl.GetString() ?? "").Trim().ToLowerInvariant().Replace('-', '_').Replace(' ', '_');
                    if (kind != "regular" &&
                        kind != "material_takeoff" &&
                        kind != "material" &&
                        kind != "takeoff" &&
                        kind != "key" &&
                        kind != "key_schedule" &&
                        kind != "keynote_legend" &&
                        kind != "keynote" &&
                        kind != "legend" &&
                        kind != "multi_category" &&
                        kind != "multicategory" &&
                        kind != "sheet_list" &&
                        kind != "view_list" &&
                        kind != "clone")
                    {
                        error = "create-schedule.kind is invalid.";
                        return false;
                    }
                }

                if (kind == "clone")
                {
                    var hasSourceId = obj.Value.TryGetProperty("sourceScheduleId", out var srcId) && srcId.ValueKind != JsonValueKind.Null;
                    var hasSourceQuery = obj.Value.TryGetProperty("sourceQuery", out var srcQuery) &&
                                         srcQuery.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(srcQuery.GetString());
                    if (!hasSourceId && !hasSourceQuery)
                    {
                        error = "create-schedule(kind=clone) requires sourceScheduleId or sourceQuery.";
                        return false;
                    }
                }

                var hasPlaceOnActiveSheet = obj.Value.TryGetProperty("placeOnActiveSheet", out var pas) &&
                                            pas.ValueKind == JsonValueKind.True;
                var hasPlaceOnActiveSheetX = obj.Value.TryGetProperty("placeOnActiveSheetX", out var pasX) && pasX.ValueKind != JsonValueKind.Null;
                var hasPlaceOnActiveSheetY = obj.Value.TryGetProperty("placeOnActiveSheetY", out var pasY) && pasY.ValueKind != JsonValueKind.Null;
                if ((hasPlaceOnActiveSheetX || hasPlaceOnActiveSheetY) && !hasPlaceOnActiveSheet)
                {
                    error = "create-schedule.placeOnActiveSheetX/Y require placeOnActiveSheet=true.";
                    return false;
                }

                if (obj.Value.TryGetProperty("placeOnSheet", out var pos) && pos.ValueKind != JsonValueKind.Null)
                {
                    if (pos.ValueKind != JsonValueKind.Object)
                    {
                        error = "create-schedule.placeOnSheet must be an object.";
                        return false;
                    }
                    if (!ValidateOptionalLong(pos, "sheetId", out error)) return false;
                    if (!ValidateOptionalString(pos, "sheetNumber", maxLen: 64, out error)) return false;
                    if (!ValidateOptionalString(pos, "query", maxLen: 128, out error)) return false;
                    if (!ValidateOptionalBool(pos, "exact", out error)) return false;
                    if (!ValidateOptionalNumber(pos, "x", out error)) return false;
                    if (!ValidateOptionalNumber(pos, "y", out error)) return false;

                    var hasSheetId = pos.TryGetProperty("sheetId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasSheetNumber = pos.TryGetProperty("sheetNumber", out var sheetNumber) &&
                                         sheetNumber.ValueKind == JsonValueKind.String &&
                                         !string.IsNullOrWhiteSpace(sheetNumber.GetString());
                    var hasSheetQuery = pos.TryGetProperty("query", out var query) &&
                                        query.ValueKind == JsonValueKind.String &&
                                        !string.IsNullOrWhiteSpace(query.GetString());
                    if (!hasSheetId && !hasSheetNumber && !hasSheetQuery)
                    {
                        error = "create-schedule.placeOnSheet requires sheetId, sheetNumber, or query.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/schedules", StringComparison.OrdinalIgnoreCase))
            {
                // list:   { action?: "list", query?: string, exact?: bool, max?: int }
                // detail: { action: "detail", scheduleId?|query?, exact?, includeFields? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "schedules body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 16, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "scheduleId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeFields", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeData", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "rowOffset", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "columnOffset", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxRows", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxColumns", out error)) return false;

                var schedulesAction = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    schedulesAction = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (!(schedulesAction == "list" || schedulesAction == "detail"))
                    {
                        error = "schedules.action must be 'list' or 'detail'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "schedules.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "schedules.max out of range.";
                        return false;
                    }
                }

                foreach (var field in new[] { "rowOffset", "columnOffset" })
                {
                    if (obj.Value.TryGetProperty(field, out var value) && value.ValueKind != JsonValueKind.Null &&
                        (!value.TryGetInt32(out var parsed) || parsed < 0 || parsed > 1000000))
                    {
                        error = "schedules." + field + " must be an integer from 0 through 1000000.";
                        return false;
                    }
                }
                if (obj.Value.TryGetProperty("maxRows", out var maxRows) && maxRows.ValueKind != JsonValueKind.Null &&
                    (!maxRows.TryGetInt32(out var rows) || rows < 1 || rows > 500))
                {
                    error = "schedules.maxRows must be an integer from 1 through 500.";
                    return false;
                }
                if (obj.Value.TryGetProperty("maxColumns", out var maxColumns) && maxColumns.ValueKind != JsonValueKind.Null &&
                    (!maxColumns.TryGetInt32(out var columns) || columns < 1 || columns > 100))
                {
                    error = "schedules.maxColumns must be an integer from 1 through 100.";
                    return false;
                }

                if (schedulesAction == "detail")
                {
                    var hasId = obj.Value.TryGetProperty("scheduleId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                    var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                                   q.ValueKind == JsonValueKind.String &&
                                   !string.IsNullOrWhiteSpace(q.GetString());
                    if (!hasId && !hasQuery)
                    {
                        error = "schedules(detail) requires scheduleId or query.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/configure-schedule", StringComparison.OrdinalIgnoreCase))
            {
                // { scheduleId?|query?, exact?, addFields?, filters?, replaceFilters?, sortGroup?, replaceSortGroup?, showGrandTotals?, columnWidths?, rowHeights?, calculatedFields?, fieldFormats?, conditionalFormats?, appearance?, filterBySheet?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "configure-schedule body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "scheduleId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "replaceFilters", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "replaceSortGroup", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "showGrandTotals", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "filterBySheet", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "addFields", maxCount: 200, maxLen: 128, out error)) return false;

                var hasId = obj.Value.TryGetProperty("scheduleId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                               q.ValueKind == JsonValueKind.String &&
                               !string.IsNullOrWhiteSpace(q.GetString());
                if (!hasId && !hasQuery)
                {
                    error = "configure-schedule requires scheduleId or query.";
                    return false;
                }

                var hasAddFields = obj.Value.TryGetProperty("addFields", out var af) &&
                                   af.ValueKind == JsonValueKind.Array &&
                                   af.GetArrayLength() > 0;

                var hasFilters = obj.Value.TryGetProperty("filters", out var filters) &&
                                 filters.ValueKind == JsonValueKind.Array;
                if (obj.Value.TryGetProperty("filters", out filters) && filters.ValueKind != JsonValueKind.Null)
                {
                    if (filters.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.filters must be an array.";
                        return false;
                    }
                    if (filters.GetArrayLength() > 200)
                    {
                        error = "configure-schedule.filters too many items (max 200).";
                        return false;
                    }
                    foreach (var f in filters.EnumerateArray())
                    {
                        if (f.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.filters items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(f, "field", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(f, "op", maxLen: 32, out error)) return false;
                        if (!ValidateOptionalString(f, "value", maxLen: 256, out error)) return false;
                    }
                }

                var hasSortGroup = obj.Value.TryGetProperty("sortGroup", out var sg) &&
                                   sg.ValueKind == JsonValueKind.Array;
                if (obj.Value.TryGetProperty("sortGroup", out sg) && sg.ValueKind != JsonValueKind.Null)
                {
                    if (sg.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.sortGroup must be an array.";
                        return false;
                    }
                    if (sg.GetArrayLength() > 20)
                    {
                        error = "configure-schedule.sortGroup too many items (max 20).";
                        return false;
                    }
                    foreach (var item in sg.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.sortGroup items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "field", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalBool(item, "ascending", out error)) return false;
                        if (!ValidateOptionalBool(item, "showHeader", out error)) return false;
                        if (!ValidateOptionalBool(item, "showFooter", out error)) return false;
                        if (!ValidateOptionalBool(item, "showBlankLine", out error)) return false;
                        if (!ValidateOptionalBool(item, "showFooterCount", out error)) return false;
                        if (!ValidateOptionalBool(item, "showFooterTitle", out error)) return false;
                    }
                }

                var hasColumnWidths = false;
                if (obj.Value.TryGetProperty("columnWidths", out var cw) && cw.ValueKind != JsonValueKind.Null)
                {
                    if (cw.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.columnWidths must be an array.";
                        return false;
                    }
                    if (cw.GetArrayLength() > 200)
                    {
                        error = "configure-schedule.columnWidths too many items (max 200).";
                        return false;
                    }
                    hasColumnWidths = cw.GetArrayLength() > 0;
                    foreach (var item in cw.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.columnWidths items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "field", maxLen: 128, out error)) return false;
                        if (item.TryGetProperty("widthFeet", out var wf) && wf.ValueKind != JsonValueKind.Null)
                        {
                            if (wf.ValueKind != JsonValueKind.Number || !wf.TryGetDouble(out var v))
                            {
                                error = "configure-schedule.columnWidths[].widthFeet must be a number.";
                                return false;
                            }
                            if (v <= 0 || v > 100)
                            {
                                error = "configure-schedule.columnWidths[].widthFeet out of range.";
                                return false;
                            }
                        }
                    }
                }

                var hasRowHeights = false;
                if (obj.Value.TryGetProperty("rowHeights", out var rh) && rh.ValueKind != JsonValueKind.Null)
                {
                    if (rh.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.rowHeights must be an array.";
                        return false;
                    }
                    if (rh.GetArrayLength() > 200)
                    {
                        error = "configure-schedule.rowHeights too many items (max 200).";
                        return false;
                    }
                    hasRowHeights = rh.GetArrayLength() > 0;
                    foreach (var item in rh.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.rowHeights items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "section", maxLen: 32, out error)) return false;
                        if (item.TryGetProperty("rowNumber", out var rn) && rn.ValueKind != JsonValueKind.Null)
                        {
                            if (rn.ValueKind != JsonValueKind.Number || !rn.TryGetInt32(out var row) || row < 0 || row > 100000)
                            {
                                error = "configure-schedule.rowHeights[].rowNumber must be an integer between 0 and 100000.";
                                return false;
                            }
                        }
                        if (item.TryGetProperty("heightFeet", out var hf) && hf.ValueKind != JsonValueKind.Null)
                        {
                            if (hf.ValueKind != JsonValueKind.Number || !hf.TryGetDouble(out var height))
                            {
                                error = "configure-schedule.rowHeights[].heightFeet must be a number.";
                                return false;
                            }
                            if (height <= 0 || height > 10)
                            {
                                error = "configure-schedule.rowHeights[].heightFeet out of range.";
                                return false;
                            }
                        }
                    }
                }

                var hasCalculatedFields = false;
                if (obj.Value.TryGetProperty("calculatedFields", out var calc) && calc.ValueKind != JsonValueKind.Null)
                {
                    if (calc.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.calculatedFields must be an array.";
                        return false;
                    }
                    if (calc.GetArrayLength() > 100)
                    {
                        error = "configure-schedule.calculatedFields too many items (max 100).";
                        return false;
                    }
                    hasCalculatedFields = calc.GetArrayLength() > 0;
                    foreach (var item in calc.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.calculatedFields items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "name", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "formula", maxLen: 512, out error)) return false;
                        if (!ValidateOptionalString(item, "valueType", maxLen: 32, out error)) return false;
                    }
                }

                var hasFieldFormats = false;
                if (obj.Value.TryGetProperty("fieldFormats", out var ff) && ff.ValueKind != JsonValueKind.Null)
                {
                    if (ff.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.fieldFormats must be an array.";
                        return false;
                    }
                    if (ff.GetArrayLength() > 200)
                    {
                        error = "configure-schedule.fieldFormats too many items (max 200).";
                        return false;
                    }
                    hasFieldFormats = ff.GetArrayLength() > 0;
                    foreach (var item in ff.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.fieldFormats items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "field", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "heading", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "headingOrientation", maxLen: 32, out error)) return false;
                        if (!ValidateOptionalString(item, "horizontalAlignment", maxLen: 32, out error)) return false;
                        if (!ValidateOptionalBool(item, "hidden", out error)) return false;
                        if (item.TryGetProperty("widthFeet", out var fw) && fw.ValueKind != JsonValueKind.Null)
                        {
                            if (fw.ValueKind != JsonValueKind.Number || !fw.TryGetDouble(out var width))
                            {
                                error = "configure-schedule.fieldFormats[].widthFeet must be a number.";
                                return false;
                            }
                            if (width <= 0 || width > 100)
                            {
                                error = "configure-schedule.fieldFormats[].widthFeet out of range.";
                                return false;
                            }
                        }

                        if (item.TryGetProperty("textColorRgb", out var tcr) && tcr.ValueKind != JsonValueKind.Null)
                        {
                            if (tcr.ValueKind != JsonValueKind.Array || tcr.GetArrayLength() != 3)
                            {
                                error = "configure-schedule.fieldFormats[].textColorRgb must be [r,g,b].";
                                return false;
                            }
                            foreach (var ch in tcr.EnumerateArray())
                            {
                                if (ch.ValueKind != JsonValueKind.Number || !ch.TryGetInt32(out var c) || c < 0 || c > 255)
                                {
                                    error = "configure-schedule.fieldFormats[].textColorRgb values must be integers 0..255.";
                                    return false;
                                }
                            }
                        }

                        if (item.TryGetProperty("backgroundColorRgb", out var bcr) && bcr.ValueKind != JsonValueKind.Null)
                        {
                            if (bcr.ValueKind != JsonValueKind.Array || bcr.GetArrayLength() != 3)
                            {
                                error = "configure-schedule.fieldFormats[].backgroundColorRgb must be [r,g,b].";
                                return false;
                            }
                            foreach (var ch in bcr.EnumerateArray())
                            {
                                if (ch.ValueKind != JsonValueKind.Number || !ch.TryGetInt32(out var c) || c < 0 || c > 255)
                                {
                                    error = "configure-schedule.fieldFormats[].backgroundColorRgb values must be integers 0..255.";
                                    return false;
                                }
                            }
                        }
                    }
                }

                var hasConditionalFormats = false;
                if (obj.Value.TryGetProperty("conditionalFormats", out var cf) && cf.ValueKind != JsonValueKind.Null)
                {
                    if (cf.ValueKind != JsonValueKind.Array)
                    {
                        error = "configure-schedule.conditionalFormats must be an array.";
                        return false;
                    }
                    if (cf.GetArrayLength() > 200)
                    {
                        error = "configure-schedule.conditionalFormats too many items (max 200).";
                        return false;
                    }
                    hasConditionalFormats = cf.GetArrayLength() > 0;
                    foreach (var item in cf.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object)
                        {
                            error = "configure-schedule.conditionalFormats items must be objects.";
                            return false;
                        }
                        if (!ValidateOptionalString(item, "field", maxLen: 128, out error)) return false;
                        if (!ValidateOptionalString(item, "op", maxLen: 40, out error)) return false;
                        if (!ValidateOptionalString(item, "value", maxLen: 256, out error)) return false;

                        if (item.TryGetProperty("textColorRgb", out var tcr) && tcr.ValueKind != JsonValueKind.Null)
                        {
                            if (tcr.ValueKind != JsonValueKind.Array || tcr.GetArrayLength() != 3)
                            {
                                error = "configure-schedule.conditionalFormats[].textColorRgb must be [r,g,b].";
                                return false;
                            }
                            foreach (var ch in tcr.EnumerateArray())
                            {
                                if (ch.ValueKind != JsonValueKind.Number || !ch.TryGetInt32(out var c) || c < 0 || c > 255)
                                {
                                    error = "configure-schedule.conditionalFormats[].textColorRgb values must be integers 0..255.";
                                    return false;
                                }
                            }
                        }

                        if (item.TryGetProperty("backgroundColorRgb", out var bcr) && bcr.ValueKind != JsonValueKind.Null)
                        {
                            if (bcr.ValueKind != JsonValueKind.Array || bcr.GetArrayLength() != 3)
                            {
                                error = "configure-schedule.conditionalFormats[].backgroundColorRgb must be [r,g,b].";
                                return false;
                            }
                            foreach (var ch in bcr.EnumerateArray())
                            {
                                if (ch.ValueKind != JsonValueKind.Number || !ch.TryGetInt32(out var c) || c < 0 || c > 255)
                                {
                                    error = "configure-schedule.conditionalFormats[].backgroundColorRgb values must be integers 0..255.";
                                    return false;
                                }
                            }
                        }
                    }
                }

                var hasAppearance = false;
                if (obj.Value.TryGetProperty("appearance", out var ap) && ap.ValueKind != JsonValueKind.Null)
                {
                    if (ap.ValueKind != JsonValueKind.Object)
                    {
                        error = "configure-schedule.appearance must be an object.";
                        return false;
                    }
                    hasAppearance = true;
                    if (!ValidateOptionalBool(ap, "showTitle", out error)) return false;
                    if (!ValidateOptionalBool(ap, "showHeaders", out error)) return false;
                    if (!ValidateOptionalBool(ap, "stripedRows", out error)) return false;
                    if (!ValidateOptionalBool(ap, "freezeHeaders", out error)) return false;
                }

                var hasGrandTotals = obj.Value.TryGetProperty("showGrandTotals", out var gt) && gt.ValueKind != JsonValueKind.Null;
                var hasFilterBySheet = obj.Value.TryGetProperty("filterBySheet", out var fbs) && fbs.ValueKind != JsonValueKind.Null;
                if (!hasAddFields && !hasFilters && !hasSortGroup && !hasColumnWidths && !hasRowHeights && !hasGrandTotals && !hasCalculatedFields && !hasFieldFormats && !hasConditionalFormats && !hasAppearance && !hasFilterBySheet)
                {
                    error = "configure-schedule requires at least one operation.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/export-schedule-csv", StringComparison.OrdinalIgnoreCase))
            {
                // { scheduleId?|query?, exact?, outputFolder?, fileName?, delimiter?, textQualifier?, columnHeaders?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "export-schedule-csv body must be an object.";
                    return false;
                }

                if (!ValidateOptionalLong(obj.Value, "scheduleId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "outputFolder", maxLen: 260, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fileName", maxLen: 180, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "delimiter", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "textQualifier", maxLen: 32, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "columnHeaders", maxLen: 32, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                var hasId = obj.Value.TryGetProperty("scheduleId", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                               q.ValueKind == JsonValueKind.String &&
                               !string.IsNullOrWhiteSpace(q.GetString());
                if (!hasId && !hasQuery)
                {
                    error = "export-schedule-csv requires scheduleId or query.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/export-warnings-report", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/warnings", StringComparison.OrdinalIgnoreCase))
            {
                // { action?:"list"|"export", outputFolder?, fileName?, filePath?, format?: "txt"|"json"|"csv", max?|limit?, offset?, includeElements?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "warnings body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 24, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "outputFolder", maxLen: 260, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fileName", maxLen: 180, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "filePath", maxLen: 320, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "format", maxLen: 16, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeElements", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("format", out var f) && f.ValueKind != JsonValueKind.Null)
                {
                    var format = (f.GetString() ?? "").Trim().ToLowerInvariant();
                    if (format != "txt" && format != "json" && format != "csv")
                    {
                        error = "warnings.format must be 'txt', 'csv', or 'json'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "warnings.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "warnings.max out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("limit", out var lim) && lim.ValueKind != JsonValueKind.Null)
                {
                    if (lim.ValueKind != JsonValueKind.Number || !lim.TryGetInt32(out var v))
                    {
                        error = "warnings.limit must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "warnings.limit out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("offset", out var off) && off.ValueKind != JsonValueKind.Null)
                {
                    if (off.ValueKind != JsonValueKind.Number || !off.TryGetInt32(out var v))
                    {
                        error = "warnings.offset must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 500000)
                    {
                        error = "warnings.offset out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    var actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (actionName != "" && actionName != "list" && actionName != "export" && actionName != "preview" && actionName != "write")
                    {
                        error = "warnings.action must be 'list' or 'export'.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/model-health", StringComparison.OrdinalIgnoreCase))
            {
                // { includeWarnings?, includeLinks?, includeViews?, includeSheets?, includeSheetChecks?, requiredSheetParameter?, maxMissingSheetParams?, maxUnplacedViews? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "model-health body must be an object.";
                    return false;
                }

                if (!ValidateOptionalBool(obj.Value, "includeWarnings", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeLinks", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeViews", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSheets", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSheetChecks", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "requiredSheetParameter", maxLen: 128, out error)) return false;

                if (obj.Value.TryGetProperty("maxMissingSheetParams", out var mm) && mm.ValueKind != JsonValueKind.Null)
                {
                    if (mm.ValueKind != JsonValueKind.Number || !mm.TryGetInt32(out var v))
                    {
                        error = "model-health.maxMissingSheetParams must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "model-health.maxMissingSheetParams out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxUnplacedViews", out var muv) && muv.ValueKind != JsonValueKind.Null)
                {
                    if (muv.ValueKind != JsonValueKind.Number || !muv.TryGetInt32(out var v))
                    {
                        error = "model-health.maxUnplacedViews must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 2000)
                    {
                        error = "model-health.maxUnplacedViews out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/qa-checks", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "interference_basic"|"view_bounds", sourceCategories?, targetCategories?, viewId?, maxClashes?, viewIds?, categories?, maxViews?, maxFindingsPerView?, maxElementsPerView?, marginFeet? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "qa-checks body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 48, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sourceCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "targetCategories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxClashes", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "viewIds", maxCount: 200, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "categories", maxCount: 100, maxLen: 96, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxViews", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxFindingsPerView", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxElementsPerView", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "marginFeet", out error)) return false;

                if (obj.Value.TryGetProperty("maxClashes", out var maxClashesEl) && maxClashesEl.ValueKind != JsonValueKind.Null)
                {
                    if (maxClashesEl.ValueKind != JsonValueKind.Number || !maxClashesEl.TryGetInt32(out var v) || v < 1 || v > 5000)
                    {
                        error = "qa-checks.maxClashes must be an integer in range [1,5000].";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxViews", out var maxViewsEl) && maxViewsEl.ValueKind != JsonValueKind.Null)
                {
                    if (maxViewsEl.ValueKind != JsonValueKind.Number || !maxViewsEl.TryGetInt32(out var v) || v < 1 || v > 200)
                    {
                        error = "qa-checks.maxViews must be an integer in range [1,200].";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxFindingsPerView", out var maxFindingsEl) && maxFindingsEl.ValueKind != JsonValueKind.Null)
                {
                    if (maxFindingsEl.ValueKind != JsonValueKind.Number || !maxFindingsEl.TryGetInt32(out var v) || v < 1 || v > 5000)
                    {
                        error = "qa-checks.maxFindingsPerView must be an integer in range [1,5000].";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxElementsPerView", out var maxElementsEl) && maxElementsEl.ValueKind != JsonValueKind.Null)
                {
                    if (maxElementsEl.ValueKind != JsonValueKind.Number || !maxElementsEl.TryGetInt32(out var v) || v < 100 || v > 50000)
                    {
                        error = "qa-checks.maxElementsPerView must be an integer in range [100,50000].";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("marginFeet", out var marginEl) && marginEl.ValueKind != JsonValueKind.Null)
                {
                    if (marginEl.ValueKind != JsonValueKind.Number || !marginEl.TryGetDouble(out var v) || v < 0 || v > 10)
                    {
                        error = "qa-checks.marginFeet must be a number in range [0,10].";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    if (actionEl.ValueKind != JsonValueKind.String)
                    {
                        error = "qa-checks.action must be a string.";
                        return false;
                    }

                    var actionName = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    var okAction =
                        actionName == "" ||
                        actionName == "interference_basic" ||
                        actionName == "interference" ||
                        actionName == "clash" ||
                        actionName == "clash_check" ||
                        actionName == "view_bounds" ||
                        actionName == "outside_crop_or_scope" ||
                        actionName == "outside_crop" ||
                        actionName == "outside_scope" ||
                        actionName == "crop_scope_bounds";
                    if (!okAction)
                    {
                        error = "qa-checks.action is invalid.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/print-sets", StringComparison.OrdinalIgnoreCase))
            {
                // { action?: "list"|"detail", name?: string, includeSheets?: bool, max?: int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "print-sets body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "action", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeSheets", out error)) return false;

                var printSetsAction = "list";
                if (obj.Value.TryGetProperty("action", out var actionEl) && actionEl.ValueKind != JsonValueKind.Null)
                {
                    printSetsAction = (actionEl.GetString() ?? "").Trim().ToLowerInvariant();
                    if (printSetsAction != "list" && printSetsAction != "detail")
                    {
                        error = "print-sets.action must be 'list' or 'detail'.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "print-sets.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 500)
                    {
                        error = "print-sets.max out of range.";
                        return false;
                    }
                }

                if (printSetsAction == "detail")
                {
                    var hasName = obj.Value.TryGetProperty("name", out var nm) &&
                                  nm.ValueKind == JsonValueKind.String &&
                                  !string.IsNullOrWhiteSpace(nm.GetString());
                    if (!hasName)
                    {
                        error = "print-sets(detail) requires name.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-print-set", StringComparison.OrdinalIgnoreCase))
            {
                // { name, sheetIds?|sheetNumbers?|query?|all?, exact?, max?, overwrite?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-print-set body must be an object.";
                    return false;
                }

                if (!ValidateRequiredString(obj.Value, "name", maxLen: 128, out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "sheetIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sheetNumbers", maxCount: 5000, maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "all", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "overwrite", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "create-print-set.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "create-print-set.max out of range.";
                        return false;
                    }
                }

                var hasSheetIds = obj.Value.TryGetProperty("sheetIds", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasSheetNumbers = obj.Value.TryGetProperty("sheetNumbers", out var sn) && sn.ValueKind != JsonValueKind.Null;
                var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                               q.ValueKind == JsonValueKind.String &&
                               !string.IsNullOrWhiteSpace(q.GetString());
                var hasAll = obj.Value.TryGetProperty("all", out var all) &&
                             (all.ValueKind == JsonValueKind.True || all.ValueKind == JsonValueKind.False) &&
                             all.GetBoolean();
                if (!hasSheetIds && !hasSheetNumbers && !hasQuery && !hasAll)
                {
                    error = "create-print-set requires sheetIds, sheetNumbers, query, or all:true.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/revisions", StringComparison.OrdinalIgnoreCase))
            {
                // { max?: int }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "revisions body must be an object.";
                    return false;
                }

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "revisions.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 1000)
                    {
                        error = "revisions.max out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/create-revision", StringComparison.OrdinalIgnoreCase))
            {
                // { description?, revisionDate?, issued?, issuedBy?, issuedTo?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "create-revision body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "description", maxLen: 512, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "revisionDate", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "issued", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "issuedBy", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "issuedTo", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/apply-revision-to-sheets", StringComparison.OrdinalIgnoreCase))
            {
                // { revisionId, sheetIds?|sheetNumbers?|query?|all?, exact?, max?, mode?, dryRun? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "apply-revision-to-sheets body must be an object.";
                    return false;
                }

                if (!ValidateRequiredLong(obj.Value, "revisionId", out error)) return false;
                if (!ValidateOptionalLongArray(obj.Value, "sheetIds", maxCount: 5000, out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "sheetNumbers", maxCount: 5000, maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "query", maxLen: 128, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "exact", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "all", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "mode", maxLen: 16, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;

                if (obj.Value.TryGetProperty("max", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "apply-revision-to-sheets.max must be an integer.";
                        return false;
                    }
                    if (v < 1 || v > 5000)
                    {
                        error = "apply-revision-to-sheets.max out of range.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("mode", out var md) && md.ValueKind != JsonValueKind.Null)
                {
                    var mode = (md.GetString() ?? "").Trim().ToLowerInvariant();
                    if (mode != "" && mode != "append" && mode != "replace")
                    {
                        error = "apply-revision-to-sheets.mode must be 'append' or 'replace'.";
                        return false;
                    }
                }

                var hasSheetIds = obj.Value.TryGetProperty("sheetIds", out var sid) && sid.ValueKind != JsonValueKind.Null;
                var hasSheetNumbers = obj.Value.TryGetProperty("sheetNumbers", out var sn) && sn.ValueKind != JsonValueKind.Null;
                var hasQuery = obj.Value.TryGetProperty("query", out var q) &&
                               q.ValueKind == JsonValueKind.String &&
                               !string.IsNullOrWhiteSpace(q.GetString());
                var hasAll = obj.Value.TryGetProperty("all", out var all) &&
                             (all.ValueKind == JsonValueKind.True || all.ValueKind == JsonValueKind.False) &&
                             all.GetBoolean();
                if (!hasSheetIds && !hasSheetNumbers && !hasQuery && !hasAll)
                {
                    error = "apply-revision-to-sheets requires sheetIds, sheetNumbers, query, or all:true.";
                    return false;
                }

                return true;
            }

            if (string.Equals(path, "/revit/titleblock-label-map", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetViewId?: number, titleBlockElementId?: number, includeParameters?: bool, includeHeuristics?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "titleblock-label-map body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleBlockElementId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeParameters", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeHeuristics", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/capture-sheet-region", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetViewId?: number, region?: string, marginFt?: number, imageMaxSizePx?: number, includeMapping?: bool, fileName?: string, includeOcr?: bool, ocrKind?: string, ocrExpected?: string, ocrTimeoutMs?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "capture-sheet-region body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "region", maxLen: 32, out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "marginFt", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "imageMaxSizePx", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeMapping", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "fileName", maxLen: 120, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeOcr", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ocrKind", maxLen: 16, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "ocrExpected", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "ocrTimeoutMs", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/verify-parameter-on-sheet", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetViewId?: number, parameterName?: string, labelText?: string, includeCapture?: bool, imageMaxSizePx?: number, marginFt?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "verify-parameter-on-sheet body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "parameterName", maxLen: 128, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "labelText", maxLen: 80, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeCapture", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "imageMaxSizePx", out error)) return false;
                if (!ValidateOptionalNumber(obj.Value, "marginFt", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/titleblock-date-candidates", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetViewId?: number, titleBlockElementId?: number, keywords?: string[], includeReadOnly?: bool, maxCandidates?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "titleblock-date-candidates body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleBlockElementId", out error)) return false;
                if (!ValidateOptionalStringArray(obj.Value, "keywords", maxCount: 20, maxLen: 24, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeReadOnly", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxCandidates", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/titleblock-set-date-smart", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetViewId?: number, labelText?: string, intendedValue: string, dryRun?: bool, apply?: bool, confirm?: string, maxCandidates?: number, includeOcrText?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "titleblock-set-date-smart body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "labelText", maxLen: 80, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "intendedValue", maxLen: 120, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "maxCandidates", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "includeOcrText", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/get-titleblock-info", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?: string, sheetId?: number, sheetViewId?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "get-titleblock-info body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/get-family-file-path", StringComparison.OrdinalIgnoreCase))
            {
                // { familyId: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "get-family-file-path body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "familyId", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/open-family-doc", StringComparison.OrdinalIgnoreCase))
            {
                // { filePath?: string, familyId?: number, titleblockInstanceId?: number, elementId?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "open-family-doc body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "filePath", maxLen: 260, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "familyId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleblockInstanceId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "elementId", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/find-text-notes", StringComparison.OrdinalIgnoreCase))
            {
                // { docId?: string, familyDocumentId?: string, textContains?: string, contains?: string, regex?: string, viewId?: number, max?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "find-text-notes body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "docId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "textContains", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "contains", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "regex", maxLen: 200, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "viewId", out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/replace-text-note", StringComparison.OrdinalIgnoreCase))
            {
                // { docId?: string, familyDocumentId?: string, elementId: number, newText: string, dryRun?: bool, apply?: bool, confirm?: string }
                // Omitting docId/familyDocumentId targets the active project document.
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "replace-text-note body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "docId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "elementId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newText", maxLen: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/save-family-doc", StringComparison.OrdinalIgnoreCase))
            {
                // { docId?: string, familyDocumentId?: string, overwrite?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "save-family-doc body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "docId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                var hasDocId = obj.Value.TryGetProperty("docId", out var did) && did.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((did.GetString() ?? "").Trim());
                var hasFamDocId = obj.Value.TryGetProperty("familyDocumentId", out var fdid) && fdid.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((fdid.GetString() ?? "").Trim());
                if (!hasDocId && !hasFamDocId)
                {
                    error = "save-family-doc requires docId (or familyDocumentId).";
                    return false;
                }
                if (!ValidateOptionalBool(obj.Value, "overwrite", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/load-family-doc", StringComparison.OrdinalIgnoreCase))
            {
                // { docId?: string, familyDocumentId?: string, overwriteParameterValuesOnLoad?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "load-family-doc body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "docId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                var hasDocId = obj.Value.TryGetProperty("docId", out var did) && did.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((did.GetString() ?? "").Trim());
                var hasFamDocId = obj.Value.TryGetProperty("familyDocumentId", out var fdid) && fdid.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((fdid.GetString() ?? "").Trim());
                if (!hasDocId && !hasFamDocId)
                {
                    error = "load-family-doc requires docId (or familyDocumentId).";
                    return false;
                }
                if (!ValidateOptionalBool(obj.Value, "overwriteParameterValuesOnLoad", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/close-doc", StringComparison.OrdinalIgnoreCase))
            {
                // { docId?: string, familyDocumentId?: string, saveChanges?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "close-doc body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "docId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                var hasDocId = obj.Value.TryGetProperty("docId", out var did) && did.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((did.GetString() ?? "").Trim());
                var hasFamDocId = obj.Value.TryGetProperty("familyDocumentId", out var fdid) && fdid.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace((fdid.GetString() ?? "").Trim());
                if (!hasDocId && !hasFamDocId)
                {
                    error = "close-doc requires docId (or familyDocumentId).";
                    return false;
                }
                if (!ValidateOptionalBool(obj.Value, "saveChanges", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/edit-family-from-instance", StringComparison.OrdinalIgnoreCase))
            {
                // { elementId: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "edit-family-from-instance body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "elementId", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/find-family-text-notes", StringComparison.OrdinalIgnoreCase))
            {
                // { familyDocumentId: string, contains?: string, max?: number }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "find-family-text-notes body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "contains", maxLen: 120, out error)) return false;
                if (!ValidateOptionalInt(obj.Value, "max", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/set-text-note-text", StringComparison.OrdinalIgnoreCase))
            {
                // { familyDocumentId?: string, textNoteId: number, newText: string, dryRun?: bool, apply?: bool, confirm?: string }
                // Omitting familyDocumentId targets the active project document.
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "set-text-note-text body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "textNoteId", out error)) return false;
                if (!ValidateRequiredString(obj.Value, "newText", maxLen: 200, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "confirm", maxLen: 120, out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/reload-family-edit-session", StringComparison.OrdinalIgnoreCase))
            {
                // { familyDocumentId: string, overwriteParameterValues?: bool, closeSession?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "reload-family-edit-session body must be an object.";
                    return false;
                }
                if (!ValidateRequiredString(obj.Value, "familyDocumentId", maxLen: 64, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "overwriteParameterValues", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "closeSession", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/titleblock-family-update-text", StringComparison.OrdinalIgnoreCase))
            {
                // { sheetNumber?|sheetViewId?|titleBlockElementId?|titleBlockTypeId?|familyName?, findText, replaceText, matchMode?, dryRun?, apply?, confirm?, maxEdits? }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "titleblock-family-update-text body must be an object.";
                    return false;
                }

                if (!ValidateOptionalString(obj.Value, "sheetNumber", maxLen: 64, out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "sheetViewId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleBlockElementId", out error)) return false;
                if (!ValidateOptionalLong(obj.Value, "titleBlockTypeId", out error)) return false;
                if (!ValidateOptionalString(obj.Value, "familyName", maxLen: 128, out error)) return false;

                if (!ValidateRequiredString(obj.Value, "findText", maxLen: 120, out error)) return false;
                if (!ValidateRequiredString(obj.Value, "replaceText", maxLen: 200, out error)) return false;
                if (!ValidateOptionalString(obj.Value, "matchMode", maxLen: 16, out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "dryRun", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "apply", out error)) return false;

                if (obj.Value.TryGetProperty("confirm", out var confirm) && confirm.ValueKind != JsonValueKind.Null)
                {
                    if (confirm.ValueKind != JsonValueKind.String)
                    {
                        error = "titleblock-family-update-text.confirm must be a string.";
                        return false;
                    }
                    var s = BulkConfirmUtil.Normalize(confirm.GetString());
                    if (s.Length > 120)
                    {
                        error = "titleblock-family-update-text.confirm is too long.";
                        return false;
                    }
                }

                if (obj.Value.TryGetProperty("maxEdits", out var mx) && mx.ValueKind != JsonValueKind.Null)
                {
                    if (mx.ValueKind != JsonValueKind.Number || !mx.TryGetInt32(out var v))
                    {
                        error = "titleblock-family-update-text.maxEdits must be an integer.";
                        return false;
                    }
                    if (v < 0 || v > 200)
                    {
                        error = "titleblock-family-update-text.maxEdits out of range.";
                        return false;
                    }
                }

                return true;
            }

            if (string.Equals(path, "/revit/replace-door", StringComparison.OrdinalIgnoreCase))
            {
                // { elementId: number, newTypeId: number, copyCommonParams?: bool, deleteOld?: bool }
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "replace-door body must be an object.";
                    return false;
                }
                if (!ValidateRequiredLong(obj.Value, "elementId", out error)) return false;
                if (!ValidateRequiredLong(obj.Value, "newTypeId", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "copyCommonParams", out error)) return false;
                if (!ValidateOptionalBool(obj.Value, "deleteOld", out error)) return false;
                return true;
            }

            if (string.Equals(path, "/revit/transaction-plan", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = "transaction-plan body must be an object.";
                    return false;
                }
                if (obj.Value.TryGetProperty("actions", out var acts) && acts.ValueKind != JsonValueKind.Null)
                {
                    if (acts.ValueKind != JsonValueKind.Array)
                    {
                        error = "transaction-plan.actions must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var _ in acts.EnumerateArray())
                    {
                        count++;
                        if (count > 50)
                        {
                            error = "transaction-plan.actions too large.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/transaction-validate", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = $"{path} body must be an object.";
                    return false;
                }
                if (!ValidateOptionalString(obj.Value, "transactionId", maxLen: 128, out error)) return false;
                if (obj.Value.TryGetProperty("checks", out var checks) && checks.ValueKind != JsonValueKind.Null)
                {
                    if (checks.ValueKind != JsonValueKind.Array)
                    {
                        error = "transaction-validate.checks must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var _ in checks.EnumerateArray())
                    {
                        count++;
                        if (count > 200)
                        {
                            error = "transaction-validate.checks too large.";
                            return false;
                        }
                    }
                }
                return true;
            }

            if (string.Equals(path, "/revit/transaction-apply", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out var obj) || !obj.HasValue)
                {
                    error = $"{path} body must be an object.";
                    return false;
                }
                if (obj.Value.TryGetProperty("actions", out var acts) && acts.ValueKind != JsonValueKind.Null)
                {
                    if (acts.ValueKind != JsonValueKind.Array)
                    {
                        error = "transaction-apply.actions must be an array.";
                        return false;
                    }
                    var count = 0;
                    foreach (var _ in acts.EnumerateArray())
                    {
                        count++;
                        if (count > 100)
                        {
                            error = "transaction-apply.actions too large.";
                            return false;
                        }
                    }
                }

                if (obj.Value.TryGetProperty("diff", out var diff) && diff.ValueKind != JsonValueKind.Null)
                {
                    if (diff.ValueKind != JsonValueKind.Object)
                    {
                        error = "transaction-apply.diff must be an object.";
                        return false;
                    }

                    if (!ValidateOptionalBool(diff, "includeParameterDeltas", out error)) return false;
                    if (!ValidateOptionalBool(diff, "includeGeometryDeltas", out error)) return false;
                    if (!ValidateOptionalBool(diff, "includeViewSheetChanges", out error)) return false;
                    if (!ValidateOptionalBool(diff, "persistArtifact", out error)) return false;
                    if (!ValidateOptionalString(diff, "artifactFolder", maxLen: 256, out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxTrackedElementIds", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxCreated", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxDeleted", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxModified", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxParameterDeltas", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxGeometryDeltas", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxViewSheetChanges", out error)) return false;
                    if (!ValidateOptionalInt(diff, "maxWatchElementsPerScope", out error)) return false;
                }
                return true;
            }

            if (string.Equals(path, "/revit/query", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(path, "/revit/resolve", StringComparison.OrdinalIgnoreCase))
            {
                if (!IsNullOrObject(body, out _))
                {
                    error = $"{path} body must be an object.";
                    return false;
                }
                return true;
            }

            // Default: require object (future endpoints will get explicit schemas)
            if (!IsNullOrObject(body, out _))
            {
                error = $"{path} body must be an object.";
                return false;
            }

            return true;
        }

        private static bool ValidateOptionalLong(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
            {
                error = $"{name} must be an integer.";
                return false;
            }
            return true;
        }

        private static bool ValidateOptionalInt(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out _))
            {
                error = $"{name} must be an integer.";
                return false;
            }
            return true;
        }

        private static bool ValidateOptionalNumber(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetDouble(out _))
            {
                error = $"{name} must be a number.";
                return false;
            }
            return true;
        }

        private static bool ValidateRequiredInt(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            {
                error = $"{name} is required.";
                return false;
            }
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out _))
            {
                error = $"{name} must be an integer.";
                return false;
            }
            return true;
        }

        private static bool ValidateRequiredLong(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            {
                error = $"{name} is required.";
                return false;
            }
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
            {
                error = $"{name} must be an integer.";
                return false;
            }
            return true;
        }

        private static bool ValidateRequiredString(JsonElement obj, string name, int maxLen, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            {
                error = $"{name} is required.";
                return false;
            }
            if (el.ValueKind != JsonValueKind.String)
            {
                error = $"{name} must be a string.";
                return false;
            }
            var s = el.GetString() ?? "";
            if (s.Length > maxLen)
            {
                error = $"{name} is too long.";
                return false;
            }
            return true;
        }

        private static bool ValidateRequiredNumber(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null)
            {
                error = $"{name} is required.";
                return false;
            }
            if (el.ValueKind != JsonValueKind.Number || !el.TryGetDouble(out _))
            {
                error = $"{name} must be a number.";
                return false;
            }
            return true;
        }

        private static bool ContainsBannedPathOverride(JsonElement obj, out string? error)
        {
            error = null;
            // These keys are used across multiple endpoints to control output folders/paths.
            // We disallow them broadly to avoid arbitrary writes. Endpoint-specific path
            // fields (e.g., config/template paths) should be validated per endpoint.
            var bannedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "folder",
                "outputDir",
                "outputDirectory",
                "outputPath",
                "outDir",
                "workDir",
                "modelPath"
            };

            foreach (var prop in obj.EnumerateObject())
            {
                if (!bannedKeys.Contains(prop.Name)) continue;
                if (prop.Value.ValueKind == JsonValueKind.Null) continue;
                error = $"Overriding '{prop.Name}' is not allowed.";
                return true;
            }

            return false;
        }
        private static bool ValidateOptionalComputerUseInteractionMode(JsonElement obj, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty("interactionMode", out var el) || el.ValueKind == JsonValueKind.Null) return true;
            var mode = (el.GetString() ?? "").Trim().Replace("-", "_").ToLowerInvariant();
            if (mode == "" || mode == "message" || mode == "mouse" || mode == "message_then_mouse") return true;
            error = "interactionMode must be 'message', 'mouse', or 'message_then_mouse'.";
            return false;
        }

        private static bool ValidateOptionalComputerUseCursorRestoreMode(JsonElement obj, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty("cursorRestoreMode", out var el) || el.ValueKind == JsonValueKind.Null) return true;
            var mode = (el.GetString() ?? "").Trim().Replace("-", "_").ToLowerInvariant();
            if (mode == "" || mode == "restore" || mode == "keep" || mode == "none" || mode == "no_restore") return true;
            error = "cursorRestoreMode must be 'restore' or 'keep'.";
            return false;
        }

        private static bool ValidateOptionalString(JsonElement obj, string name, int maxLen, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
            if (el.ValueKind != JsonValueKind.String)
            {
                error = $"{name} must be a string.";
                return false;
            }
            var s = el.GetString() ?? "";
            if (s.Length > maxLen)
            {
                error = $"{name} is too long.";
                return false;
            }
            return true;
        }

        private static bool ValidateOptionalStringArray(JsonElement obj, string name, int maxCount, int maxLen, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var arr) || arr.ValueKind == JsonValueKind.Null) return true;
            if (arr.ValueKind != JsonValueKind.Array)
            {
                error = $"{name} must be an array.";
                return false;
            }
            var count = 0;
            foreach (var el in arr.EnumerateArray())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (el.ValueKind != JsonValueKind.String)
                {
                    error = $"{name} must be an array of strings.";
                    return false;
                }
                var s = el.GetString() ?? "";
                if (s.Length > maxLen)
                {
                    error = $"{name} entries are too long.";
                    return false;
                }
            }
            return true;
        }

        private static bool ValidateOptionalBool(JsonElement obj, string name, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
            if (el.ValueKind != JsonValueKind.True && el.ValueKind != JsonValueKind.False)
            {
                error = $"{name} must be a boolean.";
                return false;
            }
            return true;
        }

        private static bool ValidateRequiredLongArray(JsonElement obj, string name, int maxCount, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var arr) || arr.ValueKind == JsonValueKind.Null)
            {
                error = $"{name} is required.";
                return false;
            }
            if (arr.ValueKind != JsonValueKind.Array)
            {
                error = $"{name} must be an array.";
                return false;
            }
            var count = 0;
            foreach (var el in arr.EnumerateArray())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                {
                    error = $"{name} must be an array of integers.";
                    return false;
                }
            }
            return true;
        }

        private static bool ValidateOptionalLongArray(JsonElement obj, string name, int maxCount, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var arr) || arr.ValueKind == JsonValueKind.Null) return true;
            if (arr.ValueKind != JsonValueKind.Array)
            {
                error = $"{name} must be an array.";
                return false;
            }
            var count = 0;
            foreach (var el in arr.EnumerateArray())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out _))
                {
                    error = $"{name} must be an array of integers.";
                    return false;
                }
            }
            return true;
        }

        private static bool ValidateOptionalNumberArray(JsonElement obj, string name, int maxCount, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var arr) || arr.ValueKind == JsonValueKind.Null) return true;
            if (arr.ValueKind != JsonValueKind.Array)
            {
                error = $"{name} must be an array.";
                return false;
            }
            var count = 0;
            foreach (var el in arr.EnumerateArray())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (el.ValueKind != JsonValueKind.Number)
                {
                    error = $"{name} must be an array of numbers.";
                    return false;
                }
            }
            return true;
        }

        private static bool ValidateOptionalStringMap(JsonElement obj, string name, int maxCount, int maxKeyLen, int maxValueLen, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var map) || map.ValueKind == JsonValueKind.Null) return true;
            if (map.ValueKind != JsonValueKind.Object)
            {
                error = $"{name} must be an object.";
                return false;
            }
            var count = 0;
            foreach (var prop in map.EnumerateObject())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (string.IsNullOrWhiteSpace(prop.Name) || prop.Name.Length > maxKeyLen)
                {
                    error = $"{name} keys must be non-empty and reasonably sized.";
                    return false;
                }
                if (prop.Value.ValueKind != JsonValueKind.String || (prop.Value.GetString() ?? "").Length > maxValueLen)
                {
                    error = $"{name} values must be strings.";
                    return false;
                }
            }
            return true;
        }

        private static bool ValidateOptionalPlacementsArray(JsonElement obj, string name, int maxCount, out string? error)
        {
            error = null;
            if (!obj.TryGetProperty(name, out var arr) || arr.ValueKind == JsonValueKind.Null) return true;
            if (arr.ValueKind != JsonValueKind.Array)
            {
                error = $"{name} must be an array.";
                return false;
            }
            var count = 0;
            foreach (var item in arr.EnumerateArray())
            {
                count++;
                if (count > maxCount)
                {
                    error = $"{name} too large.";
                    return false;
                }
                if (item.ValueKind != JsonValueKind.Object)
                {
                    error = $"{name} items must be objects.";
                    return false;
                }
                if (!ValidateOptionalNumberArray(item, "pointXyz", maxCount: 3, out error)) return false;
                if (!ValidateOptionalNumber(item, "alongHostOffsetFt", out error)) return false;
                if (!ValidateOptionalNumber(item, "targetChainageFt", out error)) return false;
                if (!ValidateOptionalNumber(item, "targetNormalizedChainage", out error)) return false;
                if (!ValidateOptionalNumber(item, "elevationFt", out error)) return false;
                if (!ValidateOptionalNumber(item, "elevationDeltaFt", out error)) return false;
                if (!ValidateOptionalString(item, "label", maxLen: 128, out error)) return false;
            }
            return true;
        }

        private static bool TryReadLongFlexible(JsonElement el, out long value)
        {
            if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out value))
            {
                return true;
            }

            if (el.ValueKind == JsonValueKind.String)
            {
                var s = el.GetString();
                if (!string.IsNullOrWhiteSpace(s) &&
                    long.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out value))
                {
                    return true;
                }
            }

            value = 0;
            return false;
        }

        private static string JsonKindLabel(JsonElement el)
        {
            return el.ValueKind.ToString().ToLowerInvariant();
        }

        private static string JsonValuePreview(JsonElement el)
        {
            try
            {
                switch (el.ValueKind)
                {
                    case JsonValueKind.String:
                    {
                        var s = el.GetString() ?? "";
                        if (s.Length > 80) s = s.Substring(0, 80) + "...";
                        return "\"" + s + "\"";
                    }
                    case JsonValueKind.Array:
                        return "array(len=" + el.GetArrayLength().ToString(CultureInfo.InvariantCulture) + ")";
                    case JsonValueKind.Object:
                        return "object";
                    default:
                        return el.GetRawText();
                }
            }
            catch
            {
                return "<unavailable>";
            }
        }

        private static bool IsNullOrObject(JsonElement? body, out JsonElement? obj)
        {
            obj = null;
            if (!body.HasValue) return true;
            if (body.Value.ValueKind == JsonValueKind.Null) return true;
            if (body.Value.ValueKind != JsonValueKind.Object) return false;
            obj = body.Value;
            return true;
        }

        private static JsonElement? ToJsonElement(object? body)
        {
            if (body == null) return null;
            if (body is JsonElement je) return je;

            // Best-effort normalize.
            var json = JsonSerializer.Serialize(body, OperatorUiProtocol.JsonOptions);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.Clone();
        }

        private static bool IsSafeFileName(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return true;
            if (input.Contains("\\") || input.Contains("/")) return false;
            if (input.Contains(":")) return false;
            if (input.Length > 120) return false;

            foreach (var ch in Path.GetInvalidFileNameChars())
            {
                if (input.IndexOf(ch) >= 0) return false;
            }

            return true;
        }
    }
}


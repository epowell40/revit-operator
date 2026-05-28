using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Operator
{
    internal enum OperatorNativeApiProfile
    {
        Balanced = 0,
        Broad = 1,
        Unrestricted = 2
    }

    internal sealed class NativeApiMemberDescriptor
    {
        public string MemberId { get; set; } = "";
        public string Namespace { get; set; } = "";
        public string TypeName { get; set; } = "";
        public string Name { get; set; } = "";
        public string Kind { get; set; } = "";
        public string Signature { get; set; } = "";
        public string ReturnType { get; set; } = "";
        public string Risk { get; set; } = "high";
        public int Priority { get; set; } = 50;
        public bool MutatingHint { get; set; }
        public bool FreezeRiskHint { get; set; }
        public bool IsStatic { get; set; }
        public int ParameterCount { get; set; }
        public string[] ParameterTypes { get; set; } = Array.Empty<string>();
        public bool Callable { get; set; }
        public string[] UnsupportedParameterTypes { get; set; } = Array.Empty<string>();
        public string DocsSearchUrl { get; set; } = "";

        [JsonIgnore] public OperatorActionRisk RiskLevel { get; set; } = OperatorActionRisk.High;
        [JsonIgnore] public MethodBase? Method { get; set; }
        [JsonIgnore] public Type? DeclaringType { get; set; }
        [JsonIgnore] public string SearchText { get; set; } = "";
    }

    internal sealed class NativeApiPolicySnapshot
    {
        public OperatorNativeApiProfile Profile { get; set; } = OperatorNativeApiProfile.Broad;
        public OperatorActionRisk MaxRisk { get; set; } = OperatorActionRisk.High;
        public bool AllowMutating { get; set; } = true;
        public bool BlockFreezeRisk { get; set; } = true;
        public bool Locked { get; set; }
        public int MaxResults { get; set; } = 200;
        public int MaxInvocationParams { get; set; } = 10;
        public string Source { get; set; } = "default";
        public string[] BlockedTypePrefixes { get; set; } = Array.Empty<string>();
        public string[] BlockedMethodTokens { get; set; } = Array.Empty<string>();
    }

    internal static class OperatorNativeApiPolicy
    {
        private static readonly object _lock = new object();
        private static NativeApiPolicySnapshot? _state;

        public static NativeApiPolicySnapshot Snapshot()
        {
            lock (_lock)
            {
                if (_state == null) _state = BuildInitial();
                return Clone(_state);
            }
        }

        public static object GetStatus()
        {
            var s = Snapshot();
            return new
            {
                version = "operator.native_api_policy.v1",
                generated_at = DateTime.UtcNow.ToString("o"),
                profile = ProfileToString(s.Profile),
                max_risk = RiskToString(s.MaxRisk),
                allow_mutating = s.AllowMutating,
                block_freeze_risk = s.BlockFreezeRisk,
                locked = s.Locked,
                source = s.Source,
                max_results = s.MaxResults,
                max_invocation_params = s.MaxInvocationParams,
                blocked_type_prefixes = s.BlockedTypePrefixes,
                blocked_method_tokens = s.BlockedMethodTokens
            };
        }

        public static object SetPolicy(string? profile, string? maxRisk, bool? allowMutating, bool? blockFreezeRisk, int? maxResults, int? maxInvocationParams)
        {
            lock (_lock)
            {
                if (_state == null) _state = BuildInitial();
                if (_state.Locked)
                {
                    return new { ok = false, error = "Native API policy is locked by enterprise settings.", policy = GetStatus() };
                }

                if (!string.IsNullOrWhiteSpace(profile))
                {
                    _state.Profile = ParseProfile(profile, _state.Profile);
                    ApplyProfileDefaults(_state);
                }
                if (!string.IsNullOrWhiteSpace(maxRisk)) _state.MaxRisk = ParseRisk(maxRisk, _state.MaxRisk);
                if (allowMutating.HasValue) _state.AllowMutating = allowMutating.Value;
                if (blockFreezeRisk.HasValue) _state.BlockFreezeRisk = blockFreezeRisk.Value;
                if (maxResults.HasValue) _state.MaxResults = Clamp(maxResults.Value, 20, 1000);
                if (maxInvocationParams.HasValue) _state.MaxInvocationParams = Clamp(maxInvocationParams.Value, 1, 50);
                _state.Source = "runtime";
                return new { ok = true, policy = GetStatus() };
            }
        }

        public static bool IsAllowed(NativeApiMemberDescriptor d, out string reason)
        {
            var s = Snapshot();
            if (!d.Callable)
            {
                reason = "Unsupported parameter types for this gateway.";
                return false;
            }
            if (s.BlockedTypePrefixes.Any(p => !string.IsNullOrWhiteSpace(p) && d.TypeName.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
            {
                reason = "Type blocked by enterprise policy.";
                return false;
            }
            if (s.BlockedMethodTokens.Any(t => !string.IsNullOrWhiteSpace(t) && d.Name.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0))
            {
                reason = "Method blocked by enterprise policy.";
                return false;
            }
            if (!s.AllowMutating && d.MutatingHint)
            {
                reason = "Mutating calls disabled by current profile.";
                return false;
            }
            if (s.BlockFreezeRisk && d.FreezeRiskHint)
            {
                reason = "Freeze-risk calls disabled by current profile.";
                return false;
            }
            if (d.RiskLevel > s.MaxRisk)
            {
                reason = $"Risk '{d.Risk}' exceeds max_risk '{RiskToString(s.MaxRisk)}'.";
                return false;
            }
            if (d.ParameterCount > s.MaxInvocationParams)
            {
                reason = $"Parameter count {d.ParameterCount} exceeds max_invocation_params {s.MaxInvocationParams}.";
                return false;
            }
            reason = "";
            return true;
        }

        public static string RiskToString(OperatorActionRisk r) => r == OperatorActionRisk.Low ? "low" : (r == OperatorActionRisk.Medium ? "medium" : "high");

        private static NativeApiPolicySnapshot BuildInitial()
        {
            var s = new NativeApiPolicySnapshot
            {
                Profile = ParseProfile(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_PROFILE"), OperatorNativeApiProfile.Broad),
                Locked = ParseBool(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_POLICY_LOCKED"), false),
                MaxResults = Clamp(ParseInt(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_MAX_RESULTS"), 200), 20, 1000),
                MaxInvocationParams = Clamp(ParseInt(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_MAX_INVOCATION_PARAMS"), 10), 1, 50),
                BlockedTypePrefixes = ParseCsv(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_BLOCKED_TYPE_PREFIXES"), "Autodesk.Revit.ApplicationServices.ControlledApplication"),
                BlockedMethodTokens = ParseCsv(Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_BLOCKED_METHOD_TOKENS"), "Shutdown,Quit,Exit"),
                Source = "env/default"
            };
            ApplyProfileDefaults(s);
            var envRisk = Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_MAX_RISK");
            if (!string.IsNullOrWhiteSpace(envRisk)) s.MaxRisk = ParseRisk(envRisk, s.MaxRisk);
            var envMut = Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_ALLOW_MUTATING");
            if (!string.IsNullOrWhiteSpace(envMut)) s.AllowMutating = ParseBool(envMut, s.AllowMutating);
            var envFreeze = Environment.GetEnvironmentVariable("OPERATOR_NATIVE_API_BLOCK_FREEZE_RISK");
            if (!string.IsNullOrWhiteSpace(envFreeze)) s.BlockFreezeRisk = ParseBool(envFreeze, s.BlockFreezeRisk);
            return s;
        }

        private static void ApplyProfileDefaults(NativeApiPolicySnapshot s)
        {
            if (s.Profile == OperatorNativeApiProfile.Balanced)
            {
                s.MaxRisk = OperatorActionRisk.Medium;
                s.AllowMutating = false;
                s.BlockFreezeRisk = true;
            }
            else if (s.Profile == OperatorNativeApiProfile.Unrestricted)
            {
                s.MaxRisk = OperatorActionRisk.High;
                s.AllowMutating = true;
                s.BlockFreezeRisk = false;
            }
            else
            {
                s.MaxRisk = OperatorActionRisk.High;
                s.AllowMutating = true;
                s.BlockFreezeRisk = true;
            }
        }

        private static NativeApiPolicySnapshot Clone(NativeApiPolicySnapshot s) =>
            new NativeApiPolicySnapshot
            {
                Profile = s.Profile,
                MaxRisk = s.MaxRisk,
                AllowMutating = s.AllowMutating,
                BlockFreezeRisk = s.BlockFreezeRisk,
                Locked = s.Locked,
                MaxResults = s.MaxResults,
                MaxInvocationParams = s.MaxInvocationParams,
                Source = s.Source,
                BlockedTypePrefixes = s.BlockedTypePrefixes.ToArray(),
                BlockedMethodTokens = s.BlockedMethodTokens.ToArray()
            };

        private static OperatorNativeApiProfile ParseProfile(string? raw, OperatorNativeApiProfile fallback)
        {
            var v = (raw ?? "").Trim().ToLowerInvariant();
            if (v == "balanced" || v == "safe") return OperatorNativeApiProfile.Balanced;
            if (v == "unrestricted" || v == "max" || v == "unsafe") return OperatorNativeApiProfile.Unrestricted;
            if (v == "broad" || v == "default") return OperatorNativeApiProfile.Broad;
            return fallback;
        }

        private static string ProfileToString(OperatorNativeApiProfile p) => p == OperatorNativeApiProfile.Balanced ? "balanced" : (p == OperatorNativeApiProfile.Unrestricted ? "unrestricted" : "broad");
        private static OperatorActionRisk ParseRisk(string? raw, OperatorActionRisk fallback)
        {
            var v = (raw ?? "").Trim().ToLowerInvariant();
            if (v == "low") return OperatorActionRisk.Low;
            if (v == "medium") return OperatorActionRisk.Medium;
            if (v == "high") return OperatorActionRisk.High;
            return fallback;
        }
        private static bool ParseBool(string? raw, bool fallback)
        {
            var v = (raw ?? "").Trim().ToLowerInvariant();
            if (v == "1" || v == "true" || v == "yes" || v == "on") return true;
            if (v == "0" || v == "false" || v == "no" || v == "off") return false;
            return fallback;
        }
        private static int ParseInt(string? raw, int fallback) => int.TryParse((raw ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : fallback;
        private static int Clamp(int v, int min, int max) => v < min ? min : (v > max ? max : v);
        private static string[] ParseCsv(string? raw, string fallback)
        {
            var input = string.IsNullOrWhiteSpace(raw) ? fallback : raw;
            return input.Split(new[] { ',', ';', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries).Select(x => x.Trim()).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }
    }

    internal static class OperatorNativeApiGateway
    {
        private static readonly object _lock = new object();
        private static List<NativeApiMemberDescriptor>? _catalog;
        private static Dictionary<string, NativeApiMemberDescriptor>? _byId;
        private static DateTime _builtAtUtc = DateTime.MinValue;
        private static int _typeCount;

        public static object GetCatalog(string? query, string? namespacePrefix, string? typeContains, string? risk, int offset, int limit)
        {
            EnsureCatalog();
            var policy = OperatorNativeApiPolicy.Snapshot();
            var maxRisk = ParseRiskOrNull(risk);
            var q = (query ?? "").Trim().ToLowerInvariant();
            var ns = (namespacePrefix ?? "").Trim();
            var tc = (typeContains ?? "").Trim().ToLowerInvariant();
            var safeOffset = Math.Max(0, offset);
            var safeLimit = Math.Max(1, Math.Min(limit <= 0 ? 80 : limit, policy.MaxResults));

            IEnumerable<NativeApiMemberDescriptor> filtered = _catalog!;
            if (!string.IsNullOrWhiteSpace(ns)) filtered = filtered.Where(x => x.Namespace.StartsWith(ns, StringComparison.OrdinalIgnoreCase));
            if (!string.IsNullOrWhiteSpace(tc)) filtered = filtered.Where(x => x.TypeName.IndexOf(tc, StringComparison.OrdinalIgnoreCase) >= 0);
            if (maxRisk.HasValue) filtered = filtered.Where(x => x.RiskLevel <= maxRisk.Value);

            List<NativeApiMemberDescriptor> ordered;
            if (!string.IsNullOrWhiteSpace(q))
            {
                ordered = filtered.Select(x => new { member = x, score = Score(x, q) }).Where(x => x.score > 0).OrderByDescending(x => x.score).ThenByDescending(x => x.member.Priority).ThenBy(x => x.member.MemberId, StringComparer.OrdinalIgnoreCase).Select(x => x.member).ToList();
            }
            else
            {
                ordered = filtered.OrderByDescending(x => x.Priority).ThenBy(x => x.MemberId, StringComparer.OrdinalIgnoreCase).ToList();
            }

            var total = ordered.Count;
            var items = ordered.Skip(safeOffset).Take(safeLimit).Select(ToPublicItem).ToList();
            return new
            {
                version = "operator.native_api_catalog.v1",
                generated_at = _builtAtUtc.ToString("o"),
                summary = new { total_types = _typeCount, total_members = _catalog!.Count },
                policy = OperatorNativeApiPolicy.GetStatus(),
                query = string.IsNullOrWhiteSpace(q) ? null : query,
                offset = safeOffset,
                limit = safeLimit,
                total,
                returned = items.Count,
                items
            };
        }

        public static object Search(string query, string? namespacePrefix, string? risk, int max)
        {
            EnsureCatalog();
            if (string.IsNullOrWhiteSpace(query)) return new { ok = false, error = "query is required." };
            var policy = OperatorNativeApiPolicy.Snapshot();
            var safeMax = Math.Max(1, Math.Min(max <= 0 ? 20 : max, policy.MaxResults));
            var q = query.Trim().ToLowerInvariant();
            var ns = (namespacePrefix ?? "").Trim();
            var maxRisk = ParseRiskOrNull(risk);

            var ranked = _catalog!
                .Where(x => string.IsNullOrWhiteSpace(ns) || x.Namespace.StartsWith(ns, StringComparison.OrdinalIgnoreCase))
                .Where(x => !maxRisk.HasValue || x.RiskLevel <= maxRisk.Value)
                .Select(x => new { member = x, score = Score(x, q) })
                .Where(x => x.score > 0)
                .OrderByDescending(x => x.score)
                .ThenByDescending(x => x.member.Priority)
                .Take(safeMax)
                .Select(x => new { score = x.score, item = ToPublicItem(x.member) })
                .ToList();

            return new
            {
                version = "operator.native_api_search.v1",
                generated_at = _builtAtUtc.ToString("o"),
                query,
                returned = ranked.Count,
                items = ranked
            };
        }

        public static object Invoke(UIApplication app, string memberId, string? target, JsonElement? args, bool dryRun)
        {
            EnsureCatalog();
            var id = (memberId ?? "").Trim();
            if (string.IsNullOrWhiteSpace(id)) throw new InvalidOperationException("memberId is required.");
            if (!_byId!.TryGetValue(id, out var descriptor) || descriptor.Method == null) throw new InvalidOperationException($"Unknown memberId: {id}");
            if (!OperatorNativeApiPolicy.IsAllowed(descriptor, out var reason)) throw new InvalidOperationException($"Native API call blocked: {reason}");

            var method = descriptor.Method;
            var ps = method.GetParameters();
            var provided = ReadArgs(args);
            var values = new object?[ps.Length];
            for (var i = 0; i < ps.Length; i++)
            {
                var p = ps[i];
                if (p.IsOut || p.ParameterType.IsByRef) throw new InvalidOperationException($"Unsupported by-ref parameter: {p.Name}");
                if (i < provided.Count)
                {
                    values[i] = ConvertValue(provided[i], p.ParameterType);
                    continue;
                }
                if (TryResolveContextObject(p.ParameterType, app, out var ctx))
                {
                    values[i] = ctx;
                    continue;
                }
                if (p.HasDefaultValue)
                {
                    values[i] = p.DefaultValue;
                    continue;
                }
                throw new InvalidOperationException($"Missing argument for parameter '{p.Name}' ({p.ParameterType.Name}).");
            }

            if (dryRun && descriptor.MutatingHint)
            {
                return new { ok = true, dry_run = true, blocked_execution = true, member_id = descriptor.MemberId, signature = descriptor.Signature };
            }

            var invokeTarget = ResolveTarget(descriptor, app, target);
            var sw = Stopwatch.StartNew();
            object? raw = null;
            try
            {
                if (method is MethodInfo mi) raw = mi.Invoke(mi.IsStatic ? null : invokeTarget, values);
                else if (method is ConstructorInfo ci) raw = ci.Invoke(values);
                else throw new InvalidOperationException("Unsupported member type.");
            }
            catch (TargetInvocationException tie)
            {
                var root = tie.InnerException ?? tie;
                throw new InvalidOperationException($"Native API invocation failed: {root.Message}", root);
            }
            finally
            {
                sw.Stop();
            }

            return new
            {
                ok = true,
                member_id = descriptor.MemberId,
                signature = descriptor.Signature,
                risk = descriptor.Risk,
                duration_ms = sw.ElapsedMilliseconds,
                result = ReturnShape(raw, 0)
            };
        }

        private static object ToPublicItem(NativeApiMemberDescriptor d)
        {
            var allowed = OperatorNativeApiPolicy.IsAllowed(d, out var reason);
            return new
            {
                member_id = d.MemberId,
                @namespace = d.Namespace,
                type = d.TypeName,
                name = d.Name,
                kind = d.Kind,
                signature = d.Signature,
                return_type = d.ReturnType,
                is_static = d.IsStatic,
                parameter_count = d.ParameterCount,
                parameter_types = d.ParameterTypes,
                risk = d.Risk,
                mutating_hint = d.MutatingHint,
                freeze_risk_hint = d.FreezeRiskHint,
                priority = d.Priority,
                callable = d.Callable,
                unsupported_parameter_types = d.UnsupportedParameterTypes,
                allowed,
                blocked_reason = allowed ? null : reason,
                docs_search_url = d.DocsSearchUrl
            };
        }

        private static void EnsureCatalog()
        {
            if (_catalog != null && _byId != null) return;
            lock (_lock)
            {
                if (_catalog != null && _byId != null) return;
                var members = new List<NativeApiMemberDescriptor>(20000);
                var byId = new Dictionary<string, NativeApiMemberDescriptor>(StringComparer.OrdinalIgnoreCase);
                var types = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var asm in new[] { typeof(Element).Assembly, typeof(UIApplication).Assembly }.Distinct())
                {
                    Type[] exported;
                    try { exported = asm.GetExportedTypes(); } catch { continue; }
                    foreach (var t in exported)
                    {
                        var ns = t.Namespace ?? "";
                        if (!ns.StartsWith("Autodesk.Revit", StringComparison.Ordinal)) continue;
                        types.Add(t.FullName ?? t.Name);
                        foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                        {
                            if (m.IsSpecialName || m.ContainsGenericParameters) continue;
                            var d = BuildDescriptor(t, m, "method");
                            if (d == null || byId.ContainsKey(d.MemberId)) continue;
                            byId[d.MemberId] = d;
                            members.Add(d);
                        }
                        foreach (var c in t.GetConstructors(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                        {
                            if (c.ContainsGenericParameters) continue;
                            var d = BuildDescriptor(t, c, "ctor");
                            if (d == null || byId.ContainsKey(d.MemberId)) continue;
                            byId[d.MemberId] = d;
                            members.Add(d);
                        }
                    }
                }
                _catalog = members;
                _byId = byId;
                _typeCount = types.Count;
                _builtAtUtc = DateTime.UtcNow;
            }
        }

        private static NativeApiMemberDescriptor? BuildDescriptor(Type t, MethodBase m, string kind)
        {
            var ps = m.GetParameters();
            var paramTypes = ps.Select(x => FriendlyType(x.ParameterType)).ToArray();
            var unsupported = new List<string>();
            foreach (var p in ps)
            {
                if (p.IsOut || p.ParameterType.IsByRef) unsupported.Add(p.ParameterType.FullName ?? p.ParameterType.Name);
                else if (!IsSupportedType(p.ParameterType) && !p.HasDefaultValue && !CanResolveContextParameter(p.ParameterType)) unsupported.Add(p.ParameterType.FullName ?? p.ParameterType.Name);
            }

            var mut = IsMutatingHint(m.Name);
            var freeze = IsFreezeRiskHint(m.Name, t);
            var riskLevel = freeze || mut ? OperatorActionRisk.High : OperatorActionRisk.Low;
            var id = $"{(kind == "ctor" ? "ctor" : "method")}:{t.FullName}{(kind == "ctor" ? "" : "." + m.Name)}({string.Join(",", ps.Select(x => x.ParameterType.FullName ?? x.ParameterType.Name))})";
            var sig = $"{(m is MethodInfo mi ? FriendlyType(mi.ReturnType) : t.Name)} {t.Name}.{(kind == "ctor" ? ".ctor" : m.Name)}({string.Join(", ", ps.Select(x => $"{FriendlyType(x.ParameterType)} {x.Name}"))})";
            var name = kind == "ctor" ? ".ctor" : m.Name;
            return new NativeApiMemberDescriptor
            {
                MemberId = id,
                Namespace = t.Namespace ?? "",
                TypeName = t.FullName ?? t.Name,
                Name = name,
                Kind = kind,
                Signature = sig,
                ReturnType = m is MethodInfo mi2 ? FriendlyType(mi2.ReturnType) : t.Name,
                Risk = OperatorNativeApiPolicy.RiskToString(riskLevel),
                RiskLevel = riskLevel,
                Priority = EstimatePriority(m.Name, m.IsStatic, ps.Length, unsupported.Count == 0, mut, freeze),
                MutatingHint = mut,
                FreezeRiskHint = freeze,
                IsStatic = m.IsStatic,
                ParameterCount = ps.Length,
                ParameterTypes = paramTypes,
                Callable = unsupported.Count == 0,
                UnsupportedParameterTypes = unsupported.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(),
                DocsSearchUrl = "https://www.revitapidocs.com/search/?query=" + Uri.EscapeDataString($"{t.FullName}.{m.Name}"),
                Method = m,
                DeclaringType = t,
                SearchText = $"{t.FullName} {m.Name} {string.Join(" ", paramTypes)}".ToLowerInvariant()
            };
        }

        private static object? ResolveTarget(NativeApiMemberDescriptor d, UIApplication app, string? target)
        {
            if (d.Method == null || d.Method.IsStatic) return null;
            if (!string.IsNullOrWhiteSpace(target))
            {
                var tok = target.Trim().ToLowerInvariant();
                object? explicitTarget = tok == "uiapp" || tok == "application" ? app : (tok == "uidoc" ? app.ActiveUIDocument : (tok == "doc" || tok == "document" ? app.ActiveUIDocument?.Document : (tok == "view" || tok == "activeview" ? app.ActiveUIDocument?.Document?.ActiveView : null)));
                if (explicitTarget == null) throw new InvalidOperationException($"Unsupported target token: {target}");
                if (d.DeclaringType != null && !d.DeclaringType.IsInstanceOfType(explicitTarget)) throw new InvalidOperationException($"Target token '{target}' is incompatible with {d.DeclaringType.FullName}.");
                return explicitTarget;
            }
            if (d.DeclaringType != null && TryResolveContextObject(d.DeclaringType, app, out var inferred)) return inferred;
            throw new InvalidOperationException("Instance member requires target=\"uiapp\"|\"uidoc\"|\"doc\"|\"view\".");
        }

        private static List<JsonElement> ReadArgs(JsonElement? args)
        {
            var list = new List<JsonElement>();
            if (!args.HasValue || args.Value.ValueKind == JsonValueKind.Null) return list;
            if (args.Value.ValueKind != JsonValueKind.Array) throw new InvalidOperationException("args must be an array.");
            foreach (var el in args.Value.EnumerateArray()) list.Add(el);
            return list;
        }

        private static object? ConvertValue(JsonElement value, Type targetType)
        {
            var nt = Nullable.GetUnderlyingType(targetType);
            if (nt != null) return value.ValueKind == JsonValueKind.Null ? null : ConvertValue(value, nt);
            if (targetType == typeof(string)) return value.ValueKind == JsonValueKind.String ? value.GetString() : value.GetRawText();
            if (targetType == typeof(bool)) return value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False ? value.GetBoolean() : bool.Parse(value.GetString() ?? "false");
            if (targetType == typeof(int)) return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var i) ? i : int.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture);
            if (targetType == typeof(long)) return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var l) ? l : long.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture);
            if (targetType == typeof(double)) return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var d) ? d : double.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture);
            if (targetType == typeof(float)) return value.ValueKind == JsonValueKind.Number && value.TryGetSingle(out var f) ? f : float.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture);
            if (targetType == typeof(decimal)) return value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var dm) ? dm : decimal.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture);
            if (targetType.IsEnum) return value.ValueKind == JsonValueKind.String ? Enum.Parse(targetType, value.GetString() ?? "", true) : Enum.ToObject(targetType, value.GetInt32());
            if (targetType == typeof(ElementId)) return new ElementId(value.ValueKind == JsonValueKind.Number ? value.GetInt32() : int.Parse(value.GetString() ?? "0", CultureInfo.InvariantCulture));
            if (targetType == typeof(XYZ))
            {
                if (value.ValueKind == JsonValueKind.Array)
                {
                    var arr = value.EnumerateArray().ToArray();
                    return new XYZ(ReadNumber(arr, 0), ReadNumber(arr, 1), arr.Length > 2 ? ReadNumber(arr, 2) : 0d);
                }
                var x = ReadNamedNumber(value, "x", "X");
                var y = ReadNamedNumber(value, "y", "Y");
                var z = ReadNamedNumber(value, false, "z", "Z") ?? 0d;
                return new XYZ(x ?? 0d, y ?? 0d, z);
            }
            if (targetType == typeof(UV))
            {
                if (value.ValueKind == JsonValueKind.Array)
                {
                    var arr = value.EnumerateArray().ToArray();
                    return new UV(ReadNumber(arr, 0), ReadNumber(arr, 1));
                }
                var u = ReadNamedNumber(value, "u", "U", "x", "X");
                var v = ReadNamedNumber(value, "v", "V", "y", "Y");
                return new UV(u ?? 0d, v ?? 0d);
            }
            if (targetType.IsArray)
            {
                var et = targetType.GetElementType() ?? typeof(object);
                var arr = value.EnumerateArray().Select(x => ConvertValue(x, et)).ToArray();
                var output = Array.CreateInstance(et, arr.Length);
                for (var i = 0; i < arr.Length; i++) output.SetValue(arr[i], i);
                return output;
            }
            if (targetType.IsGenericType)
            {
                var def = targetType.GetGenericTypeDefinition();
                if (def == typeof(List<>) || def == typeof(IList<>) || def == typeof(IEnumerable<>) || def == typeof(IReadOnlyList<>))
                {
                    var et = targetType.GetGenericArguments()[0];
                    var listType = typeof(List<>).MakeGenericType(et);
                    var list = (IList)Activator.CreateInstance(listType)!;
                    foreach (var item in value.EnumerateArray()) list.Add(ConvertValue(item, et));
                    return list;
                }
            }
            if (targetType == typeof(object)) return JsonSerializer.Deserialize<object>(value.GetRawText(), OperatorUiProtocol.JsonOptions);
            throw new InvalidOperationException($"Unsupported parameter type: {targetType.FullName}");
        }

        private static object? ReturnShape(object? value, int depth)
        {
            if (depth > 3) return value?.ToString();
            if (value == null) return null;
            if (value is string || value is bool || value is int || value is long || value is double || value is float || value is decimal) return value;
            if (value is Enum) return value.ToString();
            if (value is ElementId eid) return new { id = eid.IntegerValue };
            if (value is XYZ xyz) return new { x = xyz.X, y = xyz.Y, z = xyz.Z };
            if (value is UV uv) return new { u = uv.U, v = uv.V };
            if (value is Element el) return new { id = el.Id?.IntegerValue, unique_id = Safe(() => el.UniqueId), name = Safe(() => el.Name), category = Safe(() => el.Category?.Name) };
            if (value is Document doc) return new { title = Safe(() => doc.Title), path = Safe(() => doc.PathName), is_modifiable = SafeBool(() => doc.IsModifiable) };
            if (value is View view) return new { id = view.Id?.IntegerValue, name = Safe(() => view.Name), view_type = view.ViewType.ToString() };
            if (value is IEnumerable seq)
            {
                var outItems = new List<object?>();
                var i = 0;
                foreach (var item in seq)
                {
                    outItems.Add(ReturnShape(item, depth + 1));
                    i++;
                    if (i >= 50) break;
                }
                return new { count = i, items = outItems };
            }
            return new { type = value.GetType().FullName ?? value.GetType().Name, text = Trim(value.ToString(), 600) };
        }

        private static string FriendlyType(Type t)
        {
            var nt = Nullable.GetUnderlyingType(t);
            if (nt != null) return FriendlyType(nt) + "?";
            if (t == typeof(int)) return "int";
            if (t == typeof(long)) return "long";
            if (t == typeof(double)) return "double";
            if (t == typeof(float)) return "float";
            if (t == typeof(decimal)) return "decimal";
            if (t == typeof(bool)) return "bool";
            if (t == typeof(string)) return "string";
            if (t == typeof(void)) return "void";
            if (t.IsArray) return FriendlyType(t.GetElementType() ?? typeof(object)) + "[]";
            if (t.IsGenericType) { var n = t.Name; var tick = n.IndexOf('`'); if (tick > 0) n = n.Substring(0, tick); return n + "<" + string.Join(", ", t.GetGenericArguments().Select(FriendlyType)) + ">"; }
            return t.Name;
        }

        private static bool IsSupportedType(Type t)
        {
            var nt = Nullable.GetUnderlyingType(t);
            if (nt != null) return IsSupportedType(nt);
            if (t.IsEnum) return true;
            if (t == typeof(string) || t == typeof(bool) || t == typeof(int) || t == typeof(long) || t == typeof(double) || t == typeof(float) || t == typeof(decimal) || t == typeof(ElementId) || t == typeof(XYZ) || t == typeof(UV) || t == typeof(object)) return true;
            if (CanResolveContextParameter(t)) return true;
            if (t.IsArray) return IsSupportedType(t.GetElementType() ?? typeof(object));
            if (t.IsGenericType) { var def = t.GetGenericTypeDefinition(); if (def == typeof(List<>) || def == typeof(IList<>) || def == typeof(IEnumerable<>) || def == typeof(IReadOnlyList<>)) return IsSupportedType(t.GetGenericArguments()[0]); }
            return false;
        }

        private static bool CanResolveContextParameter(Type t) => t == typeof(UIApplication) || t == typeof(UIDocument) || t == typeof(Document) || t == typeof(View);
        private static bool TryResolveContextObject(Type t, UIApplication app, out object? value)
        {
            value = null;
            if (t == typeof(UIApplication) || t.IsAssignableFrom(typeof(UIApplication))) { value = app; return true; }
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc?.Document;
            var view = doc?.ActiveView;
            if (uidoc != null && (t == typeof(UIDocument) || t.IsAssignableFrom(uidoc.GetType()))) { value = uidoc; return true; }
            if (doc != null && (t == typeof(Document) || t.IsAssignableFrom(doc.GetType()))) { value = doc; return true; }
            if (view != null && (t == typeof(View) || t.IsAssignableFrom(view.GetType()))) { value = view; return true; }
            return false;
        }

        private static int Score(NativeApiMemberDescriptor m, string q)
        {
            var s = 0;
            var tokens = q.Split(new[] { ' ', '\t', '\r', '\n', '/', '-', '_' }, StringSplitOptions.RemoveEmptyEntries);
            if (m.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) s += 80;
            if (m.TypeName.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) s += 60;
            if (m.Signature.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0) s += 50;
            foreach (var t in tokens) { if (m.SearchText.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0) s += 8; }
            s += m.Priority / 3;
            if (m.Callable) s += 4;
            return s;
        }

        private static bool IsMutatingHint(string name)
        {
            var n = (name ?? "").ToLowerInvariant();
            var prefixes = new[] { "set", "add", "create", "delete", "remove", "insert", "move", "rotate", "copy", "open", "save", "load", "sync", "purge", "regenerate", "commit", "rollback", "apply", "rename", "change", "modify", "post" };
            return prefixes.Any(p => n.StartsWith(p, StringComparison.Ordinal));
        }
        private static bool IsFreezeRiskHint(string name, Type t)
        {
            var n = ((name ?? "") + " " + (t.FullName ?? "")).ToLowerInvariant();
            var tokens = new[] { "export", "print", "render", "sync", "open", "save", "load", "reload", "purge", "regenerate", "analy", "audit", "ifc", "dwg", "pdf" };
            return tokens.Any(tok => n.IndexOf(tok, StringComparison.Ordinal) >= 0);
        }
        private static int EstimatePriority(string name, bool isStatic, int paramCount, bool callable, bool mut, bool freeze)
        {
            var s = 50;
            var n = (name ?? "").ToLowerInvariant();
            if (n.StartsWith("get", StringComparison.Ordinal) || n.StartsWith("find", StringComparison.Ordinal) || n.StartsWith("try", StringComparison.Ordinal)) s += 18;
            if (isStatic) s += 6;
            if (paramCount <= 2) s += 12; else if (paramCount >= 6) s -= 10;
            if (mut) s -= 10;
            if (freeze) s -= 20;
            if (!callable) s -= 20;
            if (s < 0) s = 0;
            if (s > 100) s = 100;
            return s;
        }

        private static OperatorActionRisk? ParseRiskOrNull(string? raw)
        {
            var v = (raw ?? "").Trim().ToLowerInvariant();
            if (v == "low") return OperatorActionRisk.Low;
            if (v == "medium") return OperatorActionRisk.Medium;
            if (v == "high") return OperatorActionRisk.High;
            return null;
        }

        private static double ReadNumber(JsonElement[] arr, int idx)
        {
            if (idx >= arr.Length) throw new InvalidOperationException("Vector component missing.");
            var el = arr[idx];
            if (el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d)) return d;
            if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var s)) return s;
            throw new InvalidOperationException("Expected numeric vector component.");
        }
        private static double? ReadNamedNumber(JsonElement obj, params string[] names) => ReadNamedNumber(obj, true, names);
        private static double? ReadNamedNumber(JsonElement obj, bool required, params string[] names)
        {
            if (obj.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Expected object input.");
            foreach (var n in names)
            {
                if (!obj.TryGetProperty(n, out var el)) continue;
                if (el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d)) return d;
                if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var s)) return s;
                throw new InvalidOperationException($"Expected numeric value for '{n}'.");
            }
            if (required) throw new InvalidOperationException($"Missing required numeric field '{(names.Length > 0 ? names[0] : "value")}'.");
            return null;
        }
        private static string? Safe(Func<string?> getter) { try { return getter(); } catch { return null; } }
        private static bool? SafeBool(Func<bool> getter) { try { return getter(); } catch { return null; } }
        private static string Trim(string? s, int max) { var v = s ?? ""; return v.Length <= max ? v : v.Substring(0, max) + "..."; }
    }
}

using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class LinkRevitHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public string? action { get; set; }
            public long? linkTypeId { get; set; }
            public bool? dryRun { get; set; }
            public bool? pin { get; set; }
            public double? x { get; set; }
            public double? y { get; set; }
            public double? z { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;
            var action = (p.action ?? "link").Trim().ToLowerInvariant();
            if (action == "unload") return Task.FromResult(UnloadRevitLinkType(doc, p));
            if (action == "reload") return Task.FromResult(ReloadRevitLinkType(doc, p));
            if (action != "link") throw new InvalidOperationException("link-revit.action must be 'link', 'reload', or 'unload'.");

            var src = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(src)) throw new InvalidOperationException("link-revit.sourcePath is required.");

            var full = ResolveSourcePath(src);
            var ext = (Path.GetExtension(full) ?? "").Trim().ToLowerInvariant();
            if (ext != ".rvt") throw new InvalidOperationException("link-revit only supports .rvt files.");

            var dryRun = p.dryRun ?? false;
            var offset = new XYZ(p.x ?? 0, p.y ?? 0, p.z ?? 0);
            var plan = new
            {
                sourcePath = src,
                sourceFullPath = full,
                dryRun,
                placement = "origin",
                offset = new { x = offset.X, y = offset.Y, z = offset.Z },
                pin = p.pin ?? false
            };

            if (dryRun)
            {
                return Task.FromResult<object>(new { status = "Dry Run", dryRun = true, plan });
            }

            using (var t = new Transaction(doc, "Link Revit Model"))
            {
                t.Start();

                var linkTypeId = FindExistingRevitLinkType(doc, full) ?? CreateRevitLinkType(doc, full);
                var instanceId = CreateRevitLinkInstance(doc, linkTypeId);

                if (offset.GetLength() > 1e-9)
                {
                    ElementTransformUtils.MoveElement(doc, instanceId, offset);
                }

                var instance = doc.GetElement(instanceId);
                if (instance != null && (p.pin ?? false))
                {
                    instance.Pinned = true;
                }

                t.Commit();

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    sourcePath = src,
                    linkTypeId = ElementIdCompat.GetValue(linkTypeId),
                    linkInstanceId = ElementIdCompat.GetValue(instanceId),
                    placement = "origin",
                    offset = new { x = offset.X, y = offset.Y, z = offset.Z },
                    pinned = p.pin ?? false
                });
            }
        }

        private static object UnloadRevitLinkType(Document doc, Params p)
        {
            var rawId = p.linkTypeId ?? 0;
            if (rawId <= 0) throw new InvalidOperationException("link-revit.linkTypeId is required for action='unload'.");
            var dryRun = p.dryRun ?? false;
            var linkTypeId = ElementIdCompat.Create(rawId);
            var linkType = doc.GetElement(linkTypeId) as RevitLinkType;
            if (linkType == null)
                throw new InvalidOperationException($"Revit link type {rawId} was not found.");

            var plan = new
            {
                action = "unload",
                dryRun,
                linkTypeId = rawId,
                name = linkType.Name
            };
            if (dryRun)
                return new { status = "Dry Run", dryRun = true, plan };

            InvokeUnload(linkType);
            try { doc.Regenerate(); } catch { }
            return new
            {
                status = "Unloaded",
                action = "unload",
                dryRun = false,
                linkTypeId = rawId,
                name = linkType.Name
            };
        }

        private static object ReloadRevitLinkType(Document doc, Params p)
        {
            var rawId = p.linkTypeId ?? 0;
            if (rawId <= 0) throw new InvalidOperationException("link-revit.linkTypeId is required for action='reload'.");
            var sourcePath = (p.sourcePath ?? "").Trim();
            if (string.IsNullOrWhiteSpace(sourcePath))
                throw new InvalidOperationException("link-revit.sourcePath is required for action='reload'.");
            var fullPath = ResolveSourcePath(sourcePath);
            if (!string.Equals(Path.GetExtension(fullPath), ".rvt", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("link-revit reload only supports .rvt files.");

            var linkTypeId = ElementIdCompat.Create(rawId);
            var linkType = doc.GetElement(linkTypeId) as RevitLinkType;
            if (linkType == null)
                throw new InvalidOperationException($"Revit link type {rawId} was not found.");

            var dryRun = p.dryRun ?? false;
            var plan = new
            {
                action = "reload",
                dryRun,
                linkTypeId = rawId,
                name = linkType.Name,
                sourcePath,
                sourceFullPath = fullPath,
                preservesExistingInstances = true
            };
            if (dryRun) return new { status = "Dry Run", dryRun = true, plan };

            var modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(fullPath);
            var worksets = new WorksetConfiguration(WorksetConfigurationOption.OpenAllWorksets);
            var loadResult = linkType.LoadFrom(modelPath, worksets);
            try { doc.Regenerate(); } catch { }
            var loadedInstances = new FilteredElementCollector(doc)
                .OfClass(typeof(RevitLinkInstance))
                .Cast<RevitLinkInstance>()
                .Where(instance => instance.GetTypeId() == linkTypeId)
                .Select(instance => new
                {
                    instanceId = ElementIdCompat.GetValue(instance.Id),
                    loaded = instance.GetLinkDocument() != null
                })
                .ToList();
            if (loadedInstances.Count == 0 || loadedInstances.Any(instance => !instance.loaded))
                throw new InvalidOperationException($"Revit link type {rawId} did not load every existing instance from the requested path.");

            return new
            {
                status = "Reloaded",
                action = "reload",
                dryRun = false,
                linkTypeId = rawId,
                name = linkType.Name,
                sourcePath,
                sourceFullPath = fullPath,
                loadResult = loadResult?.ToString(),
                loadedInstances
            };
        }

        private static void InvokeUnload(RevitLinkType linkType)
        {
            var methods = typeof(RevitLinkType)
                .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                .Where(m => string.Equals(m.Name, "Unload", StringComparison.Ordinal))
                .OrderBy(m => m.GetParameters().Length)
                .ToList();

            Exception? lastError = null;
            foreach (var method in methods)
            {
                try
                {
                    var args = method.GetParameters()
                        .Select(param => param.ParameterType.IsValueType ? Activator.CreateInstance(param.ParameterType) : null)
                        .ToArray();
                    method.Invoke(linkType, args);
                    return;
                }
                catch (TargetInvocationException ex)
                {
                    lastError = ex.InnerException ?? ex;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }

            throw new InvalidOperationException(
                lastError == null
                    ? "This Revit API version does not expose RevitLinkType.Unload."
                    : $"Revit link type unload failed: {lastError.Message}");
        }

        private static string ResolveSourcePath(string userProvided)
        {
            try
            {
                return WorkspacePaths.ResolveExistingFileUnderWorkspace(userProvided);
            }
            catch
            {
                return OperatorSecurity.ResolveExistingExternalFileUnderAllowedRoots(userProvided);
            }
        }

        private static ElementId CreateRevitLinkType(Document doc, string fullPath)
        {
            var modelPath = ModelPathUtils.ConvertUserVisiblePathToModelPath(fullPath);
            var options = new RevitLinkOptions(false);
            var result = RevitLinkType.Create(doc, modelPath, options);
            var id = TryExtractElementId(result);
            if (id == null || id == ElementId.InvalidElementId)
                throw new InvalidOperationException("Revit link type creation failed (no link type id returned).");
            return id;
        }

        private static ElementId? FindExistingRevitLinkType(Document doc, string fullPath)
        {
            var target = NormalizePath(fullPath);
            if (string.IsNullOrWhiteSpace(target)) return null;

            foreach (var linkType in new FilteredElementCollector(doc).OfClass(typeof(RevitLinkType)).Cast<RevitLinkType>())
            {
                try
                {
                    var reference = linkType.GetExternalFileReference();
                    var modelPath = reference?.GetPath();
                    if (modelPath == null) continue;

                    var existing = NormalizePath(ModelPathUtils.ConvertModelPathToUserVisiblePath(modelPath));
                    if (string.Equals(existing, target, StringComparison.OrdinalIgnoreCase))
                        return linkType.Id;
                }
                catch
                {
                    continue;
                }
            }

            return null;
        }

        private static string NormalizePath(string path)
        {
            try
            {
                return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
            catch
            {
                return (path ?? "").Trim().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
        }

        private static ElementId CreateRevitLinkInstance(Document doc, ElementId linkTypeId)
        {
            var createMethods = typeof(RevitLinkInstance)
                .GetMethods(BindingFlags.Public | BindingFlags.Static)
                .Where(m => string.Equals(m.Name, "Create", StringComparison.Ordinal))
                .ToList();

            foreach (var m in createMethods)
            {
                try
                {
                    var ps = m.GetParameters();
                    if (ps.Length == 2 && ps[0].ParameterType == typeof(Document) && ps[1].ParameterType == typeof(ElementId))
                    {
                        var raw = m.Invoke(null, new object[] { doc, linkTypeId });
                        if (raw is RevitLinkInstance inst) return inst.Id;
                        if (raw is ElementId eid && eid != ElementId.InvalidElementId) return eid;
                    }
                }
                catch
                {
                    continue;
                }
            }

            throw new InvalidOperationException("This Revit API version does not expose RevitLinkInstance.Create(Document, ElementId).");
        }

        private static ElementId? TryExtractElementId(object result)
        {
            if (result is ElementId eid) return eid;
            if (result == null) return null;

            var type = result.GetType();
            foreach (var name in new[] { "GetElementId", "ElementId", "LinkTypeId" })
            {
                try
                {
                    var method = type.GetMethod(name, BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null);
                    if (method != null && method.Invoke(result, Array.Empty<object>()) is ElementId methodId) return methodId;

                    var prop = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                    if (prop != null && prop.GetValue(result) is ElementId propId) return propId;
                }
                catch
                {
                    continue;
                }
            }

            return null;
        }
    }
}

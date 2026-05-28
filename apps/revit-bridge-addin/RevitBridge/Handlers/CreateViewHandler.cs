using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;

namespace RevitBridge.Handlers
{
    public sealed class CreateViewHandler : IRequestHandler
    {
        public sealed class Point3
        {
            public double x { get; set; }
            public double y { get; set; }
            public double? z { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; } // create_floor_plan | create_3d | create_dependent | create_callout | create_section | create_elevation | create_camera | create_drafting | create_legend | create_view_template | rename_batch
            public string? name { get; set; }

            public long? levelId { get; set; }
            public string? levelName { get; set; }
            public string? planType { get; set; } // floor|ceiling|engineering|structural

            public bool? perspective { get; set; }
            public long? sourceViewId { get; set; }
            public string? calloutType { get; set; } // detail|section
            public double? sectionHeight { get; set; }
            public double? sectionDepth { get; set; }
            public int? elevationIndex { get; set; } // 0..3

            public long? templateId { get; set; }
            public string? templateName { get; set; }
            public int? scale { get; set; }
            public string? detailLevel { get; set; }
            public string? discipline { get; set; }
            public Point3? p1 { get; set; }
            public Point3? p2 { get; set; }
            public Point3? eye { get; set; }
            public Point3? target { get; set; }
            public Point3? up { get; set; }

            public long[]? viewIds { get; set; }
            public string? nameContains { get; set; }
            public string? prefix { get; set; }
            public string? suffix { get; set; }
            public string? findText { get; set; }
            public string? replaceText { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }

            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var action = NormalizeAction(p.action);
            var dryRun = p.dryRun ?? false;
            var activeView = app.ActiveUIDocument?.ActiveView;

            if (action == "rename_batch")
            {
                var renamePlan = BuildRenameBatchPlan(doc, p);
                var preview = ExecuteRenameBatch(doc, p, dryRun: true);
                if (dryRun)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Dry Run",
                        dryRun = true,
                        action,
                        plan = renamePlan,
                        result = preview
                    });
                }

                object result;
                using (var tx = new Transaction(doc, "Rename Views (Batch)"))
                {
                    tx.Start();
                    result = ExecuteRenameBatch(doc, p, dryRun: false);
                    tx.Commit();
                }

                return Task.FromResult<object>(new
                {
                    status = "Success",
                    dryRun = false,
                    action,
                    plan = renamePlan,
                    result
                });
            }

            var plan = BuildPlan(doc, p, action, activeView);
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    action,
                    plan
                });
            }

            View created;
            using (var tx = new Transaction(doc, "Create View"))
            {
                tx.Start();
                created = action switch
                {
                    "create_floor_plan" => CreateFloorPlan(doc, p),
                    "create_3d" => Create3D(doc, p),
                    "create_dependent" => CreateDependent(doc, p),
                    "create_callout" => CreateCallout(doc, p),
                    "create_section" => CreateSection(doc, p),
                    "create_elevation" => CreateElevation(doc, p),
                    "create_camera" => CreateCamera(doc, p),
                    "create_drafting" => CreateDrafting(doc, p),
                    "create_legend" => CreateLegend(doc, p),
                    "create_view_template" => CreateViewTemplate(doc, p, activeView),
                    _ => throw new InvalidOperationException("create-view.action is invalid.")
                };

                if (action != "create_view_template")
                {
                    ApplyOptionalViewSettings(doc, created, p);
                }
                tx.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                action,
                view = BuildViewSummary(doc, created)
            });
        }

        private static object BuildPlan(Document doc, Params p, string action, View? activeView)
        {
            var requestedName = (p.name ?? "").Trim();
            var resolvedLevel = ResolveLevel(doc, p.levelId, p.levelName);
            var sourceView = action == "create_legend"
                ? ResolveLegendSourceView(doc, p.sourceViewId)
                : ResolveView(doc, p.sourceViewId);
            var templateSourceView = sourceView ?? activeView;
            var template = ResolveTemplate(doc, p.templateId, p.templateName);

            var planType = NormalizePlanType(p.planType);
            ViewFamily? targetViewFamily = action switch
            {
                "create_floor_plan" => PlanTypeToViewFamily(planType),
                "create_3d" => ViewFamily.ThreeDimensional,
                "create_camera" => ViewFamily.ThreeDimensional,
                "create_callout" => CalloutTypeToViewFamily((p.calloutType ?? "detail").Trim()),
                "create_section" => ViewFamily.Section,
                "create_elevation" => ViewFamily.Elevation,
                "create_drafting" => ViewFamily.Drafting,
                "create_legend" => ViewFamily.Legend,
                "create_dependent" => (ViewFamily?)null,
                "create_view_template" => (ViewFamily?)null,
                _ => (ViewFamily?)null
            };

            if (action == "create_legend" && sourceView == null)
            {
                throw new InvalidOperationException("create-view(create_legend) requires sourceViewId for a legend view, or at least one existing non-template legend view.");
            }

            var vft = (action == "create_dependent" || action == "create_view_template" || action == "create_legend")
                ? null
                : ResolveViewFamilyType(doc, targetViewFamily ?? ViewFamily.FloorPlan);

            return new
            {
                requestedName = string.IsNullOrWhiteSpace(requestedName) ? null : requestedName,
                resolvedName = SuggestName(doc, action, p, resolvedLevel, action == "create_view_template" ? templateSourceView : sourceView),
                action,
                planType = action == "create_floor_plan" ? planType : null,
                level = resolvedLevel == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(resolvedLevel.Id), name = resolvedLevel.Name },
                sourceView = sourceView == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(sourceView.Id), name = sourceView.Name },
                templateSourceView = action == "create_view_template" && templateSourceView != null
                    ? new { id = RevitBridge.Common.ElementIdCompat.GetValue(templateSourceView.Id), name = templateSourceView.Name, isTemplate = templateSourceView.IsTemplate }
                    : null,
                targetViewFamily = targetViewFamily?.ToString(),
                viewFamilyType = vft == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(vft.Id), name = vft.Name, viewFamily = vft.ViewFamily.ToString() },
                template = template == null ? null : new { id = RevitBridge.Common.ElementIdCompat.GetValue(template.Id), name = template.Name },
                perspective = action == "create_3d" ? (p.perspective ?? false) : (bool?)null,
                camera = action == "create_camera"
                    ? new
                    {
                        eye = p.eye == null ? null : new { p.eye.x, p.eye.y, z = p.eye.z },
                        target = p.target == null ? null : new { p.target.x, p.target.y, z = p.target.z },
                        up = p.up == null ? null : new { p.up.x, p.up.y, z = p.up.z }
                    }
                    : null,
                calloutType = action == "create_callout" ? (p.calloutType ?? "detail").Trim() : null,
                sectionHeight = action == "create_section" ? (p.sectionHeight ?? 10.0) : (double?)null,
                sectionDepth = action == "create_section" ? (p.sectionDepth ?? 8.0) : (double?)null,
                elevationIndex = action == "create_elevation" ? (p.elevationIndex ?? 0) : (int?)null,
                p1 = p.p1 == null ? null : new { p.p1.x, p.p1.y, z = p.p1.z },
                p2 = p.p2 == null ? null : new { p.p2.x, p.p2.y, z = p.p2.z },
                scale = p.scale,
                detailLevel = string.IsNullOrWhiteSpace(p.detailLevel) ? null : p.detailLevel.Trim(),
                discipline = string.IsNullOrWhiteSpace(p.discipline) ? null : p.discipline.Trim()
            };
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "create_floor_plan").Trim().ToLowerInvariant();
            if (value == "floor_plan") value = "create_floor_plan";
            if (value == "3d") value = "create_3d";
            if (value == "dependent") value = "create_dependent";
            if (value == "callout") value = "create_callout";
            if (value == "section") value = "create_section";
            if (value == "elevation") value = "create_elevation";
            if (value == "camera") value = "create_camera";
            if (value == "drafting") value = "create_drafting";
            if (value == "legend") value = "create_legend";
            if (value == "view_template") value = "create_view_template";

            return value switch
            {
                "create_floor_plan" => value,
                "create_3d" => value,
                "create_dependent" => value,
                "create_callout" => value,
                "create_section" => value,
                "create_elevation" => value,
                "create_camera" => value,
                "create_drafting" => value,
                "create_legend" => value,
                "create_view_template" => value,
                "rename_batch" => value,
                _ => throw new InvalidOperationException("create-view.action must be create_floor_plan, create_3d, create_dependent, create_callout, create_section, create_elevation, create_camera, create_drafting, create_legend, create_view_template, or rename_batch.")
            };
        }

        private static string NormalizePlanType(string? planType)
        {
            var value = (planType ?? "floor").Trim().ToLowerInvariant();
            return value switch
            {
                "floor" => value,
                "ceiling" => value,
                "engineering" => value,
                "structural" => value,
                _ => throw new InvalidOperationException("create-view.planType must be floor, ceiling, engineering, or structural.")
            };
        }

        private static ViewFamily PlanTypeToViewFamily(string planType)
        {
            return planType switch
            {
                "floor" => ViewFamily.FloorPlan,
                "ceiling" => ViewFamily.CeilingPlan,
                // Revit 2024 API does not expose ViewFamily.EngineeringPlan.
                // Treat engineering plans as floor-plan family and drive discipline separately.
                "engineering" => ViewFamily.FloorPlan,
                "structural" => ViewFamily.StructuralPlan,
                _ => ViewFamily.FloorPlan
            };
        }

        private static ViewFamily CalloutTypeToViewFamily(string calloutType)
        {
            var key = (calloutType ?? "detail").Trim().ToLowerInvariant();
            return key switch
            {
                "detail" => ViewFamily.Detail,
                "section" => ViewFamily.Section,
                _ => ViewFamily.Detail
            };
        }

        private static ViewPlan CreateFloorPlan(Document doc, Params p)
        {
            var level = ResolveLevel(doc, p.levelId, p.levelName);
            if (level == null) throw new InvalidOperationException("create-view(create_floor_plan) requires levelId or levelName.");

            var planType = NormalizePlanType(p.planType);
            var vf = PlanTypeToViewFamily(planType);
            var vft = ResolveViewFamilyType(doc, vf)
                ?? throw new InvalidOperationException($"No ViewFamilyType found for {vf}.");

            var created = ViewPlan.Create(doc, vft.Id, level.Id);
            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View3D Create3D(Document doc, Params p)
        {
            var vft = ResolveViewFamilyType(doc, ViewFamily.ThreeDimensional)
                ?? throw new InvalidOperationException("No ViewFamilyType found for ThreeDimensional views.");

            var perspective = p.perspective ?? false;
            var created = perspective
                ? View3D.CreatePerspective(doc, vft.Id)
                : View3D.CreateIsometric(doc, vft.Id);

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View CreateDependent(Document doc, Params p)
        {
            var source = ResolveView(doc, p.sourceViewId);
            if (source == null)
            {
                throw new InvalidOperationException("create-view(create_dependent) requires sourceViewId.");
            }

            try
            {
                if (!source.CanViewBeDuplicated(ViewDuplicateOption.AsDependent))
                {
                    throw new InvalidOperationException($"View '{source.Name}' cannot be duplicated as dependent.");
                }
            }
            catch
            {
                // On some API surfaces CanViewBeDuplicated may not be available/reliable.
            }

            var newId = source.Duplicate(ViewDuplicateOption.AsDependent);
            var created = doc.GetElement(newId) as View;
            if (created == null) throw new InvalidOperationException("Failed to create dependent view.");

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View CreateCallout(Document doc, Params p)
        {
            var source = ResolveView(doc, p.sourceViewId);
            if (source == null)
            {
                throw new InvalidOperationException("create-view(create_callout) requires sourceViewId.");
            }

            if (p.p1 == null || p.p2 == null)
            {
                throw new InvalidOperationException("create-view(create_callout) requires p1 and p2.");
            }

            var calloutType = (p.calloutType ?? "detail").Trim();
            var vf = CalloutTypeToViewFamily(calloutType);
            var vft = ResolveViewFamilyType(doc, vf)
                ?? throw new InvalidOperationException($"No ViewFamilyType found for callout type '{calloutType}'.");

            var defaultZ = 0.0;
            try
            {
                if (source is ViewPlan vp && vp.GenLevel != null)
                {
                    defaultZ = vp.GenLevel.Elevation;
                }
            }
            catch
            {
                // ignore
            }

            var xyz1 = ToXyz(p.p1, defaultZ);
            var xyz2 = ToXyz(p.p2, defaultZ);
            var min = new XYZ(Math.Min(xyz1.X, xyz2.X), Math.Min(xyz1.Y, xyz2.Y), Math.Min(xyz1.Z, xyz2.Z));
            var max = new XYZ(Math.Max(xyz1.X, xyz2.X), Math.Max(xyz1.Y, xyz2.Y), Math.Max(xyz1.Z, xyz2.Z));

            var created = ViewSection.CreateCallout(doc, source.Id, vft.Id, min, max);
            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static ViewSection CreateSection(Document doc, Params p)
        {
            if (p.p1 == null || p.p2 == null)
            {
                throw new InvalidOperationException("create-view(create_section) requires p1 and p2.");
            }

            var vft = ResolveViewFamilyType(doc, ViewFamily.Section)
                ?? throw new InvalidOperationException("No ViewFamilyType found for Section.");

            var xyz1 = ToXyz(p.p1, p.p1.z ?? 0.0);
            var xyz2 = ToXyz(p.p2, p.p1.z ?? 0.0);
            var delta = xyz2 - xyz1;
            var horizontal = new XYZ(delta.X, delta.Y, 0);
            if (horizontal.GetLength() < 1e-6)
            {
                throw new InvalidOperationException("create-view(create_section) requires p1 and p2 with distinct XY coordinates.");
            }

            var right = horizontal.Normalize();
            var up = XYZ.BasisZ;
            var viewDir = right.CrossProduct(up);
            if (viewDir.GetLength() < 1e-6)
            {
                viewDir = XYZ.BasisY;
            }
            viewDir = viewDir.Normalize();

            var width = Math.Max(1.0, horizontal.GetLength());
            var height = Math.Max(1.0, p.sectionHeight ?? 10.0);
            var depth = Math.Max(0.5, p.sectionDepth ?? 8.0);

            var mid = (xyz1 + xyz2) * 0.5;
            var tr = Transform.Identity;
            tr.Origin = mid;
            tr.BasisX = right;
            tr.BasisY = up;
            tr.BasisZ = viewDir;

            var box = new BoundingBoxXYZ
            {
                Transform = tr,
                Min = new XYZ(-0.5 * width, -0.5 * height, 0),
                Max = new XYZ(0.5 * width, 0.5 * height, depth)
            };

            var created = ViewSection.CreateSection(doc, vft.Id, box);
            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static ViewSection CreateElevation(Document doc, Params p)
        {
            var sourceView = ResolveView(doc, p.sourceViewId);
            if (sourceView == null)
            {
                throw new InvalidOperationException("create-view(create_elevation) requires sourceViewId.");
            }

            if (sourceView is not ViewPlan hostPlan)
            {
                throw new InvalidOperationException("create-view(create_elevation) requires sourceViewId for a plan view.");
            }

            if (p.p1 == null)
            {
                throw new InvalidOperationException("create-view(create_elevation) requires p1 marker point.");
            }

            var index = p.elevationIndex ?? 0;
            if (index < 0 || index > 3)
            {
                throw new InvalidOperationException("create-view.elevationIndex must be in range [0,3].");
            }

            var vft = ResolveViewFamilyType(doc, ViewFamily.Elevation)
                ?? throw new InvalidOperationException("No ViewFamilyType found for Elevation.");

            var markerScale = p.scale ?? 100;
            if (markerScale < 1 || markerScale > 2400) markerScale = 100;

            var defaultZ = 0.0;
            try { defaultZ = hostPlan.GenLevel?.Elevation ?? 0.0; } catch { }
            var origin = ToXyz(p.p1, defaultZ);

            var marker = ElevationMarker.CreateElevationMarker(doc, vft.Id, origin, markerScale);
            var created = marker.CreateElevation(doc, hostPlan.Id, index);

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View3D CreateCamera(Document doc, Params p)
        {
            var vft = ResolveViewFamilyType(doc, ViewFamily.ThreeDimensional)
                ?? throw new InvalidOperationException("No ViewFamilyType found for ThreeDimensional views.");

            var created = View3D.CreatePerspective(doc, vft.Id);

            if (p.eye != null && p.target != null)
            {
                var eye = ToXyz(p.eye, p.eye.z ?? 0.0);
                var target = ToXyz(p.target, p.target.z ?? 0.0);
                var forward = target - eye;
                if (forward.GetLength() < 1e-6)
                {
                    throw new InvalidOperationException("create-view(create_camera) requires eye and target to be different points.");
                }

                var upPoint = p.up == null
                    ? new XYZ(0, 0, 1)
                    : ToXyz(p.up, p.up.z ?? 1.0);
                if (upPoint.GetLength() < 1e-6) upPoint = new XYZ(0, 0, 1);

                var orientation = new ViewOrientation3D(eye, upPoint.Normalize(), forward.Normalize());
                created.SetOrientation(orientation);
            }

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static ViewDrafting CreateDrafting(Document doc, Params p)
        {
            var vft = ResolveViewFamilyType(doc, ViewFamily.Drafting)
                ?? throw new InvalidOperationException("No ViewFamilyType found for Drafting views.");

            var created = ViewDrafting.Create(doc, vft.Id);
            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View CreateLegend(Document doc, Params p)
        {
            var source = ResolveLegendSourceView(doc, p.sourceViewId);
            if (source == null)
            {
                throw new InvalidOperationException("create-view(create_legend) requires sourceViewId for a legend view, or at least one existing non-template legend view.");
            }

            ElementId duplicatedId;
            try
            {
                duplicatedId = source.Duplicate(ViewDuplicateOption.WithDetailing);
            }
            catch
            {
                duplicatedId = source.Duplicate(ViewDuplicateOption.Duplicate);
            }

            var created = doc.GetElement(duplicatedId) as View;
            if (created == null)
            {
                throw new InvalidOperationException("Failed to create legend view.");
            }

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View CreateViewTemplate(Document doc, Params p, View? activeView)
        {
            var source = ResolveView(doc, p.sourceViewId) ?? activeView;
            if (source == null)
            {
                throw new InvalidOperationException("create-view(create_view_template) requires sourceViewId, or an active view.");
            }

            if (source.IsTemplate)
            {
                throw new InvalidOperationException("create-view(create_view_template) source view cannot be a template.");
            }

            var created = source.CreateViewTemplate();
            if (created == null)
            {
                throw new InvalidOperationException("Failed to create view template from source view.");
            }

            var requestedName = (p.name ?? "").Trim();
            if (requestedName.Length > 0)
            {
                created.Name = EnsureUniqueViewName(doc, requestedName);
            }

            return created;
        }

        private static View? ResolveTemplate(Document doc, long? templateId, string? templateName)
        {
            if (templateId.HasValue && templateId.Value > 0)
            {
                var byId = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(templateId.Value)) as View;
                if (byId != null && byId.IsTemplate) return byId;
            }

            var name = (templateName ?? "").Trim();
            if (name.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .FirstOrDefault(v => v.IsTemplate && (v.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static View? ResolveView(Document doc, long? viewId)
        {
            if (!viewId.HasValue || viewId.Value <= 0) return null;
            return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(viewId.Value)) as View;
        }

        private static View? ResolveLegendSourceView(Document doc, long? viewId)
        {
            var byId = ResolveView(doc, viewId);
            if (byId != null)
            {
                if (byId.IsTemplate || byId.ViewType != ViewType.Legend)
                {
                    throw new InvalidOperationException("create-view(create_legend) sourceViewId must target a non-template legend view.");
                }
                return byId;
            }

            return new FilteredElementCollector(doc)
                .OfClass(typeof(View))
                .Cast<View>()
                .Where(v => !v.IsTemplate && v.ViewType == ViewType.Legend)
                .OrderBy(v => v.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        private static Level? ResolveLevel(Document doc, long? levelId, string? levelName)
        {
            if (levelId.HasValue && levelId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(levelId.Value)) as Level;
            }

            var name = (levelName ?? "").Trim();
            if (name.Length == 0) return null;

            return new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .FirstOrDefault(l => (l.Name ?? "").Trim().Equals(name, StringComparison.OrdinalIgnoreCase));
        }

        private static ViewFamilyType? ResolveViewFamilyType(Document doc, ViewFamily vf)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewFamilyType))
                .Cast<ViewFamilyType>()
                .FirstOrDefault(x => x.ViewFamily == vf);
        }

        private static object BuildRenameBatchPlan(Document doc, Params p)
        {
            ValidateRenameBatchParams(p);
            List<object> selectorErrors;
            var targets = ResolveRenameBatchTargets(doc, p, out selectorErrors);

            var viewIds = p.viewIds ?? Array.Empty<long>();
            var prefix = (p.prefix ?? "").Trim();
            var suffix = (p.suffix ?? "").Trim();
            var findText = p.findText ?? "";
            var replaceText = p.replaceText ?? "";
            var exact = p.exact ?? false;
            var nameContains = (p.nameContains ?? "").Trim();

            return new
            {
                selectors = new
                {
                    viewIds,
                    nameContains = nameContains.Length == 0 ? null : nameContains,
                    exact,
                    max = p.max
                },
                rename = new
                {
                    prefix = prefix.Length == 0 ? null : prefix,
                    suffix = suffix.Length == 0 ? null : suffix,
                    findText = findText.Length == 0 ? null : findText,
                    replaceText = findText.Length == 0 ? null : replaceText
                },
                selected = targets.Count,
                selectorErrors
            };
        }

        private static object ExecuteRenameBatch(Document doc, Params p, bool dryRun)
        {
            ValidateRenameBatchParams(p);
            List<object> selectorErrors;
            var targets = ResolveRenameBatchTargets(doc, p, out selectorErrors);

            var changed = new List<object>();
            var unchanged = new List<object>();
            var errors = new List<object>();

            foreach (var selectorError in selectorErrors)
            {
                errors.Add(selectorError);
            }

            var existingNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                var name = (view?.Name ?? "").Trim();
                if (name.Length > 0) existingNames.Add(name);
            }

            var prefix = (p.prefix ?? "").Trim();
            var suffix = (p.suffix ?? "").Trim();
            var findText = p.findText ?? "";
            var replaceText = p.replaceText ?? "";
            var exact = p.exact ?? false;

            foreach (var view in targets)
            {
                var id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id);
                var oldName = (view.Name ?? "").Trim();
                var oldNameForSet = oldName.Length == 0 ? null : oldName;
                if (oldNameForSet != null) existingNames.Remove(oldNameForSet);

                var restoreOldName = true;
                try
                {
                    var candidate = oldName;
                    if (findText.Length > 0)
                    {
                        candidate = exact
                            ? (candidate.Equals(findText, StringComparison.OrdinalIgnoreCase) ? replaceText : candidate)
                            : ReplaceIgnoreCase(candidate, findText, replaceText);
                    }

                    if (prefix.Length > 0) candidate = prefix + candidate;
                    if (suffix.Length > 0) candidate = candidate + suffix;

                    candidate = NormalizeViewName(candidate);
                    if (candidate.Equals(oldName, StringComparison.Ordinal))
                    {
                        unchanged.Add(new { id, name = oldName, reason = "No change." });
                        continue;
                    }

                    var uniqueName = EnsureUniqueViewName(existingNames, candidate);
                    if (!dryRun)
                    {
                        view.Name = uniqueName;
                    }

                    changed.Add(new { id, oldName, newName = uniqueName });
                    existingNames.Add(uniqueName);
                    restoreOldName = false;
                }
                catch (Exception ex)
                {
                    errors.Add(new { id, name = oldName, error = ex.Message });
                }
                finally
                {
                    if (restoreOldName && oldNameForSet != null)
                    {
                        existingNames.Add(oldNameForSet);
                    }
                }
            }

            return new
            {
                selected = targets.Count,
                changedCount = changed.Count,
                unchangedCount = unchanged.Count,
                errorCount = errors.Count,
                changed,
                unchanged,
                errors
            };
        }

        private static List<View> ResolveRenameBatchTargets(Document doc, Params p, out List<object> selectorErrors)
        {
            selectorErrors = new List<object>();
            var exact = p.exact ?? false;
            var nameContains = (p.nameContains ?? "").Trim();
            var max = p.max;

            var targets = new List<View>();
            var seen = new HashSet<long>();

            if (p.viewIds != null && p.viewIds.Length > 0)
            {
                foreach (var rawId in p.viewIds)
                {
                    if (rawId <= 0)
                    {
                        selectorErrors.Add(new { id = rawId, error = "Invalid view id." });
                        continue;
                    }

                    if (!seen.Add(rawId)) continue;

                    var element = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(rawId));
                    var view = element as View;
                    if (view == null)
                    {
                        selectorErrors.Add(new { id = rawId, error = "Element not found or not a view." });
                        continue;
                    }

                    targets.Add(view);
                }
            }
            else
            {
                targets.AddRange(new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>());
            }

            if (nameContains.Length > 0)
            {
                targets = targets
                    .Where(v =>
                    {
                        var name = (v.Name ?? "").Trim();
                        if (exact)
                        {
                            return name.Equals(nameContains, StringComparison.OrdinalIgnoreCase);
                        }

                        return name.IndexOf(nameContains, StringComparison.OrdinalIgnoreCase) >= 0;
                    })
                    .ToList();
            }

            if (max.HasValue && max.Value > 0)
            {
                targets = targets.Take(max.Value).ToList();
            }

            return targets;
        }

        private static void ValidateRenameBatchParams(Params p)
        {
            var hasIds = p.viewIds != null && p.viewIds.Length > 0;
            var hasName = !string.IsNullOrWhiteSpace(p.nameContains);
            if (!hasIds && !hasName)
            {
                throw new InvalidOperationException("create-view(rename_batch) requires viewIds or nameContains.");
            }

            var hasPrefix = !string.IsNullOrWhiteSpace(p.prefix);
            var hasSuffix = !string.IsNullOrWhiteSpace(p.suffix);
            var hasFind = !string.IsNullOrEmpty(p.findText);
            if (!hasPrefix && !hasSuffix && !hasFind)
            {
                throw new InvalidOperationException("create-view(rename_batch) requires prefix, suffix, or findText.");
            }

            if (p.max.HasValue && p.max.Value <= 0)
            {
                throw new InvalidOperationException("create-view.max must be greater than 0 when provided.");
            }
        }

        private static string ReplaceIgnoreCase(string source, string findText, string replaceText)
        {
            if (string.IsNullOrEmpty(source) || string.IsNullOrEmpty(findText)) return source;

            var current = source;
            var start = 0;
            while (start < current.Length)
            {
                var index = current.IndexOf(findText, start, StringComparison.OrdinalIgnoreCase);
                if (index < 0) break;

                current = current.Substring(0, index) + replaceText + current.Substring(index + findText.Length);
                start = index + replaceText.Length;
            }

            return current;
        }

        private static void ApplyOptionalViewSettings(Document doc, View view, Params p)
        {
            var template = ResolveTemplate(doc, p.templateId, p.templateName);
            if (template != null)
            {
                view.ViewTemplateId = template.Id;
            }

            if (p.scale.HasValue)
            {
                var scale = p.scale.Value;
                if (scale > 0 && scale <= 2400)
                {
                    try { view.Scale = scale; } catch { }
                }
            }

            var detail = (p.detailLevel ?? "").Trim();
            if (detail.Length > 0)
            {
                TrySetEnumProperty(view, "DetailLevel", detail);
            }

            var discipline = (p.discipline ?? "").Trim();
            if (discipline.Length > 0)
            {
                TrySetEnumProperty(view, "Discipline", discipline);
            }
        }

        private static bool TrySetEnumProperty(object target, string propName, string value)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || !p.PropertyType.IsEnum) return false;
                var parsed = Enum.Parse(p.PropertyType, value, ignoreCase: true);
                p.SetValue(target, parsed, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string SuggestName(Document doc, string action, Params p, Level? level, View? sourceView)
        {
            var requested = (p.name ?? "").Trim();
            if (requested.Length > 0)
            {
                return EnsureUniqueViewName(doc, requested);
            }

            var baseName = action switch
            {
                "create_floor_plan" => level == null ? "Floor Plan" : $"{level.Name} - Plan",
                "create_3d" => (p.perspective ?? false) ? "Perspective" : "3D View",
                "create_dependent" => sourceView == null ? "Dependent View" : $"{sourceView.Name} - Dependent",
                "create_callout" => sourceView == null ? "Callout" : $"{sourceView.Name} - Callout",
                "create_section" => "Section",
                "create_elevation" => "Elevation",
                "create_camera" => "Camera",
                "create_drafting" => "Drafting View",
                "create_legend" => sourceView == null ? "Legend" : $"{sourceView.Name} - Legend",
                "create_view_template" => sourceView == null ? "View Template" : $"{sourceView.Name} - Template",
                _ => "View"
            };

            return EnsureUniqueViewName(doc, baseName);
        }

        private static string EnsureUniqueViewName(Document doc, string name)
        {
            var existing = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var view in new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>())
            {
                var n = (view?.Name ?? "").Trim();
                if (n.Length > 0) existing.Add(n);
            }

            return EnsureUniqueViewName(existing, name);
        }

        private static string EnsureUniqueViewName(HashSet<string> existingNames, string name)
        {
            var trimmed = NormalizeViewName(name);
            if (!existingNames.Contains(trimmed)) return trimmed;
            for (var i = 2; i <= 100; i++)
            {
                var candidate = $"{trimmed} ({i})";
                if (!existingNames.Contains(candidate)) return candidate;
            }

            return $"{trimmed}_{Guid.NewGuid().ToString("N").Substring(0, 6)}";
        }

        private static string NormalizeViewName(string? name)
        {
            var trimmed = (name ?? "").Trim();
            if (trimmed.Length == 0) trimmed = "View";
            if (trimmed.Length > 120) trimmed = trimmed.Substring(0, 120).Trim();
            return trimmed;
        }

        private static XYZ ToXyz(Point3 p, double defaultZ)
        {
            return new XYZ(p.x, p.y, p.z ?? defaultZ);
        }

        private static object BuildViewSummary(Document doc, View view)
        {
            View? template = null;
            try
            {
                if (view.ViewTemplateId != ElementId.InvalidElementId)
                {
                    template = doc.GetElement(view.ViewTemplateId) as View;
                }
            }
            catch
            {
                // ignore
            }

            var typeId = view.GetTypeId();
            var vfType = doc.GetElement(typeId) as ViewFamilyType;
            string? vfName = vfType?.Name;
            string? family = vfType?.ViewFamily.ToString();

            return new
            {
                id = RevitBridge.Common.ElementIdCompat.GetValue(view.Id),
                name = view.Name,
                typeId = RevitBridge.Common.ElementIdCompat.GetValue(typeId),
                typeName = vfName,
                viewFamily = family,
                isTemplate = view.IsTemplate,
                scale = view.Scale,
                templateId = RevitBridge.Common.ElementIdCompat.GetValue(template?.Id),
                templateName = template?.Name
            };
        }
    }
}

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.ApplicationServices;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ProjectParametersHandler : IRequestHandler
    {
        private const string OperatorSharedParamGroupName = "RevitOperator";

        public sealed class Params
        {
            public string? action { get; set; } // list (default) | create | validate_required
            public string? name { get; set; } // create
            public string[]? categoryNames { get; set; } // create
            public bool? instanceBinding { get; set; } // create (default true)
            public string? parameterGroup { get; set; } // create (default identity_data)
            public string? dataType { get; set; } // create (text|yesno|integer|number|url|multiline_text)
            public bool? visible { get; set; } // create (default true)
            public bool? userModifiable { get; set; } // create (default true)
            public bool? rebindIfExists { get; set; } // create
            public string? query { get; set; } // list
            public int? max { get; set; } // list
            public bool? dryRun { get; set; } // create
            public string[]? requiredParameters { get; set; } // validate_required
            public string[]? requiredParameterNames { get; set; } // validate_required alias
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("project-parameters is only supported in project documents.");

            var action = NormalizeAction(p.action);
            return action switch
            {
                "list" => Task.FromResult<object>(ListProjectParameters(doc, p)),
                "create" => Task.FromResult<object>(CreateProjectParameter(app, doc, p)),
                "validate_required" => Task.FromResult<object>(ValidateRequiredParameters(doc, p)),
                _ => throw new InvalidOperationException("project-parameters.action must be list, create, or validate_required.")
            };
        }

        private static object ListProjectParameters(Document doc, Params p)
        {
            var query = (p.query ?? "").Trim();
            var max = p.max.GetValueOrDefault(500);
            if (max < 1) max = 1;
            if (max > 5000) max = 5000;

            var items = new List<object>();
            var iterator = doc.ParameterBindings.ForwardIterator();
            iterator.Reset();
            while (iterator.MoveNext())
            {
                var def = iterator.Key;
                if (def == null) continue;

                var name = (def.Name ?? "").Trim();
                if (name.Length == 0) continue;
                if (query.Length > 0 && name.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0) continue;

                var binding = iterator.Current as ElementBinding;
                var categories = EnumerateCategoryNames(binding)
                    .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                    .ToList();

                var isInstance = iterator.Current is InstanceBinding;
                items.Add(new
                {
                    name,
                    isInstance,
                    parameterGroup = GetParameterGroupLabel(def),
                    categories,
                    categoryCount = categories.Count
                });

                if (items.Count >= max) break;
            }

            return new
            {
                status = "Ok",
                action = "list",
                count = items.Count,
                max,
                query = query.Length == 0 ? null : query,
                items
            };
        }

        private static object CreateProjectParameter(UIApplication uiapp, Document doc, Params p)
        {
            var name = (p.name ?? "").Trim();
            if (name.Length == 0) throw new InvalidOperationException("project-parameters.create requires name.");

            var categoryNames = NormalizeNameSet(p.categoryNames);
            if (categoryNames.Count == 0)
                throw new InvalidOperationException("project-parameters.create requires categoryNames.");

            var isInstance = p.instanceBinding ?? true;
            var parameterGroup = ResolveParameterGroupTypeId(p.parameterGroup);
            var dataType = ResolveDataTypeId(p.dataType);
            var dataTypeLabel = NormalizeDataTypeLabel(p.dataType);
            var visible = p.visible ?? true;
            var userModifiable = p.userModifiable ?? true;
            var rebindIfExists = p.rebindIfExists ?? false;
            var dryRun = p.dryRun ?? false;

            var unresolved = new List<string>();
            var unsupported = new List<string>();
            var categories = ResolveCategories(doc, categoryNames, unresolved, unsupported);
            if (categories.Count == 0)
            {
                var reason = unresolved.Count > 0
                    ? "No requested categories were resolved."
                    : "Resolved categories do not allow bound parameters.";
                throw new InvalidOperationException(reason);
            }

            if (TryFindBindingByName(doc, name, out var existingDefinition, out _))
            {
                if (!rebindIfExists)
                {
                    return new
                    {
                        status = "AlreadyExists",
                        action = "create",
                        message = "A project parameter with this name already exists. Set rebindIfExists=true to update binding/categories.",
                        parameter = new
                        {
                            name = existingDefinition?.Name ?? name,
                            parameterGroup = GetParameterGroupLabel(existingDefinition)
                        }
                    };
                }

                var rebindPlan = BuildCreatePlan(
                    name,
                    categories,
                    unresolved,
                    unsupported,
                    isInstance,
                    parameterGroup,
                    dataTypeLabel,
                    visible,
                    userModifiable,
                    rebindIfExists,
                    existing: true);

                if (dryRun)
                {
                    return new
                    {
                        status = "Dry Run",
                        action = "create",
                        dryRun = true,
                        mode = "rebind_existing",
                        plan = rebindPlan
                    };
                }

                var binding = BuildBinding(uiapp.Application, categories, isInstance);
                var ok = false;
                using (var tx = new Transaction(doc, "Rebind Project Parameter"))
                {
                    tx.Start();
                    ok = doc.ParameterBindings.ReInsert(existingDefinition, binding, parameterGroup);
                    if (ok) tx.Commit();
                    else tx.RollBack();
                }

                if (!ok) throw new InvalidOperationException("Failed to rebind existing project parameter.");

                return new
                {
                    status = "Success",
                    action = "create",
                    mode = "rebind_existing",
                    parameter = new
                    {
                        name,
                        isInstance,
                        parameterGroup = parameterGroup.TypeId,
                        dataType = dataTypeLabel,
                        categoryCount = categories.Count,
                        categories = categories.Select(x => x.Name).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList()
                    },
                    unresolvedCategories = unresolved,
                    unsupportedCategories = unsupported
                };
            }

            var createPlan = BuildCreatePlan(
                name,
                categories,
                unresolved,
                unsupported,
                isInstance,
                parameterGroup,
                dataTypeLabel,
                visible,
                userModifiable,
                rebindIfExists,
                existing: false);

            if (dryRun)
            {
                return new
                {
                    status = "Dry Run",
                    action = "create",
                    dryRun = true,
                    mode = "create_new",
                    plan = createPlan
                };
            }

            var definition = EnsureSharedParameterDefinition(uiapp.Application, name, dataType, visible, userModifiable, out var sharedParameterFile);
            var elementBinding = BuildBinding(uiapp.Application, categories, isInstance);

            var inserted = false;
            using (var tx = new Transaction(doc, "Create Project Parameter"))
            {
                tx.Start();
                inserted = doc.ParameterBindings.Insert(definition, elementBinding, parameterGroup);
                if (!inserted && rebindIfExists)
                {
                    inserted = doc.ParameterBindings.ReInsert(definition, elementBinding, parameterGroup);
                }

                if (inserted) tx.Commit();
                else tx.RollBack();
            }

            if (!inserted)
                throw new InvalidOperationException("Failed to bind project parameter. A conflicting parameter definition may already exist.");

            return new
            {
                status = "Success",
                action = "create",
                mode = "create_new",
                parameter = new
                {
                    name,
                    isInstance,
                    parameterGroup = parameterGroup.TypeId,
                    dataType = dataTypeLabel,
                    categoryCount = categories.Count,
                    categories = categories.Select(x => x.Name).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList(),
                    visible,
                    userModifiable
                },
                sharedParameterFile,
                unresolvedCategories = unresolved,
                unsupportedCategories = unsupported
            };
        }

        private static object ValidateRequiredParameters(Document doc, Params p)
        {
            var required = NormalizeNameSet(p.requiredParameters);
            foreach (var x in NormalizeNameSet(p.requiredParameterNames))
            {
                required.Add(x);
            }

            if (required.Count == 0)
                throw new InvalidOperationException("project-parameters.validate_required requires requiredParameters (or requiredParameterNames).");

            var requestedCategories = NormalizeNameSet(p.categoryNames);
            var unresolvedCategories = new List<string>();
            var resolvedCategoryNames = new List<string>();

            foreach (var requested in requestedCategories)
            {
                var cat = ResolveCategory(doc, requested);
                if (cat == null)
                {
                    unresolvedCategories.Add(requested);
                    continue;
                }
                resolvedCategoryNames.Add(cat.Name);
            }

            var parameterBindings = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
            var iter = doc.ParameterBindings.ForwardIterator();
            iter.Reset();
            while (iter.MoveNext())
            {
                var def = iter.Key;
                if (def == null) continue;

                var paramName = (def.Name ?? "").Trim();
                if (paramName.Length == 0) continue;

                if (!parameterBindings.TryGetValue(paramName, out var categories))
                {
                    categories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    parameterBindings[paramName] = categories;
                }

                if (iter.Current is ElementBinding binding)
                {
                    foreach (var c in EnumerateCategoryNames(binding))
                    {
                        categories.Add(c);
                    }
                }
            }

            var requiredList = required.OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
            var globallyPresent = new List<string>();
            var globallyMissing = new List<string>();

            foreach (var param in requiredList)
            {
                if (parameterBindings.ContainsKey(param)) globallyPresent.Add(param);
                else globallyMissing.Add(param);
            }

            var categoryResults = new List<object>();
            foreach (var categoryName in resolvedCategoryNames.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var present = new List<string>();
                var missing = new List<string>();
                foreach (var param in requiredList)
                {
                    if (!parameterBindings.TryGetValue(param, out var boundCats))
                    {
                        missing.Add(param);
                        continue;
                    }

                    if (boundCats.Contains(categoryName)) present.Add(param);
                    else missing.Add(param);
                }

                categoryResults.Add(new
                {
                    categoryName,
                    presentParameters = present,
                    missingParameters = missing
                });
            }

            return new
            {
                status = "Ok",
                action = "validate_required",
                requiredCount = requiredList.Count,
                requiredParameters = requiredList,
                globallyPresentParameters = globallyPresent,
                globallyMissingParameters = globallyMissing,
                resolvedCategoryCount = resolvedCategoryNames.Count,
                unresolvedCategories,
                categoryResults
            };
        }

        private static object BuildCreatePlan(
            string name,
            List<Category> categories,
            List<string> unresolved,
            List<string> unsupported,
            bool isInstance,
            ForgeTypeId parameterGroup,
            string dataType,
            bool visible,
            bool userModifiable,
            bool rebindIfExists,
            bool existing)
        {
            return new
            {
                name,
                mode = existing ? "rebind_existing" : "create_new",
                categoryCount = categories.Count,
                categories = categories.Select(x => x.Name).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList(),
                isInstance,
                parameterGroup = parameterGroup.TypeId,
                dataType,
                visible,
                userModifiable,
                rebindIfExists,
                unresolvedCategories = unresolved,
                unsupportedCategories = unsupported
            };
        }

        private static List<Category> ResolveCategories(
            Document doc,
            HashSet<string> requested,
            List<string> unresolved,
            List<string> unsupported)
        {
            var resolved = new List<Category>();
            foreach (var requestedName in requested)
            {
                var category = ResolveCategory(doc, requestedName);
                if (category == null)
                {
                    unresolved.Add(requestedName);
                    continue;
                }

                if (!category.AllowsBoundParameters)
                {
                    unsupported.Add(category.Name);
                    continue;
                }

                if (resolved.Any(x => RevitBridge.Common.ElementIdCompat.GetValue(x.Id) == RevitBridge.Common.ElementIdCompat.GetValue(category.Id))) continue;
                resolved.Add(category);
            }

            return resolved;
        }

        private static Category? ResolveCategory(Document doc, string token)
        {
            var trimmed = (token ?? "").Trim();
            if (trimmed.Length == 0) return null;

            foreach (Category cat in doc.Settings.Categories)
            {
                if (cat == null) continue;
                if (string.Equals(cat.Name, trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    return cat;
                }
            }

            if (Enum.TryParse(trimmed, true, out BuiltInCategory bic))
            {
                try
                {
                    return Category.GetCategory(doc, bic);
                }
                catch
                {
                    // no-op
                }
            }

            return null;
        }

        private static ElementBinding BuildBinding(Application app, IEnumerable<Category> categories, bool isInstance)
        {
            var set = app.Create.NewCategorySet();
            foreach (var c in categories)
            {
                if (c == null) continue;
                set.Insert(c);
            }

            return isInstance
                ? (ElementBinding)app.Create.NewInstanceBinding(set)
                : app.Create.NewTypeBinding(set);
        }

        private static Definition EnsureSharedParameterDefinition(
            Application app,
            string name,
            ForgeTypeId dataType,
            bool visible,
            bool userModifiable,
            out string sharedParameterFile)
        {
            var originalPath = app.SharedParametersFilename ?? "";
            var usingTemporaryPath = false;
            sharedParameterFile = originalPath;

            if (string.IsNullOrWhiteSpace(sharedParameterFile) || !File.Exists(sharedParameterFile))
            {
                sharedParameterFile = EnsureOperatorSharedParameterFile();
                app.SharedParametersFilename = sharedParameterFile;
                usingTemporaryPath = true;
            }

            try
            {
                var file = app.OpenSharedParameterFile();
                if (file == null)
                    throw new InvalidOperationException("Unable to open shared parameter file for project-parameter creation.");

                var existing = FindDefinitionByName(file, name);
                if (existing != null) return existing;

                var group = file.Groups.get_Item(OperatorSharedParamGroupName) ?? file.Groups.Create(OperatorSharedParamGroupName);
                var options = new ExternalDefinitionCreationOptions(name, dataType)
                {
                    Visible = visible,
                    UserModifiable = userModifiable,
                    Description = "Created by RevitOperator /revit/project-parameters."
                };

                return group.Definitions.Create(options);
            }
            finally
            {
                if (usingTemporaryPath)
                {
                    app.SharedParametersFilename = originalPath;
                }
            }
        }

        private static string EnsureOperatorSharedParameterFile()
        {
            var workspace = WorkspacePaths.GetWorkspaceRoot();
            var folder = Path.Combine(workspace, "config");
            Directory.CreateDirectory(folder);

            var path = Path.Combine(folder, "operator_shared_parameters.txt");
            if (!File.Exists(path))
            {
                // Minimal Revit shared-parameters file scaffold.
                var lines = new[]
                {
                    "# This is a Revit shared parameter file.",
                    "# Do not edit manually.",
                    "*META\tVERSION\tMINVERSION",
                    "META\t2\t1",
                    "*GROUP\tID\tNAME",
                    "*PARAM\tGUID\tNAME\tDATATYPE\tDATACATEGORY\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE"
                };
                File.WriteAllLines(path, lines);
            }

            return path;
        }

        private static Definition? FindDefinitionByName(DefinitionFile file, string name)
        {
            foreach (var group in file.Groups)
            {
                if (group == null) continue;
                foreach (var def in group.Definitions)
                {
                    if (def == null) continue;
                    if (string.Equals((def.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase))
                    {
                        return def;
                    }
                }
            }
            return null;
        }

        private static bool TryFindBindingByName(Document doc, string name, out Definition definition, out ElementBinding? binding)
        {
            var iter = doc.ParameterBindings.ForwardIterator();
            iter.Reset();
            while (iter.MoveNext())
            {
                var def = iter.Key;
                if (def == null) continue;
                if (!string.Equals((def.Name ?? "").Trim(), name, StringComparison.OrdinalIgnoreCase)) continue;

                definition = def;
                binding = iter.Current as ElementBinding;
                return true;
            }

            definition = null!;
            binding = null;
            return false;
        }

        private static List<string> EnumerateCategoryNames(ElementBinding? binding)
        {
            var names = new List<string>();
            if (binding?.Categories == null) return names;

            foreach (Category c in binding.Categories)
            {
                if (c == null) continue;
                var n = (c.Name ?? "").Trim();
                if (n.Length == 0) continue;
                names.Add(n);
            }

            return names;
        }

        private static string GetParameterGroupLabel(Definition? definition)
        {
            if (definition == null) return "";
            return definition.GetGroupTypeId().TypeId;
        }

        private static ForgeTypeId ResolveParameterGroupTypeId(string? token)
        {
            var value = (token ?? "identity_data").Trim().ToLowerInvariant();
            return value switch
            {
                "identity_data" => GroupTypeId.IdentityData,
                "identity" => GroupTypeId.IdentityData,
                "data" => GroupTypeId.Data,
                "text" => GroupTypeId.Text,
                "constraints" => GroupTypeId.Constraints,
                "geometry" => GroupTypeId.Geometry,
                "materials" => GroupTypeId.Materials,
                "graphics" => GroupTypeId.Graphics,
                "phasing" => GroupTypeId.Phasing,
                _ => GroupTypeId.IdentityData
            };
        }

        private static string NormalizeDataTypeLabel(string? token)
        {
            var value = (token ?? "text").Trim().ToLowerInvariant();
            return value switch
            {
                "yes_no" => "yesno",
                "yes/no" => "yesno",
                "multiline" => "multiline_text",
                "multilinetext" => "multiline_text",
                _ => value.Length == 0 ? "text" : value
            };
        }

        private static ForgeTypeId ResolveDataTypeId(string? token)
        {
            var value = NormalizeDataTypeLabel(token);
            return value switch
            {
                "text" => SpecTypeId.String.Text,
                "url" => SpecTypeId.String.Url,
                "multiline_text" => SpecTypeId.String.MultilineText,
                "yesno" => SpecTypeId.Boolean.YesNo,
                "integer" => SpecTypeId.Int.Integer,
                "number" => SpecTypeId.Number,
                _ => SpecTypeId.String.Text
            };
        }

        private static HashSet<string> NormalizeNameSet(string[]? values)
        {
            var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (values == null) return set;

            foreach (var raw in values)
            {
                var v = (raw ?? "").Trim();
                if (v.Length == 0) continue;
                set.Add(v);
            }

            return set;
        }

        private static string NormalizeAction(string? action)
        {
            var value = (action ?? "list").Trim().ToLowerInvariant();
            return value switch
            {
                "list" => "list",
                "create" => "create",
                "validate_required" => "validate_required",
                _ => value
            };
        }
    }
}

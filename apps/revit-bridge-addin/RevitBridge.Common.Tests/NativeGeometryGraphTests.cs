using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeGeometryGraphTests
    {
        private class Geometry { public object? Owner { get; set; } }
        private class Curve : Geometry { }
        private sealed class Line : Curve { }
        private sealed class Spline : Curve { }
        private sealed class Solid : Geometry { }
        private sealed class SketchPlane { public object? Owner { get; set; } }
        private readonly Dictionary<string, NativeGraphArgument> _values = new Dictionary<string, NativeGraphArgument>();
        private NativeGraphArgument Resolve(string json, Type type, OperatorNativeGraphArguments? resolver = null)
        {
            using var input = JsonDocument.Parse(json);
            return (resolver ?? new OperatorNativeGraphArguments()).Resolve(input.RootElement, type,
                id => _values.TryGetValue(id, out var value) ? value : null,
                (literal, target) => target == typeof(double) ? (object)literal.GetDouble()
                    : target == typeof(string) ? literal.GetString() : throw new InvalidOperationException("Unsupported literal."),
                target => typeof(Geometry).IsAssignableFrom(target) || target == typeof(SketchPlane),
                intrinsicOwner: value => value is SketchPlane plane ? plane.Owner : (value as Geometry)?.Owner);
        }

        [Fact]
        public void TypedCurveListResolvesPriorDerivedReferencesAndAllOwners()
        {
            var active = new object(); var foreign = new object();
            var first = new Line(); var second = new Line();
            _values["first"] = new NativeGraphArgument(first, new[] { active });
            _values["second"] = new NativeGraphArgument(second, new[] { foreign });
            var result = Resolve("[{\"$ref\":\"first\"},{\"$ref\":\"$second\"}]", typeof(IList<Curve>));
            Assert.Equal(new Curve[] { first, second }, Assert.IsAssignableFrom<IList<Curve>>(result.Value));
            Assert.Equal(new[] { active, foreign }, result.Owners);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(result.Owners, active, ReferenceEquals));
        }

        [Fact]
        public void CollectionInterfaceKeepsTypedReferencesOwnershipAndItemBounds()
        {
            var active = new object(); var foreign = new object();
            var first = new Line(); var second = new Line();
            _values["first"] = new NativeGraphArgument(first, new[] { active });
            _values["second"] = new NativeGraphArgument(second, new[] { foreign });
            var result = Resolve("[{\"$ref\":\"first\"},{\"$ref\":\"second\"}]", typeof(ICollection<Curve>));
            Assert.Equal(new Curve[] { first, second }, Assert.IsAssignableFrom<ICollection<Curve>>(result.Value));
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(result.Owners, active, ReferenceEquals));
            _values["overflow"] = new NativeGraphArgument(Enumerable.Range(0, 65).Select(_ => new Line()).ToList());
            Assert.Throws<InvalidOperationException>(() => Resolve("{\"$ref\":\"overflow\"}", typeof(ICollection<Curve>)));
            Assert.Throws<InvalidOperationException>(() => Resolve("[{\"fake\":true}]", typeof(ICollection<Curve>)));
            var literal = Resolve("[1,2]", typeof(ICollection<double>));
            Assert.Equal(new[] { 1d, 2d }, Assert.IsAssignableFrom<ICollection<double>>(literal.Value));
        }

        [Fact]
        public void NestedCollectionsAndDerivedFactoryResultsCannotDropForeignProvenance()
        {
            var active = new object(); var foreign = new object();
            _values["curve"] = new NativeGraphArgument(new Line(), new[] { foreign });
            var nested = Resolve("[[{\"$ref\":\"curve\"}]]", typeof(IList<IList<Curve>>));
            _values["solid"] = new NativeGraphArgument(new Solid(), OperatorNativeGraphArguments.MergeOwners(nested.Owners));
            var argument = Resolve("[{\"$ref\":\"solid\"}]", typeof(IList<Geometry>));
            var all = new[] { active }.Concat(argument.Owners);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(all, active, ReferenceEquals));
            Assert.Single(argument.Owners);
        }

        [Fact]
        public void NativeCollectionReferenceScansEveryActualItemOwner()
        {
            var active = new object(); var foreign = new object();
            _values["borrowed"] = new NativeGraphArgument(new Curve[] { new Line { Owner = active }, new Line { Owner = foreign } }, new[] { active });
            var argument = Resolve("{\"$ref\":\"borrowed\"}", typeof(Curve[]));
            Assert.Equal(new[] { active, foreign }, argument.Owners);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(argument.Owners, active, ReferenceEquals));
        }

        [Theory]
        [InlineData("{\"$ref\":\"missing\"}")]
        [InlineData("{\"$ref\":\"future\"}")]
        [InlineData("{\"$ref\":\"\"}")]
        [InlineData("{\"$ref\":\"line\",\"type\":\"Curve\"}")]
        [InlineData("{\"$ref\":3}")]
        public void MissingForwardOrMalformedReferenceFailsBeforeNativeInvocation(string json)
        {
            _values["line"] = new NativeGraphArgument(new Line());
            Assert.Throws<InvalidOperationException>(() => Resolve(json, typeof(Curve)));
        }

        [Theory]
        [InlineData("{\"$ref\":\"solid\"}")]
        [InlineData("{\"$ref\":\"null\"}")]
        [InlineData("{\"type\":\"Curve\",\"points\":[]}")]
        public void GeometryRequiresTheCorrectActualRuntimeType(string json)
        {
            _values["solid"] = new NativeGraphArgument(new Solid());
            _values["null"] = new NativeGraphArgument(null);
            Assert.Throws<InvalidOperationException>(() => Resolve(json, typeof(Curve)));
        }

        [Fact]
        public void GeometryBaseAcceptsSolidReferenceWithoutJsonObjectCoercion()
        {
            var solid = new Solid(); _values["solid"] = new NativeGraphArgument(solid);
            Assert.Same(solid, Assert.IsType<List<Geometry>>(Resolve("[{\"$ref\":\"solid\"}]", typeof(IList<Geometry>)).Value)[0]);
        }

        [Fact]
        public void TypedSplineArgumentPreservesActualTypeAndForeignOwnership()
        {
            var active = new object(); var foreign = new object();
            var spline = new Spline();
            _values["spline"] = new NativeGraphArgument(spline, new[] { foreign });
            var argument = Resolve("{\"$ref\":\"spline\"}", typeof(Spline));
            Assert.Same(spline, argument.Value);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(argument.Owners, active, ReferenceEquals));
            _values["line"] = new NativeGraphArgument(new Line(), new[] { active });
            Assert.Throws<InvalidOperationException>(() => Resolve("{\"$ref\":\"line\"}", typeof(Spline)));
            Assert.Throws<InvalidOperationException>(() => Resolve("{\"points\":[[0,0,0],[1,0,0]]}", typeof(Spline)));
        }

        [Fact]
        public void SplineSignaturesRequireExactReviewedNativeTypeNames()
        {
            const string ns = "Autodesk.Revit.DB.";
            Assert.True(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "HermiteSpline"));
            Assert.True(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "NurbSpline"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "NurbSplineOptions"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType("Untrusted.Autodesk.Revit.DB.NurbSpline"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "NurbSpline", "Create", true, ns + "NurbSpline", ns + "HermiteSpline"));
        }

        [Fact]
        public void SketchPlaneUsesExactReferenceOnlyAdmissionAndNeverBecomesADetachedFactory()
        {
            const string ns = "Autodesk.Revit.DB.";
            Assert.True(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "SketchPlane"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "SketchPlaneOptions"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType("Untrusted." + ns + "SketchPlane"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "Plane"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "SketchPlane", "Create", true,
                ns + "SketchPlane", ns + "Document", ns + "Plane"));
        }

        [Fact]
        public void SketchPlaneReferenceRetainsActualDocumentOwnerAndRejectsForeignBorrowing()
        {
            var active = new object(); var foreign = new object();
            var plane = new SketchPlane { Owner = active };
            _values["plane"] = new NativeGraphArgument(plane, new[] { active });
            var argument = Resolve("{\"$ref\":\"plane\"}", typeof(SketchPlane));
            Assert.Same(plane, argument.Value);
            OperatorNativeGraphArguments.RequireActiveOwners(argument.Owners, active, ReferenceEquals);
            _values["borrowed"] = new NativeGraphArgument(new SketchPlane { Owner = foreign }, new[] { active });
            var borrowed = Resolve("{\"$ref\":\"borrowed\"}", typeof(SketchPlane));
            Assert.Equal(new[] { active, foreign }, borrowed.Owners);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(borrowed.Owners, active, ReferenceEquals));
        }

        [Theory]
        [InlineData("910")]
        [InlineData("null")]
        [InlineData("{\"elementId\":910}")]
        [InlineData("{\"$ref\":\"empty\"}")]
        [InlineData("{\"$ref\":\"line\"}")]
        [InlineData("{\"$ref\":\"plane\",\"elementId\":910}")]
        public void SketchPlaneCannotBeForgedFromAnIdNullOrWrongRuntimeReference(string json)
        {
            _values["plane"] = new NativeGraphArgument(new SketchPlane());
            _values["empty"] = new NativeGraphArgument(null);
            _values["line"] = new NativeGraphArgument(new Line());
            Assert.Throws<InvalidOperationException>(() => Resolve(json, typeof(SketchPlane)));
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void OrdinaryNullReferencesKeepTheirExistingCompatibility(bool collection)
        {
            var owner = new object(); _values["empty"] = new NativeGraphArgument(null, new[] { owner });
            var result = Resolve("{\"$ref\":\"empty\"}", collection ? typeof(IList<string>) : typeof(string));
            Assert.Null(result.Value);
            Assert.Equal(new[] { owner }, result.Owners);
        }

        [Fact]
        public void LiteralAndReferencedCollectionsBothEnforceItemLimits()
        {
            var json = "[" + string.Join(",", Enumerable.Repeat("1", 65)) + "]";
            Assert.Throws<InvalidOperationException>(() => Resolve(json, typeof(double[])));
            _values["too_many"] = new NativeGraphArgument(Enumerable.Range(0, 65).Select(_ => new Line()).ToArray());
            Assert.Throws<InvalidOperationException>(() => Resolve("{\"$ref\":\"too_many\"}", typeof(Curve[])));
        }

        [Fact]
        public void CollectionDepthAndWholeRequestNodeBudgetsAreBounded()
        {
            Assert.Throws<InvalidOperationException>(() => Resolve("[[[[[1]]]]]", typeof(List<List<List<List<List<double>>>>>)));
            var resolver = new OperatorNativeGraphArguments();
            for (var i = 0; i < OperatorNativeGraphArguments.MaxNodes; i++) Resolve("1", typeof(double), resolver);
            Assert.Throws<InvalidOperationException>(() => Resolve("1", typeof(double), resolver));
        }

        [Fact]
        public void OwnerOverflowRejectsInsteadOfHidingAForeignOwner()
        {
            var active = new object(); var foreign = new object();
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(
                Enumerable.Repeat(active, 256).Concat(new[] { foreign }), active, ReferenceEquals));
            Assert.Throws<InvalidOperationException>(() => OperatorNativeGraphArguments.RequireActiveOwners(Array.Empty<object>(), active, ReferenceEquals));
            OperatorNativeGraphArguments.RequireActiveOwners(new[] { active, active }, active, ReferenceEquals);
        }

        [Fact]
        public void OnlyExactReviewedStaticGeometryFactoriesAreDocumentNeutral()
        {
            const string ns = "Autodesk.Revit.DB.";
            Assert.True(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "Line", "CreateBound", true, ns + "Line", ns + "XYZ", ns + "XYZ"));
            Assert.True(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "Arc", "Create", true, ns + "Arc", ns + "XYZ", ns + "XYZ", ns + "XYZ"));
            Assert.True(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "CurveLoop", "Create", true, ns + "CurveLoop", "System.Collections.Generic.IList`1<" + ns + "Curve>"));
            Assert.True(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "GeometryCreationUtilities", "CreateExtrusionGeometry", true, ns + "Solid", "System.Collections.Generic.IList`1<" + ns + "CurveLoop>", ns + "XYZ", "System.Double"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "Line", "CreateBound", false, ns + "Line", ns + "XYZ", ns + "XYZ"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "Line", "CreateBound", true, ns + "Solid", ns + "XYZ", ns + "XYZ"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "Arc", "Create", true, ns + "Arc", ns + "Plane", "System.Double", "System.Double", "System.Double"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "DirectShape", "CreateElement", true, ns + "DirectShape", ns + "Document", ns + "ElementId"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsDetachedFactory(ns + "GeometryCreationUtilities", "CreateExtrusionGeometry", true, ns + "Solid", "System.Collections.Generic.IList`1<" + ns + "CurveLoop>", ns + "XYZ", "System.Double", ns + "SolidOptions"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "ShapeBuilder"));
            Assert.False(OperatorNativeGeometryGraphPolicy.IsReferenceOnlyType(ns + "Transaction"));
        }

        [Theory]
        [InlineData("RolledBack", "none")]
        [InlineData("Pending", "unknown")]
        public void WrongReferenceAfterCreationRetainsActualRollbackOutcome(string rolledBack, string effect)
        {
            var result = OperatorNativeGraphFailureSettlement.Capture(new InvalidOperationException("missing solid after shape creation"),
                () => "Started", () => rolledBack, () => throw new Exception("not committed"));
            Assert.Equal(false, result["success"]);
            Assert.Equal(effect, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/native-api-mutation-ops").EffectState);
        }

        [Fact]
        public void LostCommitResponseCannotBecomeSchemaRejectionOrRetryableNoEffect()
        {
            var result = OperatorNativeGraphFailureSettlement.Capture(new InvalidOperationException("response failed after commit"),
                () => "Committed", () => throw new Exception("never roll back known commit"),
                () => OperatorNativeTransactionReceipt.CommittedChanges(new[] { 42L }, Array.Empty<long>(), Array.Empty<long>()));
            Assert.Equal("CommittedWithErrors", result["status"]);
            Assert.Equal(new[] { "element_id:42" }, OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/native-api-mutation-ops").AffectedTargetIdentities);
        }

        [Fact]
        public void FailedStatusReadStaysUnknownAndNoCreatedTransactionProvesNotStarted()
        {
            var unknown = OperatorNativeGraphFailureSettlement.Capture(new Exception("failed"), () => throw new Exception("status unavailable"),
                () => throw new Exception("cannot infer rollback"), () => throw new Exception("no inventory"));
            Assert.Equal("unknown", OperatorAttemptSuccessfulSettlement.Classify(unknown, "apply", "POST", "/revit/native-api-mutation-ops").EffectState);
            var notStarted = OperatorNativeGraphFailureSettlement.Capture(new Exception("checkpoint unavailable"), null, null, () => throw new Exception("no commit"));
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(notStarted, "apply", "POST", "/revit/native-api-mutation-ops").EffectState);
        }

        [Fact]
        public void RollbackExceptionNeedsFreshNativeStatusInsteadOfAssumedNoEffect()
        {
            var reads = 0;
            var result = OperatorNativeGraphFailureSettlement.Capture(new Exception("bad argument after creation"),
                () => ++reads == 1 ? "Started" : "RolledBack", () => throw new Exception("rollback response lost"),
                () => throw new Exception("must not invent a commit"));
            Assert.Equal(2, reads);
            Assert.Equal("none", OperatorAttemptSuccessfulSettlement.Classify(result, "apply", "POST", "/revit/native-api-mutation-ops").EffectState);
            Assert.Contains("rollback response lost", (string)result["error"]!);
        }

        [Fact]
        public void ProductionGatewayUsesTestedConverterAndSeparateGraphPolicy()
        {
            var source = ReadGatewaySource();
            Assert.Contains("=> resolver.Resolve(value, targetType", source);
            Assert.Contains("OperatorNativeGraphArguments.RequireActiveOwners", source);
            Assert.Contains("OperatorNativeDocumentIdBaseline.Capture(ids.Select(ElementIdCompat.GetValue)", source);
            Assert.Contains("SameDocument(element.Document, document)", source);
            Assert.DoesNotContain("new HashSet<long>(ids.Select(ElementIdCompat.GetValue).Where(id => id > 0))", source);
            Assert.Contains("OperatorNativeGeometryGraphPolicy.IsDetachedFactory", source);
            Assert.Contains("graph_signature_supported = d.GraphCallable", source);
            Assert.Contains("IsAllowed(descriptor, out var reason, graphArguments: true)) throw new InvalidOperationException($\"Native API operation blocked:", source);
            Assert.Contains("IsAllowed(descriptor, out var reason)) throw new InvalidOperationException($\"Native API call blocked:", source);
            Assert.DoesNotContain("IsAllowed(descriptor, out var reason, graphArguments: true)) throw new InvalidOperationException($\"Native API call blocked:", source);
            Assert.Contains("OperatorNativeGraphFailureSettlement.Capture(originalError", source);
            Assert.True(source.IndexOf("ownedGeometry.Add(temporary)", StringComparison.Ordinal) < source.IndexOf("if (step.ElapsedMilliseconds > maxOperationMs)", StringComparison.Ordinal));
            Assert.Contains("for (var i = ownedGeometry.Count - 1; i >= 0; i--)", source);
        }

        private static string ReadGatewaySource()
        {
            var retained = Environment.GetEnvironmentVariable("OPERATOR_TEST_GATEWAY_SOURCE");
            if (!string.IsNullOrWhiteSpace(retained)) return File.ReadAllText(retained);
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, "RevitBridge/Operator/OperatorNativeApiGateway.cs");
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException("Native gateway source not found.");
        }
    }
}

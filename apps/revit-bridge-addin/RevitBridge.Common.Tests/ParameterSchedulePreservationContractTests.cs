using System;
using System.IO;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ParameterSchedulePreservationContractTests
    {
        private static string Source(string relative)
        {
            for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                {
                    var file = Path.Combine(directory.FullName, prefix, relative);
                    if (File.Exists(file)) return File.ReadAllText(file);
                }
            throw new FileNotFoundException(relative);
        }

        [Fact]
        public void ParameterProducerCapturesBeforeTransactionAndRetainsActualCollateral()
        {
            var source = Source("RevitBridge/Handlers/SetParameterHandler.cs");
            var capture = source.IndexOf("AnnotationSchedulePreservation.CaptureBefore(doc)", StringComparison.Ordinal);
            Assert.True(capture >= 0 && capture < source.IndexOf("trans.Start()", StringComparison.Ordinal));
            Assert.Contains("AnnotationSchedulePreservation.AttachParameterResult", source);
            Assert.Contains("changeInventory.CommittedReceipt()", source);
            Assert.Contains("finally { app.Application.DocumentChanged -= Changed; }", source);
        }

        [Fact]
        public void SeparateParameterReadExposesBoundedScheduleSnapshotsWithoutChangingLegacySelector()
        {
            var source = Source("RevitBridge/Handlers/GetElementParametersHandler.cs");
            Assert.Contains("List<long>? preservationScheduleIds", source);
            Assert.Contains("AnnotationSchedulePreservation.AttachRead", source);
            Assert.Contains("get-parameters accepts exactly one selector", source);
            // The executable parser must be the same strict parser exercised by
            // the request tests, not a second handler whitelist that can drift.
            Assert.Contains("GetElementParametersRequestParser.Parse<Params>(jsonData)", source);
            var schema = Source("RevitBridge/Operator/OperatorToolIntrospection.cs");
            var start = schema.IndexOf("if (string.Equals(p, \"/revit/get-parameters\"", StringComparison.Ordinal);
            Assert.Contains("\"preservationScheduleIds\"", schema.Substring(start, 2100));
        }
    }
}

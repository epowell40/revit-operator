using System;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB.Events;
using RevitBridge.Common;

namespace RevitBridge.Services
{
    internal static class RevitDocumentChangeObservations
    {
        private static readonly OperatorDocumentChangeObservationStore Store = new OperatorDocumentChangeObservationStore(Process.GetCurrentProcess().Id);

        // Called only from the existing Revit UI event subscription. Never retain Document/Element objects.
        public static void Capture(DocumentChangedEventArgs args)
        {
            try
            {
                var document = args.GetDocument();
                Store.Record(OperatorNativeDocumentSessionAuthority.GetSessionId(document), args.Operation.ToString(), args.GetTransactionNames(),
                    args.GetAddedElementIds().Select(ElementIdCompat.GetValue), args.GetModifiedElementIds().Select(ElementIdCompat.GetValue),
                    args.GetDeletedElementIds().Select(ElementIdCompat.GetValue), DateTimeOffset.UtcNow);
            }
            catch { Store.RecordCaptureFailure(DateTimeOffset.UtcNow); }
        }

        public static JsonElement Read(string documentSessionId)
        {
            using var json = JsonDocument.Parse(Store.ReadJson(documentSessionId));
            return json.RootElement.Clone();
        }
    }
}

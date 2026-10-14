using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Read an owned temporary document; never close an editor already open before the read.</summary>
    public static class TemporaryDocumentInspection
    {
        public static TResult Run<TDocument, TResult>(IEnumerable<TDocument> alreadyOpen,
            Func<TDocument> open, Func<TDocument, TResult> inspect,
            Func<TDocument, bool> closeWithoutSaving, Func<TDocument, bool> isValid)
            where TDocument : class
        {
            // Snapshot before opening: Revit EditFamily can return an existing editor.
            var retained = alreadyOpen.ToArray();
            var document = open() ?? throw new InvalidOperationException("The temporary inspection document could not be opened.");
            if (retained.Contains(document))
                throw new InvalidOperationException("The family is already open for editing. Close the existing edit session before inspecting loaded project content; this read did not close the editor or discard its edits.");

            try
            {
                return inspect(document);
            }
            finally
            {
                // No success result escapes before native closure is confirmed.
                if (!closeWithoutSaving(document) || isValid(document))
                    throw new InvalidOperationException("The temporary inspection document could not be confirmed closed without saving.");
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    internal static class FamilyLabelStyleAccess
    {
        internal static FamilyEditSessionStore.Session RequireSession(UIApplication app, string id)
        {
            if (!FamilyEditSessionStore.TryGet(id, out var session, out var error))
                throw new InvalidOperationException(error ?? "Family session not found.");
            if (!session.ProjectDoc.IsValidObject || !session.FamilyDoc.IsValidObject
                || !session.FamilyDoc.IsFamilyDocument || session.ProjectDoc.IsFamilyDocument
                || !session.ProjectDoc.Equals(app.ActiveUIDocument?.Document))
                throw new InvalidOperationException("The family session does not belong to the active project. Activate its parent project first.");
            return session;
        }

        internal static Element[] Labels(Document doc)
            => new FilteredElementCollector(doc).WhereElementIsNotElementType().ToElements()
                .Where(element => !(element is TextNote) && FamilyLabelInspectionPolicy.IsLabel(element.GetType().Name))
                .OrderBy(element => ElementIdCompat.GetValue(element.Id)).ToArray();

        internal static Element RequireType(Document doc, long id, Element[] labels)
        {
            var type = doc.GetElement(ElementIdCompat.Create(id));
            if (!(type is ElementType) || !labels.Any(label => label.GetTypeId() == type.Id))
                throw new InvalidOperationException("labelTypeId must identify a type actually used by a label in this family session.");
            return type;
        }

        internal static FamilyLabelStyleValues Read(Element type)
        {
            int? Integer(BuiltInParameter id) => type.get_Parameter(id)?.AsInteger();
            double? Number(BuiltInParameter id) => type.get_Parameter(id)?.AsDouble();
            return new FamilyLabelStyleValues
            {
                font = type.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString(),
                textSizeFeet = Number(BuiltInParameter.TEXT_SIZE),
                bold = Integer(BuiltInParameter.TEXT_STYLE_BOLD) is int bold ? (bool?)(bold != 0) : null,
                italic = Integer(BuiltInParameter.TEXT_STYLE_ITALIC) is int italic ? (bool?)(italic != 0) : null,
                underline = Integer(BuiltInParameter.TEXT_STYLE_UNDERLINE) is int underline ? (bool?)(underline != 0) : null,
                widthFactor = Number(BuiltInParameter.TEXT_WIDTH_SCALE)
            };
        }

        internal static BuiltInParameter ParameterId(string field)
        {
            switch (field)
            {
                case "font": return BuiltInParameter.TEXT_FONT;
                case "textSizeFeet": return BuiltInParameter.TEXT_SIZE;
                case "bold": return BuiltInParameter.TEXT_STYLE_BOLD;
                case "italic": return BuiltInParameter.TEXT_STYLE_ITALIC;
                case "underline": return BuiltInParameter.TEXT_STYLE_UNDERLINE;
                case "widthFactor": return BuiltInParameter.TEXT_WIDTH_SCALE;
                default: throw new ArgumentException("Unknown label style field.");
            }
        }

        internal static void RequireWritable(Element type, FamilyLabelStyleValues patch)
        {
            foreach (var field in FamilyLabelStylePolicy.Values(patch))
            {
                var parameter = type.get_Parameter(ParameterId(field.Key));
                var storage = field.Value is bool ? StorageType.Integer : field.Value is double ? StorageType.Double : StorageType.String;
                if (parameter == null || parameter.IsReadOnly || parameter.StorageType != storage)
                    throw new InvalidOperationException("Label style field is unavailable or read-only: " + field.Key);
            }
        }

        internal static void Set(Element type, FamilyLabelStyleValues patch)
        {
            var current = FamilyLabelStylePolicy.Values(Read(type));
            foreach (var field in FamilyLabelStylePolicy.Values(patch))
            {
                if (current.TryGetValue(field.Key, out var observed) && FamilyLabelStylePolicy.EqualValue(field.Value, observed)) continue;
                var parameter = type.get_Parameter(ParameterId(field.Key));
                var accepted = field.Value is bool flag ? parameter.Set(flag ? 1 : 0)
                    : field.Value is double number ? parameter.Set(number) : parameter.Set((string)field.Value);
                if (!accepted) throw new InvalidOperationException("Revit refused label style field: " + field.Key);
            }
        }
    }
}

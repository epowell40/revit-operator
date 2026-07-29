using System;

namespace Autodesk.Revit.DB
{
    public abstract class APIObject : IDisposable
    {
        public virtual bool IsValidObject { get { return true; } }
        public virtual void Dispose() { }
    }

    public abstract class Element : APIObject
    {
    }

    public sealed class Document : APIObject
    {
        public bool IsModifiable { get { return false; } }
        public bool IsModified { get { return false; } }
    }

    public sealed class ViewSheet : Element
    {
        public bool IsPlaceholder { get { return false; } }
    }

    public sealed class FilteredElementIterator : APIObject
    {
        public Element Current { get { return null!; } }
        public bool MoveNext() { return false; }
    }

    public sealed class FilteredElementCollector : APIObject
    {
        public FilteredElementCollector(Document document) { }
        public FilteredElementCollector OfClass(Type type) { return this; }
        public FilteredElementIterator GetElementIterator() { return new FilteredElementIterator(); }
    }
}

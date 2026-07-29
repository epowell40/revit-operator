using Autodesk.Revit.DB;

namespace RevitOperator.SafeReadCertifiedExecution
{
    public sealed class CertifiedSheetCountResult
    {
        private readonly bool _succeeded;
        private readonly int _count;
        private readonly int _failureCode;

        internal CertifiedSheetCountResult(bool succeeded, int count, int failureCode)
        {
            _succeeded = succeeded;
            _count = count;
            _failureCode = failureCode;
        }

        public bool Succeeded { get { return _succeeded; } }
        public int Count { get { return _count; } }
        public int FailureCode { get { return _failureCode; } }
    }

    public static class CertifiedSheetCountKernel
    {
        private const int MaximumSheetCount = 100000;

        public static CertifiedSheetCountResult Execute(Document document)
        {
            if (document == null || !document.IsValidObject)
                return Failure(1);
            if (document.IsModifiable)
                return Failure(2);

            bool initiallyModified = document.IsModified;
            int count = 0;
            FilteredElementCollector collector = new FilteredElementCollector(document).OfClass(typeof(ViewSheet));
            using (FilteredElementIterator iterator = collector.GetElementIterator())
            {
                while (iterator.MoveNext())
                {
                    if (!document.IsValidObject || document.IsModified != initiallyModified)
                        return Failure(3);
                    if (document.IsModifiable)
                        return Failure(2);

                    ViewSheet? sheet = iterator.Current as ViewSheet;
                    if (sheet == null || sheet.IsPlaceholder)
                        continue;
                    count++;
                    if (count > MaximumSheetCount)
                        return Failure(4);
                }
            }

            if (!document.IsValidObject || document.IsModified != initiallyModified)
                return Failure(3);
            if (document.IsModifiable)
                return Failure(2);
            return new CertifiedSheetCountResult(true, count, 0);
        }

        private static CertifiedSheetCountResult Failure(int code)
        {
            return new CertifiedSheetCountResult(false, 0, code);
        }
    }
}

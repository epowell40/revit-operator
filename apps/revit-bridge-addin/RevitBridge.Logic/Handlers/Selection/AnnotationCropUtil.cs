using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    /// <summary>Used only inside an export's temporary transaction. Offsets
    /// are view/paper feet, independent of model-space focus padding.</summary>
    internal static class AnnotationCropUtil
    {
        internal static bool TryConfigure(View view, double marginViewFt, List<string> warnings)
        {
            try
            {
                using (var manager = view.GetCropRegionShapeManager())
                    return TemporaryAnnotationCrop.TryConfigure(new NativeSettings(view, manager), marginViewFt, warnings);
            }
            catch (Exception error)
            {
                warnings.Add("Could not bound annotations for the temporary export: " + error.Message);
                return false;
            }
        }

        private sealed class NativeSettings : ITemporaryAnnotationCropSettings
        {
            private readonly ViewCropRegionShapeManager manager;
            private readonly Parameter? active;
            internal NativeSettings(View view, ViewCropRegionShapeManager manager)
            {
                this.manager = manager;
                active = view.get_Parameter(BuiltInParameter.VIEWER_ANNOTATION_CROP_ACTIVE);
            }
            public bool Supported => manager.CanHaveAnnotationCrop;
            public bool CanActivate => active != null && active.StorageType == StorageType.Integer && !active.IsReadOnly;
            public bool Active
            {
                get => active != null && active.StorageType == StorageType.Integer && active.AsInteger() == 1;
                set
                {
                    if (!CanActivate) throw new InvalidOperationException("The annotation-crop setting is unavailable or read-only.");
                    active!.Set(value ? 1 : 0);
                }
            }
            public double Left { get => manager.LeftAnnotationCropOffset; set => manager.LeftAnnotationCropOffset = value; }
            public double Right { get => manager.RightAnnotationCropOffset; set => manager.RightAnnotationCropOffset = value; }
            public double Top { get => manager.TopAnnotationCropOffset; set => manager.TopAnnotationCropOffset = value; }
            public double Bottom { get => manager.BottomAnnotationCropOffset; set => manager.BottomAnnotationCropOffset = value; }
        }
    }
}

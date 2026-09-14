using System.Windows;
using System.Windows.Media;

namespace RevitBridge.Operator
{
    internal static class OperatorRibbonIcon
    {
        internal static ImageSource Create(double size)
        {
            var drawing = new DrawingGroup();
            using (var context = drawing.Open())
            {
                context.DrawRoundedRectangle(new SolidColorBrush(Color.FromRgb(35, 38, 40)), null,
                    new Rect(1, 1, 30, 30), 7, 7);
                context.DrawRoundedRectangle(null, new Pen(Brushes.White, 2.4),
                    new Rect(8, 8, 16, 13), 4, 4);
                context.DrawLine(new Pen(Brushes.White, 2.4), new Point(11, 21), new Point(8, 25));
                context.DrawLine(new Pen(Brushes.White, 2.4), new Point(8, 25), new Point(17, 21));
            }
            drawing.Transform = new ScaleTransform(size / 32, size / 32);
            drawing.Freeze();
            var image = new DrawingImage(drawing);
            image.Freeze();
            return image;
        }
    }
}

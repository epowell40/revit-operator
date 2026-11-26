using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading.Tasks;
public sealed class OperatorControlFrame : Form {
    public OperatorControlFrame(Rectangle bounds) {
        FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true;
        StartPosition=FormStartPosition.Manual; Bounds=bounds;
        BackColor=Color.Magenta; TransparencyKey=Color.Magenta; DoubleBuffered=true;
        Text="Operator computer control indicator";
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams { get {
        var cp=base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00000020 | 0x00000080; return cp;
    }}
    protected override void OnPaint(PaintEventArgs e) {
        using(var pen=new Pen(Color.FromArgb(66,133,239),5))
            e.Graphics.DrawRectangle(pen,2,2,ClientSize.Width-5,ClientSize.Height-5);
        var box=new Rectangle(Math.Max(6,(ClientSize.Width-280)/2),0,280,28);
        using(var brush=new SolidBrush(Color.FromArgb(36,89,181)))e.Graphics.FillRectangle(brush,box);
        TextRenderer.DrawText(e.Graphics,"Operator computer control active",SystemFonts.MessageBoxFont,
            box,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
    }
    [STAThread] public static void Main() {
        Application.EnableVisualStyles();
        var context=new ApplicationContext();
        var frames=new System.Collections.Generic.List<OperatorControlFrame>();
        foreach(var screen in Screen.AllScreens){var f=new OperatorControlFrame(screen.Bounds);frames.Add(f);f.Show();}
        var deadline=DateTime.UtcNow.AddSeconds(6);
        Task<string> line=Task.Run(() => Console.ReadLine());
        var timer=new System.Windows.Forms.Timer();timer.Interval=100;
        timer.Tick+=(sender,args)=>{
            if(line.IsCompleted){
                if(line.IsFaulted||line.Result!="active"){context.ExitThread();return;}
                deadline=DateTime.UtcNow.AddSeconds(6);line=Task.Run(() => Console.ReadLine());
            }
            if(DateTime.UtcNow>deadline)context.ExitThread();
        };
        timer.Start();Console.WriteLine("READY");Console.Out.Flush();
        try{Application.Run(context);}finally{timer.Dispose();foreach(var f in frames)f.Dispose();}
    }
}

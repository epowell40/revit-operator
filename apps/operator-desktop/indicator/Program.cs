using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading.Tasks;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
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
        var box=new Rectangle(Math.Max(6,(ClientSize.Width-420)/2),0,420,28);
        using(var brush=new SolidBrush(Color.FromArgb(36,89,181)))e.Graphics.FillRectangle(brush,box);
        TextRenderer.DrawText(e.Graphics,"Operator control · Press Esc twice to stop",SystemFonts.MessageBoxFont,
            box,Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
    }
    private delegate IntPtr KeyboardHook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll",SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int type, KeyboardHook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string module);
    [STAThread] public static void Main(string[] args) {
        if (args.Length != 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], @"^Local\\OperatorInputStop_[a-f0-9]{32}$")) return;
        using (var stop = new EventWaitHandle(false, EventResetMode.ManualReset, args[0])) {
        Application.EnableVisualStyles();
        var context=new ApplicationContext();
        var frames=new System.Collections.Generic.List<OperatorControlFrame>();
        foreach(var screen in Screen.AllScreens){var f=new OperatorControlFrame(screen.Bounds);frames.Add(f);f.Show();}
        var halo = new OperatorPointerHalo(); halo.Show();
        var gesture = new EscapeGesture(); var clock=Stopwatch.StartNew();
        KeyboardHook callback=(code,message,data)=>{
            if(code>=0 && Marshal.ReadInt32(data)==0x1B) {
                var kind=message.ToInt64(); var flags=Marshal.ReadInt32(data,8);
                if((kind==0x100||kind==0x104||kind==0x101||kind==0x105) &&
                    gesture.Observe(kind==0x100||kind==0x104,(flags&0x12)!=0,clock.ElapsedMilliseconds)) {
                    stop.Set(); Console.WriteLine("STOP"); Console.Out.Flush();
                    return new IntPtr(1);
                }
            }
            return CallNextHookEx(IntPtr.Zero,code,message,data);
        };
        var hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);
        if(hook==IntPtr.Zero){stop.Set();foreach(var f in frames)f.Dispose();halo.Dispose();return;}
        var deadline=DateTime.UtcNow.AddSeconds(6);
        Task<string> line=Task.Run(() => Console.ReadLine());
        var timer=new System.Windows.Forms.Timer();timer.Interval=32;
        timer.Tick+=(sender,eventArgs)=>{
            var cursor=Cursor.Position; halo.Location=new Point(cursor.X-18,cursor.Y-18);
            if(stop.WaitOne(0)) { halo.Hide(); foreach(var f in frames)f.Hide(); }
            if(line.IsCompleted){
                if(line.IsFaulted){context.ExitThread();return;}
                if(line.Result=="stop")stop.Set();
                else if(line.Result!="active"){context.ExitThread();return;}
                deadline=DateTime.UtcNow.AddSeconds(6);line=Task.Run(() => Console.ReadLine());
            }
            if(DateTime.UtcNow>deadline)context.ExitThread();
        };
        timer.Start();Console.WriteLine("READY");Console.Out.Flush();
        try{Application.Run(context);}finally{stop.Set();UnhookWindowsHookEx(hook);GC.KeepAlive(callback);timer.Dispose();halo.Dispose();foreach(var f in frames)f.Dispose();}
        }
    }
}

public sealed class OperatorPointerHalo : Form {
    public OperatorPointerHalo() {
        FormBorderStyle=FormBorderStyle.None;ShowInTaskbar=false;TopMost=true;
        StartPosition=FormStartPosition.Manual;Size=new Size(36,36);BackColor=Color.DodgerBlue;Opacity=0.3;
        using(var shape=new System.Drawing.Drawing2D.GraphicsPath()){shape.AddEllipse(0,0,36,36);Region=new Region(shape);}
    }
    protected override bool ShowWithoutActivation {get{return true;}}
    protected override CreateParams CreateParams {get{var cp=base.CreateParams;cp.ExStyle|=0x08000000|0x00000020|0x00000080;return cp;}}
}

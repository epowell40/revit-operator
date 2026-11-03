#requires -Version 7.0
param(
    [Parameter(Mandatory=$true)][string]$CommonAssembly,
    [Parameter(Mandatory=$true)][string]$TestRoot
)
$ErrorActionPreference='Stop'
$taskAssembly=(Resolve-Path -LiteralPath $CommonAssembly).Path
$taskRoot=[IO.Path]::GetFullPath($TestRoot)
if(-not [IO.Path]::IsPathRooted($TestRoot) -or (Test-Path -LiteralPath $taskRoot)){throw 'Use a new absolute test artifact directory.'}
New-Item -ItemType Directory -Path $taskRoot|Out-Null
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskSource=@'
using System;using System.IO;using System.Reflection;using System.Drawing;
class ExportLegacyHost {
 static int Main(string[] a) {
  try {
   var method=Assembly.LoadFrom(a[0]).GetType("RevitBridge.Common.ExportedImagePathResolver",true).GetMethod("ReadRequired");
   object artifact;
   try {artifact=method.Invoke(null,new object[]{a[1]});}
   catch(TargetInvocationException e) {
    if(a[2]!="positive"&&e.InnerException is InvalidOperationException){Console.WriteLine("PASS "+a[2]);return 0;}throw;
   }
   if(a[2]!="positive")throw new Exception("Invalid target was accepted.");
   var type=artifact.GetType();var actual=(string)type.GetProperty("Path").GetValue(artifact,null);
   if(actual!=a[3]||(string)type.GetProperty("Sha256").GetValue(artifact,null)!=a[4])throw new Exception("Artifact identity changed.");
   var metadata=Assembly.LoadFrom(Path.Combine(Path.GetDirectoryName(a[0]),"RevitBridge.Logic.dll")).GetType("RevitBridge.Logic.ExportedImageMetadata",true);
   var dimensions=metadata.GetMethod("ReadDimensions").Invoke(null,new object[]{actual});
   if((int)dimensions.GetType().GetField("Item1").GetValue(dimensions)!=1||(int)dimensions.GetType().GetField("Item2").GetValue(dimensions)!=1)throw new Exception("Image dimensions changed.");
   Console.WriteLine("PASS positive "+actual.Length);return 0;
  } catch(Exception e){while(e.InnerException!=null)e=e.InnerException;Console.WriteLine("FAIL "+e.GetType().Name+": "+e.Message);return 1;}
 }
}
'@
$taskCs=Join-Path $taskRoot 'ExportLegacyHost.cs'
$taskExe=Join-Path $taskRoot 'ExportLegacyHost.exe'
[IO.File]::WriteAllText($taskCs,$taskSource)
[IO.File]::WriteAllText($taskExe+'.config','<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup><runtime><AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=true;Switch.System.IO.BlockLongPaths=true" /></runtime></configuration>')
& $taskCompiler /nologo /r:System.Drawing.dll "/out:$taskExe" $taskCs
if($LASTEXITCODE -ne 0){throw 'Legacy test host did not compile.'}
Add-Type -AssemblyName System.Drawing
$taskBitmap=[Drawing.Bitmap]::new(1,1)
$taskStream=[IO.MemoryStream]::new()
try{$taskBitmap.Save($taskStream,[Drawing.Imaging.ImageFormat]::Png);$taskPixels=$taskStream.ToArray()}
finally{$taskStream.Dispose();$taskBitmap.Dispose()}
$taskHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($taskPixels)).ToLowerInvariant()
$taskResults=@()
foreach($taskCase in @('short','long260','long280','missing','empty','ambiguous')){
 $taskDir=Join-Path $taskRoot $taskCase
 New-Item -ItemType Directory -Path $taskDir|Out-Null
 $taskBase=Join-Path $taskDir 'Revit_unique'
 $taskActual=$taskBase+'.png'
 $taskMode=if($taskCase -in @('short','long260','long280')){'positive'}else{$taskCase}
 if($taskCase.StartsWith('long')){
  $taskLength=[int]$taskCase.Substring(4)
  $taskPadding=$taskLength-$taskBase.Length-7
  if($taskPadding -lt 1){throw 'Test root is too long for the selected fixture.'}
  $taskActual=$taskBase+' - '+('x'*$taskPadding)+'.png'
 }
 if($taskCase -eq 'empty'){[IO.File]::WriteAllBytes($taskActual,[byte[]]::new(0))}
 elseif($taskCase -ne 'missing'){[IO.File]::WriteAllBytes($taskActual,$taskPixels)}
 if($taskCase -eq 'ambiguous'){[IO.File]::WriteAllBytes($taskBase+' - Other.png',$taskPixels)}
 [IO.File]::WriteAllBytes($taskBase+'Other.png',$taskPixels)
 $taskOutput=& $taskExe $taskAssembly $taskBase $taskMode $taskActual $taskHash
 $taskResults+=@{case=$taskCase;exit_code=$LASTEXITCODE;output=$taskOutput;path_length=$taskActual.Length}
}
$taskResults|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $taskRoot 'results.json')
$taskResults|ConvertTo-Json -Depth 5
if(@($taskResults|Where-Object exit_code -ne 0).Count){throw 'Native image legacy-host regression failed. Retain results.json.'}

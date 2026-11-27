# Persist before input, scoped by the host's admitted assignment. Unknown target
# identity remains conservative. This is readiness evidence, never an effect receipt.
function Save-OperatorNativeReadinessObligation {
 param([object]$Window)
 if (!$env:OPERATOR_NATIVE_READINESS_FILE -or $Action -notin @('click','double_click','scroll','type','keypress','drag')) {return}
 if ($Window.available -and $Window.processName -and $Window.processName -ne 'Revit' -and $ExpectedRevitProcessId -le 0) {return}
 $file=$env:OPERATOR_NATIVE_READINESS_FILE
 [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null
 $stream=$null
 try {
  $stream=[IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
  $bytes=[Text.Encoding]::UTF8.GetBytes('{"schema":1,"fresh_native_readiness_required":true}')
  $stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)
 } catch [IO.IOException] {if($stream -or ![IO.File]::Exists($file)){throw}}
 finally {if($stream){$stream.Dispose()}}
}

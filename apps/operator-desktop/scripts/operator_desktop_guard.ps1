Set-StrictMode -Version Latest

function Test-OperatorDesktopControllerTitle {
  [CmdletBinding()]
  param(
    [AllowNull()]
    [string]$Title
  )

  if ([string]::IsNullOrWhiteSpace($Title)) {
    return $false
  }

  # Browser windows normally append their name after a separator. Requiring the
  # separator keeps unrelated titles such as "Operator Desktop Notes" eligible
  # targets while covering browser and wrapper suffixes.
  return $Title -match '^\s*(?:\(\d+\)\s+)?Operator Desktop(?:\s*[-\u2013\u2014|:]\s+.+)?\s*$'
}

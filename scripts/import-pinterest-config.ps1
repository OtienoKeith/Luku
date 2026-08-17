param(
  [Parameter(Mandatory = $true)]
  [string]$AppId,
  [Parameter(Mandatory = $true)]
  [string]$RedirectUri
)

$ErrorActionPreference = 'Stop'

$secret = (Get-Clipboard -Raw).Trim()
if ($secret.Length -lt 24 -or $secret -match '\s') {
  throw 'The clipboard does not contain a valid Pinterest app secret.'
}
if ($AppId -notmatch '^\d+$') { throw 'Pinterest App ID must contain only numbers.' }
if ($RedirectUri -notmatch '^https://') { throw 'Pinterest redirect URI must use HTTPS.' }

$envPath = Join-Path $PSScriptRoot '..\supabase\.env.local'
$values = [ordered]@{
  PINTEREST_APP_ID = $AppId
  PINTEREST_APP_SECRET = $secret
  PINTEREST_REDIRECT_URI = $RedirectUri
}
$lines = [System.Collections.Generic.List[string]]::new()
if (Test-Path -LiteralPath $envPath) {
  foreach ($line in @(Get-Content -LiteralPath $envPath)) { $lines.Add([string]$line) }
}

foreach ($entry in $values.GetEnumerator()) {
  $prefix = "$($entry.Key)="
  $replacement = "$prefix$($entry.Value)"
  $found = $false
  for ($index = 0; $index -lt $lines.Count; $index += 1) {
    if ($lines[$index].StartsWith($prefix, [System.StringComparison]::Ordinal)) {
      $lines[$index] = $replacement
      $found = $true
      break
    }
  }
  if (-not $found) { $lines.Add($replacement) }
}

Set-Content -LiteralPath $envPath -Value $lines
Set-Clipboard -Value ' '
Write-Output "Pinterest OAuth configuration stored locally (secret length: $($secret.Length))."

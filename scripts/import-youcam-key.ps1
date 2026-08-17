$ErrorActionPreference = 'Stop'
$ocrPath = Join-Path $env:TEMP 'luku-youcam-ocr.txt'
$lines = Get-Content -LiteralPath $ocrPath
$keyLineIndex = [array]::FindIndex([string[]]$lines, [Predicate[string]] { param($line) $line -match 'sk-' })
if ($keyLineIndex -lt 0) { throw 'No API key was found in the local OCR result.' }
$first = $lines[$keyLineIndex] -replace '\s', ''
$continuation = (($lines[$keyLineIndex + 1] -split '\s+' | Where-Object { $_ })[0])
# The screenshot's copy icon is rendered as two trailing letters by OCR; the visible key wraps after 65 characters.
if ($first.Length -gt 65) { $first = $first.Substring(0, 65) }
$key = "$first$continuation"
if ($key -notmatch '^sk-[A-Za-z0-9_-]{60,90}$') { throw 'The extracted API key did not match the expected format.' }
Set-Content -LiteralPath (Join-Path $PSScriptRoot '..\supabase\.env.local') -Value "YOUCAM_API_KEY=$key" -NoNewline
Remove-Item -LiteralPath $ocrPath -Force
Write-Output "Stored the ignored YouCam API key ($($key.Length) characters)."

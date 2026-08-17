$ErrorActionPreference = 'Stop'
$secretPath = Join-Path $PSScriptRoot '..\supabase\.env.local'
$line = Get-Content -Raw -LiteralPath $secretPath
$key = $line.Substring($line.IndexOf('=') + 1)
$body = @{ files = @(@{ content_type = 'image/jpg'; file_name = 'credential-check.jpg'; file_size = 1 }) } | ConvertTo-Json -Depth 4
$candidates = @($key)
# OCR cannot reliably distinguish O/0 and I/l in the supplied screenshot. Test only those three observed glyphs.
foreach ($position in @(29, 39, 46)) {
  $next = @()
  foreach ($candidate in $candidates) {
    foreach ($character in $(if ($position -eq 39) { @('I', 'l') } else { @('O', '0') })) {
      $chars = $candidate.ToCharArray(); $chars[$position] = $character
      $next += -join $chars
    }
  }
  $candidates = $next | Select-Object -Unique
}
foreach ($candidate in $candidates) {
  try {
    $response = Invoke-RestMethod -Uri 'https://yce-api-01.makeupar.com/s2s/v2.0/file/cloth-v3' -Headers @{ Authorization = "Bearer $candidate" } -Method Post -ContentType 'application/json' -Body $body
    Set-Content -LiteralPath $secretPath -Value "YOUCAM_API_KEY=$candidate" -NoNewline
    Write-Output "YouCam authentication accepted (status $($response.status))."
    exit 0
  } catch {
    if (-not $_.Exception.Response) { Write-Output 'YouCam authentication check could not reach the service.'; exit 1 }
  }
}
Write-Output 'YouCam rejected every OCR-safe character variant.'
exit 1

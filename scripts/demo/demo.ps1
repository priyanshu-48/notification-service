# Walks through the service one scene at a time for a screen recording. Each step prints the request it makes (method, path,
# body) and the real response, then waits for Enter so you can switch to the browser.
#
#   $env:API_KEY = "<tenant key from npm run provision:tenant>"
#   powershell -ExecutionPolicy Bypass -File scripts/demo/demo.ps1
#
# Optional: $env:BASE_URL (default http://localhost:3000), $env:DEMO_NOPAUSE=1 to run without waiting (used for testing).
$ErrorActionPreference = 'Stop'
$base = if ($env:BASE_URL) { $env:BASE_URL.TrimEnd('/') } else { 'http://localhost:3000' }
$key = $env:API_KEY
if (-not $key) { Write-Host 'Set $env:API_KEY first (the key printed by npm run provision:tenant).' -ForegroundColor Red; exit 1 }
$run = Get-Date -Format 'HHmmss'   # keeps Idempotency-Keys unique, so the script can be run again

function Wait-Enter($message) {
  if ($env:DEMO_NOPAUSE) { return }
  Write-Host ''; Read-Host "$message (press Enter)" | Out-Null
}

function Scene($title) {
  Write-Host ''; Write-Host ('=' * 70) -ForegroundColor DarkGray
  Write-Host $title -ForegroundColor Cyan
  Write-Host ('=' * 70) -ForegroundColor DarkGray
}

# Prints the request, sends it, prints the status and body. Returns @{ Status; Json }.
function Call($method, $path, $body = $null, $extra = @{}) {
  Write-Host ''
  Write-Host "$method $path" -ForegroundColor Yellow
  Write-Host '  Authorization: Bearer ntf_live_****' -ForegroundColor DarkGray
  foreach ($k in $extra.Keys) { Write-Host "  ${k}: $($extra[$k])" -ForegroundColor DarkGray }
  if ($body) { Write-Host (($body | ConvertFrom-Json | ConvertTo-Json -Depth 10 -Compress:$false)) -ForegroundColor Gray }
  $headers = @{ Authorization = "Bearer $key" } + $extra
  $req = @{ Method = $method; Uri = "$base$path"; Headers = $headers; UseBasicParsing = $true }
  # A POST with no body still needs a JSON content type, or the server rejects it (Windows PowerShell would send a form type).
  if ($body) { $req.Body = $body; $req.ContentType = 'application/json' } elseif ($method -eq 'POST') { $req.Body = '{}'; $req.ContentType = 'application/json' }
  try {
    $r = Invoke-WebRequest @req
    $status = [int]$r.StatusCode; $content = $r.Content
  } catch {
    $resp = $_.Exception.Response
    if (-not $resp) { throw }
    $status = [int]$resp.StatusCode
    $content = $_.ErrorDetails.Message
    if (-not $content) { $content = [IO.StreamReader]::new($resp.GetResponseStream()).ReadToEnd() }
  }
  $color = if ($status -lt 300) { 'Green' } else { 'Red' }
  Write-Host "-> $status" -ForegroundColor $color
  $json = $null
  if ($content) { try { $json = $content | ConvertFrom-Json; Write-Host ($json | ConvertTo-Json -Depth 10) } catch { Write-Host $content } }
  return @{ Status = $status; Json = $json }
}

try { $ready = Invoke-RestMethod "$base/ready" -TimeoutSec 5 } catch { Write-Host "The service is not answering at $base. Start it first (npm run dev with RUN_WORKER=true)." -ForegroundColor Red; exit 1 }
Write-Host "Service at $base is ready (postgres: $($ready.checks.postgres), redis: $($ready.checks.redis))." -ForegroundColor Green

Scene '1. Register a user, and give their browser a short-lived token'
Call 'PUT' '/v1/users/maya' '{"email":"maya@example.com"}' | Out-Null
$t = Call 'POST' '/v1/users/maya/stream-token'
$shown = $t.Json.token.Substring(0, 24)
Write-Host "Token copied to the clipboard ($shown...). Open $base/demo, paste it, press Enter in the page." -ForegroundColor Magenta
Set-Clipboard -Value $t.Json.token
Wait-Enter 'When the demo page says connected'

Scene '2. Send a notification (email and in-app)'
$send = '{"externalUserId":"maya","type":"order_shipped","payload":{"title":"Your order has shipped","message":"Arriving Thursday"},"channels":["email","in_app"]}'
$key1 = @{ 'Idempotency-Key' = "order-$run-shipped" }
$first = Call 'POST' '/v1/notifications' $send $key1
Write-Host "It should now be on the demo page. The dashboard shows the delivery attempts." -ForegroundColor Magenta
Wait-Enter 'When you have shown the page and the dashboard'

Scene '3. Safe to retry: the same Idempotency-Key returns the original'
$again = Call 'POST' '/v1/notifications' $send $key1
Write-Host "Same notification id: $($first.Json.id -eq $again.Json.id)" -ForegroundColor Green
Wait-Enter 'Next: the same key with a different message'

Scene '4. The same key with a different message is rejected'
$different = '{"externalUserId":"maya","type":"order_shipped","payload":{"title":"A different message"},"channels":["in_app"]}'
Call 'POST' '/v1/notifications' $different $key1 | Out-Null
Wait-Enter 'Next: the durable inbox'

Scene '5. Offline users do not lose anything'
Write-Host 'Close the /demo tab now. The next notification is sent while the user is offline.' -ForegroundColor Magenta
Wait-Enter 'When the demo tab is closed'
$offline = '{"externalUserId":"maya","type":"order_delivered","payload":{"title":"Your order was delivered"},"channels":["in_app"]}'
Call 'POST' '/v1/notifications' $offline @{ 'Idempotency-Key' = "order-$run-delivered" } | Out-Null
Start-Sleep -Seconds 2
Write-Host 'It is waiting in the inbox:' -ForegroundColor Magenta
Call 'GET' '/v1/users/maya/inbox' | Out-Null
Write-Host "Now reopen $base/demo: the backlog loads." -ForegroundColor Magenta
Wait-Enter 'When you have shown it'

Scene '6. Surviving a crash'
if ($env:DEMO_NOPAUSE) { Write-Host '(skipped in no-pause mode)'; exit 0 }
$answer = Read-Host 'Run the crash test now? It kills a worker mid-send and needs Docker (about 20 seconds) [y/N]'
if ($answer -eq 'y') { npx vitest run tests/chaos.integration.test.ts --reporter=verbose }

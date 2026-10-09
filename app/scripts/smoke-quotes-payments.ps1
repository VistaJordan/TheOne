# Smoke test — quote + payment lifecycle against the running API (:5174).
# Usage: pwsh scripts/smoke-quotes-payments.ps1   (API in dev-bypass auth mode)
#
# Signs in once per actor through POST /auth/dev-login and keeps a cookie jar
# per actor, so every call runs as a real session the way the browser does.
# Actors (seeded roles → 0015 permission tree):
#   Matt Hammond  senior_om  quotes:edit, payments:create  — WO-39403's dispatcher (0026 scope)
#   Zach Malden   tl         quotes:approve, payments:approve
#   Dana Reyes    ap         payments/process:edit (pay / change method / delete)
#   an 'om'       om         below every gate (the 403 paths)
#   Jordan Brown  admin      super admin — payments/process:delete (confirm / keep a delete)
$ErrorActionPreference = 'Stop'
$B = 'http://127.0.0.1:5174/api'
$WON = 'WO-39403'

$sessions = @{}
function Session($name) {
  if (-not $name) { return $null }
  if ($sessions.ContainsKey($name)) { return $sessions[$name] }
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $cands = (Invoke-RestMethod -Method GET -Uri "$B/auth/dev-candidates").items
  $who = $cands | Where-Object { $_.name -eq $name -or $_.role -eq $name } | Select-Object -First 1
  if (-not $who) { throw "No sign-in candidate matches '$name'" }
  Invoke-RestMethod -Method POST -Uri "$B/auth/dev-login" -WebSession $s -ContentType 'application/json' `
    -Body (@{ principal_id = $who.id } | ConvertTo-Json -Compress) | Out-Null
  $sessions[$name] = $s
  return $s
}

function Call($method, $path, $body, $actor) {
  $s = Session $actor
  $json = if ($null -ne $body) { $body | ConvertTo-Json -Depth 8 -Compress } else { $null }
  if ($env:SMOKE_DEBUG) { Write-Host "CALL $method $B$path actor=$actor body=$json" }
  try {
    $args = @{ Method = $method; Uri = "$B$path"; ContentType = 'application/json' }
    if ($s) { $args.WebSession = $s }
    if ($json) { $args.Body = $json }
    return Invoke-RestMethod @args
  } catch {
    $r = $_.Exception.Response
    if ($r) {
      # PS 5.1 surfaces a JSON error body on ErrorDetails; the stream is the fallback.
      $txt = $_.ErrorDetails.Message
      if (-not $txt) { $sr = New-Object IO.StreamReader($r.GetResponseStream()); $txt = $sr.ReadToEnd() }
      $parsed = $null
      if ($txt) { try { $parsed = $txt | ConvertFrom-Json } catch { $parsed = $txt } }
      return @{ __error = $true; status = [int]$r.StatusCode; body = $parsed }
    }
    throw
  }
}
function Expect($label, $cond) { if ($cond) { "PASS  $label" } else { "FAIL  $label" } }

$matt  = 'Matt Hammond'
$lead  = 'Zach Malden'
$ap    = 'Dana Reyes'
$om    = 'om'
$admin = 'Jordan Brown'

"== Auth =="
$r = Call GET "/work-orders/$WON"
Expect "no session -> 401" ($r.__error -and $r.status -eq 401)

"== WO status gating =="
$wo = Call GET "/work-orders/$WON" $null $matt
Expect "detail carries actions map" ($wo.actions.'quote.edit'.allowed -eq $true)

"== Quote lifecycle =="
$q = (Call GET "/work-orders/$WON/quote" $null $matt).quote
Expect "seed quote pending_approval r1" ($q.status -eq 'pending_approval' -and $q.current_round -eq 1)
Expect "Yoda grand total = (930+2890)*1.0825" ([math]::Abs($q.totals.grand_total - 4135.15) -lt 0.01)
Expect "quote carries nte_override_open" ($null -ne $q.nte_override_open)

$r = Call POST "/work-orders/$WON/quote/approve" @{} $matt
Expect "senior_om cannot approve (403 quotes:approve)" ($r.__error -and $r.status -eq 403)

$q = (Call POST "/work-orders/$WON/quote/approve" @{} $lead).quote
Expect "team lead approves" ($q.status -eq 'approved')
$q = (Call POST "/work-orders/$WON/quote/send" @{} $lead).quote
Expect "sent" ($q.status -eq 'sent')

$r = Call PUT "/work-orders/$WON/quote" @{ specs = 'x' } $matt
Expect "edit blocked once sent (400)" ($r.__error -and $r.status -eq 400)

$q = (Call POST "/work-orders/$WON/quote/cancel-submission" @{} $lead).quote
Expect "cancel-submission -> approved" ($q.status -eq 'approved')
$q = (Call POST "/work-orders/$WON/quote/send" @{} $lead).quote

$opt = ($q.sections | Where-Object kind -eq 'option' | Select-Object -First 1).id
$r = Call POST "/work-orders/$WON/quote/client-approve" @{ section_id = $opt } $om
Expect "om cannot record client approval outside Approval phase (403/404)" ($r.__error -and ($r.status -eq 403 -or $r.status -eq 404))

$q = (Call POST "/work-orders/$WON/quote/client-approve" @{ section_id = $opt; note = 'PO 4411'; on_site = $false } $lead).quote
Expect "client_approved" ($q.status -eq 'client_approved' -and $q.approved_section_id -eq $opt)
$approvedSec = $q.sections | Where-Object id -eq $opt
Expect "approved option locked + stamped" ($approvedSec.locked -eq $true -and $approvedSec.approved_at)

$wo = Call GET "/work-orders/$WON" $null $matt
Expect "money.quote bound to approved total" ([math]::Abs($wo.money.quote - 4135.15) -lt 0.01)

$q = (Call POST "/work-orders/$WON/quote/new-round" @{} $matt).quote
Expect "round 2 opened as draft, rev bumped" ($q.status -eq 'draft' -and $q.current_round -eq 2 -and $q.rev -eq 4)
Expect "round-1 option now prices as incurred (930+2890)" ([math]::Abs($q.totals.incurred_subtotal - 3820) -lt 0.01)

$r = Call PUT "/work-orders/$WON/quote" @{ sections = @(@{ kind = 'incurred'; lines = @() }) } $matt
Expect "incurred locked in round 2 (409)" ($r.__error -and $r.status -eq 409)

$body = @{ sections = @(@{ kind = 'option'; name = 'Compressor swap'; narrative_reported = 'Compressor failed on return visit.'; lines = @(
  @{ line_type = 'part'; description = 'Compressor'; qty = 1; rate = 1200; ot = $false; day = 2 },
  @{ line_type = 'discount'; description = 'Loyalty discount'; qty = 1; rate = 100; ot = $false }
) }) }
$q = (Call PUT "/work-orders/$WON/quote" $body $matt).quote
$optB = $q.sections | Where-Object { $_.kind -eq 'option' -and $_.round -eq 2 }
Expect "discount line is negative" (($optB.lines | Where-Object line_type -eq 'discount').amount -eq -100)
Expect "round-2 option total 1100" ($optB.subtotal -eq 1100)
Expect "summary groups by day" ($q.summary.auto -match 'Day 2')

$act = Call GET "/activity?wo=$WON&limit=60" $null $matt
$revised = @($act | Where-Object action -eq 'quote_updated')
Expect "quote_updated audit row carries before/after snapshots (rule 1.2.1)" ($revised.Count -ge 1 -and $null -ne $revised[0].before -and $null -ne $revised[0].after.grand_total)

"== Payments =="
$vendor = (Call GET '/vendors?q=Gulf' $null $matt).items | Select-Object -First 1
Expect "vendor search" ($null -ne $vendor)

$pay = @{ vendor_id = $vendor.id; purpose = 'Return trip'; amount = 150; method = 'ach';
  payment_address = @{ method = 'ach'; bank_name = 'Chase'; routing_number = '021000021'; account_number = '000123456789'; account_type = 'checking' } }
$p = (Call POST "/work-orders/$WON/payment-requests" $pay $matt).item
Expect "payment created requested" ($p.status -eq 'requested')
Expect "ACH masked for requester" ($p.payment_address.account_number -like '••••*')
Expect "needs_w9 (75+400+150 > 599)" ($p.needs_w9 -eq $true)

$r = Call POST "/work-orders/$WON/payment-requests" $pay $matt
Expect "duplicate purpose (409)" ($r.__error -and $r.status -eq 409)

$r = Call POST "/payment-requests/$($p.id)/pay" @{} $matt
Expect "senior_om cannot pay (403 payments/process:edit)" ($r.__error -and $r.status -eq 403)
$r = Call POST "/payment-requests/$($p.id)/approve" @{} $ap
Expect "AP cannot approve (403 payments:approve)" ($r.__error -and $r.status -eq 403)

$full = (Call GET "/payment-requests/$($p.id)" $null $ap).item
Expect "AP sees full ACH account" ($full.payment_address.account_number -eq '000123456789')

$queue = Call GET '/payments?status=requested' $null $ap
Expect "queue lists the request with WO columns" (($queue.items | Where-Object id -eq $p.id).wo_number -eq $WON -and $null -ne $queue.counts)

$before = (Call GET "/work-orders/$WON" $null $matt).money.cost
$p = (Call POST "/payment-requests/$($p.id)/pay" @{} $ap).item
Expect "paid by AP straight from requested (Yoda Verify)" ($p.status -eq 'paid' -and $p.paid_by.display_name -eq $ap -and $p.approved_by.display_name -eq $ap)
$after = (Call GET "/work-orders/$WON" $null $matt).money.cost
Expect "cost rolled up by 150" ([math]::Abs(($after - $before) - 150) -lt 0.01)

$d = Call POST "/payment-requests/$($p.id)/delete" @{ reason = 'Duplicate' } $ap
Expect "AP delete on paid -> pending_delete" ($d.deleted -eq $false -and $d.item.pending_delete -eq $true)
$queue = Call GET '/payments?pending_delete=true' $null $ap
Expect "queue shows pending delete" ($queue.pending_delete_count -ge 1)
$r = Call POST "/payment-requests/$($p.id)/reject-delete" @{} $ap
Expect "ap cannot reject-delete (admin only, 403)" ($r.__error -and $r.status -eq 403)
$p = (Call POST "/payment-requests/$($p.id)/reject-delete" @{} $admin).item
Expect "admin reject-delete clears flag" ($p.pending_delete -eq $false)

# Seed: 75 + 400 (paid) + 120 (approved) + 350 (requested) + this run's 150 — all non-credit, none rejected.
$ytd = Call GET "/vendors/$($vendor.id)/ytd" $null $ap
Expect "YTD total 1095" ([math]::Abs($ytd.total - 1095) -lt 0.01)

"== Status gate on payments =="
$statuses = Call GET '/statuses' $null $admin
$inv = ($statuses | Where-Object name -eq 'Invoiced').id
$qr  = ($statuses | Where-Object name -eq 'Quote Ready').id
Call PATCH "/work-orders/$WON/status" @{ status_id = $inv } $admin | Out-Null
$r = Call POST "/work-orders/$WON/payment-requests" @{ vendor_id = $vendor.id; purpose = 'Late'; amount = 10; method = 'zelle' } $matt
Expect "payment request blocked on invoiced (403 WO_STATUS_BLOCKED)" ($r.__error -and $r.status -eq 403 -and $r.body.error.details.code -eq 'WO_STATUS_BLOCKED')
Call PATCH "/work-orders/$WON/status" @{ status_id = $qr } $admin | Out-Null

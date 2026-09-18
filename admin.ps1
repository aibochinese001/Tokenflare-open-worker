# admin.ps1 - manage the llm-gateway Cloudflare Worker via ADMIN_TOKEN (no SSO)
# Reads the admin token from .admin-token.txt next to this script.
#
# Usage examples:
#   .\admin.ps1 healthz
#   .\admin.ps1 keys list
#   .\admin.ps1 keys import .\keys.txt          # file with "provider:key" lines
#   .\admin.ps1 keys check-all
#   .\admin.ps1 keys check 1
#   .\admin.ps1 keys enable 1
#   .\admin.ps1 keys disable 1
#   .\admin.ps1 keys delete 1
#   .\admin.ps1 keys reveal 1
#   .\admin.ps1 keys prune
#   .\admin.ps1 tokens list
#   .\admin.ps1 tokens create -name myapp -role user -quota 1000 -rpm 60 -days 30
#   .\admin.ps1 tokens delete 1
#   .\admin.ps1 users list
#   .\admin.ps1 users approve 1
#   .\admin.ps1 users block 1
#   .\admin.ps1 usage
#   .\admin.ps1 logs
#   .\admin.ps1 probe
#   .\admin.ps1 probe-models
#   .\admin.ps1 models-status
#   .\admin.ps1 balances
#   .\admin.ps1 prices
#   .\admin.ps1 sweep

param(
  [Parameter(Position = 0)][string]$Command = "",
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = "Stop"
$BASE = "https://REPLACE_WITH_YOUR_WORKER_URL"
$TokenFile = Join-Path $PSScriptRoot ".admin-token.txt"

function Get-AdminToken {
  if (-not (Test-Path $TokenFile)) {
    throw "ADMIN_TOKEN file not found: $TokenFile"
  }
  return ([IO.File]::ReadAllText($TokenFile)).Trim()
}

$Headers = @{ Authorization = "Bearer $(Get-AdminToken)" }

function Invoke-Admin {
  param([string]$Method, [string]$Path, $Body = $null)
  $params = @{
    Uri       = "$BASE$Path"
    Method    = $Method
    Headers   = $Headers
    TimeoutSec = 90
  }
  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Compress -Depth 6)
  }
  $r = Invoke-RestMethod @params
  return $r
}

function Show-Json($obj) {
  if ($null -eq $obj -or @($obj).Count -eq 0) { return "[]" }
  ConvertTo-Json -InputObject $obj -Depth 8
}

function Usage {
  Get-Content $PSCommandPath | Select-String -Pattern '^\s*#\s' | ForEach-Object { $_.Line.TrimStart('# ') }
  exit 0
}

if ($Command -eq "" -or $Command -eq "-h" -or $Command -eq "help") { Usage }

switch ($Command) {
  "healthz" {
    (Invoke-WebRequest -Uri "$BASE/healthz" -UseBasicParsing -TimeoutSec 30).Content
  }
  "keys" {
    $sub = if ($Rest.Count -gt 0) { $Rest[0] } else { "" }
    switch ($sub) {
      "list"  { Show-Json (Invoke-Admin GET "/admin/keys/list") }
      "check-all" { Show-Json (Invoke-Admin POST "/admin/check-all-keys") }
      "sweep" { Show-Json (Invoke-Admin POST "/admin/sweep") }
      "prune" { Show-Json (Invoke-Admin POST "/admin/keys/prune") }
      "check"   { if ($Rest.Count -lt 2) { throw "usage: keys check <id>" }; Show-Json (Invoke-Admin POST "/admin/keys/$($Rest[1])/check") }
      "enable"  { if ($Rest.Count -lt 2) { throw "usage: keys enable <id>" }; Show-Json (Invoke-Admin POST "/admin/keys/$($Rest[1])/enable") }
      "disable" { if ($Rest.Count -lt 2) { throw "usage: keys disable <id>" }; Show-Json (Invoke-Admin POST "/admin/keys/$($Rest[1])/disable") }
      "delete"  { if ($Rest.Count -lt 2) { throw "usage: keys delete <id>" }; Show-Json (Invoke-Admin DELETE "/admin/keys/$($Rest[1])") }
      "reveal"  { if ($Rest.Count -lt 2) { throw "usage: keys reveal <id>" }; Show-Json (Invoke-Admin GET "/admin/keys/$($Rest[1])/reveal") }
      "import" {
        if ($Rest.Count -lt 2) { throw "usage: keys import <file with provider:key lines>" }
        $file = $Rest[1]
        if (-not (Test-Path $file)) { throw "file not found: $file" }
        $text = [IO.File]::ReadAllText((Resolve-Path $file))
        $body = @{ keys = $text.Trim() }
        Show-Json (Invoke-Admin POST "/admin/keys/import" $body)
      }
      default { throw "unknown keys subcommand: '$sub' (see help)" }
    }
  }
  "tokens" {
    $sub = if ($Rest.Count -gt 0) { $Rest[0] } else { "" }
    switch ($sub) {
      "list"   { Show-Json (Invoke-Admin GET "/admin/tokens") }
      "create" {
        $name = $null; $role = "user"; $quota = $null; $rpm = $null; $days = $null
        for ($i = 1; $i -lt $Rest.Count; $i++) {
          switch ($Rest[$i]) {
            "-name"  { $i++; $name = $Rest[$i] }
            "-role"  { $i++; $role = $Rest[$i] }
            "-quota" { $i++; $quota = [int]$Rest[$i] }
            "-rpm"   { $i++; $rpm = [int]$Rest[$i] }
            "-days"  { $i++; $days = [int]$Rest[$i] }
            default  { throw "unknown option: $($Rest[$i])" }
          }
        }
        $body = @{ role = $role }
        if ($name)  { $body.name = $name }
        if ($quota) { $body.quota_requests = $quota }
        if ($rpm)   { $body.rpm_limit = $rpm }
        if ($days)  { $body.expires_in_days = $days }
        Show-Json (Invoke-Admin POST "/admin/tokens" $body)
      }
      "delete" { if ($Rest.Count -lt 2) { throw "usage: tokens delete <id>" }; Show-Json (Invoke-Admin DELETE "/admin/tokens/$($Rest[1])") }
      default  { throw "unknown tokens subcommand: '$sub' (see help)" }
    }
  }
  "users" {
    $sub = if ($Rest.Count -gt 0) { $Rest[0] } else { "" }
    switch ($sub) {
      "list"    { Show-Json (Invoke-Admin GET "/admin/users") }
      "approve" { if ($Rest.Count -lt 2) { throw "usage: users approve <id>" }; Show-Json (Invoke-Admin POST "/admin/users/$($Rest[1])/approve") }
      "block"   { if ($Rest.Count -lt 2) { throw "usage: users block <id>" }; Show-Json (Invoke-Admin POST "/admin/users/$($Rest[1])/block") }
      default   { throw "unknown users subcommand: '$sub' (see help)" }
    }
  }
  "usage" {
    $path = "/admin/usage"
    if ($Rest.Count -gt 0 -and $Rest[0] -eq "-owner") { $path += "?owner=$($Rest[1])" }
    Show-Json (Invoke-Admin GET $path)
  }
  "logs" {
    $path = "/admin/logs"
    if ($Rest.Count -gt 0) { $path += "?owner=$($Rest[0])" }
    Show-Json (Invoke-Admin GET $path)
  }
  "probe"        { Show-Json (Invoke-Admin POST "/admin/probe") }
  "probe-models" { Show-Json (Invoke-Admin POST "/admin/probe-models") }
  "models-status"{ Show-Json (Invoke-Admin GET "/admin/models-status") }
  "balances"     { Show-Json (Invoke-Admin GET "/admin/balances") }
  "prices"       { Show-Json (Invoke-Admin GET "/admin/prices") }
  default        { throw "unknown command: '$Command' (run without args for help)" }
}

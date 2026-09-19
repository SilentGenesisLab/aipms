// The Windows counterpart of /cli. Served as plain text so the installer can
// fetch it and write it next to the config; it mirrors the bash CLI command for
// command. Keep the body free of backticks and of PowerShell ${...} syntax: it
// lives in a String.raw template, so a backslash stays literal but ${...} would
// be interpolated by this file rather than by PowerShell.
function cliScript(baseUrl: string) {
  return String.raw`#Requires -Version 5.1
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArgs)

$ErrorActionPreference = "Stop"
$DefaultBaseUrl = "${baseUrl}"
$QuoteChar = [char]34

function Get-AipmsConfigFile {
  if ($env:AIPMS_CONFIG) { return $env:AIPMS_CONFIG }
  $local = Join-Path (Get-Location).Path ".aipms/config"
  if (Test-Path -LiteralPath $local) { return $local }
  $base = if ($env:AIPMS_HOME) { $env:AIPMS_HOME } else { Join-Path $HOME ".aipms" }
  return (Join-Path $base "config")
}

$ConfigFile = Get-AipmsConfigFile
$BaseUrl = $DefaultBaseUrl
$ApiKey = ""

function Protect-AipmsConfig {
  try {
    if ($env:OS -eq "Windows_NT") {
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $acl = Get-Acl -LiteralPath $ConfigFile
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", "Allow")
      $acl.SetAccessRule($rule)
      Set-Acl -LiteralPath $ConfigFile -AclObject $acl
    } else {
      & chmod 600 $ConfigFile 2>$null
    }
  } catch { }
}

function Read-AipmsConfig {
  $script:BaseUrl = $DefaultBaseUrl
  $script:ApiKey = ""
  if (Test-Path -LiteralPath $ConfigFile) {
    foreach ($line in (Get-Content -LiteralPath $ConfigFile)) {
      if ($line -match '^\s*BASE_URL\s*=\s*(.+)$') { $script:BaseUrl = $Matches[1].Trim().Trim($QuoteChar) }
      elseif ($line -match '^\s*API_KEY\s*=\s*(.+)$') { $script:ApiKey = $Matches[1].Trim().Trim($QuoteChar) }
    }
  }
  # Environment variables win over the saved file, so exporting AIPMS_API_KEY
  # works in a directory that already has a config instead of being ignored.
  if ($env:AIPMS_API_KEY) { $script:ApiKey = $env:AIPMS_API_KEY.Trim() }
  if ($env:AIPMS_BASE_URL) { $script:BaseUrl = $env:AIPMS_BASE_URL.Trim().TrimEnd("/") }
}

function Save-AipmsConfig([string]$Base, [string]$Key) {
  $dir = Split-Path -Parent $ConfigFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $text = "BASE_URL=" + $Base + [Environment]::NewLine + "API_KEY=" + $Key + [Environment]::NewLine
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($ConfigFile, $text, $utf8)
  Protect-AipmsConfig
}

function Write-AipmsError([string]$Message) {
  Write-Host $Message -ForegroundColor Red
}

function Invoke-AipmsRequest {
  param([string]$Method, [string]$Path, [string]$Body = "", [string]$IdempotencyKey = "")
  if (-not $script:ApiKey) {
    Write-AipmsError "Not authenticated. Run: aipms auth login --api-key <key>"
    exit 2
  }
  $headers = @{ Authorization = "Bearer " + $script:ApiKey; Accept = "application/json" }
  if ($IdempotencyKey) { $headers["Idempotency-Key"] = $IdempotencyKey }
  $uri = $script:BaseUrl + $Path
  try {
    if ($Body) {
      $response = Invoke-WebRequest -Method $Method -Uri $uri -Headers $headers -ContentType "application/json" -Body $Body -UseBasicParsing
    } else {
      $response = Invoke-WebRequest -Method $Method -Uri $uri -Headers $headers -UseBasicParsing
    }
    Write-Output $response.Content
  } catch {
    $code = 0
    $detail = ""
    if ($_.Exception.Response) {
      try { $code = [int]$_.Exception.Response.StatusCode } catch { }
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $detail = $reader.ReadToEnd()
        $reader.Dispose()
      } catch { }
    }
    if ($detail) { Write-Output $detail }
    Write-AipmsError ("Request failed: HTTP " + $code)
    exit 1
  }
}

function Get-AipmsStatus([string]$Path) {
  $headers = @{ Authorization = "Bearer " + $script:ApiKey; Accept = "application/json" }
  try {
    $response = Invoke-WebRequest -Method GET -Uri ($script:BaseUrl + $Path) -Headers $headers -UseBasicParsing
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) {
      try { return [int]$_.Exception.Response.StatusCode } catch { return 0 }
    }
    return 0
  }
}

function Get-ResourcePath([string]$Resource, [string]$ProjectId) {
  if ($Resource -eq "projects") { return "/api/v1/projects" }
  if ($Resource -in @("requirements", "tasks", "bugs", "versions", "releases", "members", "milestones")) {
    if (-not $ProjectId) { Write-AipmsError "project id is required"; exit 2 }
    return "/api/v1/projects/" + $ProjectId + "/" + $Resource
  }
  if ($Resource -in @("files", "folders", "teams", "notifications", "audit-logs")) { return "/api/v1/" + $Resource }
  Write-AipmsError ("unsupported resource: " + $Resource)
  exit 2
}

function New-IdempotencyKey {
  return "aipms-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + "-" + (Get-Random -Minimum 1000 -Maximum 99999)
}

function Show-AipmsHelp {
  Write-Output "AI PMS CLI (Windows PowerShell)"
  Write-Output "  aipms auth login [--api-key <key>] [--base-url URL]"
  Write-Output "  aipms doctor [--json] | context"
  Write-Output "  aipms context [--project <id|code>] [--status A,B] [--fields f1,f2] [--limit N]"
  Write-Output "  aipms list projects"
  Write-Output "  aipms list tasks <project-id>"
  Write-Output "  aipms get tasks <project-id> <task-id>"
  Write-Output "  aipms create tasks <project-id> '{""title"":""..."",""acceptanceCriteria"":""..."",""priority"":""HIGH""}'"
  Write-Output "  aipms update tasks <project-id> <task-id> '{""status"":""IN_PROGRESS""}'"
  Write-Output "  aipms delete tasks <project-id> <task-id>"
  Write-Output "  aipms task-context <task-id>"
  Write-Output "  aipms task-report <task-id> '{""summary"":""..."",""completedItems"":[""...""],""verification"":""...""}'"
  Write-Output "  aipms task-accept <task-id> '{""decision"":""PASS"",""conclusion"":""..."",""verificationEvidence"":""...""}'"
  Write-Output "  aipms raw GET /api/v1/..."
  Write-Output ""
  Write-Output "Resources: projects, requirements, tasks, bugs, versions, releases,"
  Write-Output "members, milestones, files, folders, teams, notifications, audit-logs."
  Write-Output ("Guide: " + $DefaultBaseUrl + "/cli/guide")
}

Read-AipmsConfig

$Command = if ($CliArgs -and $CliArgs.Count -gt 0) { $CliArgs[0] } else { "help" }
# Typed as [string[]] on purpose: assigning the result of an if-expression
# would unwrap a one-element array to a bare string, making $Rest[0] the first
# character of the argument rather than the argument itself.
[string[]]$Rest = @()
if ($CliArgs -and $CliArgs.Count -gt 1) { $Rest = $CliArgs[1..($CliArgs.Count - 1)] }

switch ($Command) {
  "auth" {
    $sub = if ($Rest.Count -gt 0) { $Rest[0] } else { "" }
    switch ($sub) {
      "login" {
        $base = $DefaultBaseUrl
        $key = ""
        $i = 1
        while ($i -lt $Rest.Count) {
          if ($Rest[$i] -eq "--api-key" -and ($i + 1) -lt $Rest.Count) { $key = $Rest[$i + 1]; $i += 2 }
          elseif ($Rest[$i] -eq "--base-url" -and ($i + 1) -lt $Rest.Count) { $base = $Rest[$i + 1].TrimEnd("/"); $i += 2 }
          else { $i++ }
        }
        if (-not $key) {
          try { Start-Process $base | Out-Null } catch { Write-Output ("Open this URL in your browser: " + $base) }
          $secure = Read-Host "Paste the API Key shown by the website (input hidden)" -AsSecureString
          $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        }
        $key = $key.Trim()
        if (-not $key) { Write-AipmsError "API Key is required"; exit 2 }
        Save-AipmsConfig $base $key
        $script:BaseUrl = $base
        $script:ApiKey = $key
        Invoke-AipmsRequest -Method GET -Path "/api/v1/me" | Out-Null
        Write-Output ("Authenticated with " + $base)
      }
      "logout" {
        if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
        Write-Output "Local credentials removed"
      }
      "status" { Invoke-AipmsRequest -Method GET -Path "/api/v1/me" }
      default {
        Write-AipmsError "Usage: aipms auth login [--api-key <key>] [--base-url URL] | logout | status"
        exit 2
      }
    }
  }
  "doctor" {
    $asJson = ($Rest.Count -gt 0 -and $Rest[0] -eq "--json")
    if (-not $script:ApiKey) {
      Write-AipmsError "Not authenticated. Run: aipms auth login --api-key <key>"
      exit 2
    }
    $checks = [ordered]@{
      "identity"      = "/api/v1/me"
      "work-context"  = "/api/v1/me/work-context"
      "projects"      = "/api/v1/projects"
      "teams"         = "/api/v1/teams"
      "notifications" = "/api/v1/notifications"
      "audit-logs"    = "/api/v1/audit-logs"
    }
    $failed = $false
    $report = [ordered]@{}
    foreach ($label in $checks.Keys) {
      $code = Get-AipmsStatus $checks[$label]
      $report[$label] = $code
      if ($code -eq 0) { $failed = $true }
      if ($label -eq "identity" -and ([math]::Floor($code / 100) -ne 2)) { $failed = $true }
      if (-not $asJson) { Write-Output ($label + ": HTTP " + $code) }
    }
    if ($asJson) {
      $payload = [ordered]@{ baseUrl = $BaseUrl; checks = $report }
      Write-Output ($payload | ConvertTo-Json -Compress -Depth 5)
    }
    if ($failed) { exit 1 }
  }
  "context" {
    $query = ""
    $i = 0
    while ($i -lt $Rest.Count) {
      if ($Rest[$i] -in @("--project", "--status", "--fields", "--limit")) {
        if (($i + 1) -ge $Rest.Count) { Write-AipmsError ($Rest[$i] + " needs a value"); exit 2 }
        $query = $query + "&" + $Rest[$i].Substring(2) + "=" + $Rest[$i + 1]
        $i += 2
      } else { $i++ }
    }
    $path = "/api/v1/me/work-context"
    if ($query) { $path = $path + "?" + $query.Substring(1) }
    Invoke-AipmsRequest -Method GET -Path $path
  }
  "list" {
    if ($Rest.Count -lt 1) { Write-AipmsError "resource required"; exit 2 }
    $project = if ($Rest.Count -gt 1) { $Rest[1] } else { "" }
    Invoke-AipmsRequest -Method GET -Path (Get-ResourcePath $Rest[0] $project)
  }
  "get" {
    if ($Rest.Count -lt 1) { Write-AipmsError "resource required"; exit 2 }
    $project = if ($Rest.Count -gt 1) { $Rest[1] } else { "" }
    $id = if ($Rest.Count -gt 2) { $Rest[2] } else { "" }
    $path = Get-ResourcePath $Rest[0] $project
    if ($id) { $path = $path + "/" + $id }
    Invoke-AipmsRequest -Method GET -Path $path
  }
  "create" {
    if ($Rest.Count -lt 3) { Write-AipmsError "usage: aipms create <resource> <project-id> '<json>'"; exit 2 }
    Invoke-AipmsRequest -Method POST -Path (Get-ResourcePath $Rest[0] $Rest[1]) -Body $Rest[2] -IdempotencyKey (New-IdempotencyKey)
  }
  "update" {
    if ($Rest.Count -lt 4) { Write-AipmsError "usage: aipms update <resource> <project-id> <id> '<json>'"; exit 2 }
    Invoke-AipmsRequest -Method PATCH -Path ((Get-ResourcePath $Rest[0] $Rest[1]) + "/" + $Rest[2]) -Body $Rest[3] -IdempotencyKey (New-IdempotencyKey)
  }
  "delete" {
    if ($Rest.Count -lt 3) { Write-AipmsError "usage: aipms delete <resource> <project-id> <id>"; exit 2 }
    Invoke-AipmsRequest -Method DELETE -Path ((Get-ResourcePath $Rest[0] $Rest[1]) + "/" + $Rest[2]) -IdempotencyKey (New-IdempotencyKey)
  }
  "task-context" {
    if ($Rest.Count -lt 1) { Write-AipmsError "task id required"; exit 2 }
    Invoke-AipmsRequest -Method GET -Path ("/api/v1/tasks/" + $Rest[0] + "/context")
  }
  "task-report" {
    if ($Rest.Count -lt 2) { Write-AipmsError "task id and JSON body required"; exit 2 }
    Invoke-AipmsRequest -Method POST -Path ("/api/v1/tasks/" + $Rest[0] + "/reports") -Body $Rest[1] -IdempotencyKey (New-IdempotencyKey)
  }
  "task-accept" {
    if ($Rest.Count -lt 2) { Write-AipmsError "task id and JSON body required"; exit 2 }
    Invoke-AipmsRequest -Method POST -Path ("/api/v1/tasks/" + $Rest[0] + "/acceptances") -Body $Rest[1] -IdempotencyKey (New-IdempotencyKey)
  }
  "raw" {
    if ($Rest.Count -lt 2) { Write-AipmsError "usage: aipms raw <METHOD> <path> ['<json>']"; exit 2 }
    $body = if ($Rest.Count -gt 2) { $Rest[2] } else { "" }
    Invoke-AipmsRequest -Method $Rest[0] -Path $Rest[1] -Body $body -IdempotencyKey (New-IdempotencyKey)
  }
  "help" { Show-AipmsHelp }
  "--help" { Show-AipmsHelp }
  "-h" { Show-AipmsHelp }
  default {
    Write-AipmsError ("Unknown command: " + $Command + ". Run aipms help.")
    exit 2
  }
}
`;
}

export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  return new Response(cliScript(origin), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

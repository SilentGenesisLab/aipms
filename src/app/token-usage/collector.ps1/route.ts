import { NextResponse } from "next/server";

const script = String.raw`param([switch]$Quiet)
$ErrorActionPreference = "Stop"
$collectorVersion = "0.3.0"
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
try {
  try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { Add-Type -AssemblyName System.Security -ErrorAction Stop }
  $null = [Security.Cryptography.ProtectedData]
  $null = [Security.Cryptography.DataProtectionScope]
} catch { exit 1 }
$installDir = Join-Path $env:USERPROFILE ".chorify-usage"
$configPath = Join-Path $installDir "config.json"
$logPath = Join-Path $installDir "collector.log"
$config = Get-Content -Raw $configPath | ConvertFrom-Json
$encrypted = [Convert]::FromBase64String([string]$config.encryptedSecret)
$secretBytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
$deviceSecret = [Text.Encoding]::UTF8.GetString($secretBytes)
$headers = @{ Authorization = "Bearer $deviceSecret" }
$statePath = if ($config.statePath) { [string]$config.statePath } else { Join-Path $installDir "state.json" }
$fileState = @{}
$activityBackfill = $true
if (Test-Path $statePath) {
  try {
    $savedState = Get-Content -Raw $statePath | ConvertFrom-Json
    if ($savedState.files) { $savedState.files.PSObject.Properties | ForEach-Object { $fileState[$_.Name] = [int]$_.Value } }
    if ([int]$savedState.activityVersion -ge 2) { $activityBackfill = $false }
  } catch { }
}
$events = [Collections.Generic.List[object]]::new()
$nextLines = @{}
$scannedFiles = 0
$parsedRecords = 0
$acceptedRecords = 0
$duplicateRecords = 0

function Hash-Text([string]$value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace("-","").ToLowerInvariant() } finally { $sha.Dispose() }
}
function Number-Or-Zero($value) {
  try {
    if ($null -eq $value) { return [long]0 }
    $candidate = $value
    if ($value -is [Collections.IEnumerable] -and $value -isnot [string]) {
      $items = @($value)
      if ($items.Count -eq 0) { return [long]0 }
      $candidate = $items[$items.Count - 1]
    }
    $number = [long]0
    if (-not [long]::TryParse([string]$candidate,[ref]$number)) { return [long]0 }
    return [Math]::Max([long]0,$number)
  } catch { return [long]0 }
}
function Add-Usage($hash,$date,$tool,$model,$input,$output,$cache,$reasoning,$sessions,$activeSeconds) {
  $events.Add(@{eventHash=$hash;date=$date;tool=$tool;model=if($model){[string]$model}else{"unknown"};inputTokens=Number-Or-Zero $input;outputTokens=Number-Or-Zero $output;cacheTokens=Number-Or-Zero $cache;reasoningTokens=Number-Or-Zero $reasoning;sessions=$sessions;activeSeconds=Number-Or-Zero $activeSeconds;estimatedCost=$null})
}
function Scan-File([IO.FileInfo]$file,[string]$tool) {
  $script:scannedFiles++
  $path = $file.FullName
  $skip = if (-not $activityBackfill -and $fileState.ContainsKey($path)) { [int]$fileState[$path] } else { 0 }
  $lines = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)
  if ($skip -gt $lines.Count) { $skip = 0 }
  $sessionDays = @{}
  $previousUsageTimestamp = $null
  for ($index=0; $index -lt $lines.Count; $index++) {
    try {
      $row = $lines[$index] | ConvertFrom-Json -ErrorAction Stop
      $currentTimestamp = $null
      if ($row.timestamp) { try { $currentTimestamp = [DateTimeOffset]::Parse([string]$row.timestamp) } catch { } }
      if ($index -lt $skip) { continue }
      if ($tool -eq "CODEX" -and $row.type -eq "event_msg" -and $row.payload.type -eq "token_count" -and $row.payload.info.last_token_usage) {
        $u = $row.payload.info.last_token_usage
        $date = ([DateTimeOffset]::Parse([string]$row.timestamp)).ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd")
        if (-not $sessionDays.ContainsKey($date)) { Add-Usage (Hash-Text "session|$tool|$path|$date") $date $tool "session" 0 0 0 0 1 0; $sessionDays[$date] = $true }
        $hash = Hash-Text "codex|$path|$($row.ordinal)|$($row.timestamp)|$($u.total_tokens)"
        $activeSeconds = 0;if ($previousUsageTimestamp -and $currentTimestamp) { $gap=[Math]::Floor(($currentTimestamp-$previousUsageTimestamp).TotalSeconds);if($gap -gt 0 -and $gap -le 900){$activeSeconds=$gap} };if($currentTimestamp){$previousUsageTimestamp=$currentTimestamp}
        Add-Usage $hash $date "CODEX" "codex" $u.input_tokens $u.output_tokens ((Number-Or-Zero $u.cached_input_tokens)+(Number-Or-Zero $u.cache_write_input_tokens)) $u.reasoning_output_tokens 0 0
        if($activeSeconds -gt 0){Add-Usage (Hash-Text "activity-v2|CODEX|$path|$($row.timestamp)") $date "CODEX" "activity" 0 0 0 0 0 $activeSeconds}
        $script:parsedRecords++
      }
      if ($tool -eq "CLAUDE" -and $row.type -eq "assistant" -and $row.message.usage) {
        $u = $row.message.usage
        $date = ([DateTimeOffset]::Parse([string]$row.timestamp)).ToOffset([TimeSpan]::FromHours(8)).ToString("yyyy-MM-dd")
        if (-not $sessionDays.ContainsKey($date)) { Add-Usage (Hash-Text "session|$tool|$path|$date") $date $tool "session" 0 0 0 0 1 0; $sessionDays[$date] = $true }
        $hash = Hash-Text "claude|$($row.uuid)|$($row.message.id)"
        $activeSeconds = 0;if ($previousUsageTimestamp -and $currentTimestamp) { $gap=[Math]::Floor(($currentTimestamp-$previousUsageTimestamp).TotalSeconds);if($gap -gt 0 -and $gap -le 900){$activeSeconds=$gap} };if($currentTimestamp){$previousUsageTimestamp=$currentTimestamp}
        Add-Usage $hash $date "CLAUDE" $row.message.model $u.input_tokens $u.output_tokens ((Number-Or-Zero $u.cache_creation_input_tokens)+(Number-Or-Zero $u.cache_read_input_tokens)) 0 0 0
        if($activeSeconds -gt 0){Add-Usage (Hash-Text "activity-v2|CLAUDE|$path|$($row.timestamp)") $date "CLAUDE" "activity" 0 0 0 0 0 $activeSeconds}
        $script:parsedRecords++
      }
    } catch { }
  }
  $nextLines[$path] = $lines.Count
}

try {
  $codexRoot = Join-Path $env:USERPROFILE ".codex\sessions"
  $claudeRoot = Join-Path $env:USERPROFILE ".claude\projects"
  $codexFiles = @(if (Test-Path $codexRoot) { Get-ChildItem -LiteralPath $codexRoot -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue })
  $claudeFiles = @(if (Test-Path $claudeRoot) { Get-ChildItem -LiteralPath $claudeRoot -Recurse -File -Filter *.jsonl -ErrorAction SilentlyContinue })
  if (-not $Quiet) { Write-Host "正在扫描本地日志：Codex $($codexFiles.Count) 个文件，Claude Code $($claudeFiles.Count) 个文件..." }
  $codexFiles | ForEach-Object { Scan-File $_ "CODEX" }
  $claudeFiles | ForEach-Object { Scan-File $_ "CLAUDE" }
  for ($offset=0; $offset -lt $events.Count; $offset+=400) {
    $count = [Math]::Min(400,$events.Count-$offset)
    $chunk = $events.GetRange($offset,$count)
    $body = @{ events=$chunk; clientVersion=$collectorVersion } | ConvertTo-Json -Depth 6
    $result = Invoke-RestMethod -Method Post -Uri "$($config.baseUrl)/api/v1/token-usage/batches" -Headers $headers -ContentType "application/json" -Body $body
    $acceptedRecords += [int]$result.accepted
    $duplicateRecords += [int]$result.duplicates
  }
  foreach($key in $nextLines.Keys) { $fileState[$key] = $nextLines[$key] }
  @{ files=$fileState;activityVersion=2 } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $statePath
  $heartbeat = @{clientVersion=$collectorVersion;status="HEALTHY";error=$null}|ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$($config.baseUrl)/api/v1/usage-collectors/heartbeat" -Headers $headers -ContentType "application/json" -Body $heartbeat | Out-Null
  $stopwatch.Stop()
  if (-not $Quiet) {
    $activeTotal = [long]0
    $sessionTotal = [long]0
    foreach($event in $events) { $activeTotal += Number-Or-Zero $event.activeSeconds; $sessionTotal += Number-Or-Zero $event.sessions }
    Write-Host "扫描完成，用时 $([Math]::Round($stopwatch.Elapsed.TotalSeconds,1)) 秒。"
    Write-Host "已扫描 $scannedFiles 个文件，解析 $parsedRecords 条用量记录；新增 $acceptedRecords 条，重复 $duplicateRecords 条。"
    Write-Host "识别会话 $sessionTotal 个，AI Worker 活跃时间 $([Math]::Round($activeTotal/60,1)) 分钟。"
  }
  exit 0
} catch {
  $message = $_.Exception.Message
  $position = $_.InvocationInfo.PositionMessage
  try { ("[$(Get-Date -Format o)] $message" + [Environment]::NewLine + $position) | Set-Content -Encoding UTF8 $logPath } catch { }
  try { $heartbeat=@{clientVersion=$collectorVersion;status="ERROR";error=$message.Substring(0,[Math]::Min(500,$message.Length))}|ConvertTo-Json;Invoke-RestMethod -Method Post -Uri "$($config.baseUrl)/api/v1/usage-collectors/heartbeat" -Headers $headers -ContentType "application/json" -Body $heartbeat|Out-Null } catch { }
  exit 1
}
`;

export async function GET() {
  return new NextResponse(`\uFEFF${script}`, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

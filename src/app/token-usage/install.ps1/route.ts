import { NextResponse } from "next/server";

const script = String.raw`param([Parameter(Mandatory=$true)][string]$BaseUrl,[Parameter(Mandatory=$true)][string]$RegistrationCode)
$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$installDir = Join-Path $env:USERPROFILE ".chorify-usage"
$collectorPath = Join-Path $installDir "collector.ps1"
$configPath = Join-Path $installDir "config.json"
$statePath = Join-Path $installDir "state.json"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

try {
  try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { Add-Type -AssemblyName System.Security -ErrorAction Stop }
  $null = [Security.Cryptography.ProtectedData]
  $null = [Security.Cryptography.DataProtectionScope]
} catch {
  throw "当前 PowerShell 无法加载 Windows DPAPI。请使用 Windows PowerShell 5.1 或 PowerShell 7 后重试；注册码尚未使用。"
}

Write-Host "下载 Chorify Token 采集器 v0.3.0..."
$collectorSource = ([string](Invoke-RestMethod -Method Get -Uri "$BaseUrl/token-usage/collector.ps1")).TrimStart([char]0xFEFF)
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[IO.File]::WriteAllText($collectorPath,[string]$collectorSource,$utf8Bom)

$existingConfig = if (Test-Path $configPath) { try { Get-Content -Raw $configPath | ConvertFrom-Json } catch { $null } } else { $null }
$deviceId = if ($existingConfig -and $existingConfig.deviceId) { [string]$existingConfig.deviceId } else { [guid]::NewGuid().ToString() }
$encryptedSecret = $null
$reuseExisting = $false
if ($existingConfig -and $existingConfig.encryptedSecret -and ([string]$existingConfig.baseUrl).TrimEnd("/") -eq $BaseUrl) {
  try {
    $savedEncrypted = [Convert]::FromBase64String([string]$existingConfig.encryptedSecret)
    $savedSecretBytes = [Security.Cryptography.ProtectedData]::Unprotect($savedEncrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $savedSecret = [Text.Encoding]::UTF8.GetString($savedSecretBytes)
    $probeHeaders = @{ Authorization = "Bearer $savedSecret" }
    $probe = @{clientVersion="0.3.0";status="HEALTHY";error=$null} | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/usage-collectors/heartbeat" -Headers $probeHeaders -ContentType "application/json" -Body $probe | Out-Null
    $encryptedSecret = [string]$existingConfig.encryptedSecret
    $reuseExisting = $true
  } catch {
    $statusCode = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
    if ($statusCode -ne 401) { throw }
  }
}

if ($reuseExisting) {
  Write-Host "✓ 检测到本机已注册设备，将更新采集器并继续首次扫描。"
} else {
  $body = @{ registrationCode=$RegistrationCode; deviceId=$deviceId; deviceName=$env:COMPUTERNAME; platform="windows"; clientVersion="0.3.0" } | ConvertTo-Json
  $registered = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/usage-collectors/register" -ContentType "application/json" -Body $body
  $secretBytes = [Text.Encoding]::UTF8.GetBytes([string]$registered.deviceSecret)
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($secretBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $encryptedSecret = [Convert]::ToBase64String($encrypted)
  Write-Host "✓ 已完成设备注册。"
}
@{ baseUrl=$BaseUrl; deviceId=$deviceId; encryptedSecret=$encryptedSecret; clientVersion="0.3.0"; statePath=$statePath } | ConvertTo-Json | Set-Content -Encoding UTF8 $configPath
Write-Host "✓ 配置保存在 $configPath"

$action = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $collectorPath + '" -Quiet'
schtasks /Create /TN ChorifyUsageCollector /TR $action /SC MINUTE /MO 30 /F | Out-Null
Write-Host "✓ 已注册 Windows 计划任务 ChorifyUsageCollector（每 30 分钟后台静默上报）。"
Write-Host "首次扫描上报中（视本地日志量可能需要 1-5 分钟，请勿关闭窗口）..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $collectorPath
if ($LASTEXITCODE -ne 0) {
  $logPath = Join-Path $installDir "collector.log"
  if (Test-Path $logPath) { Write-Host (Get-Content -Raw $logPath) -ForegroundColor Red }
  throw "首次扫描失败，错误日志：$logPath"
}
Write-Host "===== 安装自检 ====="
Write-Host "客户端版本：0.3.0"
$task = Get-ScheduledTask -TaskName ChorifyUsageCollector -ErrorAction SilentlyContinue
Write-Host "后台任务：$($task.State)（每 30 分钟）"
Write-Host "✓ 全部成功！后台任务将持续上报 Codex 与 Claude Code Token 汇总。"
Write-Host "安全提示：不会上传提示词、代码、文件正文或任何密钥。分享日志时请对注册码和设备凭据打码。"
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

import { NextResponse } from "next/server";

const script = String.raw`param([Parameter(Mandatory=$true)][string]$BaseUrl,[string]$RegistrationCode = "")
$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")
$installDir = Join-Path $env:USERPROFILE ".chorify-usage"
$collectorPath = Join-Path $installDir "collector.ps1"
$residentPath = Join-Path $installDir "resident.ps1"
$launcherPath = Join-Path $installDir "run-hidden.vbs"
$residentPidPath = Join-Path $installDir "resident.pid"
$configPath = Join-Path $installDir "config.json"
$statePath = Join-Path $installDir "state.json"
$collectorVersion = "0.3.0"
$installerVersion = "0.4.0"
# 本次安装使用的任务名；同时用于清理旧版本可能留下的其他名字
$taskName = "ChorifyUsageCollector"
$knownTaskNames = @("ChorifyUsageCollector","ChorifyUsageCollector-Resident")
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

try {
  try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop } catch { Add-Type -AssemblyName System.Security -ErrorAction Stop }
  $null = [Security.Cryptography.ProtectedData]
  $null = [Security.Cryptography.DataProtectionScope]
} catch {
  throw "当前 PowerShell 无法加载 Windows DPAPI。请使用 Windows PowerShell 5.1 或 PowerShell 7 后重试；注册码尚未使用。"
}

# ---------- 1. 检测本机此前是否已安装 ----------
# 判定依据是 config.json 里已有的设备凭据：能用心跳验证通过就说明是本机已注册设备，
# 直接沿用 deviceId 与密钥（统计进度保留在 state.json），不需要消耗新的注册码。
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
    $probe = @{clientVersion=$collectorVersion;status="HEALTHY";error=$null} | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/usage-collectors/heartbeat" -Headers $probeHeaders -ContentType "application/json" -Body $probe | Out-Null
    $encryptedSecret = [string]$existingConfig.encryptedSecret
    $reuseExisting = $true
  } catch {
    $statusCode = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
    # 401 说明凭据已失效，退回去走新注册；其它错误（网络抖动等）不再中断安装，
    # 否则用户得重新领一条 10 分钟有效的注册码。
    if ($statusCode -ne 401) {
      Write-Host "提示：校验既有设备凭据时出错（$($_.Exception.Message)），将按原地更新继续。" -ForegroundColor Yellow
      $encryptedSecret = [string]$existingConfig.encryptedSecret
      $reuseExisting = $true
    }
  }
}

if ($reuseExisting) {
  Write-Host "[1/5] 检测到本机此前已安装（设备 $deviceId），本次为原地更新，统计进度保留。"
} else {
  if ([string]::IsNullOrWhiteSpace($RegistrationCode)) {
    throw "本机未检测到有效的安装记录，需要提供注册码。请回到 aipms 页面重新复制安装命令。"
  }
  Write-Host "[1/5] 未检测到本机安装记录，本次为新注册。"
  $body = @{ registrationCode=$RegistrationCode; deviceId=$deviceId; deviceName=$env:COMPUTERNAME; platform="windows"; clientVersion=$collectorVersion } | ConvertTo-Json
  $registered = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/usage-collectors/register" -ContentType "application/json" -Body $body
  $deviceSecret = [string]$registered.deviceSecret
  # 必须在清理旧安装之前确认拿到了凭据，否则会把空密钥写进配置并毁掉原有安装
  if ([string]::IsNullOrWhiteSpace($deviceSecret)) {
    throw "服务端未返回设备凭据，注册未成功。原有安装未做任何改动，请回到 aipms 页面重新复制安装命令后重试。"
  }
  $secretBytes = [Text.Encoding]::UTF8.GetBytes($deviceSecret)
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($secretBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  $encryptedSecret = [Convert]::ToBase64String($encrypted)
  Write-Host "      设备注册完成。"
}
@{ baseUrl=$BaseUrl; deviceId=$deviceId; encryptedSecret=$encryptedSecret; clientVersion=$collectorVersion; installerVersion=$installerVersion; statePath=$statePath } | ConvertTo-Json | Set-Content -Encoding UTF8 $configPath
Write-Host "      配置已保存到 $configPath"

# ---------- 2. 停掉并移除此前安装的一切 ----------
# 顺序很重要：这一步放在设备注册成功之后、写入新脚本之前。
# 放在注册之后是为了失败时不动老安装；放在写脚本之前是为了不会与老进程并发读写。
# 必须跨任务路径扫描：旧版本出错时可能在奇怪的文件夹下留下同名任务。
Write-Host "[2/5] 清理此前的安装..."
$removedTasks = New-Object System.Collections.Generic.List[string]
foreach ($task in @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $knownTaskNames -contains $_.TaskName })) {
  try { Stop-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName -ErrorAction SilentlyContinue } catch { }
  try {
    Unregister-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName -Confirm:$false -ErrorAction SilentlyContinue
    [void]$removedTasks.Add($task.TaskPath + $task.TaskName)
  } catch {
    Write-Host "      警告：无法移除计划任务 $($task.TaskPath)$($task.TaskName)：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}
if ($removedTasks.Count -eq 0) { Write-Host "      没有发现旧的计划任务。" } else { foreach ($t in $removedTasks) { Write-Host "      已移除计划任务 $t" } }

# 终止仍在运行的常驻进程与采集子进程。两道防线：先按上次写入的 pid 文件精确命中，
# 再按命令行兜底。杀掉前校验进程名与脚本路径，避免 pid 被复用后误杀无关进程。
$candidates = New-Object System.Collections.Generic.List[int]
if (Test-Path -LiteralPath $residentPidPath) {
  $recordedPid = 0
  if ([int]::TryParse(((Get-Content -Raw -LiteralPath $residentPidPath) -replace '\s',''), [ref]$recordedPid)) { [void]$candidates.Add($recordedPid) }
  Remove-Item -LiteralPath $residentPidPath -Force -ErrorAction SilentlyContinue
}
foreach ($p in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match "resident\.ps1|collector\.ps1" })) {
  [void]$candidates.Add([int]$p.ProcessId)
}
$killedPids = New-Object System.Collections.Generic.List[int]
foreach ($candidatePid in $candidates) {
  if ($candidatePid -le 0 -or $candidatePid -eq $PID) { continue }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$candidatePid" -ErrorAction SilentlyContinue
  if (-not $proc) { continue }
  if ($proc.Name -ne "powershell.exe") { continue }
  if ($proc.CommandLine -notmatch "\.chorify-usage\\") { continue }
  try {
    Stop-Process -Id $candidatePid -Force -ErrorAction SilentlyContinue
    [void]$killedPids.Add($candidatePid)
  } catch { }
}
if ($killedPids.Count -eq 0) { Write-Host "      没有发现正在运行的采集进程。" } else { Write-Host "      已终止进程 $($killedPids -join ', ')" }

# 确认常驻进程确实已退出——它若还活着会占着单实例互斥体，导致新进程无法启动。
$deadline = (Get-Date).AddSeconds(10)
do {
  $survivors = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match "\.chorify-usage\\resident\.ps1" })
  if ($survivors.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
if ($survivors.Count -gt 0) {
  Write-Host "      警告：仍有常驻进程未退出（$($survivors.ProcessId -join ', ')）。若后台未开始上报，请注销后重新登录再试。" -ForegroundColor Yellow
}

# ---------- 3. 写入采集器与静默启动器 ----------
Write-Host "[3/5] 下载并写入采集器文件..."
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$ascii = New-Object System.Text.ASCIIEncoding

$collectorSource = ([string](Invoke-RestMethod -Method Get -Uri "$BaseUrl/token-usage/collector.ps1")).TrimStart([char]0xFEFF)
[IO.File]::WriteAllText($collectorPath,[string]$collectorSource,$utf8Bom)

# 常驻脚本内容内嵌在此，安装器自身即完整可分发，不需要额外部署服务端静态文件。
# 写入时必须带 UTF-8 BOM：Windows PowerShell 5.1 会把无 BOM 的 .ps1 按 GBK 读，中文会解析失败。
$residentSource = @'
param([int]$IntervalSeconds = 1800)

$installDir = $PSScriptRoot
$collector = Join-Path $installDir "collector.ps1"
$pidFile = Join-Path $installDir "resident.pid"
$log = Join-Path $installDir "resident.log"

function Write-ResidentLog([string]$message) {
  try {
    Add-Content -LiteralPath $log -Value "[$(Get-Date -Format o)] $message" -Encoding UTF8
    $item = Get-Item -LiteralPath $log -ErrorAction SilentlyContinue
    if ($item -and $item.Length -gt 1MB) {
      $tail = @(Get-Content -LiteralPath $log -Tail 500)
      Set-Content -LiteralPath $log -Value $tail -Encoding UTF8
    }
  } catch { }
}

# 单实例互斥体：安装器每 30 分钟还会重试拉起本脚本用于自愈，
# 靠这个互斥体保证任何时刻只有一个常驻进程，安装器也用同名互斥体判断旧进程是否已退出。
$mutex = New-Object Threading.Mutex($false, "Local\ChorifyUsageCollectorResident")
$acquired = $false
try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) {
  Write-ResidentLog "已有常驻采集器在运行，本次启动直接退出 pid=$PID"
  exit 0
}

try {
  Set-Content -LiteralPath $pidFile -Value $PID -Encoding ASCII
  Write-ResidentLog "常驻采集器启动 pid=$PID 间隔=$IntervalSeconds 秒"

  # 先睡后采：安装器在安装时已经跑过一次前台扫描，这里没必要立刻重复一遍。
  # 万一常驻进程崩溃后重启，因为采集器是按行偏移增量读取的，晚一轮也不会丢数据。
  while ($true) {
    Start-Sleep -Seconds $IntervalSeconds
    $startedAt = Get-Date
    if (Test-Path -LiteralPath $collector) {
      try {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $collector -Quiet
        $elapsed = [Math]::Round(((Get-Date) - $startedAt).TotalSeconds, 1)
        if ($LASTEXITCODE -eq 0) {
          Write-ResidentLog "采集完成 exit=0 用时=$elapsed 秒"
        } else {
          Write-ResidentLog "采集失败 exit=$LASTEXITCODE 用时=$elapsed 秒（详见 collector.log）"
        }
      } catch {
        Write-ResidentLog "调用采集脚本异常：$($_.Exception.Message)"
      }
    } else {
      Write-ResidentLog "未找到采集脚本：$collector"
    }
  }
} finally {
  try { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue } catch { }
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
'@
[IO.File]::WriteAllText($residentPath,$residentSource,$utf8Bom)

# VBS 必须存成 ASCII：wscript.exe 按 ANSI 读取，带 UTF-8 BOM 会把首行注释变成代码。
$launcherSource = @'
Option Explicit
Dim shell, fso, scriptPath, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "resident.ps1")
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run cmd, 0, False
'@
[IO.File]::WriteAllText($launcherPath,$launcherSource,$ascii)
Write-Host "      已写入 $collectorPath"
Write-Host "      已写入 $residentPath"
Write-Host "      已写入 $launcherPath"

# ---------- 4. 前台跑一次，确认能采集并上报 ----------
Write-Host "[4/5] 扫描并上报中（视本地日志量可能需要 1-5 分钟，请勿关闭窗口）..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $collectorPath
if ($LASTEXITCODE -ne 0) {
  $logPath = Join-Path $installDir "collector.log"
  if (Test-Path $logPath) { Write-Host (Get-Content -Raw $logPath) -ForegroundColor Red }
  throw "扫描失败，错误日志：$logPath"
}

# ---------- 5. 注册计划任务并确认常驻进程已起来 ----------
# 动作是 wscript.exe 而不是 powershell.exe：powershell.exe 是控制台程序，会分配控制台窗口，
# 而 Win11 默认终端宿主是 Windows Terminal，-WindowStyle Hidden 压不住它，于是每 30 分钟弹一次窗。
# wscript.exe 属 GUI 子系统、本身无控制台，再配合 Run 的第二参数 0（SW_HIDE），窗口从不出现。
# LogonType 必须是 Interactive：采集器用 DPAPI 的 CurrentUser 作用域解密凭据，
# 而 DPAPI 用户主密钥由密码派生，S4U 登录没有密码、解不开，采集会静默停摆。
Write-Host "[5/5] 注册计划任务..."
$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) { throw "找不到 wscript.exe：$wscript" }

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$taskAction = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $launcherPath + '"')
# 两个触发器：登录时启动，以及安装后 1 分钟起每 30 分钟重试一次。
# 后者兼作自愈——常驻进程若崩溃，最多 30 分钟后被重新拉起；重复触发由互斥体挡掉。
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
try { $logonTrigger.Delay = "PT1M" } catch { }
$retryTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($logonTrigger,$retryTrigger) -Principal $principal -Settings $settings -Force -Description "Chorify Token 用量采集器：静默启动常驻后台进程，无窗口" | Out-Null

Start-ScheduledTask -TaskName $taskName
$deadline = (Get-Date).AddSeconds(20)
do {
  $residentProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -match "\.chorify-usage\\resident\.ps1" })
  if ($residentProcs.Count -gt 0) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Write-Host "===== 安装自检 ====="
Write-Host "安装器版本：$installerVersion"
Write-Host "客户端版本：$collectorVersion"
Write-Host "安装方式：$(if ($reuseExisting) { '原地更新（统计进度保留）' } else { '新注册' })"
Write-Host "清理结果：移除任务 $(if ($removedTasks.Count -eq 0) { 0 } else { $removedTasks.Count }) 个，终止进程 $(if ($killedPids.Count -eq 0) { 0 } else { $killedPids.Count }) 个"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host "计划任务：$taskName 状态 $($task.State)（登录时启动，每 30 分钟重试一次；运行于后台，不显示窗口）"
if ($residentProcs.Count -gt 0) {
  Write-Host "常驻进程：已启动 pid=$($residentProcs.ProcessId)，每 30 分钟采集一次"
} else {
  Write-Host "常驻进程：暂未检测到，将在 1 分钟内由计划任务自动拉起" -ForegroundColor Yellow
}
Write-Host "全部完成。后台会持续上报 Codex 与 Claude Code 的 Token 汇总。"
Write-Host "安全提示：不会上传提示词、代码、文件正文或任何密钥。分享日志时请对注册码和设备凭据打码。"
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

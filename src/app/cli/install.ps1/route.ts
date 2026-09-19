// Windows installer for the aipms CLI, the counterpart of /cli (which serves
// the bash installer). Runs standalone via `irm ... | iex`, or as a script with
// -BaseUrl for a non-production origin.
//
// Keep the body free of backticks and of PowerShell ${...} syntax: it lives in
// a String.raw template, so a backslash stays literal but ${...} would be
// interpolated by this file rather than by PowerShell.
function installerScript(baseUrl: string) {
  return String.raw`param([string]$BaseUrl = "${baseUrl}")

$ErrorActionPreference = "Stop"
$BaseUrl = $BaseUrl.TrimEnd("/")

$installDir = if ($env:AIPMS_HOME) { $env:AIPMS_HOME } else { Join-Path $HOME ".aipms" }
$binDir = if ($env:AIPMS_BIN_DIR) { $env:AIPMS_BIN_DIR } else { Join-Path $HOME ".local/bin" }
$skillDir = if ($env:AIPMS_SKILL_DIR) { $env:AIPMS_SKILL_DIR } else { Join-Path (Get-Location).Path ".agents/skills/aipms-project-operations" }
$configPath = Join-Path $installDir "config"
$cliPath = Join-Path $installDir "aipms.ps1"
$shimPath = Join-Path $binDir "aipms.cmd"
$skillPath = Join-Path $skillDir "SKILL.md"

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-Text([string]$Uri) {
  $response = Invoke-WebRequest -Method Get -Uri $Uri -UseBasicParsing
  return ([string]$response.Content).TrimStart([char]0xFEFF)
}

function Protect-Config([string]$Path) {
  try {
    if ($env:OS -eq "Windows_NT") {
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      $acl = Get-Acl -LiteralPath $Path
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, "FullControl", "Allow")
      $acl.SetAccessRule($rule)
      Set-Acl -LiteralPath $Path -AclObject $acl
    } else {
      & chmod 600 $Path 2>$null
    }
  } catch { }
}

Write-Host "Downloading AIPMS CLI..."
Write-Utf8NoBom $cliPath (Get-Text ($BaseUrl + "/cli/ps1"))

# A .cmd shim so the aipms command works from cmd.exe and PowerShell without
# depending on the execution policy that applies to .ps1 files found on PATH.
$shim = "@echo off" + [Environment]::NewLine +
  "powershell -NoProfile -ExecutionPolicy Bypass -File " + [char]34 + $cliPath + [char]34 + " %*" + [Environment]::NewLine
Write-Utf8NoBom $shimPath $shim

Write-Utf8NoBom $skillPath (Get-Text ($BaseUrl + "/cli/skill"))
Write-Host ("Skill installed: " + $skillPath)

Write-Host ("AIPMS CLI installed: " + $shimPath)
Write-Host ("Configuration directory: " + $installDir)
Write-Host ("Opening " + $BaseUrl + " so you can create/copy an API Key...")
try { Start-Process $BaseUrl | Out-Null } catch { Write-Host ("Open this URL in your browser: " + $BaseUrl) }

$secure = Read-Host "Paste the API Key shown by the website (input hidden)" -AsSecureString
$apiKey = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$apiKey = $apiKey.Trim()
if (-not $apiKey) { Write-Host "API Key is required; rerun this installer." -ForegroundColor Red; exit 2 }

Write-Utf8NoBom $configPath ("BASE_URL=" + $BaseUrl + [Environment]::NewLine + "API_KEY=" + $apiKey + [Environment]::NewLine)
Protect-Config $configPath
Write-Host ("Configuration saved locally at " + $configPath)

$pathParts = $env:PATH -split [IO.Path]::PathSeparator
if ($pathParts -notcontains $binDir) {
  Write-Host ("Add to PATH: " + '$env:PATH = "' + $binDir + ';" + $env:PATH')
  try {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) { $userPath = "" }
    if (($userPath -split [IO.Path]::PathSeparator) -notcontains $binDir) {
      $trimmed = $userPath.TrimEnd(";")
      $merged = if ($trimmed) { $trimmed + ";" + $binDir } else { $binDir }
      [Environment]::SetEnvironmentVariable("Path", $merged, "User")
      Write-Host ("Added to your user PATH; open a new terminal to pick it up: " + $binDir)
    }
  } catch { }
}

Write-Host "Running capability checks..."
& powershell -NoProfile -ExecutionPolicy Bypass -File $cliPath doctor
if ($LASTEXITCODE -ne 0) {
  Write-Host "API Key validation failed or the server is unavailable." -ForegroundColor Red
  exit 1
}
Write-Host "Capability checks completed."
Write-Host ("Guide: " + $BaseUrl + "/cli/guide")
`;
}

export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  return new Response(installerScript(origin), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": "inline; filename=install-aipms.ps1",
    },
  });
}

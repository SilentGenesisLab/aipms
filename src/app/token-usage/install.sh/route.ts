import { NextResponse } from "next/server";
import { COLLECTOR_VERSION } from "@/lib/usage-collector";

const script = String.raw`#!/bin/bash
set -euo pipefail

BASE_URL="$1"
REGISTRATION_CODE="$2"
BASE_URL="$(printf '%s' "$BASE_URL" | /usr/bin/sed 's:/*$::')"
VERSION="${COLLECTOR_VERSION}"
INSTALL_DIR="$HOME/.chorify-usage"
COLLECTOR_PATH="$INSTALL_DIR/collector.mjs"
CONFIG_PATH="$INSTALL_DIR/config.json"
STATE_PATH="$INSTALL_DIR/state.json"
LOG_PATH="$INSTALL_DIR/collector.log"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/cn.sligenai.chorify-usage.plist"
KEYCHAIN_SERVICE="cn.sligenai.chorify-usage"

if [ "$(uname -s)" != "Darwin" ]; then echo "此安装器仅支持 macOS。" >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "未找到 Node.js 18+。请先安装 Node.js，再重新执行本命令；注册码尚未使用。" >&2; exit 1; fi
NODE_PATH="$(command -v node)"
NODE_MAJOR="$($NODE_PATH -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then echo "需要 Node.js 18 或更高版本；注册码尚未使用。" >&2; exit 1; fi

mkdir -p "$INSTALL_DIR" "$PLIST_DIR"
chmod 700 "$INSTALL_DIR"
echo "下载 Chorify Token 采集器 v$VERSION..."
/usr/bin/curl -fsSL "$BASE_URL/token-usage/collector.mjs" -o "$COLLECTOR_PATH"
chmod 700 "$COLLECTOR_PATH"

DEVICE_ID=""
if [ -f "$CONFIG_PATH" ]; then DEVICE_ID="$($NODE_PATH -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).deviceId||"")}catch{}' "$CONFIG_PATH")"; fi
if [ -z "$DEVICE_ID" ]; then DEVICE_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"; fi
REUSE_EXISTING=false
if DEVICE_SECRET="$(/usr/bin/security find-generic-password -a "$DEVICE_ID" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" && [ -n "$DEVICE_SECRET" ]; then
  HEARTBEAT_CODE="$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/v1/usage-collectors/heartbeat" -H "Authorization: Bearer $DEVICE_SECRET" -H 'Content-Type: application/json' --data "{\"clientVersion\":\"$VERSION\",\"status\":\"HEALTHY\",\"error\":null}")"
  if [ "$HEARTBEAT_CODE" = "200" ]; then REUSE_EXISTING=true; elif [ "$HEARTBEAT_CODE" != "401" ]; then echo "无法验证现有设备，HTTP $HEARTBEAT_CODE" >&2; exit 1; fi
fi

if [ "$REUSE_EXISTING" = true ]; then
  echo "✓ 检测到本机已注册设备，将更新采集器并继续首次扫描。"
else
  DEVICE_NAME="$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /bin/hostname)"
  REQUEST_PATH="$INSTALL_DIR/register-request.json"
  RESPONSE_PATH="$INSTALL_DIR/register-response.json"
  REGISTRATION_CODE="$REGISTRATION_CODE" DEVICE_ID="$DEVICE_ID" DEVICE_NAME="$DEVICE_NAME" VERSION="$VERSION" $NODE_PATH -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({registrationCode:process.env.REGISTRATION_CODE,deviceId:process.env.DEVICE_ID,deviceName:process.env.DEVICE_NAME,platform:"macos",clientVersion:process.env.VERSION}))' "$REQUEST_PATH"
  HTTP_CODE="$(/usr/bin/curl -sS -o "$RESPONSE_PATH" -w '%{http_code}' -X POST "$BASE_URL/api/v1/usage-collectors/register" -H 'Content-Type: application/json' --data-binary "@$REQUEST_PATH")"
  rm -f "$REQUEST_PATH"
  if [ "$HTTP_CODE" != "201" ]; then ERROR_TEXT="$($NODE_PATH -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error||"注册失败")}catch{process.stdout.write("注册失败")}' "$RESPONSE_PATH")"; rm -f "$RESPONSE_PATH"; echo "$ERROR_TEXT" >&2; exit 1; fi
  DEVICE_SECRET="$($NODE_PATH -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).deviceSecret)' "$RESPONSE_PATH")"
  rm -f "$RESPONSE_PATH"
  /usr/bin/security add-generic-password -U -T /usr/bin/security -a "$DEVICE_ID" -s "$KEYCHAIN_SERVICE" -w "$DEVICE_SECRET" >/dev/null
  echo "✓ 已完成设备注册，设备凭据已保存到 macOS Keychain。"
fi

BASE_URL="$BASE_URL" DEVICE_ID="$DEVICE_ID" VERSION="$VERSION" STATE_PATH="$STATE_PATH" $NODE_PATH -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({baseUrl:process.env.BASE_URL,deviceId:process.env.DEVICE_ID,clientVersion:process.env.VERSION,statePath:process.env.STATE_PATH},null,2),{mode:0o600})' "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cn.sligenai.chorify-usage</string>
  <key>ProgramArguments</key><array><string>$NODE_PATH</string><string>$COLLECTOR_PATH</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
</dict></plist>
PLIST
chmod 600 "$PLIST_PATH"
/bin/launchctl bootout "gui/$(/usr/bin/id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$PLIST_PATH"
echo "✓ 已注册 macOS LaunchAgent（每 30 分钟后台上报）。"
echo "首次扫描上报中（视本地日志量可能需要 1-5 分钟，请勿关闭终端）..."
if ! "$NODE_PATH" "$COLLECTOR_PATH"; then echo "首次扫描失败，错误日志：$LOG_PATH" >&2; exit 1; fi
echo "===== 安装自检 ====="
echo "客户端版本：$VERSION"
/bin/launchctl print "gui/$(/usr/bin/id -u)/cn.sligenai.chorify-usage" >/dev/null
echo "✓ 全部成功！LaunchAgent 将持续上报 Codex 与 Claude Code Token 汇总。"
echo "配置：$CONFIG_PATH"
echo "任务：$PLIST_PATH"
echo "安全提示：设备凭据保存在 macOS Keychain；不会上传提示词、代码、文件正文或密钥。"
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
}

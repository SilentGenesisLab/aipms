import { NextResponse } from "next/server";
import { MAC_COLLECTOR_VERSION } from "@/lib/usage-collector";

const script = String.raw`#!/bin/bash
set -euo pipefail

if [ "$#" -ne 2 ]; then echo "用法：install.sh <服务地址> <一次性注册码>" >&2; exit 1; fi
if [ "$(uname -s)" != "Darwin" ]; then echo "此安装器仅支持 macOS。" >&2; exit 1; fi
if [ "$(/usr/bin/id -u)" -eq 0 ]; then echo "请使用普通用户执行，不要使用 sudo。" >&2; exit 1; fi

BASE_URL="$(printf '%s' "$1" | /usr/bin/sed 's:/*$::')"
REGISTRATION_CODE="$2"
VERSION="${MAC_COLLECTOR_VERSION}"
INSTALL_DIR="$HOME/.chorify-usage"
PARSER_PATH="$INSTALL_DIR/collector.jxa"
COLLECTOR_PATH="$INSTALL_DIR/collector.sh"
LEGACY_COLLECTOR_PATH="$INSTALL_DIR/collector.mjs"
CONFIG_PATH="$INSTALL_DIR/config.json"
STATE_PATH="$INSTALL_DIR/state.json"
LOG_PATH="$INSTALL_DIR/collector.log"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/cn.sligenai.chorify-usage.plist"
KEYCHAIN_SERVICE="cn.sligenai.chorify-usage"

for tool in /usr/bin/curl /usr/bin/osascript /usr/bin/security /usr/bin/plutil /bin/launchctl; do
  if [ ! -x "$tool" ]; then echo "系统缺少必要工具：$tool" >&2; exit 1; fi
done

mkdir -p "$INSTALL_DIR" "$PLIST_DIR"
chmod 700 "$INSTALL_DIR"
echo "下载 Chorify Token 采集器 v$VERSION（macOS 零依赖版）..."
/usr/bin/curl -fsSL "$BASE_URL/token-usage/collector.mjs" -o "$PARSER_PATH"
chmod 600 "$PARSER_PATH"

cat > "$COLLECTOR_PATH" <<'COLLECTOR'
#!/bin/bash
set -euo pipefail

VERSION="${MAC_COLLECTOR_VERSION}"
INSTALL_DIR="$HOME/.chorify-usage"
PARSER_PATH="$INSTALL_DIR/collector.jxa"
CONFIG_PATH="$INSTALL_DIR/config.json"
STATE_PATH="$INSTALL_DIR/state.json"
LOG_PATH="$INSTALL_DIR/collector.log"
KEYCHAIN_SERVICE="cn.sligenai.chorify-usage"
QUIET=false
if [ "$#" -gt 0 ] && [ "$1" = "--quiet" ]; then QUIET=true; fi

BASE_URL="$(/usr/bin/plutil -extract baseUrl raw -o - "$CONFIG_PATH")"
DEVICE_ID="$(/usr/bin/plutil -extract deviceId raw -o - "$CONFIG_PATH")"
CONFIGURED_STATE="$(/usr/bin/plutil -extract statePath raw -o - "$CONFIG_PATH" 2>/dev/null || true)"
if [ -n "$CONFIGURED_STATE" ]; then STATE_PATH="$CONFIGURED_STATE"; fi
DEVICE_SECRET="$(/usr/bin/security find-generic-password -a "$DEVICE_ID" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"
if [ -z "$DEVICE_SECRET" ]; then echo "macOS Keychain 中未找到设备凭据" >&2; exit 1; fi

RUN_DIR="$(/usr/bin/mktemp -d "$INSTALL_DIR/run.XXXXXX")"
SUCCESS=false
cleanup() {
  status=$?
  if [ "$SUCCESS" != true ]; then
    /usr/bin/curl -sS -o /dev/null -X POST "$BASE_URL/api/v1/usage-collectors/heartbeat" \
      -H "Authorization: Bearer $DEVICE_SECRET" -H 'Content-Type: application/json' \
      --data "{\"clientVersion\":\"$VERSION\",\"status\":\"ERROR\",\"error\":\"macOS collector failed; see local log\"}" || true
  fi
  rm -rf "$RUN_DIR"
  exit "$status"
}
trap cleanup EXIT

SUMMARY="$(/usr/bin/osascript -l JavaScript "$PARSER_PATH" scan "$STATE_PATH" "$RUN_DIR")"
ACCEPTED=0
DUPLICATES=0
for batch in "$RUN_DIR"/batch-*.json; do
  if [ ! -e "$batch" ]; then break; fi
  response="$RUN_DIR/response.json"
  http_code="$(/usr/bin/curl -sS -o "$response" -w '%{http_code}' -X POST "$BASE_URL/api/v1/token-usage/batches" \
    -H "Authorization: Bearer $DEVICE_SECRET" -H 'Content-Type: application/json' --data-binary "@$batch")"
  if [ "$http_code" != "200" ]; then
    error_text="$(/usr/bin/plutil -extract error raw -o - "$response" 2>/dev/null || printf 'HTTP %s' "$http_code")"
    echo "$error_text" >&2
    exit 1
  fi
  accepted="$(/usr/bin/plutil -extract accepted raw -o - "$response")"
  duplicates="$(/usr/bin/plutil -extract duplicates raw -o - "$response")"
  ACCEPTED=$((ACCEPTED + accepted))
  DUPLICATES=$((DUPLICATES + duplicates))
done

/bin/mv -f "$RUN_DIR/next-state.json" "$STATE_PATH"
chmod 600 "$STATE_PATH"
heartbeat_code="$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/v1/usage-collectors/heartbeat" \
  -H "Authorization: Bearer $DEVICE_SECRET" -H 'Content-Type: application/json' \
  --data "{\"clientVersion\":\"$VERSION\",\"status\":\"HEALTHY\",\"error\":null}")"
if [ "$heartbeat_code" != "200" ]; then echo "心跳上报失败，HTTP $heartbeat_code" >&2; exit 1; fi
SUCCESS=true
if [ "$QUIET" != true ]; then
  sources="$(printf '%s' "$SUMMARY" | /usr/bin/plutil -extract sources raw -o - -)"
  parsed="$(printf '%s' "$SUMMARY" | /usr/bin/plutil -extract parsedRecords raw -o - -)"
  echo "扫描完成：扫描 $sources 个文件，解析 $parsed 条记录；新增 $ACCEPTED 条，重复 $DUPLICATES 条。"
fi
COLLECTOR
chmod 700 "$COLLECTOR_PATH"

DEVICE_ID=""
if [ -f "$CONFIG_PATH" ]; then DEVICE_ID="$(/usr/bin/plutil -extract deviceId raw -o - "$CONFIG_PATH" 2>/dev/null || true)"; fi
if [ -z "$DEVICE_ID" ]; then DEVICE_ID="$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"; fi
REUSE_EXISTING=false
if DEVICE_SECRET="$(/usr/bin/security find-generic-password -a "$DEVICE_ID" -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)" && [ -n "$DEVICE_SECRET" ]; then
  HEARTBEAT_CODE="$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/api/v1/usage-collectors/heartbeat" -H "Authorization: Bearer $DEVICE_SECRET" -H 'Content-Type: application/json' --data "{\"clientVersion\":\"$VERSION\",\"status\":\"HEALTHY\",\"error\":null}")"
  if [ "$HEARTBEAT_CODE" = "200" ]; then REUSE_EXISTING=true; elif [ "$HEARTBEAT_CODE" != "401" ]; then echo "无法验证现有设备，HTTP $HEARTBEAT_CODE" >&2; exit 1; fi
fi

if [ "$REUSE_EXISTING" = true ]; then
  echo "✓ 检测到本机已注册设备，将保留凭据和增量状态并升级采集器。"
else
  DEVICE_NAME="$(/usr/sbin/scutil --get ComputerName 2>/dev/null || /bin/hostname)"
  REQUEST_PATH="$INSTALL_DIR/register-request.json"
  RESPONSE_PATH="$INSTALL_DIR/register-response.json"
  REGISTRATION_CODE="$REGISTRATION_CODE" DEVICE_ID="$DEVICE_ID" DEVICE_NAME="$DEVICE_NAME" \
    /usr/bin/osascript -l JavaScript "$PARSER_PATH" registration > "$REQUEST_PATH"
  HTTP_CODE="$(/usr/bin/curl -sS -o "$RESPONSE_PATH" -w '%{http_code}' -X POST "$BASE_URL/api/v1/usage-collectors/register" -H 'Content-Type: application/json' --data-binary "@$REQUEST_PATH")"
  rm -f "$REQUEST_PATH"
  if [ "$HTTP_CODE" != "201" ]; then
    ERROR_TEXT="$(/usr/bin/plutil -extract error raw -o - "$RESPONSE_PATH" 2>/dev/null || printf '注册失败，HTTP %s' "$HTTP_CODE")"
    rm -f "$RESPONSE_PATH"
    echo "$ERROR_TEXT" >&2
    exit 1
  fi
  DEVICE_SECRET="$(/usr/bin/plutil -extract deviceSecret raw -o - "$RESPONSE_PATH")"
  rm -f "$RESPONSE_PATH"
  /usr/bin/security add-generic-password -U -T /usr/bin/security -a "$DEVICE_ID" -s "$KEYCHAIN_SERVICE" -w "$DEVICE_SECRET" >/dev/null
  echo "✓ 已完成设备注册，设备凭据已保存到 macOS Keychain。"
fi

BASE_URL="$BASE_URL" DEVICE_ID="$DEVICE_ID" STATE_PATH="$STATE_PATH" \
  /usr/bin/osascript -l JavaScript "$PARSER_PATH" config > "$CONFIG_PATH"
chmod 600 "$CONFIG_PATH"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cn.sligenai.chorify-usage</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$COLLECTOR_PATH</string><string>--quiet</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$LOG_PATH</string>
  <key>StandardErrorPath</key><string>$LOG_PATH</string>
</dict></plist>
PLIST
chmod 600 "$PLIST_PATH"
/bin/launchctl bootout "gui/$(/usr/bin/id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$PLIST_PATH"
rm -f "$LEGACY_COLLECTOR_PATH"
echo "✓ 已注册 macOS LaunchAgent（每 30 分钟后台上报）。"
echo "首次扫描上报中（视本地日志量可能需要 1-5 分钟，请勿关闭终端）..."
if ! "$COLLECTOR_PATH"; then echo "首次扫描失败，错误日志：$LOG_PATH" >&2; exit 1; fi
echo "===== 安装自检 ====="
echo "客户端版本：$VERSION"
/bin/launchctl print "gui/$(/usr/bin/id -u)/cn.sligenai.chorify-usage" >/dev/null
echo "✓ 全部成功：无需 Node.js，LaunchAgent 将持续上报 Codex 与 Claude Code Token 汇总。"
echo "配置：$CONFIG_PATH"
echo "任务：$PLIST_PATH"
echo "安全提示：设备凭据保存在 macOS Keychain；不会上传提示词、代码、文件正文或密钥。"
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" } });
}

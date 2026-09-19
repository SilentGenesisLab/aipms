function cliScript(baseUrl: string) {
  return `#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="\${AIPMS_HOME:-$HOME/.aipms}"
BIN_DIR="\${AIPMS_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
chmod 700 "$INSTALL_DIR" 2>/dev/null || true
SKILL_DIR="\${AIPMS_SKILL_DIR:-$PWD/.agents/skills/aipms-project-operations}"

open_site() {
  url="$1"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  elif command -v start >/dev/null 2>&1; then start "" "$url" >/dev/null 2>&1 &
  else echo "Open this URL in your browser: $url"; fi
}

install_skill() {
  mkdir -p "$SKILL_DIR"
  curl -fsSL "$BASE_URL/cli/skill" -o "$SKILL_DIR/SKILL.md"
  chmod 600 "$SKILL_DIR/SKILL.md" 2>/dev/null || true
  echo "Skill installed: $SKILL_DIR/SKILL.md"
}

cat > "$BIN_DIR/aipms" <<'AIPMS_CLI'
#!/usr/bin/env bash
set -euo pipefail
CONFIG_FILE=""
DEFAULT_BASE_URL="${baseUrl}"

# Credentials resolve in this order: an explicit AIPMS_CONFIG, then a
# .aipms/config in the working directory, then the per-user ~/.aipms/config
# that the installer writes. A directory-local file wins so a workspace can
# hold its own key, while a plain install keeps working from any directory.
resolve_config() {
  if [ -n "\${AIPMS_CONFIG:-}" ]; then printf '%s\\n' "$AIPMS_CONFIG"; return; fi
  if [ -f "$PWD/.aipms/config" ]; then printf '%s\\n' "$PWD/.aipms/config"; return; fi
  printf '%s\\n' "\${AIPMS_HOME:-$HOME/.aipms}/config"
}
CONFIG_FILE="$(resolve_config)"

read_config() {
  BASE_URL="$DEFAULT_BASE_URL"
  API_KEY=""
  if [ -f "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    . "$CONFIG_FILE"
  fi
  # Environment variables win over the saved file, so an exported
  # AIPMS_API_KEY / AIPMS_BASE_URL still works in a directory that already has
  # a config instead of being silently overwritten by it.
  API_KEY="\${AIPMS_API_KEY:-$API_KEY}"
  BASE_URL="\${AIPMS_BASE_URL:-$BASE_URL}"
}

save_config() {
  mkdir -p "$(dirname "$CONFIG_FILE")"
  umask 077
  printf 'BASE_URL=%q\\nAPI_KEY=%q\\n' "$1" "$2" > "$CONFIG_FILE"
}

need_auth() {
  [ -n "$API_KEY" ] || { echo "Not authenticated. Run: aipms auth login --api-key <key>" >&2; exit 2; }
}

request() {
  method="$1"; path="$2"; data="\${3:-}"; idem="\${4:-}"
  need_auth
  args=(-sS -X "$method" -H "Authorization: Bearer $API_KEY" -H 'Accept: application/json')
  if [ -n "$data" ]; then args+=(-H 'Content-Type: application/json' --data-binary "$data"); fi
  if [ -n "$idem" ]; then args+=(-H "Idempotency-Key: $idem"); fi
  # Print the body even when the request fails: curl -f swallows it, leaving
  # only "HTTP 400" and hiding which field the server rejected.
  body="$(mktemp)"
  code="$(curl "\${args[@]}" -o "$body" -w '%{http_code}' "$BASE_URL$path" || printf '000')"
  cat "$body"; rm -f "$body"
  echo
  case "$code" in
    2*|3*) return 0 ;;
    *) echo "Request failed: HTTP $code" >&2; return 1 ;;
  esac
}

probe() {
  path="$1"; label="$2"
  tmp="$(mktemp)"
  code="$(curl -sS -o "$tmp" -w '%{http_code}' "\${HEADER_ARGS[@]}" "$BASE_URL$path" || printf '000')"
  rm -f "$tmp"
  printf '%s\t%s\n' "$label" "$code"
  [ "$code" != "000" ]
}

resource_path() {
  resource="$1"; project_id="\${2:-}"
  case "$resource" in
    projects) echo "/api/v1/projects" ;;
    requirements|tasks|bugs|versions|releases|members|milestones)
      [ -n "$project_id" ] || { echo "project id is required" >&2; exit 2; }
      echo "/api/v1/projects/$project_id/$resource" ;;
    files|folders|teams|notifications|audit-logs) echo "/api/v1/$resource" ;;
    *) echo "unsupported resource: $resource" >&2; exit 2 ;;
  esac
}

read_config
cmd="\${1:-help}"; shift || true
case "$cmd" in
  auth)
    sub="\${1:-}"; shift || true
    case "$sub" in
      login)
        base="$DEFAULT_BASE_URL"; key=""
        while [ "$#" -gt 0 ]; do
          case "$1" in --api-key) key="$2"; shift 2;; --base-url) base="\${2%/}"; shift 2;; *) shift;; esac
        done
        if [ -z "$key" ]; then
          open_site "$base"
          printf 'Paste the API Key shown by the website (input hidden): '
          read -r -s key; echo
        fi
        key="$(printf '%s' "$key" | tr -d '\r\n')"
        [ -n "$key" ] || { echo "API Key is required" >&2; exit 2; }
        save_config "$base" "$key"; BASE_URL="$base"; API_KEY="$key"
        request GET /api/v1/me >/dev/null
        echo "Authenticated with $base"
        ;;
      logout) rm -f "$CONFIG_FILE"; echo "Local credentials removed" ;;
      status) request GET /api/v1/me ;;
      *) echo "Usage: aipms auth login --api-key <key> [--base-url URL] | logout | status" >&2; exit 2 ;;
    esac
    ;;
  doctor)
    json=0; [ "\${1:-}" = "--json" ] && json=1
    read_config; need_auth
    HEADER_ARGS=(-H "Authorization: Bearer $API_KEY" -H 'Accept: application/json')
    checks=(
      "/api/v1/me|identity"
      "/api/v1/me/work-context|work-context"
      "/api/v1/projects|projects"
      "/api/v1/teams|teams"
      "/api/v1/notifications|notifications"
      "/api/v1/audit-logs|audit-logs"
    )
    failed=0; first=1
    [ "$json" -eq 1 ] && printf '{"baseUrl":"%s","checks":{' "$BASE_URL"
    for item in "\${checks[@]}"; do
      path="\${item%%|*}"; label="\${item##*|}"
      result="$(probe "$path" "$label")" || true
      code="\${result##*$'\t'}"
      [ "$code" = "000" ] && failed=1
      if [ "$json" -eq 1 ]; then
        [ "$first" -eq 1 ] || printf ','
        first=0
        printf '"%s":%s' "$label" "$code"
      else
        printf '%s: HTTP %s\n' "$label" "$code"
      fi
      [ "$label" = "identity" ] && [[ "$code" != 2* ]] && failed=1
    done
    [ "$json" -eq 1 ] && printf '}}\n'
    [ "$failed" -eq 0 ]
    ;;
  context)
    query=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --project|--status|--fields|--limit)
          [ "$#" -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
          query="$query&\${1#--}=$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    path="/api/v1/me/work-context"
    [ -n "$query" ] && path="$path?\${query#&}"
    request GET "$path"
    ;;
  list)
    resource="\${1:?resource required}"; project="\${2:-}"; path="$(resource_path "$resource" "$project")"
    request GET "$path"
    ;;
  get)
    resource="\${1:?resource required}"; project="\${2:-}"; id="\${3:-}"
    base="$(resource_path "$resource" "$project")"; [ -n "$id" ] && base="$base/$id"
    request GET "$base"
    ;;
  create)
    resource="\${1:?resource required}"; project="\${2:-}"; json="\${3:?JSON body required}"
    request POST "$(resource_path "$resource" "$project")" "$json" "aipms-$(date +%s)-$RANDOM"
    ;;
  update)
    resource="\${1:?resource required}"; project="\${2:-}"; id="\${3:?id required}"; json="\${4:?JSON body required}"
    request PATCH "$(resource_path "$resource" "$project")/$id" "$json" "aipms-$(date +%s)-$RANDOM"
    ;;
  delete)
    resource="\${1:?resource required}"; project="\${2:-}"; id="\${3:?id required}"
    request DELETE "$(resource_path "$resource" "$project")/$id" "" "aipms-$(date +%s)-$RANDOM"
    ;;
  task-context) request GET "/api/v1/tasks/\${1:?task id required}/context" ;;
  task-report) request POST "/api/v1/tasks/\${1:?task id required}/reports" "\${2:?JSON body required}" "aipms-$(date +%s)-$RANDOM" ;;
  task-accept) request POST "/api/v1/tasks/\${1:?task id required}/acceptances" "\${2:?JSON body required}" "aipms-$(date +%s)-$RANDOM" ;;
  raw)
    method="\${1:?method required}"; path="\${2:?path required}"; data="\${3:-}"
    request "$method" "$path" "$data" "aipms-$(date +%s)-$RANDOM"
    ;;
  help|--help|-h)
    cat <<'HELP'
AI PMS CLI
  aipms auth login [--api-key <key>] [--base-url URL]
  aipms doctor [--json] | context
  aipms context [--project <id|code>] [--status A,B] [--fields f1,f2] [--limit N]
  aipms list projects
  aipms list tasks <project-id>
  aipms get tasks <project-id> <task-id>
  aipms create tasks <project-id> '{"title":"...","acceptanceCriteria":"...","priority":"HIGH"}'
  aipms update tasks <project-id> <task-id> '{"status":"IN_PROGRESS"}'
  aipms delete tasks <project-id> <task-id>
  aipms task-context <task-id>
  aipms task-report <task-id> '{"summary":"...","completedItems":["..."],"verification":"..."}'
  aipms task-accept <task-id> '{"decision":"PASS","conclusion":"...","verificationEvidence":"..."}'
  aipms raw GET /api/v1/...

Resources: projects, requirements, tasks, bugs, versions, releases,
members, milestones, files, folders, teams, notifications, audit-logs.
Guide: ${baseUrl}/cli/guide
HELP
    ;;
  *) echo "Unknown command: $cmd. Run aipms help." >&2; exit 2 ;;
esac
AIPMS_CLI

chmod +x "$BIN_DIR/aipms"
BASE_URL="${baseUrl}"
install_skill
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\"";; esac
echo "AIPMS CLI installed: $BIN_DIR/aipms"
echo "Configuration directory: $INSTALL_DIR"
echo "Opening $BASE_URL so you can create/copy an API Key..."
open_site "$BASE_URL"
printf 'Paste the API Key shown by the website (input hidden): '
read -r -s API_KEY; echo
API_KEY="$(printf '%s' "$API_KEY" | tr -d '\r\n')"
[ -n "$API_KEY" ] || { echo "API Key is required; rerun this installer." >&2; exit 2; }
umask 077
printf 'BASE_URL=%q\nAPI_KEY=%q\n' "$BASE_URL" "$API_KEY" > "$INSTALL_DIR/config"
echo "Configuration saved locally at $INSTALL_DIR/config"
echo "Running capability checks..."
if "$BIN_DIR/aipms" doctor; then
  echo "Capability checks completed."
else
  echo "API Key validation failed or the server is unavailable." >&2
  exit 1
fi
echo "Guide: ${baseUrl}/cli/guide"
`;
}

export async function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  const origin = host ? `${protocol}://${host}` : new URL(request.url).origin;
  return new Response(cliScript(origin), {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Content-Disposition": "inline; filename=install-aipms.sh",
    },
  });
}

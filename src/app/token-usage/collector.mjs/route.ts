import { NextResponse } from "next/server";
import { COLLECTOR_VERSION } from "@/lib/usage-collector";

const script = String.raw`import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "${COLLECTOR_VERSION}";
const quiet = process.argv.includes("--quiet");
const installDir = join(homedir(), ".chorify-usage");
const configPath = join(installDir, "config.json");
const logPath = join(installDir, "collector.log");
const startedAt = Date.now();
let config;
let deviceSecret = "";

function numberOrZero(value) {
  const candidate = Array.isArray(value) ? value[value.length - 1] : value;
  const number = Number(candidate || 0);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function shanghaiDate(value) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function listJsonl(root) {
  const files = [];
  function visit(path) {
    let entries = [];
    try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }
  visit(root);
  return files;
}

function usageEvent(eventHash, date, tool, model, inputTokens, outputTokens, cacheTokens, reasoningTokens, sessions, activeSeconds) {
  return { eventHash, date, tool, model: model || "unknown", inputTokens: numberOrZero(inputTokens), outputTokens: numberOrZero(outputTokens), cacheTokens: numberOrZero(cacheTokens), reasoningTokens: numberOrZero(reasoningTokens), sessions, activeSeconds: numberOrZero(activeSeconds), estimatedCost: null };
}

async function post(path, body) {
  const response = await fetch(config.baseUrl + path, { method: "POST", headers: { authorization: "Bearer " + deviceSecret, "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
  return payload;
}

function scanFile(path, tool, savedLines, activityBackfill) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  let skip = activityBackfill ? 0 : numberOrZero(savedLines);
  if (skip > lines.length) skip = 0;
  const events = [];
  const sessionDays = new Set();
  let previousUsageTimestamp = null;
  let parsedRecords = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let row;
    try { row = JSON.parse(lines[index]); } catch { continue; }
    const currentTimestamp = row.timestamp ? new Date(row.timestamp) : null;
    if (index < skip) continue;
    if (tool === "CODEX" && row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.last_token_usage) {
      const usage = row.payload.info.last_token_usage;
      const date = shanghaiDate(row.timestamp);
      if (!sessionDays.has(date)) { events.push(usageEvent(hashText("session|" + tool + "|" + path + "|" + date), date, tool, "session", 0, 0, 0, 0, 1, 0)); sessionDays.add(date); }
      events.push(usageEvent(hashText("codex|" + path + "|" + row.ordinal + "|" + row.timestamp + "|" + usage.total_tokens), date, tool, "codex", usage.input_tokens, usage.output_tokens, numberOrZero(usage.cached_input_tokens) + numberOrZero(usage.cache_write_input_tokens), usage.reasoning_output_tokens, 0, 0));
      if (previousUsageTimestamp && currentTimestamp) { const gap = Math.floor((currentTimestamp - previousUsageTimestamp) / 1000); if (gap > 0 && gap <= 900) events.push(usageEvent(hashText("activity-v2|CODEX|" + path + "|" + row.timestamp), date, tool, "activity", 0, 0, 0, 0, 0, gap)); }
      if (currentTimestamp && !Number.isNaN(currentTimestamp.valueOf())) previousUsageTimestamp = currentTimestamp;
      parsedRecords += 1;
    }
    if (tool === "CLAUDE" && row.type === "assistant" && row.message?.usage) {
      const usage = row.message.usage;
      const date = shanghaiDate(row.timestamp);
      if (!sessionDays.has(date)) { events.push(usageEvent(hashText("session|" + tool + "|" + path + "|" + date), date, tool, "session", 0, 0, 0, 0, 1, 0)); sessionDays.add(date); }
      events.push(usageEvent(hashText("claude|" + row.uuid + "|" + row.message.id), date, tool, row.message.model, usage.input_tokens, usage.output_tokens, numberOrZero(usage.cache_creation_input_tokens) + numberOrZero(usage.cache_read_input_tokens), 0, 0, 0));
      if (previousUsageTimestamp && currentTimestamp) { const gap = Math.floor((currentTimestamp - previousUsageTimestamp) / 1000); if (gap > 0 && gap <= 900) events.push(usageEvent(hashText("activity-v2|CLAUDE|" + path + "|" + row.timestamp), date, tool, "activity", 0, 0, 0, 0, 0, gap)); }
      if (currentTimestamp && !Number.isNaN(currentTimestamp.valueOf())) previousUsageTimestamp = currentTimestamp;
      parsedRecords += 1;
    }
  }
  return { events, nextLine: lines.length, parsedRecords };
}

async function main() {
  config = JSON.parse(readFileSync(configPath, "utf8"));
  deviceSecret = execFileSync("/usr/bin/security", ["find-generic-password", "-a", config.deviceId, "-s", "cn.sligenai.chorify-usage", "-w"], { encoding: "utf8" }).trim();
  if (!deviceSecret) throw new Error("macOS Keychain 中未找到设备凭据");
  const statePath = config.statePath || join(installDir, "state.json");
  let state = { files: {}, activityVersion: 0 };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch {}
  const activityBackfill = numberOrZero(state.activityVersion) < 2;
  const sources = [
    ...listJsonl(join(homedir(), ".codex", "sessions")).map((path) => ({ path, tool: "CODEX" })),
    ...listJsonl(join(homedir(), ".claude", "projects")).map((path) => ({ path, tool: "CLAUDE" })),
  ];
  const events = [];
  const nextFiles = { ...(state.files || {}) };
  let parsedRecords = 0;
  for (const source of sources) {
    if (!statSync(source.path).isFile()) continue;
    const result = scanFile(source.path, source.tool, nextFiles[source.path] || 0, activityBackfill);
    events.push(...result.events);
    nextFiles[source.path] = result.nextLine;
    parsedRecords += result.parsedRecords;
  }
  let accepted = 0;
  let duplicates = 0;
  for (let offset = 0; offset < events.length; offset += 400) {
    const result = await post("/api/v1/token-usage/batches", { events: events.slice(offset, offset + 400), clientVersion: VERSION });
    accepted += numberOrZero(result.accepted);
    duplicates += numberOrZero(result.duplicates);
  }
  const stateTemp = statePath + ".tmp";
  writeFileSync(stateTemp, JSON.stringify({ files: nextFiles, activityVersion: 2 }, null, 2), { mode: 0o600 });
  renameSync(stateTemp, statePath);
  await post("/api/v1/usage-collectors/heartbeat", { clientVersion: VERSION, status: "HEALTHY", error: null });
  if (!quiet) console.log("扫描完成，用时 " + ((Date.now() - startedAt) / 1000).toFixed(1) + " 秒；扫描 " + sources.length + " 个文件，解析 " + parsedRecords + " 条记录；新增 " + accepted + " 条，重复 " + duplicates + " 条。");
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  try { writeFileSync(logPath, "[" + new Date().toISOString() + "] " + message + "\n", { mode: 0o600 }); } catch {}
  try { if (config && deviceSecret) await post("/api/v1/usage-collectors/heartbeat", { clientVersion: VERSION, status: "ERROR", error: message.slice(0, 500) }); } catch {}
  if (!quiet) console.error(message);
  process.exitCode = 1;
});
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}

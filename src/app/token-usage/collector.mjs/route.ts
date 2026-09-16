import { NextResponse } from "next/server";
import { MAC_COLLECTOR_VERSION } from "@/lib/usage-collector";

const script = String.raw`ObjC.import("Foundation");

var VERSION = "${MAC_COLLECTOR_VERSION}";

function env(name) {
  var value = $.NSProcessInfo.processInfo.environment.objectForKey(name);
  return value ? ObjC.unwrap(value) : "";
}

function readText(path) {
  var data = $.NSData.dataWithContentsOfFile(path);
  if (!data) return null;
  var value = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return value ? ObjC.unwrap(value) : null;
}

function writeText(path, value) {
  var ok = $(value).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  if (!ok) throw new Error("无法写入 " + path);
}

function numberOrZero(value) {
  var candidate = Array.isArray(value) ? value[value.length - 1] : value;
  var number = Number(candidate || 0);
  return isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(value) {
  var ascii = unescape(encodeURIComponent(value));
  var mathPow = Math.pow;
  var maxWord = mathPow(2, 32);
  var words = [];
  var asciiBitLength = ascii.length * 8;
  var hash = sha256.h = sha256.h || [];
  var k = sha256.k = sha256.k || [];
  var primeCounter = k.length;
  var isComposite = {};
  var i;
  var j;
  var result = "";
  for (var candidate = 2; primeCounter < 64; candidate += 1) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      primeCounter += 1;
    }
  }
  ascii += "\x80";
  while (ascii.length % 64 - 56) ascii += "\x00";
  for (i = 0; i < ascii.length; i += 1) {
    j = ascii.charCodeAt(i);
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;
  for (j = 0; j < words.length;) {
    var w = words.slice(j, j += 16);
    var oldHash = hash.slice(0);
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i += 1) {
      var w15 = w[i - 15];
      var w2 = w[i - 2];
      var a = hash[0];
      var e = hash[4];
      var temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ ((~e) & hash[6]))
        + k[i]
        + (w[i] = i < 16 ? w[i] : (
          w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
        ) | 0);
      var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
      hash.pop();
    }
    for (i = 0; i < 8; i += 1) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  for (i = 0; i < 8; i += 1) {
    for (j = 3; j + 1; j -= 1) {
      var byte = (hash[i] >> (j * 8)) & 255;
      result += (byte < 16 ? "0" : "") + byte.toString(16);
    }
  }
  return result;
}

function shanghaiDate(value) {
  var date = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000);
  function two(number) { return number < 10 ? "0" + number : String(number); }
  return date.getUTCFullYear() + "-" + two(date.getUTCMonth() + 1) + "-" + two(date.getUTCDate());
}

function listJsonl(root) {
  var enumerator = $.NSFileManager.defaultManager.enumeratorAtPath(root);
  var files = [];
  if (!enumerator) return files;
  while (true) {
    var item = enumerator.nextObject;
    if (!item) break;
    var relative = ObjC.unwrap(item);
    if (relative.slice(-6) === ".jsonl") files.push(root + "/" + relative);
  }
  return files;
}

function usageEvent(eventHash, date, tool, model, inputTokens, outputTokens, cacheTokens, reasoningTokens, sessions, activeSeconds) {
  return {
    eventHash: eventHash, date: date, tool: tool, model: model || "unknown",
    inputTokens: numberOrZero(inputTokens), outputTokens: numberOrZero(outputTokens),
    cacheTokens: numberOrZero(cacheTokens), reasoningTokens: numberOrZero(reasoningTokens),
    sessions: sessions, activeSeconds: numberOrZero(activeSeconds), estimatedCost: null
  };
}

function scanFile(path, tool, savedLines, activityBackfill) {
  var text = readText(path);
  if (text === null) return { events: [], nextLine: numberOrZero(savedLines), parsedRecords: 0 };
  var lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  var skip = activityBackfill ? 0 : numberOrZero(savedLines);
  if (skip > lines.length) skip = 0;
  var events = [];
  var sessionDays = {};
  var previousUsageTimestamp = null;
  var parsedRecords = 0;
  for (var index = 0; index < lines.length; index += 1) {
    var row;
    try { row = JSON.parse(lines[index]); } catch (error) { continue; }
    var currentTimestamp = row.timestamp ? new Date(row.timestamp) : null;
    if (index < skip) continue;
    if (tool === "CODEX" && row.type === "event_msg" && row.payload && row.payload.type === "token_count" && row.payload.info && row.payload.info.last_token_usage) {
      var usage = row.payload.info.last_token_usage;
      var date = shanghaiDate(row.timestamp);
      if (!sessionDays[date]) {
        events.push(usageEvent(sha256("session|" + tool + "|" + path + "|" + date), date, tool, "session", 0, 0, 0, 0, 1, 0));
        sessionDays[date] = true;
      }
      events.push(usageEvent(sha256("codex|" + path + "|" + row.ordinal + "|" + row.timestamp + "|" + usage.total_tokens), date, tool, "codex", usage.input_tokens, usage.output_tokens, numberOrZero(usage.cached_input_tokens) + numberOrZero(usage.cache_write_input_tokens), usage.reasoning_output_tokens, 0, 0));
      if (previousUsageTimestamp && currentTimestamp) {
        var codexGap = Math.floor((currentTimestamp.getTime() - previousUsageTimestamp.getTime()) / 1000);
        if (codexGap > 0 && codexGap <= 900) events.push(usageEvent(sha256("activity-v2|CODEX|" + path + "|" + row.timestamp), date, tool, "activity", 0, 0, 0, 0, 0, codexGap));
      }
      if (currentTimestamp && !isNaN(currentTimestamp.getTime())) previousUsageTimestamp = currentTimestamp;
      parsedRecords += 1;
    }
    if (tool === "CLAUDE" && row.type === "assistant" && row.message && row.message.usage) {
      var claudeUsage = row.message.usage;
      var claudeDate = shanghaiDate(row.timestamp);
      if (!sessionDays[claudeDate]) {
        events.push(usageEvent(sha256("session|" + tool + "|" + path + "|" + claudeDate), claudeDate, tool, "session", 0, 0, 0, 0, 1, 0));
        sessionDays[claudeDate] = true;
      }
      events.push(usageEvent(sha256("claude|" + row.uuid + "|" + row.message.id), claudeDate, tool, row.message.model, claudeUsage.input_tokens, claudeUsage.output_tokens, numberOrZero(claudeUsage.cache_creation_input_tokens) + numberOrZero(claudeUsage.cache_read_input_tokens), 0, 0, 0));
      if (previousUsageTimestamp && currentTimestamp) {
        var claudeGap = Math.floor((currentTimestamp.getTime() - previousUsageTimestamp.getTime()) / 1000);
        if (claudeGap > 0 && claudeGap <= 900) events.push(usageEvent(sha256("activity-v2|CLAUDE|" + path + "|" + row.timestamp), claudeDate, tool, "activity", 0, 0, 0, 0, 0, claudeGap));
      }
      if (currentTimestamp && !isNaN(currentTimestamp.getTime())) previousUsageTimestamp = currentTimestamp;
      parsedRecords += 1;
    }
  }
  return { events: events, nextLine: lines.length, parsedRecords: parsedRecords };
}

function registrationJson() {
  return JSON.stringify({ registrationCode: env("REGISTRATION_CODE"), deviceId: env("DEVICE_ID"), deviceName: env("DEVICE_NAME"), platform: "macos", clientVersion: VERSION });
}

function configJson() {
  return JSON.stringify({ baseUrl: env("BASE_URL"), deviceId: env("DEVICE_ID"), clientVersion: VERSION, statePath: env("STATE_PATH") }, null, 2);
}

function scan(statePath, outputDirectory, homeOverride) {
  var state = { files: {}, activityVersion: 0 };
  var stateText = readText(statePath);
  if (stateText) { try { state = JSON.parse(stateText); } catch (error) {} }
  var activityBackfill = numberOrZero(state.activityVersion) < 2;
  var home = homeOverride || ObjC.unwrap($.NSHomeDirectory());
  var sources = [];
  listJsonl(home + "/.codex/sessions").forEach(function(path) { sources.push({ path: path, tool: "CODEX" }); });
  listJsonl(home + "/.claude/projects").forEach(function(path) { sources.push({ path: path, tool: "CLAUDE" }); });
  var events = [];
  var nextFiles = state.files || {};
  var parsedRecords = 0;
  sources.forEach(function(source) {
    var result = scanFile(source.path, source.tool, nextFiles[source.path] || 0, activityBackfill);
    events = events.concat(result.events);
    nextFiles[source.path] = result.nextLine;
    parsedRecords += result.parsedRecords;
  });
  var batchCount = 0;
  for (var offset = 0; offset < events.length; offset += 400) {
    var suffix = String(batchCount);
    while (suffix.length < 5) suffix = "0" + suffix;
    writeText(outputDirectory + "/batch-" + suffix + ".json", JSON.stringify({ events: events.slice(offset, offset + 400), clientVersion: VERSION }));
    batchCount += 1;
  }
  writeText(outputDirectory + "/next-state.json", JSON.stringify({ files: nextFiles, activityVersion: 2 }, null, 2));
  return JSON.stringify({ sources: sources.length, parsedRecords: parsedRecords, batches: batchCount });
}

function run(argv) {
  var mode = argv[0] || "scan";
  if (mode === "registration") return registrationJson();
  if (mode === "config") return configJson();
  if (mode === "self-test") return JSON.stringify({ version: VERSION, sha256: sha256("abc"), codex: ".codex/sessions", claude: ".claude/projects" });
  if (!argv[1] || !argv[2]) throw new Error("缺少状态文件或输出目录");
  return scan(argv[1], argv[2], argv[3]);
}
`;

export async function GET() {
  return new NextResponse(script, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
}

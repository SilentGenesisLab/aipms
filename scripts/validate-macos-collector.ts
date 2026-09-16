import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as getCollector } from "../src/app/token-usage/collector.mjs/route";
import { GET as getInstaller } from "../src/app/token-usage/install.sh/route";

async function main() {
  if (process.platform !== "darwin") throw new Error("This validation must run on macOS");

  const directory = mkdtempSync(join(tmpdir(), "chorify-mac-collector-"));
  try {
    const collector = await (await getCollector()).text();
    const installer = await (await getInstaller()).text();
    const collectorPath = join(directory, "collector.jxa");
    const installerPath = join(directory, "install.sh");
    const plistPath = join(directory, "cn.sligenai.chorify-usage.plist");
    const fixtureHome = join(directory, "home");
    const codexDirectory = join(fixtureHome, ".codex", "sessions");
    const claudeDirectory = join(fixtureHome, ".claude", "projects", "sample");
    const outputDirectory = join(directory, "output");
    const statePath = join(directory, "state.json");
    writeFileSync(collectorPath, collector);
    writeFileSync(installerPath, installer);
    execFileSync("/bin/bash", ["-n", installerPath], { stdio: "inherit" });

    const selfTest = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", collectorPath, "self-test"], { encoding: "utf8" }));
    if (selfTest.sha256 !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error("JXA SHA-256 self-test failed");

    mkdirSync(codexDirectory, { recursive: true });
    mkdirSync(claudeDirectory, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(codexDirectory, "codex.jsonl"), `${JSON.stringify({ timestamp: "2026-09-16T00:00:00.000Z", ordinal: 1, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 4, cached_input_tokens: 2, reasoning_output_tokens: 1, total_tokens: 17 } } } })}\n`);
    writeFileSync(join(claudeDirectory, "claude.jsonl"), `${JSON.stringify({ timestamp: "2026-09-16T00:01:00.000Z", uuid: "fixture-uuid", type: "assistant", message: { id: "fixture-message", model: "claude-test", usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 2 } } })}\n`);
    const summary = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", collectorPath, "scan", statePath, outputDirectory, fixtureHome], { encoding: "utf8" }));
    const batch = JSON.parse(readFileSync(join(outputDirectory, "batch-00000.json"), "utf8"));
    const nextState = JSON.parse(readFileSync(join(outputDirectory, "next-state.json"), "utf8"));
    if (summary.sources !== 2 || summary.parsedRecords !== 2) throw new Error("JXA fixture scan summary is incorrect");
    if (batch.events.length !== 4 || !batch.events.some((event: { model: string }) => event.model === "claude-test")) throw new Error("JXA fixture events are incorrect");
    if (nextState.activityVersion !== 2 || Object.keys(nextState.files).length !== 2) throw new Error("JXA fixture state is incorrect");

    const plist = installer.match(/cat > "\$PLIST_PATH" <<PLIST\n([\s\S]*?)\nPLIST/)?.[1];
    if (!plist) throw new Error("LaunchAgent plist template not found");
    writeFileSync(plistPath, plist.replaceAll("$COLLECTOR_PATH", "/Users/test/.chorify-usage/collector.sh").replaceAll("$LOG_PATH", "/Users/test/.chorify-usage/collector.log"));
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "inherit" });
    console.log("Zero-dependency macOS collector, fixture scan, installer, and LaunchAgent plist validation passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

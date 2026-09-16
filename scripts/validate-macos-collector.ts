import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const collectorPath = join(directory, "collector.mjs");
    const installerPath = join(directory, "install.sh");
    const plistPath = join(directory, "cn.sligenai.chorify-usage.plist");
    writeFileSync(collectorPath, collector);
    writeFileSync(installerPath, installer);
    execFileSync(process.execPath, ["--check", collectorPath], { stdio: "inherit" });
    execFileSync("/bin/bash", ["-n", installerPath], { stdio: "inherit" });

    const plist = installer.match(/cat > "\$PLIST_PATH" <<PLIST\n([\s\S]*?)\nPLIST/)?.[1];
    if (!plist) throw new Error("LaunchAgent plist template not found");
    writeFileSync(plistPath, plist.replaceAll("$NODE_PATH", "/usr/local/bin/node").replaceAll("$COLLECTOR_PATH", "/Users/test/.chorify-usage/collector.mjs").replaceAll("$LOG_PATH", "/Users/test/.chorify-usage/collector.log"));
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "inherit" });
    console.log("macOS collector, installer, and LaunchAgent plist validation passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

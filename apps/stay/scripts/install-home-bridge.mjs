import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHomeState } from "../src/lib/home-assistant.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envFile = join(root, "private/home-bridge.env");
const tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const label = "build.bent.apartment-controls";
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${label}`;
const port = 18231;
const httpsPort = 10000;

function xml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function setEnv(key, value) {
  const lines = readFileSync(envFile, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith(`${key}=`));
  lines.push(`${key}=${JSON.stringify(value)}`);
  writeFileSync(envFile, lines.filter(Boolean).join("\n") + "\n", {
    mode: 0o600,
  });
  chmodSync(envFile, 0o600);
}

async function install() {
  if (process.platform !== "darwin" || !/mac-mini/i.test(hostname()))
    throw new Error("Run this setup on the configured macOS controls host.");
  if (
    process.env.HOME_CONTROL_BRIDGE_PORT &&
    Number(process.env.HOME_CONTROL_BRIDGE_PORT) !== port
  )
    throw new Error("The installer uses local port 18231.");
  // Check the real entities without changing any devices before installing or exposing anything.
  const state = await getHomeState();
  if (
    state.lights.livingRoom === null ||
    state.lights.bedroom === null ||
    !state.vacuum.actions.length
  )
    throw new Error(
      "Check the room helpers and vacuum in Home Assistant first.",
    );
  const status = JSON.parse(run(tailscale, ["serve", "status", "--json"]));
  const existing = Object.entries(status.Web ?? {}).find(([host]) =>
    host.endsWith(`:${httpsPort}`),
  )?.[1];
  if (
    status.TCP?.[httpsPort] &&
    existing?.Handlers?.["/"]?.Proxy !== `http://127.0.0.1:${port}`
  )
    throw new Error(
      "Tailscale port 10000 is already in use. Keep its existing configuration and select a different bridge connection.",
    );
  const token =
    process.env.HOME_CONTROL_BRIDGE_TOKEN || randomBytes(32).toString("hex");
  if (token.length < 32)
    throw new Error("The bridge token must be at least 32 characters.");
  setEnv("HOME_CONTROL_BRIDGE_TOKEN", token);
  setEnv("HOME_CONTROL_BRIDGE_PORT", String(port));
  mkdirSync(dirname(plist), { recursive: true });
  const args = [
    process.execPath,
    "--conditions=react-server",
    `--env-file=${envFile}`,
    join(root, "scripts/home-bridge.mjs"),
  ];
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(root, "private/home-bridge.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, "private/home-bridge-error.log"))}</string>
</dict></plist>\n`;
  writeFileSync(plist, contents, { mode: 0o600 });
  run("plutil", ["-lint", plist]);
  try {
    run("launchctl", ["bootout", service]);
  } catch {
    /* First installation has no existing service. */
  }
  // bootout can return before launchd removes the registration.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      run("launchctl", ["print", service]);
    } catch {
      break;
    }
    if (attempt === 19)
      throw new Error(
        "The previous bridge is still stopping. Retry setup shortly.",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  run("launchctl", ["bootstrap", domain, plist]);
  run("launchctl", ["kickstart", "-k", service]);
  let ready = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/state`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(9000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Allow launchd a moment to start. */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready)
    throw new Error(
      "The local bridge did not start. Check its private log files.",
    );
  process.stdout.write(
    "Local bridge verified. Enabling only its limited endpoints on Tailscale port 10000.\n",
  );
  try {
    // Separate port: preserve the private Home Assistant route on 443 and the existing route on 8443.
    execFileSync(
      tailscale,
      ["funnel", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`],
      { stdio: "inherit" },
    );
  } catch {
    throw new Error(
      "Tailscale Funnel needs authorization. The local bridge is running; finish Funnel approval and retry its command from the README.",
    );
  }
  process.stdout.write(
    "Bridge installed. Configure its URL and bridge token in the guide server environment, then redeploy. Home Assistant's token stays on the Mac mini.\n",
  );
}

install().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Bridge installation failed."}\n`,
  );
  process.exitCode = 1;
});

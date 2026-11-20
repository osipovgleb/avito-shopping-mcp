import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CHROME_HOST_NAME, chromeBridgeDirectory } from "./chrome-bridge.js";
import { AvitoMcpError } from "./errors.js";

export async function installChromeBridge() {
  const chromeDirectory = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
    : join(homedir(), ".config", "google-chrome");
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new AvitoMcpError("BROWSER_UNAVAILABLE", "Chrome bridge installation is supported on macOS and Linux.");
  }

  const extensionDirectory = fileURLToPath(new URL("../chrome-extension/", import.meta.url));
  const { key } = JSON.parse(await readFile(join(extensionDirectory, "manifest.json"), "utf8")) as { key: string };
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  const extensionId = [...digest.slice(0, 32)].map(value => String.fromCharCode(97 + Number.parseInt(value, 16))).join("");

  const hostScript = fileURLToPath(new URL("./chrome-native-host.js", import.meta.url));
  await access(hostScript);
  const launcher = join(chromeBridgeDirectory(), "native-host");
  const manifest = join(chromeDirectory, "NativeMessagingHosts", `${CHROME_HOST_NAME}.json`);
  await mkdir(dirname(launcher), { recursive: true, mode: 0o700 });
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  await writeFile(launcher, `#!/bin/sh\nexec ${shellArg(process.execPath)} ${shellArg(hostScript)}\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  await writeFile(manifest, JSON.stringify({
    name: CHROME_HOST_NAME,
    description: "Avito for Codex native messaging host",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2) + "\n", { mode: 0o600 });
  return { extensionDirectory, extensionId };
}

function shellArg(text: string): string {
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

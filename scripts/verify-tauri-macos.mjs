#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_APP_PATH = path.join(
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Amos Console.app",
);
const DEFAULT_DMG_DIR = path.join("src-tauri", "target", "release", "bundle", "dmg");
const APP_BUNDLE_NAME = "Amos Console.app";
const SERVE_TIMEOUT_MS = 15_000;
const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function fail(message) {
  throw new Error(message);
}

function requireFile(file, label) {
  if (!existsSync(file)) fail(`${label} is missing: ${file}`);
  if (!statSync(file).isFile()) fail(`${label} is not a file: ${file}`);
}

function requireDirectory(directory, label) {
  if (!existsSync(directory)) fail(`${label} is missing: ${directory}`);
  if (!statSync(directory).isDirectory()) fail(`${label} is not a directory: ${directory}`);
}

function verifySignature(args, label) {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
  if (result.error) {
    fail(`${label} codesign could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`${label} codesign verification failed (exit ${result.status}): ${detail}`);
  }
}

function findUniqueDmg(directory) {
  requireDirectory(directory, "dmg output directory");
  const images = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".dmg"))
    .filter((name) => statSync(path.join(directory, name)).isFile());
  if (images.length === 0) {
    fail(`no .dmg image found in ${directory}`);
  }
  if (images.length > 1) {
    fail(`multiple .dmg images found in ${directory}: ${images.join(", ")}`);
  }
  return path.join(directory, images[0]);
}

function attachDmg(dmgPath, mountPoint) {
  requireFile(dmgPath, "dmg image");
  mkdirSync(mountPoint, { recursive: true });
  const result = spawnSync(
    "hdiutil",
    ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath],
    { encoding: "utf8" },
  );
  if (result.error) {
    fail(`hdiutil attach could not run for ${dmgPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`hdiutil attach failed (exit ${result.status}) for ${dmgPath}: ${detail}`);
  }
}

function detachDmg(mountPoint) {
  const result = spawnSync("hdiutil", ["detach", mountPoint], { encoding: "utf8" });
  if (result.error) {
    fail(`hdiutil detach could not run for ${mountPoint}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`hdiutil detach failed (exit ${result.status}) for ${mountPoint}: ${detail}`);
  }
}

function resolveBundle(input, tempRoot) {
  const mountPoint = path.join(tempRoot, "mount");

  if (input !== undefined) {
    const target = path.resolve(input);
    const extension = path.extname(target).toLowerCase();
    if (extension === ".app") {
      return { appPath: target, mountPoint: null };
    }
    if (extension === ".dmg") {
      attachDmg(target, mountPoint);
      return { appPath: path.join(mountPoint, APP_BUNDLE_NAME), mountPoint };
    }
    fail(`unsupported bundle path, expected .app or .dmg: ${target}`);
  }

  const defaultApp = path.resolve(DEFAULT_APP_PATH);
  if (existsSync(defaultApp)) {
    return { appPath: defaultApp, mountPoint: null };
  }

  const dmgPath = findUniqueDmg(path.resolve(DEFAULT_DMG_DIR));
  attachDmg(dmgPath, mountPoint);
  return { appPath: path.join(mountPoint, APP_BUNDLE_NAME), mountPoint };
}

function killChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      clearTimeout(force);
      resolve();
    };
    const grace = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    const force = setTimeout(finish, 5_500);
    child.once("exit", finish);
    child.once("error", finish);
    child.kill("SIGTERM");
  });
}

function waitForConsoleUrl(child, stderrBuffer) {
  return new Promise((resolve, reject) => {
    if (!child.stdout) {
      reject(new Error("failed to capture stdout from the bundled node"));
      return;
    }

    const reader = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      finish(() =>
        reject(new Error(`timed out after ${SERVE_TIMEOUT_MS}ms waiting for the console URL`)),
      );
    }, SERVE_TIMEOUT_MS);
    timer.unref?.();

    let settled = false;
    function finish(action) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close();
      action();
    }

    reader.on("line", (line) => {
      const match = /本地控制台:\s*(\S+)/.exec(line);
      if (match) finish(() => resolve(match[1]));
    });

    child.once("error", (error) => {
      finish(() => reject(new Error(`failed to start the bundled node: ${error.message}`)));
    });

    child.once("exit", (code, signal) => {
      const detail = stderrBuffer().trim();
      finish(() =>
        reject(
          new Error(
            `control plane exited before reporting its URL (code ${code}, signal ${signal})` +
              (detail ? `: ${detail}` : ""),
          ),
        ),
      );
    });
  });
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("verify-tauri-macos: skipped on non-macOS host");
    return;
  }

  const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "amos-tauri-verify-"));
  let child;
  let mountPoint = null;
  let appPath;
  let primaryError = null;

  try {
    const resolved = resolveBundle(process.argv[2], tempRoot);
    appPath = resolved.appPath;
    mountPoint = resolved.mountPoint;

    requireDirectory(appPath, "app bundle");

    const contentsDir = path.join(appPath, "Contents");
    const resourcesDir = path.join(contentsDir, "Resources");
    const appRoot = path.join(resourcesDir, "app");
    const nodePath = path.join(contentsDir, "MacOS", "node");
    const cliPath = path.join(appRoot, "dist", "control-plane", "cli.js");
    const unexpectedResourceDir = path.join(resourcesDir, "_up_");

    requireFile(nodePath, "bundled node sidecar");
    requireFile(cliPath, "control plane CLI");
    requireFile(path.join(appRoot, "package.json"), "staged runtime package.json");
    requireDirectory(path.join(appRoot, "node_modules", "yaml"), "staged yaml dependency");
    requireFile(path.join(appRoot, "constraints", "rules.yaml"), "staged constraints rules");
    requireFile(path.join(appRoot, "dist", "console", "index.html"), "bundled console index");

    if (existsSync(unexpectedResourceDir)) {
      fail(`unexpected resource directory present: ${unexpectedResourceDir}`);
    }

    verifySignature(["--verify", "--strict", nodePath], "bundled node sidecar");
    verifySignature(["--verify", "--deep", "--strict", appPath], "app bundle");

    const dataDir = path.join(tempRoot, "data");
    const homeDir = path.join(tempRoot, "home");
    mkdirSync(dataDir);
    mkdirSync(homeDir);

    let stderr = "";
    const deadline = Date.now() + SERVE_TIMEOUT_MS;

    child = spawn(nodePath, [cliPath, "serve", "--port", "0"], {
      cwd: dataDir,
      env: { PATH: MINIMAL_PATH, HOME: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 20_000) stderr += chunk;
    });

    try {
      const url = await waitForConsoleUrl(child, () => stderr);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        fail(`timed out after ${SERVE_TIMEOUT_MS}ms before fetching the console URL`);
      }

      let response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(remaining) });
      } catch (error) {
        fail(`console URL did not respond: ${error.message}`);
      }
      if (response.status !== 200) {
        fail(`console URL returned HTTP ${response.status}: ${url}`);
      }
      await response.arrayBuffer();
    } catch (error) {
      if (stderr.trim()) {
        fail(`${error.message}\n${stderr.trim()}`);
      }
      throw error;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (child) await killChild(child);

    let cleanupError = null;
    if (mountPoint !== null) {
      try {
        detachDmg(mountPoint);
      } catch (error) {
        cleanupError = error;
      }
    }

    if (cleanupError === null) {
      rmSync(tempRoot, { recursive: true, force: true });
    } else if (primaryError !== null) {
      console.error(`verify-tauri-macos: ${cleanupError.message}`);
    } else {
      throw cleanupError;
    }
  }

  console.log(`verify-tauri-macos: verified ${appPath}`);
}

main().catch((error) => {
  console.error(`verify-tauri-macos: ${error.message}`);
  process.exitCode = 1;
});

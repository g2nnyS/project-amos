#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(repoRoot, "src-tauri", ".runtime");
const binariesDir = path.join(repoRoot, "src-tauri", "binaries");
const repoModulesDir = path.join(repoRoot, "node_modules");
const runtimeModulesDir = path.join(runtimeDir, "node_modules");

function fail(message) {
  console.error(`prepare-tauri-runtime: ${message}`);
  process.exit(1);
}

function listProductionClosure() {
  const args = ["ls", "--omit=dev", "--all", "--parseable", "--workspaces=false"];
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "npm";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });

  if (result.error) {
    fail(`unable to run npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`npm ls exited with ${result.status}\n${result.stderr ?? ""}`.trim());
  }

  const entries = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const absolute = path.resolve(value);
    if (absolute === repoRoot) continue;
    const relative = path.relative(repoModulesDir, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    entries.add(relative);
  }
  return [...entries].sort();
}

function hostTargetTriple() {
  const { platform, arch } = process;

  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";

  fail(`unsupported host for Tauri runtime staging: ${platform}/${arch}`);
}

function copyNodeSidecar() {
  rmSync(binariesDir, { recursive: true, force: true });
  if (process.platform === "linux") return null;

  const triple = hostTargetTriple();
  mkdirSync(binariesDir, { recursive: true });

  const fileName = `node-${triple}${process.platform === "win32" ? ".exe" : ""}`;
  const destination = path.join(binariesDir, fileName);
  cpSync(process.execPath, destination, { force: true });
  if (process.platform !== "win32") chmodSync(destination, 0o755);
  return destination;
}

function verifyDirectDependencies() {
  const { dependencies = {} } = JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const requireFromStaging = createRequire(path.join(runtimeDir, "package.json"));
  const unresolved = [];

  for (const name of Object.keys(dependencies).sort()) {
    try {
      const resolved = requireFromStaging.resolve(name);
      const relative = path.relative(runtimeModulesDir, resolved);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        unresolved.push(name);
      }
    } catch {
      unresolved.push(name);
    }
  }

  if (unresolved.length > 0) {
    fail(`staged dependencies do not resolve: ${unresolved.join(", ")}`);
  }
  return Object.keys(dependencies).length;
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeModulesDir, { recursive: true });

const packages = listProductionClosure();
for (const relative of packages) {
  cpSync(path.join(repoModulesDir, relative), path.join(runtimeModulesDir, relative), {
    recursive: true,
    force: true,
    dereference: true,
  });
}

writeFileSync(
  path.join(runtimeDir, "package.json"),
  `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
);

const nodeSidecar = copyNodeSidecar();
const dependencyCount = verifyDirectDependencies();

console.log(`prepare-tauri-runtime: staged ${packages.length} packages into ${runtimeDir}`);
console.log(
  nodeSidecar
    ? `prepare-tauri-runtime: node sidecar at ${nodeSidecar}`
    : "prepare-tauri-runtime: Linux uses Node.js 26+ from PATH",
);
console.log(
  `prepare-tauri-runtime: ${dependencyCount} direct production dependencies resolve from staging`,
);

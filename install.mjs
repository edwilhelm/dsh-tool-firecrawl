#!/usr/bin/env node
/**
 * dsh-tool-firecrawl install/uninstall script.
 *
 * Installs the `firecrawl_search` native tool into your DeepSeek Harness by
 * copying the package into the profile node_modules and adding a patch row to
 * each profile's cordis.patch.yml (or the home patch, with --home-patch).
 *
 * Usage:
 *   node install.mjs                 # install (default)
 *   node install.mjs --uninstall     # remove
 *   node install.mjs --status        # check if installed
 *   node install.mjs --home ~/.dsh   # custom DSH home
 *   node install.mjs --profile web   # single profile
 *   node install.mjs --home-patch    # use home patch instead of per-profile
 *
 * Cross-platform (Windows, macOS, Linux). No external dependencies.
 * @module @deepseek-ai/dsh-tool-firecrawl/install
 */
'use strict';

import { argv, exit, stdout } from "node:process";
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EOL } from "node:os";

// ══════════════════════════════════════════════════════════════════════════════
//  Constants
// ══════════════════════════════════════════════════════════════════════════════

const PACKAGE_NAME = "dsh-tool-firecrawl";
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_FILES = ["package.json", "README.md", "LICENSE", "lib"];

const PATCH_START = "# ===== dsh-tool-firecrawl (managed by install.mjs \u2014 do not edit) =====";
const PATCH_END   = "# ===== end dsh-tool-firecrawl =====";
const PATCH_BLOCK =
`${PATCH_START}
- insert:
    - id: tool-firecrawl
      name: '@deepseek-ai/dsh-tool-firecrawl'
${PATCH_END}
`;

// ══════════════════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════════════════

function log(...args) {
  stdout.write(args.join(" ") + EOL);
}

function warn(...args) {
  log("WARN:", ...args);
}

function err(...args) {
  log("ERROR:", ...args);
}

/** Resolve the DSH home directory. */
function resolveHome(cliHome) {
  if (cliHome) return resolve(cliHome);
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("Cannot determine home directory; set DSH_HOME or pass --home");
  return join(home, ".dsh");
}

/** Whether two paths point to the same filesystem entry (resolves junctions/symlinks). */
function samePath(a, b) {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return false;
  }
}

/** Whether the target is a junction (reparse point) or symlink. */
function isLink(path) {
  try {
    const st = lstatSync(path);
    // On Windows, junctions are reparse points; lstat.isSymbolicLink() is false
    // for junctions in Node, but isDirectory() is true. We check by comparing
    // realpath to resolved path: if they differ, it's a link/junction.
    // Actually realpath on a junction resolves through it, so realpath != resolved
    // parent + basename. Safer: just check if directory and realpath differs from
    // the path's own parent-relative target.
    // Simplest reliable check: realpathSync(path) !== resolve(path)
    // But resolve(path) normalizes; realpath resolves links. So:
    if (st.isDirectory() || st.isSymbolicLink()) {
      try {
        const rp = realpathSync(path);
        const norm = resolve(path);
        // If the forward-slash-normalized paths differ, it's a junction/symlink
        return rp.toLowerCase() !== norm.toLowerCase();
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Copy a file or directory tree. */
function copyEntry(src, dst) {
  const st = lstatSync(src);
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      copyEntry(join(src, entry), join(dst, entry));
    }
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/** Whether a YAML content contains a `tool-firecrawl` row (managed or bare). */
function hasToolRow(content) {
  if (content.includes(PATCH_START)) return true;
  // Match a line like "    - id: tool-firecrawl" (indented or not)
  return /^\s*- id: tool-firecrawl\s*$/m.test(content);
}

/** Remove a bare `- id: tool-firecrawl` row (id line + following name line) from content. */
function removeBareToolRow(content) {
  // Match two consecutive lines: `    - id: tool-firecrawl` followed by `      name: ...`
  // Preserve surrounding blank lines.
  return content.replace(/^[ \t]*- id: tool-firecrawl\s*[\r]\n+[ \t]*name: .*[\r]?\n?/gm, "");
}

/** Remove a managed block from a YAML-ish file content. */
function removeManagedBlock(content, startMarker, endMarker) {
  const start = content.indexOf(startMarker);
  if (start === -1) return content;
  const end = content.indexOf(endMarker, start);
  if (end === -1) return content;
  const endIdx = end + endMarker.length;
  // Strip surrounding blank lines and whitespace
  let removeStart = start;
  while (removeStart > 0 && (content[removeStart - 1] === "\n" || content[removeStart - 1] === "\r")) removeStart--;
  let removeEnd = endIdx;
  while (removeEnd < content.length && (content[removeEnd] === "\n" || content[removeEnd] === "\r")) removeEnd++;
  return (content.slice(0, removeStart) + content.slice(removeEnd)).trimEnd() + EOL;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Parse CLI arguments
// ══════════════════════════════════════════════════════════════════════════════

const args = argv.slice(2);
const opts = {
  mode: "install",     // install | uninstall | status
  home: null,
  profiles: [],
  homePatch: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--uninstall" || a === "-u") opts.mode = "uninstall";
  else if (a === "--status" || a === "-s") opts.mode = "status";
  else if (a === "--home-patch" || a === "-H") opts.homePatch = true;
  else if ((a === "--home" || a === "-h") && i + 1 < args.length) opts.home = args[++i];
  else if ((a === "--profile" || a === "-p") && i + 1 < args.length) opts.profiles.push(args[++i]);
  else if (a === "--help" || a === "-?") {
    log(`Usage: node install.mjs [options]
Options:
  --install / -i              Install (default)
  --uninstall / -u            Remove the tool
  --status / -s               Check installation status
  --home <dir> / -h <dir>     DSH home directory (default: \$DSH_HOME or ~/.dsh)
  --profile <name> / -p <name> Target profile(s) (repeatable; default: all)
  --home-patch / -H           Use the home patch instead of per-profile patches
  --help / -?                 Show this help`);
    exit(0);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Resolve paths
// ══════════════════════════════════════════════════════════════════════════════

let dshHome;
try {
  dshHome = resolveHome(opts.home);
} catch (e) {
  err(e.message);
  exit(1);
}

const profilesDir = join(dshHome, "profiles");
const targetDir = join(profilesDir, "node_modules", "@deepseek-ai", PACKAGE_NAME);
const homePatchPath = join(dshHome, "cordis.patch.yml");

// ══════════════════════════════════════════════════════════════════════════════
//  Status
// ══════════════════════════════════════════════════════════════════════════════

function printStatus() {
  const packageOk = existsSync(targetDir) && (isLink(targetDir) || lstatSync(targetDir).isDirectory());
  if (!packageOk) {
    log("Status: NOT INSTALLED (package directory not found)");
    return;
  }
  const linkInfo = isLink(targetDir) ? ` (junction/symlink to ${realpathSync(targetDir)})` : " (copy)";
  log(`Package: ${targetDir}${linkInfo}`);

  if (opts.homePatch) {
    const homeOk = existsSync(homePatchPath) && hasToolRow(readFileSync(homePatchPath, "utf8"));
    log(`Home patch: ${homeOk ? "ROW PRESENT" : "ROW MISSING"} (${homePatchPath})`);
  }

  if (existsSync(profilesDir)) {
    for (const profile of readdirSync(profilesDir)) {
      const pp = join(profilesDir, profile, "cordis.patch.yml");
      if (!existsSync(pp)) continue;
      const content = readFileSync(pp, "utf8");
      if (hasToolRow(content)) {
        log(`Profile "${profile}": ROW PRESENT (${pp})`);
      }
    }
  }
}

if (opts.mode === "status") {
  printStatus();
  exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
//  Install
// ══════════════════════════════════════════════════════════════════════════════

function installPackage() {
  if (existsSync(targetDir)) {
    if (samePath(targetDir, SOURCE_DIR)) {
      log(`Package already installed via junction/symlink to this repo.`);
      return;
    }
    // Remove existing (junction, copy, or symlink)
    rmSync(targetDir, { recursive: true, force: true });
    log(`Removed existing installation at ${targetDir}`);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const entry of PACKAGE_FILES) {
    const src = join(SOURCE_DIR, entry);
    const dst = join(targetDir, entry);
    if (!existsSync(src)) {
      warn(`Source file missing: ${src} — skipping`);
      continue;
    }
    copyEntry(src, dst);
  }
  log(`Package copied to ${targetDir}`);
}

function installPatches() {
  const patchFiles = [];

  if (opts.homePatch) {
    patchFiles.push({ path: homePatchPath, label: "home patch" });
  } else {
    if (!existsSync(profilesDir)) {
      warn(`No profiles directory found at ${profilesDir} — skipping patch insertion`);
      return;
    }
    const profileNames = opts.profiles.length > 0
      ? opts.profiles
      : readdirSync(profilesDir).filter(p => existsSync(join(profilesDir, p, "cordis.patch.yml")));
    for (const profile of profileNames) {
      patchFiles.push({ path: join(profilesDir, profile, "cordis.patch.yml"), label: `profile "${profile}"` });
    }
  }

  if (patchFiles.length === 0) {
    warn("No patch files to modify — tool will not be visible without a patch row");
    return;
  }

  for (const { path, label } of patchFiles) {
    let content = "";
    if (existsSync(path)) {
      content = readFileSync(path, "utf8");
    }
    if (hasToolRow(content)) {
      log(`Patch row already present in ${label} (${path}) — skipping`);
      continue;
    }
    // Ensure file ends with newline before appending
    if (content.length > 0 && !content.endsWith("\n")) content += EOL;
    content += PATCH_BLOCK;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    log(`Patch row added to ${label} (${path})`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Uninstall
// ══════════════════════════════════════════════════════════════════════════════

function uninstallPackage() {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    log(`Removed package: ${targetDir}`);
  } else {
    log(`Package not found at ${targetDir} — nothing to remove`);
  }
}

function uninstallPatches() {
  const patchFiles = [];

  if (opts.homePatch) {
    patchFiles.push({ path: homePatchPath, label: "home patch" });
  } else {
    if (!existsSync(profilesDir)) {
      warn(`No profiles directory found at ${profilesDir}`);
      return;
    }
    const profileNames = opts.profiles.length > 0
      ? opts.profiles
      : readdirSync(profilesDir).filter(p => existsSync(join(profilesDir, p, "cordis.patch.yml")));
    for (const profile of profileNames) {
      patchFiles.push({ path: join(profilesDir, profile, "cordis.patch.yml"), label: `profile "${profile}"` });
    }
  }

  if (patchFiles.length === 0) {
    log("No patch files to clean up");
    return;
  }

  for (const { path, label } of patchFiles) {
    if (!existsSync(path)) {
      log(`Patch file not found in ${label} (${path}) — skipping`);
      continue;
    }
    let content = readFileSync(path, "utf8");
    const before = content.length;
    content = removeManagedBlock(content, PATCH_START, PATCH_END);
    content = removeBareToolRow(content);
    if (content.length === before) {
      log(`No managed block or bare row found in ${label} (${path}) — skipping`);
      continue;
    }
    // Write back even if empty (allows full removal)
    writeFileSync(path, content, "utf8");
    // If the file is now empty or has only whitespace, remove it
    if (content.trim().length === 0) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
      log(`Removed emptied patch file: ${path}`);
    }
    log(`Managed block removed from ${label} (${path})`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main
// ══════════════════════════════════════════════════════════════════════════════

log(`DSH home: ${dshHome}`);
log(`Source: ${SOURCE_DIR}`);
log(`Mode: ${opts.mode}`);

switch (opts.mode) {
  case "install": {
    installPackage();
    installPatches();
    log("\nInstallation complete. Changes are hot-reloaded by the running harness.");
    log("Start a new session to see the firecrawl_search tool, or restart dsh.");
    break;
  }
  case "uninstall": {
    uninstallPackage();
    uninstallPatches();
    log("\nUninstall complete. Restart the harness to finalize.");
    break;
  }
}
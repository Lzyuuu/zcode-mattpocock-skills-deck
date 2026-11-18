#!/usr/bin/env node
/* 分发一致性检查：workspace / marketplace 镜像 / 已安装 cache 必须逐字节一致。
 * 这是"旧版本回退"的回归门：0.1.0 的 cache 少三个条目，装上去 overlay 就没有 prompt。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const PLUGIN = path.resolve(__dirname, "..");
const SPEC = JSON.parse(fs.readFileSync(path.join(PLUGIN, "package-files.json"), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".zcode-plugin/plugin.json"), "utf8")).version;
const HOME = os.homedir();
const D = SPEC.distribution || {};
const MIRROR = path.join(expand(D.mirror), "scratch-deck");
const CACHE = path.join(expand(D.cache), VERSION);
const REGISTRY = expand(D.registry);

let pass = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; return; }
  failures.push(msg + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
}
function eq(a, b, msg) { ok(a === b, msg, { actual: a, expected: b }); }
function expand(p) {
  if (!p) return "";
  if (p === "~") return HOME;
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}
function sha(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if ((SPEC.excludeNames || []).includes(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else if (!(SPEC.excludeSuffix || []).some((s) => e.name.endsWith(s))) {
      out[path.relative(base, abs).split(path.sep).join("/")] = abs;
    }
  }
  return out;
}
function expectedFiles() {
  const out = {};
  for (const rel of SPEC.files || []) {
    const abs = path.join(PLUGIN, rel);
    if (fs.existsSync(abs)) out[rel] = sha(abs);
  }
  for (const d of SPEC.dirs || []) {
    const base = path.join(PLUGIN, d);
    if (!fs.existsSync(base)) continue;
    for (const [rel, abs] of Object.entries(walk(base, PLUGIN, {}))) out[rel] = sha(abs);
  }
  return out;
}

const want = expectedFiles();
const required = ["src/deck-loader.cjs", "src/deck-overlay.js", "src/deck-prompts.js", "src/patch_install.py",
  "src/runtime_sync.py", "package-files.json", "README.md", ".zcode-plugin/plugin.json"];
for (const rel of required) ok(rel in want, "源码里有必需文件：" + rel);

function checkCopy(label, dir) {
  if (!fs.existsSync(dir)) {
    ok(false, label + " 不存在（先跑 node scripts/sync-dist.mjs）", dir);
    return;
  }
  const missing = [], stale = [], extra = [];
  for (const [rel, hash] of Object.entries(want)) {
    const target = path.join(dir, rel);
    if (!fs.existsSync(target)) { missing.push(rel); continue; }
    if (sha(target) !== hash) stale.push(rel);
  }
  const present = walk(dir, dir, {});
  for (const rel of Object.keys(present)) {
    if (rel === ".dist-manifest.json" || rel === "manifest.json" || rel.startsWith("logs/")) continue;
    if (!(rel in want)) extra.push(rel);
  }
  ok(!missing.length, label + " 不缺文件", missing.slice(0, 12));
  ok(!stale.length, label + " 内容与源码一致", stale.slice(0, 12));
  ok(!extra.length, label + " 没有多余旧文件", extra.slice(0, 12));
  const pj = path.join(dir, ".zcode-plugin/plugin.json");
  if (fs.existsSync(pj)) eq(JSON.parse(fs.readFileSync(pj, "utf8")).version, VERSION, label + " 版本一致");
}

checkCopy("marketplace 镜像", MIRROR);
checkCopy("已安装 cache", CACHE);

const marketplaces = [
  path.join(path.dirname(PLUGIN), "marketplace.json"),
  path.join(expand(D.mirror), "marketplace.json"),
];
for (const f of marketplaces) {
  if (!fs.existsSync(f)) { ok(false, "marketplace.json 不存在: " + f); continue; }
  const doc = JSON.parse(fs.readFileSync(f, "utf8"));
  const entry = (doc.plugins || []).find((p) => p && p.name === "scratch-deck");
  ok(!!entry, "marketplace.json 有 scratch-deck 条目: " + f);
  if (entry) eq(entry.version, VERSION, "marketplace.json 版本一致: " + path.basename(path.dirname(f)));
}

if (fs.existsSync(REGISTRY)) {
  const doc = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const entry = (doc.plugins || []).find((p) => p && p.name === "scratch-deck");
  ok(!!entry, "installed_plugins.json 有 scratch-deck 条目");
  if (entry) {
    eq(entry.version, VERSION, "registry 版本一致");
    eq(entry.installPath, CACHE, "registry 指向当前 cache 目录");
    ok(fs.existsSync(path.join(entry.installPath, "src/deck-prompts.js")), "registry 指向的副本含 deck-prompts.js");
  }
} else {
  ok(false, "找不到 installed_plugins.json: " + REGISTRY);
}

console.log((failures.length ? "FAILED" : "OK") + "  passed=" + pass + " failed=" + failures.length + " (version " + VERSION + ")");
for (const f of failures) console.log("  ✗ " + f);
process.exitCode = failures.length ? 1 : 0;

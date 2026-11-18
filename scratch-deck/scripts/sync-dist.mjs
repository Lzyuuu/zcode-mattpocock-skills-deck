#!/usr/bin/env node
/* 分发同步：把工作区源码推成三份可运行副本，并保证重复执行没有副作用。
 *
 *   workspace/plugins/scratch-deck        ← 唯一源码（marketplace 的 source 指这里）
 *   ~/.zcode/cli/plugins/marketplaces/dev-scratch-deck/scratch-deck
 *                                        ← CLI 对 directory marketplace 的镜像
 *   ~/.zcode/cli/plugins/cache/dev-scratch-deck/scratch-deck/<version>
 *                                        ← 已安装副本（installed_plugins.json 指向它）
 *   ~/.zcode/scratch-deck/runtime/       ← asar 注入的稳定目标（由 runtime_sync.py 管）
 *
 * 为什么要有这个脚本：cache 0.1.0 少了 deck-prompts.js / prompts/ / scripts/，
 * 装出来的 overlay 没有 prompt 文本；镜像又没人更新。手工 scp 迟早再漏。
 *
 * 语义：
 *   - 内容 hash 相同就跳过（mtime 不变）→ 幂等
 *   - 只删自己上一份 manifest 里记过、这次不在清单里的文件 → 不碰用户与工具产物
 *   - 写 registry 前先备份 → 可回滚
 *   - 旧版本 cache 目录保留不删 → 回滚有物可指
 *
 * 用法：
 *   node scripts/sync-dist.mjs            # 同步全部目标
 *   node scripts/sync-dist.mjs --dry-run  # 只打印计划
 *   node scripts/sync-dist.mjs --no-registry --no-runtime
 *   node scripts/sync-dist.mjs --rollback 0.1.0
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(HERE, "..");
const SPEC = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package-files.json"), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, ".zcode-plugin/plugin.json"), "utf8")).version;
const MANIFEST_NAME = ".dist-manifest.json";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const skipRegistry = argv.includes("--no-registry");
const skipRuntime = argv.includes("--no-runtime");
const rollbackTarget = argv.includes("--rollback") ? argv[argv.indexOf("--rollback") + 1] : null;

const HOME = os.homedir();
const dist = SPEC.distribution || {};
const MIRROR_ROOT = path.resolve(expand(dist.mirror || "~/.zcode/cli/plugins/marketplaces/dev-scratch-deck"));
const CACHE_ROOT = path.resolve(expand(dist.cache || "~/.zcode/cli/plugins/cache/dev-scratch-deck/scratch-deck"));
const REGISTRY = path.resolve(expand(dist.registry || "~/.zcode/cli/plugins/installed_plugins.json"));
const RUNTIME_ROOT = path.resolve(expand(dist.runtime || "~/.zcode/scratch-deck"));

function expand(p) {
  if (p === "~") return HOME;
  return p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function walkPackage() {
  const excludeNames = new Set(SPEC.excludeNames || []);
  const excludeSuffix = SPEC.excludeSuffix || [];
  const out = new Map();
  for (const rel of SPEC.files || []) {
    const abs = path.join(PLUGIN_DIR, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.set(rel, abs);
  }
  for (const dir of SPEC.dirs || []) {
    const base = path.join(PLUGIN_DIR, dir);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length) {
      const cur = stack.pop();
      for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
        const abs = path.join(cur, entry.name);
        if (excludeNames.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { stack.push(abs); continue; }
        if (excludeSuffix.some((s) => entry.name.endsWith(s))) continue;
        out.set(path.relative(PLUGIN_DIR, abs).split(path.sep).join("/"), abs);
      }
    }
  }
  return out;
}

function atomicCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + ".tmp-" + process.pid + "-" + Date.now();
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}
function writeJsonAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o644 });
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

/* 把清单复制进 target（扁平布局，target 即插件根） */
function syncFlat(target, label) {
  const files = walkPackage();
  const prev = readJson(path.join(target, MANIFEST_NAME), {});
  const prevFiles = prev.files && typeof prev.files === "object" ? prev.files : {};
  const result = { label, target, created: [], updated: [], unchanged: 0, removed: [], conflicts: [] };
  const manifestFiles = {};
  for (const [rel, abs] of files) {
    const want = sha256(abs);
    manifestFiles[rel] = want;
    const dst = path.join(target, rel);
    const have = fs.existsSync(dst) && fs.statSync(dst).isFile() ? sha256(dst) : null;
    if (have === want) { result.unchanged++; continue; }
    if (have !== null && prevFiles[rel] && prevFiles[rel] !== have) {
      // 目标被改过，且不是上次 manifest 记的版本：不静默覆盖
      result.conflicts.push(rel);
      manifestFiles[rel] = have;
      continue;
    }
    if (!dryRun) atomicCopy(abs, dst);
    (have === null ? result.created : result.updated).push(rel);
  }
  for (const rel of Object.keys(prevFiles)) {
    if (rel in manifestFiles) continue;
    const dst = path.join(target, rel);
    if (!fs.existsSync(dst)) continue;
    if (!dryRun) fs.unlinkSync(dst);
    result.removed.push(rel);
  }
  if (!dryRun) {
    writeJsonAtomic(path.join(target, MANIFEST_NAME), {
      schema: 1, version: VERSION, source: PLUGIN_DIR,
      syncedAt: new Date().toISOString(), files: manifestFiles,
    });
  }
  return result;
}

function updateMarketplaceJson(file, label) {
  const doc = readJson(file, null);
  if (!doc || !Array.isArray(doc.plugins)) return { label, file, skipped: "not-a-marketplace" };
  const entry = doc.plugins.find((p) => p && p.name === "scratch-deck");
  if (!entry) return { label, file, skipped: "no-entry" };
  if (entry.version === VERSION) return { label, file, unchanged: true };
  const before = entry.version;
  entry.version = VERSION;
  if (!dryRun) writeJsonAtomic(file, doc);
  return { label, file, from: before, to: VERSION };
}

function updateRegistry() {
  const doc = readJson(REGISTRY, null);
  if (!doc || !Array.isArray(doc.plugins)) return { skipped: "not-a-registry", file: REGISTRY };
  const entry = doc.plugins.find((p) => p && p.name === "scratch-deck");
  if (!entry) return { skipped: "no-entry", file: REGISTRY };
  const installPath = path.join(CACHE_ROOT, VERSION);
  if (entry.version === VERSION && entry.installPath === installPath) {
    return { unchanged: true, file: REGISTRY, version: VERSION };
  }
  const before = { version: entry.version, installPath: entry.installPath };
  entry.version = VERSION;
  entry.installPath = installPath;
  entry.updatedAt = new Date().toISOString();
  if (!dryRun) {
    const backup = REGISTRY + ".scratch-deck-bak-" + Date.now();
    fs.copyFileSync(REGISTRY, backup);
    writeJsonAtomic(REGISTRY, doc);
    return { file: REGISTRY, from: before, to: { version: VERSION, installPath }, backup };
  }
  return { file: REGISTRY, from: before, to: { version: VERSION, installPath }, dryRun: true };
}

function rollback(version) {
  if (!version) throw new Error("--rollback 需要版本号，例如 --rollback 0.1.0");
  const dir = path.join(CACHE_ROOT, version);
  if (!fs.existsSync(path.join(dir, ".zcode-plugin/plugin.json"))) {
    throw new Error(`没有这个版本的已安装副本: ${dir}`);
  }
  const doc = readJson(REGISTRY, null);
  const entry = doc && Array.isArray(doc.plugins) ? doc.plugins.find((p) => p && p.name === "scratch-deck") : null;
  if (!entry) throw new Error("registry 里没有 scratch-deck 条目");
  const before = { version: entry.version, installPath: entry.installPath };
  entry.version = version;
  entry.installPath = dir;
  entry.updatedAt = new Date().toISOString();
  if (!dryRun) {
    fs.copyFileSync(REGISTRY, REGISTRY + ".scratch-deck-bak-" + Date.now());
    writeJsonAtomic(REGISTRY, doc);
  }
  return { from: before, to: { version, installPath: dir } };
}

function runRuntime() {
  const script = path.join(PLUGIN_DIR, "src", "runtime_sync.py");
  if (!fs.existsSync(script)) return { skipped: "no-runtime-sync" };
  const args = [script, "--plugin-dir", PLUGIN_DIR, "--runtime-dir", RUNTIME_ROOT];
  if (dryRun) args.push("--dry-run");
  const res = spawnSync("python3", args, { encoding: "utf8" });
  if (res.status !== 0) return { error: (res.stderr || res.stdout || "").trim() || "runtime sync failed" };
  try { return JSON.parse(res.stdout); } catch (e) { return { raw: res.stdout }; }
}

/* ---------- 主流程 ---------- */
const report = { version: VERSION, dryRun, mirror: null, cache: null, marketplaces: [], registry: null, runtime: null };
report.mirror = syncFlat(path.join(MIRROR_ROOT, "scratch-deck"), "mirror");
report.cache = syncFlat(path.join(CACHE_ROOT, VERSION), "cache");
report.marketplaces.push(updateMarketplaceJson(path.join(path.dirname(PLUGIN_DIR), "marketplace.json"), "workspace"));
report.marketplaces.push(updateMarketplaceJson(path.join(MIRROR_ROOT, "marketplace.json"), "mirror"));
if (!skipRegistry) report.registry = rollbackTarget ? rollback(rollbackTarget) : updateRegistry();
if (!skipRuntime) report.runtime = runRuntime();

const conflicts = [].concat(report.mirror.conflicts, report.cache.conflicts);
console.log(JSON.stringify(report, null, 2));
if (conflicts.length) {
  console.error("\n[error] 这些文件在目标里被改过，未覆盖：" + conflicts.join(", "));
  console.error("确认要覆盖：先删除目标文件再重跑（旧版本目录保留可回滚）。");
  process.exitCode = 2;
}

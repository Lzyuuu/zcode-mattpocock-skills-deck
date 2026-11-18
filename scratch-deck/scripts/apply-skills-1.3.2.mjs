#!/usr/bin/env node
/* 把 mattpocock-skills 1.3.1 → 1.3.2 的两处已知差异应用到指定包目录。
 *
 * 只做精确、单次命中的字符串替换：找不到或命中多次就停下，不猜。
 * 默认只打印计划；--apply 才写，写前逐文件备份为 <file>.bak-<时间戳>。
 *
 * 用法：
 *   node scripts/apply-skills-1.3.2.mjs --dir ~/.zcode/grok-plugins/mattpocock-skills
 *   node scripts/apply-skills-1.3.2.mjs --dir <pkg> --apply
 *
 * 依据见 docs/upstream-skills-1.3.2.md（含未能取证的项）。wizard 尾部未验证，
 * 所以本脚本不碰 wizard。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CHANGES = [
  {
    file: "skills/grilling/SKILL.md",
    from: "dispatch a sub-agent to find it",
    to: "dispatch a sub-agent with a fresh context window to find it",
    why: "上游 1.3.2 #1341：subagent 需要全新上下文窗口",
  },
  {
    file: "skills/wayfinder/SKILL.md",
    from: "spin up a subagent that calls the Skill tool",
    to: "spin up a subagent with a fresh context window that calls the Skill tool",
    why: "上游 1.3.2 #1341：同上",
  },
];

function expand(p) {
  if (!p) return "";
  if (p === "~") return os.homedir();
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const dirArg = arg("--dir");
if (!dirArg) {
  console.error("用法: node scripts/apply-skills-1.3.2.mjs --dir <包目录> [--apply]");
  process.exit(2);
}
const root = path.resolve(expand(dirArg));
const apply = process.argv.includes("--apply");
if (!fs.existsSync(root)) {
  console.error("目录不存在: " + root);
  process.exit(2);
}

const plan = [];
let blocked = null;
for (const c of CHANGES) {
  const file = path.join(root, c.file);
  if (!fs.existsSync(file)) { blocked = blocked || ("缺少文件: " + c.file); continue; }
  const text = fs.readFileSync(file, "utf8");
  const hits = text.split(c.from).length - 1;
  if (hits === 0 && text.indexOf(c.to) >= 0) { plan.push({ ...c, file, state: "already-applied" }); continue; }
  if (hits !== 1) { blocked = blocked || (c.file + " 命中 " + hits + " 次（要求恰好 1 次）"); continue; }
  plan.push({ ...c, file, state: "will-change" });
}

for (const p of plan) {
  console.log((p.state === "will-change" ? "改 " : "跳过 ") + p.file + "  [" + p.state + "]");
  console.log("   原因: " + p.why);
}
if (blocked) {
  console.error("\n[error] " + blocked);
  console.error("目标包可能不是 1.3.1，或文件已被改过。先人工比对 docs/upstream-skills-1.3.2.md。");
  process.exit(1);
}
if (!plan.some((p) => p.state === "will-change")) {
  console.log("\n已经是目标状态，无需改动。");
  process.exit(0);
}
if (!apply) {
  console.log("\n这是计划（未写入）。加 --apply 执行。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const p of plan.filter((x) => x.state === "will-change")) {
  const text = fs.readFileSync(p.file, "utf8");
  if (text.split(p.from).length - 1 !== 1) {
    console.error("[error] 写入前复查失败，中止: " + p.file);
    process.exit(1);
  }
  fs.copyFileSync(p.file, p.file + ".bak-" + stamp);
  const tmp = p.file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text.replace(p.from, p.to), "utf8");
  fs.renameSync(tmp, p.file);
  console.log("已写入 " + p.file + "（备份 " + path.basename(p.file) + ".bak-" + stamp + "）");
}

const pj = path.join(root, ".zcode-plugin", "plugin.json");
if (fs.existsSync(pj)) {
  const doc = JSON.parse(fs.readFileSync(pj, "utf8"));
  if (doc.version === "1.3.1") {
    doc.version = "1.3.2";
    const tmp = pj + ".tmp-" + process.pid;
    fs.copyFileSync(pj, pj + ".bak-" + stamp);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, pj);
    console.log("已把 plugin.json 版本升到 1.3.2");
  } else {
    console.log("plugin.json 版本是 " + doc.version + "，未改动。");
  }
}
console.log("\n完成。回滚：把同目录的 *.bak-" + stamp + " 覆盖回去。");

/* 解析 prompts/*.yaml（dsh-deck 的 config/prompts 原文，MIT）→ 展开 {{shared:x}} → src/deck-prompts.js
   运行：node scripts/gen-prompts.mjs */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["shared-sections.yaml", "ticket-action-templates.yaml", "map-advancement.yaml", "ticket-creation.yaml"];

/* YAML 子集解析：顶层 id、placeholders 列表、zh: |- 块（4 空格缩进正文） */
function parse(text) {
  const items = {};
  let cur = null, section = null, buf = [];
  const flush = () => {
    if (!cur) return;
    if (buf.length) cur.text = buf.join("\n").trim();
    items[cur.id] = cur;
  };
  for (const raw of text.split(/\r?\n/)) {
    const top = /^([A-Za-z0-9_.-]+):\s*$/.exec(raw);
    if (top) { flush(); cur = { id: top[1], placeholders: [] }; section = null; buf = []; continue; }
    if (!cur) continue;
    if (/^  placeholders:\s*$/.test(raw)) { section = "ph"; continue; }
    if (/^  zh:\s*\|-?\s*$/.test(raw)) { section = "zh"; continue; }
    if (/^  \S/.test(raw) && !/^    /.test(raw) && !/^  placeholders:/.test(raw) && !/^  zh:/.test(raw)) {
      if (section === "zh") { section = "done"; }
      else if (section === "ph") section = null;
      continue;
    }
    if (section === "ph") {
      const m = /^ {4}-\s+([A-Za-z0-9_-]+)\s*$/.exec(raw);
      if (m) cur.placeholders.push(m[1]);
      continue;
    }
    if (section === "zh" && /^ {4}/.test(raw)) buf.push(raw.slice(4));
  }
  flush();
  return items;
}

const shared = {};
const templates = {};
for (const f of FILES) {
  const items = parse(readFileSync(join(ROOT, "prompts", f), "utf8"));
  for (const id in items) {
    const it = items[id];
    if (f === "shared-sections.yaml") shared[id] = it;
    else templates[id] = it;
  }
}

function expand(text, stack) {
  return text.replace(/\{\{shared:([A-Za-z0-9_]+)\}\}/g, (_, id) => {
    if (stack.includes(id)) throw new Error("shared 成环: " + [...stack, id].join(" → "));
    const s = shared[id];
    if (!s) throw new Error("缺共享段: " + id);
    return expand(s.text, [...stack, id]);
  });
}

const out = {};
let problems = [];
for (const id in templates) {
  const t = templates[id];
  if (typeof t.text !== "string") { problems.push(id + ": 无 zh 正文，已跳过"); continue; }
  const text = expand(t.text, []);
  out[id] = { placeholders: t.placeholders, text };
  if (text.indexOf("{{shared:") >= 0) problems.push(id + ": 残留共享标记");
  for (const m of text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    if (!t.placeholders.includes(m[1])) { t.placeholders.push(m[1]); }   // 上游声明漏项：以正文为准
  }
}

const js = `/* 生成物 · 勿手改。来源 dsh-mattpocock-skills-deck config/prompts/*.yaml (MIT)。
   重建：node scripts/gen-prompts.mjs */
window.__DECK_PROMPTS = ${JSON.stringify({ templates: out }, null, 0)};
window.__deckPrompt = function (id, params) {
  var t = window.__DECK_PROMPTS.templates[id];
  if (!t) return "";
  var text = t.text;
  Object.keys(params || {}).forEach(function (k) {
    text = text.split("{" + k + "}").join(String(params[k]));
  });
  return text;
};
`;
writeFileSync(join(ROOT, "src", "deck-prompts.js"), js);

console.log("templates:", Object.keys(out).length, "| shared:", Object.keys(shared).length);
for (const id in out) console.log(" ", id, "→", out[id].text.split("\n")[0].slice(0, 36), "|", out[id].placeholders.join(",") || "-");
if (problems.length) { console.error("PROBLEMS:\n" + problems.join("\n")); process.exitCode = 1; }
else console.log("no leftover markers / undeclared placeholders");

/* Scratch Deck loader（主进程 + CLI）。
 * 职责：解析 <root>/.scratch/*.md 为 DeckState（docs/state-model.md 契约），
 * 推送给 renderer 的 window.__deckUpdate；把 renderer 的动作队列落盘为事件、
 * handoff 文档与卡片回写；维护稳定诊断文件。零 npm 依赖。
 *
 * 三种根状态是数据形状的一部分，不是 UI 分支：
 *   ready         解析到工作区且 .scratch 存在（允许 0 张卡片）
 *   uninitialized 工作区存在但没有 .scratch —— 等它被创建
 *   unresolved    没有可用工作区（检测失败/路径消失/未配置）—— 报诊断，绝不回退演示数据
 * 演示工作区只在 opts.demo / 配置显式 demo / CLI --demo 下使用。 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const PLUGIN_DIR = path.join(__dirname, "..");
const DEMO_ROOT = path.join(PLUGIN_DIR, "demo-workspace");
const OVERLAY = path.join(__dirname, "deck-overlay.js");
const PROMPTS_FILE = path.join(__dirname, "deck-prompts.js");
const HOME = os.homedir();
const RUNTIME_DIR = process.env.SCRATCH_DECK_RUNTIME || path.join(HOME, ".zcode", "scratch-deck");
const LOG_DIR = path.join(RUNTIME_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "loader.log");
const DIAG_FILE = path.join(RUNTIME_DIR, "diag-latest.json");
const DIAG_EVENTS = path.join(RUNTIME_DIR, "diag-events.jsonl");
const ROOTS_CONFIG = process.env.SCRATCH_DECK_ROOTS_CONFIG
  || path.join(HOME, ".zcode", "scratch-deck-roots.json");
const SCRATCH_DIR = ".scratch";
const EVENTS_FILE = ".deck-events.jsonl";
const SCHEMA = 2;

const WRITING_WINDOW_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 300;
const DEBOUNCE_MAX_MS = 1000;
const SYNC_MS = 5000;
const OUTBOX_MS = 1200;
const REBIND_CONFIRM = 2;
const REBIND_SETTLE_MS = 2000;
const WATCH_BACKOFF_MIN = 500;
const WATCH_BACKOFF_MAX = 30000;
const WATCH_RETRY_MAX = 8;
const ENTRY_IDLE_MS = 60000;
const MAX_ENTRIES = 16;
const LOG_MAX = 1024 * 1024;
const DIAG_EVENTS_MAX = 512 * 1024;
const NOTICE_KEEP = 20;

const TYPES = ["ticket", "map", "spec"];
const STATUSES = ["frontier", "open", "blocked", "closed"];

/* ---------- frontmatter：YAML 子集（标量 + 行内/块列表） ---------- */

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function scalar(s) {
  s = String(s).trim();
  if (s === "" || s === "null" || s === "~") return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

/* 刻意不剥离行内 ` # comment`：卡片正文里 `#401` 这类票号引用会被 YAML 规则误伤 */
function parseValue(v) {
  v = v.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTop(inner).map(scalar);
  }
  return scalar(v);
}

function parseFrontmatter(src) {
  const text = String(src).replace(/^\uFEFF/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: {}, body: text, found: false };
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1], val = kv[2];
    if (val.trim() === "") {
      const items = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const li = /^(\s+)-\s+(.*)$/.exec(lines[j]);
        if (!li) break;
        items.push(parseValue(li[2]));
      }
      if (items.length) { fm[key] = items; i = j - 1; }
      else fm[key] = null;
    } else {
      fm[key] = parseValue(val);
    }
  }
  return { fm, body: text.slice(m[0].length), found: true };
}

/* ---------- 正文：H1 标题 + 评论节 ---------- */

const COMMENT_RE = /^\s*-\s+\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*[：:]\s*(.*)$/;

function parseBody(body) {
  const lines = String(body).split(/\r?\n/);
  let title = null;
  const comments = [];
  const textLines = [];
  let section = null;
  for (const line of lines) {
    const h1 = /^#(?!#)\s+(.+?)\s*$/.exec(line);
    if (h1 && title === null) { title = h1[1]; continue; }
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) { section = h2[1].trim(); continue; }
    if (section === null) { textLines.push(line); continue; }
    if (/^(评论|comments?)$/i.test(section)) {
      const c = COMMENT_RE.exec(line);
      if (c) comments.push({ who: c[1], at: c[2] || "", tx: c[3].trim() });
    }
  }
  return { title, comments, bodyText: textLines.join("\n").trim() };
}

/* ---------- Card 组装（boundary：frontmatter 在此归一为契约形状） ---------- */

function parseCard(fileName, src, mtimeMs, now) {
  const { fm, body } = parseFrontmatter(src);
  const { title, comments, bodyText } = parseBody(body);
  const fileStem = String(fileName).replace(/\.md$/, "");
  const idFromName = parseInt(fileStem.split("-")[0], 10);
  const id = Number.isFinite(idFromName) ? idFromName : (typeof fm.id === "number" ? fm.id : null);
  const slugTitle = fileStem.replace(/^\d+-/, "");
  return {
    id,
    type: TYPES.includes(fm.type) ? fm.type : "ticket",
    title: title || slugTitle,
    status: STATUSES.includes(fm.status) ? fm.status : "open",
    labels: Array.isArray(fm.labels) ? fm.labels.map(String) : [],
    blockedBy: typeof fm["blocked-by"] === "number" ? fm["blocked-by"] : null,
    children: Array.isArray(fm.children) ? fm.children.filter((n) => typeof n === "number") : [],
    author: typeof fm.author === "string" && fm.author ? fm.author : "me",
    updated: typeof fm.updated === "string" ? fm.updated : "",
    next: typeof fm.next === "string" ? fm.next : null,
    writing: (now || Date.now()) - mtimeMs < WRITING_WINDOW_MS,
    path: SCRATCH_DIR + "/" + fileName,
    body: bodyText.slice(0, 4000),
    comments,
  };
}

function computeCounts(cards) {
  const c = { takeable: 0, occupied: 0, bug: 0, triage: 0, blocked: 0, closed: 0 };
  for (const card of cards) {
    if (card.status === "closed") { c.closed++; continue; }
    if (card.status === "frontier") c.takeable++;
    if (card.type === "ticket" && card.status !== "frontier") c.occupied++;
    if (card.labels.includes("bug")) c.bug++;
    if (card.labels.includes("needs-triage")) c.triage++;
    if (card.blockedBy !== null) c.blocked++;
  }
  return c;
}

const EMPTY_COUNTS = () => ({ takeable: 0, occupied: 0, bug: 0, triage: 0, blocked: 0, closed: 0 });

/* 根状态判定与解析是两件事：状态决定 UI 说什么，解析只在 ready 时发生。 */
function classifyRoot(rootDir) {
  if (!rootDir || typeof rootDir !== "string") {
    return { status: "unresolved", diagnosis: { code: "no-root", message: "检测不到当前工作区" } };
  }
  let st;
  try { st = fs.statSync(rootDir); } catch (e) {
    return {
      status: "unresolved",
      diagnosis: { code: "root-missing", message: "工作区路径不存在或不可读：" + rootDir },
    };
  }
  if (!st.isDirectory()) {
    return {
      status: "unresolved",
      diagnosis: { code: "root-not-dir", message: "工作区路径不是目录：" + rootDir },
    };
  }
  const scratch = path.join(rootDir, SCRATCH_DIR);
  let sst;
  try { sst = fs.statSync(scratch); } catch (e) {
    if (e.code === "ENOENT") {
      return {
        status: "uninitialized",
        diagnosis: { code: "no-scratch", message: "这个工作区还没有 " + SCRATCH_DIR + "/ 目录" },
      };
    }
    return {
      status: "unresolved",
      diagnosis: { code: "scratch-unreadable", message: SCRATCH_DIR + "/ 不可读：" + e.message },
    };
  }
  if (!sst.isDirectory()) {
    return {
      status: "uninitialized",
      diagnosis: { code: "scratch-not-dir", message: SCRATCH_DIR + " 不是目录" },
    };
  }
  return { status: "ready", diagnosis: null };
}

function buildDeckState(rootDir, opts) {
  opts = opts || {};
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const cls = classifyRoot(rootDir);
  const state = {
    schema: SCHEMA,
    root: rootDir || null,
    rootSource: opts.rootSource || null,
    status: cls.status,
    diagnosis: cls.diagnosis,
    cards: [],
    counts: EMPTY_COUNTS(),
    parseErrors: [],
    updatedAt: now,
    notices: [],
    checks: null,
    git: null,
    tracker: null,
  };
  if (cls.status !== "ready") return state;
  const scratch = path.join(rootDir, SCRATCH_DIR);
  let names;
  try {
    names = fs.readdirSync(scratch).filter((n) => n.endsWith(".md")).sort();
  } catch (e) {
    state.status = "unresolved";
    state.diagnosis = { code: "scratch-read-failed", message: "读取 " + SCRATCH_DIR + "/ 失败：" + e.message };
    return state;
  }
  for (const name of names) {
    const full = path.join(scratch, name);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    let src;
    try { src = fs.readFileSync(full, "utf8"); } catch (e) {
      state.parseErrors.push({ file: name, reason: "读取失败：" + e.message });
      continue;
    }
    const card = parseCard(name, src, st.mtimeMs, now);
    if (card.id === null) {
      state.parseErrors.push({ file: name, reason: "文件名没有数字编号前缀，无法作为卡片 id" });
      continue;
    }
    state.cards.push(card);
  }
  state.cards.sort((a, b) => a.id - b.id);
  state.counts = computeCounts(state.cards);
  return state;
}

/* ---------- 日志与诊断（有界，写不进去也不影响宿主） ---------- */

function rotateIfNeeded(file, max, keep) {
  try {
    const st = fs.statSync(file);
    if (st.size <= max) return;
    for (let i = keep; i >= 1; i--) {
      const src = i === 1 ? file : file + "." + (i - 1);
      const dst = file + "." + i;
      try { fs.unlinkSync(dst); } catch (e) { }
      try { fs.renameSync(src, dst); } catch (e) { }
    }
  } catch (e) { }
}

function logLine(...args) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded(LOG_FILE, LOG_MAX, 2);
    const line = new Date().toISOString() + " " + args.map((x) => {
      if (typeof x === "string") return x;
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    }).join(" ");
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { }
  if (!process.env.SCRATCH_DECK_QUIET) {
    try { console.error("[scratch-deck]", ...args); } catch (e) { }
  }
}

function diagEvent(kind, data) {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    rotateIfNeeded(DIAG_EVENTS, DIAG_EVENTS_MAX, 1);
    fs.appendFileSync(DIAG_EVENTS,
      JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
  } catch (e) { }
}

/* ---------- 卡片写回（archive / 评论）：先校验再原子替换 ---------- */

function sha256(text) {
  return require("crypto").createHash("sha256").update(text, "utf8").digest("hex");
}

function atomicWriteFile(file, data) {
  const tmp = file + ".scratch-deck-" + process.pid + "-" + Date.now() + ".tmp";
  fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
  try { fs.renameSync(tmp, file); } finally {
    try { fs.unlinkSync(tmp); } catch (e) { }
  }
}

/* 只改 frontmatter 的 status 行；正文、行尾符、其余字段保持逐字节不变。 */
function rewriteStatus(src, status) {
  const text = String(src);
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const rest = text.slice(bom.length);
  const m = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(rest);
  if (!m) return bom + "---\nstatus: " + status + "\n---\n" + rest;
  const fmText = m[2];
  const lineRe = /^([ \t]*)status[ \t]*:.*$/m;
  const nextFm = lineRe.test(fmText)
    ? fmText.replace(lineRe, (line) => /^([ \t]*)/.exec(line)[1] + "status: " + status)
    : (fmText ? "status: " + status + "\n" + fmText : "status: " + status);
  return bom + m[1] + nextFm + m[3] + rest.slice(m[0].length);
}

function cardFileOf(root, cardPath) {
  if (!root || typeof cardPath !== "string") throw new Error("缺少 root 或卡片路径");
  const rel = cardPath.replace(/^\.\//, "");
  if (!rel.startsWith(SCRATCH_DIR + "/")) throw new Error("卡片路径不在 " + SCRATCH_DIR + "/ 内: " + cardPath);
  const base = path.resolve(root, SCRATCH_DIR);
  const full = path.resolve(root, rel);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("卡片路径越界: " + cardPath);
  }
  return full;
}

function mutateCard(root, cardPath, mutate) {
  const full = cardFileOf(root, cardPath);
  const before = fs.readFileSync(full, "utf8");
  const after = mutate(before);
  if (typeof after !== "string") throw new Error("写回没有产生内容");
  if (after === before) return { changed: false, sha256: sha256(before) };
  // 乐观并发：读后到写前若被别的进程改过，放弃写入而不是覆盖
  const again = fs.readFileSync(full, "utf8");
  if (sha256(again) !== sha256(before)) throw new Error("卡片在读取后被修改，已放弃写入");
  atomicWriteFile(full, after);
  return { changed: true, sha256: sha256(after) };
}

function archiveCard(root, cardPath) {
  return mutateCard(root, cardPath, (src) => rewriteStatus(src, "closed"));
}

function appendComment(root, cardPath, text, who, now) {
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  const stamp = p(d.getMonth() + 1) + "-" + p(d.getDate());
  const clean = String(text).replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 2000);
  if (!clean) throw new Error("评论内容为空");
  return mutateCard(root, cardPath, (src) => {
    const eol = src.includes("\r\n") ? "\r\n" : "\n";
    const entry = "- **" + (who || "me") + "** (" + stamp + ")：" + clean;
    const m = /(^|\r?\n)##[ \t]*评论[ \t]*$/m.exec(src);
    if (!m) {
      const sep = src.endsWith("\n") ? "" : eol;
      return src + sep + eol + "## 评论" + eol + entry + eol;
    }
    const at = m.index + m[0].length;
    const tail = src.slice(at);
    // 插在节内第一条之前：卡片约定最新评论在上
    return src.slice(0, at) + eol + entry + (tail.startsWith(eol) ? "" : eol) + tail;
  });
}

/* ---------- 动作事件（.scratch/.deck-events.jsonl） ---------- */

function writeEvent(root, event) {
  const scratch = path.join(root, SCRATCH_DIR);
  const file = path.join(scratch, EVENTS_FILE);
  const record = {
    action: event.action,
    cardId: event.cardId == null ? null : event.cardId,
    root: root,
    sessionId: event.sessionId || null,
    startedAt: event.startedAt || Date.now(),
    finishedAt: event.finishedAt == null ? null : event.finishedAt,
    result: event.result || "unknown",
    error: event.error ? String(event.error).slice(0, 500) : null,
  };
  if (event.detail) record.detail = String(event.detail).slice(0, 500);
  rotateIfNeeded(file, 1024 * 1024, 1);
  fs.appendFileSync(file, JSON.stringify(record) + "\n");
  return record;
}

function handoffPath(root, now) {
  const d = new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  const ts = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-"
    + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  return path.join(root, SCRATCH_DIR, "handoff", ts + ".md");
}

function handoffBody(state, now) {
  const iso = new Date(now || Date.now()).toISOString();
  const byId = new Map(state.cards.map((c) => [c.id, c]));
  const open = state.cards.filter((c) => c.status !== "closed" && c.type === "ticket");
  const blocked = state.cards.filter((c) => c.blockedBy != null && c.status !== "closed");
  const containers = state.cards.filter((c) => c.type !== "ticket");
  const line = (c) => {
    const bits = ["#" + c.id, c.title, "(" + c.status + ")"];
    if (c.blockedBy != null) bits.push("被 #" + c.blockedBy + " 挡住");
    if (c.next) bits.push("下一步：" + c.next);
    return "- " + bits.join(" · ");
  };
  const parts = [
    "# 交接 · " + iso,
    "",
    "- 工作区：" + state.root,
    "- 来源：Scratch Deck 本地 .scratch 模式",
    "- 卡片：共 " + state.cards.length + " 张，可接 " + state.counts.takeable
      + "，故障 " + state.counts.bug + "，待分诊 " + state.counts.triage + "，已关闭 " + state.counts.closed,
    "",
    "## 当前决策",
    "- 无显式决策记录（本轮 action 事件见 " + SCRATCH_DIR + "/" + EVENTS_FILE + "）",
    "",
    "## 未完成项",
  ];
  if (open.length) parts.push(...open.map(line));
  else parts.push("- 没有开放中的工单");
  parts.push("", "## 阻塞与依赖");
  if (blocked.length) parts.push(...blocked.map((c) => "- #" + c.id + " 被 #" + c.blockedBy + " 挡住"));
  else parts.push("- 无");
  parts.push("", "## 容器与地图");
  if (containers.length) {
    parts.push(...containers.map((c) => {
      const kids = (c.children || []).map((n) => byId.get(n)).filter(Boolean);
      const closed = kids.filter((k) => k.status === "closed").length;
      return "- #" + c.id + " " + c.title + " " + closed + "/" + kids.length;
    }));
  } else parts.push("- 无");
  parts.push("", "## 下一步");
  if (open.length) parts.push("- 先接可接卡片（status: frontier）中编号最小的那张");
  else parts.push("- 当前没有可推进的工单，考虑开新需求或关闭已完成的容器");
  parts.push("", "## 给新会话的提示词", "", "```",
    "读 " + SCRATCH_DIR + "/handoff/" + path.basename(handoffPath(state.root, now))
      + "，复述你的理解后再继续推进；不要重复已完成的工作。",
    "```", "");
  return parts.join("\n");
}

function writeHandoff(state, now) {
  const file = handoffPath(state.root, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFile(file, handoffBody(state, now));
  return file;
}

/* ---------- roots 配置（缺配置不等于"用演示数据"） ---------- */

function normalizeRoot(r) {
  let p = String(r == null ? "" : r).trim();
  if (!p) return "";
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));
  return path.resolve(p);
}

function resolveRootsConfig(configPath) {
  const file = configPath || ROOTS_CONFIG;
  let cfg = null, error = null;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    error = e.code === "ENOENT" ? null : "roots 配置读取失败：" + e.message;
  }
  if (cfg !== null && (typeof cfg !== "object" || Array.isArray(cfg))) {
    error = "roots 配置不是一个对象";
    cfg = null;
  }
  const rawRoots = cfg && Array.isArray(cfg.roots) ? cfg.roots : [];
  const roots = rawRoots.filter((r) => typeof r === "string" && r.trim()).map(normalizeRoot);
  let active = cfg && typeof cfg.active === "string" ? normalizeRoot(cfg.active) : "";
  if (!roots.includes(active)) active = roots[0] || "";
  return {
    roots,
    active,
    demo: !!(cfg && cfg.demo === true),
    configPath: file,
    error,
  };
}

/* ---------- 数据面模块（环境检查 / git / tracker）：按需加载，失败可见 ---------- */

function loadDataPlane() {
  const out = { modules: {}, errors: [] };
  for (const [key, file] of [["env", "env-checks.cjs"], ["git", "git-status.cjs"], ["tracker", "tracker.cjs"]]) {
    try {
      out.modules[key] = require(path.join(__dirname, file));
    } catch (e) {
      out.errors.push({ module: key, error: e.message });
    }
  }
  return out;
}

/* ---------- 主进程注入 ---------- */

function safeJsonForExecute(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

function loadOverlaySource(overlayPath) {
  const file = overlayPath || OVERLAY;
  // 生成物 deck-prompts.js 与 overlay 拼成一段注入：prompts 先于 overlay 定义 __deckPrompt
  const combined = fs.readFileSync(PROMPTS_FILE, "utf8") + "\n" + fs.readFileSync(file, "utf8");
  new Function(combined);   // 载入前语法校验，半写状态的文件不进页面
  return combined;
}

function start(opts) {
  opts = opts || {};
  logLine("start() enter", { demo: !!opts.demo, runtime: RUNTIME_DIR });
  let electron;
  try { electron = opts.electron || require("electron"); } catch (e) {
    logLine("electron require failed:", e.message);
    throw new Error("deck-loader.start() needs Electron (require('electron') failed: " + e.message + ")");
  }
  const app = electron.app, BrowserWindow = electron.BrowserWindow, webContents = electron.webContents;
  const startedAt = Date.now();
  const cfg = resolveRootsConfig(opts.configPath);
  let overlaySrc = null, overlayError = null;
  try { overlaySrc = loadOverlaySource(opts.overlayPath); } catch (e) {
    overlayError = e.message;
    logLine("overlay/prompts unavailable:", e.message);
  }
  logLine("roots config:", { roots: cfg.roots, active: cfg.active, demo: cfg.demo, overlay: !!overlaySrc });

  const demoMode = opts.demo === true || cfg.demo === true;
  const rebindConfirm = opts.rebindConfirm || REBIND_CONFIRM;
  const rebindSettleMs = opts.rebindSettleMs == null ? REBIND_SETTLE_MS : opts.rebindSettleMs;
  const dataPlane = loadDataPlane();
  const notices = [];
  let noticeSeq = 0;
  let stopped = false;
  let disposeReason = null;
  const byRoot = new Map();      // root -> entry
  const bindings = new Map();    // wcId -> binding
  const wcRef = new Map();       // wcId -> wc
  const wcGen = new Map();       // wcId -> 注入代际
  const wcStage = new Map();     // wcId -> 阶段标志
  const diagTimers = new Map();  // wcId -> 上次写诊断时间
  let lastDiagWrite = 0;

  const now = () => Date.now();
  const isWindow = (wc) => {
    try { return !!wc && wc.getType() === "window" && !wc.isDestroyed(); } catch (e) { return false; }
  };

  function addNotice(kind, text) {
    const n = { id: ++noticeSeq, kind: kind || "info", text: String(text).slice(0, 300), at: now() };
    notices.push(n);
    while (notices.length > NOTICE_KEEP) notices.shift();
    return n;
  }

  function baseState(entry) {
    if (!entry.state) return null;
    const s = Object.assign({}, entry.state, {
      rootSource: entry.source || null,
      version: readVersion(),
      notices: notices.slice(),
    });
    return s;
  }

  function pushTo(wc, st) {
    if (!isWindow(wc) || !st) return Promise.resolve(false);
    const payload = safeJsonForExecute(st);
    return Promise.resolve()
      .then(() => wc.executeJavaScript("window.__deckUpdate && window.__deckUpdate(" + payload + ")", true))
      .then(() => {
        const stage = wcStage.get(wc.id) || (wcStage.set(wc.id, {}), wcStage.get(wc.id));
        stage.statePushedAt = now();
        stage.lastPushError = null;
        return true;
      })
      .catch((e) => {
        const stage = wcStage.get(wc.id) || (wcStage.set(wc.id, {}), wcStage.get(wc.id));
        stage.lastPushError = String(e && e.message || e);
        logLine("push failed", { wc: wc.id, err: stage.lastPushError });
        diagEvent("push-failed", { wc: wc.id, err: stage.lastPushError });
        return false;
      });
  }
  function pushEntry(e) {
    const st = baseState(e);
    for (const id of e.wcs) { const wc = wcRef.get(id); if (wc) pushTo(wc, st); }
  }

  /* ---------- watcher 状态机 ---------- */

  function closeWatcher(entry) {
    if (entry.watcher) { try { entry.watcher.close(); } catch (e) { } entry.watcher = null; }
    if (entry.fileWatchers) {
      for (const w of entry.fileWatchers.values()) { try { w.close(); } catch (e) { } }
      entry.fileWatchers.clear();
    }
    if (entry.retryTimer) { clearTimeout(entry.retryTimer); entry.retryTimer = null; }
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = null;
    entry.debounceDeadline = 0;
    entry.watchKind = null;
  }

  function scheduleRefresh(entry) {
    const t = now();
    if (!entry.debounceDeadline) entry.debounceDeadline = t + DEBOUNCE_MAX_MS;
    clearTimeout(entry.debounceTimer);
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, entry.debounceDeadline - t));
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      entry.debounceDeadline = 0;
      refreshEntry(entry, "watch");
    }, wait);
  }

  function armRetry(entry, err) {
    entry.retryCount = (entry.retryCount || 0) + 1;
    entry.lastError = err ? String(err.message || err) : entry.lastError;
    if (entry.retryCount > WATCH_RETRY_MAX) {
      entry.watchKind = "gave-up";
      logLine("watcher gave up", { root: entry.root, retries: entry.retryCount, err: entry.lastError });
      diagEvent("watch-gave-up", { root: entry.root, err: entry.lastError });
      return;
    }
    const delay = Math.min(WATCH_BACKOFF_MAX, WATCH_BACKOFF_MIN * Math.pow(2, entry.retryCount - 1));
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      if (!stopped) attachWatcher(entry);
    }, delay);
  }

  function watchScratch(entry) {
    const dir = path.join(entry.root, SCRATCH_DIR);
    let fellBack = false;
    try {
      entry.watcher = fs.watch(dir, { recursive: true }, () => scheduleRefresh(entry));
    } catch (e) {
      fellBack = true;
      logLine("recursive watch unavailable, falling back", { root: entry.root, err: e.message });
    }
    if (fellBack) {
      try {
        entry.watcher = fs.watch(dir, { recursive: false }, () => scheduleRefresh(entry));
      } catch (e) {
        armRetry(entry, e);
        return;
      }
      // 非递归模式：逐文件监听内容变化，目录监听只管增删
      entry.fileWatchers = entry.fileWatchers || new Map();
      let names = [];
      try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".md")); } catch (e) { }
      for (const n of names) {
        try {
          const w = fs.watch(path.join(dir, n), () => scheduleRefresh(entry));
          entry.fileWatchers.set(n, w);
        } catch (e) { }
      }
    }
    entry.watchKind = "scratch";
    entry.retryCount = 0;
    entry.lastError = null;
    entry.watcher.on("error", (err) => {
      logLine("scratch watcher error", { root: entry.root, err: err.message });
      diagEvent("watch-error", { root: entry.root, err: err.message });
      closeWatcher(entry);
      // 目录被删/改名：状态降级，等父目录监听发现重建
      entry.state = buildDeckState(entry.root, { rootSource: entry.source, now: now() });
      pushEntry(entry);
      attachWatcher(entry);
    });
    logLine("watch attached", { root: entry.root, kind: "scratch" });
  }

  function watchParent(entry) {
    const dir = entry.root;
    try {
      entry.watcher = fs.watch(dir, { recursive: false }, () => scheduleRefresh(entry));
    } catch (e) {
      armRetry(entry, e);
      return;
    }
    entry.watchKind = "parent";
    entry.retryCount = 0;
    entry.watcher.on("error", (err) => {
      logLine("parent watcher error", { root: entry.root, err: err.message });
      diagEvent("watch-error", { root: entry.root, kind: "parent", err: err.message });
      closeWatcher(entry);
      armRetry(entry, err);
    });
    logLine("watch attached", { root: entry.root, kind: "parent" });
  }

  function attachWatcher(entry) {
    if (stopped) return;
    closeWatcher(entry);
    const cls = classifyRoot(entry.root);
    entry.status = cls.status;
    if (cls.status === "ready") watchScratch(entry);
    else if (cls.status === "uninitialized") watchParent(entry);
    else armRetry(entry, new Error(cls.diagnosis ? cls.diagnosis.message : "root 不可用"));
  }

  /* 只在 watchKind 与当前状态不匹配时重挂：每次刷新都重开 watcher 会丢事件 */
  function ensureWatcher(entry) {
    const want = entry.status === "ready" ? "scratch"
      : (entry.status === "uninitialized" ? "parent" : null);
    if (want === null) {
      if (entry.watchKind) attachWatcher(entry);
      return;
    }
    if (entry.watchKind !== want) attachWatcher(entry);
  }

  function entryOf(root, source) {
    let entry = byRoot.get(root);
    if (entry) { entry.lastUsedAt = now(); if (source) entry.source = source; return entry; }
    entry = {
      root,
      source: source || null,
      state: buildDeckState(root, { rootSource: source, now: now() }),
      watcher: null,
      fileWatchers: new Map(),
      wcs: new Set(),
      debounceTimer: null,
      debounceDeadline: 0,
      retryTimer: null,
      retryCount: 0,
      watchKind: null,
      lastError: null,
      status: "unresolved",
      createdAt: now(),
      lastUsedAt: now(),
    };
    entry.status = entry.state.status;
    byRoot.set(root, entry);
    attachWatcher(entry);
    evictEntries();
    return entry;
  }

  function evictEntries() {
    if (byRoot.size <= MAX_ENTRIES) return;
    const idle = [...byRoot.values()]
      .filter((e) => e.wcs.size === 0 && now() - e.lastUsedAt > ENTRY_IDLE_MS)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const e of idle) {
      if (byRoot.size <= MAX_ENTRIES) break;
      closeWatcher(e);
      byRoot.delete(e.root);
      logLine("entry evicted", { root: e.root });
    }
  }

  function sweepEntries() {
    for (const [root, e] of byRoot) {
      if (e.wcs.size === 0 && now() - e.lastUsedAt > ENTRY_IDLE_MS) {
        closeWatcher(e);
        byRoot.delete(root);
        logLine("entry swept", { root });
      }
    }
    for (const [id, wc] of wcRef) {
      if (!isWindow(wc)) { wcRef.delete(id); bindings.delete(id); wcStage.delete(id); wcGen.delete(id); }
    }
  }

  function refreshEntry(entry, reason) {
    const wasStatus = entry.status;
    let next;
    try {
      next = buildDeckState(entry.root, { rootSource: entry.source, now: now() });
    } catch (e) {
      entry.lastError = String(e.message || e);
      logLine("rebuild failed", { root: entry.root, err: entry.lastError });
      diagEvent("rebuild-failed", { root: entry.root, err: entry.lastError });
      return;
    }
    entry.lastError = null;
    entry.state = next;
    entry.status = next.status;
    // 保留上一轮的动作通知与数据面结果，避免刷新把它们擦掉
    if (entry.aux) {
      next.checks = entry.aux.checks || null;
      next.git = entry.aux.git || null;
      next.tracker = entry.aux.tracker || null;
    }
    if (wasStatus !== next.status || reason !== "watch") {
      ensureWatcher(entry);
    }
    pushEntry(entry);
    logLine("state refreshed", { root: entry.root, status: next.status, cards: next.cards.length, reason });
  }

  function readAux(entry) {
    return (entry.aux = entry.aux || { checks: null, git: null, tracker: null });
  }

  function applyAux(entry, key, value) {
    readAux(entry)[key] = value;
    if (entry.state) entry.state[key] = value;
  }

  /* ---------- 窗口绑定（含滞回，避免 5s 对账反复切 root） ---------- */

  function bind(wc, root, source, reason) {
    const prev = bindings.get(wc.id);
    if (prev && prev.root === root) {
      prev.lastSeenAt = now();
      const pe = byRoot.get(root);
      if (pe) { pe.wcs.add(wc.id); wcRef.set(wc.id, wc); pe.lastUsedAt = now(); }
      return;
    }
    if (prev) {
      const pe = byRoot.get(prev.root);
      if (pe) pe.wcs.delete(wc.id);
    }
    const entry = entryOf(root, source);
    entry.wcs.add(wc.id);
    wcRef.set(wc.id, wc);
    bindings.set(wc.id, {
      root, source, reason,
      boundAt: now(), lastSeenAt: now(),
      candidate: null, candidateSince: 0, candidateCount: 0,
    });
    logLine("bind root", { wc: wc.id, root, source, reason, cards: entry.state ? entry.state.cards.length : -1 });
    diagEvent("bind", { wc: wc.id, root, source, reason });
    pushTo(wc, baseState(entry));
    writeDiag(true);
  }

  /* 候选位移必须连续命中且稳定一段时间才真的换根 */
  function offerCandidate(wc, candidate, source) {
    let b = bindings.get(wc.id);
    if (!b) return bind(wc, candidate, source, "initial");
    b.lastSeenAt = now();
    if (b.root === candidate) {
      b.candidate = null; b.candidateSince = 0; b.candidateCount = 0;
      return;
    }
    if (b.candidate !== candidate) {
      b.candidate = candidate;
      b.candidateSince = now();
      b.candidateCount = 1;
      return;
    }
    b.candidateCount++;
    if (b.candidateCount < rebindConfirm || now() - b.candidateSince < rebindSettleMs) return;
    logLine("rebind after confirm", { wc: wc.id, from: b.root, to: candidate, source, count: b.candidateCount });
    bind(wc, candidate, source, "rebind-confirmed");
  }

  function setUnresolved(wc, diagnosis) {
    const key = "__unresolved__";
    let b = bindings.get(wc.id);
    if (!b) {
      bindings.set(wc.id, {
        root: key, source: null, reason: "no-root", boundAt: now(), lastSeenAt: now(),
        candidate: null, candidateSince: 0, candidateCount: 0,
      });
      const st = {
        schema: SCHEMA, root: null, rootSource: null, status: "unresolved",
        diagnosis, cards: [], counts: EMPTY_COUNTS(), parseErrors: [],
        updatedAt: now(), notices: notices.slice(), checks: null, git: null, tracker: null,
      };
      pushTo(wc, st);
      return;
    }
    if (b.root !== key) return;   // 已绑定真实 root：检测失败不改绑定
    const st = {
      schema: SCHEMA, root: null, rootSource: null, status: "unresolved",
      diagnosis, cards: [], counts: EMPTY_COUNTS(), parseErrors: [],
      updatedAt: now(), notices: notices.slice(), checks: null, git: null, tracker: null,
    };
    pushTo(wc, st);
  }

  function detect(wc) {
    return Promise.resolve()
      .then(() => wc.executeJavaScript("(window.__deckGetRoot && window.__deckGetRoot()) || null", true))
      .then((r) => (typeof r === "string" && r.trim() ? normalizeRoot(r) : null))
      .catch((e) => {
        const stage = wcStage.get(wc.id) || {};
        stage.lastDetectError = String(e && e.message || e);
        return null;
      });
  }

  function syncWindow(wc) {
    if (!isWindow(wc)) return Promise.resolve();
    return detect(wc).then((root) => {
      if (stopped || !isWindow(wc)) return;
      const b = bindings.get(wc.id);
      if (root) return offerCandidate(wc, root, "window");
      if (b && b.root && b.root !== "__unresolved__") return;   // 已有绑定，检测失败不动它
      if (cfg.active) return offerCandidate(wc, cfg.active, root ? "window" : "config");
      if (demoMode) return bind(wc, DEMO_ROOT, "demo", "demo-explicit");
      setUnresolved(wc, {
        code: "no-root",
        message: "检测不到当前工作区（ZCode 的 workspacePath 未暴露或页面尚未就绪）",
      });
    });
  }

  /* ---------- 注入 ---------- */

  function injectOverlay(wc, why) {
    if (!isWindow(wc) || !overlaySrc) {
      if (!overlaySrc && isWindow(wc)) {
        const stage = wcStage.get(wc.id) || (wcStage.set(wc.id, {}), wcStage.get(wc.id));
        stage.overlayError = overlayError || "overlay 源不可用";
      }
      return Promise.resolve(false);
    }
    const gen = (wcGen.get(wc.id) || 0) + 1;
    wcGen.set(wc.id, gen);
    const stage = wcStage.get(wc.id) || (wcStage.set(wc.id, {}), wcStage.get(wc.id));
    const body = "(function(){try{if(window.__deckDispose)window.__deckDispose(" + gen + ");}catch(e){}"
      + "try{window.__deckGeneration=" + gen + ";}catch(e){}\n" + overlaySrc + "\n})();";
    return Promise.resolve()
      .then(() => wc.executeJavaScript(body, true))
      .then(() => {
        if (wcGen.get(wc.id) !== gen) return false;   // 期间又被注入一次，这次的结果作废
        stage.injectedAt = now();
        stage.injectedGen = gen;
        stage.injectedWhy = why || null;
        stage.overlayError = null;
        logLine("overlay injected", { wc: wc.id, gen, why: why || null });
        diagEvent("injected", { wc: wc.id, gen, why: why || null });
        return syncWindow(wc).then(() => true);
      })
      .catch((e) => {
        stage.overlayError = String(e && e.message || e);
        logLine("overlay inject failed", { wc: wc.id, gen, err: stage.overlayError });
        diagEvent("inject-failed", { wc: wc.id, gen, err: stage.overlayError });
        return false;
      });
  }

  function pullDiag(wc) {
    if (!isWindow(wc)) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => wc.executeJavaScript(
        "(window.__deckDiag ? JSON.stringify(window.__deckDiag()) : null)", true))
      .then((raw) => {
        if (typeof raw !== "string" || !raw) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      })
      .catch(() => null);
  }

  function drainActions(wc) {
    if (!isWindow(wc)) return Promise.resolve([]);
    return Promise.resolve()
      .then(() => wc.executeJavaScript(
        "(window.__deckDrainActions ? JSON.stringify(window.__deckDrainActions()) : '[]')", true))
      .then((raw) => {
        if (typeof raw !== "string" || !raw) return [];
        try {
          const arr = JSON.parse(raw);
          return Array.isArray(arr) ? arr : [];
        } catch (e) {
          logLine("action queue parse failed", { wc: wc.id, err: e.message });
          return [];
        }
      })
      .catch((e) => {
        logLine("action drain failed", { wc: wc.id, err: String(e && e.message || e) });
        return [];
      });
  }

  /* ---------- 动作执行 ---------- */

  function resolveEntryFor(action) {
    const root = action.root && typeof action.root === "string" ? normalizeRoot(action.root) : "";
    if (root) {
      const e = byRoot.get(root);
      if (e) return e;
      if (classifyRoot(root).status === "ready") return entryOf(root, action.rootSource || null);
      return null;
    }
    for (const e of byRoot.values()) if (e.wcs.size) return e;
    return null;
  }

  function runAction(wc, action) {
    const kind = action && action.kind;
    const startedAt = typeof action.startedAt === "number" ? action.startedAt : now();
    const entry = resolveEntryFor(action || {});
    const root = entry ? entry.root : null;
    const cardPath = action && action.path;

    const finish = (result, error, detail) => {
      const finishedAt = now();
      if (root && entry && entry.state && entry.state.status === "ready") {
        try {
          writeEvent(root, {
            action: kind, cardId: action.cardId, root,
            sessionId: action.sessionId, startedAt, finishedAt, result, error, detail,
          });
        } catch (e) {
          logLine("event write failed", { root, err: e.message });
          diagEvent("event-write-failed", { root, err: e.message });
        }
      }
      const label = {
        "archive": "已归档",
        "comment": "已写入评论",
        "handoff": "已生成交接文档",
        "env.refresh": "环境检查已刷新",
        "git.refresh": "Git 状态已刷新",
        "tracker.refresh": "Tracker 已刷新",
      }[kind];
      if (label) {
        addNotice(result === "ok" ? "ok" : "warn",
          result === "ok" ? label : label + "失败：" + (error || "未知错误"));
      }
      if (entry) {
        if (entry.state) entry.state.notices = notices.slice();
        if (kind !== "prompt.inject") {
          refreshEntry(entry, "action:" + kind);
        } else {
          pushEntry(entry);   // 注入类动作只更新通知，不重读文件
        }
      }
      diagEvent("action", { kind, root, result, error: error || null, wc: wc && wc.id });
    };

    try {
      if (kind === "prompt.inject") {
        // 注入本身可观测（renderer 侧同步返回失败原因），后续任务是否完成不可观测
        const ok = action.result !== "failed";
        finish(ok ? "ok" : "failed", ok ? null : action.error || "注入输入框失败",
          "prompt 注入完成；任务完成情况不可观测");
        if (ok && root && entry && entry.state && entry.state.status === "ready") {
          try {
            writeEvent(root, {
              action: "prompt.task", cardId: action.cardId, root,
              sessionId: action.sessionId, startedAt, finishedAt: null,
              result: "unknown", detail: "等待 agent 回复，无法从 overlay 观测完成",
            });
          } catch (e) {
            logLine("task event write failed", { root, err: e.message });
          }
        }
        return;
      }
      if (kind === "archive") {
        if (!root) throw new Error("没有可用工作区，无法归档");
        archiveCard(root, cardPath);
        finish("ok", null, "status 已写回 closed");
        return;
      }
      if (kind === "comment") {
        if (!root) throw new Error("没有可用工作区，无法写评论");
        appendComment(root, cardPath, action.text, action.who, now());
        finish("ok", null, null);
        return;
      }
      if (kind === "handoff") {
        if (!root) throw new Error("没有可用工作区，无法生成交接文档");
        if (!entry.state || entry.state.status !== "ready") throw new Error("当前工作区没有 .scratch，无法生成交接文档");
        const file = writeHandoff(entry.state, now());
        finish("ok", null, path.relative(root, file));
        addNotice("ok", "已生成 handoff：" + path.relative(root, file) + "（新会话请打开它）");
        return;
      }
      if (kind === "env.refresh") {
        if (!root || !dataPlane.modules.env) throw new Error(dataPlane.errors.find((e) => e.module === "env")
          ? "env-checks 模块不可用：" + dataPlane.errors.find((e) => e.module === "env").error
          : "没有可用工作区");
        return Promise.resolve(dataPlane.modules.env.runEnvChecks({ root }))
          .then((report) => { applyAux(entry, "checks", report); finish("ok", null, null); })
          .catch((e) => finish("failed", e.message));
      }
      if (kind === "git.refresh") {
        if (!root || !dataPlane.modules.git) throw new Error("git-status 模块不可用");
        return Promise.resolve(dataPlane.modules.git.readGitStatus(root))
          .then((status) => { applyAux(entry, "git", status); finish("ok", null, status.kind); })
          .catch((e) => finish("failed", e.message));
      }
      if (kind === "tracker.refresh") {
        if (!root || !dataPlane.modules.tracker) throw new Error("tracker 模块不可用");
        const tracker = dataPlane.modules.tracker.createTracker({
          kind: action.trackerKind || "local", root,
        });
        return Promise.resolve(tracker.refresh())
          .then((snapshot) => { applyAux(entry, "tracker", snapshot); finish("ok", null, snapshot.status); })
          .catch((e) => finish("failed", e.message));
      }
      if (kind === "refresh") {
        if (entry) refreshEntry(entry, "action:refresh");
        finish("ok", null, null);
        return;
      }
      finish("failed", "未知动作：" + kind);
    } catch (e) {
      finish("failed", String(e && e.message || e));
    }
    return undefined;
  }

  let outboxBusy = false;
  function pollOutbox() {
    if (stopped || outboxBusy) return;
    outboxBusy = true;
    const jobs = [];
    for (const wc of webContents.getAllWebContents()) {
      if (!isWindow(wc)) continue;
      jobs.push(drainActions(wc).then((actions) => {
        for (const a of actions) {
          try { runAction(wc, a); } catch (e) { logLine("action failed", { err: String(e && e.message || e) }); }
        }
      }));
    }
    Promise.all(jobs).catch(() => { }).then(() => { outboxBusy = false; });
  }

  /* ---------- 诊断落盘 ---------- */

  function diagnosticSnapshot() {
    const windows = [];
    for (const [id, wc] of wcRef) {
      if (!isWindow(wc)) continue;
      const b = bindings.get(id) || {};
      const stage = wcStage.get(id) || {};
      const entry = b.root ? byRoot.get(b.root) : null;
      windows.push({
        wcId: id,
        root: b.root && b.root !== "__unresolved__" ? b.root : null,
        rootSource: b.source || null,
        bindReason: b.reason || null,
        boundAt: b.boundAt || null,
        status: entry ? entry.status : (b.root === "__unresolved__" ? "unresolved" : null),
        cardCount: entry && entry.state ? entry.state.cards.length : null,
        generation: wcGen.get(id) || 0,
        injectedAt: stage.injectedAt || null,
        injectedWhy: stage.injectedWhy || null,
        lastUpdateAt: stage.statePushedAt || null,
        lastError: stage.overlayError || stage.lastPushError || stage.lastDetectError || null,
        renderer: stage.renderer || null,
      });
    }
    const watchers = [];
    for (const e of byRoot.values()) {
      watchers.push({
        root: e.root, kind: e.watchKind, retries: e.retryCount || 0,
        lastError: e.lastError, windows: e.wcs.size,
        status: e.status, cards: e.state ? e.state.cards.length : null,
      });
    }
    return {
      schema: SCHEMA,
      pid: process.pid,
      version: readVersion(),
      startedAt,
      at: now(),
      demoMode,
      runtimeDir: RUNTIME_DIR,
      config: { path: cfg.configPath, roots: cfg.roots, active: cfg.active, demo: cfg.demo, error: cfg.error },
      overlay: { loaded: !!overlaySrc, error: overlayError },
      dataPlane: { loaded: Object.keys(dataPlane.modules), errors: dataPlane.errors },
      stages: {
        loaderLoaded: true,
        startExecutedAt: startedAt,
        injectedWindows: windows.filter((w) => w.injectedAt).length,
        pushedWindows: windows.filter((w) => w.lastUpdateAt).length,
      },
      windows,
      watchers,
      entries: byRoot.size,
    };
  }

  function readVersion() {
    try {
      const p = path.join(PLUGIN_DIR, ".zcode-plugin", "plugin.json");
      return JSON.parse(fs.readFileSync(p, "utf8")).version || null;
    } catch (e) { return null; }
  }

  function writeDiag(force) {
    const t = now();
    if (!force && t - lastDiagWrite < 2000) return;
    lastDiagWrite = t;
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      const doc = diagnosticSnapshot();
      const tmp = DIAG_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
      fs.renameSync(tmp, DIAG_FILE);
    } catch (e) {
      logLine("diag write failed", e.message);
    }
  }

  /* ---------- 窗口生命周期 ---------- */

  function attachWindow(win) {
    try {
      const wc = win && win.webContents;
      if (!wc) { logLine("attach window skipped: no webContents"); return; }
      if (wcRef.get(wc.id) === wc) { injectOverlay(wc, "attach-existing"); return; }
      wcRef.set(wc.id, wc);
      wc.on("did-navigate", () => { injectOverlay(wc, "did-navigate"); });
      wc.on("did-navigate-in-page", () => { injectOverlay(wc, "did-navigate-in-page"); });
      wc.on("render-process-gone", (_e, details) => {
        const stage = wcStage.get(wc.id) || {};
        stage.lastError = "render-process-gone:" + (details && details.reason || "unknown");
        logLine("render process gone", { wc: wc.id, details });
        diagEvent("render-gone", { wc: wc.id, details: details || null });
      });
      wc.on("destroyed", () => {
        const b = bindings.get(wc.id);
        if (b) { const e = byRoot.get(b.root); if (e) e.wcs.delete(wc.id); }
        bindings.delete(wc.id); wcRef.delete(wc.id); wcStage.delete(wc.id); wcGen.delete(wc.id);
        logLine("window destroyed", { wc: wc.id });
      });
      logLine("window attached", { wc: wc.id });
      injectOverlay(wc, "initial");
    } catch (e) {
      logLine("attach window failed:", e.message);
      diagEvent("attach-failed", { err: e.message });
    }
  }

  // browser-window-created 的首参是 event，窗口在第二个参数
  const onWindowCreated = (event, win) => attachWindow(win);
  app.on("browser-window-created", onWindowCreated);
  if (app.isReady && !app.isReady()) {
    Promise.resolve(app.whenReady())
      .then(() => { for (const win of BrowserWindow.getAllWindows()) attachWindow(win); })
      .catch((e) => logLine("whenReady failed", e.message));
  } else {
    for (const win of BrowserWindow.getAllWindows()) attachWindow(win);
  }

  // 工作区切换不一定触发导航事件：低频对账（有滞回，不会来回切根）
  const syncTimer = setInterval(() => {
    if (stopped) return;
    for (const wc of webContents.getAllWebContents()) {
      if (!isWindow(wc)) continue;
      syncWindow(wc).then(() => pullDiag(wc)).then((diag) => {
        if (!diag || !isWindow(wc)) return;
        const stage = wcStage.get(wc.id) || (wcStage.set(wc.id, {}), wcStage.get(wc.id));
        stage.renderer = diag;
      }).catch(() => { });
    }
    sweepEntries();
    writeDiag(false);
    diagTimers.clear();
  }, SYNC_MS);

  const outboxTimer = setInterval(pollOutbox, OUTBOX_MS);
  writeDiag(true);

  return {
    state: () => {
      for (const e of byRoot.values()) if (e.state && e.state.cards.length) return baseState(e);
      for (const e of byRoot.values()) if (e.state) return baseState(e);
      return null;
    },
    config: cfg,
    byRoot,
    bindings,
    diag: () => diagnosticSnapshot(),
    refresh() {
      for (const e of byRoot.values()) refreshEntry(e, "manual");
    },
    runAction,
    pollOutbox,
    sync: () => { for (const wc of webContents.getAllWebContents()) if (isWindow(wc)) syncWindow(wc); },
    stop() {
      stopped = true;
      disposeReason = "stop";
      clearInterval(syncTimer);
      clearInterval(outboxTimer);
      app.removeListener("browser-window-created", onWindowCreated);
      for (const e of byRoot.values()) closeWatcher(e);
      bindings.clear();
      wcRef.clear();
      writeDiag(true);
      logLine("stopped", { reason: disposeReason });
    },
  };
}

/* ---------- CLI ---------- */

function usage() {
  return [
    "usage:",
    "  node deck-loader.cjs --once <workspace-root>   # 打印 DeckState（ready/uninitialized/unresolved）",
    "  node deck-loader.cjs --once --demo             # 显式使用演示工作区",
    "  node deck-loader.cjs --checks [--root <dir>]   # 环境检查（只读）",
    "  node deck-loader.cjs --git [--root <dir>]      # Git 状态（只读）",
    "  node deck-loader.cjs --diag                    # 打印最近一次诊断快照",
  ].join("\n");
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}

/* 位置参数：去掉所有 --flag（含 --flag=value 形式） */
function positionalArgs(argv) {
  return argv.filter((a) => !a.startsWith("--"));
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.includes("--diag")) {
    try {
      process.stdout.write(fs.readFileSync(DIAG_FILE, "utf8") + "\n");
      return;
    } catch (e) {
      process.stderr.write("没有诊断文件：" + DIAG_FILE + "（loader 可能从未在客户端里启动过）\n");
      process.exitCode = 1;
      return;
    }
  }
  const demo = args.includes("--demo");
  const rootArg = argValue(args, "--root") || positionalArgs(args)[0] || null;
  if (args.includes("--checks")) {
    const mod = loadDataPlane().modules.env;
    if (!mod) { process.stderr.write("env-checks.cjs 不可用\n"); process.exitCode = 1; return; }
    const root = demo ? DEMO_ROOT : (rootArg ? normalizeRoot(rootArg) : (resolveRootsConfig().active || ""));
    mod.runEnvChecks({ root }).then((report) => {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    }).catch((e) => { process.stderr.write(String(e && e.message || e) + "\n"); process.exitCode = 1; });
    return;
  }
  if (args.includes("--git")) {
    const mod = loadDataPlane().modules.git;
    if (!mod) { process.stderr.write("git-status.cjs 不可用\n"); process.exitCode = 1; return; }
    const root = demo ? DEMO_ROOT : (rootArg ? normalizeRoot(rootArg) : (resolveRootsConfig().active || ""));
    mod.readGitStatus(root).then((status) => {
      process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    }).catch((e) => { process.stderr.write(String(e && e.message || e) + "\n"); process.exitCode = 1; });
    return;
  }
  if (!args.includes("--once")) {
    process.stderr.write(usage() + "\n");
    process.exitCode = 1;
    return;
  }
  const root = demo ? DEMO_ROOT : normalizeRoot(rootArg || resolveRootsConfig().active || "");
  if (!root) {
    process.stderr.write("没有工作区：请传 <workspace-root> 或用 --demo\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(buildDeckState(root, {
    rootSource: demo ? "demo" : "cli", now: Date.now(),
  }), null, 2) + "\n");
}

if (require.main === module) {
  runCli(process.argv);
} else {
  // asar 注入入口：被 import() 加载时自启，CLI 直跑走上面的 runCli。
  // Electron 不可用（纯 node require 单测）时抛错由调用方决定，这里只记录。
  try { start(); } catch (e) { logLine("auto-start failed", e.message); }
}

module.exports = {
  start,
  runCli,
  buildDeckState,
  classifyRoot,
  parseCard,
  parseFrontmatter,
  parseBody,
  computeCounts,
  resolveRootsConfig,
  normalizeRoot,
  rewriteStatus,
  appendComment,
  archiveCard,
  writeEvent,
  writeHandoff,
  handoffBody,
  DIAG_FILE,
  LOG_FILE,
  DEMO_ROOT,
  SCRATCH_DIR,
};

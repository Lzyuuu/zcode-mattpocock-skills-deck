#!/usr/bin/env node
/* deck-loader 的行为测试：真实临时目录 + 真实 fs.watch + fake Electron。
 * 覆盖三态根语义、root 滞回、watcher 生命周期、注入阶段、动作闭环。
 * 不碰真机 asar，也不写 ~/.zcode（runtime 目录指到临时目录）。 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "sd-loader-test-"));
process.env.SCRATCH_DECK_RUNTIME = path.join(TMP, "runtime");
process.env.SCRATCH_DECK_ROOTS_CONFIG = path.join(TMP, "no-such-roots.json");
process.env.SCRATCH_DECK_QUIET = "1";

const L = require("../src/deck-loader.cjs");

let pass = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; return; }
  failures.push(msg + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
}
function eq(actual, expected, msg) {
  ok(actual === expected, msg, { actual, expected });
}
function section(name) { console.log("\n# " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, msg) {
  const until = Date.now() + (ms || 3000);
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(40);
  }
  ok(false, "等待超时：" + msg);
  return false;
}
function mkroot(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function card(dir, id, extra) {
  const f = path.join(dir, ".scratch", id + "-测试卡.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "---\nid: " + id + "\ntype: ticket\nstatus: open\nlabels: []\n---\n# 卡片 " + id + "\n正文\n## 评论\n- **qb** (11-16): 一条评论\n");
  return f;
}

/* ---------- fake Electron ---------- */

function makePage() {
  const page = {
    root: null,
    updates: [],
    actions: [],
    injected: 0,
    failInject: false,
    failPush: false,
    failDetect: false,
    failDrain: false,
    diag: { generation: 1, mounted: true, composerFound: true, paneId: "pane-a", hiddenReason: null },
  };
  return page;
}

function makeElectron(opts) {
  const listeners = {};
  const wins = [];
  const wcs = [];
  const app = {
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); },
  };
  function addWindow(page, id) {
    const wcListeners = {};
    const wc = {
      id: id,
      getType: () => "window",
      isDestroyed: () => !!page.destroyed,
      on: (ev, fn) => { (wcListeners[ev] = wcListeners[ev] || []).push(fn); },
      fire: (ev, ...a) => (wcListeners[ev] || []).forEach((f) => f(...a)),
      executeJavaScript: async (code) => {
        if (!code) return null;
        if (code.indexOf("(function(){try{if(window.__deckDispose)") === 0) {
          if (page.failInject) throw new Error("inject boom");
          page.injected++;
          return undefined;
        }
        if (code.indexOf("__deckGetRoot") >= 0) {
          if (page.failDetect) throw new Error("detect boom");
          return page.root;
        }
        if (code.indexOf("__deckUpdate") >= 0) {
          if (page.failPush) throw new Error("push boom");
          const start = code.indexOf("__deckUpdate(") + "__deckUpdate(".length;
          page.updates.push(JSON.parse(code.slice(start, code.lastIndexOf(")"))));
          return undefined;
        }
        if (code.indexOf("__deckDrainActions") >= 0) {
          if (page.failDrain) throw new Error("drain boom");
          const out = page.actions;
          page.actions = [];
          return JSON.stringify(out);
        }
        if (code.indexOf("__deckDiag") >= 0) return JSON.stringify(page.diag);
        return null;
      },
    };
    const win = { webContents: wc };
    wcs.push(wc); wins.push(win);
    return { win, wc };
  }
  for (const p of (opts && opts.pages) || []) addWindow(p, 1 + wcs.length);
  return {
    electron: {
      app,
      BrowserWindow: { getAllWindows: () => wins },
      webContents: { getAllWebContents: () => wcs },
    },
    fireWindowCreated: (win) => (listeners["browser-window-created"] || []).forEach((f) => f({}, win)),
    addWindow,
    wins,
    wcs,
  };
}

function startLoader(opts) {
  return L.start(Object.assign({ rebindConfirm: 2, rebindSettleMs: 0 }, opts));
}

const last = (page) => page.updates[page.updates.length - 1] || { cards: [], status: null, root: null };

/* ---------- 1. 三态根语义 ---------- */

function testRootStates() {
  section("三态根语义");
  const ready = mkroot("ready");
  card(ready, 401);
  card(ready, 402);
  const s1 = L.buildDeckState(ready);
  eq(s1.status, "ready", "有 .scratch 时为 ready");
  eq(s1.cards.length, 2, "解析出两张卡");
  ok(s1.diagnosis === null, "ready 不带诊断");

  const empty = mkroot("empty-scratch");
  fs.mkdirSync(path.join(empty, ".scratch"));
  const s2 = L.buildDeckState(empty);
  eq(s2.status, "ready", "空 .scratch 仍是 ready（允许 0 张卡）");
  eq(s2.cards.length, 0, "0 张卡");
  eq(s2.counts.takeable, 0, "计数归零");

  const noScratch = mkroot("no-scratch");
  const s3 = L.buildDeckState(noScratch);
  eq(s3.status, "uninitialized", "没有 .scratch 时是 uninitialized");
  eq(s3.diagnosis.code, "no-scratch", "诊断码是 no-scratch");

  const s4 = L.buildDeckState(path.join(TMP, "does-not-exist"));
  eq(s4.status, "unresolved", "路径不存在时是 unresolved");
  eq(s4.diagnosis.code, "root-missing", "诊断码是 root-missing");

  const s5 = L.buildDeckState("");
  eq(s5.status, "unresolved", "空 root 是 unresolved");
  eq(s5.diagnosis.code, "no-root", "诊断码是 no-root");

  const bad = mkroot("malformed");
  fs.mkdirSync(path.join(bad, ".scratch"), { recursive: true });
  fs.writeFileSync(path.join(bad, ".scratch", "无编号.md"), "---\nstatus: open\n---\n# x\n");
  fs.writeFileSync(path.join(bad, ".scratch", "403-好卡.md"), "---\nstatus: frontier\n---\n# 好卡\n");
  const s6 = L.buildDeckState(bad);
  eq(s6.status, "ready", "有坏卡时整体仍是 ready");
  eq(s6.cards.length, 1, "只收下合法卡片");
  eq(s6.parseErrors.length, 1, "坏卡进 parseErrors");
  ok(/无编号/.test(s6.parseErrors[0].file), "parseErrors 指出文件名");

  const uni = mkroot("unicode");
  fs.mkdirSync(path.join(uni, ".scratch"), { recursive: true });
  fs.writeFileSync(path.join(uni, ".scratch", "410-登录超时埋点补齐.md"),
    "\uFEFF---\r\nid: 410\r\ntype: ticket\r\nstatus: frontier\r\nlabels: [bug, needs-triage]\r\nblocked-by: 401\r\n---\r\n# 登录超时埋点补齐\r\n正文\r\n## 评论\r\n- **rx** (11-16)：全角冒号也能解析\r\n- **me**: 没有日期也行\r\n");
  const s7 = L.buildDeckState(uni);
  eq(s7.cards.length, 1, "BOM + CRLF + 中文文件名可解析");
  eq(s7.cards[0].title, "登录超时埋点补齐", "H1 标题");
  eq(s7.cards[0].labels.length, 2, "行内列表");
  eq(s7.cards[0].blockedBy, 401, "blocked-by");
  eq(s7.cards[0].comments.length, 2, "两种评论写法都认");
  eq(s7.cards[0].comments[0].tx, "全角冒号也能解析", "全角冒号正文");
}

/* ---------- 2. 演示数据只在显式开关下使用 ---------- */

async function testDemoGate() {
  section("演示数据门禁");
  const cfgMissing = L.resolveRootsConfig(path.join(TMP, "nope.json"));
  eq(cfgMissing.demo, false, "缺配置时 demo 为 false");
  eq(cfgMissing.active, "", "缺配置时不指定 active");
  eq(cfgMissing.roots.length, 0, "缺配置时 roots 为空");

  const cfgPath = path.join(TMP, "roots-valid.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ roots: ["~/code/x"], active: "~/code/y", demo: true }));
  const cfg = L.resolveRootsConfig(cfgPath);
  eq(cfg.demo, true, "配置里 demo:true 才开演示");
  eq(cfg.active, L.normalizeRoot("~/code/x"), "active 不在 roots 里时退到第一个");

  const badPath = path.join(TMP, "roots-bad.json");
  fs.writeFileSync(badPath, "{not json");
  const cfgBad = L.resolveRootsConfig(badPath);
  ok(!!cfgBad.error, "坏配置报 error 而不是静默");
  eq(cfgBad.roots.length, 0, "坏配置不产生 roots");

  // 检测失败且没有配置：必须 unresolved，不能伪装成 demo
  const page = makePage();
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: cfgMissing.configPath });
  h.sync();
  await waitFor(() => page.updates.length > 0, 2000, "未绑定时也应推一条状态");
  const st = last(page);
  eq(st.status, "unresolved", "检测失败 + 无配置 → unresolved");
  eq(st.root, null, "unresolved 不带 root");
  ok(!st.cards.length, "unresolved 没有卡片");
  h.stop();

  // 显式 demo 才用演示工作区
  const page2 = makePage();
  const fake2 = makeElectron({ pages: [page2] });
  const h2 = startLoader({ electron: fake2.electron, configPath: cfgMissing.configPath, demo: true });
  h2.sync();
  await waitFor(() => page2.updates.length > 0 && last(page2).cards.length > 0, 3000, "demo 模式应推演示卡片");
  eq(last(page2).root, L.DEMO_ROOT, "demo 模式 root 是演示工作区");
  eq(last(page2).rootSource, "demo", "rootSource 标为 demo");
  eq(last(page2).status, "ready", "demo 工作区是 ready");
  h2.stop();
}

/* ---------- 3. root 滞回 ---------- */

async function testHysteresis() {
  section("root 滞回");
  const A = mkroot("ws-a"); card(A, 501);
  const B = mkroot("ws-b"); card(B, 601);
  const page = makePage();
  page.root = A;
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: path.join(TMP, "nope.json") });
  h.sync();
  await waitFor(() => page.updates.length > 0, 2000, "首次绑定");
  eq(last(page).root, A, "首次绑定到 A");
  const bindsAfterFirst = page.updates.length;

  page.root = B;
  h.sync();
  await sleep(50);
  eq(last(page).root, A, "单次候选不切根");
  eq(page.updates.length, bindsAfterFirst, "单次候选不重推状态");

  page.root = A;
  h.sync();
  await sleep(50);
  eq(last(page).root, A, "回到 A 后候选被清空");

  page.root = B;
  h.sync();
  await sleep(50);
  h.sync();
  await waitFor(() => last(page).root === B, 2000, "连续命中后切到 B");
  ok(h.bindings.get(1).reason === "rebind-confirmed", "绑定原因记录为 rebind-confirmed");

  const diag = h.diag();
  const w = diag.windows[0];
  eq(w.root, B, "诊断里 root 是 B");
  ok(!!w.boundAt, "诊断里有绑定时间");

  // 检测失败不能把已绑定的 root 打回 demo 或 null
  page.failDetect = true;
  h.sync();
  await sleep(80);
  eq(last(page).root, B, "检测失败保留原绑定");
  h.stop();
}

/* ---------- 4. watcher：创建 / 删除 / 重建 / 改名 ---------- */

async function testWatchers() {
  section("watcher 生命周期");
  const root = mkroot("watch-root");
  const page = makePage();
  page.root = root;
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: path.join(TMP, "nope.json") });
  h.sync();
  await waitFor(() => page.updates.length > 0, 2000, "绑定 root");
  eq(last(page).status, "uninitialized", "初始没有 .scratch");
  eq(h.byRoot.get(root).watchKind, "parent", "此时监听父目录");

  fs.mkdirSync(path.join(root, ".scratch"));
  await waitFor(() => last(page).status === "ready", 4000, "创建 .scratch 后转 ready");
  eq(h.byRoot.get(root).watchKind, "scratch", ".scratch 出现后切到 scratch 监听");

  card(root, 701);
  await waitFor(() => last(page).cards.length === 1, 4000, "新增卡片推送到 renderer");
  eq(last(page).cards[0].id, 701, "卡片 id 正确");

  const renamed = path.join(root, ".scratch", "702-改名后.md");
  fs.renameSync(path.join(root, ".scratch", "701-测试卡.md"), renamed);
  await waitFor(() => last(page).cards.length === 1 && last(page).cards[0].id === 702, 4000,
    "改名后卡片 id 跟随文件名");

  const beforeDelete = page.updates.length;
  fs.rmSync(path.join(root, ".scratch"), { recursive: true, force: true });
  await waitFor(() => last(page).status === "uninitialized", 5000, "删除 .scratch 后转 uninitialized");
  ok(page.updates.length > beforeDelete, "删除后确实推送了新状态");
  eq(h.byRoot.get(root).watchKind, "parent", "删除后回到父目录监听");

  fs.mkdirSync(path.join(root, ".scratch"));
  await waitFor(() => last(page).status === "ready", 4000, "重建 .scratch 后回到 ready");
  h.stop();
}

/* ---------- 5. 注入生命周期（fake Electron） ---------- */

async function testInjection() {
  section("注入生命周期");
  const root = mkroot("inject-root"); card(root, 801);
  const page = makePage(); page.root = root;
  const extra = makePage(); extra.root = root;
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: path.join(TMP, "nope.json") });
  await waitFor(() => page.injected === 1, 2000, "已有窗口在 start 时注入一次");
  eq(page.injected, 1, "注入一次");
  await waitFor(() => page.updates.length > 0, 2000, "注入后立刻推状态");

  page.fire = (ev, ...a) => fake.wcs[0].fire(ev, ...a);
  page.fire("did-navigate");
  await waitFor(() => page.injected === 2, 2000, "did-navigate 触发再注入");
  page.fire("did-navigate-in-page");
  await waitFor(() => page.injected === 3, 2000, "did-navigate-in-page 触发再注入");

  const added = fake.addWindow(extra, 2);
  fake.fireWindowCreated(added.win);
  await waitFor(() => extra.injected === 1, 2000, "新建窗口注入");
  h.sync();
  await waitFor(() => extra.updates.length > 0, 2000, "新窗口拿到状态");
  eq(h.byRoot.get(root).wcs.size, 2, "两个窗口绑同一 root");
  const d = h.diag();
  eq(d.windows.length, 2, "诊断列出两个窗口");
  ok(d.stages.loaderLoaded === true && d.stages.startExecutedAt > 0, "诊断阶段：loader 已加载 / start 已执行");
  eq(d.stages.injectedWindows, 2, "诊断阶段：两个窗口都已注入");

  extra.destroyed = true;
  added.wc.fire("destroyed");
  await sleep(50);
  eq(h.bindings.size, 1, "窗口销毁后解绑");
  eq(h.byRoot.get(root).wcs.size, 1, "root 的窗口集同步收缩");

  // executeJavaScript 失败必须留下错误，不吞掉
  const bad = makePage(); bad.root = root; bad.failInject = true;
  const fake2 = makeElectron({ pages: [bad] });
  const h2 = startLoader({ electron: fake2.electron, configPath: path.join(TMP, "nope.json") });
  await waitFor(() => {
    const w = h2.diag().windows[0];
    return w && w.lastError && w.lastError.indexOf("inject boom") >= 0;
  }, 2000, "注入失败写入诊断");
  ok(true, "注入失败可见");
  h2.stop();

  // 推送失败也要可见
  page.failPush = true;
  h.refresh();
  await waitFor(() => {
    const w = h.diag().windows.find((x) => x.wcId === 1);
    return w && w.lastError && w.lastError.indexOf("push boom") >= 0;
  }, 3000, "推送失败写入诊断");
  page.failPush = false;
  h.stop();
}

/* ---------- 6. 动作闭环 ---------- */

async function testActions() {
  section("动作闭环");
  const root = mkroot("action-root");
  const f = card(root, 901);
  card(root, 902);
  const page = makePage(); page.root = root;
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: path.join(TMP, "nope.json") });
  h.sync();
  await waitFor(() => last(page).cards.length === 2, 3000, "绑定并解析");

  const eventsFile = path.join(root, ".scratch", ".deck-events.jsonl");
  const readEvents = () => fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

  // prompt 注入：注入成功记 ok，任务记 unknown
  page.actions.push({
    kind: "prompt.inject", cardId: 901, path: ".scratch/901-测试卡.md",
    root, sessionId: "sess-x", startedAt: Date.now(), result: "ok",
  });
  h.pollOutbox();
  await waitFor(() => fs.existsSync(eventsFile), 2000, "写入事件文件");
  let evs = readEvents();
  const injectEv = evs.find((e) => e.action === "prompt.inject");
  eq(injectEv.result, "ok", "prompt 注入记 ok");
  eq(injectEv.cardId, 901, "事件带 cardId");
  eq(injectEv.sessionId, "sess-x", "事件带 sessionId");
  ok(typeof injectEv.startedAt === "number" && typeof injectEv.finishedAt === "number", "事件有时间戳");
  const taskEv = evs.find((e) => e.action === "prompt.task");
  eq(taskEv.result, "unknown", "任务完成情况记 unknown 而不是伪造成功");
  ok(taskEv.finishedAt === null, "unknown 不带完成时间");

  // archive：真实写回 frontmatter
  page.actions.push({ kind: "archive", cardId: 901, path: ".scratch/901-测试卡.md", root, startedAt: Date.now() });
  h.pollOutbox();
  await waitFor(() => last(page).cards.find((c) => c.id === 901).status === "closed", 3000, "archive 后卡片关闭");
  const after = fs.readFileSync(f, "utf8");
  ok(/^---\n[\s\S]*?status: closed[\s\S]*?\n---\n/.test(after), "frontmatter status 已写回");
  ok(after.indexOf("# 卡片 901") >= 0, "正文保持完整");
  ok(after.indexOf("## 评论") >= 0, "评论节保持完整");
  eq(readEvents().filter((e) => e.action === "archive").pop().result, "ok", "archive 事件记 ok");

  // comment：追加到卡片
  page.actions.push({
    kind: "comment", cardId: 902, path: ".scratch/902-测试卡.md", root,
    text: "这条评论应落盘", who: "me", startedAt: Date.now(),
  });
  h.pollOutbox();
  await waitFor(() => fs.readFileSync(path.join(root, ".scratch", "902-测试卡.md"), "utf8").indexOf("这条评论应落盘") >= 0,
    3000, "评论写入卡片");
  const card902 = L.parseCard("902-测试卡.md", fs.readFileSync(path.join(root, ".scratch", "902-测试卡.md"), "utf8"), Date.now(), Date.now());
  ok(card902.comments.some((c) => c.tx === "这条评论应落盘"), "评论可被重新解析出来");

  // handoff：生成文件
  page.actions.push({ kind: "handoff", cardId: null, root, startedAt: Date.now() });
  h.pollOutbox();
  const handoffDir = path.join(root, ".scratch", "handoff");
  await waitFor(() => fs.existsSync(handoffDir) && fs.readdirSync(handoffDir).length > 0, 3000, "生成 handoff 文件");
  const hf = path.join(handoffDir, fs.readdirSync(handoffDir)[0]);
  const body = fs.readFileSync(hf, "utf8");
  ok(/^# 交接/.test(body), "handoff 有标题");
  ok(body.indexOf("## 未完成项") >= 0, "handoff 含未完成项");
  ok(body.indexOf("## 下一步") >= 0, "handoff 含下一步");
  ok(body.indexOf("给新会话的提示词") >= 0, "handoff 含新会话提示词");
  ok(body.indexOf("902") >= 0, "handoff 带卡片上下文");
  eq(readEvents().filter((e) => e.action === "handoff").pop().result, "ok", "handoff 事件记 ok");

  // 失败路径：文件不存在时记 failed，不抛
  page.actions.push({ kind: "archive", cardId: 999, path: ".scratch/999-不存在.md", root, startedAt: Date.now() });
  h.pollOutbox();
  await waitFor(() => readEvents().filter((e) => e.action === "archive" && e.result === "failed").length > 0,
    3000, "失败动作记 failed");
  ok(readEvents().filter((e) => e.action === "archive").pop().error, "失败事件带 error");

  // 未知动作
  page.actions.push({ kind: "no.such.action", root, startedAt: Date.now() });
  h.pollOutbox();
  await waitFor(() => readEvents().filter((e) => e.action === "no.such.action").length > 0, 3000, "未知动作也有记录");
  eq(readEvents().filter((e) => e.action === "no.such.action").pop().result, "failed", "未知动作记 failed");

  // 路径越界必须拒绝
  page.actions.push({ kind: "archive", cardId: 1, path: "../escape.md", root, startedAt: Date.now() });
  h.pollOutbox();
  await waitFor(() => readEvents().filter((e) => e.action === "archive" && e.result === "failed").length >= 2,
    3000, "越界路径被拒");
  const esc = readEvents().filter((e) => e.action === "archive").pop();
  ok(/越界|不在/.test(esc.error), "错误信息说明路径越界", esc.error);

  // unresolved 根上的动作：failed，且不写到工作区外
  h.stop();
  const page2 = makePage(); page2.root = null;
  const fake2 = makeElectron({ pages: [page2] });
  const h2 = startLoader({ electron: fake2.electron, configPath: path.join(TMP, "nope.json") });
  h2.sync();
  await waitFor(() => page2.updates.length > 0, 2000, "未绑定时推 unresolved");
  page2.actions.push({ kind: "archive", cardId: 1, path: ".scratch/1-x.md", startedAt: Date.now() });
  h2.pollOutbox();
  await sleep(200);
  ok(fs.readdirSync(TMP).every((n) => n !== ".scratch"), "没有在工作区外写出 .scratch");
  h2.stop();
}

/* ---------- 7. 诊断文件 ---------- */

async function testDiag() {
  section("诊断文件");
  const root = mkroot("diag-root"); card(root, 1001);
  const page = makePage(); page.root = root;
  const fake = makeElectron({ pages: [page] });
  const h = startLoader({ electron: fake.electron, configPath: path.join(TMP, "nope.json") });
  h.sync();
  await waitFor(() => page.updates.length > 0, 2000, "绑定");
  await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(L.DIAG_FILE, "utf8")).windows.length === 1;
    } catch (e) { return false; }
  }, 3000, "诊断文件包含窗口");
  ok(fs.existsSync(L.DIAG_FILE), "诊断文件已落盘", L.DIAG_FILE);
  const doc = JSON.parse(fs.readFileSync(L.DIAG_FILE, "utf8"));
  eq(doc.schema, 2, "诊断 schema");
  ok(doc.stages && doc.stages.startExecutedAt > 0, "诊断记录 start 时刻");
  ok(Array.isArray(doc.windows) && doc.windows.length === 1, "诊断记录窗口");
  eq(doc.windows[0].cardCount, 1, "诊断记录卡片数");
  ok(Array.isArray(doc.watchers) && doc.watchers[0].kind === "scratch", "诊断记录 watcher");
  ok(!JSON.stringify(doc).includes("token"), "诊断不含凭据字段");
  h.stop();
}

/* ---------- 7. CLI（位置参数解析是真实回归过的 bug） ---------- */

function captureCli(argv) {
  const chunks = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  const prevCode = process.exitCode;
  process.exitCode = 0;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try {
    L.runCli(["node", "deck-loader"].concat(argv));
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    var code = process.exitCode;
    process.exitCode = prevCode;
  }
  return { out: chunks.join(""), code: code };
}

function testCli() {
  section("CLI");
  const ready = mkroot("cli-ready");
  card(ready, 2001);
  const uninit = mkroot("cli-uninit");

  const a = captureCli(["--once", ready]);
  eq(a.code, 0, "--once <ready> 退出码 0");
  const sa = JSON.parse(a.out);
  eq(sa.status, "ready", "--once 解析出 ready");
  eq(sa.cards.length, 1, "--once 解析出卡片");
  eq(sa.cards[0].id, 2001, "卡片 id");

  const b = captureCli(["--once", uninit]);
  eq(b.code, 0, "--once <无 .scratch> 退出码 0");
  eq(JSON.parse(b.out).status, "uninitialized", "--once 报 uninitialized");

  const c = captureCli(["--once", path.join(TMP, "no-such-root")]);
  eq(c.code, 0, "--once <不存在> 退出码 0");
  eq(JSON.parse(c.out).status, "unresolved", "--once 报 unresolved");

  const d = captureCli(["--once", "--demo"]);
  eq(d.code, 0, "--once --demo 退出码 0");
  const sd = JSON.parse(d.out);
  eq(sd.status, "ready", "demo 是 ready");
  eq(sd.cards.length, 10, "demo 有 10 张卡");
  eq(sd.rootSource, "demo", "demo 标注来源");

  const e = captureCli(["--once"]);
  eq(e.code, 1, "缺 root 且无配置时退出码 1");
  ok(/没有工作区/.test(e.out), "提示缺工作区");
}

(async function main() {
  try {
    testRootStates();
    await testDemoGate();
    await testHysteresis();
    await testWatchers();
    await testInjection();
    await testActions();
    testCli();
    await testDiag();
  } catch (e) {
    failures.push("未捕获异常：" + (e && e.stack || e));
  }
  console.log("\n" + (failures.length ? "FAILED" : "OK") + "  passed=" + pass + " failed=" + failures.length);
  for (const f of failures) console.log("  ✗ " + f);
  process.exitCode = failures.length ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 100);
})();

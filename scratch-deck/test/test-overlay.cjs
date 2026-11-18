#!/usr/bin/env node
/* deck-overlay 的自动化测试：在 dom-shim 里跑真实 overlay 源码。
 * 覆盖 composer 选择顺序、pane 约束、隐藏语义、销毁/重注入、三态渲染与动作队列。
 * 不验证真实排版——那需要真机；这里验证的是"选谁、挂哪、什么时候藏起来"。 */
"use strict";
const path = require("path");
const { createPage, loadOverlayInto, el, rect } = require("./dom-shim.cjs");

let pass = 0;
const failures = [];
function ok(cond, msg, extra) {
  if (cond) { pass++; return; }
  failures.push(msg + (extra === undefined ? "" : " :: " + JSON.stringify(extra)));
}
function eq(actual, expected, msg) { ok(actual === expected, msg, { actual, expected }); }
function section(n) { console.log("\n# " + n); }
const tick = () => new Promise((r) => setTimeout(r, 12));

function card(id, over) {
  return Object.assign({
    id, type: "ticket", title: "卡片 " + id, status: "open", labels: [], blockedBy: null,
    children: [], author: "me", updated: "2026-11-18", next: null, writing: false,
    path: ".scratch/" + id + "-c.md", body: "正文", comments: [],
  }, over || {});
}
function stateReady(cards, over) {
  return Object.assign({
    schema: 2, root: "/work/repo", rootSource: "window", status: "ready", diagnosis: null,
    cards: cards || [], counts: { takeable: 1, occupied: 1, bug: 0, triage: 0, blocked: 0, closed: 0 },
    parseErrors: [], updatedAt: Date.now(), notices: [], version: "0.1.1",
    checks: null, git: null, tracker: null,
  }, over || {});
}

/* ---------- 页面骨架 ---------- */

function composerCard(page, parent, opts) {
  const host = el(page, "div", { class: "composer-card" }, opts.hostRect);
  const surface = el(page, "div", { class: "chat-composer-input-surface" }, opts.surfaceRect);
  const ta = el(page, "textarea", opts.taAttrs || {}, opts.taRect);
  ta.__value = "";
  surface.append(ta);
  const send = el(page, "button", { class: "send" }, rect(0, 0, 30, 30));
  host.append(surface, send);
  parent.append(host);
  return { host, surface, ta, send };
}

function buildChat(page, opts) {
  opts = opts || {};
  const main = el(page, "div", { "data-pane-id": "main" }, rect(0, 0, 1000, 900));
  const scroller = el(page, "div", { class: "scroller" }, rect(0, 0, 1000, 650));
  main.append(scroller);
  const c = composerCard(page, main, {
    hostRect: rect(50, 650, 900, 200),
    surfaceRect: rect(60, 660, 880, 90),
    taRect: rect(70, 670, 800, 60),
    taAttrs: { "data-testid": "v4-composer-input", "aria-label": "输入框" },
  });
  page.document.body.append(main);
  return { main, composer: c };
}

function addSidePane(page) {
  const side = el(page, "div", { "data-pane-id": "side", "data-testid": "selection-side-chat" }, rect(1000, 0, 400, 900));
  const c = composerCard(page, side, {
    hostRect: rect(1010, 650, 380, 200),
    surfaceRect: rect(1020, 660, 360, 90),
    taRect: rect(1030, 670, 300, 60),
    taAttrs: { "data-testid": "v4-composer-input", "aria-label": "辅助对话输入框" },
  });
  page.document.body.append(side);
  return { side, composer: c };
}

function btns(root) {
  return root.querySelectorAll("button");
}
function findByText(root, text) {
  return root._walk([]).find((e) => e.tagName === "BUTTON" && e.textContent.indexOf(text) >= 0) || null;
}
function root(page) { return page.document.getElementById("deck-root"); }
function paneKeyOf(node) {
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const v = n.getAttribute && n.getAttribute("data-pane-id");
    if (v) return v;
  }
  return null;
}
function visible(page) {
  const r = root(page);
  return !!(r && r.style.display !== "none" && r.isConnected);
}

/* ---------- 1. composer 选择 ---------- */

async function testMainVsAux() {
  section("主 composer + 辅助 composer");
  const page = createPage();
  const { main } = buildChat(page);
  const side = addSidePane(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();

  const r = root(page);
  ok(!!r, "overlay 已挂载");
  eq(r.parentElement, main.querySelector(".composer-card"), "挂在主 pane 的 composer 卡片里");
  ok(!side.composer.host.contains(r), "没有挂到辅助 pane");
  eq(page.window.__deckDiag().paneId, "main", "诊断记录 paneId=main");
  ok(visible(page), "有 composer 时可见");
}

async function testOnlyAux() {
  section("只有辅助 composer");
  const page = createPage();
  const side = addSidePane(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  const r = root(page);
  eq(r.parentElement, side.composer.host, "没有主栏时用辅助栏");
  eq(page.window.__deckDiag().paneId, "side", "paneId 记为 side");
}

async function testExclusions() {
  section("设置页 / 插件市场 / 自动化页覆盖聊天");
  const pages = [
    ["设置页", { "data-testid": "settings-page" }],
    ["插件市场", { "data-testid": "plugin-market-page" }],
    ["自动化页", { "data-testid": "automation-page" }],
    ["对话框", { role: "dialog" }],
  ];
  for (const [label, attrs] of pages) {
    const page = createPage();
    const wrap = el(page, "div", attrs, rect(0, 0, 1400, 900));
    page.document.body.append(wrap);
    const chat = el(page, "div", {}, rect(0, 0, 1400, 900));
    wrap.append(chat);
    composerCard(page, chat, {
      hostRect: rect(50, 650, 1300, 200), surfaceRect: rect(60, 660, 1280, 90),
      taRect: rect(70, 670, 1200, 60), taAttrs: { "data-testid": "v4-composer-input" },
    });
    loadOverlayInto(page);
    page.window.__deckUpdate(stateReady([card(1)]));
    await tick();
    const d = page.window.__deckDiag();
    ok(!visible(page), label + "：overlay 必须隐藏", d);
    eq(d.hiddenReason, "no-composer", label + "：隐藏原因是 no-composer");
    ok(page.document.querySelectorAll("#deck-root").length <= 1, label + "：不存在重复 overlay");
  }
}

/* ---------- 2. 生命周期 ---------- */

async function testComposerRemovedAndRestored() {
  section("composer 被删掉后恢复");
  const page = createPage();
  const { main, composer } = buildChat(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  ok(visible(page), "初始可见");

  composer.host.remove();
  await tick();
  ok(!visible(page), "composer 消失后 overlay 隐藏");
  eq(page.window.__deckDiag().hiddenReason, "no-composer", "隐藏原因正确");
  ok(page.document.body.children.indexOf(root(page)) < 0 || root(page).style.display === "none",
    "不是浮动在页面其他位置");

  const again = composerCard(page, main, {
    hostRect: rect(50, 650, 900, 200), surfaceRect: rect(60, 660, 880, 90),
    taRect: rect(70, 670, 800, 60), taAttrs: { "data-testid": "v4-composer-input" },
  });
  await tick();
  ok(visible(page), "composer 恢复后 overlay 重新出现");
  eq(root(page).parentElement, again.host, "挂到新的 composer 卡片");
}

async function testReinjection() {
  section("导航后重新注入");
  const page = createPage();
  buildChat(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  const gen1 = page.window.__deckDiag().generation;
  const resizeBefore = page.listeners.get("resize").size;
  const keyBefore = page.document._captureListeners.size;

  // 模拟 loader 的 did-navigate：先 dispose 再执行同一段脚本
  page.window.__deckDispose();
  await tick();
  eq(page.document.querySelectorAll("#deck-root").length, 0, "dispose 后 DOM 清干净");
  eq(page.document.getElementById("deck-overlay-style"), null, "dispose 后样式清掉");
  page.document.body.append(el(page, "div", { class: "deck-hovmenu" }, rect(0, 0, 10, 10)));
  page.window.__deckDispose();
  eq(page.document.querySelectorAll(".deck-hovmenu").length, 1, "二次 dispose 不再移除新浮层（幂等）");

  // 清理后重新注入：新实例定义在旧作用域之上
  page.document.querySelectorAll(".deck-hovmenu").forEach((n) => n.remove());
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(2)]));
  await tick();
  const gen2 = page.window.__deckDiag().generation;
  ok(gen2 > gen1, "generation 单调递增", { gen1, gen2 });
  eq(page.document.querySelectorAll("#deck-root").length, 1, "重新注入后只有一个 overlay");
  eq(page.listeners.get("resize").size, resizeBefore, "resize 监听没有累积");
  eq(page.document._captureListeners.size, keyBefore, "文档 capture 监听没有累积");
  ok(visible(page), "重新注入后可见");

  // 旧实例不能再响应更新
  const before = page.window.__deckDiag().lastUpdateAt;
  page.window.__deckUpdate(stateReady([card(3), card(4)]));
  await tick();
  eq(page.window.__deckDiag().cardCount, 2, "新实例接管状态");
  ok(page.window.__deckDiag().lastUpdateAt >= before, "更新时间前进");
}

async function testPaneCollision() {
  section("双 pane 切换与单实例");
  const page = createPage();
  const { main, composer } = buildChat(page);
  const side = addSidePane(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  eq(page.document.querySelectorAll("#deck-root").length, 1, "始终只有一个 overlay");
  eq(root(page).parentElement, composer.host, "先在主 pane");

  composer.host.remove();
  await tick();
  eq(root(page).parentElement, side.composer.host, "主 pane 消失后移到辅助 pane");
  eq(page.window.__deckDiag().paneId, "side", "paneId 跟着变");
  eq(page.document.querySelectorAll("#deck-root").length, 1, "移动而不是复制");

  // 把面板打开再切 pane，body 级浮层必须被清掉
  const panel = page.document.querySelector(".sheet");
  ok(!!panel, "面板存在");
  panel.hidden = false;
  page.document.body.append(el(page, "div", { class: "deck-entry" }, rect(0, 0, 10, 10)));
  const main2 = el(page, "div", { "data-pane-id": "main2" }, rect(0, 0, 1200, 900));
  page.document.body.append(main2);
  composerCard(page, main2, {
    hostRect: rect(20, 640, 1100, 220), surfaceRect: rect(30, 650, 1080, 100),
    taRect: rect(40, 660, 1000, 60), taAttrs: { "data-testid": "v4-composer-input" },
  });
  await tick();
  eq(paneKeyOf(root(page)), "main2", "换到更大的 pane");
  eq(page.document.querySelectorAll(".deck-entry").length, 0, "换 pane 时清掉 body 级弹窗");
  eq(panel.hidden, true, "换 pane 时收起面板");
}

/* ---------- 3. 三态渲染 ---------- */

async function testThreeStates() {
  section("三态渲染");
  const page = createPage();
  buildChat(page);
  loadOverlayInto(page);

  page.window.__deckUpdate(stateReady([card(1, { status: "frontier" }), card(2, { status: "closed" })]));
  await tick();
  const rows = page.document.querySelectorAll(".row");
  eq(rows.length, 2, "ready 渲染两行");
  ok(page.document.querySelector(".sheet").textContent.indexOf("本地 .scratch") >= 0, "ready 徽标");

  page.window.__deckUpdate(stateReady([], { status: "uninitialized", root: "/work/repo", diagnosis: { code: "no-scratch", message: "这个工作区还没有 .scratch/ 目录" } }));
  await tick();
  const listText = page.document.querySelector(".dlist").textContent;
  ok(listText.indexOf("尚未初始化 Scratch Deck") >= 0, "uninitialized 有明确空态", listText.slice(0, 80));
  ok(listText.indexOf(".scratch") >= 0, "说明缺什么");
  ok(page.document.querySelector(".dhead").textContent.indexOf("未初始化") >= 0, "头部徽标切到未初始化");

  page.window.__deckUpdate(stateReady([], { status: "unresolved", root: null, diagnosis: { code: "root-missing", message: "工作区路径不存在或不可读：/gone" } }));
  await tick();
  const t2 = page.document.querySelector(".dlist").textContent;
  ok(t2.indexOf("检测不到工作区") >= 0, "unresolved 有诊断空态", t2.slice(0, 80));
  ok(t2.indexOf("/gone") >= 0, "展示真实原因");
  ok(t2.indexOf("演示") >= 0, "明确说明不回退演示数据");
  eq(page.document.querySelectorAll(".row").length, 0, "unresolved 不渲染任何卡片");
}

/* ---------- 4. 动作队列 ---------- */

async function testActions() {
  section("动作队列");
  const page = createPage();
  const { composer } = buildChat(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([
    card(11, { status: "frontier", title: "待办一" }),
    card(12, { status: "open", labels: ["bug"], title: "故障二" }),
  ]));
  await tick();

  const drain = () => page.window.__deckDrainActions();
  eq(drain().length, 0, "初始队列为空");

  const prim = findByText(page.document.querySelector(".dlist"), "执行");
  ok(!!prim, "找到主按钮");
  prim.click();
  await tick();
  let acts = drain();
  eq(acts.length, 1, "主按钮产生一条动作");
  eq(acts[0].kind, "prompt.inject", "动作类型是 prompt.inject");
  eq(acts[0].result, "ok", "注入成功");
  eq(acts[0].cardId, 11, "带 cardId");
  eq(acts[0].path, ".scratch/11-c.md", "带卡片路径");
  eq(acts[0].root, "/work/repo", "带 root");
  ok(typeof acts[0].startedAt === "number", "带 startedAt");
  ok(composer.ta.__value.length > 0, "输入框已被填充");
  ok(composer.ta.__value.indexOf(".scratch/11-c.md") >= 0, "prompt 里带卡片路径");

  // 打开详情 → 归档 / 交接 / 评论
  page.document.querySelectorAll(".row")[0].click();
  await tick();
  const detail = page.document.querySelector(".ddetail");
  ok(detail.classList.contains("on"), "进入详情");
  findByText(detail, "归档").click();
  await tick();
  acts = drain();
  eq(acts[0].kind, "archive", "归档动作进入队列");
  eq(acts[0].cardId, 11, "归档带 cardId");

  findByText(detail, "交接").click();
  await tick();
  acts = drain();
  eq(acts[0].kind, "handoff", "交接动作进入队列");

  const inp = detail.querySelector("input");
  inp.value = "这条评论要落盘";
  findByText(detail, "发送").click();
  await tick();
  acts = drain();
  eq(acts[0].kind, "comment", "评论动作进入队列");
  eq(acts[0].text, "这条评论要落盘", "评论正文");
  eq(acts[0].who, "me", "评论作者");

  // 没有 composer 时 overlay 隐藏，但状态不清空（恢复后立刻可见）
  composer.host.remove();
  await tick();
  ok(!visible(page), "composer 移除后隐藏");
  eq(page.window.__deckDiag().cardCount, 2, "状态仍在，只是不可见");
}

async function testNotices() {
  section("通知回传");
  const page = createPage();
  buildChat(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  const st = stateReady([card(1)], {
    notices: [{ id: 9, kind: "ok", text: "已归档", at: Date.now() }],
  });
  page.window.__deckUpdate(st);
  await tick();
  const host = page.document.getElementById("deck-toasts");
  ok(!!host, "toast 宿主已创建");
  ok(host.textContent.indexOf("已归档") >= 0, "通知被展示", host.textContent);
  page.window.__deckUpdate(st);
  await tick();
  eq(host.querySelectorAll(".toast").length, 1, "同一条通知不会重复弹");
}

async function testDiagAndEscape() {
  section("诊断与 Esc");
  const page = createPage();
  buildChat(page);
  loadOverlayInto(page);
  page.window.__deckUpdate(stateReady([card(1)]));
  await tick();
  const d = page.window.__deckDiag();
  eq(d.overlayCount, 1, "诊断报告一个 overlay");
  eq(d.mounted, true, "诊断报告已挂载");
  eq(d.stateStatus, "ready", "诊断报告状态");
  ok(d.composerFound, "诊断报告找到 composer");
  ok(page.window.__deckGetRoot !== undefined, "工作区识别入口存在");

  page.document.querySelector(".sheet").hidden = false;
  page.document.body.append(el(page, "div", { class: "deck-entry" }));
  page.document.dispatchEvent({ type: "keydown", key: "Escape", target: page.document.body });
  eq(page.document.querySelectorAll(".deck-entry").length, 0, "Esc 关掉新建弹窗");
  eq(page.document.querySelector(".sheet").hidden, true, "Esc 收起面板");
}

(async function main() {
  try {
    await testMainVsAux();
    await testOnlyAux();
    await testExclusions();
    await testComposerRemovedAndRestored();
    await testReinjection();
    await testPaneCollision();
    await testThreeStates();
    await testActions();
    await testNotices();
    await testDiagAndEscape();
  } catch (e) {
    failures.push("未捕获异常：" + (e && e.stack || e));
  }
  console.log("\n" + (failures.length ? "FAILED" : "OK") + "  passed=" + pass + " failed=" + failures.length);
  for (const f of failures) console.log("  ✗ " + f);
  process.exitCode = failures.length ? 1 : 0;
  // 垫片的 MutationObserver 用 setTimeout 排微任务；不硬退会留在事件循环里
  setTimeout(() => process.exit(process.exitCode), 20);
})();

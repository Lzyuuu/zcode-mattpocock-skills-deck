/* Scratch Deck overlay（renderer 侧 IIFE）。
 * 入口 window.__deckUpdate(DeckState)；样式与交互照搬 prototype/deck-prototype.html
 * 变体 D（胶囊状态行 + 底部上弹五页签面板），数据源改为推送。
 * 动作不再只是填输入框：填完后把 action 压进 __deckDrainActions()，由主进程
 * loader 落盘事件、写回卡片、生成 handoff，并把结果作为 notices 推回来。 */
(function () {
  "use strict";
  /* 同一页面里可能被反复注入（did-navigate-in-page / 热更新 / 多窗口切换）。
     旧实例必须先拆干净，否则两份 overlay 会抢同一个输入框、监听器也越积越多。 */
  if (typeof window.__deckDispose === "function") {
    try { window.__deckDispose(); } catch (e) { }
  }
  var GEN = (window.__deckGeneration || 0) + 1;
  window.__deckGeneration = GEN;
  window.__scratchDeckOverlay = GEN;
  var TOKEN = "deck-" + GEN + "-" + Date.now();
  var disposed = false;
  var initedAt = 0, lastUpdateAt = 0, lastError = null;
  var hiddenReason = "not-mounted", mountedPaneKey = null;
  var mo = null;
  var outbox = [];

  /* ================= 图标 ================= */
  var P = {
    map: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2.5 5.5L9 15l2.5-5.5z"/>',
    bug: '<path d="M12 8a4 4 0 0 1 4 4v2a4 4 0 0 1-8 0v-2a4 4 0 0 1 4-4z"/><path d="M9 13H5m14 0h-4M9.5 9.5 7 7m7.5 2.5L17 7M9.5 16 7 19m7.5-3 2.5 3M12 8V5"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    dot: '<circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/>',
    alert: '<path d="M12 4L2.5 20h19z"/><path d="M12 10v4m0 3v.01"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 3v4h-4"/>',
    chevD: '<path d="M6 9l6 6 6-6"/>', chevU: '<path d="M6 15l6-6 6 6"/>', chevL: '<path d="M15 5l-7 7 7 7"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    ext: '<path d="M14 4h6v6M20 4L11 13"/><path d="M9 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M9 11V8a3 3 0 0 1 6 0v3"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    archive: '<rect x="4" y="5" width="16" height="4" rx="1"/><path d="M6 9v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1"/>'
  };
  function ic(n, s) {
    return '<svg class="ic" style="width:' + (s || 13) + 'px;height:' + (s || 13) + 'px" viewBox="0 0 24 24" aria-hidden="true">' + P[n] + "</svg>";
  }

  /* ================= 样式（prototype 变体 D 子集，全部收在 #deck-root 作用域下防宿主冲突） ================= */
  var CSS = ""
    + ":root{--dk-bg:#0f1115;--dk-surface:#16181d;--dk-surface-2:#1b1f26;--dk-surface-3:#22262e;--dk-border:#2a2d35;--dk-fg:#e8e8ec;--dk-muted:#a1a1aa;--dk-muted-2:#8b8b95;--dk-ok:#4ade80;--dk-danger:#f87171;--dk-warn:#f59e0b;--dk-info:#58a6ff;--dk-map:#bc8cff;--dk-spec:#7aa2f7;--dk-overlay:rgba(0,0,0,.65);--dk-shadow:0 8px 30px rgba(0,0,0,.45);--dk-shadow-sm:0 4px 16px rgba(0,0,0,.35);--dk-r-s:6px;--dk-r-m:8px;--dk-r-pill:99px;--dk-fs-cap:11px;--dk-fs-small:12px;--dk-fs-body:13px;--dk-fs-mid:15px}"
    + "#deck-root{position:relative;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:var(--dk-fs-body);line-height:1.5;color:var(--dk-fg);-webkit-font-smoothing:antialiased}"
    + "#deck-root *{box-sizing:border-box;margin:0;padding:0}"
    + "#deck-root.deck-floating{position:fixed;left:50%;transform:translateX(-50%);bottom:88px;z-index:2147483000;width:min(720px,92vw)}"
    + "#deck-root.deck-inline{position:relative;width:100%;margin:4px 0 2px;padding:0}"
    + "#deck-root .sheet.deck-sheet-fixed{position:fixed;left:auto;right:auto;bottom:auto;z-index:2147483000}"
    + "#deck-root button{font:inherit;color:inherit;background:none;border:none;cursor:pointer}"
    + "#deck-root :focus-visible{outline:2px solid var(--dk-info);outline-offset:1px;border-radius:4px}"
    + "#deck-root .num{font-variant-numeric:tabular-nums;min-width:2ch;text-align:right}"
    + "#deck-root .cap{font-size:var(--dk-fs-cap);letter-spacing:.02em}"
    + "#deck-root svg.ic{width:1em;height:1em;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}"
    + "#deck-root .capsule{display:flex;align-items:center;gap:2px;flex-wrap:nowrap;overflow:hidden;background:var(--dk-surface-2);border:1px solid var(--dk-border);border-radius:var(--dk-r-pill);padding:3px 6px;margin:0 auto;width:100%;box-shadow:var(--dk-shadow-sm);font-size:var(--dk-fs-cap)}"
    + "#deck-root .capsule .brand{display:flex;align-items:center;gap:6px;color:var(--dk-map);font-weight:600;letter-spacing:.02em;padding:3px 8px;border-radius:var(--dk-r-s);flex:none}"
    + "#deck-root .capsule .brand:hover{background:rgba(188,140,252,.12)}"
    + "#deck-root .capsule .seg{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:var(--dk-r-s);color:var(--dk-muted);white-space:nowrap;flex:none;min-height:24px;letter-spacing:.01em}"
    + "#deck-root .capsule .seg:hover{background:var(--dk-surface-3)}"
    + "#deck-root .capsule .seg[data-seg=takeable]{color:var(--dk-ok)}"
    + "#deck-root .capsule .seg[data-seg=bug]{color:var(--dk-danger)}"
    + "#deck-root .capsule .seg[data-seg=triage]{color:var(--dk-warn)}"
    + "#deck-root .capsule .seg[data-seg=env]{color:var(--dk-warn)}"
    + "#deck-root .capsule .split{display:inline-flex;flex:none;border-radius:var(--dk-r-pill);overflow:hidden;color:var(--dk-info)}"
    + "#deck-root .capsule .split button{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;min-height:24px;letter-spacing:.01em}"
    + "#deck-root .capsule .split button:hover{background:rgba(88,166,255,.12)}"
    + "#deck-root .capsule .split .l{border-radius:99px 0 0 99px}"
    + "#deck-root .capsule .split .r{border-radius:0 99px 99px 0;border-left:1px solid rgba(88,166,255,.25)}"
    + "#deck-root .capsule .timebtn{display:inline-flex;align-items:center;gap:6px;color:var(--dk-ok);padding:3px 8px;border-radius:var(--dk-r-s);min-height:24px;flex:none}"
    + "#deck-root .capsule .timebtn:hover{background:var(--dk-surface-3)}"
    + "#deck-root .capsule .timebtn .spin{animation:deck-rot 1s linear infinite}"
    + "@keyframes deck-rot{to{transform:rotate(360deg)}}"
    + "#deck-root .capsule .foldtg{margin-left:auto;color:var(--dk-muted);padding:3px 6px;border-radius:var(--dk-r-s);flex:none;min-height:24px}"
    + "#deck-root .capsule .foldtg:hover{background:var(--dk-surface-3)}"
    + "#deck-root .capsule [hidden]{display:none!important}"
    + ".deck-hovmenu{position:absolute;z-index:2147483000;background:var(--dk-surface,#16181d);border:1px solid #2a2d35;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);padding:4px;min-width:132px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}"
    + ".deck-hovmenu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:6px 10px;border-radius:6px;font-size:12px;min-height:28px;color:#e8e8ec;background:none;border:none;cursor:pointer}"
    + ".deck-hovmenu button:hover{background:#22262e}"
    + ".deck-entry{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}"
    + ".deck-entry[hidden]{display:none}"
    + ".deck-entry .ebox{width:min(640px,92vw);background:#16181d;border:1px solid #2a2d35;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.45);padding:16px;color:#e8e8ec}"
    + ".deck-entry .ehd{font-size:15px;font-weight:600;margin-bottom:12px}"
    + ".deck-entry .ecards{display:grid;grid-template-columns:1fr 1fr;gap:10px}"
    + "@media (max-width:560px){.deck-entry .ecards{grid-template-columns:1fr}}"
    + ".deck-entry .ecard{border:1px solid #2a2d35;border-radius:8px;padding:12px;text-align:left;background:#1b1f26;min-height:128px;display:flex;flex-direction:column;gap:5px;color:#e8e8ec;cursor:pointer}"
    + ".deck-entry .ecard:hover{border-color:#bc8cff;background:rgba(188,140,252,.06)}"
    + ".deck-entry .brow{font-size:11px;color:#bc8cff;letter-spacing:.06em}"
    + ".deck-entry .bst{font-size:12px;font-weight:600}"
    + ".deck-entry .bbd{font-size:11px;color:#a1a1aa;line-height:1.6}"
    + ".deck-entry .bch{margin-top:auto;font-size:10px;color:#8b8b95;font-family:ui-monospace,Menlo,monospace}"
    + "#deck-root .sheet{position:absolute;left:12px;right:12px;bottom:12px;max-height:78vh;background:var(--dk-surface);border:1px solid var(--dk-border);border-radius:var(--dk-r-m);box-shadow:var(--dk-shadow);display:flex;flex-direction:column;overflow:hidden;z-index:100}"
    + "#deck-root .sheet[hidden]{display:none}"
    + "#deck-root .dhead{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dk-border);flex:none}"
    + "#deck-root .dhead .ttl{font-size:var(--dk-fs-mid);font-weight:600}"
    + "#deck-root .dhead .demo{font-size:10px;color:var(--dk-muted-2);border:1px solid var(--dk-border);border-radius:var(--dk-r-pill);padding:1px 7px;letter-spacing:.06em}"
    + "#deck-root .dhead .smini{display:flex;align-items:center;gap:8px;margin-left:4px}"
    + "#deck-root .dhead .smini .ring{width:22px;height:22px}"
    + "#deck-root .dhead .x{margin-left:auto;width:26px;height:26px;border-radius:var(--dk-r-s);display:grid;place-items:center;color:var(--dk-muted)}"
    + "#deck-root .dhead .x:hover{background:var(--dk-surface-3);color:var(--dk-fg)}"
    + "#deck-root .dhead .x+.x{margin-left:0}"
    + "#deck-root .dtabs{display:flex;gap:2px;padding:6px 10px;border-bottom:1px solid var(--dk-border);flex:none}"
    + "#deck-root .dtabs button{padding:5px 11px;border-radius:var(--dk-r-s);font-size:var(--dk-fs-small);color:var(--dk-muted);min-height:28px}"
    + "#deck-root .dtabs button.on{background:var(--dk-surface-3);color:var(--dk-fg)}"
    + "#deck-root .dtabs button:hover:not(.on){color:var(--dk-fg)}"
    + "#deck-root .filterrow{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid var(--dk-border);flex:none;flex-wrap:wrap}"
    + "#deck-root .filterrow button{font-size:var(--dk-fs-cap);padding:3px 10px;border-radius:var(--dk-r-pill);border:1px solid var(--dk-border);color:var(--dk-muted);min-height:24px}"
    + "#deck-root .filterrow button.on{color:var(--dk-fg);border-color:transparent}"
    + "#deck-root .filterrow button.on[data-f=frontier]{background:rgba(74,222,128,.16);color:var(--dk-ok)}"
    + "#deck-root .filterrow button.on[data-f=bug]{background:rgba(248,113,113,.16);color:var(--dk-danger)}"
    + "#deck-root .filterrow button.on[data-f=needs-triage]{background:rgba(245,158,11,.14);color:var(--dk-warn)}"
    + "#deck-root .filterrow button.on[data-f=doing]{background:rgba(245,158,11,.14);color:var(--dk-warn)}"
    + "#deck-root .filterrow button.on[data-f=closed]{background:rgba(139,139,149,.16);color:var(--dk-muted)}"
    + "#deck-root .dlist{flex:1;overflow:auto;padding:6px}"
    + "#deck-root .row{display:flex;flex-direction:column;gap:2px;padding:8px 9px;border-radius:var(--dk-r-s);cursor:pointer;position:relative}"
    + "#deck-root .row:hover{background:var(--dk-surface-2)}"
    + "#deck-root .row.cont{border-left:3px solid var(--dk-map);background:rgba(188,140,252,.05);margin:3px 0}"
    + "#deck-root .row.cont.spec{border-left-color:var(--dk-spec);background:rgba(122,162,247,.05)}"
    + "#deck-root .row .l1{display:flex;align-items:center;gap:8px}"
    + "#deck-root .row .l2{display:flex;align-items:center;gap:6px;margin-top:2px;min-height:22px;flex-wrap:wrap}"
    + "#deck-root .cbadge{display:inline-flex;flex-direction:column;align-items:center;line-height:1.15;flex:none;border-radius:4px;padding:2px 5px;font-size:9px;letter-spacing:.06em}"
    + "#deck-root .cbadge .n{font-size:var(--dk-fs-cap);font-weight:600}"
    + "#deck-root .cbadge.map{background:rgba(188,140,252,.14);color:var(--dk-map)}"
    + "#deck-root .cbadge.spec{background:rgba(122,162,247,.14);color:var(--dk-spec)}"
    + "#deck-root .tnum{font-size:var(--dk-fs-cap);color:var(--dk-muted);font-weight:600;flex:none}"
    + "#deck-root .writing{display:inline-flex;align-items:center;gap:4px;font-size:9px;color:var(--dk-info);border:1px dashed var(--dk-info);border-radius:4px;padding:1px 5px;opacity:.85;flex:none}"
    + "#deck-root .rttl{font-size:var(--dk-fs-small);line-height:1.35;flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}"
    + "#deck-root .row.closed .rttl{color:var(--dk-muted-2)}"
    + "#deck-root .row.cont .rttl{font-weight:600}"
    + "#deck-root .ava{width:16px;height:16px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:9px;font-weight:600;border:2px solid var(--dk-ok)}"
    + "#deck-root .rwrap{display:flex;align-items:center;gap:3px;flex:none}"
    + "#deck-root .ring{width:18px;height:18px;flex:none}"
    + "#deck-root .ring svg{transform:rotate(-90deg);display:block}"
    + "#deck-root .ring+.cnt{font-size:8.5px;color:var(--dk-muted)}"
    + "#deck-root .chip{font-size:10px;padding:1px 7px;border-radius:var(--dk-r-pill);flex:none}"
    + "#deck-root .chip.bug{background:rgba(248,113,113,.16);color:var(--dk-danger)}"
    + "#deck-root .chip.tri{background:rgba(245,158,11,.14);color:var(--dk-warn)}"
    + "#deck-root .chip.gen{background:rgba(139,139,149,.14);color:var(--dk-muted)}"
    + "#deck-root .chip.closedchip{background:rgba(139,139,149,.12);color:var(--dk-muted-2)}"
    + "#deck-root .chip.doingchip{background:rgba(88,166,255,.12);color:var(--dk-info)}"
    + "#deck-root .blkpill{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--dk-danger);background:rgba(248,113,113,.16);border-radius:var(--dk-r-pill);padding:1px 7px;flex:none}"
    + "#deck-root .rbtns{display:flex;gap:4px;margin-left:auto;flex:none;align-items:center}"
    + "#deck-root .btn{display:inline-flex;align-items:center;gap:4px;font-size:var(--dk-fs-cap);font-weight:600;padding:2px 9px;border-radius:var(--dk-r-s);min-height:24px;letter-spacing:.02em;border:1px solid transparent}"
    + "#deck-root .btn.pri{color:#140a1e}"
    + "#deck-root .btn.pri.c-ok{background:var(--dk-ok)}"
    + "#deck-root .btn.pri.c-map{background:var(--dk-map)}"
    + "#deck-root .btn.pri.c-spec{background:var(--dk-spec)}"
    + "#deck-root .btn.pri.c-warn{background:var(--dk-warn)}"
    + "#deck-root .btn.pri.c-done{background:var(--dk-ok);color:#0c1a10}"
    + "#deck-root .btn.pri.c-danger{background:var(--dk-danger);color:#1a0d0d}"
    + "#deck-root .btn.solid2{background:var(--dk-surface-3);color:var(--dk-fg);font-weight:500}"
    + "#deck-root .btn.ghost{background:none;color:var(--dk-muted);padding:2px 6px;font-weight:400}"
    + "#deck-root .btn.ghost:hover{color:var(--dk-fg);background:var(--dk-surface-3)}"
    + "#deck-root .btn.okflash{background:rgba(74,222,128,.25);color:var(--dk-ok)}"
    + "#deck-root .ddetail{flex:1;overflow:auto;padding:12px 14px;display:none}"
    + "#deck-root .ddetail.on{display:block}"
    + "#deck-root .dback{display:inline-flex;align-items:center;gap:5px;color:var(--dk-muted);font-size:var(--dk-fs-small);padding:4px 8px;border-radius:var(--dk-r-s);margin-bottom:8px;min-height:24px}"
    + "#deck-root .dback:hover{background:var(--dk-surface-3);color:var(--dk-fg)}"
    + "#deck-root .ddetail h3{font-size:16px;font-weight:600;line-height:1.4;margin:2px 0 6px}"
    + "#deck-root .dmeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}"
    + "#deck-root .dbar{display:flex;gap:6px;padding:10px 0;border-top:1px solid var(--dk-border);border-bottom:1px solid var(--dk-border);margin:10px 0;flex-wrap:wrap}"
    + "#deck-root .dnext{font-size:var(--dk-fs-small);color:var(--dk-muted);line-height:1.6;margin-bottom:6px}"
    + "#deck-root .dbody{font-size:var(--dk-fs-small);color:var(--dk-muted);line-height:1.65;white-space:pre-wrap;margin:6px 0}"
    + "#deck-root .dsec{font-size:var(--dk-fs-cap);color:var(--dk-muted-2);letter-spacing:.06em;text-transform:uppercase;margin:14px 0 6px}"
    + "#deck-root .cmt{border:1px solid var(--dk-border);border-radius:var(--dk-r-s);padding:8px 10px;margin-bottom:8px;background:var(--dk-surface-2)}"
    + "#deck-root .cmt .who{font-size:var(--dk-fs-cap);color:var(--dk-info);margin-bottom:3px}"
    + "#deck-root .cmt .tx{font-size:var(--dk-fs-small);color:var(--dk-muted);line-height:1.55}"
    + "#deck-root .cmtbox{display:flex;gap:6px;margin-top:10px}"
    + "#deck-root .cmtbox input{flex:1;background:var(--dk-surface-2);border:1px solid var(--dk-border);border-radius:var(--dk-r-s);color:var(--dk-fg);font:inherit;font-size:var(--dk-fs-small);padding:6px 10px;min-height:30px;outline:none}"
    + "#deck-root .dpage{flex:1;overflow:auto;padding:12px 14px;display:none}"
    + "#deck-root .dpage.on{display:block}"
    + "#deck-root .chk{display:flex;align-items:center;gap:9px;padding:8px 4px;border-bottom:1px solid var(--dk-border);font-size:var(--dk-fs-small);color:var(--dk-muted)}"
    + "#deck-root .chk .st{margin-left:auto;font-size:var(--dk-fs-cap);color:var(--dk-muted-2)}"
    + "#deck-root .skgrid{display:flex;flex-wrap:wrap;gap:6px}"
    + "#deck-root .skgrid button{display:inline-flex;align-items:center;gap:6px;font-size:var(--dk-fs-small);color:var(--dk-muted);border:1px solid var(--dk-border);border-radius:var(--dk-r-pill);padding:5px 12px;min-height:28px}"
    + "#deck-root .skgrid button:hover{color:var(--dk-map);border-color:rgba(188,140,252,.4)}"
    + "#deck-root .empty{padding:26px 10px;color:var(--dk-muted-2);font-size:var(--dk-fs-small);text-align:center}"
    + "#deck-toasts{position:fixed;top:14px;right:14px;z-index:2147483600;display:flex;flex-direction:column;gap:8px;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}"
    + "#deck-toasts .toast{background:#16181d;border:1px solid #2a2d35;border-left:3px solid #58a6ff;border-radius:6px;box-shadow:0 8px 30px rgba(0,0,0,.45);padding:8px 14px;font-size:12px;color:#e8e8ec;max-width:340px;animation:deck-tin .18s ease-out}"
    + "#deck-toasts .toast.ok{border-left-color:#4ade80}"
    + "#deck-toasts .toast.warn{border-left-color:#f59e0b}"
    + "@keyframes deck-tin{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}"
    + "@media (prefers-reduced-motion:reduce){#deck-root *,#deck-toasts *{animation:none!important;transition:none!important}}";

  /* ================= 状态与纯派生（id→Card 注册表；counts 单点来自 loader） ================= */
  var state = null;
  var byId = new Map();

  function reindex() {
    byId.clear();
    if (state) for (var i = 0; i < state.cards.length; i++) byId.set(state.cards[i].id, state.cards[i]);
  }
  function kidsOf(c) { return (c.children || []).map(function (n) { return byId.get(n); }).filter(Boolean); }
  function contState(c) {
    var k = kidsOf(c);
    if (!k.length) return "empty";
    var closed = k.filter(function (x) { return x.status === "closed"; }).length;
    return closed === k.length ? "done" : "doing";
  }
  function isBlocked(c) { return c.blockedBy !== null && c.blockedBy !== undefined && c.status !== "closed"; }
  function stOf(c) { return c.status === "closed" ? "closed" : (isBlocked(c) ? "blocked" : c.status); }
  function ticketsCount() {
    var all = 0, closed = 0;
    if (state) for (var i = 0; i < state.cards.length; i++) {
      var c = state.cards[i];
      if (c.type === "ticket") { all++; if (c.status === "closed") closed++; }
    }
    return { all: all, closed: closed };
  }
  var AVA_COLORS = { me: "transparent", qb: "#f59e0b", rx: "#bc8cff" };

  /* ================= Prompt 构建（源自 dsh-deck config/prompts/*.yaml，模板 + 占位符，本地模式 {url}=卡片路径） ================= */
  var TP = window.__deckPrompt || function () { return ""; };
  function tsSlug() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function repoName() {
    var r = (state && state.root) || "";
    return r ? (r.split("/").filter(Boolean).pop() || r) : "当前工作区";
  }
  function closedOf(c) { var k = kidsOf(c); return { closed: k.filter(function (x) { return x.status === "closed"; }).length, total: k.length }; }

  /* 动作 → 模板（与 deck 动作表同构） */
  function promptFor(c) {
    if (c.type === "spec") {
      var sp = contState(c);
      if (sp === "empty") return TP("specSplit", { url: c.path });
      if (sp === "done") { var kc = closedOf(c); return TP("specComplete", { url: c.path, closed: kc.closed, total: kc.total }); }
      return TP("specExecute", { url: c.path });
    }
    if (c.type === "map") {
      var s = contState(c);
      if (s === "empty") return TP("mapInspect", { n: c.id, title: c.title, url: c.path, subIssue: c.path });
      if (s === "done") { var km = closedOf(c); return TP("complete", { url: c.path, closed: km.closed, total: km.total }); }
      return TP("mapExecute", {});
    }
    if (c.labels.indexOf("needs-triage") >= 0) return TP("tpl.diagnose", { url: c.path });
    if (c.labels.indexOf("bug") >= 0) return TP("tpl.diagnose", { url: c.path });
    if (c.labels.indexOf("research") >= 0) return TP("tpl.research", { url: c.path });
    if (c.labels.indexOf("grilling") >= 0) return TP("tpl.discuss", { url: c.path });
    if (c.labels.indexOf("prototype") >= 0) return TP("tpl.prototype", { url: c.path });
    if (c.labels.indexOf("needs-info") >= 0) return TP("tpl.supplement", { url: c.path });
    if (c.labels.indexOf("ready-for-human") >= 0) return TP("tpl.takeover", { url: c.path });
    return TP("tpl.execute", { url: c.path });
  }
  function fixText(c) { return TP("tpl.fix", { url: c.path }); }
  function supplementText(c) { return TP("tpl.supplement", { url: c.path }); }
  function primaryOf(c) {
    if (c.status === "closed") return null;
    if (isBlocked(c)) return null;
    if (c.type === "spec") return contState(c) === "empty" ? { t: "拆票", cls: "c-spec" } : { t: "执行", cls: "c-spec" };
    if (c.type === "map") {
      var s = contState(c);
      return s === "done" ? { t: "完成", cls: "c-done" } : s === "empty" ? { t: "检查", cls: "c-map" } : { t: "执行", cls: "c-map" };
    }
    if (c.labels.indexOf("needs-triage") >= 0) return { t: "诊断", cls: "c-warn" };
    if (c.labels.indexOf("bug") >= 0) return { t: "诊断", cls: "c-danger" };
    if (c.labels.indexOf("needs-info") >= 0) return { t: "补充", cls: "c-warn" };
    if (c.labels.indexOf("ready-for-human") >= 0) return { t: "接手", cls: "c-warn" };
    return { t: "执行", cls: "c-ok" };
  }

  /* ================= 小工具 ================= */
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.indexOf("on") === 0) e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (k2) {
      if (k2 == null) return;
      if (typeof k2 === "string") { var t = document.createElement("template"); t.innerHTML = k2.trim(); e.append(t.content); }
      else e.append(k2);
    });
    return e;
  }
  function txt(t) { return document.createTextNode(t); }
  function ringSVG(size, r, sw, frac, color) {
    var C = 2 * Math.PI * r;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '" aria-hidden="true">'
      + '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="' + sw + '"/>'
      + '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + (C * frac) + " " + C + '"/></svg>';
  }
  function miniRing(c) {
    var k = kidsOf(c), closed = k.filter(function (x) { return x.status === "closed"; }).length, frac = k.length ? closed / k.length : 0;
    var cs2 = contState(c);
    var col = cs2 === "done" ? "#4ade80" : (cs2 === "empty" ? "#f59e0b" : (c.type === "map" ? "#bc8cff" : "#7aa2f7"));
    return h("span", { class: "rwrap" }, [h("span", { class: "ring", html: ringSVG(18, 7, 2.4, frac, col) }), h("span", { class: "cnt num" }, [txt(closed + "/" + k.length)])]);
  }
  function ava(author) {
    if (!author || author === "me") return null;
    return h("span", { class: "ava", style: "border-color:" + (AVA_COLORS[author] || "#4ade80"), "aria-label": "作者 " + author }, [txt(author[0].toUpperCase())]);
  }
  function labelChips(c) {
    var out = [];
    c.labels.forEach(function (l) {
      if (l === "bug") out.push(h("span", { class: "chip bug" }, [txt("bug")]));
      else if (l === "needs-triage") out.push(h("span", { class: "chip tri" }, [txt("待分诊")]));
      else if (l === "wayfinder:map" || l === "spec") return;
      else out.push(h("span", { class: "chip gen" }, [txt(l)]));
    });
    return out;
  }

  /* ================= toast / 悬停菜单 / 双卡选择器 ================= */
  var toastHost = null;
  function toast(msg, kind) {
    if (!toastHost) { toastHost = h("div", { id: "deck-toasts", "aria-live": "polite" }); document.body.append(toastHost); }
    var t = h("div", { class: "toast" + (kind ? " " + kind : ""), role: "status" }, [txt(msg)]);
    toastHost.append(t);
    setTimeout(function () { t.remove(); }, 2600);
  }
  function hovMenu(anchor, items) {
    var m = document.querySelector(".deck-hovmenu");
    if (m) m.remove();
    m = h("div", { class: "deck-hovmenu", role: "menu" });
    items.forEach(function (it) { m.append(h("button", { role: "menuitem", onclick: function () { m.remove(); it.go(); } }, [ic(it.icon, 12), txt(it.t)])); });
    document.body.append(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
    m.style.top = (r.top - m.offsetHeight - 6) + "px";
    setTimeout(function () {
      var close = function (e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("mousedown", close); } };
      document.addEventListener("mousedown", close);
    }, 0);
  }
  function openEntryChooser() {
    var root = document.querySelector(".deck-entry");
    if (root) root.remove();
    root = h("div", { class: "deck-entry", role: "dialog", "aria-label": "新建需求" });
    var box = h("div", { class: "ebox" });
    box.append(h("div", { class: "ehd" }, [txt("这条需求，你现在能说清要做什么吗？")]));
    var cards = h("div", { class: "ecards" });
    [["探索地图", "目标大而模糊", "想清楚了要做什么，没想清楚细节，也没想清楚做到什么程度。", "/wayfinder · /prototype · /research · /grilling", "新需求（探索地图，目标大而模糊）：\n" + TP("newWayfinder", { repo: repoName() })],
     ["实施地图", "目标明确清晰", "要做什么、细节和做到什么程度都想清楚了，还没写成规格。", "/wayfinder → /to-spec → /to-tickets", "新需求（实施地图，目标明确清晰）：\n" + TP("newWayfinder", { repo: repoName() })]]
      .forEach(function (row) {
        cards.append(h("button", { class: "ecard", onclick: function () { root.remove(); fillComposer(row[4]); } }, [
          h("span", { class: "brow" }, [txt(row[0])]), h("span", { class: "bst" }, [txt(row[1])]),
          h("span", { class: "bbd" }, [txt(row[2])]), h("span", { class: "bch" }, [txt(row[3])])]));
      });
    box.append(cards, h("button", { class: "dback", style: "margin:12px 0 0;color:#a1a1aa", onclick: function () { root.remove(); } }, [txt("关闭")]));
    root.append(box);
    root.addEventListener("click", function (e) { if (e.target === root) root.remove(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { root.remove(); document.removeEventListener("keydown", esc); } });
    document.body.append(root);
  }

  /* ================= composer 定位（先排除 → 再主 pane → 最后同 pane 粘滞） ================= */
  var COMPOSER_SEL = 'textarea[data-testid="v4-composer-input"], textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .ql-editor';
  /* 这些区域里的输入框不是聊天 composer。判定顺序必须是"先排除再选"：设置页/插件市场
     盖在聊天页上时，粘滞的 lastComposer 仍会把状态行焊在看不见的输入框上。 */
  var EXCLUDE_SEL = [
    '[role="dialog"]',
    '[data-testid="settings-page"]', '[data-settings-content-frame]', '[data-settings-panel-frame]',
    '[data-testid*="settings"]', '[data-testid*="plugin-market"]', '[data-testid*="marketplace"]',
    '[data-testid*="automation"]', '[data-testid*="command-palette"]', '[data-testid*="command-menu"]',
    '[role="listbox"]', '[aria-hidden="true"]',
    '#deck-root', '.deck-entry', '.deck-hovmenu'
  ].join(',');
  var SIDE_SEL = '[data-testid*="selection-side-chat"],[data-pane-role="aux"],[data-aux="true"],[data-pane-kind="aux"]';
  var PANE_SEL = '[data-pane-id],[data-testid^="v4-pane-shell-"]';

  function visible(el) {
    if (!el || !el.isConnected) return false;
    var r = el.getBoundingClientRect();
    return r.width > 40 && r.height > 8 && r.bottom > 0 && r.top < innerHeight;
  }
  function paneElOf(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute && (n.getAttribute("data-pane-id")
        || (n.getAttribute("data-testid") || "").indexOf("v4-pane-shell-") === 0)) return n;
    }
    return null;
  }
  function paneKeyOf(el) {
    var p = paneElOf(el);
    if (!p) return "root";
    return p.getAttribute("data-pane-id") || p.getAttribute("data-testid") || "pane";
  }
  function paneArea(el) {
    var p = paneElOf(el);
    var r = p ? p.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
    return Math.max(0, r.width) * Math.max(0, r.height);
  }
  function isChatComposer(el) {
    var tid = el.getAttribute && el.getAttribute("data-testid");
    if (tid === "v4-composer-input") return true;                       // 原生聊天输入框
    if (el.closest && el.closest('[data-testid^="v4-pane-shell-"]')) return true;
    if (el.id === "composer-ta") return true;                           // test-host
    if (el.tagName === "TEXTAREA" && el.closest && el.closest("form")) return true;
    return false;
  }
  function composerCandidates() {
    var out = [], nodes = document.querySelectorAll(COMPOSER_SEL);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (typeof el.closest === "function" && el.closest(EXCLUDE_SEL)) continue;
      if (!visible(el)) continue;
      if (!isChatComposer(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.top < innerHeight * 0.45) continue;   // 聊天输入框特征：在视口下半部
      out.push({
        el: el, r: r,
        side: !!(el.closest && el.closest(SIDE_SEL)),
        area: paneArea(el),
      });
    }
    return out;
  }
  var lastComposer = null;
  function findComposer() {
    var cands = composerCandidates();
    if (!cands.length) { lastComposer = null; return null; }
    var primary = cands.filter(function (c) { return !c.side; });
    var pool = primary.length ? primary : cands;   // 有主栏就绝不选辅助栏
    pool.sort(function (a, b) { return (b.area - a.area) || (b.r.top - a.r.top); });
    var best = pool[0];
    var key = paneKeyOf(best.el);
    if (lastComposer && lastComposer.isConnected) {
      for (var i = 0; i < pool.length; i++) {
        if (pool[i].el === lastComposer && paneKeyOf(pool[i].el) === key) { best = pool[i]; break; }
      }
    }
    lastComposer = best.el;
    return best.el;
  }
  function sessionIdNow() {
    try {
      var el = findComposer();
      for (var n = el; n && n !== document.body; n = n.parentElement) {
        if (n.getAttribute && n.getAttribute("data-session-id")) return n.getAttribute("data-session-id");
      }
      var node = document.querySelector("[data-session-id]");
      return node && node.getAttribute ? (node.getAttribute("data-session-id") || null) : null;
    } catch (e) { return null; }
  }

  /* ================= 动作队列（renderer → 主进程，单向拉取） ================= */
  function queueAction(a) {
    var item = {};
    for (var k in a) item[k] = a[k];
    if (item.startedAt == null) item.startedAt = Date.now();
    if (!item.root && state && state.root) item.root = state.root;
    if (!item.sessionId) item.sessionId = sessionIdNow();
    outbox.push(item);
    if (outbox.length > 64) outbox.splice(0, outbox.length - 64);
    return item;
  }

  /* 从输入框向上找「卡片」层级：自身够宽且父容器明显更宽的那一层。 */
  var firstFill = true;
  function setComposerValue(el, text) {
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") {
      var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);   // 原生 setter，React 受控组件才认
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
      return;
    }
    el.focus();
    var rng = document.createRange();
    rng.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(rng);
    document.execCommand("insertText", false, text);
  }
  function injectPrompt(text, meta) {
    var el = findComposer();
    if (!el) {
      queueAction(Object.assign({ kind: "prompt.inject", result: "failed", error: "未找到输入框" }, meta || {}));
      toast("未找到输入框", "warn");
      return false;
    }
    try { setComposerValue(el, text); } catch (e) {
      lastError = "fill failed: " + (e && e.message || e);
      queueAction(Object.assign({ kind: "prompt.inject", result: "failed", error: lastError }, meta || {}));
      toast("填充失败：" + (e && e.message || e), "warn");
      return false;
    }
    queueAction(Object.assign({ kind: "prompt.inject", result: "ok" }, meta || {}));
    if (firstFill) { firstFill = false; toast("已填入输入框，回车发送（不自动发送）"); }
    return true;
  }
  function fillComposer(text, meta) { return injectPrompt(text, meta); }
  function copyText(text, btn) {
    var done = function () {
      if (btn) { btn.classList.add("okflash"); setTimeout(function () { btn.classList.remove("okflash"); }, 1300); }
      toast("已复制 " + text, "ok");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast("复制失败", "warn"); });
    else done();
  }

  /* ================= 停靠：卡内行（zusage 同区域）+ 面板逃逸裁切 ================= */
  var deckRoot = null;
  /* 卡内模式下 sheet 改 fixed 贴胶囊上方，避开卡片 overflow 裁切 */
  function positionSheet() {
    var s = panel && panel.el;
    if (!s) return;
    if (s.hidden || !deckRoot.classList.contains("deck-inline")) {
      s.classList.remove("deck-sheet-fixed");
      s.style.left = ""; s.style.width = ""; s.style.bottom = "";
      return;
    }
    var r = deckRoot.getBoundingClientRect();
    s.classList.add("deck-sheet-fixed");
    s.style.left = Math.max(8, Math.round(r.left)) + "px";
    s.style.width = Math.round(r.width) + "px";
    s.style.bottom = Math.round(innerHeight - r.top + 8) + "px";
  }
  /* 卡内行会加高底部区域，聊天滚动区需补同等底部内边距，否则最后一行被压住 */
  function padChat() {
    var el = findComposer();
    if (!el || !deckRoot) return;
    var col = el, scroller = null;
    for (var i = 0; i < 10 && col && col.parentElement; i++) {
      var p = col.parentElement;
      for (var j = 0; j < p.children.length; j++) {
        var c = p.children[j];
        if (c === col || c.contains(el) || c.contains(deckRoot)) continue;
        var cs = getComputedStyle(c), r = c.getBoundingClientRect();
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && r.height > 150 && r.width > 200) { scroller = c; break; }
      }
      if (scroller) break;
      col = p;
    }
    if (!scroller) return;
    if (!scroller.hasAttribute("data-deck-pad-base")) {
      scroller.setAttribute("data-deck-pad-base", String(parseFloat(getComputedStyle(scroller).paddingBottom) || 0));
    }
    var base = parseFloat(scroller.getAttribute("data-deck-pad-base")) || 0;
    var want = base + deckRoot.offsetHeight + 6;
    if (Math.abs((parseFloat(scroller.style.paddingBottom) || -1) - want) > 1) {
      scroller.style.paddingBottom = want + "px";
    }
  }
  function unpadChat() {
    var all = document.querySelectorAll("[data-deck-pad-base]");
    for (var i = 0; i < all.length; i++) {
      all[i].style.paddingBottom = all[i].getAttribute("data-deck-pad-base") + "px";
      all[i].removeAttribute("data-deck-pad-base");
    }
  }
  /* body 级浮层（悬停菜单、新建需求弹窗、面板）在导航/隐藏/换 pane 时必须清掉，
     否则它们会留在新页面上，而且没有对应的状态行可以关掉。 */
  function removeBodyLayers() {
    var m = document.querySelectorAll(".deck-hovmenu, .deck-entry");
    for (var i = 0; i < m.length; i++) { if (m[i].parentElement) m[i].remove(); }
    if (panel && panel.el) panel.el.hidden = true;
    if (toastHost && toastHost.parentElement) toastHost.innerHTML = "";
  }

  function hideOverlay(reason) {
    if (!deckRoot) return;
    deckRoot.classList.remove("deck-inline");
    unpadChat();
    if (deckRoot.style.display !== "none") {
      deckRoot.style.display = "none";
      console.info("[scratch-deck] overlay hidden:", reason);
    }
    hiddenReason = reason;
    mountedPaneKey = null;
    removeBodyLayers();
  }

  function dock() {
    if (!deckRoot || disposed) return;
    var testDock = document.getElementById("deck-dock");
    if (testDock && testDock.parentElement) {
      if (!(deckRoot.parentElement === testDock.parentElement && deckRoot.previousElementSibling === testDock)) {
        testDock.parentElement.insertBefore(deckRoot, testDock);
      }
      deckRoot.classList.remove("deck-floating");
      deckRoot.classList.add("deck-inline");
      deckRoot.style.display = "";
      mountedPaneKey = "test-host";
      hiddenReason = null;
      runFold();
      return;
    }
    var el = findComposer();
    if (!el) { hideOverlay("no-composer"); return; }
    var surface = (el.closest && (el.closest(".chat-composer-input-surface") || el.closest("form"))) || el.parentElement;
    var host = surface && surface.parentElement;
    // 卡内行：输入区之后、底栏之前。胶囊是卡片布局的一部分，不覆盖聊天内容。
    if (!host || host.children.length < 2) { hideOverlay("no-card-host"); return; }
    var key = paneKeyOf(el);
    if (mountedPaneKey && mountedPaneKey !== key) removeBodyLayers();
    if (!(deckRoot.parentElement === host && deckRoot.previousElementSibling === surface)) {
      host.insertBefore(deckRoot, surface.nextSibling);
    }
    deckRoot.classList.remove("deck-floating");
    deckRoot.classList.add("deck-inline");
    deckRoot.style.display = "";
    mountedPaneKey = key;
    hiddenReason = null;
    if (!deckRoot.dataset.docked) {
      deckRoot.dataset.docked = "1";
      console.info("[scratch-deck] inline in composer card");
    }
    runFold();
    positionSheet();
    padChat();
  }
  var dockScheduled = false;
  function scheduleDock() {
    if (dockScheduled) return;
    dockScheduled = true;
    (window.requestAnimationFrame || setTimeout)(function () { dockScheduled = false; dock(); }, 0);
  }

  /* ================= 状态行 ================= */
  /* 折叠机优先级表（state-model：品牌1/时间2/技能3/环境4/沉淀5/交接6/可接7/阻塞8/故障9/诊断10） */
  var FOLD_PRIORITY = { brand: 1, time: 2, skills: 3, env: 4, fixate: 5, handoff: 6, takeable: 7, occupied: 8, bug: 9, triage: 10 };
  var capsule = null, segNums = {}, timeLabel = null, pendingRefresh = false, refreshTimer = null;

  function fmtTime(ms) {
    if (!ms) return "--:--";
    var d = new Date(ms), p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function buildCapsule() {
    var cap = h("div", { class: "capsule", role: "toolbar", "aria-label": "Scratch Deck 状态行" });
    var brand = h("button", { class: "brand", "data-fp": FOLD_PRIORITY.brand, html: ic("map", 14) + "<span>MattSkills</span>", title: "打开 / 关闭面板" });
    var timebtn = h("button", { class: "timebtn", "data-fp": FOLD_PRIORITY.time, title: "等待主进程推送刷新（watch 自动）" }, [
      h("span", { class: "rficon", html: ic("refresh", 11) }),
      timeLabel = h("span", { class: "num", style: "font-size:10px" }, [txt("更新 --:--")])]);
    var env = h("button", { class: "seg", "data-seg": "env", "data-fp": FOLD_PRIORITY.env, title: "环境检查（v0 未接入）" }, [ic("dot", 12), h("span", { class: "lbl" }, [txt("环境")])]);
    var fixate = h("button", { class: "seg", title: "保存进度快照，注入零丢失 prompt" }, [ic("spark", 12), h("span", { class: "lbl" }, [txt("沉淀")])]);
    fixate.setAttribute("data-fp", FOLD_PRIORITY.fixate); fixate.setAttribute("data-seg", "fixate");
    var handoffR = h("button", { class: "r", title: "交接·第二步：新会话读交接文档后继续", "aria-label": "交接第二步" }, [ic("ext", 11)]);
    var handoff = h("span", { class: "split", "data-fp": FOLD_PRIORITY.handoff, role: "group", "aria-label": "交接" }, [
      h("button", { class: "l", title: "交接·第一步：生成交接文档" }, [ic("map", 11), h("span", { class: "lbl" }, [txt("交接")])]), handoffR]);
    function seg(key, label, title, numKey) {
      var num = h("span", { class: "num" }, [txt("0")]);
      segNums[numKey || key] = num;
      var b = h("button", { class: "seg", "data-seg": key, "data-fp": FOLD_PRIORITY[key], title: title }, [h("span", { class: "lbl" }, [txt(label)]), num]);
      return b;
    }
    var takeable = seg("takeable", "可接", "可接 = 未认领可执行的任务数");
    var occupied = seg("occupied", "阻塞", "阻塞 = 已认领未关闭的任务数");
    occupied.style.color = "var(--dk-warn)";
    var bug = seg("bug", "故障", "过滤：开放 + bug 标签");
    var triage = seg("triage", "诊断", "过滤：开放 + needs-triage 标签");
    var foldtg = h("button", { class: "foldtg", html: ic("chevD", 12), "aria-label": "收起MattSkillsDeck", title: "收起MattSkillsDeck" });
    cap.append(brand, takeable, occupied, bug, triage, fixate, handoff, env, timebtn, foldtg);

    brand.addEventListener("click", function () { panel.toggle(); });
    takeable.addEventListener("click", function () { panel.filter("frontier"); });
    occupied.addEventListener("click", function () { panel.filter("doing"); });
    bug.addEventListener("click", function () { panel.filter("bug"); });
    triage.addEventListener("click", function () { panel.filter("needs-triage"); });
    env.addEventListener("click", function () { panel.tab("checks"); panel.toggle(true); });
    fixate.addEventListener("click", function () { fillComposer(TP("fixate")); });
    handoff.firstChild.addEventListener("click", function () { fillComposer(TP("tpl.handoff1", { ts: tsSlug() })); });
    handoffR.addEventListener("click", function () { fillComposer(TP("tpl.handoff2", { path: ".scratch/handoff/ 下最新一份交接文档" })); });
    timebtn.addEventListener("click", function () {
      var s = timebtn.querySelector(".rficon svg");
      if (s) s.classList.add("spin");
      timebtn.title = "等待推送…";
      pendingRefresh = true;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function () {
        pendingRefresh = false;
        if (s) s.classList.remove("spin");
        timebtn.title = "等待主进程推送刷新（watch 自动）";
        toast("暂无新快照", "warn");
      }, 3000);
    });
    takeable.addEventListener("mouseenter", function () { hovMenu(takeable, [{ icon: "map", t: "新建需求", go: openEntryChooser }]); });
    bug.addEventListener("mouseenter", function () { hovMenu(bug, [{ icon: "bug", t: "新增", go: function () { fillComposer(TP("newBugWayfinder", { repo: repoName() })); } }]); });
    foldtg.addEventListener("click", function () {
      var open = cap.dataset.folded !== "1";
      cap.dataset.folded = open ? "1" : "0";
      foldtg.innerHTML = open ? ic("chevU", 10) : ic("chevD", 12);
      foldtg.title = open ? "MattSkillsDeck 已收起，点击展开" : "收起MattSkillsDeck";
      foldtg.setAttribute("aria-label", foldtg.title);
      cap.querySelectorAll(".seg,.split,.timebtn").forEach(function (el) { if (open) el.setAttribute("hidden", ""); else el.removeAttribute("hidden"); });
    });
    capsule = cap;
    return cap;
  }

  function runFold() {
    if (!capsule || capsule.dataset.folded === "1" || !capsule.isConnected) return;
    var list = Array.prototype.slice.call(capsule.querySelectorAll("[data-fp]"))
      .filter(function (el) { return !el.classList.contains("brand"); })
      .sort(function (a, b) { return (+b.dataset.fp) - (+a.dataset.fp); });
    list.forEach(function (el) { el.removeAttribute("hidden"); });
    var guard = list.length + 1;
    while (capsule.scrollWidth > capsule.clientWidth && guard-- > 0) {
      var next = list.find(function (el) { return !el.hasAttribute("hidden"); });
      if (!next) break;
      next.setAttribute("hidden", "");
    }
    while (capsule.scrollWidth <= capsule.clientWidth) {
      var back = Array.prototype.slice.call(list).reverse().find(function (el) { return el.hasAttribute("hidden"); });
      if (!back) break;
      back.removeAttribute("hidden");
      if (capsule.scrollWidth > capsule.clientWidth) { back.setAttribute("hidden", ""); break; }
    }
  }

  function refreshCapsule() {
    if (!capsule || !state) return;
    var c = state.counts || {};
    ["takeable", "occupied", "bug", "triage"].forEach(function (k) { if (segNums[k]) segNums[k].textContent = String(c[k] == null ? 0 : c[k]); });
    if (timeLabel) timeLabel.textContent = "更新 " + fmtTime(state.updatedAt);
    if (settingsRootCell) settingsRootCell.textContent = state.root || "";
    if (pendingRefresh) {
      pendingRefresh = false;
      clearTimeout(refreshTimer);
      var s = capsule.querySelector(".timebtn .rficon svg");
      if (s) s.classList.remove("spin");
      var tb = capsule.querySelector(".timebtn");
      if (tb) tb.title = "等待主进程推送刷新（watch 自动）";
      toast("已更新 " + fmtTime(state.updatedAt), "ok");
    }
  }

  /* ================= 面板（五页签 + 详情 + 评论） ================= */
  var panel = null;
  function buildPanel() {
    var ui = { tab: "list", filter: null, active: null };
    var sheet = h("section", { class: "sheet", role: "dialog", "aria-label": "任务板", hidden: "" });
    var tabs = h("div", { class: "dtabs", role: "tablist" });
    [["list", "列表"], ["pr", "拉取请求"], ["skills", "技能"], ["checks", "环境检查"], ["vc", "版本管理"]].forEach(function (row) {
      tabs.append(h("button", { role: "tab", "data-tab": row[0], onclick: function () { setTab(row[0]); } }, [txt(row[1])]));
    });
    var filterRow = h("div", { class: "filterrow" });
    var smini = h("span", { class: "smini" });
    var statusBadge = h("span", { class: "demo" }, [txt("本地 .scratch")]);
    var head = h("div", { class: "dhead" }, [
      h("span", { class: "ttl" }, [txt("MattSkills")]),
      statusBadge,
      smini]);
    head.append(h("button", { class: "x", "aria-label": "设置", title: "设置", html: ic("gear", 13), onclick: function () { setTab("settings"); sheet.hidden = false; } }));
    head.append(h("button", { class: "x", "aria-label": "收起面板", title: "关闭面板", html: ic("chevD", 13), onclick: function () { sheet.hidden = true; } }));
    var listWrap = h("div", { class: "dlist", role: "list" });
    var detail = h("div", { class: "ddetail" });
    var pages = { checks: buildChecks(), skills: buildSkills(), settings: buildSettings(), pr: buildPR(), vc: buildVC() };
    sheet.append(head, tabs, filterRow, listWrap, detail, pages.checks, pages.skills, pages.settings, pages.pr, pages.vc);

    function setFilter(f) {
      ui.filter = ui.filter === f ? null : f;
      ui.active = null;
      renderFilter(); renderList(); openSheet(true);
    }
    function renderFilter() {
      filterRow.innerHTML = "";
      var c = (state && state.counts) || {};
      [["frontier", "可接"], ["doing", "阻塞"], ["bug", "故障"], ["needs-triage", "诊断"], ["closed", "已关闭"]].forEach(function (row) {
        var n = row[0] === "frontier" ? c.takeable : row[0] === "doing" ? c.occupied : row[0] === "bug" ? c.bug : row[0] === "needs-triage" ? c.triage : c.closed;
        filterRow.append(h("button", { "data-f": row[0], class: ui.filter === row[0] ? "on" : "", onclick: function () { setFilter(row[0]); } }, [txt(row[1] + " " + (n == null ? 0 : n))]));
      });
      filterRow.append(h("span", { style: "margin-left:auto;display:inline-flex;gap:6px;align-self:center" }, [
        h("button", { class: "btn solid2", title: "体检：对整个仓库的开放票做健康检查", onclick: function () { fillComposer(TP("healthCheck", { subject: "本地 Markdown 模式：卡片标签行（Labels: …）与「## 评论」条目格式是否规范、_index 索引是否存在且不过期。" })); } }, [txt("体检")]),
        h("button", { class: "btn solid2", title: "等待主进程推送刷新（watch 自动）", onclick: function () { queueAction({ kind: "refresh" }); toast("已请求主进程重新读取卡片"); } }, [txt("更新")])]));
    }
    function setTab(k) {
      ui.tab = k;
      tabs.querySelectorAll("button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === k); });
      listWrap.style.display = k === "list" ? "" : "none";
      filterRow.style.display = k === "list" ? "" : "none";
      detail.classList.toggle("on", k === "list" && !!ui.active);
      Object.keys(pages).forEach(function (p) { pages[p].classList.toggle("on", pages[p].dataset.page === k); });
      if (pages[k] && pages[k]._render) pages[k]._render();
    }
    function openSheet(force) { sheet.hidden = force === true ? false : !sheet.hidden; if (!sheet.hidden) setTab(ui.tab); positionSheet(); }

    function rowEl(c) {
      var st = stOf(c);
      var row = h("div", { class: "row" + (c.type !== "ticket" ? " cont" : "") + (c.type === "spec" ? " spec" : "") + (st === "closed" ? " closed" : ""), role: "listitem", tabindex: 0 });
      var l1 = h("div", { class: "l1" });
      if (c.type !== "ticket") l1.append(h("span", { class: "cbadge " + c.type }, [h("span", { class: "n" }, [txt(c.type === "map" ? "图" : "规")]), h("span", {}, [txt(c.type === "map" ? "地图" : "格")])]));
      l1.append(h("span", { class: "tnum" }, [txt("#" + c.id)]));
      if (c.writing) l1.append(h("span", { class: "writing" }, [txt("写作中")]));
      l1.append(h("span", { class: "rttl" }, [txt(c.title)]));
      var a = ava(c.author); if (a) l1.append(a);
      if (c.type !== "ticket" && st !== "closed") l1.append(miniRing(c));
      var l2 = h("div", { class: "l2" });
      labelChips(c).forEach(function (x) { l2.append(x); });
      if (st === "open" && !isBlocked(c) && c.type === "ticket") l2.append(h("span", { class: "chip doingchip" }, [txt("在办")]));
      if (st === "closed") l2.append(h("span", { class: "chip closedchip" }, [txt("已结案")]));
      if (st === "blocked") l2.append(h("button", { class: "blkpill", title: "被阻塞，点红条看阻塞在哪里", onclick: function (e) { e.stopPropagation(); ui.active = byId.get(c.blockedBy) || null; renderDetail(); } }, [ic("lock", 10), txt("被 #" + c.blockedBy + " 挡住")]));
      if (st !== "closed" && st !== "blocked") {
        var btns = h("span", { class: "rbtns" });
        var pri = primaryOf(c);
        if (pri) btns.append(h("button", { class: "btn pri " + pri.cls, onclick: function (e) { e.stopPropagation(); fillComposer(promptFor(c), { cardId: c.id, path: c.path }); } }, [txt(pri.t)]));
        if (pri && pri.t === "诊断" && c.labels.indexOf("bug") >= 0 && c.labels.indexOf("needs-triage") < 0)
          btns.append(h("button", { class: "btn solid2", title: "生成 bug 修复提示并注入输入框", onclick: function (e) { e.stopPropagation(); fillComposer(fixText(c), { cardId: c.id, path: c.path }); } }, [txt("修复")]));
        if (c.labels.indexOf("needs-info") >= 0)
          btns.append(h("button", { class: "btn solid2", title: "缺信息：问清可回答的问题", onclick: function (e) { e.stopPropagation(); fillComposer(supplementText(c), { cardId: c.id, path: c.path }); } }, [txt("补充")]));
        btns.append(h("button", { class: "btn ghost", "aria-label": "复制链接", title: "复制卡片路径", html: ic("copy", 12), onclick: function (e) { e.stopPropagation(); copyText(c.path, e.currentTarget); } }));
        btns.append(h("button", { class: "btn ghost", "aria-label": "打开链接", title: "本地模式：卡片即文件 " + c.path, html: ic("ext", 12), onclick: function (e) { e.stopPropagation(); copyText(c.path, e.currentTarget); } }));
        l2.append(btns);
      }
      row.append(l1, l2);
      row.addEventListener("click", function () { ui.active = c; renderDetail(); });
      row.addEventListener("keydown", function (e) { if (e.key === "Enter") { ui.active = c; renderDetail(); } });
      return row;
    }
    function matchFilter(c) {
      if (!ui.filter) return true;
      if (ui.filter === "frontier") return c.status === "frontier";
      if (ui.filter === "doing") return c.status !== "closed" && c.status !== "frontier";
      if (ui.filter === "closed") return c.status === "closed";
      if (ui.filter === "bug") return c.status !== "closed" && c.labels.indexOf("bug") >= 0;
      return c.status !== "closed" && c.labels.indexOf("needs-triage") >= 0;
    }
    function renderList() {
      if (ui.active) { renderDetail(); return; }
      listWrap.innerHTML = "";
      if (!state) { listWrap.append(h("div", { class: "empty" }, [txt("等待主进程推送状态…")])); return; }
      /* 三态在这里是三种真实界面，不是同一条空态文案：
         uninitialized 是"能定位工作区但还没建 .scratch"，unresolved 是"连工作区都没有"。 */
      if (state.status === "uninitialized") {
        listWrap.append(h("div", { class: "empty" }, [
          h("div", { style: "font-weight:600;color:var(--dk-fg);margin-bottom:6px;font-size:13px" }, [txt("尚未初始化 Scratch Deck")]),
          h("div", {}, [txt((state.diagnosis && state.diagnosis.message) || ("当前工作区没有 " + ".scratch/" + " 目录。"))]),
          h("div", { style: "margin-top:8px" }, [txt("loader 正在监听工作区根目录：自建 .scratch/ 后这里会自动出现卡片。")])]));
        listWrap.append(h("div", { style: "display:flex;justify-content:center;padding:8px" }, [
          h("button", { class: "btn pri c-map", onclick: function () {
            fillComposer("在这个工作区初始化 Scratch Deck：创建 .scratch/ 目录，并按 docs/card-format.md 的 frontmatter 契约建立第一张卡片。");
          } }, [txt("初始化")])]));
        return;
      }
      if (state.status === "unresolved") {
        listWrap.append(h("div", { class: "empty" }, [
          h("div", { style: "font-weight:600;color:var(--dk-warn);margin-bottom:6px;font-size:13px" }, [txt("检测不到工作区")]),
          h("div", {}, [txt((state.diagnosis && state.diagnosis.message) || "没有可用的工作区路径")]),
          h("div", { style: "margin-top:8px" }, [txt("这里不会回退到演示数据。可在 ~/.zcode/scratch-deck-roots.json 配置 roots/active。")])]));
        listWrap.append(h("div", { style: "display:flex;justify-content:center;gap:6px;padding:8px" }, [
          h("button", { class: "btn solid2", onclick: function () { setTab("checks"); } }, [txt("查看诊断")]),
          h("button", { class: "btn solid2", onclick: function () { copyText("~/.zcode/scratch-deck-roots.json"); } }, [txt("复制配置路径")])]));
        return;
      }
      var cards = state.cards;
      var conts = cards.filter(function (c) { return c.type !== "ticket" && matchFilter(c); });
      var open = cards.filter(function (c) { return c.type === "ticket" && c.status !== "closed" && matchFilter(c); });
      var closed = cards.filter(function (c) { return c.type === "ticket" && c.status === "closed" && matchFilter(c); });
      if (!conts.length && !open.length && !closed.length) {
        listWrap.append(h("div", { class: "empty" }, [txt(!cards.length ? ".scratch/ 里还没有卡片"
          : (state.parseErrors && state.parseErrors.length ? "卡片全部解析失败（见环境检查）" : "这个过滤器下没有卡片"))]));
        return;
      }
      conts.forEach(function (c) { listWrap.append(rowEl(c)); });
      open.forEach(function (c) { listWrap.append(rowEl(c)); });
      if (closed.length) {
        listWrap.append(h("div", { class: "dsec", style: "margin:10px 4px 4px" }, [txt("已关闭 " + closed.length + "（已加载 " + cards.length + "）")]));
        closed.forEach(function (c) { listWrap.append(rowEl(c)); });
      }
    }
    function cardMeta(c) { return { cardId: c.id, path: c.path }; }
    function renderDetail() {
      var c = ui.active;
      if (!c) return;
      setTab("list");
      detail.classList.add("on");
      listWrap.style.display = "none";
      filterRow.style.display = "none";
      detail.innerHTML = "";
      detail.append(h("button", { class: "dback", html: ic("chevL", 12) + "<span>返回列表</span>", onclick: function () { ui.active = null; detail.classList.remove("on"); listWrap.style.display = ""; filterRow.style.display = ""; renderList(); } }));
      var meta = h("div", { class: "dmeta" });
      meta.append(h("span", { class: "tnum", style: "font-size:var(--dk-fs-small)" }, [txt("#" + c.id)]));
      labelChips(c).forEach(function (x) { meta.append(x); });
      meta.append(h("span", { style: "font-size:var(--dk-fs-cap);color:var(--dk-muted-2)" }, [txt((c.author === "me" ? "我" : c.author) + (c.updated ? " · 更新 " + c.updated : ""))]));
      detail.append(h("h3", {}, [txt(c.title)]), meta);
      detail.append(h("div", { class: "dbody" }, [txt(c.body || "无描述")]));
      if (c.next) detail.append(h("div", { class: "dnext" }, [txt("下一步：" + c.next)]));
      var bar = h("div", { class: "dbar" });
      var pri = primaryOf(c);
      if (pri) bar.append(h("button", { class: "btn pri " + pri.cls, onclick: function () { fillComposer(promptFor(c), cardMeta(c)); } }, [txt(pri.t)]));
      if (pri && pri.t === "诊断" && c.labels.indexOf("bug") >= 0 && c.labels.indexOf("needs-triage") < 0)
        bar.append(h("button", { class: "btn solid2", onclick: function () { fillComposer(fixText(c), cardMeta(c)); } }, [txt("修复")]));
      if (c.labels.indexOf("needs-info") >= 0)
        bar.append(h("button", { class: "btn solid2", onclick: function () { fillComposer(supplementText(c), cardMeta(c)); } }, [txt("补充")]));
      bar.append(h("button", { class: "btn solid2", title: "复制卡片路径", onclick: function () { copyText(c.path); } }, [txt("路径")]));
      bar.append(h("button", { class: "btn solid2", title: "生成 .scratch/handoff/<时间戳>.md（主进程写盘）",
        onclick: function () { queueAction({ kind: "handoff", cardId: c.id, path: c.path }); toast("已请求生成交接文档"); } }, [ic("ext", 12), txt("交接")]));
      bar.append(h("button", { class: "btn solid2", title: "把 frontmatter 的 status 写回 closed（原子写入，失败会报错）",
        onclick: function () { queueAction({ kind: "archive", cardId: c.id, path: c.path }); toast("已请求归档"); } }, [ic("archive", 12), txt("归档")]));
      detail.append(bar);
      detail.append(h("div", { class: "dsec" }, [txt("评论 (" + c.comments.length + ")")]));
      c.comments.forEach(function (m) {
        detail.append(h("div", { class: "cmt" }, [
          h("div", { class: "who" }, [txt(m.who + (m.at ? " · " + m.at : ""))]),
          h("div", { class: "tx" }, [txt(m.tx)])]));
      });
      var inp = h("input", { "aria-label": "写评论", placeholder: "写下评论（⌘+Enter / Ctrl+Enter 发送）" });
      detail.append(h("div", { class: "cmtbox" }, [inp, h("button", { class: "btn pri c-ok", onclick: function () {
        var v = inp.value.trim();
        if (!v) return;
        queueAction({ kind: "comment", cardId: c.id, path: c.path, text: v, who: "me" });
        inp.value = "";
        toast("已提交写入评论", "ok");
      } }, [txt("发送")])]));
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.target.nextElementSibling.click(); } });
    }
    function refreshHead() {
      var t = ticketsCount();
      var frac = t.all ? t.closed / t.all : 0;
      var cnts = (state && state.counts) || {};
      statusBadge.textContent = !state ? "等待推送"
        : state.status === "ready" ? "本地 .scratch"
          : state.status === "uninitialized" ? "未初始化"
            : "无工作区";
      smini.innerHTML = "";
      smini.append(
        h("span", { class: "ring", html: ringSVG(22, 8.5, 3, frac, "#4ade80") }),
        h("span", { class: "num", style: "font-size:11px;color:var(--dk-ok)" }, [txt(t.closed + "/" + t.all)]),
        h("span", { style: "font-size:11px;color:var(--dk-muted)" }, [txt("可接 " + (cnts.takeable || 0) + " · 故障 " + (cnts.bug || 0) + " · 诊断 " + (cnts.triage || 0) + " · 阻塞 " + (cnts.blocked || 0))]));
    }

    panel = {
      el: sheet,
      toggle: openSheet,
      filter: setFilter,
      tab: function (k) { setTab(k); },
      reset: function () { ui.tab = "list"; ui.filter = null; ui.active = null; detail.classList.remove("on"); listWrap.style.display = ""; filterRow.style.display = ""; setTab("list"); renderFilter(); renderList(); refreshHead(); },
      render: function () {
        renderFilter(); renderList(); if (ui.active) renderDetail(); refreshHead();
        if (pages[ui.tab] && pages[ui.tab]._render) pages[ui.tab]._render();
      }
    };
    panel.reset();
    return sheet;
  }

  /* ================= 检查 / 技能 / 设置 / PR / 版本管理页 ================= */
  function pageHead(title, actionLabel, onAction) {
    return h("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:8px" }, [
      h("div", { class: "dsec", style: "margin:0" }, [txt(title)]),
      h("button", { class: "btn solid2", style: "margin-left:auto", onclick: onAction }, [txt(actionLabel)]),
    ]);
  }
  function note(text) {
    return h("div", { style: "margin-top:10px;font-size:var(--dk-fs-cap);color:var(--dk-muted-2);line-height:1.6" }, [txt(text)]);
  }
  function kv(label, value, title) {
    return h("div", { class: "chk" }, [
      h("span", {}, [txt(label)]),
      h("span", { class: "st", title: title || value, style: "max-width:56%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [txt(value)]),
    ]);
  }

  function buildChecks() {
    var p = h("div", { class: "dpage", "data-page": "checks" });
    p._render = function () {
      p.innerHTML = "";
      p.append(pageHead("环境检查（只读）", "重新检查", function () {
        queueAction({ kind: "env.refresh" });
        toast("已请求重新检查");
      }));
      var rep = state && state.checks;
      if (!rep) {
        p.append(h("div", { class: "empty" }, [txt("尚未运行。点「重新检查」读取真实环境，不会修改任何东西。")]));
        return;
      }
      (rep.checks || []).forEach(function (c) {
        var color = c.status === "ok" ? "var(--dk-ok)"
          : c.status === "warn" ? "var(--dk-warn)"
            : c.status === "skipped" ? "var(--dk-muted-2)" : "var(--dk-danger)";
        p.append(h("div", { class: "chk" }, [
          h("span", { style: "color:" + color + ";flex:none" }, [ic(c.status === "ok" ? "check" : "alert", 13)]),
          h("span", { style: "min-width:0" }, [txt(c.label)]),
          h("span", { class: "st", title: c.detail || "", style: "max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [txt(c.detail || "")]),
        ]));
        if (c.hint) p.append(h("div", { style: "font-size:10.5px;color:var(--dk-muted-2);padding:0 4px 6px 26px;line-height:1.5" }, [txt(c.hint)]));
      });
      var s = rep.summary || {};
      p.append(note("检查于 " + fmtTime(rep.at) + " · ok " + (s.ok || 0) + " / warn " + (s.warn || 0)
        + " / fail " + (s.fail || 0) + " · 只读，不写卡片、不写凭据"));
    };
    p._render();
    return p;
  }

  function buildPR() {
    var p = h("div", { class: "dpage", "data-page": "pr" });
    p._render = function () {
      p.innerHTML = "";
      p.append(pageHead("拉取请求 / Issue（只读）", "刷新", function () {
        queueAction({ kind: "tracker.refresh", trackerKind: "local" });
        toast("已请求刷新（本地模式）");
      }));
      var t = state && state.tracker;
      if (!t) {
        p.append(h("div", { class: "empty" }, [txt("尚未拉取。默认只读本地 .scratch；GitHub 只读接入需要凭据，未认证时不会显示任何修改按钮。")]));
        return;
      }
      if (t.detail) p.append(note(t.detail));
      if (t.status === "unauthenticated" || t.status === "offline") {
        p.append(h("div", { class: "empty" }, [txt("只读未就绪：本轮不发起任何网络请求")]));
        return;
      }
      var items = (t.prs || []).concat(t.issues || []);
      if (!items.length) { p.append(h("div", { class: "empty" }, [txt("没有条目")])); return; }
      items.slice(0, 80).forEach(function (it) {
        p.append(h("div", { class: "row", style: "cursor:default" }, [
          h("div", { class: "l1" }, [
            h("span", { class: "tnum" }, [txt("#" + it.id)]),
            h("span", { class: "rttl" }, [txt(it.title)]),
            h("span", { class: "chip " + (it.state === "open" ? "doingchip" : "closedchip") }, [txt(it.state)]),
          ]),
          h("div", { class: "l2" }, [
            h("span", { style: "font-size:10.5px;color:var(--dk-muted-2)" }, [txt(it.url || it.updatedAt || "")]),
          ]),
        ]));
      });
      p.append(note("只读快照 " + fmtTime(t.fetchedAt) + " · 修改类按钮在只读接入下不提供"));
    };
    p._render();
    return p;
  }

  function buildVC() {
    var p = h("div", { class: "dpage", "data-page": "vc" });
    p._render = function () {
      p.innerHTML = "";
      p.append(pageHead("版本管理（只读）", "刷新", function () {
        queueAction({ kind: "git.refresh" });
        toast("已请求刷新 Git 状态");
      }));
      var g = state && state.git;
      if (!g) {
        p.append(h("div", { class: "empty" }, [txt("尚未读取。点「刷新」执行只读 git 查询（固定 argv、5s 超时、输出上限 256KB）。")]));
      } else if (g.kind === "not-a-repo") {
        p.append(h("div", { class: "empty" }, [txt("当前工作区不是 Git 仓库")]));
      } else if (g.kind === "git-missing") {
        p.append(h("div", { class: "empty" }, [txt("没有找到 git 可执行文件")]));
      } else if (g.kind === "error") {
        p.append(h("div", { class: "empty" }, [txt("读取失败：" + (g.error || "未知错误"))]));
      } else {
        p.append(kv("分支", g.detached ? "(detached HEAD)" : String(g.branch || "-")));
        p.append(kv("工作树", g.dirty.count ? g.dirty.count + " 个改动" : "干净"));
        p.append(kv("与上游", (g.ahead || 0) + " ahead · " + (g.behind || 0) + " behind",
          g.upstream ? "upstream: " + g.upstream : "没有配置 upstream"));
        if (g.dirty.files && g.dirty.files.length) {
          p.append(h("div", { class: "dsec" }, [txt("变更" + (g.dirty.truncated ? "（已截断）" : ""))]));
          g.dirty.files.slice(0, 40).forEach(function (f) {
            p.append(h("div", { class: "chk", style: "padding:4px 4px;font-family:ui-monospace,Menlo,monospace;font-size:11px" }, [
              h("span", { style: "color:var(--dk-warn);flex:none" }, [txt((f.x || " ") + (f.y || " "))]),
              h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [txt(f.path)]),
            ]));
          });
        }
        if (g.commits && g.commits.length) {
          p.append(h("div", { class: "dsec" }, [txt("最近提交")]));
          g.commits.forEach(function (c) {
            p.append(h("div", { class: "chk", style: "padding:4px 4px;font-size:11px" }, [
              h("span", { style: "color:var(--dk-info);flex:none;font-family:ui-monospace,Menlo,monospace" }, [txt(c.hash)]),
              h("span", { style: "color:var(--dk-muted-2);flex:none" }, [txt(c.date)]),
              h("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [txt(c.subject)]),
            ]));
          });
        }
      }
      var dis = h("div", { style: "display:flex;gap:6px;padding:10px 0;border-top:1px solid var(--dk-border);margin-top:10px;flex-wrap:wrap" });
      ["提交", "推送", "拉取", "合并"].forEach(function (label) {
        dis.append(h("button", { class: "btn solid2", disabled: "disabled", title: "只读版本：写操作尚未启用", style: "opacity:.45;cursor:not-allowed" }, [txt(label)]));
      });
      p.append(dis);
      p.append(note("写操作尚未启用：本页只执行只读 git 命令。"));
    };
    p._render();
    return p;
  }

  function buildSkills() {
    var p = h("div", { class: "dpage", "data-page": "skills" });
    p._render = function () {
      p.innerHTML = "";
      p.append(h("div", { class: "dsec", style: "margin-top:0" }, [txt("Matt 技能套件")]));
      var g = h("div", { class: "skgrid" });
      ["wayfinder", "triage", "grilling", "handoff", "tdd", "to-tickets", "implement-spec", "diagnosing-bugs"].forEach(function (s) {
        g.append(h("button", { onclick: function () { fillComposer("/" + s + " "); } }, [ic("spark", 11), txt(s)]));
      });
      p.append(g);
      p.append(note("技能缺失时环境检查会报出来。按钮只把命令填进输入框，不自动发送。"));
    };
    p._render();
    return p;
  }

  var settingsRootCell = null;
  function buildSettings() {
    var p = h("div", { class: "dpage", "data-page": "settings" });
    p._render = function () {
      p.innerHTML = "";
      p.append(h("div", { class: "dsec", style: "margin-top:0" }, [txt("设置")]));
      settingsRootCell = h("span", { class: "st", style: "max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
        [txt(state ? (state.root || "（无工作区）") : "")]);
      p.append(h("div", { class: "chk" }, [txt("当前 root"), settingsRootCell]));
      p.append(kv("root 来源", (state && state.rootSource) || "-"));
      p.append(kv("root 状态", state ? String(state.status) : "-"));
      if (state && state.diagnosis) p.append(kv("诊断", state.diagnosis.message || state.diagnosis.code));
      if (state && state.parseErrors && state.parseErrors.length) {
        p.append(kv("解析失败", state.parseErrors.length + " 个文件"));
      }
      p.append(h("div", { class: "chk" }, [txt("面板宽度跟随窗口"), h("span", { class: "st" }, [txt("开")])]));
      p.append(h("div", { class: "chk" }, [txt("状态行自动折叠窄段"), h("span", { class: "st" }, [txt("开")])]));
      p.append(note("scratch-deck " + ((state && state.version) || "?")
        + " · roots 配置 ~/.zcode/scratch-deck-roots.json · 诊断 ~/.zcode/scratch-deck/diag-latest.json"));
    };
    p._render();
    return p;
  }

  /* ================= 装配 ================= */
  var inited = false;
  var resizeObs = null;
  function onResize() { runFold(); scheduleDock(); }
  function onKeydown(e) {
    if (e.key !== "Escape") return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    removeBodyLayers();
  }
  // 点击面板以外的任何地方收起（含胶囊外的宿主区域；capture 阶段先于宿主 stopPropagation）
  function onDocClick(e) {
    if (!panel || !panel.el || panel.el.hidden) return;
    var t = e.target;
    if (panel.el.contains(t) || (deckRoot && deckRoot.contains(t))) return;
    if (t && t.closest && (t.closest(".deck-entry") || t.closest(".deck-hovmenu") || t.closest(".deck-toast"))) return;
    panel.el.hidden = true;
  }

  function init() {
    if (inited || disposed) return;   // DOMContentLoaded 与先到的 __deckUpdate 双入口只装配一次
    inited = true;
    initedAt = Date.now();
    if (!document.getElementById("deck-overlay-style")) {
      var style = document.createElement("style");
      style.id = "deck-overlay-style";
      style.textContent = CSS;
      document.head.append(style);
    }

    deckRoot = h("div", { id: "deck-root" });
    deckRoot.append(buildCapsule());
    deckRoot.append(buildPanel());
    dock();
    console.info("[scratch-deck] overlay mounted gen=" + GEN + ", composer:", !!findComposer());

    if (typeof MutationObserver === "function") {
      mo = new MutationObserver(scheduleDock);
      mo.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener("scroll", scheduleDock, true);   // 会话滚动时重新贴合 composer
    if (window.ResizeObserver && capsule) {
      resizeObs = new ResizeObserver(runFold);
      resizeObs.observe(capsule);
    }
    window.addEventListener("resize", onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(runFold);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("click", onDocClick, true);
  }

  /* ================= 销毁（导航/热更新/重复注入前必须拆干净） ================= */
  function deckDispose() {
    if (disposed) return;
    disposed = true;
    try {
      if (mo) { mo.disconnect(); mo = null; }
      window.removeEventListener("scroll", scheduleDock, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKeydown);
      document.removeEventListener("click", onDocClick, true);
      if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { } resizeObs = null; }
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
      pendingRefresh = false;
      removeBodyLayers();
      if (deckRoot && deckRoot.parentElement) deckRoot.remove();
      deckRoot = null;
      var st = document.getElementById("deck-overlay-style");
      if (st) st.remove();
      var th = document.getElementById("deck-toasts");
      if (th) th.remove();
      toastHost = null;
      panel = null;
      capsule = null;
      if (window.__deckUpdate === deckUpdate) delete window.__deckUpdate;
      if (window.__deckDiag === deckDiag) delete window.__deckDiag;
      if (window.__deckGetRoot === deckGetRootImpl) delete window.__deckGetRoot;
      if (window.__deckDrainActions === deckDrainActions) delete window.__deckDrainActions;
      if (window.__scratchDeckOverlay === GEN) window.__scratchDeckOverlay = 0;
    } catch (e) { }
  }
  window.__deckDispose = deckDispose;
  function deckDrainActions() { var o = outbox; outbox = []; return o; }
  window.__deckDrainActions = deckDrainActions;

  function deckDiag() {
    var cands = 0;
    try { cands = composerCandidates().length; } catch (e) { }
    return {
      generation: GEN, token: TOKEN, disposed: disposed,
      mounted: !!(deckRoot && deckRoot.isConnected && deckRoot.style.display !== "none"),
      composerFound: !!findComposer(), composerCandidates: cands,
      paneId: mountedPaneKey, hiddenReason: hiddenReason,
      initedAt: initedAt, lastUpdateAt: lastUpdateAt, lastError: lastError,
      overlayCount: document.querySelectorAll("#deck-root").length,
      stateStatus: state ? state.status : null,
      cardCount: state ? state.cards.length : null,
      outbox: outbox.length,
    };
  }
  window.__deckDiag = deckDiag;

  function renderNotices() {
    if (!state || !state.notices || !state.notices.length) return;
    var seen = window.__deckNoticeSeen || 0;
    state.notices.forEach(function (n) {
      if (n && typeof n.id === "number" && n.id > seen) {
        toast(n.text, n.kind === "warn" ? "warn" : (n.kind === "ok" ? "ok" : undefined));
      }
    });
    var maxId = state.notices[state.notices.length - 1].id;
    if (typeof maxId === "number") window.__deckNoticeSeen = Math.max(seen, maxId);
  }

  /* ================= 工作区识别（zusage 手法：React fiber 走链读 workspacePath，JSX 属性名不压缩） ================= */
  function deckGetRootImpl() {
    try {
      function fiberScan(nodes) {
        var hit = {};
        for (var i = 0; i < nodes.length && i < 24; i++) {
          var el = nodes[i];
          var keys = Object.keys(el), fk = "";
          for (var k = 0; k < keys.length; k++) {
            if (keys[k].indexOf("__reactFiber$") === 0 || keys[k].indexOf("__reactInternalInstance$") === 0) { fk = keys[k]; break; }
          }
          if (!fk) continue;
          var fiber = el[fk], depth = 0;
          while (fiber && depth++ < 24) {
            var p = fiber.memoizedProps || fiber.pendingProps;
            if (p && typeof p.workspacePath === "string" && p.workspacePath.trim()) hit[p.workspacePath.trim()] = 1;
            fiber = fiber.return;
          }
        }
        return Object.keys(hit);
      }
      // 优先锚定胶囊所在栏的会话节点（与 findComposer 的粘滞选择一致），避免多分栏时 root 来回跳
      var anchor = findComposer(), scope = null;
      for (var n = anchor; n && n !== document.body; n = n.parentElement) {
        if (n.hasAttribute && n.hasAttribute("data-session-id")) { scope = n; break; }
      }
      var list = scope ? fiberScan([scope]) : [];
      if (!list.length) list = fiberScan(document.querySelectorAll("[data-session-id],[data-pane-id]"));
      if (list.length) {
        if (list.length > 1) console.info("[scratch-deck] workspace candidates:", list);
        return list[0];
      }
      // 兜底：顶部区域里形似绝对路径的 title/data 属性
      var scan = document.querySelectorAll("[data-project-path],[data-workspace-path],[title]");
      for (var j = 0; j < scan.length && j < 300; j++) {
        var n = scan[j];
        var r = n.getBoundingClientRect();
        if (r.top > 200) continue;
        var cands = [n.getAttribute("data-project-path"), n.getAttribute("data-workspace-path"), n.getAttribute("title")];
        for (var q = 0; q < cands.length; q++) {
          var v = cands[q];
          if (typeof v === "string" && /^(~\/|\/Users\/|\/Volumes\/|\/home\/|\/root\/)/.test(v.trim())) return v.trim();
        }
      }
      return null;
    } catch (e) { return null; }
  }
  window.__deckGetRoot = deckGetRootImpl;

  function deckUpdate(next) {
    if (disposed) return;
    if (!next || !Array.isArray(next.cards)) {
      lastError = "坏状态：缺少 cards 数组";
      return;
    }
    var rootChanged = !state || state.root !== next.root;
    var statusChanged = !state || state.status !== next.status;
    if (!next.status) next.status = "ready";   // 兼容旧 loader 推送
    state = next;
    reindex();
    lastUpdateAt = Date.now();
    lastError = null;
    if (!deckRoot) init();
    if (rootChanged || statusChanged) {
      if (panel) panel.reset();   // 切 root/切状态：卡片区全量重渲染，UI 态归位
      refreshCapsule();
    } else {
      if (panel) panel.render();
      refreshCapsule();
    }
    renderNotices();
    runFold();
    scheduleDock();
  }
  window.__deckUpdate = deckUpdate;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

/* 最小 DOM 垫片：只为跑 deck-overlay.js 的逻辑测试，不追求浏览器等价。
 *
 * 为什么不用 jsdom：本插件零 npm 依赖，测试必须能在干净机器上直接跑。垫片的
 * 覆盖范围由 deck-overlay.js 实际用到的 API 决定；用到没实现的方法会直接抛错，
 * 所以测试不会因为"垫片恰好返回 undefined"而静默通过。
 *
 * 布局是数据：每个元素的矩形由测试显式设置（__rect），不会自行计算。
 * 这正是 composer 选择要验证的东西——位置与面积，而不是真实排版。
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const VOID = { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 };

/* ---------- 选择器 ---------- */
function parseSimple(sel) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let s = sel.trim();
  const tagM = /^([a-zA-Z][\w-]*|\*)/.exec(s);
  if (tagM) { out.tag = tagM[1] === "*" ? null : tagM[1].toUpperCase(); s = s.slice(tagM[0].length); }
  const re = /([#.])([\w-]+)|\[\s*([\w:-]+)\s*(?:([\^$*~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/g;
  let m, consumed = 0;
  while ((m = re.exec(s))) {
    consumed = re.lastIndex;
    if (m[1] === "#") out.id = m[2];
    else if (m[1] === ".") out.classes.push(m[2]);
    else {
      out.attrs.push({
        name: m[3],
        op: m[4] || null,
        value: m[5] != null ? m[5] : m[6] != null ? m[6] : m[7] != null ? m[7] : null,
      });
    }
  }
  if (s.slice(consumed).trim()) throw new Error("dom-shim: 不支持的简单选择器片段: " + JSON.stringify(s.slice(consumed)));
  if (!out.tag && !out.id && !out.classes.length && !out.attrs.length) {
    throw new Error("dom-shim: 空选择器");
  }
  return out;
}

function parseSelector(sel) {
  return String(sel).split(",").map((part) => {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) throw new Error("dom-shim: 空选择器项");
    if (tokens.some((t) => t === ">" || t === "+" || t === "~")) {
      throw new Error("dom-shim: 不支持子/兄弟组合器: " + part);
    }
    return tokens.map(parseSimple);
  });
}

function matchSimple(el, simple) {
  if (simple.tag && el.tagName !== simple.tag) return false;
  if (simple.id && el.getAttribute("id") !== simple.id) return false;
  for (const c of simple.classes) if (!el.classList.contains(c)) return false;
  for (const a of simple.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (!a.op) continue;
    const v = el.getAttribute(a.name);
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !String(v).startsWith(a.value)) return false;
    if (a.op === "$=" && !String(v).endsWith(a.value)) return false;
    if (a.op === "*=" && String(v).indexOf(a.value) < 0) return false;
    if (a.op === "~=" && String(v).split(/\s+/).indexOf(a.value) < 0) return false;
  }
  return true;
}

function matchChain(el, chain) {
  if (!matchSimple(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let node = el.parentElement;
  while (i >= 0) {
    if (!node) return false;
    if (matchSimple(node, chain[i])) i--;
    node = node.parentElement;
  }
  return true;
}

function matchesSelector(el, selector) {
  return parseSelector(selector).some((chain) => matchChain(el, chain));
}

/* ---------- 节点 ---------- */
let observers = [];

function mutation() {
  for (const ob of observers) ob._schedule();
}

class TextNode {
  constructor(text, doc) {
    this.nodeType = 3;
    this.ownerDocument = doc;
    this.parentElement = null;
    this.data = String(text);
  }
  get isConnected() { return connected(this); }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  remove() { detach(this); mutation(); }
}

class RawNode {
  constructor(html, doc) {
    this.nodeType = 1;
    this.tagName = "RAW";
    this.ownerDocument = doc;
    this.parentElement = null;
    this._html = String(html);
  }
  get isConnected() { return connected(this); }
  get textContent() { return this._html; }
  set textContent(v) { this._html = String(v); }
  get outerHTML() { return this._html; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  remove() { detach(this); mutation(); }
}

function connected(node) {
  let n = node;
  while (n) {
    if (n === n.ownerDocument) return true;
    if (!n.parentElement) return n === n.ownerDocument;
    n = n.parentElement;
  }
  return false;
}

function detach(node) {
  const p = node.parentElement;
  if (!p) return;
  const i = p.children.indexOf(node);
  if (i >= 0) p.children.splice(i, 1);
  node.parentElement = null;
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.parentElement = null;
    this.children = [];
    this._attrs = new Map();
    this._listeners = new Map();
    this.style = {};
    this.__rect = Object.assign({}, VOID);
    this.__scrollWidth = null;
    this.__clientWidth = null;
    this.__overflowY = "visible";
    const self = this;
    this.classList = {
      add(...names) { names.forEach((n) => { if (n) self._classSet().add(n); }); },
      remove(...names) { names.forEach((n) => self._classSet().delete(n)); },
      contains(n) { return self._classSet().has(n); },
      toggle(n, force) {
        const has = self._classSet().has(n);
        const want = force === undefined ? !has : !!force;
        if (want) self._classSet().add(n); else self._classSet().delete(n);
        return want;
      },
    };
    this.dataset = new Proxy({}, {
      get(_t, key) {
        const v = self._attrs.get("data-" + camelToKebab(String(key)));
        return v === undefined ? undefined : v;
      },
      set(_t, key, value) {
        self.setAttribute("data-" + camelToKebab(String(key)), String(value));
        return true;
      },
      has(_t, key) { return self._attrs.has("data-" + camelToKebab(String(key))); },
      deleteProperty(_t, key) { self.removeAttribute("data-" + camelToKebab(String(key))); return true; },
    });
  }

  _classSet() {
    if (!this.__classes) this.__classes = new Set();
    return this.__classes;
  }
  get id() { return this.getAttribute("id") || ""; }
  set id(v) { this.setAttribute("id", v); }
  get className() { return Array.from(this._classSet()).join(" "); }
  set className(v) { this.__classes = new Set(String(v).split(/\s+/).filter(Boolean)); mutation(); }

  get isConnected() { return connected(this); }
  get value() { return this.__value == null ? "" : this.__value; }
  set value(v) { this.__value = String(v); }
  get offsetWidth() { return this.__rect.width; }
  get offsetHeight() { return this.__rect.height; }
  get scrollWidth() { return this.__scrollWidth == null ? this.__rect.width : this.__scrollWidth; }
  set scrollWidth(v) { this.__scrollWidth = v; }
  get clientWidth() { return this.__clientWidth == null ? this.__rect.width : this.__clientWidth; }
  set clientWidth(v) { this.__clientWidth = v; }

  get textContent() {
    return this.children.map((c) => (c.nodeType === 3 || c.tagName === "RAW" ? c.textContent : c.textContent)).join("");
  }
  set textContent(v) {
    this.children.forEach((c) => { c.parentElement = null; });
    this.children = [];
    if (v !== "" && v != null) {
      const t = new TextNode(v, this.ownerDocument);
      t.parentElement = this;
      this.children.push(t);
    }
    mutation();
  }
  get innerHTML() { return ""; }
  set innerHTML(v) {
    this.children.forEach((c) => { c.parentElement = null; });
    this.children = [];
    if (v) {
      const raw = new RawNode(v, this.ownerDocument);
      raw.parentElement = this;
      this.children.push(raw);
    }
    mutation();
  }

  setAttribute(name, value) {
    this._attrs.set(String(name), String(value));
  }
  getAttribute(name) {
    const v = this._attrs.get(String(name));
    return v === undefined ? null : v;
  }
  removeAttribute(name) { this._attrs.delete(String(name)); }
  hasAttribute(name) { return this._attrs.has(String(name)); }

  append(...nodes) {
    for (const n of nodes) {
      if (n == null) continue;
      if (typeof n === "string") { this.append(new TextNode(n, this.ownerDocument)); continue; }
      if (n.parentElement) detach(n);
      n.parentElement = this;
      this.children.push(n);
    }
    mutation();
  }
  appendChild(n) { this.append(n); return n; }
  insertBefore(node, ref) {
    if (node.parentElement) detach(node);
    node.parentElement = this;
    if (!ref) { this.children.push(node); mutation(); return node; }
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, node);
    mutation();
    return node;
  }
  remove() { detach(this); mutation(); }
  contains(node) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  get previousElementSibling() {
    const p = this.parentElement;
    if (!p) return null;
    const i = p.children.indexOf(this);
    for (let j = i - 1; j >= 0; j--) if (p.children[j].nodeType === 1) return p.children[j];
    return null;
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get childNodes() { return this.children; }
  get childrenCount() { return this.children.length; }
  get nextSibling() {
    const p = this.parentElement;
    if (!p) return null;
    const i = p.children.indexOf(this);
    return i >= 0 ? p.children[i + 1] || null : null;
  }
  get previousSibling() {
    const p = this.parentElement;
    if (!p) return null;
    const i = p.children.indexOf(this);
    return i > 0 ? p.children[i - 1] : null;
  }
  get content() { return this; }   // <template>.content：垫片里直接当节点用
  get nextElementSibling() {
    const p = this.parentElement;
    if (!p) return null;
    const i = p.children.indexOf(this);
    for (let j = i + 1; j < p.children.length; j++) if (p.children[j].nodeType === 1) return p.children[j];
    return null;
  }
  _walk(out) {
    for (const c of this.children) {
      if (c.nodeType === 1 && typeof c._walk === "function") { out.push(c); c._walk(out); }
    }
    return out;
  }
  querySelectorAll(sel) {
    if (this.tagName === "RAW") return [];
    const want = parseSelector(sel);
    return this._walk([]).filter((el) => want.some((chain) => matchChain(el, chain)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    const want = parseSelector(sel);
    for (let n = this; n && n.nodeType === 1; n = n.parentElement) {
      if (want.some((chain) => matchChain(n, chain))) return n;
    }
    return null;
  }
  matches(sel) { return matchesSelector(this, sel); }
  getBoundingClientRect() {
    const r = this.__rect;
    return {
      left: r.left, top: r.top, width: r.width, height: r.height,
      right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
    };
  }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new EventCtor("click", { bubbles: true })); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const s = this._listeners.get(type);
    if (s) s.delete(fn);
  }
  dispatchEvent(ev) {
    ev.target = ev.target || this;
    const path = [];
    for (let n = this; n; n = n.parentElement) path.push(n);
    // capture 阶段：文档根的 capture 监听先跑（overlay 用它抢在宿主 stopPropagation 前收面板）
    for (let i = path.length - 1; i >= 0; i--) {
      const doc = path[i].ownerDocument;
      if (doc && doc._captureListeners.has(ev.type)) {
        ev.currentTarget = doc;
        for (const fn of doc._captureListeners.get(ev.type)) fn(ev);
      }
      const s = path[i]._listeners && path[i]._listeners.get(ev.type);
      if (ev._stopped) break;
      if (i > 0 && s) { ev.currentTarget = path[i]; for (const fn of s) fn(ev); }
      if (ev._stopped) break;
    }
    if (!ev._stopped) {
      const s = this._listeners.get(ev.type);
      if (s) { ev.currentTarget = this; for (const fn of s) fn(ev); }
    }
    return !ev._prevented;
  }
}

function camelToKebab(s) { return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()); }

class EventCtor {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
    this.target = null;
    this.currentTarget = null;
    this.key = opts && opts.key;
    this.metaKey = !!(opts && opts.metaKey);
    this.ctrlKey = !!(opts && opts.ctrlKey);
    this._stopped = false;
    this._prevented = false;
  }
  preventDefault() { this._prevented = true; }
  stopPropagation() { this._stopped = true; }
  stopImmediatePropagation() { this._stopped = true; }
}

class Document extends Element {
  constructor() {
    super("#document", null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this._captureListeners = new Map();
    this.activeElement = null;
    this.readyState = "complete";
    this.head = new Element("head", this);
    this.head.parentElement = this;
    this.body = new Element("body", this);
    this.body.parentElement = this;
    this.children = [this.head, this.body];
    this.documentElement = null;
  }
  createElement(tag) {
    const el = new Element(tag, this);
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") el.__value = "";
    return el;
  }
  createTextNode(t) { return new TextNode(t, this); }
  createRange() { return { selectNodeContents() { } }; }
  execCommand() { return true; }
  addEventListener(type, fn, opts) {
    if (opts === true || (opts && opts.capture)) {
      if (!this._captureListeners.has(type)) this._captureListeners.set(type, new Set());
      this._captureListeners.get(type).add(fn);
      return;
    }
    super.addEventListener(type, fn);
  }
  removeEventListener(type, fn, opts) {
    if (opts === true || (opts && opts.capture)) {
      const s = this._captureListeners.get(type);
      if (s) s.delete(fn);
      return;
    }
    super.removeEventListener(type, fn);
  }
  getElementById(id) {
    return this._walk([]).find((el) => el.getAttribute("id") === id) || null;
  }
}

class MutationObserverShim {
  constructor(cb) { this.cb = cb; this._observed = false; this._pending = false; }
  observe() { if (!this._observed) { this._observed = true; observers.push(this); } }
  disconnect() { this._observed = false; observers = observers.filter((o) => o !== this); }
  _schedule() {
    if (!this._observed || this._pending) return;
    this._pending = true;
    setTimeout(() => {
      this._pending = false;
      if (this._observed) this.cb([{ type: "childList" }], this);
    }, 0);
  }
}

class ResizeObserverShim {
  constructor(cb) { this.cb = cb; }
  observe() { }
  disconnect() { }
}

/* ---------- 环境 ---------- */
function createPage(opts) {
  opts = opts || {};
  observers = [];
  const document = new Document();
  const winListeners = new Map();
  const win = {
    innerWidth: opts.width || 1400,
    innerHeight: opts.height || 900,
    devicePixelRatio: 2,
    addEventListener(type, fn) { if (!winListeners.has(type)) winListeners.set(type, new Set()); winListeners.get(type).add(fn); },
    removeEventListener(type, fn) { const s = winListeners.get(type); if (s) s.delete(fn); },
    dispatchEvent(ev) { const s = winListeners.get(ev.type); if (s) for (const fn of s) fn(ev); return true; },
    requestAnimationFrame(fn) { return setTimeout(fn, 0); },
    getSelection() { return { removeAllRanges() { }, addRange() { } }; },
    console,
    setTimeout,
    clearTimeout,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, Promise, Error,
    parseInt, parseFloat, isNaN, RegExp,
  };
  win.window = win;
  win.document = document;
  win.navigator = { clipboard: { writeText: () => Promise.resolve() }, userAgent: "dom-shim" };
  win.MutationObserver = MutationObserverShim;
  win.ResizeObserver = ResizeObserverShim;
  win.Event = EventCtor;
  win.getComputedStyle = (el) => ({
    overflowY: el.__overflowY || "visible",
    paddingBottom: el.style.paddingBottom || "0px",
    display: "block",
  });
  function makeProtoAccessor(name) {
    const proto = {};
    Object.defineProperty(proto, "value", {
      configurable: true,
      get() { return this.__value; },
      set(v) { this.__value = String(v); },
    });
    win[name] = function () { };
    win[name].prototype = proto;
  }
  makeProtoAccessor("HTMLTextAreaElement");
  makeProtoAccessor("HTMLInputElement");
  win.HTMLElement = function () { };
  win.__listeners = winListeners;
  win.__observers = () => observers;

  const context = vm.createContext(win);
  return { document, window: win, context, listeners: winListeners };
}

function loadOverlayInto(page, opts) {
  opts = opts || {};
  const prompts = fs.readFileSync(path.join(__dirname, "..", "src", "deck-prompts.js"), "utf8");
  const overlay = fs.readFileSync(opts.overlayPath || path.join(__dirname, "..", "src", "deck-overlay.js"), "utf8");
  vm.runInContext(prompts + "\n" + overlay, page.context, { filename: "deck-overlay.js" });
}

/* 常用 DOM 构造助手 */
function el(page, tag, attrs, rect) {
  const e = page.document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === "class") e.className = attrs[k];
    else if (k === "id") e.id = attrs[k];
    else if (k === "style") Object.assign(e.style, attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  if (rect) e.__rect = Object.assign({ left: 0, top: 0, width: 0, height: 0 }, rect);
  return e;
}
const rect = (left, top, width, height) => ({ left, top, width, height });

module.exports = { createPage, loadOverlayInto, el, rect, Event: EventCtor };

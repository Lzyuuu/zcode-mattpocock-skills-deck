"use strict";

const fs = require("fs");
const path = require("path");
const { redact } = require("./env-checks.cjs");

const GITHUB_BASE = "https://api.github.com";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MIN_INTERVAL_MS = 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

class UnsafeUrlError extends Error {
  constructor(code, message) {
    super(message || "URL 不安全");
    this.name = "UnsafeUrlError";
    this.code = code;
  }
}

class TrackerRequestError extends Error {
  constructor(trackerStatus, message) {
    super(message);
    this.name = "TrackerRequestError";
    this.trackerStatus = trackerStatus;
  }
}

function parseIPv4(host) {
  const parts = String(host).split(".");
  if (parts.length !== 4) {
    return null;
  }
  const numbers = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value < 0 || value > 255) {
      return null;
    }
    numbers.push(value);
  }
  return numbers;
}

function isBlockedIPv4(parts) {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function parseIPv6(raw) {
  let value = String(raw).toLowerCase();
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) {
      return null;
    }
    const v4 = parseIPv4(value.slice(lastColon + 1));
    if (!v4) {
      return null;
    }
    const embedded = [
      ((v4[0] << 8) | v4[1]).toString(16),
      ((v4[2] << 8) | v4[3]).toString(16),
    ].join(":");
    value = `${value.slice(0, lastColon + 1)}${embedded}`;
  }

  let headParts;
  let tailParts;
  const compressedAt = value.indexOf("::");
  if (compressedAt !== -1) {
    if (value.indexOf("::", compressedAt + 2) !== -1) {
      return null;
    }
    const head = value.slice(0, compressedAt);
    const tail = value.slice(compressedAt + 2);
    headParts = head ? head.split(":") : [];
    tailParts = tail ? tail.split(":") : [];
    if (
      headParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
      tailParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    ) {
      return null;
    }
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 1) {
      return null;
    }
    headParts = headParts.concat(
      new Array(missing).fill("0"),
      tailParts,
    );
  } else {
    headParts = value.split(":");
    if (
      headParts.length !== 8 ||
      headParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
    ) {
      return null;
    }
  }

  return headParts.map((part) => parseInt(part, 16));
}

function isBlockedIPv6(raw) {
  if (String(raw).includes("%")) {
    return true;
  }
  const groups = parseIPv6(raw);
  if (!groups) {
    return true;
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 0) {
    return true;
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return true;
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((g0 & 0xffc0) === 0xfec0) {
    return true;
  }
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }

  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0x2002) {
    return isBlockedIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }

  return false;
}

function detectBadPort(input) {
  const text = String(input);
  const match = text.match(
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(?:\[[^\]]+\]|[^/?#:]+):([0-9]+)(?:[/?#]|$)/,
  );
  if (!match) {
    return false;
  }
  const port = Number(match[1]);
  return !(Number.isInteger(port) && port >= 1 && port <= 65535);
}

function assertSafeUrl(input) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input));
  } catch {
    if (detectBadPort(input)) {
      throw new UnsafeUrlError("port", "端口超出 1..65535");
    }
    throw new UnsafeUrlError("invalid", "URL 无法解析");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("scheme", "只允许 http 或 https URL");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("credentials", "URL 不能包含用户名或密码");
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    throw new UnsafeUrlError("invalid", "URL 缺少主机名");
  }
  const host = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const bareHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (bareHost.includes(":")) {
    if (isBlockedIPv6(bareHost)) {
      throw new UnsafeUrlError("private-address", "不允许私网或本机地址");
    }
  } else {
    const v4 = parseIPv4(host);
    if (v4) {
      if (isBlockedIPv4(v4)) {
        throw new UnsafeUrlError("private-address", "不允许私网或本机地址");
      }
    } else if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      throw new UnsafeUrlError("private-address", "不允许私网或本机地址");
    }
  }

  const port = url.port;
  if (port !== "") {
    const value = Number(port);
    if (!/^\d+$/.test(port) || value < 1 || value > 65535) {
      throw new UnsafeUrlError("port", "端口超出 1..65535");
    }
  }

  return url;
}

function getHeader(headers, name) {
  if (!headers) {
    return null;
  }
  const key = String(name).toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(key);
    return value == null ? null : String(value);
  }
  for (const headerName of Object.keys(headers)) {
    if (headerName.toLowerCase() === key) {
      const value = headers[headerName];
      return value == null ? null : String(value);
    }
  }
  return null;
}

function rateLimitMessage(response, status, now) {
  const remaining = getHeader(response.headers, "x-ratelimit-remaining");
  const retryAfter = getHeader(response.headers, "retry-after");
  const reset = getHeader(response.headers, "x-ratelimit-reset");
  if (
    !(status === 403 || status === 429) ||
    (remaining !== "0" && retryAfter == null)
  ) {
    return null;
  }

  let resetAt = null;
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      resetAt = now + seconds * 1000;
    } else {
      const parsed = Date.parse(retryAfter);
      if (!Number.isNaN(parsed)) {
        resetAt = parsed;
      }
    }
  }
  if (resetAt == null && reset != null) {
    const epoch = Number(reset);
    if (Number.isFinite(epoch) && epoch > 0) {
      resetAt = epoch * 1000;
    }
  }

  if (resetAt != null) {
    return `GitHub API 速率受限，将于 ${new Date(resetAt).toISOString()} 恢复`;
  }
  return "GitHub API 速率受限，请稍后重试";
}

function oneLine(text) {
  return redact(
    String(text == null ? "" : text)
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

async function readBodyCapped(response, controller) {
  const contentLength = getHeader(response.headers, "content-length");
  if (contentLength != null) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      controller.abort();
      throw new TrackerRequestError("error", "GitHub 响应体超过 2MB 上限");
    }
  }

  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value == null ? "" : value);
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          controller.abort();
          try {
            await reader.cancel();
          } catch {
            // 已经超过上限，取消失败不影响拒绝结果。
          }
          throw new TrackerRequestError(
            "error",
            "GitHub 响应体超过 2MB 上限",
          );
        }
        chunks.push(chunk);
      }
    } finally {
      if (typeof reader.releaseLock === "function") {
        try {
          reader.releaseLock();
        } catch {
          // 释放锁失败不应覆盖响应解析结果。
        }
      }
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const value of body) {
      const chunk = Buffer.isBuffer(value)
        ? value
        : Buffer.from(value == null ? "" : value);
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        controller.abort();
        throw new TrackerRequestError("error", "GitHub 响应体超过 2MB 上限");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total).toString("utf8");
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      controller.abort();
      throw new TrackerRequestError("error", "GitHub 响应体超过 2MB 上限");
    }
    return text;
  }

  if (typeof response.json === "function") {
    const data = await response.json();
    const text = JSON.stringify(data === undefined ? null : data);
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      controller.abort();
      throw new TrackerRequestError("error", "GitHub 响应体超过 2MB 上限");
    }
    return text;
  }

  throw new TrackerRequestError("error", "GitHub 响应缺少响应体");
}

function mapLabels(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => {
      if (typeof label === "string") {
        return label;
      }
      if (label && typeof label.name === "string") {
        return label.name;
      }
      return null;
    })
    .filter((label) => typeof label === "string" && label);
}

function mapIssue(item) {
  const id =
    item && item.id != null
      ? item.id
      : item && item.number != null
        ? item.number
        : "";
  return {
    id,
    title: item && item.title != null ? String(item.title) : "",
    state: item && item.state === "closed" ? "closed" : "open",
    labels: mapLabels(item && item.labels),
    url:
      item && typeof item.html_url === "string" ? item.html_url : null,
    updatedAt:
      item && typeof item.updated_at === "string" ? item.updated_at : null,
  };
}

function mapPullRequest(item) {
  const merged = Boolean(
    item &&
      (item.merged_at ||
        item.merged === true ||
        item.state === "merged"),
  );
  const state = merged
    ? "merged"
    : item && item.state === "closed"
      ? "closed"
      : "open";
  const id =
    item && item.id != null
      ? item.id
      : item && item.number != null
        ? item.number
        : "";
  return {
    id,
    title: item && item.title != null ? String(item.title) : "",
    state,
    draft: Boolean(item && item.draft === true),
    labels: mapLabels(item && item.labels),
    url:
      item && typeof item.html_url === "string" ? item.html_url : null,
    updatedAt:
      item && typeof item.updated_at === "string" ? item.updated_at : null,
    branch:
      item && item.head && typeof item.head.ref === "string"
        ? item.head.ref
        : null,
    checks:
      item && typeof item.checks === "string" ? item.checks : null,
  };
}

function mapComment(item) {
  return {
    who:
      item && item.user && typeof item.user.login === "string"
        ? item.user.login
        : "unknown",
    at:
      item && typeof item.created_at === "string" ? item.created_at : null,
    body: item && item.body != null ? String(item.body) : "",
  };
}

class GithubTracker {
  #token;
  #fetchImpl;
  #repo;
  #repoInvalid;
  #now;
  #sleep;
  #timeoutMs;
  #minIntervalMs;
  #lastRequestAt = null;
  #snapshot = null;
  #refreshing = null;

  constructor(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    this.kind = "github";
    const explicitToken =
      typeof options.token === "string" ? options.token.trim() : "";
    const githubToken = (process.env.GITHUB_TOKEN || "").trim();
    const ghToken = (process.env.GH_TOKEN || "").trim();
    this.#token = explicitToken || githubToken || ghToken;

    const repo = typeof options.repo === "string" ? options.repo : "";
    const repoParts = repo.split("/");
    const repoValid =
      REPO_PATTERN.test(repo) &&
      repoParts.length === 2 &&
      repoParts.every((part) => part !== "." && part !== "..");
    this.#repo = repoValid ? repo : "";
    this.#repoInvalid = !repoValid;
    this.#fetchImpl =
      typeof options.fetchImpl === "function"
        ? options.fetchImpl
        : globalThis.fetch;
    this.#timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    this.#minIntervalMs =
      Number.isFinite(options.minIntervalMs) && options.minIntervalMs >= 0
        ? options.minIntervalMs
        : DEFAULT_MIN_INTERVAL_MS;
    this.#now =
      typeof options.now === "function"
        ? () => options.now()
        : options.now && typeof options.now.now === "function"
          ? () => options.now.now()
          : typeof options.clock === "function"
            ? () => options.clock()
            : options.clock && typeof options.clock.now === "function"
              ? () => options.clock.now()
              : () => Date.now();
    this.#sleep =
      typeof options.sleep === "function"
        ? options.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  #cleanError(text) {
    const line = oneLine(text);
    if (!this.#token) {
      return line;
    }
    return line.split(this.#token).join("[REDACTED]");
  }

  async #throttle() {
    const now = this.#now();
    if (this.#lastRequestAt != null) {
      const wait = this.#minIntervalMs - (now - this.#lastRequestAt);
      if (wait > 0) {
        await this.#sleep(wait);
      }
    }
    this.#lastRequestAt = this.#now();
  }

  async #get(requestPath) {
    const url = assertSafeUrl(new URL(requestPath, GITHUB_BASE));
    await this.#throttle();

    const timeoutSignal = AbortSignal.timeout(this.#timeoutMs);
    const controller = new AbortController();
    const onTimeout = () => controller.abort(timeoutSignal.reason);
    timeoutSignal.addEventListener("abort", onTimeout, { once: true });

    try {
      let response;
      try {
        response = await this.#fetchImpl(url.toString(), {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.#token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (timeoutSignal.aborted) {
          throw new TrackerRequestError("error", "GitHub 请求超时");
        }
        throw new TrackerRequestError(
          "error",
          this.#cleanError(
            `GitHub 请求失败：${error && error.message ? error.message : "未知错误"}`,
          ),
        );
      }

      const numericStatus = Number(response && response.status);
      const status =
        response && response.status != null && Number.isFinite(numericStatus)
          ? numericStatus
          : response && response.ok
            ? 200
            : 0;

      if (status >= 300 && status < 400) {
        throw new TrackerRequestError(
          "error",
          `GitHub 返回重定向（${status}），已拒绝跟随`,
        );
      }
      if (status < 200 || status >= 300) {
        const limited = rateLimitMessage(response || {}, status, this.#now());
        if (limited) {
          throw new TrackerRequestError("rate-limited", limited);
        }
        if (status === 401) {
          throw new TrackerRequestError(
            "unauthenticated",
            "GitHub 认证失败（401）",
          );
        }
        if (status === 403) {
          throw new TrackerRequestError("error", "GitHub 拒绝访问（403）");
        }
        throw new TrackerRequestError(
          "error",
          `GitHub 返回 ${status || "未知状态"}`,
        );
      }

      let text;
      try {
        text = await readBodyCapped(response, controller);
      } catch (error) {
        if (error instanceof TrackerRequestError) {
          throw error;
        }
        if (timeoutSignal.aborted) {
          throw new TrackerRequestError("error", "GitHub 请求超时");
        }
        throw new TrackerRequestError(
          "error",
          this.#cleanError(
            `读取 GitHub 响应失败：${error && error.message ? error.message : "未知错误"}`,
          ),
        );
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new TrackerRequestError("error", "GitHub 响应不是合法 JSON");
      }
    } finally {
      timeoutSignal.removeEventListener("abort", onTimeout);
    }
  }

  async #refreshOnce() {
    const base = {
      kind: "github",
      status: "error",
      detail: "",
      issues: [],
      prs: [],
      fetchedAt: null,
    };

    if (!this.#token) {
      return {
        ...base,
        status: "unauthenticated",
        detail: "未配置 GitHub token，请设置 GITHUB_TOKEN 或 GH_TOKEN",
      };
    }
    if (this.#repoInvalid) {
      return { ...base, detail: "repo 参数非法" };
    }
    if (typeof this.#fetchImpl !== "function") {
      return { ...base, detail: "当前环境没有可用的 fetch" };
    }

    try {
      const issueData = await this.#get(
        `/repos/${this.#repo}/issues?state=all&per_page=50`,
      );
      const prData = await this.#get(
        `/repos/${this.#repo}/pulls?state=all&per_page=50`,
      );
      if (!Array.isArray(issueData) || !Array.isArray(prData)) {
        throw new TrackerRequestError("error", "GitHub 响应形状非法");
      }

      const issues = issueData
        .filter((item) => item && !item.pull_request)
        .map((item) => mapIssue(item));
      const prs = prData.map((item) => mapPullRequest(item));

      return {
        ...base,
        status: "ready",
        detail: `GitHub 数据已刷新（${issues.length} 个 issue，${prs.length} 个 PR）`,
        issues,
        prs,
        fetchedAt: this.#now(),
      };
    } catch (error) {
      const status =
        error && typeof error.trackerStatus === "string"
          ? error.trackerStatus
          : "error";
      return {
        ...base,
        status,
        detail: this.#cleanError(
          error && error.message ? error.message : "GitHub 请求失败",
        ),
      };
    }
  }

  async refresh() {
    if (this.#refreshing) {
      return this.#refreshing;
    }
    this.#refreshing = this.#refreshOnce()
      .catch((error) => ({
        kind: "github",
        status: "error",
        detail: this.#cleanError(
          error && error.message ? error.message : "GitHub 请求失败",
        ),
        issues: [],
        prs: [],
        fetchedAt: null,
      }))
      .then((snapshot) => {
        this.#snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.#refreshing = null;
      });
    return this.#refreshing;
  }

  async #ensureSnapshot() {
    if (this.#snapshot) {
      return this.#snapshot;
    }
    return this.refresh();
  }

  // 列表/详情复用最近一次 refresh 快照；快照不存在时自动刷新，getComments 始终实时请求。
  async listIssues() {
    const snapshot = await this.#ensureSnapshot();
    return snapshot.issues.slice();
  }

  async getIssue(number) {
    const snapshot = await this.#ensureSnapshot();
    return (
      snapshot.issues.find(
        (issue) => String(issue.id) === String(number),
      ) || null
    );
  }

  async listPRs() {
    const snapshot = await this.#ensureSnapshot();
    return snapshot.prs.slice();
  }

  async getComments(number) {
    const snapshot = await this.#ensureSnapshot();
    if (snapshot.status !== "ready") {
      return [];
    }
    const id = Number(number);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return [];
    }
    try {
      const data = await this.#get(
        `/repos/${this.#repo}/issues/${id}/comments?per_page=50`,
      );
      if (!Array.isArray(data)) {
        return [];
      }
      return data.map((item) => mapComment(item));
    } catch {
      return [];
    }
  }
}

function unquote(value) {
  const text = value.trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function parseFrontmatter(raw) {
  const text = String(raw);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    return {};
  }

  const result = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.startsWith("#") || /^\s/.test(line)) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    if (value === "") {
      const items = [];
      let next = index + 1;
      while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
        const item = unquote(
          lines[next].replace(/^\s+-\s+/, "").trim(),
        );
        if (item) {
          items.push(item);
        }
        next += 1;
      }
      if (items.length > 0) {
        result[key] = items;
        index = next - 1;
        continue;
      }
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => unquote(item.trim()))
        .filter((item) => item);
    } else {
      result[key] = unquote(value);
    }
  }
  return result;
}

function parseCardLabels(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item);
  }
  if (typeof value !== "string") {
    return [];
  }
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  return text
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter((item) => item);
}

function parseCardId(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  return text;
}

function cardTitle(raw, baseName) {
  const meta = parseFrontmatter(raw);
  if (typeof meta.title === "string" && meta.title.trim()) {
    return meta.title.trim();
  }
  const body = String(raw).replace(
    /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
    "",
  );
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) {
    return heading[1].trim();
  }
  const fallback = baseName
    .replace(/^\d+-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return fallback || baseName;
}

class LocalTracker {
  #root;
  #existsSync;
  #readFileSync;
  #readdirSync;
  #snapshot = null;

  constructor(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    const deps =
      options.deps && typeof options.deps === "object" ? options.deps : options;
    this.kind = "local";
    this.#root =
      typeof options.root === "string" && options.root
        ? options.root
        : process.cwd();
    this.#existsSync =
      typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;
    this.#readFileSync =
      typeof deps.readFileSync === "function"
        ? deps.readFileSync
        : (target, encoding) => fs.readFileSync(target, encoding);
    this.#readdirSync =
      typeof deps.readdirSync === "function" ? deps.readdirSync : fs.readdirSync;
  }

  async refresh() {
    const base = {
      kind: "local",
      status: "error",
      detail: "",
      issues: [],
      prs: [],
      fetchedAt: null,
    };
    const scratchDir = path.join(this.#root, ".scratch");
    if (!this.#existsSync(scratchDir)) {
      this.#snapshot = { ...base, detail: ".scratch 不存在" };
      return this.#snapshot;
    }

    let entries;
    try {
      entries = this.#readdirSync(scratchDir);
    } catch {
      this.#snapshot = { ...base, detail: "无法读取 .scratch" };
      return this.#snapshot;
    }

    const issues = [];
    for (const entry of entries.slice().sort()) {
      if (
        typeof entry !== "string" ||
        !entry.toLowerCase().endsWith(".md")
      ) {
        continue;
      }
      const idMatch = /^(\d+)-/.exec(entry);
      if (!idMatch) {
        continue;
      }
      let raw;
      try {
        raw = String(
          this.#readFileSync(path.join(scratchDir, entry), "utf8"),
        );
      } catch {
        continue;
      }
      const meta = parseFrontmatter(raw);
      const status = typeof meta.status === "string" ? meta.status.toLowerCase() : "";
      issues.push({
        id: parseCardId(meta.id, Number(idMatch[1])),
        title: cardTitle(raw, entry.replace(/\.md$/i, "")),
        state: status === "closed" ? "closed" : "open",
        labels: parseCardLabels(meta.labels),
        url: typeof meta.url === "string" ? meta.url : null,
        updatedAt:
          typeof meta.updated === "string"
            ? meta.updated
            : typeof meta.updatedAt === "string"
              ? meta.updatedAt
              : typeof meta.updated_at === "string"
                ? meta.updated_at
                : null,
      });
    }

    this.#snapshot = {
      ...base,
      status: "ready",
      detail: `本地卡片 ${issues.length} 张`,
      issues,
      fetchedAt: Date.now(),
    };
    return this.#snapshot;
  }

  async #ensureSnapshot() {
    if (this.#snapshot) {
      return this.#snapshot;
    }
    return this.refresh();
  }

  async listIssues() {
    const snapshot = await this.#ensureSnapshot();
    return snapshot.issues.slice();
  }

  async getIssue(number) {
    const snapshot = await this.#ensureSnapshot();
    return (
      snapshot.issues.find(
        (issue) => String(issue.id) === String(number),
      ) || null
    );
  }

  async listPRs() {
    return [];
  }

  async getComments() {
    return [];
  }
}

class UnsupportedTracker {
  constructor(opts) {
    const options = opts && typeof opts === "object" ? opts : {};
    this.kind =
      typeof options.kind === "string" && options.kind
        ? options.kind
        : "gitlab";
  }

  async refresh() {
    return {
      kind: this.kind,
      status: "unsupported",
      detail: "GitLab 只读接入尚未实现",
      issues: [],
      prs: [],
      fetchedAt: null,
    };
  }

  async listIssues() {
    return [];
  }

  async getIssue() {
    return null;
  }

  async listPRs() {
    return [];
  }

  async getComments() {
    return [];
  }
}

function sanitizeLog(text) {
  return redact(text);
}

function createTracker(opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const kind =
    typeof options.kind === "string" && options.kind
      ? options.kind.toLowerCase()
      : options.repo
        ? "github"
        : "local";

  if (kind === "github") {
    return new GithubTracker(options);
  }
  if (kind === "local") {
    return new LocalTracker(options);
  }
  if (kind === "gitlab") {
    return new UnsupportedTracker({ ...options, kind: "gitlab" });
  }
  return new UnsupportedTracker({ ...options, kind });
}

module.exports = {
  assertSafeUrl,
  createTracker,
  sanitizeLog,
  GithubTracker,
  LocalTracker,
  UnsupportedTracker,
  UnsafeUrlError,
};

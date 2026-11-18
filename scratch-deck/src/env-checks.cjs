"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER = 262144;
const REDACT_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|token\s+\S+)/gi;
const REQUIRED_SKILLS = [
  "wayfinder",
  "triage",
  "grilling",
  "tdd",
  "to-tickets",
  "implement-spec",
  "diagnosing-bugs",
  "handoff",
];

function redact(text) {
  const value =
    typeof text === "string" ? text : text == null ? "" : String(text);
  return value.replace(REDACT_PATTERN, "[REDACTED]").slice(0, 300);
}

function defaultRunProc(argv, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const cwd =
    typeof options.cwd === "string" && options.cwd
      ? options.cwd
      : process.cwd();
  const timeout = Number.isFinite(options.timeout)
    ? options.timeout
    : COMMAND_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer)
    ? options.maxBuffer
    : COMMAND_MAX_BUFFER;

  return new Promise((resolve) => {
    try {
      execFile(
        argv[0],
        argv.slice(1),
        {
          cwd,
          timeout,
          maxBuffer,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({
              code: 0,
              stdout: stdout || "",
              stderr: stderr || "",
              timedOut: false,
            });
            return;
          }

          const timedOut = Boolean(
            error.killed ||
              error.signal ||
              error.code === "ETIMEDOUT" ||
              /timed?\s*out/i.test(error.message || ""),
          );
          const code =
            typeof error.code === "number"
              ? error.code
              : typeof error.exitCode === "number"
                ? error.exitCode
                : -1;
          const extra =
            stderr || (error.code === "ENOENT" ? "ENOENT" : error.message || "");
          resolve({
            code,
            stdout: stdout || "",
            stderr: extra,
            timedOut,
          });
        },
      );
    } catch (error) {
      resolve({
        code: -1,
        stdout: "",
        stderr: error && error.message ? error.message : "命令启动失败",
        timedOut: false,
      });
    }
  });
}

function defaultDeps() {
  return {
    runProc: defaultRunProc,
    existsSync: (target) => fs.existsSync(target),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    readdirSync: (target) => fs.readdirSync(target),
    homedir: () => os.homedir(),
    gitSkillsDirs: null,
  };
}

function resolveDeps(overrides) {
  const base = defaultDeps();
  if (!overrides || typeof overrides !== "object") {
    return base;
  }
  return {
    runProc:
      typeof overrides.runProc === "function" ? overrides.runProc : base.runProc,
    existsSync:
      typeof overrides.existsSync === "function"
        ? overrides.existsSync
        : base.existsSync,
    readFileSync:
      typeof overrides.readFileSync === "function"
        ? overrides.readFileSync
        : base.readFileSync,
    readdirSync:
      typeof overrides.readdirSync === "function"
        ? overrides.readdirSync
        : base.readdirSync,
    homedir:
      typeof overrides.homedir === "function" || typeof overrides.homedir === "string"
        ? overrides.homedir
        : base.homedir,
    gitSkillsDirs: overrides.gitSkillsDirs,
  };
}

function getHome(deps) {
  try {
    const value =
      typeof deps.homedir === "function" ? deps.homedir() : deps.homedir;
    return typeof value === "string" && value ? value : os.homedir();
  } catch {
    return os.homedir();
  }
}

function isDirectory(deps, target) {
  if (typeof target !== "string" || !target || !deps.existsSync(target)) {
    return false;
  }
  try {
    deps.readdirSync(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeProc(result) {
  const value = result && typeof result === "object" ? result : {};
  return {
    code: Number.isInteger(value.code) ? value.code : -1,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    timedOut: Boolean(value.timedOut),
  };
}

async function runCommand(deps, argv, cwd) {
  try {
    const result = await deps.runProc(argv, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER,
      shell: false,
    });
    return normalizeProc(result);
  } catch (error) {
    return {
      code: -1,
      stdout: "",
      stderr: error && error.message ? error.message : "命令执行失败",
      timedOut: false,
    };
  }
}

function isMissingCommand(result) {
  if (result.timedOut) {
    return false;
  }
  if (!/ENOENT|not found|command not found|无法找到|找不到/i.test(result.stderr)) {
    return false;
  }
  return result.code !== 0;
}

function safeCwd(deps, root) {
  return isDirectory(deps, root) ? root : process.cwd();
}

function commandFailure(label, result) {
  if (result.timedOut) {
    return `${label} 超时`;
  }
  if (isMissingCommand(result)) {
    return `未找到 ${label.split(" ")[0]} 命令`;
  }
  return `${label} 失败（退出码 ${result.code}）`;
}

function discoverSkillRoots(deps) {
  if (Array.isArray(deps.gitSkillsDirs)) {
    return deps.gitSkillsDirs.filter((item) => typeof item === "string" && item);
  }
  if (typeof deps.gitSkillsDirs === "function") {
    try {
      const value = deps.gitSkillsDirs();
      return Array.isArray(value)
        ? value.filter((item) => typeof item === "string" && item)
        : [];
    } catch {
      return [];
    }
  }

  const cacheRoot = path.join(getHome(deps), ".zcode", "cli", "plugins", "cache");
  let cacheEntries;
  try {
    cacheEntries = deps.readdirSync(cacheRoot);
  } catch {
    return [];
  }

  const roots = [];
  for (const pluginName of cacheEntries) {
    const pluginDir = path.join(cacheRoot, pluginName, "mattpocock-skills");
    if (!deps.existsSync(pluginDir)) {
      continue;
    }
    let versions;
    try {
      versions = deps.readdirSync(pluginDir);
    } catch {
      continue;
    }
    for (const version of versions) {
      const skillsDir = path.join(pluginDir, version, "skills");
      if (deps.existsSync(skillsDir)) {
        roots.push(skillsDir);
      }
    }
  }
  return roots;
}

function createCheck(id, label, status, detail, hint, durationMs) {
  return {
    id,
    label,
    status,
    detail: typeof detail === "string" ? detail : String(detail),
    hint: typeof hint === "string" ? hint : null,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
  };
}

async function runEnvChecksInner(opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const root = typeof options.root === "string" ? options.root : "";
  const deps = resolveDeps(options.deps);
  const at = Date.now();
  const checks = [];

  const runCheck = async (id, label, hint, fn) => {
    const started = Date.now();
    try {
      const result = await fn();
      checks.push(
        createCheck(
          id,
          label,
          result.status,
          result.detail,
          result.hint == null ? hint : result.hint,
          Date.now() - started,
        ),
      );
    } catch (error) {
      checks.push(
        createCheck(
          id,
          label,
          "fail",
          redact(error && error.message ? error.message : "检查异常"),
          hint,
          Date.now() - started,
        ),
      );
    }
  };

  try {
    await runCheck(
      "workspace",
      "工作区",
      "确认 root 路径存在且为目录",
      async () => {
        if (!root) {
          return { status: "fail", detail: "未提供 root 路径" };
        }
        if (!deps.existsSync(root)) {
          return { status: "fail", detail: `root 不存在：${root}` };
        }
        if (!isDirectory(deps, root)) {
          return { status: "fail", detail: "root 不是可读目录" };
        }
        return { status: "ok", detail: "root 可用" };
      },
    );

    await runCheck(
      "scratch",
      ".scratch 目录",
      "创建 .scratch 目录后重试",
      async () => {
        if (!isDirectory(deps, root)) {
          return { status: "skipped", detail: "root 不可用，跳过" };
        }
        const scratchDir = path.join(root, ".scratch");
        if (!deps.existsSync(scratchDir)) {
          return { status: "fail", detail: ".scratch 不存在" };
        }
        if (!isDirectory(deps, scratchDir)) {
          return { status: "fail", detail: ".scratch 不是目录" };
        }
        return { status: "ok", detail: ".scratch 可用" };
      },
    );

    await runCheck(
      "cards",
      "卡片",
      "卡片文件名需以数字加短横线开头",
      async () => {
        if (!isDirectory(deps, root)) {
          return { status: "skipped", detail: "root 不可用，跳过" };
        }
        const scratchDir = path.join(root, ".scratch");
        if (!isDirectory(deps, scratchDir)) {
          return { status: "skipped", detail: ".scratch 不存在，跳过" };
        }

        let entries;
        try {
          entries = deps.readdirSync(scratchDir);
        } catch {
          return { status: "fail", detail: "无法读取 .scratch" };
        }

        const cards = entries
          .filter(
            (name) => typeof name === "string" && name.toLowerCase().endsWith(".md"),
          )
          .sort();
        const malformed = [];
        for (const name of cards) {
          try {
            deps.readFileSync(path.join(scratchDir, name), "utf8");
          } catch {
            malformed.push(name);
            continue;
          }
          if (!/^\d+-/.test(name)) {
            malformed.push(name);
          }
        }

        if (malformed.length > 0) {
          return {
            status: "warn",
            detail: `${cards.length} 张卡片，${malformed.length} 个无法解析（首个：${malformed[0]}）`,
          };
        }
        return { status: "ok", detail: `${cards.length} 张卡片` };
      },
    );

    await runCheck("git", "git", "安装 git 并确保在 PATH 中", async () => {
      const cwd = safeCwd(deps, root);
      const result = await runCommand(deps, ["git", "--version"], cwd);
      if (result.timedOut) {
        return { status: "fail", detail: commandFailure("git --version", result) };
      }
      if (result.code === 0) {
        return { status: "ok", detail: "git 可用" };
      }
      return { status: "fail", detail: commandFailure("git --version", result) };
    });

    await runCheck(
      "git-repo",
      "git 仓库",
      "在 root 中执行 git init",
      async () => {
        if (!isDirectory(deps, root)) {
          return { status: "skipped", detail: "root 不可用，跳过" };
        }
        const result = await runCommand(
          deps,
          ["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
          root,
        );
        if (result.timedOut) {
          return {
            status: "fail",
            detail: commandFailure("git rev-parse", result),
          };
        }
        if (isMissingCommand(result)) {
          return { status: "skipped", detail: "git 不可用，跳过" };
        }
        if (result.code !== 0 || result.stdout.trim() !== "true") {
          return { status: "warn", detail: "root 不是 git 仓库" };
        }
        return { status: "ok", detail: "root 是 git 仓库" };
      },
    );

    await runCheck("gh", "gh", "安装 GitHub CLI 并确保在 PATH 中", async () => {
      const cwd = safeCwd(deps, root);
      const result = await runCommand(deps, ["gh", "--version"], cwd);
      if (result.timedOut) {
        return { status: "fail", detail: commandFailure("gh --version", result) };
      }
      if (result.code === 0) {
        return { status: "ok", detail: "gh 可用" };
      }
      return { status: "fail", detail: commandFailure("gh --version", result) };
    });

    await runCheck(
      "gh-auth",
      "gh 认证",
      "运行 gh auth login",
      async () => {
        const cwd = safeCwd(deps, root);
        const result = await runCommand(deps, ["gh", "auth", "status"], cwd);
        if (result.timedOut) {
          return { status: "fail", detail: "gh auth status 超时" };
        }
        if (result.code === 0) {
          return { status: "ok", detail: "gh 已认证" };
        }
        if (isMissingCommand(result)) {
          return { status: "fail", detail: "未找到 gh 命令" };
        }
        const reason = redact(
          `gh 未认证：${result.stderr || result.stdout || `退出码 ${result.code}`}`,
        );
        return { status: "warn", detail: reason };
      },
    );

    await runCheck(
      "skills",
      "mattpocock 技能",
      "安装 mattpocock-skills 插件",
      async () => {
        const roots = discoverSkillRoots(deps);
        const found = [];
        for (const name of REQUIRED_SKILLS) {
          for (const skillsDir of roots) {
            const nested = deps.existsSync(
              path.join(skillsDir, name, "SKILL.md"),
            );
            const direct =
              path.basename(skillsDir) === name &&
              deps.existsSync(path.join(skillsDir, "SKILL.md"));
            const directFile =
              skillsDir.endsWith(path.join(name, "SKILL.md")) &&
              deps.existsSync(skillsDir);
            if (nested || direct || directFile) {
              found.push(name);
              break;
            }
          }
        }
        const missing = REQUIRED_SKILLS.filter((name) => !found.includes(name));
        if (missing.length === 0) {
          return {
            status: "ok",
            detail: `${found.length}/${REQUIRED_SKILLS.length} 个技能已安装`,
          };
        }
        return {
          status: "warn",
          detail: `${found.length}/${REQUIRED_SKILLS.length} 个技能已安装，缺少：${missing.join(", ")}`,
        };
      },
    );

    await runCheck(
      "roots-config",
      "roots 配置",
      "修复 JSON 或移除该文件",
      async () => {
        const configPath = path.join(
          getHome(deps),
          ".zcode",
          "scratch-deck-roots.json",
        );
        if (!deps.existsSync(configPath)) {
          return { status: "warn", detail: "未找到 roots 配置文件，视为尚未配置" };
        }

        let raw;
        try {
          raw = deps.readFileSync(configPath, "utf8");
        } catch {
          return { status: "fail", detail: "无法读取 roots 配置文件" };
        }

        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return { status: "fail", detail: "roots 配置不是合法 JSON" };
        }

        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return { status: "fail", detail: "roots 配置形状非法" };
        }
        if (
          !Array.isArray(data.roots) ||
          data.roots.some((item) => typeof item !== "string")
        ) {
          return { status: "fail", detail: "roots 必须是字符串数组" };
        }
        if (data.active !== undefined) {
          if (
            typeof data.active !== "string" ||
            !data.roots.includes(data.active)
          ) {
            return { status: "fail", detail: "active 不在 roots 中" };
          }
        }
        return {
          status: "ok",
          detail: `roots 配置有效（${data.roots.length} 个）`,
        };
      },
    );
  } catch (error) {
    checks.push(
      createCheck(
        "internal",
        "环境检查",
        "fail",
        redact(error && error.message ? error.message : "环境检查异常"),
        null,
        0,
      ),
    );
  }

  const summary = { ok: 0, warn: 0, fail: 0, skipped: 0 };
  for (const check of checks) {
    if (Object.prototype.hasOwnProperty.call(summary, check.status)) {
      summary[check.status] += 1;
    }
  }

  return { root, at, checks, summary };
}

async function runEnvChecks(opts) {
  try {
    return await runEnvChecksInner(opts);
  } catch (error) {
    const root =
      opts && typeof opts === "object" && typeof opts.root === "string"
        ? opts.root
        : "";
    return {
      root,
      at: Date.now(),
      checks: [
        createCheck(
          "internal",
          "环境检查",
          "fail",
          redact(error && error.message ? error.message : "环境检查异常"),
          null,
          0,
        ),
      ],
      summary: { ok: 0, warn: 0, fail: 1, skipped: 0 },
    };
  }
}

module.exports = { runEnvChecks, redact };

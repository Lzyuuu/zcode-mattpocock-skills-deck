"use strict";

const { execFile } = require("child_process");
const { redact } = require("./env-checks.cjs");

const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_MAX_BUFFER = 262144;
const STDOUT_CAP_BYTES = 262144;
const DIRTY_FILE_CAP = 200;
const COMMIT_CAP = 8;

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
          resolve({
            code,
            stdout: stdout || "",
            stderr:
              stderr ||
              (error.code === "ENOENT" ? "ENOENT" : error.message || ""),
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

function normalizeProc(result) {
  const value = result && typeof result === "object" ? result : {};
  return {
    code: Number.isInteger(value.code) ? value.code : -1,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    timedOut: Boolean(value.timedOut),
  };
}

function isMissingCommand(result) {
  return (
    !result.timedOut &&
    result.code !== 0 &&
    (result.code === 127 ||
      /ENOENT|not found|command not found|无法找到|找不到/i.test(result.stderr))
  );
}

function capStdout(text) {
  if (typeof text !== "string" || !text) {
    return "";
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= STDOUT_CAP_BYTES) {
    return text;
  }
  return buffer.subarray(0, STDOUT_CAP_BYTES).toString("utf8");
}

function oneLine(text) {
  return redact(
    String(text == null ? "" : text)
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function emptyStatus(kind, at, error) {
  return {
    kind,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: { count: 0, files: [], truncated: false },
    commits: [],
    error: typeof error === "string" && error ? error : null,
    at,
  };
}

function parsePorcelain(raw) {
  const text = capStdout(raw);
  const tokens = text.split("\0");
  const files = [];
  let total = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.length < 3) {
      continue;
    }

    const x = token[0];
    const y = token[1];
    const filePath = token.slice(3);
    total += 1;

    if (files.length < DIRTY_FILE_CAP) {
      files.push({ x, y, path: filePath });
    }

    // -z 把重命名/复制的两个路径作为连续 NUL 字段；第二个字段不是独立条目。
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      if (index + 1 < tokens.length && tokens[index + 1]) {
        index += 1;
      }
    }
  }

  return { files, total, truncated: total > DIRTY_FILE_CAP };
}

function parseCommits(raw) {
  const text = capStdout(raw);
  const commits = [];
  for (const line of text.split("\n")) {
    if (!line || commits.length >= COMMIT_CAP) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 3) {
      continue;
    }
    commits.push({
      hash: parts[0].trim(),
      date: parts[1].trim(),
      subject: parts.slice(2).join("\t").trim(),
    });
  }
  return commits;
}

async function readGitStatus(root, opts) {
  const at = Date.now();
  const options = opts && typeof opts === "object" ? opts : {};
  const deps =
    options.deps && typeof options.deps === "object" ? options.deps : options;
  const runProc =
    typeof deps.runProc === "function" ? deps.runProc : defaultRunProc;
  const cwd = typeof root === "string" ? root : "";

  if (!cwd || cwd.includes("\0")) {
    return emptyStatus("error", at, "root 参数非法");
  }

  const run = async (argv) => {
    try {
      const result = await runProc(argv, {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER,
        shell: false,
      });
      return normalizeProc(result);
    } catch (error) {
      return {
        code: -2,
        stdout: "",
        stderr: error && error.message ? error.message : "命令执行失败",
        timedOut: false,
      };
    }
  };

  const inside = await run([
    "git",
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (inside.timedOut) {
    return emptyStatus("error", at, "git rev-parse 超时");
  }
  if (isMissingCommand(inside)) {
    return emptyStatus("git-missing", at, "未找到 git 命令");
  }
  if (inside.code === -2) {
    return emptyStatus(
      "error",
      at,
      oneLine(inside.stderr) || "git 执行失败",
    );
  }
  if (inside.code !== 0) {
    return emptyStatus("not-a-repo", at, null);
  }
  if (capStdout(inside.stdout).trim() !== "true") {
    return emptyStatus("not-a-repo", at, null);
  }

  const branchResult = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchResult.timedOut) {
    return emptyStatus("error", at, "git rev-parse HEAD 超时");
  }
  if (isMissingCommand(branchResult)) {
    return emptyStatus("git-missing", at, "未找到 git 命令");
  }

  let branch = null;
  let detached = false;
  if (branchResult.code === 0) {
    const value = capStdout(branchResult.stdout).trim();
    if (!value || value === "HEAD") {
      detached = true;
    } else {
      branch = value;
    }
  } else if (
    /unknown revision|ambiguous argument|needed a single revision|no commits yet/i.test(
      branchResult.stderr,
    )
  ) {
    detached = true;
  } else {
    return emptyStatus(
      "error",
      at,
      oneLine(branchResult.stderr) ||
        `git rev-parse HEAD 失败（退出码 ${branchResult.code}）`,
    );
  }

  const statusResult = await run(["git", "status", "--porcelain=v1", "-z"]);
  if (statusResult.timedOut) {
    return emptyStatus("error", at, "git status 超时");
  }
  if (isMissingCommand(statusResult)) {
    return emptyStatus("git-missing", at, "未找到 git 命令");
  }
  if (statusResult.code !== 0) {
    return emptyStatus(
      "error",
      at,
      oneLine(statusResult.stderr) ||
        `git status 失败（退出码 ${statusResult.code}）`,
    );
  }
  const parsedDirty = parsePorcelain(statusResult.stdout);

  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let hasUpstream = false;
  const upstreamResult = await run([
    "git",
    "rev-list",
    "--left-right",
    "--count",
    "@{upstream}...HEAD",
  ]);
  if (upstreamResult.timedOut) {
    return emptyStatus("error", at, "git rev-list 超时");
  }
  if (isMissingCommand(upstreamResult)) {
    return emptyStatus("git-missing", at, "未找到 git 命令");
  }
  if (upstreamResult.code === -2) {
    return emptyStatus(
      "error",
      at,
      oneLine(upstreamResult.stderr) || "git rev-list 执行失败",
    );
  }
  if (upstreamResult.code === 0) {
    hasUpstream = true;
    const counts = capStdout(upstreamResult.stdout).trim().split(/\s+/);
    if (counts.length >= 2) {
      const parsedBehind = Number(counts[0]);
      const parsedAhead = Number(counts[1]);
      if (Number.isFinite(parsedBehind) && Number.isFinite(parsedAhead)) {
        behind = parsedBehind;
        ahead = parsedAhead;
      }
    }
  }

  const logResult = await run([
    "git",
    "log",
    "--max-count=8",
    "--date=short",
    "--format=%h%x09%ad%x09%s",
  ]);
  if (logResult.timedOut) {
    return emptyStatus("error", at, "git log 超时");
  }
  if (isMissingCommand(logResult)) {
    return emptyStatus("git-missing", at, "未找到 git 命令");
  }
  if (logResult.code !== 0) {
    if (
      !/does not have any commits|no commits yet|unknown revision|bad default revision/i.test(
        logResult.stderr,
      )
    ) {
      return emptyStatus(
        "error",
        at,
        oneLine(logResult.stderr) ||
          `git log 失败（退出码 ${logResult.code}）`,
      );
    }
  }

  if (hasUpstream) {
    const upstreamName = await run([
      "git",
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (upstreamName.timedOut) {
      return emptyStatus("error", at, "git rev-parse upstream 超时");
    }
    if (upstreamName.code === 0) {
      upstream = capStdout(upstreamName.stdout).trim() || null;
    }
  }

  return {
    kind: "repo",
    branch,
    detached,
    upstream,
    ahead,
    behind,
    dirty: {
      count: parsedDirty.total,
      files: parsedDirty.files,
      truncated: parsedDirty.truncated,
    },
    commits: logResult.code === 0 ? parseCommits(logResult.stdout) : [],
    error: null,
    at,
  };
}

module.exports = { readGitStatus };

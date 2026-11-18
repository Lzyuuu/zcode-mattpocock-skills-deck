"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runEnvChecks, redact } = require("../src/env-checks.cjs");
const { readGitStatus } = require("../src/git-status.cjs");
const {
  assertSafeUrl,
  createTracker,
  sanitizeLog,
  UnsafeUrlError,
} = require("../src/tracker.cjs");

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-deck-data-plane-"));
let assertions = 0;
let failures = 0;

function assert(condition, message) {
  assertions += 1;
  if (!condition) {
    throw new Error(message || "断言失败");
  }
}

function assertEqual(actual, expected, message) {
  assert(
    Object.is(actual, expected),
    `${message}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
  );
}

function assertIncludes(text, needle, message) {
  assert(
    typeof text === "string" && text.includes(needle),
    `${message}: 文本不含 ${JSON.stringify(needle)}`,
  );
}

async function group(name, fn) {
  const before = assertions;
  try {
    await fn();
    console.log(`ok   ${name} (${assertions - before} assertions)`);
  } catch (error) {
    failures += 1;
    const message = String(error && error.message ? error.message : error)
      .replace(/\s+/g, " ")
      .slice(0, 300);
    console.log(`FAIL ${name}: ${message}`);
  }
}

function tempDir(name) {
  const target = path.join(BASE, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function procResult(code, stdout, stderr, timedOut) {
  return {
    code: code == null ? 0 : code,
    stdout: stdout || "",
    stderr: stderr || "",
    timedOut: Boolean(timedOut),
  };
}

function basicProc(argv) {
  const joined = argv.join(" ");
  if (joined === "git --version") {
    return procResult(0, "git version 2.42.0\n");
  }
  if (argv[0] === "git" && argv.includes("--is-inside-work-tree")) {
    return procResult(0, "true\n");
  }
  if (joined === "gh --version") {
    return procResult(0, "gh version 2.40.0\n");
  }
  if (joined === "gh auth status") {
    return procResult(0, "Logged in to github.com\n");
  }
  return procResult(1, "", `unexpected command: ${joined}`);
}

function checkById(report, id) {
  return report.checks.find((check) => check.id === id);
}

function createCard(root, fileName, content) {
  const scratch = path.join(root, ".scratch");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, fileName), content);
}

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

function installSkills(root, names) {
  for (const name of names) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n`);
  }
}

function writeRootsConfig(home, value) {
  const zcode = path.join(home, ".zcode");
  fs.mkdirSync(zcode, { recursive: true });
  fs.writeFileSync(
    path.join(zcode, "scratch-deck-roots.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function expectAllowed(input) {
  const parsed = assertSafeUrl(input);
  assert(parsed instanceof URL, `${input} 应返回 URL`);
  return parsed;
}

function expectBlocked(input, code) {
  let error = null;
  try {
    assertSafeUrl(input);
  } catch (caught) {
    error = caught;
  }
  assert(error !== null, `${input} 应被拒绝`);
  if (!error) {
    return;
  }
  assert(error instanceof UnsafeUrlError, `${input} 应抛 UnsafeUrlError`);
  assertEqual(error.code, code, `${input} 错误码`);
}

function jsonResponse(status, data, headers) {
  const text = JSON.stringify(data);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers || {},
    text: async () => text,
  };
}

(async () => {
  await group("env-checks: all ok", async () => {
    const root = tempDir("root-ok");
    createCard(
      root,
      "001-alpha.md",
      "---\nstatus: open\ntitle: Alpha\n---\n# Alpha\n",
    );
    const home = tempDir("home-ok");
    writeRootsConfig(home, { roots: [root], active: root });
    const skills = tempDir("skills-ok");
    installSkills(skills, REQUIRED_SKILLS);

    const report = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => home,
        gitSkillsDirs: [skills],
      },
    });

    assertEqual(report.root, root, "report.root");
    assertEqual(report.checks.length, 9, "检查项数量");
    assertEqual(report.summary.ok, 9, "ok 数量");
    assertEqual(report.summary.warn, 0, "warn 数量");
    assertEqual(report.summary.fail, 0, "fail 数量");
    assertEqual(report.summary.skipped, 0, "skipped 数量");
    assertEqual(checkById(report, "workspace").status, "ok", "workspace");
    assertEqual(checkById(report, "scratch").status, "ok", ".scratch");
    assertEqual(checkById(report, "cards").status, "ok", "cards");
    assertIncludes(checkById(report, "cards").detail, "1 张卡片", "卡片数量");
    assertEqual(checkById(report, "git").status, "ok", "git");
    assertEqual(checkById(report, "git-repo").status, "ok", "git-repo");
    assertEqual(checkById(report, "gh").status, "ok", "gh");
    assertEqual(checkById(report, "gh-auth").status, "ok", "gh-auth");
    assertEqual(checkById(report, "skills").status, "ok", "skills");
    assertEqual(checkById(report, "roots-config").status, "ok", "roots");
    assert(
      report.checks.every(
        (check) =>
          typeof check.durationMs === "number" && check.durationMs >= 0,
      ),
      "durationMs 应为非负数",
    );
  });

  await group("env-checks: missing root", async () => {
    const home = tempDir("home-missing-root");
    const report = await runEnvChecks({
      root: path.join(BASE, "does-not-exist"),
      deps: {
        runProc: basicProc,
        homedir: () => home,
        gitSkillsDirs: [],
      },
    });
    assertEqual(checkById(report, "workspace").status, "fail", "workspace");
    assertEqual(checkById(report, "scratch").status, "skipped", ".scratch");
    assertEqual(checkById(report, "cards").status, "skipped", "cards");
    assertEqual(checkById(report, "roots-config").status, "warn", "roots");
    assertEqual(report.summary.fail, 1, "fail 数量");
  });

  await group("env-checks: .scratch absent", async () => {
    const root = tempDir("root-no-scratch");
    const home = tempDir("home-no-scratch");
    const report = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => home,
        gitSkillsDirs: [],
      },
    });
    assertEqual(checkById(report, "workspace").status, "ok", "workspace");
    assertEqual(checkById(report, "scratch").status, "fail", ".scratch");
    assertEqual(checkById(report, "cards").status, "skipped", "cards");
  });

  await group("env-checks: malformed card is warn", async () => {
    const root = tempDir("root-bad-card");
    createCard(root, "001-good.md", "# Good\n");
    createCard(root, "notes.md", "# Notes\n");
    const home = tempDir("home-bad-card");
    const report = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => home,
        gitSkillsDirs: [],
      },
    });
    const cards = checkById(report, "cards");
    assertEqual(cards.status, "warn", "cards");
    assertIncludes(cards.detail, "2 张卡片", "卡片数量");
    assertIncludes(cards.detail, "notes.md", "首个失败文件");
    assertIncludes(cards.detail, "1 个无法解析", "失败数量");
  });

  await group("env-checks: git missing", async () => {
    const root = tempDir("root-no-git");
    createCard(root, "001-good.md", "# Good\n");
    const home = tempDir("home-no-git");
    const proc = (argv) => {
      if (argv[0] === "git") {
        return procResult(-1, "", "spawn git ENOENT");
      }
      return basicProc(argv);
    };
    const report = await runEnvChecks({
      root,
      deps: { runProc: proc, homedir: () => home, gitSkillsDirs: [] },
    });
    const git = checkById(report, "git");
    assertEqual(git.status, "fail", "git");
    assertIncludes(git.detail, "未找到 git", "git 原因");
    assertEqual(checkById(report, "git-repo").status, "skipped", "git-repo");
    assertEqual(checkById(report, "gh").status, "ok", "gh");
  });

  await group("env-checks: not a repo", async () => {
    const root = tempDir("root-not-repo");
    createCard(root, "001-good.md", "# Good\n");
    const home = tempDir("home-not-repo");
    const proc = (argv) => {
      const joined = argv.join(" ");
      if (
        argv[0] === "git" &&
        argv.includes("--is-inside-work-tree")
      ) {
        return procResult(
          128,
          "",
          "fatal: not a git repository (or any of the parent directories): .git\n",
        );
      }
      return basicProc(argv);
    };
    const report = await runEnvChecks({
      root,
      deps: { runProc: proc, homedir: () => home, gitSkillsDirs: [] },
    });
    assertEqual(checkById(report, "git").status, "ok", "git");
    assertEqual(checkById(report, "git-repo").status, "warn", "git-repo");
    assertIncludes(
      checkById(report, "git-repo").detail,
      "不是 git 仓库",
      "git-repo 原因",
    );
  });

  await group("env-checks: gh auth failure redacts token", async () => {
    const root = tempDir("root-gh-auth");
    createCard(root, "001-good.md", "# Good\n");
    const home = tempDir("home-gh-auth");
    const fakeToken = `ghp_${"A".repeat(24)}`;
    const proc = (argv) => {
      if (argv.join(" ") === "gh auth status") {
        return procResult(
          1,
          "",
          `failed to authenticate: token ${fakeToken}\n`,
        );
      }
      return basicProc(argv);
    };
    const report = await runEnvChecks({
      root,
      deps: { runProc: proc, homedir: () => home, gitSkillsDirs: [] },
    });
    const auth = checkById(report, "gh-auth");
    assertEqual(auth.status, "warn", "gh-auth");
    assert(!auth.detail.includes(fakeToken), "gh-auth 详情泄露 token");
    assertIncludes(auth.detail, "[REDACTED]", "gh-auth 已脱敏");
    assert(auth.detail.length <= 300, "gh-auth 详情未截断");
    assertEqual(redact("x token abc"), "x [REDACTED]", "redact token");
    assertEqual(
      sanitizeLog("x token abc"),
      "x [REDACTED]",
      "sanitizeLog 复用 redact",
    );
    assertEqual(
      redact(`github_pat_${"B".repeat(24)}`),
      "[REDACTED]",
      "redact github_pat",
    );
    assertEqual(redact("x".repeat(400)).length, 300, "redact 截断");
  });

  await group("env-checks: skills partially found", async () => {
    const root = tempDir("root-skills-partial");
    createCard(root, "001-good.md", "# Good\n");
    const home = tempDir("home-skills-partial");
    const skills = tempDir("skills-partial");
    installSkills(skills, ["wayfinder", "triage", "grilling"]);
    const report = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => home,
        gitSkillsDirs: [skills],
      },
    });
    const check = checkById(report, "skills");
    assertEqual(check.status, "warn", "skills");
    assertIncludes(check.detail, "3/8", "技能发现数量");
    assertIncludes(check.detail, "tdd", "缺失技能");
  });

  await group("env-checks: roots config invalid", async () => {
    const root = tempDir("root-bad-roots");
    createCard(root, "001-good.md", "# Good\n");

    const homeInvalid = tempDir("home-bad-json");
    writeRootsConfig(homeInvalid, "{ nope");
    const invalidReport = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => homeInvalid,
        gitSkillsDirs: [],
      },
    });
    const invalid = checkById(invalidReport, "roots-config");
    assertEqual(invalid.status, "fail", "非法 JSON");
    assertIncludes(invalid.detail, "JSON", "非法 JSON 原因");

    const homeActive = tempDir("home-bad-active");
    writeRootsConfig(homeActive, { roots: [root], active: "/other/root" });
    const activeReport = await runEnvChecks({
      root,
      deps: {
        runProc: basicProc,
        homedir: () => homeActive,
        gitSkillsDirs: [],
      },
    });
    const active = checkById(activeReport, "roots-config");
    assertEqual(active.status, "fail", "active 不属于 roots");
    assertIncludes(active.detail, "active", "active 原因");
  });

  await group("git-status: clean repo", async () => {
    const runProc = (argv) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --is-inside-work-tree") {
        return procResult(0, "true\n");
      }
      if (key === "git rev-parse --abbrev-ref HEAD") {
        return procResult(0, "main\n");
      }
      if (key === "git status --porcelain=v1 -z") {
        return procResult(0, "");
      }
      if (key === "git rev-list --left-right --count @{upstream}...HEAD") {
        return procResult(0, "0\t0\n");
      }
      if (
        key ===
        "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"
      ) {
        return procResult(0, "origin/main\n");
      }
      if (key.startsWith("git log ")) {
        return procResult(0, "abc123\t2026-01-02\tInitial commit\n");
      }
      return procResult(1, "", `unexpected: ${key}`);
    };
    const status = await readGitStatus("/virtual/clean", { runProc });
    assertEqual(status.kind, "repo", "kind");
    assertEqual(status.branch, "main", "branch");
    assertEqual(status.detached, false, "detached");
    assertEqual(status.upstream, "origin/main", "upstream");
    assertEqual(status.ahead, 0, "ahead");
    assertEqual(status.behind, 0, "behind");
    assertEqual(status.dirty.count, 0, "dirty count");
    assertEqual(status.dirty.files.length, 0, "dirty files");
    assertEqual(status.dirty.truncated, false, "dirty truncated");
    assertEqual(status.commits.length, 1, "commits");
    assertEqual(status.commits[0].hash, "abc123", "commit hash");
    assertEqual(status.commits[0].subject, "Initial commit", "commit subject");
    assertEqual(status.error, null, "error");
    assertEqual(typeof status.at, "number", "at");
  });

  await group("git-status: dirty rename entry", async () => {
    const runProc = (argv) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --is-inside-work-tree") {
        return procResult(0, "true\n");
      }
      if (key === "git rev-parse --abbrev-ref HEAD") {
        return procResult(0, "main\n");
      }
      if (key === "git status --porcelain=v1 -z") {
        return procResult(0, "R  old.txt\0new.txt\0 M tracked.md\0?? fresh.md\0");
      }
      if (key === "git rev-list --left-right --count @{upstream}...HEAD") {
        return procResult(0, "0\t0\n");
      }
      if (
        key ===
        "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"
      ) {
        return procResult(0, "origin/main\n");
      }
      if (key.startsWith("git log ")) {
        return procResult(0, "");
      }
      return procResult(1, "", `unexpected: ${key}`);
    };
    const status = await readGitStatus("/virtual/rename", { runProc });
    assertEqual(status.kind, "repo", "kind");
    assertEqual(status.dirty.count, 3, "rename 只计一个条目");
    assertEqual(status.dirty.files.length, 3, "文件数量");
    assertEqual(status.dirty.files[0].x, "R", "rename x");
    assertEqual(status.dirty.files[0].y, " ", "rename y");
    assertEqual(status.dirty.files[0].path, "old.txt", "rename path");
    assertEqual(status.dirty.files[1].path, "tracked.md", "第二个条目");
    assertEqual(status.dirty.files[2].x, "?", "untracked x");
    assert(
      status.dirty.files.every((file) => file.path !== "new.txt"),
      "重命名第二路径不应成为独立条目",
    );
  });

  await group("git-status: ahead and behind", async () => {
    const runProc = (argv) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --is-inside-work-tree") {
        return procResult(0, "true\n");
      }
      if (key === "git rev-parse --abbrev-ref HEAD") {
        return procResult(0, "feature\n");
      }
      if (key === "git status --porcelain=v1 -z") {
        return procResult(0, "");
      }
      if (key === "git rev-list --left-right --count @{upstream}...HEAD") {
        return procResult(0, "3\t5\n");
      }
      if (
        key ===
        "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"
      ) {
        return procResult(0, "origin/feature\n");
      }
      if (key.startsWith("git log ")) {
        return procResult(0, "");
      }
      return procResult(1, "", `unexpected: ${key}`);
    };
    const status = await readGitStatus("/virtual/diverged", { runProc });
    assertEqual(status.behind, 3, "behind");
    assertEqual(status.ahead, 5, "ahead");
    assertEqual(status.upstream, "origin/feature", "upstream");
  });

  await group("git-status: more than 200 dirty files", async () => {
    let output = "";
    for (let index = 0; index < 250; index += 1) {
      output += ` M file${index}.md\0`;
    }
    const runProc = (argv) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --is-inside-work-tree") {
        return procResult(0, "true\n");
      }
      if (key === "git rev-parse --abbrev-ref HEAD") {
        return procResult(0, "main\n");
      }
      if (key === "git status --porcelain=v1 -z") {
        return procResult(0, output);
      }
      if (key === "git rev-list --left-right --count @{upstream}...HEAD") {
        return procResult(0, "0\t0\n");
      }
      if (
        key ===
        "git rev-parse --abbrev-ref --symbolic-full-name @{upstream}"
      ) {
        return procResult(0, "origin/main\n");
      }
      if (key.startsWith("git log ")) {
        return procResult(0, "");
      }
      return procResult(1, "", `unexpected: ${key}`);
    };
    const status = await readGitStatus("/virtual/many-dirty", { runProc });
    assertEqual(status.dirty.count, 250, "总 dirty 数量");
    assertEqual(status.dirty.files.length, 200, "文件列表上限");
    assertEqual(status.dirty.truncated, true, "truncated");
    assertEqual(status.dirty.files[199].path, "file199.md", "最后一个保留项");
  });

  await group("git-status: not a repo", async () => {
    const runProc = () =>
      procResult(
        128,
        "",
        "fatal: not a git repository (or any of the parent directories): .git\n",
      );
    const status = await readGitStatus("/virtual/not-repo", { runProc });
    assertEqual(status.kind, "not-a-repo", "kind");
    assertEqual(status.branch, null, "branch");
    assertEqual(status.upstream, null, "upstream");
    assertEqual(status.dirty.count, 0, "dirty count");
    assertEqual(status.commits.length, 0, "commits");
    assertEqual(status.error, null, "error");
  });

  await group("git-status: timeout is error", async () => {
    const runProc = () => procResult(-1, "", "", true);
    const status = await readGitStatus("/virtual/timeout", { runProc });
    assertEqual(status.kind, "error", "kind");
    assertIncludes(status.error, "超时", "error 原因");
    assertEqual(status.dirty.count, 0, "dirty count");
  });

  await group("git-status: git missing", async () => {
    const runProc = () => procResult(-1, "", "spawn git ENOENT");
    const status = await readGitStatus("/virtual/no-git", { runProc });
    assertEqual(status.kind, "git-missing", "kind");
    assertIncludes(status.error, "未找到 git", "error 原因");
  });

  await group("tracker: URL safety", async () => {
    expectAllowed("https://api.github.com");
    const github = expectAllowed("https://api.github.com");
    assertEqual(github.hostname, "api.github.com", "GitHub host");
    expectAllowed("https://example.com");
    expectAllowed("http://example.com");
    expectAllowed("https://example.com:443");
    expectAllowed("https://example.com:65535");
    expectAllowed("https://[2001:4860:4860::8888]");
    expectAllowed("https://sub.example.com:8443/path?q=1");
    expectAllowed("https://example.com.");

    expectBlocked("javascript:alert(1)", "scheme");
    expectBlocked("file:///etc/passwd", "scheme");
    expectBlocked("ftp://example.com", "scheme");
    expectBlocked("https://user:pass@api.github.com", "credentials");
    expectBlocked("http://user@example.com", "credentials");

    expectBlocked("http://localhost", "private-address");
    expectBlocked("http://LOCALHOST", "private-address");
    expectBlocked("http://localhost.", "private-address");
    expectBlocked("http://foo.localhost", "private-address");
    expectBlocked("http://foo.local", "private-address");
    expectBlocked("http://foo.internal", "private-address");

    expectBlocked("http://127.0.0.1", "private-address");
    expectBlocked("http://127.1", "private-address");
    expectBlocked("http://2130706433", "private-address");
    expectBlocked("http://0x7f000001", "private-address");
    expectBlocked("http://10.0.0.5", "private-address");
    expectBlocked("http://172.16.0.1", "private-address");
    expectBlocked("http://192.168.1.1", "private-address");
    expectBlocked("http://169.254.169.254", "private-address");
    expectBlocked("http://0.0.0.0", "private-address");
    expectBlocked("http://100.64.1.1", "private-address");
    expectBlocked("http://192.0.0.1", "private-address");
    expectBlocked("http://198.19.0.1", "private-address");
    expectBlocked("http://224.0.0.1", "private-address");
    expectBlocked("http://240.0.0.1", "private-address");

    expectBlocked("http://[::1]", "private-address");
    expectBlocked("http://[::]", "private-address");
    expectBlocked("http://[fe80::1]", "private-address");
    expectBlocked("http://[fc00::1]", "private-address");
    expectBlocked("http://[::ffff:127.0.0.1]", "private-address");
    expectBlocked("http://[::127.0.0.1]", "private-address");
    expectBlocked("http://[2002:7f00:1::]", "private-address");

    expectBlocked("http://example.com:0", "port");
    expectBlocked("http://example.com:65536", "port");
    expectBlocked("https://example.com:99999", "port");
    expectBlocked("http://[::1]:99999", "port");
  });

  await group("tracker: GitHub unauthenticated makes no network call", async () => {
    const savedGithub = process.env.GITHUB_TOKEN;
    const savedGh = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    let calls = 0;
    try {
      const tracker = createTracker({
        kind: "github",
        repo: "octo/demo",
        token: undefined,
        fetchImpl: async () => {
          calls += 1;
          throw new Error("fetch 不应被调用");
        },
        now: () => 1700000000000,
        sleep: async () => {},
        minIntervalMs: 0,
      });
      const snapshot = await tracker.refresh();
      assertEqual(snapshot.status, "unauthenticated", "status");
      assertEqual(calls, 0, "fetch 调用次数");
      assertEqual(snapshot.issues.length, 0, "issues");
      assertEqual(snapshot.prs.length, 0, "prs");
      assertEqual(snapshot.fetchedAt, null, "fetchedAt");
      assertIncludes(snapshot.detail, "GITHUB_TOKEN", "认证提示");
      const issues = await tracker.listIssues();
      assertEqual(issues.length, 0, "listIssues");
      assertEqual(calls, 0, "listIssues 不触发网络");
    } finally {
      if (savedGithub === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = savedGithub;
      }
      if (savedGh === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = savedGh;
      }
    }
  });

  await group("tracker: GitHub success mapping", async () => {
    const token = "test-token-not-real";
    const now = 1700000000000;
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.includes("/issues?")) {
        return jsonResponse(200, [
          {
            id: 1,
            number: 1,
            title: "Bug report",
            state: "open",
            labels: [{ name: "bug" }, "help wanted"],
            html_url: "https://github.com/octo/demo/issues/1",
            updated_at: "2026-01-01T00:00:00Z",
          },
          {
            id: 2,
            number: 2,
            title: "A pull request in issues",
            state: "open",
            labels: [],
            html_url: "https://github.com/octo/demo/pull/2",
            pull_request: { url: "https://api.github.com/repos/octo/demo/pulls/2" },
            updated_at: "2026-01-05T00:00:00Z",
          },
        ]);
      }
      if (url.includes("/pulls?")) {
        return jsonResponse(200, [
          {
            id: 3,
            number: 3,
            title: "Feature work",
            state: "closed",
            merged_at: "2026-01-03T00:00:00Z",
            draft: false,
            labels: [{ name: "enhancement" }],
            html_url: "https://github.com/octo/demo/pull/3",
            updated_at: "2026-01-03T00:00:00Z",
            head: { ref: "feature/work" },
            checks: "success",
          },
        ]);
      }
      if (url.includes("/comments?")) {
        return jsonResponse(200, [
          {
            user: { login: "alice" },
            created_at: "2026-01-04T00:00:00Z",
            body: "Looks good",
          },
        ]);
      }
      return jsonResponse(404, { message: "not found" });
    };

    const tracker = createTracker({
      kind: "github",
      repo: "octo/demo",
      token,
      fetchImpl,
      now: () => now,
      sleep: async () => {},
      minIntervalMs: 0,
    });
    const snapshot = await tracker.refresh();

    assertEqual(tracker.kind, "github", "tracker.kind");
    assertEqual(snapshot.status, "ready", "status");
    assertEqual(snapshot.fetchedAt, now, "fetchedAt");
    assertEqual(snapshot.issues.length, 1, "issues 数量");
    assertEqual(snapshot.issues[0].id, 1, "issue id");
    assertEqual(snapshot.issues[0].title, "Bug report", "issue title");
    assertEqual(snapshot.issues[0].state, "open", "issue state");
    assertEqual(
      JSON.stringify(snapshot.issues[0].labels),
      JSON.stringify(["bug", "help wanted"]),
      "issue labels",
    );
    assertEqual(
      snapshot.issues[0].url,
      "https://github.com/octo/demo/issues/1",
      "issue url",
    );
    assertEqual(
      snapshot.issues[0].updatedAt,
      "2026-01-01T00:00:00Z",
      "issue updatedAt",
    );
    assertEqual(snapshot.prs.length, 1, "prs 数量");
    assertEqual(snapshot.prs[0].state, "merged", "pr state");
    assertEqual(snapshot.prs[0].draft, false, "pr draft");
    assertEqual(snapshot.prs[0].branch, "feature/work", "pr branch");
    assertEqual(snapshot.prs[0].checks, "success", "pr checks");
    assertEqual(calls.length, 2, "请求次数");
    assertEqual(new URL(calls[0].url).hostname, "api.github.com", "请求 host");
    assertEqual(calls[0].init.redirect, "manual", "redirect manual");
    assertEqual(
      calls[0].init.headers.Authorization,
      `Bearer ${token}`,
      "Authorization 头",
    );
    assertEqual(
      calls[0].init.headers.Accept,
      "application/vnd.github+json",
      "Accept 头",
    );
    assertEqual(
      calls[0].init.headers["X-GitHub-Api-Version"],
      "2022-11-28",
      "API 版本头",
    );
    assert(calls[0].init.signal instanceof AbortSignal, "请求 signal");
    assert(!JSON.stringify(snapshot).includes(token), "快照泄露 token");
    assert(!snapshot.detail.includes(token), "详情泄露 token");
    assertEqual((await tracker.getIssue(1)).title, "Bug report", "getIssue");
    assertEqual((await tracker.listIssues()).length, 1, "listIssues");
    assertEqual((await tracker.listPRs()).length, 1, "listPRs");
    const comments = await tracker.getComments(1);
    assertEqual(comments.length, 1, "getComments 数量");
    assertEqual(comments[0].who, "alice", "comment who");
    assertEqual(comments[0].at, "2026-01-04T00:00:00Z", "comment at");
    assertEqual(comments[0].body, "Looks good", "comment body");
  });

  await group("tracker: rate limited", async () => {
    const token = "test-token-not-real";
    const now = 1700000000000;
    let calls = 0;
    const tracker = createTracker({
      kind: "github",
      repo: "octo/demo",
      token,
      fetchImpl: async () => {
        calls += 1;
        return {
          status: 429,
          ok: false,
          headers: {
            "x-ratelimit-remaining": "0",
            "retry-after": "30",
          },
        };
      },
      now: () => now,
      sleep: async () => {},
      minIntervalMs: 0,
    });
    const snapshot = await tracker.refresh();
    assertEqual(snapshot.status, "rate-limited", "status");
    assertEqual(calls, 1, "不做重试");
    assertIncludes(snapshot.detail, "速率受限", "详情");
    assertIncludes(
      snapshot.detail,
      new Date(now + 30000).toISOString(),
      "恢复时间",
    );
    assert(!snapshot.detail.includes(token), "详情泄露 token");
    assertEqual(snapshot.issues.length, 0, "issues");
  });

  await group("tracker: GitHub auth errors", async () => {
    const baseOptions = {
      kind: "github",
      repo: "octo/demo",
      token: "test-token-not-real",
      now: () => 1700000000000,
      sleep: async () => {},
      minIntervalMs: 0,
    };
    const unauthorized = createTracker({
      ...baseOptions,
      fetchImpl: async () => ({ status: 401, ok: false, headers: {} }),
    });
    const unauthorizedSnapshot = await unauthorized.refresh();
    assertEqual(unauthorizedSnapshot.status, "unauthenticated", "401 status");
    assertIncludes(unauthorizedSnapshot.detail, "401", "401 详情");

    const forbidden = createTracker({
      ...baseOptions,
      fetchImpl: async () => ({ status: 403, ok: false, headers: {} }),
    });
    const forbiddenSnapshot = await forbidden.refresh();
    assertEqual(forbiddenSnapshot.status, "error", "403 status");
    assertIncludes(forbiddenSnapshot.detail, "403", "403 详情");

    const token = baseOptions.token;
    const leaking = createTracker({
      ...baseOptions,
      fetchImpl: async () => {
        throw new Error(`request failed with Bearer ${token}`);
      },
    });
    const leakingSnapshot = await leaking.refresh();
    assertEqual(leakingSnapshot.status, "error", "网络错误状态");
    assert(!leakingSnapshot.detail.includes(token), "错误详情泄露 token");
  });

  await group("tracker: invalid repo", async () => {
    const tracker = createTracker({
      kind: "github",
      repo: "not-a-repo",
      token: "test-token-not-real",
      fetchImpl: async () => {
        throw new Error("fetch 不应被调用");
      },
      now: () => 1700000000000,
      sleep: async () => {},
      minIntervalMs: 0,
    });
    const snapshot = await tracker.refresh();
    assertEqual(snapshot.status, "error", "status");
    assertEqual(snapshot.detail, "repo 参数非法", "detail");
    assertEqual(snapshot.issues.length, 0, "issues");
  });

  await group("tracker: redirect is not followed", async () => {
    let calls = 0;
    const tracker = createTracker({
      kind: "github",
      repo: "octo/demo",
      token: "test-token-not-real",
      fetchImpl: async () => {
        calls += 1;
        return {
          status: 302,
          ok: false,
          headers: { location: "https://evil.example/steal" },
        };
      },
      now: () => 1700000000000,
      sleep: async () => {},
      minIntervalMs: 0,
    });
    const snapshot = await tracker.refresh();
    assertEqual(snapshot.status, "error", "status");
    assertEqual(calls, 1, "未跟随重定向");
    assertIncludes(snapshot.detail, "302", "状态码");
    assertIncludes(snapshot.detail, "拒绝跟随", "拒绝说明");
  });

  await group("tracker: body over 2MB rejected", async () => {
    let reads = 0;
    let fetches = 0;
    const body = {
      getReader() {
        return {
          async read() {
            reads += 1;
            if (reads <= 3) {
              return { done: false, value: new Uint8Array(1024 * 1024) };
            }
            return { done: true, value: undefined };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    };
    const tracker = createTracker({
      kind: "github",
      repo: "octo/demo",
      token: "test-token-not-real",
      fetchImpl: async () => {
        fetches += 1;
        return { status: 200, ok: true, headers: {}, body };
      },
      now: () => 1700000000000,
      sleep: async () => {},
      minIntervalMs: 0,
    });
    const snapshot = await tracker.refresh();
    assertEqual(snapshot.status, "error", "status");
    assertEqual(fetches, 1, "请求次数");
    assert(reads >= 3, "读取到超限");
    assertIncludes(snapshot.detail, "2MB", "上限说明");
    assertEqual(snapshot.issues.length, 0, "issues");
  });

  await group("tracker: GitLab unsupported", async () => {
    let fetchCalls = 0;
    const tracker = createTracker({
      kind: "gitlab",
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch 不应被调用");
      },
    });
    const snapshot = await tracker.refresh();
    assertEqual(tracker.kind, "gitlab", "kind");
    assertEqual(snapshot.kind, "gitlab", "snapshot.kind");
    assertEqual(snapshot.status, "unsupported", "status");
    assertEqual(snapshot.detail, "GitLab 只读接入尚未实现", "detail");
    assertEqual(snapshot.issues.length, 0, "issues");
    assertEqual(snapshot.prs.length, 0, "prs");
    assertEqual(snapshot.fetchedAt, null, "fetchedAt");
    assertEqual(fetchCalls, 0, "fetch 调用次数");
    assertEqual((await tracker.listIssues()).length, 0, "listIssues");
    assertEqual(await tracker.getIssue(1), null, "getIssue");
    assertEqual((await tracker.listPRs()).length, 0, "listPRs");
    assertEqual((await tracker.getComments(1)).length, 0, "getComments");
  });

  await group("tracker: local cards", async () => {
    const root = tempDir("local-root");
    createCard(
      root,
      "007-demo.md",
      [
        "---",
        "title: Demo Card",
        "status: closed",
        'labels: [bug, "needs review"]',
        "updated: 2026-02-03",
        "---",
        "# Demo Card",
        "",
      ].join("\n"),
    );
    const tracker = createTracker({ kind: "local", root });
    const snapshot = await tracker.refresh();
    assertEqual(snapshot.kind, "local", "kind");
    assertEqual(snapshot.status, "ready", "status");
    assertEqual(snapshot.issues.length, 1, "issue 数量");
    assertEqual(snapshot.issues[0].id, 7, "issue id");
    assertEqual(snapshot.issues[0].title, "Demo Card", "issue title");
    assertEqual(snapshot.issues[0].state, "closed", "issue state");
    assertEqual(
      JSON.stringify(snapshot.issues[0].labels),
      JSON.stringify(["bug", "needs review"]),
      "issue labels",
    );
    assertEqual(snapshot.issues[0].updatedAt, "2026-02-03", "updatedAt");
    assert(typeof snapshot.fetchedAt === "number", "fetchedAt");
    assertEqual((await tracker.getIssue(7)).title, "Demo Card", "getIssue");
    assertEqual((await tracker.listIssues()).length, 1, "listIssues");
    assertEqual((await tracker.listPRs()).length, 0, "listPRs");
    assertEqual((await tracker.getComments(7)).length, 0, "getComments");

    const missingRoot = path.join(BASE, "local-without-scratch");
    fs.mkdirSync(missingRoot, { recursive: true });
    const missing = createTracker({ kind: "local", root: missingRoot });
    const missingSnapshot = await missing.refresh();
    assertEqual(missingSnapshot.status, "error", "缺少 .scratch");
    assertIncludes(missingSnapshot.detail, ".scratch", "缺少 .scratch 详情");
    assertEqual(missingSnapshot.fetchedAt, null, "缺少 .scratch fetchedAt");
  });

  fs.rmSync(BASE, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`${failures} 个断言组失败`);
    process.exitCode = 1;
  } else {
    console.log("全部断言组通过");
  }
})().catch((error) => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true });
  } catch {
    // 清理失败不覆盖原始异常。
  }
  const message = String(error && error.message ? error.message : error)
    .replace(/\s+/g, " ")
    .slice(0, 300);
  console.log(`FAIL 测试入口: ${message}`);
  process.exitCode = 1;
});

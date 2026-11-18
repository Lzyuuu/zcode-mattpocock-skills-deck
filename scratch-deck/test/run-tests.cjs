#!/usr/bin/env node
/* 全部测试的唯一入口：node test/run-tests.cjs [--only loader,overlay]
 * 每个套件独立进程跑（环境变量、临时目录、watcher 互不污染），失败时回放尾部输出。 */
"use strict";
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SUITES = [
  { name: "loader", cmd: "node", args: ["test/test-loader.cjs"], what: "三态/滞回/watcher/注入/动作" },
  { name: "overlay", cmd: "node", args: ["test/test-overlay.cjs"], what: "composer 选择/pane/销毁/渲染" },
  { name: "data-plane", cmd: "node", args: ["test/test-data-plane.cjs"], what: "环境检查/git/tracker URL 安全" },
  { name: "patch-install", cmd: "python3", args: ["test/test_patch_install.py"], what: "asar 注入/剥离/恶意 header/runtime" },
  { name: "hook", cmd: "python3", args: ["test/test_hook.py"], what: "SessionStart 宿主判定/opt-out/注入提示" },
  { name: "dist", cmd: "node", args: ["test/test-dist.cjs"], what: "workspace/镜像/cache 逐字节一致" },
];

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? String(process.argv[onlyArg + 1] || "").split(",").filter(Boolean) : null;
const suites = only ? SUITES.filter((s) => only.includes(s.name)) : SUITES;
if (!suites.length) {
  console.error("没有匹配的套件：" + (only || []).join(",") + "（可选：" + SUITES.map((s) => s.name).join(",") + "）");
  process.exit(2);
}

const results = [];
const SUITE_TIMEOUT_MS = 180000;
for (const suite of suites) {
  const started = Date.now();
  process.stdout.write("\n=== " + suite.name + " · " + suite.what + " ===\n");
  const res = spawnSync(suite.cmd, suite.args, {
    cwd: ROOT, encoding: "utf8", timeout: SUITE_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const ms = Date.now() - started;
  const timedOut = res.signal === "SIGKILL" || (res.error && res.error.code === "ETIMEDOUT");
  const out = (res.stdout || "") + (res.stderr || "");
  const passed = !timedOut && res.status === 0;
  results.push({ name: suite.name, passed, ms, status: timedOut ? "timeout" : res.status, out });
  process.stdout.write(out);
  process.stdout.write("\n-> " + (passed ? "PASS" : (timedOut ? "TIMEOUT" : "FAIL")) + " (" + ms + "ms)\n");
}

const failed = results.filter((r) => !r.passed);
console.log("\n================ 汇总 ================");
for (const r of results) console.log((r.passed ? "PASS" : "FAIL") + "  " + r.name + "  " + r.ms + "ms");
if (failed.length) {
  console.log("\n失败套件：");
  for (const r of failed) {
    console.log("\n--- " + r.name + " (exit " + r.status + ") 尾部输出 ---");
    console.log(r.out.trim().split("\n").slice(-25).join("\n"));
  }
  console.log("\n注意：这些是本地静态/自动化测试，不等于真机验证。");
  process.exit(1);
}
console.log("\n全部通过。真机验收步骤见 README「真机验收」。");

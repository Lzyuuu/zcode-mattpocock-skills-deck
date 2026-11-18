#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook 的行为测试：宿主判定、opt-out、注入状态提示、失败不抛。

直接 import hook 模块并调用 main()，不起子进程、不拼命令行。
用合成的 asar 副本与临时 runtime，绝不读写真机 asar，也不碰 ~/.zcode。
"""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import patch_install as pi  # noqa: E402
from test_patch_install import build_asar  # noqa: E402

HOOK = ROOT / "hooks" / "session-start.py"


def load_hook():
    """每次重新导入：RUNTIME_DIR 是模块级常量，必须按当前环境重算。"""
    spec = importlib.util.spec_from_file_location("sd_session_start_under_test", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.runtime = self.dir / "runtime-home"
        self.asar = build_asar(self.dir / "app.asar", {
            "/out/main/index.js": b"main();\n",
            "/package.json": b'{"name":"zcode"}',
        })
        self.env = {
            "HOME": str(self.dir),
            "SCRATCH_DECK_RUNTIME": str(self.runtime),
            "SCRATCH_DECK_ASAR": str(self.asar),
            "ZCODE_PLUGIN_ROOT": str(ROOT),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload=None, extra_env=None):
        saved = dict(os.environ)
        os.environ.update(self.env)
        os.environ.update(extra_env or {})
        out, err = io.StringIO(), io.StringIO()
        fake_stdin = io.StringIO(json.dumps(payload or {}))
        saved_stdin = sys.stdin
        try:
            sys.stdin = fake_stdin
            mod = load_hook()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = mod.main()
        finally:
            sys.stdin = saved_stdin
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual(code, 0, err.getvalue())
        text = out.getvalue().strip()
        self.assertTrue(text, "hook 必须输出 JSON")
        return json.loads(text)

    def record(self):
        return json.loads((self.runtime / "plugin-session-start.json").read_text("utf-8"))

    def test_non_zcode_host_does_nothing(self):
        out = self.run_hook(extra_env={"ZCODE_PLUGIN_ROOT": "", "ZCODE_SESSION_ID": ""})
        self.assertTrue(out.get("suppressOutput"))
        self.assertNotIn("systemMessage", out)
        self.assertFalse((self.runtime / "plugin-session-start.json").exists())

    def test_uninjected_asar_reports_install_step(self):
        out = self.run_hook()
        self.assertIn("/install-overlay", out.get("systemMessage", ""))
        rec = self.record()
        self.assertTrue(rec["asar"]["exists"])
        self.assertFalse(rec["asar"]["injected"])
        self.assertIn("runtime", rec)

    def test_injected_with_stale_url_is_reported(self):
        entry = (b"main();\n\n/* scratch-deck-begin */\n"
                 b"import('file:///tmp/old/src/deck-loader.cjs');\n"
                 b"/* scratch-deck-end */\n")
        self.asar = build_asar(self.dir / "stale.asar", {
            "/out/main/index.js": entry, "/package.json": b'{"name":"zcode"}',
        })
        self.env["SCRATCH_DECK_ASAR"] = str(self.asar)
        out = self.run_hook()
        self.assertIn("旧路径", out.get("systemMessage", ""))

    def test_injected_with_expected_url_is_quiet(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pi.main(["install", "--asar", str(self.asar),
                                      "--runtime-dir", str(self.runtime)]), 0)
        out = self.run_hook()
        self.assertTrue(out.get("suppressOutput"))
        self.assertNotIn("systemMessage", out, out)

    def test_opt_out_suppresses_everything(self):
        self.runtime.mkdir(parents=True, exist_ok=True)
        (self.runtime / ".opted-out").write_text("2026-11-18T00:00:00+00:00\n", "utf-8")
        out = self.run_hook()
        self.assertTrue(out.get("suppressOutput"))
        self.assertNotIn("systemMessage", out)
        self.assertEqual(self.record().get("skipped"), "opted-out")

    def test_missing_asar_is_reported_not_raised(self):
        self.env["SCRATCH_DECK_ASAR"] = str(self.dir / "nope.asar")
        out = self.run_hook()
        self.assertTrue(out.get("suppressOutput"))
        self.assertTrue(self.record()["asar"]["error"])
        self.assertIn("注入检查失败", out.get("systemMessage", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)

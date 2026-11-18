#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""patch_install.py 的离线测试：只用临时目录里的合成 asar，绝不触碰真机 asar。

覆盖：正常 install / 重复 install 幂等 / remove 后逐字节还原 / 与其它工具注入共存 /
恶意 header（越界名字、越界区间）/ 非法 --asar / stage 落盘失败不改动原包 /
loader 缺失 / runtime 手工改动保护。
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
sys.path.insert(0, str(SRC))

import patch_install as pi  # noqa: E402
import runtime_sync  # noqa: E402

ALIGN = 4


def _header_bytes(files: dict) -> bytes:
    return json.dumps({"files": files}, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")


def build_asar(path: Path, entries: dict[str, bytes], raw_names: list[str] | None = None) -> Path:
    """按官方布局写一个合成 asar。raw_names 用于塞入恶意名字（跳过合法性构造）。"""
    root: dict = {"files": {}}
    payload = []
    offset = 0
    for full, data in entries.items():
        parts = [p for p in full.split("/") if p]
        node = root
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(offset)}
        payload.append(data)
        offset += len(data)
    for name in raw_names or []:
        root["files"][name] = {"size": 0, "offset": "0"}
    header = _header_bytes(root["files"])
    d = len(header)
    c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
    with open(path, "wb") as f:
        f.write(struct.pack("<4I", 4, c + 4, c, d))
        f.write(header)
        f.write(b"\0" * (c - d - 4))
        f.write(b"".join(payload))
    return path


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def call(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = pi.main(argv)
    return code, out.getvalue(), err.getvalue()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.runtime = self.dir / "runtime-home"
        self.entry = b"var app=require('electron').app;\napp.whenReady().then(()=>{});\n"
        self.files = {
            "/out/main/index.js": self.entry,
            "/package.json": b'{"name":"zcode","main":"out/main/index.js"}',
            "/node_modules/x/index.js": b"module.exports=1;\n",
        }
        self.asar = build_asar(self.dir / "app.asar", self.files)

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, *extra):
        return call(["install", "--asar", str(self.asar),
                     "--runtime-dir", str(self.runtime), *extra])

    def remove(self, *extra):
        return call(["remove", "--asar", str(self.asar),
                     "--runtime-dir", str(self.runtime), *extra])

    def status(self, *extra):
        return call(["status", "--asar", str(self.asar),
                     "--runtime-dir", str(self.runtime), *extra])


class InstallRoundTrip(Base):
    def test_status_reports_not_injected(self):
        code, out, _ = self.status()
        self.assertEqual(code, 0)
        self.assertIn("未注入", out)

    def test_install_then_status_then_remove_restores_bytes(self):
        original = sha(self.asar)
        code, out, err = self.install()
        self.assertEqual(code, 0, err)
        self.assertIn("已注入", out)
        self.assertNotEqual(sha(self.asar), original)

        entry = pi.entry_bytes(self.asar)
        self.assertTrue(entry.startswith(self.entry))
        self.assertEqual(len(pi.BLOCK_RE.findall(entry)), 1)
        url = pi.URL_RE.search(pi.BLOCK_RE.findall(entry)[0]).group(1).decode()
        self.assertEqual(url, (self.runtime / "runtime/src/deck-loader.cjs").as_uri())
        self.assertTrue((self.runtime / "runtime/src/deck-loader.cjs").is_file())

        code, out, _ = self.status()
        self.assertEqual(code, 0)
        self.assertIn("已注入", out)

        code, out, err = self.remove()
        self.assertEqual(code, 0, err)
        self.assertEqual(sha(self.asar), original, "remove 必须逐字节还原")
        self.assertEqual(pi.entry_bytes(self.asar), self.entry)

    def test_install_is_idempotent(self):
        self.assertEqual(self.install()[0], 0)
        first = sha(self.asar)
        code, out, _ = self.install()
        self.assertEqual(code, 0)
        self.assertEqual(sha(self.asar), first, "重复 install 不应改动 asar")
        self.assertIn("已是最新注入", out)

    def test_remove_when_clean_is_noop(self):
        before = sha(self.asar)
        code, out, _ = self.remove()
        self.assertEqual(code, 0)
        self.assertIn("无需卸载", out)
        self.assertEqual(sha(self.asar), before)

    def test_repack_keeps_other_files_intact(self):
        self.assertEqual(self.install()[0], 0)
        with open(self.asar, "rb") as f:
            header, base = pi.read_header(f, self.asar.stat().st_size)
            nodes = dict(pi.iter_files(header))
            node = nodes["/package.json"]
            f.seek(base + int(node["offset"]))
            self.assertEqual(f.read(node["size"]), self.files["/package.json"])
        self.assertNotIn(".scratch-deck-", "".join(os.listdir(self.dir)))


class Coexistence(Base):
    def test_keeps_other_tool_injection(self):
        other = self.entry + b"\n/* zusage-begin */\nimport('file:///tmp/other/loader.cjs');\n/* zusage-end */\n"
        self.asar = build_asar(self.dir / "app2.asar",
                               {**self.files, "/out/main/index.js": other})
        self.assertEqual(self.install()[0], 0)
        entry = pi.entry_bytes(self.asar)
        self.assertIn(b"zusage-begin", entry)
        self.assertIn(b"file:///tmp/other/loader.cjs", entry)
        self.assertEqual(self.remove()[0], 0)
        self.assertEqual(pi.entry_bytes(self.asar), other)


class MaliciousHeader(Base):
    def _expect_error(self, asar: Path):
        before = sha(asar)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pi.main(["status", "--asar", str(asar),
                            "--runtime-dir", str(self.runtime)])
        self.assertEqual(code, 1, "status 应报错而不是崩溃")
        self.assertIn("[error]", err.getvalue())
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pi.main(["install", "--asar", str(asar),
                            "--runtime-dir", str(self.runtime)])
        self.assertEqual(code, 1)
        self.assertIn("[error]", err.getvalue())
        self.assertEqual(sha(asar), before, "失败路径不得改动 asar")

    def test_dotdot_name_rejected(self):
        bad = build_asar(self.dir / "bad1.asar", self.files, raw_names=["../evil.js"])
        self._expect_error(bad)

    def test_absolute_name_rejected(self):
        bad = build_asar(self.dir / "bad2.asar", self.files, raw_names=["/etc/passwd"])
        self._expect_error(bad)

    def test_dot_name_rejected(self):
        bad = build_asar(self.dir / "bad3.asar", self.files, raw_names=[".."])
        self._expect_error(bad)

    def test_empty_name_rejected(self):
        bad = build_asar(self.dir / "bad4.asar", self.files, raw_names=[""])
        self._expect_error(bad)

    def test_out_of_range_offset_rejected(self):
        bad = build_asar(self.dir / "bad5.asar", self.files)
        with open(bad, "rb") as f:
            header, base = pi.read_header(f, bad.stat().st_size)
        node = header["files"]["out"]["files"]["main"]["files"]["index.js"]
        node["offset"] = "999999999"
        header_bytes = _header_bytes(header["files"])
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        with open(bad, "wb") as f:
            f.write(struct.pack("<4I", 4, c + 4, c, d))
            f.write(header_bytes)
            f.write(b"\0" * (c - d - 4))
            f.write(self.entry)
        self._expect_error(bad)

    def test_negative_size_rejected(self):
        bad = build_asar(self.dir / "bad6.asar", self.files)
        with open(bad, "rb") as f:
            header, _ = pi.read_header(f, bad.stat().st_size)
        header["files"]["out"]["files"]["main"]["files"]["index.js"]["size"] = "-5"
        header_bytes = _header_bytes(header["files"])
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        with open(bad, "wb") as f:
            f.write(struct.pack("<4I", 4, c + 4, c, d))
            f.write(header_bytes)
            f.write(b"\0" * (c - d - 4))
            f.write(self.entry)
        self._expect_error(bad)

    def test_modify_key_traversal_rejected(self):
        out = self.dir / "stage.bin"
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, {"/../escape": b"x"}, out)
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, {"/out/../../escape": b"x"}, out)
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, {"/nope": b"x"}, out)


class RepackTargetGuard(Base):
    """repack 的目标路径边界（Mimosa 在 line 194 报的就是这里）。"""

    def _good(self):
        return {"/out/main/index.js": b"x"}

    def test_target_outside_source_dir_rejected(self):
        outside = self.dir / "sub"
        outside.mkdir()
        with self.assertRaises(pi.AsarError) as ctx:
            pi.repack(self.asar, self._good(), outside / "stage.bin")
        self.assertIn("同目录", str(ctx.exception))

    def test_existing_target_rejected(self):
        existing = self.dir / "already.bin"
        existing.write_bytes(b"keep me")
        with self.assertRaises(pi.AsarError) as ctx:
            pi.repack(self.asar, self._good(), existing)
        self.assertIn("拒绝覆盖", str(ctx.exception))
        self.assertEqual(existing.read_bytes(), b"keep me")

    def test_symlink_target_rejected(self):
        target = self.dir / "sym.bin"
        target.symlink_to(self.dir / "elsewhere.bin")
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, self._good(), target)
        self.assertFalse((self.dir / "elsewhere.bin").exists())

    def test_dotdot_target_rejected(self):
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, self._good(), self.dir / ".." / "escape.bin")

    def test_relative_target_uses_cwd(self):
        # 相对路径按 cwd 解析；不在源目录就拒绝，绝不"就地写"
        with self.assertRaises(pi.AsarError):
            pi.repack(self.asar, self._good(), Path("stage.bin"))


class InvalidAsarArgument(Base):
    def test_missing_file(self):
        code, _, err = call(["status", "--asar", str(self.dir / "nope.asar")])
        self.assertEqual(code, 1)
        self.assertIn("不可解析", err)

    def test_directory(self):
        code, _, err = call(["status", "--asar", str(self.dir)])
        self.assertEqual(code, 1)
        self.assertIn("不可解析", err) if "不可解析" in err else self.assertIn("不是普通文件", err)

    def test_tiny_file(self):
        tiny = self.dir / "tiny.asar"
        tiny.write_bytes(b"\x04\x00\x00\x00")
        code, _, err = call(["status", "--asar", str(tiny)])
        self.assertEqual(code, 1)

    def test_symlink_to_asar_is_resolved(self):
        link = self.dir / "link.asar"
        link.symlink_to(self.asar)
        code, out, err = call(["status", "--asar", str(link),
                               "--runtime-dir", str(self.runtime)])
        self.assertEqual(code, 0, err)
        self.assertIn("未注入", out, "status 走的是解析后的真实文件")
        code, out, err = call(["install", "--asar", str(link),
                               "--runtime-dir", str(self.runtime)])
        self.assertEqual(code, 0, err)
        self.assertTrue(link.is_symlink())
        self.assertEqual(len(pi.BLOCK_RE.findall(pi.entry_bytes(self.asar))), 1,
                         "注入落在最终目标文件上，不是链接本身")


class FailurePaths(Base):
    def test_stage_failure_leaves_asar_untouched(self):
        before = sha(self.asar)
        original = pi.rewrite_entry

        def boom(*_a, **_k):
            raise pi.AsarError("模拟 stage 写入失败")

        pi.rewrite_entry = boom
        try:
            code, _, err = self.install()
        finally:
            pi.rewrite_entry = original
        self.assertEqual(code, 1)
        self.assertIn("模拟", err)
        self.assertEqual(sha(self.asar), before)
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.startswith(".")], [])

    def test_missing_loader_in_plugin_dir(self):
        empty = self.dir / "empty-plugin"
        (empty / "src").mkdir(parents=True)
        original = pi.PLUGIN_DIR
        pi.PLUGIN_DIR = empty
        try:
            code, _, err = self.install()
        finally:
            pi.PLUGIN_DIR = original
        self.assertEqual(code, 1)
        self.assertIn("loader", err)

    def test_hand_edited_runtime_file_is_not_overwritten(self):
        self.assertEqual(self.install()[0], 0)
        target = self.runtime / "runtime/src/deck-overlay.js"
        target.write_text("// 用户手改\n", "utf-8")
        code, _, err = self.install()
        self.assertEqual(code, 1)
        self.assertIn("deck-overlay.js", err)
        self.assertEqual(target.read_text("utf-8"), "// 用户手改\n")
        code, _, err = self.install("--force")
        self.assertEqual(code, 0, err)
        self.assertNotEqual(target.read_text("utf-8"), "// 用户手改\n")


class OptOut(Base):
    def test_remove_writes_opt_out_and_install_clears_it(self):
        marker = self.runtime / ".opted-out"
        self.assertEqual(self.install()[0], 0)
        self.assertFalse(marker.exists(), "install 不该留下 opt-out 标记")
        self.assertEqual(self.remove()[0], 0)
        self.assertTrue(marker.is_file(), "remove 必须写 opt-out，阻止自动重装")
        self.assertEqual(self.install()[0], 0)
        self.assertFalse(marker.exists(), "显式 install 应清掉 opt-out")


class RuntimeSync(Base):
    def test_sync_is_idempotent_and_records_manifest(self):
        first = runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertTrue(first["created"])
        manifest = json.loads((self.runtime / "manifest.json").read_text("utf-8"))
        self.assertEqual(manifest["schema"], 1)
        self.assertTrue(manifest["files"])
        mtime = (self.runtime / "manifest.json").stat().st_mtime_ns
        second = runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertEqual(second["created"], [])
        self.assertEqual(second["updated"], [])
        self.assertTrue(second["unchanged"])
        self.assertEqual((self.runtime / "manifest.json").stat().st_mtime_ns, mtime)

    def test_verify_reports_drift(self):
        runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertTrue(runtime_sync.verify_runtime(pi.PLUGIN_DIR, self.runtime)["inSync"])
        (self.runtime / "runtime/src/deck-loader.cjs").write_text("x", "utf-8")
        report = runtime_sync.verify_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertFalse(report["inSync"])
        self.assertIn("src/deck-loader.cjs", report["stale"])

    def test_deleted_source_file_is_pruned(self):
        runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        manifest = json.loads((self.runtime / "manifest.json").read_text("utf-8"))
        manifest["files"]["docs/removed.md"] = "0" * 64
        (self.runtime / "manifest.json").write_text(json.dumps(manifest), "utf-8")
        target = self.runtime / "runtime/docs/removed.md"
        target.write_text("gone", "utf-8")
        result = runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertIn("docs/removed.md", result["removed"])
        self.assertFalse(target.exists())

    def test_runtime_outputs_are_never_pruned(self):
        runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        logs = self.runtime / "logs/loader.log"
        logs.parent.mkdir(parents=True, exist_ok=True)
        logs.write_text("keep", "utf-8")
        runtime_sync.sync_runtime(pi.PLUGIN_DIR, self.runtime)
        self.assertTrue(logs.is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)

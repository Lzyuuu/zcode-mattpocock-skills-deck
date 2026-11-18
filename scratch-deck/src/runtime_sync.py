#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""稳定 runtime 同步：把插件包内容镜像到 ~/.zcode/scratch-deck/runtime/。

为什么需要这一层：app.asar 里注入的是 file:// URL。若该 URL 指向插件市场缓存
（…/cache/dev-scratch-deck/scratch-deck/0.1.0/…）或草稿工作区，一次重装、一次
版本 bump、一次目录改名就留下悬空 import —— 客户端照常启动，只是状态行永远不出现。
runtime 目录因此是注入的唯一目标，也是唯一需要看"是否是同一份代码"的地方。

约束：
  * 幂等：内容 hash 相同则跳过，重复执行不产生写动作（mtime 不变）。
  * 不覆盖用户手改：同步前比对目标 hash，若目标既非 manifest 记录的版本、也与源
    不一致，说明被手工改过，默认跳过该文件并报 conflicts（--force 才覆盖）。
  * 只删自己写过的文件：prune 的依据是上一份 manifest，绝不整目录删除。
  * 日志/诊断/opt-out 标记不参与同步，永不删除。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
DEFAULT_RUNTIME_DIR = Path.home() / ".zcode" / "scratch-deck"
MANIFEST_NAME = "manifest.json"

# 随包清单与分发脚本共用 package-files.json：两份 glob 各写各的迟早会漏文件
# （cache 0.1.0 就漏了 deck-prompts.js、prompts/、scripts/）。
PACKAGE_MANIFEST = Path(__file__).resolve().parent.parent / "package-files.json"
# runtime 目录下归本工具管理、但永远不 prune 的路径（运行时产物）
PROTECTED = ("logs/", "diag", "manifest.json", ".opted-out", ".pending-restart")


def package_spec(plugin_dir: Path | None = None) -> dict:
    path = (Path(plugin_dir) / "package-files.json") if plugin_dir else PACKAGE_MANIFEST
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {"dirs": ["src", "prompts", "docs", "test"], "files": ["README.md"],
                "excludeNames": [], "excludeSuffix": []}
    return data if isinstance(data, dict) else {}


def walk_package(plugin_dir: Path) -> dict[str, Path]:
    """按 package-files.json 收集随包文件（rel posix 路径 -> 绝对路径）。"""
    spec = package_spec(plugin_dir)
    exclude_names = set(spec.get("excludeNames") or [])
    exclude_suffix = tuple(spec.get("excludeSuffix") or ())
    out: dict[str, Path] = {}
    for rel_file in spec.get("files") or []:
        p = plugin_dir / rel_file
        if p.is_file() and not p.is_symlink():
            out[Path(rel_file).as_posix()] = p
    for rel_dir in spec.get("dirs") or []:
        base = plugin_dir / rel_dir
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if not p.is_file() or p.is_symlink():
                continue
            parts = set(p.relative_to(plugin_dir).parts)
            if parts & exclude_names:
                continue
            if exclude_suffix and p.name.endswith(exclude_suffix):
                continue
            out[p.relative_to(plugin_dir).as_posix()] = p
    return out


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _version(plugin_dir: Path) -> str:
    try:
        data = json.loads((plugin_dir / ".zcode-plugin" / "plugin.json").read_text("utf-8"))
        v = data.get("version")
        return v if isinstance(v, str) else "0.0.0"
    except (OSError, ValueError):
        return "0.0.0"


def source_files(plugin_dir: Path) -> dict[str, Path]:
    return walk_package(plugin_dir)


def read_manifest(runtime_dir: Path) -> dict:
    try:
        data = json.loads((runtime_dir / MANIFEST_NAME).read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get("schema") == SCHEMA else {}


def _atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix="." + target.name + ".")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _inside(base: Path, candidate: Path) -> bool:
    """candidate 必须落在 base 内（防止 manifest 被改写后删到目录外）。"""
    try:
        candidate.resolve().relative_to(base.resolve())
        return True
    except (ValueError, OSError):
        return False


def sync_runtime(plugin_dir: Path | None = None,
                 runtime_dir: Path | None = None,
                 force: bool = False,
                 dry_run: bool = False) -> dict:
    """把 plugin_dir 镜像进 runtime_dir/runtime/，返回逐文件结果。

    conflicts 非空表示有文件被手工改过而没有覆盖；调用方应把它报给用户，
    而不是当成成功。
    """
    plugin_dir = Path(plugin_dir or Path(__file__).resolve().parent.parent)
    runtime_dir = Path(runtime_dir or DEFAULT_RUNTIME_DIR).expanduser()
    root = runtime_dir / "runtime"
    src = source_files(plugin_dir)
    prev = read_manifest(runtime_dir)
    prev_files = prev.get("files") if isinstance(prev.get("files"), dict) else {}

    created, updated, unchanged, conflicts = [], [], [], []
    files_out: dict[str, str] = {}
    for rel, abs_src in src.items():
        want = _sha256(abs_src)
        files_out[rel] = want
        dst = root / rel
        have = _sha256(dst) if dst.is_file() else None
        if have == want:
            unchanged.append(rel)
            continue
        recorded = prev_files.get(rel)
        if have is not None and recorded is not None and recorded != have and not force:
            # 目标被改过，且不是上一份 manifest 里的内容：不静默覆盖
            conflicts.append(rel)
            files_out[rel] = have
            continue
        if dry_run:
            (updated if have is not None else created).append(rel)
            continue
        _atomic_write(dst, abs_src.read_bytes())
        (updated if have is not None else created).append(rel)

    removed: list[str] = []
    for rel in sorted(set(prev_files) - set(src)):
        dst = root / rel
        if not dst.is_file() or not _inside(root, dst):
            continue
        if dry_run:
            removed.append(rel)
            continue
        try:
            dst.unlink()
            removed.append(rel)
        except OSError:
            pass

    if not dry_run:
        for rel in removed:
            parent = (root / rel).parent
            while parent != root and parent.is_dir():
                try:
                    parent.rmdir()      # 只删空目录
                except OSError:
                    break
                parent = parent.parent
        manifest = {
            "schema": SCHEMA,
            "version": _version(plugin_dir),
            "pluginRoot": str(plugin_dir),
            "runtimeRoot": str(root),
            "syncedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "files": files_out,
        }
        data = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        current = runtime_dir / MANIFEST_NAME
        if not current.is_file() or current.read_bytes() != data:
            _atomic_write(current, data)

    return {
        "runtimeDir": str(runtime_dir),
        "runtimeRoot": str(root),
        "loader": str(root / "src" / "deck-loader.cjs"),
        "version": _version(plugin_dir),
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "removed": removed,
        "conflicts": conflicts,
        "dryRun": dry_run,
    }


def verify_runtime(plugin_dir: Path | None = None,
                   runtime_dir: Path | None = None) -> dict:
    """只读检查：runtime 是否与源一致。供 status / hook 报诊断用。"""
    plugin_dir = Path(plugin_dir or Path(__file__).resolve().parent.parent)
    runtime_dir = Path(runtime_dir or DEFAULT_RUNTIME_DIR).expanduser()
    root = runtime_dir / "runtime"
    manifest = read_manifest(runtime_dir)
    recorded = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
    missing, stale, extra = [], [], []
    for rel, abs_src in source_files(plugin_dir).items():
        dst = root / rel
        if not dst.is_file():
            missing.append(rel)
        elif _sha256(dst) != _sha256(abs_src):
            stale.append(rel)
    for rel in recorded:
        if not (root / rel).is_file():
            extra.append(rel)
    loader = root / "src" / "deck-loader.cjs"
    return {
        "runtimeDir": str(runtime_dir),
        "loader": str(loader),
        "loaderExists": loader.is_file(),
        "manifestVersion": manifest.get("version"),
        "sourceVersion": _version(plugin_dir),
        "inSync": not missing and not stale and not extra,
        "missing": missing,
        "stale": stale,
        "vanished": extra,
    }


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="同步 scratch-deck 稳定 runtime 目录")
    ap.add_argument("--plugin-dir")
    ap.add_argument("--runtime-dir")
    ap.add_argument("--force", action="store_true", help="覆盖被手工改过的目标文件")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify", action="store_true", help="只读检查，不写入")
    ns = ap.parse_args()
    if ns.verify:
        print(json.dumps(verify_runtime(ns.plugin_dir and Path(ns.plugin_dir),
                                        ns.runtime_dir and Path(ns.runtime_dir)),
                         ensure_ascii=False, indent=2))
    else:
        print(json.dumps(sync_runtime(ns.plugin_dir and Path(ns.plugin_dir),
                                      ns.runtime_dir and Path(ns.runtime_dir),
                                      force=ns.force, dry_run=ns.dry_run),
                         ensure_ascii=False, indent=2))

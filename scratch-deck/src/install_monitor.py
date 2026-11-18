#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可选 install monitor：盯着 asar 注入与 runtime 一致性，变了就打印一行。

不常驻、不自启。想确认"客户端升级后注入有没有失效"时手动跑：
  python3 src/install_monitor.py            # 每 15s 检查一次
  python3 src/install_monitor.py --once     # 检查一次就退出（适合脚本）
  python3 src/install_monitor.py --json     # 机器可读
只读：从不写 asar，也不改 runtime。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SRC = Path(__file__).resolve().parent
sys.path.insert(0, str(SRC))

import patch_install as pi  # noqa: E402
import runtime_sync  # noqa: E402


def snapshot() -> dict:
    out = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "injected": None,
           "loaderUrl": None, "expectedUrl": None, "loaderExists": None,
           "runtimeInSync": None, "asar": None, "error": None}
    try:
        runtime_loader = pi.runtime_paths(None)[1]
        out["expectedUrl"] = runtime_loader.as_uri()
        out["loaderExists"] = runtime_loader.is_file()
        rt = runtime_sync.verify_runtime(None, None)
        out["runtimeInSync"] = bool(rt.get("inSync"))
        asar = pi.resolve_asar(None)
        out["asar"] = str(asar)
        entry = pi.entry_bytes(asar)
        urls = [pi.URL_RE.search(b).group(1).decode("utf-8", "replace")
                for b in pi.BLOCK_RE.findall(entry)]
        out["injected"] = bool(urls)
        out["loaderUrl"] = urls[-1] if urls else None
    except Exception as e:  # noqa: BLE001 — monitor 的价值就是报告失败
        out["error"] = str(e)
    return out


def verdict(s: dict) -> str:
    if s["error"]:
        return "检查失败：" + s["error"]
    if not Path(s["asar"]).is_file():
        return "找不到 app.asar"
    if not s["injected"]:
        return "未注入"
    if s["loaderUrl"] != s["expectedUrl"]:
        return "注入指向旧路径"
    if not s["loaderExists"]:
        return "runtime 缺 loader"
    if not s["runtimeInSync"]:
        return "runtime 与源码不一致"
    return "正常"


def main() -> int:
    ap = argparse.ArgumentParser(description="scratch-deck 注入状态监视（只读）")
    ap.add_argument("--interval", type=float, default=15.0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--json", action="store_true")
    ns = ap.parse_args()

    last = None
    try:
        while True:
            s = snapshot()
            line = verdict(s)
            if ns.json:
                print(json.dumps({"snapshot": s, "verdict": line}, ensure_ascii=False))
            elif line != last:
                print(f"[{s['at']}] {line}")
                if s["loaderUrl"]:
                    print(f"  loader: {s['loaderUrl']}")
            last = line
            if ns.once:
                return 0 if line == "正常" else 1
            time.sleep(max(1.0, ns.interval))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())

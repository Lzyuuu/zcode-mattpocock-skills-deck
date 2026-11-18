#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SessionStart hook：同步稳定 runtime，只读检查 asar 注入，报告需要用户做什么。

默认只报告，不改客户端：
  * 注入缺失/指向旧路径 → 提示运行 /install-overlay（不自动写 app.asar）
  * runtime 刚更新 → 提示重启 ZCode 才生效
  * 一切正常 → 静默
自动安装仅在 SCRATCH_DECK_AUTO_INSTALL=1 时发生（默认关闭，见 README）。

安全边界：
  * 只在 ZCode 里动手：没有 ZCODE_PLUGIN_ROOT / ZCODE_SESSION_ID 就直接退出，
    避免装在 WorkBuddy 等宿主时去改一个不属于它的客户端。
  * opt-out 标记（/uninstall-overlay 写入）优先于一切：不再提示、不再自动安装。
  * 任何异常都转成合法 hook JSON，绝不影响会话启动。
"""
from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SRC = PLUGIN_ROOT / "src"
RUNTIME_DIR = Path(os.environ.get("SCRATCH_DECK_RUNTIME") or (Path.home() / ".zcode" / "scratch-deck"))
OPT_OUT = RUNTIME_DIR / ".opted-out"
STATE_FILE = RUNTIME_DIR / "asar-state.json"
RECORD_FILE = RUNTIME_DIR / "plugin-session-start.json"


def read_stdin(timeout_s: float = 2.0) -> str:
    """协议要求消费 stdin；客户端不给 EOF 时也不能挂起。"""
    box = {"raw": ""}

    def pump():
        try:
            box["raw"] = sys.stdin.read()
        except Exception:
            pass

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    t.join(timeout_s)
    return box["raw"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def detect_zcode() -> tuple[bool, str]:
    """只认 ZCode：hook 由它注入这两个环境变量之一。"""
    if os.environ.get("ZCODE_PLUGIN_ROOT"):
        return True, "ZCODE_PLUGIN_ROOT"
    if os.environ.get("ZCODE_SESSION_ID"):
        return True, "ZCODE_SESSION_ID"
    return False, "no-zcode-env"


def check_asar() -> dict:
    """只读检查：注入在不在、指向哪、loader 在不在、asar 是否被客户端升级换掉。"""
    sys.path.insert(0, str(SRC))
    import patch_install as pi

    out = {"asar": None, "exists": False, "injected": False, "loaderUrl": None,
           "loaderExists": False, "expectedUrl": None, "entrySha256": None,
           "changedSinceInstall": False, "error": None}
    try:
        runtime_loader = RUNTIME_DIR / "runtime" / "src" / "deck-loader.cjs"
        out["expectedUrl"] = runtime_loader.as_uri()
        out["loaderExists"] = runtime_loader.is_file()
        asar = pi.resolve_asar(None)
        out["asar"] = str(asar)
        out["exists"] = True
        entry = pi.entry_bytes(asar)
        out["entrySha256"] = __import__("hashlib").sha256(entry).hexdigest()
        urls = [pi.URL_RE.search(b).group(1).decode("utf-8", "replace")
                for b in pi.BLOCK_RE.findall(entry)]
        out["injected"] = bool(urls)
        out["loaderUrl"] = urls[-1] if urls else None
        try:
            state = json.loads(STATE_FILE.read_text("utf-8"))
            hist = state.get("history") if isinstance(state.get("history"), list) else []
            if hist:
                last = hist[-1]
                out["changedSinceInstall"] = (last.get("asar") == out["asar"]
                                              and last.get("entrySha256")
                                              and last.get("entrySha256") != out["entrySha256"])
        except (OSError, ValueError):
            pass
    except Exception as e:  # noqa: BLE001 — 检查失败要可见，但不能抛
        out["error"] = str(e)
    return out


def decide(sync: dict, asar: dict, auto_install: bool) -> list[str]:
    """把事实翻译成用户能执行的一句话；空列表表示不用打扰。"""
    notes: list[str] = []
    if sync.get("created") or sync.get("updated"):
        notes.append("runtime 已更新（" + str(len(sync.get("created", [])) + len(sync.get("updated", [])))
                     + " 个文件），重启 ZCode 后生效。")
    if asar.get("error"):
        notes.append("注入检查失败：" + asar["error"])
        return notes
    if not asar.get("exists"):
        return notes
    if not asar.get("injected"):
        notes.append("scratch-deck 还没有注入客户端：运行 /install-overlay，然后完全退出（⌘Q）并重开 ZCode。")
        return notes
    if asar.get("loaderUrl") != asar.get("expectedUrl"):
        notes.append("注入仍指向旧路径（" + str(asar.get("loaderUrl")) + "）：运行 /install-overlay 改指稳定 runtime。")
        return notes
    if not asar.get("loaderExists"):
        notes.append("稳定 runtime 里缺 deck-loader.cjs：运行 /install-overlay 修复。")
        return notes
    if asar.get("changedSinceInstall"):
        notes.append("客户端 app.asar 已被替换（可能是 ZCode 升级），注入已失效：运行 /install-overlay 重新注入。")
    return notes


def write_record(record: dict) -> None:
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        tmp = RECORD_FILE.with_name(RECORD_FILE.name + ".tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, RECORD_FILE)
    except OSError:
        pass


def main() -> int:
    raw = read_stdin()
    try:
        payload = json.loads(raw or "{}")
    except ValueError:
        payload = {}
    record = {"at": now_iso(), "pluginRoot": str(PLUGIN_ROOT),
              "source": payload.get("source") if isinstance(payload, dict) else None}

    ok, why = detect_zcode()
    if not ok:
        record["skipped"] = why
        print(json.dumps({"suppressOutput": True}, ensure_ascii=False))
        return 0
    record["host"] = why

    if OPT_OUT.exists():
        record["skipped"] = "opted-out"
        write_record(record)
        print(json.dumps({"suppressOutput": True}, ensure_ascii=False))
        return 0

    try:
        sys.path.insert(0, str(SRC))
        import runtime_sync
        sync = runtime_sync.sync_runtime(PLUGIN_ROOT, RUNTIME_DIR)
    except Exception as e:  # noqa: BLE001
        sync = {"error": str(e)}
    record["runtime"] = {k: sync.get(k) for k in ("runtimeDir", "version", "created", "updated", "conflicts", "error")}

    asar = check_asar()
    record["asar"] = asar

    auto_install = os.environ.get("SCRATCH_DECK_AUTO_INSTALL") == "1"
    notes = decide(sync, asar, auto_install)
    if auto_install and asar.get("exists") and not asar.get("injected") and not asar.get("error"):
        try:
            import patch_install as pi
            pi.main(["install", "--asar", str(asar["asar"]), "--json"])
            notes.append("已按 SCRATCH_DECK_AUTO_INSTALL 自动注入，重启 ZCode 后生效。")
            record["autoInstalled"] = True
        except SystemExit:
            pass
        except Exception as e:  # noqa: BLE001
            notes.append("自动注入失败：" + str(e) + "；请手动运行 /install-overlay。")

    result = {"suppressOutput": True}
    if notes:
        msg = "scratch-deck · " + " ".join(notes)
        result["systemMessage"] = msg
        result["hookSpecificOutput"] = {"hookEventName": "SessionStart", "additionalContext": msg}
    record["result"] = result
    record["notes"] = notes
    write_record(record)

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 — hook 绝不能把会话一起弄挂
        print(json.dumps({"suppressOutput": True, "systemMessage": "scratch-deck hook 异常：" + str(e)},
                         ensure_ascii=False))
        sys.exit(0)

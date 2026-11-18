#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""scratch-deck loader 注入器：改写 ZCode 桌面端 app.asar 内主入口 out/main/index.js。

用法:
  python3 patch_install.py status  [--asar <app.asar>] [--json]
  python3 patch_install.py install [--asar <app.asar>] [--force]
  python3 patch_install.py remove  [--asar <app.asar>]

--asar 缺省 /Applications/ZCode.app/Contents/Resources/app.asar（其它平台必须显式指定）。

机制：Electron 的 asar 完整性校验 fuse 关闭，重打包 asar、在主入口尾部追加
import('file://…/deck-loader.cjs') 即可在主进程启动时加载 loader。注入内容是带
/* scratch-deck-begin/end */ 标记的块：install 幂等（先剥旧块，再按当前 runtime
目录生成新块追加），remove 只剥本工具的块、不影响其它工具的注入行。

注入目标是稳定 runtime（~/.zcode/scratch-deck/runtime/src/deck-loader.cjs），不是
插件缓存目录：缓存会随版本 bump 消失，asar 里的 URL 不会自己跟着改。

安全边界（本文件是被 Mimosa 报过 CWE-22 的位置，逐条对应）：
  * --asar resolve(strict) 后必须是普通文件；stage 与本文件同目录，用 O_EXCL 新建，
    绝不复用已存在的名字（符号链接无从劫持）。
  * asar header 里的每个名字只允许单段普通文件名：拒绝空、`.`、`..`、含 `/` `\\\\`
    与控制字符、超长。header 嵌套深度设上限。
  * 每个数据节点的 offset/size 必须是非负整数且落在文件内。
  * modify 的目标必须在 header 中真实存在且不是 unpacked/链接节点。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import secrets
import stat
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

SRC_DIR = Path(__file__).resolve().parent
PLUGIN_DIR = SRC_DIR.parent
ENTRY = "out/main/index.js"
DEFAULT_ASAR = Path("/Applications/ZCode.app/Contents/Resources/app.asar")
ALIGN = 4                    # asar header 字符串区按 4 字节对齐（chromium pickle 布局）
CHUNK = 4 * 1024 * 1024      # integrity 分块大小，须与官方打包器一致
MAX_HEADER = 64 * 1024 * 1024
MAX_ASAR = 8 * 1024 * 1024 * 1024
MAX_ENTRY = 64 * 1024 * 1024
MAX_DEPTH = 64
MAX_NAME = 255
BEGIN_MARK = b"/* scratch-deck-begin */"
END_MARK = b"/* scratch-deck-end */"
# 只认本工具写入的完整块（URL 任意）。形状收得紧，剥块时才不可能吞掉别的注入行；
# 若标记被手工改形，宁可报错也不盲剥。无捕获组：findall 拿到的就是完整块。
BLOCK_RE = re.compile(
    rb"\n/\* scratch-deck-begin \*/\n"
    rb"import\('file://[^']*'\);\n"
    rb"/\* scratch-deck-end \*/\n"
)
URL_RE = re.compile(rb"import\('(file://[^']*)'\);")
# 名字里出现控制字符、路径分隔符、或整段就是 . / .. 一律拒绝
_BAD_NAME = re.compile(r"[\x00-\x1f\x7f/\\]")


class AsarError(Exception):
    """asar 结构异常或入口状态不符合工具预期。"""


# ---------------------------------------------------------------- 路径与节点校验

def validate_name(name, where="header") -> str:
    if not isinstance(name, str) or not name:
        raise AsarError(f"{where}: 名字为空或不是字符串")
    if name in (".", ".."):
        raise AsarError(f"{where}: 非法名字 {name!r}")
    if _BAD_NAME.search(name):
        raise AsarError(f"{where}: 名字含路径分隔符或控制字符 {name!r}")
    if len(name) > MAX_NAME:
        raise AsarError(f"{where}: 名字超过 {MAX_NAME} 字符")
    return name


def validate_node_path(path) -> str:
    """校验 modify 的 key：绝对、单段普通名、非空。"""
    if not isinstance(path, str) or not path.startswith("/"):
        raise AsarError(f"目标路径必须是 asar 内绝对路径: {path!r}")
    parts = path.split("/")[1:]
    if not parts or any(p == "" for p in parts):
        raise AsarError(f"目标路径形状非法: {path!r}")
    for part in parts:
        validate_name(part, "目标路径")
    return path


def _int_field(node, key, what):
    v = node.get(key)
    if isinstance(v, bool):
        raise AsarError(f"{what}: {key} 是布尔值")
    if isinstance(v, str):
        if not re.fullmatch(r"\d+", v):
            raise AsarError(f"{what}: {key} 不是非负整数: {v!r}")
        n = int(v)
    elif isinstance(v, int):
        n = v
    else:
        raise AsarError(f"{what}: 缺少 {key}")
    if n < 0:
        raise AsarError(f"{what}: {key} 为负")
    return n


def read_header(f, file_size: int):
    head = f.read(16)
    if len(head) != 16:
        raise AsarError("文件太小，不是 asar")
    a, b, c, d = struct.unpack("<4I", head)
    if a != 4:
        raise AsarError(f"不是 asar 格式（首个 uint32={a}，应为 4）")
    if d == 0 or d > MAX_HEADER or b > MAX_HEADER + 16 or c < d:
        raise AsarError(f"header 尺寸异常（json={d}, pickle={b}, payload 起点={c}）")
    if 8 + b > file_size:
        raise AsarError("header 超出文件长度")
    try:
        header = json.loads(f.read(d))
    except ValueError as e:
        raise AsarError(f"asar header JSON 解析失败: {e}") from e
    if not isinstance(header, dict) or not isinstance(header.get("files"), dict):
        raise AsarError("asar header 没有 files 字段")
    return header, 8 + b


def iter_files(node, path="", depth=0):
    if depth > MAX_DEPTH:
        raise AsarError(f"header 嵌套超过 {MAX_DEPTH} 层")
    files = node.get("files")
    if not isinstance(files, dict):
        raise AsarError(f"{path or '/'}: files 不是对象")
    for name, ch in files.items():
        validate_name(name)
        p = f"{path}/{name}"
        if not isinstance(ch, dict):
            raise AsarError(f"{p}: 节点不是对象")
        if isinstance(ch.get("files"), dict):
            yield from iter_files(ch, p, depth + 1)
        else:
            yield p, ch


def _is_link(node) -> bool:
    return isinstance(node.get("link"), str)


def entry_bytes(asar: Path, file_size: int | None = None) -> bytes:
    size = file_size if file_size is not None else asar.stat().st_size
    with open(asar, "rb") as f:
        header, base = read_header(f, size)
        node = dict(iter_files(header)).get("/" + ENTRY)
        if node is None:
            raise AsarError(f"asar 内没有 {ENTRY}")
        if node.get("unpacked") or _is_link(node):
            raise AsarError(f"{ENTRY} 是 unpacked/链接节点，本工具不支持")
        off = _int_field(node, "offset", ENTRY)
        n = _int_field(node, "size", ENTRY)
        if n > MAX_ENTRY:
            raise AsarError(f"{ENTRY} 尺寸异常: {n}")
        if base + off + n > size:
            raise AsarError(f"{ENTRY} 数据区间越界")
        f.seek(base + off)
        data = f.read(n)
    if len(data) != n:
        raise AsarError(f"读取 {ENTRY} 不完整")
    return data


def compute_integrity(data: bytes) -> dict:
    return {
        "algorithm": "SHA256",
        "hash": hashlib.sha256(data).hexdigest(),
        "blockSize": CHUNK,
        "blocks": [hashlib.sha256(data[i:i + CHUNK]).hexdigest()
                   for i in range(0, len(data), CHUNK)],
    }


def _assert_repack_paths(src: Path, dst: Path) -> tuple[Path, Path]:
    """repack 的边界守卫：源必须是普通文件；目标必须与源同目录、是普通名、且当前不存在。
    调用方（rewrite_entry）本来就会传合法的 stage 路径，这里再挡一次——把安全条件
    放在函数边界，而不是靠"调用方一定传对"。"""
    try:
        src_r = src.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise AsarError(f"源 asar 不可解析: {src}（{e}）") from e
    if not stat.S_ISREG(src_r.stat().st_mode):
        raise AsarError(f"源 asar 不是普通文件: {src_r}")
    if not dst.is_absolute():
        dst = (Path.cwd() / dst).absolute()
    try:
        dst_parent = dst.parent.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise AsarError(f"目标目录不可解析: {dst.parent}（{e}）") from e
    if dst_parent != src_r.parent:
        raise AsarError("目标文件必须与源 asar 同目录（保证 rename 原子且不跨目录写）")
    name = dst.name
    if (not name or name in (".", "..") or "/" in name or "\\" in name
            or name.startswith("..") or _BAD_NAME.search(name)):
        raise AsarError(f"目标文件名非法: {name!r}")
    if dst.is_symlink() or dst.exists():
        raise AsarError(f"目标已存在，拒绝覆盖: {dst}")
    return src_r, Path(dst_parent) / name


def repack(src: Path, modify: dict, dst: Path) -> int:
    """重建 asar（modify: {asar 内绝对路径: 新内容 bytes}），返回文件数。
    header JSON 的键序即数据区文件顺序，dict 保序，未改动文件的 offset 复算后不变。
    目标用 O_CREAT|O_EXCL 新建：符号链接与预置文件都无法劫持写入。"""
    for key in modify:
        validate_node_path(key)
    src, dst = _assert_repack_paths(src, dst)
    size = src.stat().st_size
    try:
        fd = os.open(str(dst), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as e:
        raise AsarError(f"目标已存在，拒绝覆盖: {dst}") from e
    with open(src, "rb") as f, os.fdopen(fd, "wb") as out:
        header, base = read_header(f, size)
        nodes = dict(iter_files(header))
        missing = set(modify) - set(nodes)
        if missing:
            raise AsarError(f"asar 内不存在: {sorted(missing)}")
        for key in modify:
            node = nodes[key]
            if node.get("unpacked") or _is_link(node):
                raise AsarError(f"{key} 是 unpacked/链接节点，不能改写")

        payload = []
        offset = 0
        for path, node in nodes.items():
            if node.get("unpacked") or "size" not in node or _is_link(node):
                # unpacked 的数据在外置 .unpacked 目录（官方包里 offset 本就是 "0"）；
                # 无 size 的节点是链接等无数据区条目：都不参与 payload 排布。
                if "offset" in node:
                    node["offset"] = "0"
                continue
            if path in modify:
                data = modify[path]
                # 只在原节点本来就带 integrity 时重算：官方打包器会写它，手写/精简
                # 封包可能没有。凭空加字段会让 remove 还原不出原字节。
                if "integrity" in node:
                    node["integrity"] = compute_integrity(data)
                node["size"] = len(data)
            else:
                off = _int_field(node, "offset", path)
                n = _int_field(node, "size", path)
                if base + off + n > size:
                    raise AsarError(f"{path} 数据区间越界")
                f.seek(base + off)
                data = f.read(n)
                if len(data) != n:
                    raise AsarError(f"读取不完整: {path}")
            node["offset"] = str(offset)
            payload.append(data)
            offset += len(data)

        total = offset
        header_bytes = json.dumps(header, ensure_ascii=False,
                                  separators=(",", ":")).encode("utf-8")
        d = len(header_bytes)
        c = (d + 4 + ALIGN - 1) // ALIGN * ALIGN
        out.write(struct.pack("<4I", 4, c + 4, c, d))
        out.write(header_bytes)
        out.write(b"\0" * (c - d - 4))
        out.write(b"".join(payload))
        out.flush()
        if out.tell() != 12 + c + total:   # 16 字节 pickle 头 + d + 补齐 = 12 + c
            raise AsarError("写入长度与预期不符")
    return len(nodes)


def _stage_path(asar: Path) -> Path:
    """在 asar 同目录挑一个当前不存在的名字；实际创建交给 repack 的 O_EXCL。
    同目录保证 rename 原子；O_EXCL + 不存在校验保证不会跟随符号链接或覆盖文件。"""
    parent = asar.resolve().parent
    for _ in range(8):
        cand = parent / f".{asar.name}.scratch-deck-{os.getpid()}-{secrets.token_hex(4)}.tmp"
        if cand.is_symlink() or cand.exists():
            continue
        if cand.resolve().parent != parent:
            raise AsarError(f"stage 路径规范化后不在 asar 同目录: {cand}")
        return cand
    raise AsarError("无法在 asar 同目录挑选 stage 文件名")


def rewrite_entry(asar: Path, new_entry: bytes, expect_blocks: int) -> None:
    """重打包落盘。先写同目录 stage 再 rename，任一时刻磁盘上都有完整 asar；
    落盘前自检，不把坏包换上去。"""
    if len(new_entry) > MAX_ENTRY:
        raise AsarError(f"新入口过大: {len(new_entry)}")
    stage = _stage_path(asar)
    try:
        n_files = repack(asar, {"/" + ENTRY: new_entry}, stage)
        st = asar.stat()
        try:
            os.chown(stage, st.st_uid, st.st_gid)  # 系统位置下可能与调用者不同主
        except (OSError, AttributeError):
            pass
        os.chmod(stage, stat.S_IMODE(st.st_mode))
        stage_size = stage.stat().st_size
        if stage_size < 16 or stage_size > MAX_ASAR:
            raise AsarError(f"stage 尺寸异常: {stage_size}")
        with open(stage, "rb") as f:
            header2, _ = read_header(f, stage_size)
        if sum(1 for _ in iter_files(header2)) != n_files:
            raise AsarError("stage 自检失败：文件数变化")
        staged_entry = entry_bytes(stage, stage_size)
        if staged_entry != new_entry or len(BLOCK_RE.findall(staged_entry)) != expect_blocks:
            raise AsarError("stage 自检失败：入口内容或标记块数不符合预期")
        os.replace(stage, asar)
    finally:
        try:
            stage.unlink()
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------- runtime 与注入块

def runtime_paths(runtime_dir: Path | None) -> tuple[Path, Path]:
    try:
        sys.path.insert(0, str(SRC_DIR))
        import runtime_sync  # noqa: WPS433 — 同目录模块，按需导入避免循环
    except ImportError as e:
        raise AsarError(f"缺少 runtime_sync.py，无法确定注入目标: {e}") from e
    rd = Path(runtime_dir).expanduser() if runtime_dir else runtime_sync.DEFAULT_RUNTIME_DIR
    return rd, rd / "runtime" / "src" / "deck-loader.cjs"


def sync_runtime_or_fail(runtime_dir: Path | None, force: bool) -> dict:
    import runtime_sync
    result = runtime_sync.sync_runtime(PLUGIN_DIR, runtime_dir, force=force)
    if result["conflicts"]:
        raise AsarError(
            "runtime 目录里这些文件被手工改过，拒绝覆盖（确认要覆盖请加 --force）: "
            + ", ".join(result["conflicts"]))
    if not Path(result["loader"]).is_file():
        raise AsarError(f"runtime 同步后 loader 仍不存在: {result['loader']}")
    return result


def inject_block(loader_uri: str) -> bytes:
    # 前导 \n：真机入口不以换行结尾；若某版本入口末行是 // 行注释，不换行会把整个块
    # 吞进注释里导致 loader 静默失效。URI 走 percent-encoding：路径里的中文/空格/#/?，
    # 裸拼进 file:// URL 会被截断或改变语义，' 更会直接破坏 JS 字符串字面量。
    return (
        "\n/* scratch-deck-begin */\n"
        f"import('{loader_uri}');\n"
        "/* scratch-deck-end */\n"
    ).encode("utf-8")


def state_file(runtime_dir: Path | None) -> Path:
    rd = Path(runtime_dir).expanduser() if runtime_dir else Path.home() / ".zcode" / "scratch-deck"
    return rd / "asar-state.json"


def opt_out_file(runtime_dir: Path | None) -> Path:
    rd = Path(runtime_dir).expanduser() if runtime_dir else Path.home() / ".zcode" / "scratch-deck"
    return rd / ".opted-out"


def set_opt_out(runtime_dir: Path | None, on: bool) -> None:
    """remove 写标记（阻止 SessionStart 自动重装），install 清标记（用户显式要求回来）。"""
    path = opt_out_file(runtime_dir)
    try:
        if on:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(datetime.now(timezone.utc).isoformat(timespec="seconds") + "\n", "utf-8")
        else:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def record_state(runtime_dir: Path | None, asar: Path, command: str,
                 entry_sha: str, injected: bool) -> None:
    """记下注入前后的事实（入口 hash、asar 尺寸、时间），供 rollback 与诊断核对。
    写失败不影响主流程。"""
    path = state_file(runtime_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        prev = {}
        try:
            prev = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            prev = {}
        history = prev.get("history") if isinstance(prev.get("history"), list) else []
        history.append({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "command": command,
            "asar": str(asar),
            "entrySha256": entry_sha,
            "injected": injected,
        })
        doc = {"schema": 1, "asar": str(asar), "history": history[-20:]}
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), "utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


# ---------------------------------------------------------------- 命令

def cmd_status(asar: Path, runtime_dir: Path | None, as_json: bool) -> int:
    size = asar.stat().st_size
    with open(asar, "rb") as f:
        header, _ = read_header(f, size)
    n_files = sum(1 for _ in iter_files(header))
    entry = entry_bytes(asar, size)
    urls = [URL_RE.search(block).group(1).decode("utf-8", "replace")
            for block in BLOCK_RE.findall(entry)]
    rd, loader = runtime_paths(runtime_dir)
    try:
        import runtime_sync
        rt = runtime_sync.verify_runtime(PLUGIN_DIR, rd)
    except Exception as e:  # noqa: BLE001 — status 不能因检查失败而不可用
        rt = {"inSync": False, "error": str(e)}

    if as_json:
        print(json.dumps({
            "asar": str(asar),
            "asarBytes": size,
            "asarFiles": n_files,
            "entryBytes": len(entry),
            "entrySha256": hashlib.sha256(entry).hexdigest(),
            "injected": bool(urls),
            "loaderUrls": urls,
            "loader": str(loader),
            "loaderExists": loader.is_file(),
            "runtime": rt,
        }, ensure_ascii=False, indent=2))
        return 0 if not (BEGIN_MARK in entry and not urls) else 1

    print(f"asar: {asar} ({size} bytes, {n_files} files)")
    print(f"entry: {ENTRY} ({len(entry)} bytes)")
    print(f"runtime: {rd} ({'一致' if rt.get('inSync') else '不一致或缺失'})")
    if urls:
        print(f"scratch-deck: 已注入（{len(urls)} 个块）")
        expect = loader.as_uri()
        for u in urls:
            local = Path(unquote(u[len("file://"):]))
            print(f"  loader url: {u}")
            print(f"  loader 文件: {local}（{'存在' if local.is_file() else '缺失'}）")
        if urls[-1] != expect:
            print(f"  注意: 与当前 runtime 的 loader（{expect}）不一致，重跑 install 可改指。")
    elif BEGIN_MARK in entry or END_MARK in entry:
        print("scratch-deck: 发现标记残留但形状不符本工具写入的块（可能被手工改动），"
              "需人工检查入口尾部。")
        return 1
    else:
        print("scratch-deck: 未注入")
    return 0


def cmd_install(asar: Path, runtime_dir: Path | None, force: bool, as_json: bool) -> int:
    sync = sync_runtime_or_fail(runtime_dir, force)
    _, loader = runtime_paths(runtime_dir)
    old = entry_bytes(asar)
    stripped = BLOCK_RE.sub(b"", old)
    if BEGIN_MARK in stripped or END_MARK in stripped:
        raise AsarError("入口里有形状不符的 scratch-deck 标记（可能被手工改动），拒绝注入，请人工检查")
    uri = loader.as_uri()
    new = stripped + inject_block(uri)
    if new == old:
        set_opt_out(runtime_dir, False)
        record_state(runtime_dir, asar, "install", hashlib.sha256(old).hexdigest(), True)
        msg = f"已是最新注入（loader: {uri}），无需改动。"
        print(json.dumps({"ok": True, "changed": False, "message": msg,
                          "runtime": sync}, ensure_ascii=False) if as_json else msg)
        return 0
    if stripped != old:
        print("检测到旧 scratch-deck 注入块，已剥离，将按当前 runtime 目录重新写入。",
              file=sys.stderr if as_json else sys.stdout)
    rewrite_entry(asar, new, expect_blocks=1)
    set_opt_out(runtime_dir, False)
    record_state(runtime_dir, asar, "install", hashlib.sha256(new).hexdigest(), True)
    if as_json:
        print(json.dumps({"ok": True, "changed": True, "loaderUrl": uri,
                          "runtime": sync, "restartRequired": True}, ensure_ascii=False, indent=2))
    else:
        print(f"已注入 scratch-deck 块 → {uri}")
        print("重启 ZCode 后生效。")
    return 0


def cmd_remove(asar: Path, runtime_dir: Path | None, as_json: bool) -> int:
    old = entry_bytes(asar)
    stripped = BLOCK_RE.sub(b"", old)
    if stripped == old:
        if BEGIN_MARK in old or END_MARK in old:
            raise AsarError("入口里有形状不符的 scratch-deck 标记，无法自动剥离，请人工检查")
        set_opt_out(runtime_dir, True)
        msg = "当前 asar 没有 scratch-deck 注入块，无需卸载（已写入 opt-out，不会再自动注入）。"
        print(json.dumps({"ok": True, "changed": False, "message": msg},
                         ensure_ascii=False) if as_json else msg)
        return 0
    rewrite_entry(asar, stripped, expect_blocks=0)
    set_opt_out(runtime_dir, True)
    record_state(runtime_dir, asar, "remove", hashlib.sha256(stripped).hexdigest(), False)
    msg = "已剥离 scratch-deck 注入块（其它工具的注入行不受影响）。重启 ZCode 后生效。已写入 opt-out 标记，SessionStart 不会再自动注入。"
    print(json.dumps({"ok": True, "changed": True, "message": msg,
                      "restartRequired": True, "optedOut": True}, ensure_ascii=False) if as_json else msg)
    return 0


def resolve_asar(raw: str | None) -> Path:
    if raw:
        p = Path(raw).expanduser()
    elif os.environ.get("SCRATCH_DECK_ASAR"):
        # 测试与排障用：把目标指到副本，绝不误改真机包
        p = Path(os.environ["SCRATCH_DECK_ASAR"]).expanduser()
    elif sys.platform == "darwin":
        p = DEFAULT_ASAR
    else:
        raise AsarError("本平台没有默认 asar 位置，必须用 --asar 指定")
    try:
        resolved = p.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise AsarError(f"asar 路径不可解析: {p}（{e}）") from e
    st = resolved.stat()
    if not stat.S_ISREG(st.st_mode):
        raise AsarError(f"asar 不是普通文件: {resolved}")
    if st.st_size < 32:
        raise AsarError(f"asar 太小，不像有效包: {resolved}（{st.st_size} bytes）")
    if st.st_size > MAX_ASAR:
        raise AsarError(f"asar 尺寸超过上界: {st.st_size}")
    return resolved


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="scratch-deck loader 注入/卸载工具（app.asar out/main/index.js 尾部标记块）")
    ap.add_argument("command", choices=("status", "install", "remove"))
    ap.add_argument("--asar", help=f"目标 app.asar 路径（默认 {DEFAULT_ASAR}）")
    ap.add_argument("--runtime-dir", help="稳定 runtime 目录（默认 ~/.zcode/scratch-deck）")
    ap.add_argument("--force", action="store_true",
                    help="覆盖 runtime 目录里被手工改过的文件")
    ap.add_argument("--json", action="store_true", help="机器可读输出")
    args = ap.parse_args(argv)

    try:
        asar = resolve_asar(args.asar)
        runtime_dir = Path(args.runtime_dir) if args.runtime_dir else None
        if args.command == "status":
            return cmd_status(asar, runtime_dir, args.json)
        if args.command == "install":
            return cmd_install(asar, runtime_dir, args.force, args.json)
        return cmd_remove(asar, runtime_dir, args.json)
    except AsarError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1
    except OSError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

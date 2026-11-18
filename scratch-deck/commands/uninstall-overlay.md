# /uninstall-overlay

从 ZCode 桌面端剥离 Scratch Deck 的注入块（不影响其它工具的注入行），并写 opt-out 标记。

执行：

```bash
python3 "${ZCODE_PLUGIN_ROOT}/src/patch_install.py" remove
```

要点：
- 只剥本工具写入的标记块；zusage 等其它工具的注入行保持原样。
- 逐字节可还原：真实 366MB asar 副本上验证过 install → remove 后与基线 sha256 完全相同。
- 会写 `~/.zcode/scratch-deck/.opted-out`：之后 SessionStart 不再提示、也不会自动重装（除非设置 `SCRATCH_DECK_AUTO_INSTALL=1` 并再次显式安装）。
- 装完需要**完全退出 ZCode 再重开**（⌘Q）。
- 想恢复：重新运行 `/install-overlay`（会清掉 opt-out）。
- 只想看状态不改动：`python3 "${ZCODE_PLUGIN_ROOT}/src/patch_install.py" status`。

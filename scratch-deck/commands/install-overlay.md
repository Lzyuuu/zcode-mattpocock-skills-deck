# /install-overlay

把 Scratch Deck 的 loader 注入 ZCode 桌面端：先同步稳定 runtime，再在 app.asar 主入口尾部追加带标记的 import 块。

执行：

```bash
python3 "${ZCODE_PLUGIN_ROOT}/src/patch_install.py" install
```

要点：
- 注入目标是 `~/.zcode/scratch-deck/runtime/src/deck-loader.cjs`，不是插件缓存目录——缓存会随版本 bump 消失，asar 里的 URL 不会自己跟着改。
- 幂等：重复执行只会在必要时改指 URL；已是最新时不动 asar。
- 写入前先建同目录 stage 文件、自检、再原子 rename；失败不会留下半个包。
- 装完需要**完全退出 ZCode 再重开**（⌘Q，不是关窗口）。
- 会清掉 `/uninstall-overlay` 写的 opt-out 标记（显式安装 = 用户同意回来）。
- 升级 ZCode 覆盖 app.asar 后，重跑本命令即可；SessionStart 也会提示。
- 其它平台的 asar 位置需显式指定：`--asar <路径>`。
- 只看不改：`python3 "${ZCODE_PLUGIN_ROOT}/src/patch_install.py" status`（加 `--json` 给机器读）。

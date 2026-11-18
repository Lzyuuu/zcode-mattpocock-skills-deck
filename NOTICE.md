# NOTICE

本仓库是 [FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)（MIT，Copyright (c) 2026 王辰浩）在 ZCode 桌面端的宿主移植。

## 来自上游的部分

| 内容 | 位置 | 说明 |
|---|---|---|
| Prompt 模板 | `scratch-deck/prompts/*.yaml` | 从上游 `config/prompts/*.yaml` vendor，保留原文；由 `scripts/gen-prompts.mjs` 展开成 `src/deck-prompts.js` |
| 卡片格式与状态机 | `scratch-deck/docs/card-format.md` | frontmatter 字段、容器三态、派生规则与上游同构 |
| 状态行与面板的视觉形态 | `scratch-deck/src/deck-overlay.js` | 按上游 `prototype` 的变体 D 复刻（胶囊状态行 + 上弹五页签面板） |
| 动作语义 | `scratch-deck/docs/prompt-bridge.md` | 诊断/执行/拆票/交接等动作的护轨正文 |

## 本仓库新增的部分

- `src/deck-loader.cjs`：ZCode 主进程 loader，三态根语义、root 滞回、watcher 状态机、动作事件落盘与卡片写回
- `src/deck-overlay.js` 的宿主适配层：composer 判定、pane 约束、overlay 销毁与代际
- `src/patch_install.py`、`src/runtime_sync.py`、`scripts/sync-dist.mjs`、`hooks/session-start.py`：asar 注入、稳定 runtime、分发同步、会话自检
- `src/env-checks.cjs`、`src/git-status.cjs`、`src/tracker.cjs`：只读数据面
- `test/`：全部自动化测试与 DOM 垫片

## 间接依赖

上游本身集成了 [mattpocock/skills](https://github.com/mattpocock/skills)（MIT，Copyright (c) 2026 Matt Pocock）的技能集。本仓库不 vendor 这些技能，运行时复用 ZCode 已安装的 `mattpocock-skills` 插件；`docs/upstream-skills-1.3.2.md` 记录了本地版本与上游的差异。

## 许可

MIT。上游版权声明保留在 [LICENSE](LICENSE) 中。

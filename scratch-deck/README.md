# Scratch Deck

MattSkills 任务板（[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck)）向 ZCode 桌面端的移植。本地 Markdown 模式：卡片就是工作区 `.scratch/` 下的文件。

状态行贴在聊天输入框上方，面板从状态行上弹。读的是真实工作区，不是演示数据。

## 组成

| 文件 | 职责 |
|---|---|
| `src/deck-loader.cjs` | 主进程 loader：解析 `.scratch/*.md` 为 DeckState，逐窗口推送；监听文件变化；执行 renderer 排队的动作（归档/评论/交接/刷新） |
| `src/deck-overlay.js` | renderer overlay：状态行 + 五页签面板；选择 composer、注入 prompt、把动作压进队列 |
| `src/deck-prompts.js` | 生成物：`prompts/*.yaml` 展开后的模板表（勿手改，`node scripts/gen-prompts.mjs` 重建） |
| `src/env-checks.cjs` | 只读环境检查（工作区/.scratch/卡片/git/gh/技能/roots 配置） |
| `src/git-status.cjs` | 只读 git 状态（分支/脏/领先落后/最近提交） |
| `src/tracker.cjs` | tracker 抽象：本地 Markdown + GitHub 只读；URL/host 安全校验 |
| `src/patch_install.py` | asar 注入工具（status/install/remove，幂等，remove 逐字节还原） |
| `src/runtime_sync.py` | 稳定 runtime 同步（`~/.zcode/scratch-deck/runtime/`） |
| `src/install_monitor.py` | 可选只读监视：注入失效时打印一行 |
| `hooks/session-start.py` | 会话启动自检：同步 runtime，只读检查注入，必要时提示 |
| `scripts/sync-dist.mjs` | 把源码同步到 marketplace 镜像与已安装 cache（幂等） |
| `test/` | 全部自动化测试 + 手工场景宿主 `test-host.html` |

## 分发链：谁是谁

```
仓库源码  <repo>/scratch-deck                                   ← 唯一可编辑处
    │  node scripts/sync-dist.mjs
    ├─→ marketplace 镜像  ~/.zcode/cli/plugins/marketplaces/dev-scratch-deck/scratch-deck
    ├─→ 已安装 cache      ~/.zcode/cli/plugins/cache/dev-scratch-deck/scratch-deck/<version>
    │       ↑ installed_plugins.json 的 installPath 指向它
    └─→ 稳定 runtime      ~/.zcode/scratch-deck/runtime/
            ↑ app.asar 注入的 file:// URL 指向这里的 src/deck-loader.cjs
```

为什么要 runtime 这一层：asar 里的 URL 是写死的。指向 cache 或草稿目录时，一次版本 bump、一次重装、一次目录改名就留下悬空 import——客户端照常启动，只是状态行永远不出现。runtime 是唯一稳定目标。

同步语义：
- 内容 hash 相同就跳过（重复执行不改 mtime）
- 只删自己上一份 manifest 记过、这次不在清单里的文件；不碰用户文件和工具产物
- 写 `installed_plugins.json` 前先备份为 `.scratch-deck-bak-<时间戳>`
- 旧版本 cache 目录保留，可 `--rollback <version>` 指回去

随包文件清单写在 `package-files.json`，Python 与 Node 两条同步路径读同一份，避免各写各的 glob（0.1.0 的 cache 就漏了 `deck-prompts.js`、`prompts/`、`scripts/`）。

## 使用

```bash
# 1) 同步分发副本（改了源码之后）
node scripts/sync-dist.mjs

# 2) 注入客户端（会修改 app.asar）
python3 src/patch_install.py install
#    只读查看
python3 src/patch_install.py status
#    卸载（逐字节还原，写 opt-out 标记，之后不会自动重装）
python3 src/patch_install.py remove
```

装完**完全退出 ZCode 再重开**（⌘Q，不是关窗口）。

工作区不靠配置文件指定：loader 从页面读 ZCode 暴露的 `workspacePath`。兜底配置在 `~/.zcode/scratch-deck-roots.json`：

```json
{ "roots": ["~/code/你的项目"], "active": "~/code/你的项目", "demo": false }
```

### 三种根状态

| 状态 | 条件 | 界面 |
|---|---|---|
| `ready` | 定位到工作区且 `.scratch/` 存在 | 真实卡片，文件变化自动刷新 |
| `uninitialized` | 工作区存在但没有 `.scratch/` | 「尚未初始化 Scratch Deck」+ 初始化按钮；监听工作区根目录等它出现 |
| `unresolved` | 检测不到工作区 / 路径消失 | 诊断空态，写明原因与排查入口；**不回退演示数据** |

演示工作区只在三种情况使用：测试宿主、配置里 `demo: true`、CLI `--demo`。

## 卡片速览

```markdown
---
id: 405
type: ticket        # ticket | map | spec
status: frontier    # frontier | open | blocked | closed
labels: []
updated: 2026-11-17
next: 无依赖，可直接开工
---
# 清理废弃 API（v1 兼容层）
正文…
## 评论
- **me** (11-17): 一句话。
```

按钮向输入框注入 `/wayfinder`、`/to-tickets`、`/triage` 等命令（依赖已装的 mattpocock-skills），护轨 prompt 见 `docs/prompt-bridge.md`。

## 动作闭环

每个动作统一形状：`action / cardId / root / sessionId / startedAt / finishedAt / result / error`，落到 `<工作区>/.scratch/.deck-events.jsonl`。

| 动作 | 结果 |
|---|---|
| prompt 注入 | 注入成功记 `ok`；后续任务完成情况不可观测，另记一条 `prompt.task` = `unknown` |
| 归档 | 主进程把 frontmatter 的 `status` 原子写回 `closed`，失败记 `failed` 并报错 |
| 评论 | 主进程追加到卡片 `## 评论` 节，最新在上 |
| 交接 | 生成 `.scratch/handoff/<时间戳>.md`（决策/未完成项/下一步/卡片上下文/新会话提示词） |
| 环境检查 / git / tracker | 只读快照推回面板 |

不伪造成功：无法观测完成状态的动作一律记 `unknown`。

## 测试

```bash
node test/run-tests.cjs          # 全部套件
node test/run-tests.cjs --only loader,overlay
```

| 套件 | 覆盖 |
|---|---|
| `loader` | 三态语义、root 滞回、watcher 创建/删除/重建/改名、注入生命周期（fake Electron）、动作落盘与失败 |
| `overlay` | composer 排除优先/主辅 pane/设置页覆盖/移除恢复/导航后重注入、三态渲染、动作队列、通知去重 |
| `data-plane` | 环境检查九项、git 状态解析、URL/host 安全（20 组拒绝用例） |
| `patch-install` | install 幂等、remove 逐字节还原、与其它工具注入共存、恶意 header、非法 `--asar`、stage 失败、loader 缺失、runtime 手改保护、opt-out |
| `hook` | 非 ZCode 宿主不动手、opt-out、注入缺失/旧路径提示、检查失败不抛 |
| `dist` | workspace/镜像/cache 逐字节一致、版本与 registry 指向 |

`test/test-host.html` 是手工场景宿主（file:// 直开）：顶部可切 ready / 无 `.scratch` / 无工作区 / 双 composer / 设置页覆盖 / 移除 composer。

**这些是本地自动化与逻辑测试，不等于真机通过。** 真机步骤见下。

## 真机验收

1. `node test/run-tests.cjs` 全绿。
2. `python3 src/patch_install.py status` → 显示「已注入」且 loader URL 是 `~/.zcode/scratch-deck/runtime/src/deck-loader.cjs`。
3. 完全退出并重开 ZCode，在真实项目里打开一个会话。
4. 状态行出现在输入框上方，数字与 `.scratch/` 里的卡片一致。
5. 改一张卡片（改标题）→ 约 0.3s 后状态行「更新」时间变化、列表刷新。
6. 删除 `.scratch/` → 面板转为「尚未初始化」；恢复目录 → 转回 ready。
7. 打开设置页/插件市场 → 状态行消失（不是浮在别处）；回到聊天 → 重新出现。
8. 点一张卡的「执行」→ 输入框被填入 prompt（不自动发送）→ `.scratch/.deck-events.jsonl` 出现两条记录（`ok` + `unknown`）。
9. 详情里「归档」→ 卡片 `status: closed` 写回；「评论」→ `## 评论` 出现新条目；「交接」→ `.scratch/handoff/` 生成文件。
10. 环境检查页 → 点刷新，九项显示真实结果（不是「未检查」）。
11. `python3 src/install_monitor.py --once` → `正常`。
12. `cat ~/.zcode/scratch-deck/diag-latest.json` → 有 windows/watchers/stages。

## 故障排查

| 现象 | 先看什么 |
|---|---|
| 状态行完全不出现 | `~/.zcode/scratch-deck/diag-latest.json` 是否更新；`python3 src/install_monitor.py --once` |
| 序列号里 `injected: false` | 跑 `/install-overlay`，然后 ⌘Q 重开 |
| 注入指向旧路径 | 重跑 `install`，它会把 URL 改指 runtime |
| 状态行显示「检测不到工作区」 | ZCode 没暴露 `workspacePath`；配 `~/.zcode/scratch-deck-roots.json` |
| 显示「尚未初始化」但目录存在 | 看 `.scratch` 是否是个文件、或 loader 读到的是另一个工作区（设置页有 root 来源） |
| 卡片不刷新 | `~/.zcode/scratch-deck/logs/loader.log`（1MB 轮转）看 `watch attached` / `watch-error` |
| ZCode 升级后失效 | SessionStart 会提示；重跑 `/install-overlay` |
| 注释里要回滚 | `python3 src/patch_install.py remove`（逐字节还原，写 opt-out） |

## 已实现 / 未实现

**已实现**：三态根语义、root 滞回、watcher 状态机（创建/删除/重建/改名/退避/上限）、composer 排除优先与 pane 粘滞、overlay 销毁与代际、三态渲染、动作事件落盘、归档/评论/交接真实写回、环境检查九项、只读 git 状态、tracker 抽象（本地 + GitHub 只读 + URL 安全）、SessionStart 自检、opt-out、稳定 runtime、幂等分发同步、可选 install monitor。

**未实现 / 明确禁用**：
- Git 写操作（commit/push/pull/merge）在版本管理页显示为 disabled，只读命令可用。
- GitLab 接入只有接口与「未实现」空态，不伪造数据。
- GitHub 只读需要 `GITHUB_TOKEN`/`GH_TOKEN`；未认证时不发请求、不显示修改按钮。
- 新会话创建：ZCode 会话机制不同，只在 handoff 文件里生成自包含提示词，不声称创建了新会话。
- 自动注入客户端：默认关闭，`SCRATCH_DECK_AUTO_INSTALL=1` 才开。
- `.scratch/_index` 索引文件：没有实现，卡片按目录实时解析。

## 已知限制

- overlay 的自动化测试跑在自建 DOM 垫片上，验证的是选择/挂载/销毁逻辑，不是真实排版；排版要靠真机看。
- `workspacePath` 读的是 React fiber 的内部属性，ZCode 前端重构会让它失效；失效时用 roots 配置兜底。
- 递归 `fs.watch` 在 macOS 可用；Linux 上会退化为目录监听 + 逐文件监听。
- 卡片写回只改 frontmatter 的 `status` 行与追加评论；不做通用 Markdown 重排。
- 诊断与日志只写本机 `~/.zcode/scratch-deck/`，不写工作区（事件文件除外）。
- 安全扫描：最新一次 Mimosa 深度静态扫描报告 0 findings，但该次 `runStatus=inconclusive`、`completeness=partial`（调用图对动态派发不完整）。这**不构成"安全扫描通过"的结论**；上一轮在同一位置报过的 CWE-22 已修复并新增 5 项目标路径边界测试。


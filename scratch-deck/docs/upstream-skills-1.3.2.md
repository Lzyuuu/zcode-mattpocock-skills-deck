# mattpocock-skills：本地 1.3.1 vs 上游 1.3.2

核对日期 2026-11-18。只读核对；**没有改动已安装的 skills 包**（原因见末尾）。

## 本地事实

| 项 | 值 |
|---|---|
| 安装路径 | `~/.zcode/cli/plugins/cache/dev-grok-sync/mattpocock-skills/1.3.1` |
| 版本 | `.zcode-plugin/plugin.json` = `1.3.1` |
| 技能数 | 27（`skills/<name>/SKILL.md`，扁平布局） |
| LICENSE | **缺失**：包内只有 `skills/`，没有 LICENSE/COPYING/NOTICE |
| 上游声明的许可 | `plugin.json` 里 `"license": "MIT"`，`repository: https://github.com/mattpocock/skills` |
| 归属文件 | `skills/pr/CREDITS.md`（上游文件，credits Dex Horthy 的 show-me） |

## 上游事实

| 项 | 值 |
|---|---|
| 最新版本 | `1.3.2`（`package.json` 与 `.claude-plugin/plugin.json` 一致） |
| 许可 | 仓库根 `LICENSE` = MIT，`Copyright (c) 2026 Matt Pocock` |
| 技能集 | 与本地相同的 27 个名字，无增删改名 |
| 布局差异 | 上游分 `skills/engineering/`（20）与 `skills/productivity/`（7）；ZCode 包拍平为 `skills/<name>/` |

## 12 个优先技能逐个结论

| 技能 | 结论 | 依据 |
|---|---|---|
| ask-matt | 未变 | 本地全文与上游 main 文本逐段一致 |
| code-review | 未变 | 同上 |
| diagnosing-bugs | 未变 | 同上 |
| **grilling** | **变 1 处** | 「dispatch a sub-agent **with a fresh context window** to find it」（上游 1.3.2 #1341） |
| implement | 未变 | 同上 |
| setup-matt-pocock-skills | 未变 | 同上 |
| tdd | 未变 | 同上 |
| teach | 未变 | 同上 |
| **wayfinder** | **变 1 处** | 「spin up a subagent **with a fresh context window** that calls the Skill tool」（#1341） |
| to-tickets | 未变（高置信） | 实质文本一致；抓取器会剥离尖括号占位符，未能字节级比对 |
| handoff | 未变 | #1184 的改动本地已有 |
| wizard | **未知** | 本地文件完整；上游抓取在 `bash -n` 处被截断，尾部未验证。1.3.2 changelog 提到 wizard 两个修复批次（#1237、#1198） |

补充：1.3.2 changelog 还把 ask-matt、code-review、diagnosing-bugs、implement、tdd、to-tickets、teach 列为有改动，但这些行为在本地 1.3.1 文本里已经存在。最可能的原因是本地包是从一个已包含部分 post-1.3.1 合并的 main 提交打的。以上结论以文本比对为准，不以 changelog 为准。

## 未能取证的项

- `api.github.com/repos/mattpocock/skills/tags|releases` 返回 403（限流），无法枚举 tag；"最新 = 1.3.2" 依据是 main 分支的两个 manifest。
- 上游 wizard 尾部、to-tickets 标签级差异未做字节比对（抓取器限制）。
- 无 shell 权限，本地 sha256 未计算；以全文比对为证据。

## 结论与建议

**可以安全升级**（内容层面）：同一 27 技能集，MIT，只有两处短语插入。

但**本轮没有应用**，原因：
1. 已安装包属于 `dev-grok-sync` 市场，由另一个同步流程（grok CLI 镜像）管理；手改 cache 会在下次 sync 被覆盖，也可能与 registry 记录的版本不一致。
2. 两处改动只影响 subagent 的上下文说明，不影响 scratch-deck 的运行时行为。
3. 升级应同时补上游 MIT LICENSE——缺 LICENSE 是这个包的分发缺陷，值得单独处理。

想现在应用：`node scripts/apply-skills-1.3.2.mjs --dir <目标包目录>` 先看计划，加 `--apply` 才写（逐文件 `.bak`，只做精确单次替换，失败即停）。目标建议指向市场源目录而不是 cache。

# Scratch Deck · Prompt 桥契约

对应 deck 源码 `config/prompts/*.yaml` + `src/client/kernel/prompts.ts`；本仓库由 `scripts/gen-prompts.mjs` 生成 `src/deck-prompts.js`。
原则：**薄壳型直接复用已装技能；护轨型正文移植；文件类动作不走 prompt，直接写盘。**

## 触发点 → 模板 → 落地方式

| 触发点 | 模板 | 落地 |
|---|---|---|
| 待分诊 | `tpl.diagnose`（`/triage` + 护栏句） | 填 composer |
| 故障 | `tpl.diagnose` + `tpl.fix` | 填 composer（诊断 / 修复两个按钮） |
| 执行 / 实施 | `tpl.execute` → `shared:mapTicketAdvance` | 填 composer |
| 缺信息 | `tpl.supplement` | 填 composer |
| ready-for-human | `tpl.takeover` | 填 composer |
| research / grilling / prototype | `tpl.research` / `tpl.discuss` / `tpl.prototype` | 填 composer |
| spec 三态 | `specSplit` / `specExecute` / `specComplete` | 填 composer |
| map 三态 | `mapInspect` / `mapExecute` / `complete` | 填 composer |
| 新建需求 | `newWayfinder`（探索/实施两卡） | 填 composer |
| 新增 BUG | `newBugWayfinder` + `newBugFields` | 填 composer |
| 体检 | `healthCheck` | 填 composer |
| 沉淀 | `fixate` | 填 composer |
| 交接·第一步 | `tpl.handoff1` | **写盘**：`.scratch/handoff/<时间戳>.md`（主进程） |
| 交接·第二步 | `tpl.handoff2` | 填 composer，指向刚生成的 handoff 文件 |
| 归档 | 无 | **写盘**：frontmatter `status: closed`（主进程） |
| 评论 | 无 | **写盘**：追加到 `## 评论`（主进程） |
| 新会话 | — | 不创建会话；生成自包含 handoff prompt，并明确提示"请在新会话打开" |
| GitLab | — | 只有接口与「未实现」空态，不生成 prompt、不伪造数据 |

为什么交接/归档/评论不走 prompt：这三件事的结果可以观测。让 agent 代写会把"成功与否"变成猜测；主进程直接写盘则能记 `ok`/`failed`。prompt 只用于需要 agent 推理的工作。

## 占位符

deck 原用 `{url}` 指向 issue。本地模式统一换成 `{path}` = `.scratch/{id}-{slug}.md`；其余：`{ts}` 交接时间戳、`{n}`/`{title}` 卡片号与标题、`{repo}` 工作区目录名、`{subject}` 体检范围、`{closed}`/`{total}` 子票进度。

`TP(id, params)` 定义在生成物 `src/deck-prompts.js`，loader 注入时把它与 overlay 拼成一段脚本（prompts 先执行）。

## 与 0.1.0 文档的差异（已修正）

- 旧文档写「交接 = 注入 prompt 让 agent 生成文件」。现在第一步直接由主进程写文件，第二步才注入 prompt 指向它。
- 旧文档写「档案 = 归档动作（map.archive）」。现在是真实 frontmatter 回写，失败会报错；详情页按钮叫「归档」。
- 旧文档写「新会话 → ZCode 新写」。现在明确不做会话创建，只生成 handoff 与自包含 prompt。
- 旧文档的「Step 2 移植清单已全部完成」只表示模板已 vendor 与展开；动作接线与文件写回是 0.1.1 才闭环的。

## 护轨正文（首句）

| 触发 | 首句 |
|---|---|
| 诊断 | 诊断不等于修复，只弄清问题与分流：不改业务代码、不开始实施。 |
| 接手 | 这张票停在 ready-for-human：有一块必须由人亲自做的部分。 |
| 补充 | 这张票停在 needs-info：缺关键信息，还不能开工。 |
| 沉淀 | 告一段落。暂停推进，执行「思维对齐 · 成果沉淀」，从第一性原理出发。 |
| 地图·检查 | 该 map 在面板中显示为 0/0（无子议题），这不正常。 |
| 地图·完成 | 按 wayfinder 技能要求确认真完成，当前进度 {closed}/{total}，不要只信数字。 |
| 体检 | 这次体检的范围是整个仓库的开放票（不跟随面板当前的筛选）。 |
| 共享起手 | 从第一性原理出发。 |

完整正文在 `src/deck-prompts.js`（由 `prompts/*.yaml` 生成，勿手改）。

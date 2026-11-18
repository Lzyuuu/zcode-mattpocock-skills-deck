# Scratch Deck 卡片格式（v0.1.1）

`.scratch/` 下每个 `*.md` 是一张卡片。文件名 `{id}-{标题短slug}.md`。状态机与 dsh-mattpocock-skills-deck 同构；人是主语，agent 是读者。

## Frontmatter

```yaml
---
id: 405                # 可选；缺省取文件名数字前缀
type: ticket           # ticket | map | spec（容器）
status: frontier       # frontier 可接 | open 进行中 | blocked 被阻塞 | closed 已关
labels: []             # bug / needs-triage / research / grilling / prototype / needs-info / ready-for-human
blocked-by: 401        # 可选；被哪张卡阻塞（有此字段时展示为 blocked）
children: [403, 404]   # 仅容器；子票 id 列表
author: me             # 作者（me 时不显示头像）
updated: 2026-11-17    # 最近更新（日期，原样展示）
next: 等复现日志         # 可选；下一步一句话，列表直接展示
---
```

解析是 YAML 子集：标量、行内列表 `[a, b]`、块列表。**不剥离行内 ` # 注释`**——卡片正文里的 `#401` 引用会被 YAML 规则误伤。

## 编号规则

卡片 id 取文件名开头的数字（`405-清理废弃API.md` → 405）。
文件名没有数字前缀时退回 frontmatter 的 `id`；两者都没有的文件**不会被收进卡片列表**，而是进 `parseErrors`，并在环境检查里报「N 张卡片解析失败」。

## 正文

自由 Markdown。推荐分节：

```markdown
# 清理废弃 API（v1 兼容层）

目标与背景……

## 评论
- **qb** (11-16): 重构了导出管线，请帮看兼容性。
- **me**：没有日期也行。
```

标题取第一个 `# ` 行；没有就用文件名去编号。
评论行格式：`- **who** (日期): 正文`。日期可省；冒号全角 `：` 与半角 `:` 都认；节名 `评论` / `Comments` 都认。

## 派生规则（loader 侧，不写入文件）

- 容器三态：无子票 = 空（橙）；有未关 = 进行中（容器色）；全关 = 完成（绿）
- 进度环：`closed(children) / len(children)`
- 写作中：mtime 距今 < 10 分钟 → 蓝虚线标记
- 状态条计数：可接 = `status: frontier`；阻塞 = 工单且非关闭非可接；故障 = 非关闭且 `bug ∈ labels`；诊断 = 非关闭且 `needs-triage ∈ labels`
- 状态章：在办（open 工单）、已结案（closed）、被 #{id} 挡住（blocked）

## 写回语义（主进程，原子）

**归档**（详情页「归档」）

- 只改 frontmatter 的 `status:` 行 → `closed`；没有该行则插在 frontmatter 首行
- 正文、行尾符（LF/CRLF）、其它字段逐字节保持
- 写前重新读取并比对 hash：读后被别的进程改过就**放弃写入并报错**，不覆盖
- 临时文件 + rename 落盘；失败时原文件不变

**评论**（详情页输入框「发送」）

- 插入到 `## 评论` 节第一条之前（最新在上）；没有该节就追加 `## 评论`
- 正文压成单行、去控制字符、截断到 2000 字
- 格式 `- **me** (MM-DD)：正文`

**交接**（详情页「交接」）

- 生成 `.scratch/handoff/<YYYYMMDD-HHMMSS>.md`
- 内容：工作区、计数、当前决策、未完成项、阻塞与依赖、容器进度、下一步、给新会话的提示词
- 只读卡片，不改卡片

## 事件记录

每次动作追加一行到 `.scratch/.deck-events.jsonl`（1MB 轮转）：

```json
{"action":"prompt.inject","cardId":405,"root":"/path","sessionId":null,"startedAt":1763000000000,"finishedAt":1763000000001,"result":"ok","error":null}
{"action":"prompt.task","cardId":405,"root":"/path","sessionId":null,"startedAt":1763000000000,"finishedAt":null,"result":"unknown","error":null}
```

不写凭据、不写 prompt 全文、不写卡片正文。动作契约细节见 `docs/state-model.md`。

## 目录约定

```
<工作区>/.scratch/
  401-登录稳定性路线.md
  405-清理废弃API.md
  handoff/                # loader 生成
    20261118-101500.md
  .deck-events.jsonl      # loader 追加
  .deck-events.jsonl.1    # 轮转历史
```

`.scratch/` 不存在时状态行显示「尚未初始化」，不会伪造卡片。

# Scratch Deck · 状态模型与进程桥（schema 2）

本文档是 `deck-loader.cjs` / `deck-overlay.js` / `patch_install.py` 的共同契约。schema 2 与 0.1.0 的差别：根状态是三态判别式、演示数据不再兜底、动作有回传通道。

## 数据形状（DeckState）

```js
DeckState = {
  schema: 2,
  root: string | null,                 // 绝对路径；unresolved 时为 null
  rootSource: 'window' | 'config' | 'demo' | 'cli' | null,
  status: 'ready' | 'uninitialized' | 'unresolved',
  diagnosis: { code: string, message: string } | null,
  cards: Card[],                       // 仅 ready 时有内容
  counts: { takeable, occupied, bug, triage, blocked, closed },
  parseErrors: { file: string, reason: string }[],
  updatedAt: number,
  version: string | null,              // 插件版本
  notices: { id: number, kind: 'ok'|'warn'|'info', text: string, at: number }[],
  checks: EnvReport | null,            // 按需
  git: GitStatus | null,               // 按需
  tracker: TrackerSnapshot | null      // 按需
}

Card = {
  id: number,                          // 文件名数字前缀（无前缀则用 frontmatter id；都没有则不收）
  type: 'ticket' | 'map' | 'spec',
  title: string,                       // 正文 H1，缺省用文件名去编号
  status: 'frontier' | 'open' | 'blocked' | 'closed',
  labels: string[],
  blockedBy: number | null,
  children: number[],                  // 仅容器
  author: string,                      // 默认 'me'
  updated: string,                     // frontmatter 日期原样
  next: string | null,
  writing: boolean,                    // mtime 距今 < 10min，派生不落盘
  path: string,                        // 相对 root：.scratch/<文件名>
  body: string,                        // 正文前 4000 字符
  comments: { who: string, at: string, tx: string }[]
}
```

## 三态是数据，不是 UI 分支

| status | 判定（`classifyRoot`） | loader 行为 |
|---|---|---|
| `ready` | root 是目录且 `<root>/.scratch` 是目录 | 解析卡片；监听 `.scratch`；推送卡片 |
| `uninitialized` | root 是目录，`.scratch` 不存在或不是目录 | 不解析；监听 root 等 `.scratch` 出现 |
| `unresolved` | root 为空、路径不存在、不是目录、`.scratch` 不可读 | 不解析；按退避重试；推送诊断 |

`diagnosis.code` 取值：`no-root`、`root-missing`、`root-not-dir`、`no-scratch`、`scratch-not-dir`、`scratch-unreadable`、`scratch-read-failed`。

**演示数据不是兜底。** 只有 `opts.demo === true`、配置 `{"demo": true}`、CLI `--demo` 三者之一才会把 root 设为 `demo-workspace`，且 `rootSource: 'demo'`。

为什么这么分：检测失败时回退演示数据会让用户看到 10 张不存在的卡，误以为工作区被读到了。空态必须说清是"没初始化"还是"找不到"，这两件事的修复动作完全不同。

## 根绑定与滞回

每个窗口一份绑定记录：

```js
Binding = {
  root, source, reason: 'initial'|'rebind-confirmed'|'demo-explicit'|'no-root',
  boundAt, lastSeenAt,
  candidate, candidateSince, candidateCount
}
```

规则：
- 检测到与当前绑定不同的 root 时，先记为候选；必须连续命中 ≥2 次且稳定 ≥2s 才真的换根（`REBIND_CONFIRM` / `REBIND_SETTLE_MS`）。
- 检测失败**不改已有绑定**（页面换帧、React 重渲染会短暂返回 null）。
- 没有绑定时：配置 `active` → 绑定它（`source: 'config'`）；都没有 → `unresolved`。
- 5s 对账只更新 `lastSeenAt`，同 root 不重推状态，避免 DOM 顺序变化造成闪烁。

## watcher 状态机

| 状态 | 监听对象 | 触发 |
|---|---|---|
| `scratch` | `<root>/.scratch`（macOS 递归；否则目录 + 逐文件） | 卡片增删改 → 300ms 去抖（最长 1s 强制冲刷）后重解析 |
| `parent` | `<root>`（非递归） | `.scratch` 被创建/删除 → 重判状态并换 watcher |
| `gave-up` | 无 | 连续失败超过 8 次，退避 0.5s→30s 封顶；错误写 `lastError` 与诊断 |

删除 `.scratch` → 状态转 `uninitialized`，watcher 切到 `parent`；重建 → 转回 `ready`。
没有窗口引用的 root 条目在 60s 后关闭 watcher 并清理；条目总数上限 16。

## 进程桥（双向）

- **主 → 渲染**：`webContents.executeJavaScript('window.__deckUpdate(<JSON>)')`。frontmatter 在主进程解析校验，renderer 信任形状。
- **渲染 → 主**：渲染侧把动作压进队列，`window.__deckDrainActions()` 返回并清空。loader 每 1.2s 拉取一次。
  没有 preload 桥，这是唯一可行的回传通道；代价是动作延迟上限约 1.2s。
- **诊断回拉**：loader 每 5s 调 `window.__deckDiag()` 把 renderer 侧事实（mounted / composerFound / paneId / hiddenReason / overlayCount）并入诊断文件。

## 动作契约

```js
Action = {
  kind: 'prompt.inject' | 'archive' | 'comment' | 'handoff'
      | 'env.refresh' | 'git.refresh' | 'tracker.refresh' | 'refresh',
  cardId: number | null,
  path: string | null,                 // .scratch/<file>
  root: string | null,
  sessionId: string | null,
  startedAt: number,
  result: 'ok' | 'failed',
  error: string | null,
  text?: string                        // comment 正文
}
```

落盘记录（`.scratch/.deck-events.jsonl`，1MB 轮转）字段固定：

```js
{ action, cardId, root, sessionId, startedAt, finishedAt, result, error, detail? }
```

- `prompt.inject` 的 `result` 只描述"是否成功填进输入框"；注入成功后再写一条 `prompt.task`，`result: 'unknown'`、`finishedAt: null`——overlay 看不到 agent 是否完成了任务，不伪造。
- `archive` / `comment` / `handoff` 的结果由主进程写盘成败决定，可观测。
- 任何动作失败都写 `failed` 并带 `error`，不静默。

## 卡片写回

- `archive`：只替换 frontmatter 的 `status:` 行（没有则插入），正文、行尾符、其它字段逐字节不变；写前重读比对 hash，被并发改过就放弃并报错。
- `comment`：插入到 `## 评论` 节第一条之前（最新在上），没有该节就追加；正文压成单行、去控制字符、上限 2000 字。
- 路径必须落在 `<root>/.scratch/` 内（`path.resolve` 后前缀校验），越界直接拒绝。

## 诊断

`~/.zcode/scratch-deck/diag-latest.json`：

```js
{
  schema, pid, version, startedAt, at, demoMode, runtimeDir,
  config: { path, roots, active, demo, error },
  overlay: { loaded, error },
  dataPlane: { loaded: ['env','git','tracker'], errors },
  stages: { loaderLoaded, startExecutedAt, injectedWindows, pushedWindows },
  windows: [{ wcId, root, rootSource, bindReason, boundAt, status, cardCount,
              generation, injectedAt, lastUpdateAt, lastError, renderer }],
  watchers: [{ root, kind, retries, lastError, windows, status, cards }],
  entries
}
```

`renderer` 字段里有二次注入后才能拿到的 `mounted / composerFound / paneId / hiddenReason / overlayCount`。
阶段划分对应"loader 已加载 → start 已执行 → overlay 已注入 → composer 已找到 → state 已推送 → UI 已显示"，缺哪一步看哪一项。

日志：`~/.zcode/scratch-deck/logs/loader.log`（1MB 轮转，保留 2 份）；事件：`diag-events.jsonl`（512KB 轮转）。
不含凭据；`gh` 输出经 `redact()` 脱敏后才会进诊断。

## overlay 生命周期

- 每次注入先 `window.__deckDispose()` 拆旧实例（监听器、DOM、样式、浮层、定时器），再建新的；`window.__deckGeneration` 单调递增。
- 旧的 `__deckUpdate` / `__deckDiag` / `__deckGetRoot` 只在仍指向本实例时才删除，避免误删新实例。
- composer 选择顺序：**先排除**（设置页、插件市场、自动化页、dialog、命令中心、`aria-hidden`、overlay 自己）→ 再选主 pane（max 面积）→ 最后在同一 pane 内粘滞 `lastComposer`。辅助 pane 的 `lastComposer` 永远抢不到主 pane。
- 同一时刻只有一个 `#deck-root`：pane 变化时移动节点，不复制。没有 composer 时节点隐藏并清理 body 级浮层（悬停菜单、新建弹窗、面板）。

## 验收（真实命令）

| 契约 | 命令 |
|---|---|
| 三态解析 | `node src/deck-loader.cjs --once <root>` → `status` 字段 |
| 演示门禁 | `node src/deck-loader.cjs --once --demo` 有卡片；无 `--demo` 且无配置时不产生演示 root |
| 环境检查 | `node src/deck-loader.cjs --checks --root <root>` |
| git 只读 | `node src/deck-loader.cjs --git --root <root>` |
| 诊断 | `node src/deck-loader.cjs --diag` |
| 动作闭环 | `node test/run-tests.cjs --only loader` |
| composer/pane | `node test/run-tests.cjs --only overlay` |
| URL 安全 | `node test/run-tests.cjs --only data-plane` |

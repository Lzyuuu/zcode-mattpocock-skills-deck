# zcode-mattpocock-skills-deck

[FeatherHunter/dsh-mattpocock-skills-deck](https://github.com/FeatherHunter/dsh-mattpocock-skills-deck) 的 **ZCode 桌面端移植**。

上游是一个独立的 dsh deck 应用；这个仓库把它的核心流程和 UI 形态搬进 ZCode：读取工作区 `.scratch/` 下的 Markdown 卡片，在聊天输入框上方渲染状态行，点开是五页签面板，动作按钮把 prompt 注入输入框，并把归档/评论/交接写回真实文件。

这是一个**宿主移植**，不是上游的分支：两边的语言、目录、运行时都不同，没有共享文件。所以它是独立仓库，而不是 fork——上游 887MB 的历史对我们没有价值。上游的 prompt 模板以 vendor 形式引入，归属见 [NOTICE.md](NOTICE.md)。

## 仓库结构

```
marketplace.json     # ZCode directory marketplace 清单（插件名 scratch-deck）
scratch-deck/        # 插件本体：直接可装
  src/               # loader / overlay / 数据面 / asar 注入 / runtime 同步
  prompts/           # 从上游 vendor 的模板 YAML
  scripts/           # 模板生成、分发同步
  docs/              # 状态模型、卡片格式、prompt 桥契约
  test/              # 自动化测试 + 手工场景宿主
  hooks/             # SessionStart 自检
  commands/          # /install-overlay、/uninstall-overlay
```

`marketplace.json` 里的 marketplace 名沿用 `dev-scratch-deck`：这是本地已安装副本引用的 id，改名需要重装插件才能对齐，对使用没有影响。

## 安装

**方式一：作为 ZCode 市场源**

```bash
git clone git@github.com:Lzyuuu/zcode-mattpocock-skills-deck.git
# 在 ZCode 里把这个目录加为 directory marketplace，然后安装 scratch-deck
```

**方式二：直接注入（会修改 app.asar）**

```bash
cd scratch-deck
node scripts/sync-dist.mjs          # 同步 runtime / 镜像 / cache
python3 src/patch_install.py install
# 完全退出 ZCode（⌘Q）再重开
python3 src/patch_install.py status # 只读确认
```

卸载：`python3 src/patch_install.py remove`（逐字节还原，并写 opt-out 阻止自动重装）。

## 开发

```bash
cd scratch-deck
node test/run-tests.cjs             # 六套：loader / overlay / data-plane / patch-install / hook / dist
node test/run-tests.cjs --only loader,overlay
```

改了 `prompts/*.yaml` 要重建模板：`node scripts/gen-prompts.mjs`。
改了源码后跑 `node scripts/sync-dist.mjs` 让镜像、cache、runtime 三份副本跟上（幂等）。

测试使用自建 DOM 垫片（`test/dom-shim.cjs`）驱动真实 overlay 源码，不依赖浏览器；`test/test-host.html` 是手工场景宿主，file:// 直开。

## 与上游的关系

| 上游 | 本仓库 |
|---|---|
| dsh deck 应用（TypeScript + Electron 宿主） | ZCode 插件（.scratch → 主进程 loader → renderer overlay） |
| GitHub / GitLab issue 数据源 | 本地 Markdown 为主，GitHub 只读为可选 |
| 自带 27 个 mattpocock 技能 | 复用 ZCode 已装的 mattpocock-skills 插件 |
| 887MB | 约 1MB |

上游更新时值得跟进的只有 `config/prompts/*.yaml` 与技能文本，用 `git remote add upstream` + 手工 diff 即可，见 `scratch-deck/docs/upstream-skills-1.3.2.md`。

## 许可

MIT。上游部分版权归 王辰浩，本仓库的移植与新增部分版权归 lzy。完整声明见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

# dsh-step-pause

每 N 个 agent 步骤**暂停一次**，在对话里用几行说明「正在做什么 / 已完成什么 / 接下来做什么 / 卡点」，
说完**不停下来等确认**，直接继续原任务。

> Plugin for DeepSeek Harness: every N agent steps, interrupt the turn with a short progress
> report, then keep going on its own. No document is produced — the report is plain chat text.

![插件页配置页](docs/config-page.png)

---

## 宣传片（52 秒）

[![宣传片封面](docs/promo/poster.png)](docs/promo/dsh-step-pause-promo-final.mp4)

点封面看 52 秒 1080p 宣传片：痛点 → 原理 → 真机效果 → 配置页 → 能力清单。
分镜总览见 [contact-sheet.png](docs/promo/contact-sheet.png)。

---

## 它解决什么问题

长任务跑到第 30、40 步时，你往往不知道它现在在干什么、卡在哪、还要多久。
这个插件按固定节奏把进度**主动说出来**，而且不需要你回一句话才继续：

- 每满 N 步，往**当前步骤的输入批次**里追加一条消息，要求模型先汇报再继续；
- 因为它属于「本步输入」而不是新任务，所以**不产生额外回合**，汇报和后续动作在同一次响应里完成；
- 不会把任务挂成「等待用户确认」，也不会打断正在跑的工具调用（边界本来就是两次思考之间）。

## 安装

桌面版**不要**用 `dsh plugin --profile desktop` 直接改 profile —— 它由应用内的插件管理器独占。二选一：

1. **应用内安装**：`设置 → 插件 → 添加插件 → 从本地目录`，选这个仓库的根目录；
2. **命令行**（只对非 desktop 的 profile）：

```bash
dsh plugin --profile <你的profile> add file:<这个仓库的绝对路径>
```

装完按 `文件 → 退出` **完全退出应用**再启动（不是刷新页面）。

## 配置

装好后：`设置 → 插件 → 分步暂停 → › → 配置`。五个字段都带说明与草稿态：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后插件仍然加载，但不再汇报 |
| `everyNSteps` | `10` | 每多少步汇报一次（按轮次内的步骤计，1–500） |
| `maxReportsPerTurn` | `0` | 每轮最多汇报几次；`0` 表示不限制（兜底防失控轮次刷屏） |
| `prompt` | 见下 | 注入的提示词，支持 `{{step}}` `{{every}}` `{{turn}}` |
| `showPromptInChat` | `false` | 是否在对话里显示这段提示词原文。默认隐藏，只留你的进度小结；不影响模型收到指令 |

改动**保存即生效，不用重启**：字段声明为 `volatile()`，主机每一步都重新读值。
保存会写进当前 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-step-pause
  name: dsh-step-pause
  config:
    everyNSteps: 6
```

不想要配置页的话，直接手写上面这段完全等价。

默认提示词：

```text
[自动 · 分步暂停 · 第 {{step}} 步（每 {{every}} 步一次）]
先暂停手上的工作，直接在对话正文里用 5-10 行说明当前进度，然后立刻继续原任务：
1. 正在做什么：当前任务与所处步骤
2. 已完成什么：本轮已完成的动作或产出
3. 接下来做什么：下一步计划
4. 卡点：需要我决策或补充信息的地方（没有就写「无」）

要求：直接在回复正文里写，不要新建或修改任何文档/计划文件；
说完不要停下来等我确认，继续把原任务做完。
```

## 工作原理

挂在驱动器的步骤边界 `agent/pre-step`（waterfall）上：

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()                       // 先拿到本来的决策
  if (decision.kind !== 'enter') return decision      // reject / aborted 原样透传
  return { ...decision, messages: [...decision.messages, notice] }
}, { prepend: true })
```

计数用 `(turn, step)` 去重，换轮重置；`payload` 里带 `agent`，所以子 agent 也会各自计数
（不想要就按 `agent.id` 过滤）。

### 一个必须踩对的细节：`source.kind` 决定这条消息显不显示

DSH 客户端按消息来源决定怎么渲染（`dsh-client-ui-chat` 的 `input-message` 分类）：

```js
if (event.data.source.kind !== "user") return { ...contextMessage(event, event.data) }  // 降级为 context
return { kind: "user" /* 画成对话气泡 */ }
```

降级成 `context` 之后，`isVisibleChatNode` 还会把普通 context 从可见行里过滤掉：

```js
node.kind !== "context" || node.data.content.some(b => b.type === "tool-addition" || b.type === "tool-removal")
```

所以就两个选项，没有第三条路：

- `kind: 'user'` → 显示成一条用户气泡，**提示词原文全部可见**；
- 其它值 → 归为 context，**对话里完全看不见**。

两边都不影响模型：请求组装只看 `role`（见 `dsh-llm` 的 `createMessage`），
所以 `showPromptInChat: false` 是"藏起来但照样生效"。

本项目第一版用了 `kind: 'step-pause'`，模型收到了、行为也对，屏幕上却什么都没有，
一度误判为"插件没生效"。现在默认 `showPromptInChat: false`（用 `kind: 'step-pause'` 隐藏原文），
需要排查"到底注入了什么"时再把这个开关打开。

## 兼容性

- DSH `0.2.0-rc.2` 与 `0.2.1-rc.2` 上实测可用（`dsh.compatibility.dshReleases` 声明）；
- Node `^22.19.0 || >=24.0.0`；
- 主机侧唯一依赖是 `@deepseek-ai/schemastery`（peer，由宿主解析）；
- 浏览器半边只 `require('react')`，**不依赖** `@deepseek-ai/dsh-client-ui-primitives`（该包不随 SDK 发布）。

## 已知限制

- **按 step 计，不按「思考 token」计**：一次 step = 一次模型请求＋它的工具调用。每轮第 1 步不汇报。
- **不是硬中断**：不会取消正在执行的工具，只在步骤边界插入。
- **汇报会留在会话历史里**：它是真正的 user 消息，会进上下文、会被导出。想少留痕就把 N 调大。
  提示词原文默认不在对话里显示（`showPromptInChat: false`），但它仍在会话事件里。
- **子 agent 也汇报**：每个子 agent 独立计数，长任务里可能比你预期更频繁。
- **不强制模型必须照做**：提示词是请求，极端情况下模型可能只回一句就继续。
- **主机半边不会拖垮 profile**：加载失败只会被跳过并留一条 `dsh: warning`（用三个故意弄坏的插件实测过）。
- **客户端半边是唯一风险面**：`lib/client.js` 若加载失败，桌面窗口可能整个起不来。只想要主机逻辑的话，
  删掉 `lib/client.js`、`locale/`、`icon.svg`，再清掉 `package.json` 里的 `dsh.client` 与对应的
  `exports` 即可，行为完全不受影响。

## 开发

```bash
npm install          # 只装 @deepseek-ai/schemastery（dev）
npm test             # 11 组断言
```

测试覆盖：只在第 N 步注入、同步去重、消息形状与冻结、`showPromptInChat` 两种来源、
原批次不被改写、`reject`/`aborted` 透传、每轮配额重置、占位符渲染、
`enabled: false` 不注入但保留注册、schema 默认值、运行中改配置立即生效。

```
dsh-step-pause/
├── package.json          # exports / files / dsh.bundle.patch / dsh.client / dsh.compatibility
├── cordis.patch.yml      # loader 补丁（一条 insert）
├── lib/index.js          # 主机逻辑：Config + agent/pre-step 监听
├── lib/client.js         # 浏览器半边：注册「设置 → 插件 → 本插件 → 配置」页
├── locale/{zh,en}.json   # 插件页标题与描述
├── icon.svg              # 插件页图标
├── test/index.test.mjs   # 离线行为测试
└── docs/config-page.png  # 实测截图
```

`cordis.patch.yml` 只插一条 loader 条目；**不要**把它手写进 profile 的 loader 列表，
否则会撞 `duplicate loader entry id`。

## License

[MIT](LICENSE)

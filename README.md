# dsh-step-pause

每 N 个 agent 步骤**暂停一次**，在对话里用几行说明「正在做什么 / 已完成什么 / 接下来做什么 / 卡点」，
说完**不停下来等确认**，直接继续原任务。

> Plugin for DeepSeek Harness: every N agent steps, interrupt the turn with a short progress
> report, then keep going on its own. No document is produced — the report is plain chat text.

![插件页配置页](docs/config-page.png)

---

## 宣传片（52 秒 · 含配音与讲解员）

[![宣传片封面](docs/promo/poster.png)](docs/promo/dsh-step-pause-promo-final.mp4)

点封面看 52 秒 1080p 宣传片：痛点 → 原理 → 真机效果 → 配置页 → 能力清单 → 结尾。
全片配中文旁白与同步字幕，左下角的「大肥鱼」讲解员会随音量点头、起浮、亮光晕。
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

装好后：`设置 → 插件 → 分步暂停 → › → 配置`。六个字段都带说明与草稿态：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关。关掉后插件仍然加载，但不再汇报 |
| `everyNSteps` | `10` | 每多少步汇报一次（按轮次内的步骤计，1–500） |
| `maxReportsPerTurn` | `0` | 每轮最多汇报几次；`0` 表示不限制（兜底防失控轮次刷屏） |
| `prompt` | 见下 | 注入的提示词，支持 `{{step}}` `{{every}}` `{{turn}}` |
| `showPromptInChat` | `false` | 是否在对话里显示这段提示词原文。默认隐藏，只留你的进度小结；不影响模型收到指令 |
| `mainAgentOnly` | `true` | 只在主智能体里汇报，子智能体一律不汇报。默认开：避免并行子任务各报一份 |

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

## 已知问题与风险

这一节是把源码逐行读过、并在真机上验证过之后写的，不是免责声明。**装之前请至少看完"高风险"两条。**

风险分档：`高` = 可能让你丢掉正在做的工作或看不到界面；`中` = 影响体验或结果，可配法规避；
`低` = 已知瑕疵，不影响主流程。

### 高风险

#### 1. 客户端半边加载失败，会让**整个桌面窗口白屏**

这不是本插件独有的问题，而是 DSH 前端加载器的行为，但它决定了"装插件"这件事的风险上限。

前端在启动时遍历**所有**客户端插件条目，只要有**任何一个**没进入 `active` 状态，就抛异常、整个窗口起不来。
源码在 `@deepseek-ai/dsh-web-frontend` 的启动函数 `bZ()`：

```js
for (const i of e.loader.entries()) {
  const n = i.options.name
  if (i.fiber === void 0) { /* import failed */ r.push(...) ; continue }
  const s = vx[i.fiber.state]
  if (s !== "active") {
    if (s === "pending") {
      const l = Object.keys(i.fiber.inject).filter(d => e.get(d) === void 0)
      r.push(`${n}: pending (waiting for service: ${l.join(", ")})`)
    } else r.push(`${n}: ${s}`)
  }
}
if (r.length > 0) throw new Error(`web boot: ${r.length} entries did not activate\n${r.join("\n")}`)
```

注意三件事：

- **`pending` 也算失败**。`inject` 里声明了某个服务、而那个服务没被提供时，条目会永远停在
  `pending (waiting for service: …)`，然后整个窗口白屏。
- **没有 optional / required 之分**，`bZ()` 不做任何过滤。
- 本插件的 `lib/client.js` 声明了 `const inject = ["slots", "locale", "configForms"]`——**三个都是硬依赖**。
  如果将来 DSH 移除或重命名 `configForms`（它是配置页机制的服务），本插件就会从"配置页没了"直接升级成
  "整个界面起不来"，而且是**静默升级**：你只会看到一个打不开的窗口。

真机上见过这种情况，崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log`：

```text
Error: web boot: 6 entries did not activate
billion-context: import failed: client-modules: could not load "billion-context": ...
```

**缓解**：如果你只想用主机逻辑、不需要配置页，把客户端半边整个删掉就行（见文末"去掉客户端半边"）。
删掉之后这条路彻底不存在——主机插件的加载失败只会被 `try/catch` 捕获、留一条 `dsh: warning`，profile 照常启动
（这点用三个故意弄坏的插件实测过：import 不存在的包 / `apply()` 抛异常 / `apply()` 返回永不 resolve 的 Promise，
三种情况下 profile 都能正常启动，第三种连 warning 都没有）。

#### 2. 注入的是**真正的 `user` 消息**，会永久写进会话历史并影响后续上下文

这是本插件最关键的设计取舍，也是它跟"旁路提示"类工具的根本区别。

- 它被追加进本步的 `user/message` 批次，随会话日志**落盘**（`~/.dsh/sessions/<工作区>/…`），
  会进上下文窗口、会被 `dsh-context` 之类压缩、会跟着"导出会话"一起出去、重开应用恢复会话时它还在；
- 它的 `role` 是 `user`，所以模型可能把它**读成用户新下达的指令**。你的原始任务里如果有强约束
  （"只输出代码不要解释"、"严格 JSON"、"不要中途提问"），这条进度请求在当步会**压过**那个约束；
- 它**每一次都花 token**（默认提示词约 150–200 token / 次）。N=5 跑 100 步 ≈ 20 次注入。

**缓解**：把 `everyNSteps` 调大（默认 10，不急就 20–30）；用 `maxReportsPerTurn` 限死每轮次数；
在 `prompt` 里把它写成"汇报完立刻回到原任务，原任务里的一切格式约束仍然有效"，能明显降低劫持概率。

### 中风险

#### 3. 不是硬中断，长工具调用期间不汇报

一次 step = 一次模型请求＋它的工具调用。插件挂在**步骤边界**（`agent/pre-step`）上，
所以它**不会打断**正在跑的工具。如果你有一个跑了 3 分钟的 `npm test` 或一次大文件生成，
这期间插件什么都不会说——你等的那段沉默，它治不了。

同理，模型的思考过程（reasoning）再长，也只在一次请求内部，插件看不到、也切不进去。

#### 4. 子 agent 各自独立计数（默认已关掉汇报）

计数状态按 `payload.agent` 用 `WeakMap` 分开存，**每个子 agent 一套**。

**默认已缓解**：`mainAgentOnly: true` 让子智能体一次都不汇报，只有你直接对话的主智能体出小结。
判定依据是会话 header（`agent.session.header`）里的 `origin === 'subagent'`（`dsh-subagent`
创建子会话时写入）、`delegationDepth > 0`、或非空 `parentSession`——三者任一成立即视为子智能体。
读不到 header 时保守当作主智能体，绝不静默吞掉主智能体的进度。

要恢复旧行为（每个智能体各报各的），把 `mainAgentOnly` 关掉即可。

#### 5. 模型可以不照做；默认设置下你**看不见**它有没有触发

提示词只是请求，不是强制约束。极端情况下模型可能只回一句"收到，继续"就接着干活。

更麻烦的是默认配置：`showPromptInChat: false` 时消息的 `source.kind` 是 `'step-pause'`，
客户端按 `source.kind !== 'user'` 把它归为 context，而 `isVisibleChatNode` 又会把普通 context
从可见行里过滤掉——**结果是它在对话里完全不可见**，你只能从模型有没有输出进度小结来反推插件有没有生效。

排查时把 `showPromptInChat` 打开，就能看到注入的原文（会让对话里多一条用户气泡）。

#### 6. 每轮第 1 步不汇报；`everyNSteps: 1` 也是从第 2 步开始

计数从 1 起、只在 `step % N === 0` 时触发，第 1 步被显式跳过。所以：

- 默认 N=10 → 实际在第 10、20、30… 步汇报；
- N=1 → 不是"每步都报"，而是第 2、3、4… 步都报（第 1 步仍然跳过）。

#### 7. 计数状态在内存里，重启就没了

`WeakMap` 键是 agent 对象，进程重启、或 turn 边界重置后计数归零。
如果你在第 7 步退出应用再恢复会话，它会从 0 重新数——不是"接着第 7 步往下数"。

### 低风险 / 已知瑕疵

| # | 问题 | 说明 |
|---|---|---|
| 8 | `everyNSteps` 兜底值与 schema 默认值不一致 | `lib/index.js:101` 的 `clampInt(everyNSteps, 5, 1, 500)` 兜底是 **5**，而 schema 默认是 **10**。正常走 schema 不会触发；只有直接构造 `apply(ctx, {})` 时才看得见 5。 |
| 9 | `Boolean("false")` 是 `true` | 手写 `cordis.patch.yml` 时若写成 `enabled: "false"`（带引号的字符串），`Boolean("false") === true`，开关会失效。写裸的 `false` 才对。 |
| 10 | 测试覆盖不到真实生命周期 | `test/index.test.mjs` 的 `fakeCtx` 只实现了 `on()`，没有 `effect()`/dispose，所以"插件卸载时监听是否干净移除"这条**没有测**（依赖 cordis 的作用域自动 dispose，理论上没问题，但没有测试兜底）。11 组断言覆盖的是注入逻辑本身。 |
| 11 | 兼容性只声明到 `0.2.1-rc.2` | `dsh.compatibility.dshReleases` 只写了 `0.2.0-rc.2` / `0.2.1-rc.2`。更新的 DSH 上如果 `agent/pre-step` 的 payload 形状变了，插件**不会报错，只会静默不生效**。 |
| 12 | 与其它 `agent/pre-step` 监听器的顺序耦合 | 本插件用 `{ prepend: true }` 抢在最外层，先 `await next()` 拿到下游（含 compaction）的决策，再往批次**末尾**追加。如果将来有别的插件也 prepend 并且**不**调 `next()`，本插件会被短路。 |

### 它不会造成什么（也验证过）

- **主机半边不会拖垮 profile**：`lib/index.js` 的 import 失败或 `apply()` 抛异常，loader 只记一条
  `dsh: warning`，profile 照常启动（`cordis-plugin-loader` 的 entry 加载有 `try/catch`）。
- **不会被压缩吞掉**：`dsh-compaction-basic` 的 `agent/pre-step` 监听**不读** `payload.messages`，
  它压的是 session surface 最旧区间；本插件在其之后追加，故注入内容不会在当步被吃掉。
- **不产生额外回合、不多花一次模型调用**：消息属于"本步输入批次"，汇报与后续动作在同一次响应里完成。
- **不会挂成等待确认**：没有任何 `wait`/`ask` 语义，说完就继续。

### 去掉客户端半边（推荐给只想用主机的用户）

不需要配置页时，可以只留主机插件：

1. 删除 `lib/client.js`、`locale/`、`icon.svg`、`docs/config-page.png`；
2. 清掉 `package.json` 里的 `dsh.client` 字段，以及 `exports` 中指向 `./lib/client.js` 的条目；
3. 行为完全不受影响，只是没有 `设置 → 插件 → 分步暂停 → 配置` 那个页面——配置改成手写
   `cordis.patch.yml`（格式见上一节）。

这样风险表里的第 1 条对你就不存在了。

## 开发

```bash
npm install          # 只装 @deepseek-ai/schemastery（dev）
npm test             # 14 组断言
```

测试覆盖：只在第 N 步注入、同步去重、消息形状与冻结、`showPromptInChat` 两种来源、
原批次不被改写、`reject`/`aborted` 透传、每轮配额重置、占位符渲染、
`enabled: false` 不注入但保留注册、schema 默认值、运行中改配置立即生效、
**子智能体不汇报（三种 header 判定 + 读不到 header 时不误伤 + 可关回旧行为）**。

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

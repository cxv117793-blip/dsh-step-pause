# 汇报完就停下：为什么会这样，以及怎么修

这个文档解释 0.4.0 里 `autoResume` / `maxAutoResumesPerTurn` 这两个开关的由来。

如果你只想调参数：打开设置页的「停下后自动拉回来继续」，把「每轮最多自动续跑几次」留在默认的 `2` 就行。

## 现象

插件每 N 步往对话里放一条「说说你现在在干什么」。大多数时候模型说完就接着干活，但有一定概率**说完就停**——这一轮就此结束，得你自己补一句「继续」。

先看这有多严重。用本机真实会话日志统计（`~/.dsh/sessions/` 下所有会话，按注入消息的 `source.kind` 与 `step/end` 的 `data.step` 对齐）：

| 范围 | 检查点数 | 说了就停 | 停率 |
|---|---|---|---|
| 单个高频会话 | 23 | 5 | 21.7% |
| 全部 20 个会话（诊断时的样本） | 170 | 14 | 8.2% |
| 全部会话（后来复跑，样本更大） | 207 | 16 | 7.7% |

单看 7–8% 好像还能忍。但把「停在哪一步」也对齐之后，结论就变了：

> **诊断样本里的 14 次停止，14 次（100%）都恰好结束在注入汇报提示词的那一步。**
> （换成全量样本复跑后是 16/16，形态完全一样。）

这不是模型随机不听话，是结构决定的。

## 根因：没有工具调用的回复等于「这一轮做完了」

DSH 的 agent 驱动器是 `@deepseek-ai/dsh-agent-loop`。它在每一步跑完模型之后，用下面这段代码判断这一轮是否结束（`dsh-agent-loop/lib/index.js` 的 `step()` 末尾）：

```js
if (finish.kind === "max-tokens") return { kind: "max-tokens" };
const toolCalls = message.content.filter((block) => block.type === "tool-call");
if (toolCalls.length === 0) return { kind: "completed" };   // ← 这一轮到此为止
```

也就是说：**一条回复里只要没有任何 `tool-call`，就判定成「已完成」。**

而「用 5-10 行说明当前进度」这个要求，模型越认真执行，越会产出一段干净的纯文本。纯文本没有工具调用，于是必然 `completed`。

一次真实的日志链路（某个会话的连续事件）：

```
seq 3348  user/message       [自动 · 分步暂停 · 第 20 步…]
seq 3349  assistant/message  **进度说明** 1. 正在做什么…    ← 纯文本，无 tool call
seq 3350  step/end
seq 3352  turn/end           reason: completed              ← 这一轮关闭了
seq 3358  user/message       "继续"                          ← 只能人工补
```

所以「说完不要停下来等我确认」这类**言辞上的劝说，永远赢不过驱动器的判据**。旧版提示词里就写着这句，实测照样停 8%。

## 修法一（乙）：让回复在结构上带一次工具调用

不改任何机制，只改提示词，把要求从「写一段汇报」改成「写完汇报，在同一条回复里接着发出下一个工具调用」：

```text
用 5-10 行说明当前进度，然后**在同一条回复里接着发出下一个工具调用**：
...
- 这条回复必须以一次真实的工具调用结束（继续读文件、跑命令、调子智能体等），
  不要只用文字收尾——没有工具调用的回复会让这一轮就此结束；
- 只有原任务确实已经全部做完时，才允许纯文字收尾，并明确写「任务已完成」。
```

最后那条出口很重要：如果只要求「必须有工具调用」而不给退出条件，模型在任务真的做完时会**硬凑一个动作**出来，反而是新的问题。

这一条能覆盖大多数情况，但只是概率性的——模型仍可能不听话。所以还需要第二层。

## 修法二（甲）：在回合关闭前把它拉回来

驱动器的主循环（`dsh-agent-loop/lib/index.js` 的 `turn()`）长这样：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial("agent/turn-stopping", { turn, signal });
  signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;
```

关键在**顺序**：先 `await` 派发 `agent/turn-stopping` 事件，**之后**才重新检查 `inputs.nextStep` 是否为空来决定要不要 `break`。

所以监听器只要在这个事件里往 `next-step` 投一条消息，循环就不会结束。

投递用 `agent.steer()`：

```js
send(message, target, wakeup) {
  const wakingAfterAbort = wakeup && this.phase.kind !== "idle" && this.phase.abort.signal.aborted;
  const resolvedTarget = wakingAfterAbort ? "next-turn" : target;
  this.inbox.splice(resolvedTarget, Infinity, 0, [message]);
  if (wakeup) this.wakeDriver(wakingAfterAbort);
}
followup(input) { this.send(input, "next-turn", true); }
steer(input)    { this.send(input, "next-step", true); }   // ← 用这个
inject(input)   { this.send(input, "next-step", false); }
```

`steer` 落进 `next-step` 并唤醒驱动器，正好接上主循环的那个检查。官方文档的说法是：

> `agent/turn-stopping` 在本可完成的轮次关闭前运行，并可通过 steer 使其保持打开。

## 但「能拉回来」也意味着「可能停不下来」

这是必须认真对待的风险：自动续跑本质上是在跟用户抢方向盘。所以六条刹车都是**默认保守**——任何一条不满足就放手，让这一轮正常结束。

判断逻辑收在一个纯函数 `shouldAutoResume()` 里，逐条可测：

### 刹车一：只在「刚刚停在检查点上」时才救

```js
const atCheckpoint = state.step === state.injectedStep
const atResumedStep = Number.isInteger(state.resumedStep) && state.step === state.resumedStep
if (!atCheckpoint && !atResumedStep) return false
```

只有「这一轮刚刚结束的那一步，正好是注入汇报提示词的那一步」才考虑续跑。这精确对应实测里「14 次停止全部落在检查点」的形态。

如果模型汇报完又干了七八步才自然收尾（任务真做完了），那**不是**我们要救的场景，绝不干预。

`atResumedStep` 是给「救了之后它又纯文本收尾」留的——但那仍然受配额限制，不会无限循环。

### 刹车二：每轮最多救 N 次（默认 2，0 = 关）

```js
const used = Number.isInteger(state.autoResumes) ? state.autoResumes : 0
if (used >= limit) return false
```

换轮时 `autoResumes` 归零（新的一轮重新发配额）。这是用户明确要求的「小心让对话无法停止」的最后一道硬闸。

记账发生在 `steer()` **之前**：即使 steer 抛错也不会重复计数导致超配额。

### 刹车三：用户已经取消，绝不复活

`payload.signal.aborted === true` 时直接返回 `false`。用户按了停止，插件不许擅自把它叫回来。

### 刹车四：不碰子智能体

与 `mainAgentOnly` 一致。子智能体既不汇报也不续跑——否则一次并行派生会在十几个子会话里各被拉一次。

### 刹车五：只救「纯文本收尾」，工具自己结束的轮次不碰

这一条是**真机压测压出来的**。`dsh-agent-loop` 判定一轮结束有两条路（`step()`，`agent-loop.js:1163-1167`）：

```js
const toolCalls = message.content.filter((block) => block.type === 'tool-call')
if (toolCalls.length === 0) return { kind: 'completed' }        // 纯文本收尾
const { concluded } = await executeToolCalls(...)
return concluded ? { kind: 'completed' } : null                  // 工具自己宣布收尾
```

`turn-stopping` 的 payload 只有 `{turn, signal}`，**拿不到是哪一种**。所以插件自己去会话历史里看：`endedWithToolCall(agent)` 从 `agent.session.deriveMessages()` 尾部倒着找最后一条 assistant 消息，看 `content` 里有没有 `tool-call`。

```js
if (endedByTool !== false) return false // 只有确证是纯文本收尾才救；读不出来也不救
```

为什么要这么严：第二类（工具自己 `concludeTurn()`）意味着任务**真的**做完了（`todo_write` 全勾完、`plan-mode` 提交方案、子智能体返回），此时拉回来就是纯粹捣乱。把「读不出来」当「可以救」，正好撞上「让对话停不下来」这条红线。

真机复现：任务「依次创建 3 个文件」，N=2。第 6 步模型已经写完总结、`task` 工具也报告完成，插件还是连 steer 两次，白烧两个配额。加上这道刹车后同样的任务在第 7 步干净结束。

真机实测过滤这道刹车的价值：本机 245 个会话、184 次注入、14 次真实停止，**14 次全部是纯文本收尾，工具收尾 0 次** ⇒ 这道刹车在真实数据上零误伤。

### 刹车六：模型自己说「任务已完成」就放手

第五道刹车解决的是「工具结束」，但纯文本收尾里还有一种**正经收尾**：模型写完了全部工作，回一句「任务已完成」。插件在提示词里就是这么约定的（`DEFAULT_PROMPT` 的第三条「写法要求」），所以必须认这句话，否则约定形同虚设。

`declaredComplete(agent)` 取最后一条 assistant 消息，把文本块拼起来，拆行后**从结尾往前找第一条有实际内容的行**（跳过 `---`、`✅` 这类纯装饰），只在这一行里找标记：

```js
const COMPLETION_MARKERS = [
  '任务已完成', '任务已全部完成', '已全部完成', '全部完成',
  'task complete', 'task is complete', 'all done', 'all tasks are complete',
]
```

判据：`if (declaredDone === true) return false`。读不出、抛错一律按「没宣告完成」处理——方向是保守的：宁可多跑一步，也不误判完成把活丢下。

> 只看最后一条**有内容的行**，而不是「整段最后 30 个字符」。第一版用的后者，在 `'任务已完成的意思是全部做完。\n现在继续创建 t4.txt。'` 上会误判成完成——那句「任务已完成」是在写说明，不是在宣告。

### 还有一层：续跑提示词写死，不可配置

`RESUME_PROMPT` 刻意**不做成配置项**。它必须同时做到两件事：

1. 给模型一个明确、可判定的继续动作（同一条回复里带工具调用）；
2. 给模型一个明确、可判定的**退出出口**（任务真做完就纯文本收尾，并写明「任务已完成」）。

如果让设置页改这段，很容易改出一个「永远继续」的语义——那就真停不下来了。所以它是代码里的常量：

```text
[自动 · 分步暂停 · 续跑检查]
上一步在没有发出任何工具调用的情况下就要结束了。
如果有没做完的工作，就在这条回复里立刻继续：说明你接着要做的事，并发出对应的工具调用。
如果原任务确实已经全部做完，直接用文字给出结论并写明「任务已完成」——
不要为了继续而继续，也不要凭空造一个步骤出来。
```

## 想彻底不要这个行为

三种关法，任选：

| 做法 | 效果 |
|---|---|
| 设置页关掉「停下后自动拉回来继续」（`autoResume: false`） | 完全不做续跑，只留提示词引导 |
| 把「每轮最多自动续跑几次」填 `0`（`maxAutoResumesPerTurn: 0`） | 同上，效果等价 |
| 只改提示词 | 回到 v0.3.0 那种纯文案引导，8% 的停止率会回来 |

手写 `cordis.patch.yml` 也可以：

```yaml
- id: dsh-step-pause
  name: dsh-step-pause
  config:
    autoResume: false
```

## 成本

自动续跑本身几乎不花钱——它只是把一条约 100 token 的短提示塞进 `next-step`，让原本要结束的那一轮多跑一步。真正的成本是那多出来的一步（也就是模型本来没做的那次工具调用 + 后续）。按 `docs/cost.md` 的单价，一次续跑通常在 0.001–0.005 元量级，且只在真的发生「说了就停」时才触发（实测 8%）。

## 相关文件

- 判定逻辑：`lib/index.js` 的 `shouldAutoResume()`、`RESUME_PROMPT`、`agent/turn-stopping` 监听
- 提示词：`lib/index.js` 的 `DEFAULT_PROMPT`
- 设置页控件：`lib/client.js`（`autoResume` 开关 与 `maxAutoResumesPerTurn` 数字框）
- 测试：`test/index.test.mjs` 第 12 组（12a–12s），覆盖六条刹车、配额耗尽、换轮重置、与 steer 抛错、`endedWithToolCall` 与 `declaredComplete` 的直测

---

## English summary

**Problem.** After the plugin asks the model to summarise progress, the turn sometimes just ends. Measured on this machine's real session logs: 14 of 170 checkpoints (8.2%) ended without continuing — and **all 14 ended exactly on the step where the prompt was injected**. Re-running the same check over a larger sample gives 16 of 207 (7.7%), same shape; after v0.4.0 the measured rate is **1 of 139 (0.7%)**.

**Root cause.** `dsh-agent-loop`'s `step()` marks a turn `completed` whenever the reply contains no `tool-call` block. A well-behaved "write 5-10 lines of progress" reply is plain text, so it always trips that rule. No amount of "please keep going" in the prompt can beat that check.

**Fix 1 (prompt).** Ask for the progress text *and* a real tool call in the same reply, with an explicit escape hatch ("only if the task is genuinely done, finish with text and say so") so the model doesn't invent busywork.

**Fix 2 (hard backstop).** Listen on `agent/turn-stopping`. The driver awaits that event *before* re-checking whether `next-step` is empty, so a `steer()` from the listener keeps the turn open — documented as "can be kept open by steering".

**Six brakes, all defaulting to "let it end":**
1. Only rescue when the turn stopped exactly on the checkpoint step (the shape seen in all 14/14 stops of the diagnostic sample).
2. At most `maxAutoResumesPerTurn` rescues per turn (default 2; `0` disables), reset each turn.
3. Never revive a turn whose signal was aborted.
4. Never touch child agents.
5. Only rescue a reply that ended **without any tool call** — a tool that called `concludeTurn()`, or a state we cannot read, is left alone.
6. Back off as soon as the model's closing line says "任务已完成 / all done".

The resume prompt is a hard-coded constant, deliberately not configurable, because it carries the "this is genuinely finished" exit that keeps the loop from becoming endless.

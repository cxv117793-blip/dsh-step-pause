/**
 * dsh-step-pause — 每 N 个 agent 步骤暂停一次，输出进度后自动继续。
 *
 * 介入点：`agent/pre-step`（waterfall）。驱动器在组装好本步批次后运行它，
 * 监听器可以拒绝本步，或替换/追加进入本步的消息。
 *
 * 做法：每满 N 步，往本步批次里追加一条 user 消息，要求模型先在对话里
 * 说明进度，然后立即继续原任务。因为它是"本步的输入"而不是新任务，
 * 所以不产生额外回合，也不会把任务挂在等待用户确认上。
 *
 * 消息的 source.kind 决定它在 Chat 里显不显示（见 showPromptInChat）：
 *   - 'user'：显示成一条用户气泡，提示词原文全部可见；
 *   - 其它（默认 'step-pause'）：客户端归类为 context，Chat 里隐藏。
 * 两种情况的 role 都是 'user'，模型照常收到这条指令——请求组装只看 role，
 * 不看 source.kind，所以"隐藏"只是显示层的事。
 *
 * 子智能体不汇报（见 mainAgentOnly）：`agent/pre-step` 对主智能体与
 * subagent / 子智能体一律触发，若不区分，一次派生十几个子智能体就会在
 * 各自的会话里各报一份，刷屏且干扰父级汇总。判定走两道判据（详见
 * `isSubagent`）：会话 header 的 `origin === 'subagent'` / `delegationDepth > 0`，
 * 以及 `AgentRegistry.roots()` 给出的运行时归属（header 缺失时靠它兜底）。
 *
 * 不依赖任何核心包：消息体按 `dsh-llm` 的 `createMessage` 形状手工构造
 * （`{ id, role, content, source }`，id 为裸 UUID）。
 */

import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

/**
 * 甲方案的续跑提示词（**刻意不做成配置项**）。
 *
 * 它必须同时做到两件事，任何一件做不到都会变成「对话停不下来」：
 *   1. 给模型一个明确、可判定的继续动作（同一条回复里带工具调用）；
 *   2. 给模型一个明确、可判定的**退出出口**（任务真做完就纯文本收尾）。
 *
 * 因为这是防死循环的最后一道语义闸门，所以写死在代码里，不让设置页改坏。
 */
const RESUME_PROMPT = [
  '[自动 · 分步暂停 · 续跑检查]',
  '上一步在没有发出任何工具调用的情况下就要结束了。',
  '如果有没做完的工作，就在这条回复里立刻继续：说明你接着要做的事，并发出对应的工具调用。',
  '如果原任务确实已经全部做完，直接用文字给出结论并写明「任务已完成」——',
  '不要为了继续而继续，也不要凭空造一个步骤出来。',
].join('\n')

export const name = 'dsh-step-pause'

/** 不强制依赖任何服务；服务不可用时事件不会到达，自然空转。 */
export const inject = []

/**
 * 默认提示词。
 *
 * 关键在最后一段：DSH 的驱动器在 `dsh-agent-loop` 的 `step()` 里有一条硬判据
 * （见 `agent-loop.js:1163-1167`）——
 *
 * ```js
 * const toolCalls = message.content.filter((block) => block.type === 'tool-call')
 * if (toolCalls.length === 0) return { kind: 'completed' }
 * ```
 *
 * 只要回复里没有 tool call，这个轮次就判定为「已完成」并关闭。而「用 5-10 行
 * 说明进度」天然会得到一个纯文本回复，于是必然收尾。本机真实日志统计：20 个
 * 会话 170 个检查点里 14 次停止，这 14 次 **100%** 都停在这条提示词所在的那
 * 一步（见 docs/auto-resume.md）。
 *
 * 所以提示词不能只靠「请继续」这种劝说，必须让回复**结构上**带上 tool call：
 * 要求先说明进度、紧接着在同一条回复里发出下一个工具调用。同时给模型一个合法
 * 出口——任务确实做完时允许纯文本收尾，否则会逼它在无事可做时硬凑动作。
 */
const DEFAULT_PROMPT = [
  '[自动 · 分步暂停 · 第 {{step}} 步（每 {{every}} 步一次）]',
  '用 5-10 行说明当前进度，然后**在同一条回复里接着发出下一个工具调用**：',
  '1. 正在做什么：当前任务与所处步骤',
  '2. 已完成什么：本轮已完成的动作或产出',
  '3. 接下来做什么：下一步计划',
  '4. 卡点：需要我决策或补充信息的地方（没有就写「无」）',
  '',
  '写法要求：',
  '- 进度说明直接在回复正文里写，不要新建或修改任何文档/计划文件；',
  '- 这条回复必须以一次真实的工具调用结束（继续读文件、跑命令、调子智能体等），',
  '  不要只用文字收尾——没有工具调用的回复会让这一轮就此结束；',
  '- 只有原任务确实已经全部做完时，才允许纯文字收尾，并明确写「任务已完成」。',
].join('\n')

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('总开关。关掉后插件仍然加载，但不再汇报；可在设置页即时切换。')
    .volatile(),
  everyNSteps: Schema.number()
    .default(10)
    .min(1)
    .max(500)
    .description('每多少个 agent 步骤暂停一次并输出进度（按轮次内的步骤计）。')
    .volatile(),
  maxReportsPerTurn: Schema.number()
    .default(0)
    .min(0)
    .description('每个轮次最多汇报几次；0 表示不限制。用于兜底防止失控轮次刷屏。')
    .volatile(),
  prompt: Schema.string()
    .default(DEFAULT_PROMPT)
    .description('注入的提示词。支持 {{step}} {{every}} {{turn}} 三个占位符。')
    .volatile(),
  showPromptInChat: Schema.boolean()
    .default(false)
    .description('是否在对话里显示注入的提示词原文。默认隐藏：只留你的进度小结。')
    .volatile(),
  mainAgentOnly: Schema.boolean()
    .default(true)
    .description('只在主智能体里汇报，子智能体一律不汇报。默认开：避免并行子任务各报一份。')
    .volatile(),
  autoResume: Schema.boolean()
    .default(true)
    .description(
      '当模型在汇报后停下（这一轮就此结束）时，自动把它拉回来继续。默认开。关掉后只有提示词层面的引导。',
    )
    .volatile(),
  maxAutoResumesPerTurn: Schema.number()
    .default(2)
    .min(0)
    .description(
      '每个轮次最多自动续跑几次；0 表示完全关闭自动续跑。这是防止「对话停不下来」的硬上限。',
    )
    .volatile(),
})

function clampInt(value, fallback, min, max) {
  // `Number(null) === 0`、`Number('') === 0` 这类 JS 怪癖会把「没填」悄悄变成 0，
  // 再被 clamp 抬到 min，于是「没配置」反而成了最频繁的取值。这里显式挡掉。
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string' && value.trim() === '') return fallback
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * `.volatile()` 字段在运行时是带 `get()` 的稳定引用（设置页靠它做热更新）；
 * 直接调用 apply 时也可能拿到普通值，两种都要吃得下。
 */
function readOption(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 默认隐藏提示词原文：这些 kind 都会被客户端归为 context，Chat 里不渲染。 */
const HIDDEN_SOURCE_KIND = 'step-pause'

/**
 * 「任务已完成」的判定标记。
 *
 * 提示词里和模型约定的是写「任务已完成」四个字，但模型常写成
 * 「原任务确实已全部完成」「全部做完了」这类变体，所以两种语言各收几条。
 * 只在最后一条 assistant 消息的**收尾那一行**里找（跳过 `---`、`✅` 这类纯装饰），
 * 避免正文中间偶尔提到这些词就把还在跑的轮次判成完成。
 */
const COMPLETION_MARKERS = [
  '任务已完成',
  '任务已全部完成',
  '已全部完成',
  '全部完成',
  'task complete',
  'task is complete',
  'all done',
  'all tasks are complete',
]

/**
 * 读本步最后一条 assistant 消息，判断它「是不是以一次工具调用收尾」。
 *
 * 为什么需要这道刹车：`dsh-agent-loop` 的 `step()`（`agent-loop.js:1163-1167`）有两种
 * completed —— 纯文本（`toolCalls.length === 0`）和「带了 tool call 但工具自己声明
 * `concludesTurn`」。`agent/turn-stopping` 的 payload 只有 `{turn, signal}`，**拿不到
 * 是哪种**。所以只看「停在检查点」会把后一种也救回来，正好撞上「任务已经做完却被
 * 强行续跑」。
 *
 * 本机 245 个会话、184 条注入、其中 14 次真实停止的统计：**14/14 全部是纯文本收尾**，
 * 没有一次以 tool call 收尾 —— 说明这道刹车在真实数据上零误伤，只砍掉理论上的误救。
 *
 * @param agent - 本步所属的 agent（要能读到 `agent.session`）。
 * @returns `true` 表示最后一条 assistant 消息里含 `tool-call`（不该救）；
 *   `false` 表示纯文本收尾（该救）；`undefined` 表示读不出来（调用方保守处理）。
 */
export function endedWithToolCall(agent) {
  try {
    const session = agent?.session
    if (session === null || session === undefined) return undefined
    if (typeof session.deriveMessages !== 'function') return undefined
    const messages = session.deriveMessages()
    if (!Array.isArray(messages) || messages.length === 0) return undefined
    // 从后往前找最后一条 assistant 消息（尾部可能还有我们的注入或工具结果）。
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role !== 'assistant') continue
      const content = message.content
      if (!Array.isArray(content)) return undefined
      return content.some((block) => block?.type === 'tool-call')
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 读 `agent.session.header`；读不到（或抛错）返回 undefined，绝不中断主循环。 */
function readHeader(agent) {
  try {
    const header = agent?.session?.header
    return header === null || header === undefined ? undefined : header
  } catch {
    return undefined
  }
}

/**
 * 模型是不是已经明确宣布「任务已完成」。
 *
 * 这是第六道刹车。默认提示词里和模型约定好了：*只有原任务确实已经全部做完时，
 * 才允许纯文字收尾，并明确写「任务已完成」*。可是 `turn-stopping` 只能看到
 * 「这一轮要结束了」，看不到结束的理由，于是会把「说完了」当成「说完就停」再拉回来。
 *
 * 实测（隔离 profile，`everyNSteps: 2`）：模型在第 6 步已经写下「任务已完成。」，
 * 插件仍然连续 steer 了两次，白烧两个配额才放手 —— 正是「对话停不下来」的形态。
 * 所以必须真的去读那句话。
 *
 * 只看最后一条 assistant 消息的**最后一行**（或结尾 30 字符）：完成宣告总在
 * 收尾处；正文中间的「已完成什么：…」这类进度描述不会命中。
 *
 * @param agent - 本步所属的 agent（要能读到 `agent.session`）。
 * @returns `true` 表示模型已宣告完成（调用方不该再救）。
 */
export function declaredComplete(agent) {
  try {
    const session = agent?.session
    if (session === null || session === undefined) return false
    if (typeof session.deriveMessages !== 'function') return false
    const messages = session.deriveMessages()
    if (!Array.isArray(messages) || messages.length === 0) return false
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.role !== 'assistant') continue
      const content = message.content
      if (!Array.isArray(content)) return false
      const text = content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      if (text.trim().length === 0) return false

      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      // 从结尾往前找第一条「有实际内容」的行：跳过 `---`、`✅` 这类纯装饰收尾。
      // 只认这一行 —— 正文中间顺口提到「任务已完成」不算数（那多半是在写说明书）。
      let closing = ''
      for (let n = lines.length - 1; n >= 0; n--) {
        if (/[\p{L}\p{N}]/u.test(lines[n])) {
          closing = lines[n]
          break
        }
      }
      if (closing.length === 0) return false
      const lower = closing.toLowerCase()
      return COMPLETION_MARKERS.some((marker) => lower.includes(marker))
    }
    return false
  } catch {
    return false
  }
}

/**
 * 从运行时归属判断：这个 agent 是顶层 root，还是被某个父 agent 创建的。
 *
 * 依据是 `dsh-agent` 的 `AgentRegistry.roots()`——官方文档原话：「所有存活的
 * 顶层 agent；顶层 agent 是在没有所属 agent 上下文的情况下创建的。**持久化的
 * 会话谱系不影响这个运行时关系，所以被恢复的 fork 仍可能是 root**」。
 * 也就是说 roots 里的成员一定是主智能体，不在 roots 里的存活 agent 一定是子
 * agent——它不依赖 header 是否写全，正好补上 header 缺失那一档。
 *
 * @returns `true`/`false` 是注册表给出的确定答案；`undefined` 表示判不了
 *   （没注册表、没 id、id 不在注册表里、或调用抛错），由调用方兜底。
 */
function ownedByParent(agent, registry) {
  try {
    if (registry === null || registry === undefined) return undefined
    if (typeof registry.roots !== 'function') return undefined
    const id = agent?.session?.id ?? agent?.id
    if (typeof id !== 'string' || id.length === 0) return undefined
    const sameId = (candidate) => (candidate?.session?.id ?? candidate?.id) === id
    const roots = registry.roots()
    if (!Array.isArray(roots) || roots.length === 0) return undefined
    const isRoot = roots.some(sameId)
    // 注册表不认识这个 id（例如测试里的假 agent）时不下结论，
    // 免得把「查不到」当成「是子 agent」而静默吞掉主智能体的汇报。
    if (!isRoot && typeof registry.get === 'function' && registry.get(id) === undefined) return undefined
    return !isRoot
  } catch {
    return undefined
  }
}

/**
 * 判断当前步骤属于哪个 agent：是不是子智能体。
 *
 * 两道判据，任一能给出确定答案就用它：
 *
 * 1. **会话 header**（`agent.session.header`，`dsh-subagent` 创建子会话时写入）
 *    —— `origin === 'subagent'` 或 `delegationDepth > 0` 即子智能体。
 *    **不能只看 `parentSession` 非空**：用户手动 fork（分叉）出来的会话同样有
 *    `parentSession`，但它是主智能体（本机 226 个真实会话里，3 个 fork 会话都是
 *    `origin=undefined` / `delegationDepth=0` / `isSeeded=true`，而 111 个真子
 *    智能体全是 `origin='subagent'`）。把 fork 当成子智能体会让分叉会话里再也
 *    不汇报，因此这里刻意不认 `parentSession`。
 *
 * 2. **运行时归属**（`AgentRegistry.roots()`，见 `ownedByParent`）—— 覆盖
 *    header 缺失或没写全的情况。这是 v0.3.0 补上的泄漏面：旧版读不到 header
 *    就保守当成主智能体，于是任何没写 `origin`/`delegationDepth` 的派生路径
 *    （外部 SDK、IM 桥接）都会被灌入提示词。注册表的归属关系是运行时事实，
 *    不受 header 写法影响。
 *
 * 两道都判不了时才保守返回 false（当作主智能体），与旧版一致——原则是
 * 「实在不认识就照旧汇报」，绝不静默吞掉主智能体的进度。
 *
 * @param agent - 本步所属的 agent。
 * @param registry - 可选，`ctx.get('agents')` 拿到的 `AgentRegistry`。
 */
export function isSubagent(agent, registry) {
  const header = readHeader(agent)
  if (header !== undefined) {
    if (header.origin === 'subagent') return true
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  }
  const owned = ownedByParent(agent, registry)
  if (owned !== undefined) return owned
  return false
}

/** 配置可能未经 schema 处理（例如直接构造 apply），这里再兜一次底。 */
function resolveOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const enabled = readOption(raw.enabled)
  const everyNSteps = readOption(raw.everyNSteps)
  const maxReportsPerTurn = readOption(raw.maxReportsPerTurn)
  const prompt = readOption(raw.prompt)
  const showPromptInChat = readOption(raw.showPromptInChat)
  const mainAgentOnly = readOption(raw.mainAgentOnly)
  const autoResume = readOption(raw.autoResume)
  const maxAutoResumesPerTurn = readOption(raw.maxAutoResumesPerTurn)
  return {
    enabled: enabled === undefined ? true : Boolean(enabled),
    // 兜底必须与 schema 默认值一致（10）。旧值是 5，一旦配置绕过 schema
    // （直接构造 apply、或设置页传了裸对象）就会静默变成每 5 步汇报一次。
    everyNSteps: clampInt(everyNSteps, 10, 1, 500),
    maxReportsPerTurn: clampInt(maxReportsPerTurn, 0, 0, 1000),
    prompt:
      typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : DEFAULT_PROMPT,
    showPromptInChat: showPromptInChat === undefined ? false : Boolean(showPromptInChat),
    mainAgentOnly: mainAgentOnly === undefined ? true : Boolean(mainAgentOnly),
    autoResume: autoResume === undefined ? true : Boolean(autoResume),
    maxAutoResumesPerTurn: clampInt(maxAutoResumesPerTurn, 2, 0, 20),
  }
}

function renderPrompt(template, vars) {
  return template.replace(/\{\{\s*(step|every|turn)\s*\}\}/g, (_, key) => String(vars[key]))
}

/** 按 `dsh-llm` 的 createMessage 形状构造一条不可变 user 消息。 */
function createNoticeMessage(text, showInChat) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    // source.kind 只影响 Chat 的显示，不影响模型是否收到：
    // 客户端的 input-message 定义里，kind === 'user' 才画成气泡，其它一律
    // 归为 context，并被 isVisibleChatNode 过滤掉（普通 context 不可见）。
    // 请求组装只看 role，所以隐藏后模型仍会照常读到这段指令。
    source: Object.freeze({ kind: showInChat ? 'user' : HIDDEN_SOURCE_KIND }),
  })
}

/**
 * 甲方案的唯一决策点：这一轮到底该不该被「拉回来继续」。
 *
 * 这是整个插件里唯一可能让对话停不下来的地方，所以做成纯函数、逐条可测，
 * 并且**默认全部走保守分支**——任何一条不满足就返回 false（放手让轮次正常结束）。
 *
 * 五道刹车，缺一不可：
 *
 * 1. **触发条件极窄**：只有当「这一轮刚刚结束的那一步，正好是注入汇报提示词的
 *    那一步」时才考虑续跑。这正是实测里 14/14 次停止的共同形态——模型读完汇报
 *    指令、输出纯文本、没有 tool call，于是 `completed`。其它任何原因的结束
 *    （正常收尾、被拒绝、超 token、用户取消、报错）一律不碰。
 * 2. **次数上限**：每轮最多自动续跑 `maxAutoResumesPerTurn` 次（默认 2，0=关闭），
 *    用完之后无论什么情况都不再续跑。用户明确要求「小心让对话无法停止」，
 *    这是最后一道硬闸。
 * 3. **尊重用户的取消**：signal 已中止 / 轮次因为 aborted 结束，立刻放手。
 * 4. **不碰子智能体**：与 mainAgentOnly 一致，子智能体不汇报也不续跑。
 * 5. **只救纯文本收尾**：驱动器有两种 `completed`——「回复里没有 tool call」和
 *    「有 tool call 但工具自己结束了轮次（`concludesTurn`）」。后者是任务真的做完了。
 *    `turn-stopping` 的 payload 只有 `{turn, signal}`，拿不到结束原因，只能从会话
 *    历史反推：读不出就当作「不该救」。本机 245 个会话 / 184 条注入 / 14 次真实停止
 *    的统计是 14/14 全为纯文本收尾，所以这道刹车在真实数据上零误伤。
 *
 * @param input.state - 该 agent 的运行状态（含 turn / injectedStep / autoResumes）。
 * @param input.turn - 本轮轮次号。
 * @param input.opts - 已解析的配置。
 * @param input.aborted - 本轮是否已被取消。
 * @param input.isSubagent - 该 agent 是否为子智能体。
 * @param input.endedWithToolCall - 本步最后一条 assistant 消息是否以 tool call 收尾
 *   （`true` 说明是「工具自己结束了轮次」，属正常收尾，不该救；`undefined` 表示判不了）。
 * @param input.declaredDone - 模型是否已在最后一条 assistant 消息里明确宣告「任务已完成」。
 * @returns 是否应该 steer 一条续跑提示。
 */
export function shouldAutoResume(input) {
  const {
    state,
    turn,
    opts,
    aborted,
    isSubagent: child,
    endedWithToolCall: endedByTool,
    declaredDone,
  } = input ?? {}
  if (state === undefined || state === null) return false
  if (opts === undefined || opts === null) return false

  // 刹车四：不碰子智能体。
  if (child === true) return false
  // 刹车三：用户/系统已经取消，绝不复活。
  if (aborted === true) return false
  // 总开关与自动续跑开关。
  if (opts.enabled !== true) return false
  if (opts.autoResume !== true) return false

  // 刹车五：是「工具自己结束了这一轮」（`concludesTurn`），不是「说完就停」。
  // 只在**确证**是纯文本收尾时才救；判不了（undefined）一律不救——把「读不出」
  // 当成「可以救」会在任务已做完时强行续跑，正是用户明确警告过的风险方向。
  if (endedByTool !== false) return false

  // 刹车六：模型已经明确说「任务已完成」，放它走。
  // 提示词里就是这么约定的，但驱动器判定只看有没有 tool call，不看这句话；
  // 不读它就等于白写的约定（实测里白烧两个配额才停）。
  if (declaredDone === true) return false

  // 刹车二：次数上限（0 = 关闭）。用 `>=` 而不是 `>`，确保上限被严格尊重。
  const limit = opts.maxAutoResumesPerTurn
  if (typeof limit !== 'number' || limit <= 0) return false

  // 刹车一：必须「刚刚停在检查点上」，而不是在检查点之后又干了很久才自然收尾。
  // 这正是实测里 14/14 次停止的共同形态：模型读完汇报指令 → 输出纯文本 →
  // 没有 tool call → 判 completed。若已经离检查点很远，就当作正常收尾，不干预。
  if (state.injectedTurn === undefined) return false
  if (state.injectedTurn !== turn) return false
  if (!Number.isInteger(state.injectedStep) || state.injectedStep <= 0) return false

  // 允许两种「刚停下」：停在注入提示词那一步，或停在我们上一次续跑落下的那一步。
  // 两者之外的结束一律视为正常收尾。
  const atCheckpoint = state.step === state.injectedStep
  const atResumedStep = Number.isInteger(state.resumedStep) && state.step === state.resumedStep
  if (!atCheckpoint && !atResumedStep) return false

  const used = Number.isInteger(state.autoResumes) ? state.autoResumes : 0
  if (used >= limit) return false

  return true
}

export function apply(ctx, config) {
  // 每次进入步骤时重新读取配置：volatile 字段被设置页改写后立即生效，
  // 不必等插件重新加载。
  const options = () => resolveOptions(config)

  // 运行时归属判据的服务：没注册时 `ctx.get` 返回 undefined，我们用 undefined
  // 表示「判不了」，而不是抛错——插件不强依赖 agent 注册表。
  const registry = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    } catch {
      return undefined
    }
  }

  /** agent -> 计数状态。用 WeakMap，agent 释放后自动回收。 */
  const states = new WeakMap()
  const NO_AGENT = {}

  function stateOf(agent) {
    const key = agent !== null && typeof agent === 'object' ? agent : NO_AGENT
    let state = states.get(key)
    if (state === undefined) {
      state = {
        turn: undefined,
        step: 0,
        reports: 0,
        injectedTurn: undefined,
        injectedStep: 0,
        autoResumes: 0,
        pendingResume: false,
        resumedStep: 0,
      }
      states.set(key, state)
    }
    return state
  }

  function decorate(decision, payload) {
    // 只处理允许进入的步骤；被拒绝的步骤不需要汇报。
    if (decision === undefined || decision === null) return decision
    if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    if (payload === undefined || payload === null) return decision
    if (payload.signal !== undefined && payload.signal.aborted) return decision

    const opts = options()
    if (!opts.enabled) return decision

    // 子智能体不汇报：只让主智能体（用户直接对话的那个）出进度小结。
    if (opts.mainAgentOnly && isSubagent(payload.agent, registry())) return decision

    const state = stateOf(payload.agent)

    if (state.turn !== payload.turn) {
      state.turn = payload.turn
      state.step = 0
      state.reports = 0
      // 新的一轮：自动续跑的配额重新发放，上一轮的续跑痕迹一并清掉。
      state.autoResumes = 0
      state.pendingResume = false
      state.resumedStep = 0
    }

    const reportedStep = Number.isInteger(payload.step) && payload.step > 0 ? payload.step : state.step + 1
    state.step = Math.max(state.step, reportedStep)

    // 我们上一次 steer 把这一轮拉了回来，现在第一个后继步骤真正开跑了：
    // 记下它，供 shouldAutoResume 判断「刚刚停下」是否发生在续跑之后。
    if (state.pendingResume === true) {
      state.pendingResume = false
      state.resumedStep = reportedStep
    }

    if (state.injectedTurn === payload.turn && state.injectedStep === reportedStep) return decision
    // 第 1 步还没有任何可汇报的工作，跳过（N=1 时从第 2 步开始）。
    if (reportedStep < 2) return decision
    if (reportedStep % opts.everyNSteps !== 0) return decision
    if (opts.maxReportsPerTurn > 0 && state.reports >= opts.maxReportsPerTurn) return decision

    const text = renderPrompt(opts.prompt, {
      step: reportedStep,
      every: opts.everyNSteps,
      turn: payload.turn,
    })

    state.injectedTurn = payload.turn
    state.injectedStep = reportedStep
    state.reports += 1

    return {
      ...decision,
      messages: [...decision.messages, createNoticeMessage(text, opts.showPromptInChat)],
    }
  }

  // prepend：先挂上、让下游处理完再追加我们的消息，保持批次顺序稳定。
  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      // next() 只能调用一次，先取回下游决策再决定是否修饰。
      const decision = await next()
      try {
        return decorate(decision, payload)
      } catch {
        // 任何意外都不许弄坏主循环：退回未干预的决策。
        return decision
      }
    },
    { prepend: true },
  )

  /**
   * 甲方案：回合关闭前的最后一道硬兜底。
   *
   * `dsh-agent-loop` 的循环体（`agent-loop.js:1000-1007`）是：
   *
   * ```js
   * if (turnEnds && this.inbox.nextStep.length === 0) {
   *   await this.dispatch.serial('agent/turn-stopping', { turn, signal })
   *   signal.throwIfAborted()
   * }
   * if (turnEnds && this.inbox.nextStep.length === 0) break
   * ```
   *
   * 注意顺序：先 await 本事件，**之后**才重新检查 `nextStep` 是否为空。所以只要
   * 监听器在这里 `steer()` 一条消息进 `next-step`，循环就不会 break——官方文档
   * 原话也是「`agent/turn-stopping` 在本可完成的轮次关闭前运行，并可通过 steer
   * 使其保持打开」。
   *
   * 所有「该不该救」的判断都收在 `shouldAutoResume` 里（纯函数、逐条可测），
   * 这里只负责调用与记账。异常一律吞掉：兜底失败最多是「照常结束」，绝不能
   * 反过来把主循环弄坏。
   */
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent
      if (agent === null || agent === undefined) return
      if (typeof agent.steer !== 'function') return

      const opts = options()
      const state = states.get(agent)
      if (state === undefined) return

      const aborted = payload?.signal !== undefined && payload.signal.aborted === true
      const child = opts.mainAgentOnly && isSubagent(agent, registry())

      const resume = shouldAutoResume({
        state,
        turn: payload?.turn,
        opts,
        aborted,
        isSubagent: child,
        endedWithToolCall: endedWithToolCall(agent),
        declaredDone: declaredComplete(agent),
      })
      if (!resume) return

      // 记账放在 steer 之前：即使 steer 抛错也不会重复计数导致超配额。
      state.autoResumes += 1
      state.pendingResume = true

      agent.steer(createNoticeMessage(RESUME_PROMPT, opts.showPromptInChat))
    } catch {
      // 放手让轮次正常结束。
    }
  })
}

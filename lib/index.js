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

export const name = 'dsh-step-pause'

/** 不强制依赖任何服务；服务不可用时事件不会到达，自然空转。 */
export const inject = []

const DEFAULT_PROMPT = [
  '[自动 · 分步暂停 · 第 {{step}} 步（每 {{every}} 步一次）]',
  '先暂停手上的工作，直接在对话正文里用 5-10 行说明当前进度，然后立刻继续原任务：',
  '1. 正在做什么：当前任务与所处步骤',
  '2. 已完成什么：本轮已完成的动作或产出',
  '3. 接下来做什么：下一步计划',
  '4. 卡点：需要我决策或补充信息的地方（没有就写「无」）',
  '',
  '要求：直接在回复正文里写，不要新建或修改任何文档/计划文件；',
  '说完不要停下来等我确认，继续把原任务做完。',
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
})

function clampInt(value, fallback, min, max) {
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
  return {
    enabled: enabled === undefined ? true : Boolean(enabled),
    everyNSteps: clampInt(everyNSteps, 5, 1, 500),
    maxReportsPerTurn: clampInt(maxReportsPerTurn, 0, 0, 1000),
    prompt:
      typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : DEFAULT_PROMPT,
    showPromptInChat: showPromptInChat === undefined ? false : Boolean(showPromptInChat),
    mainAgentOnly: mainAgentOnly === undefined ? true : Boolean(mainAgentOnly),
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
      state = { turn: undefined, step: 0, reports: 0, injectedTurn: undefined, injectedStep: 0 }
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
    }

    const reportedStep = Number.isInteger(payload.step) && payload.step > 0 ? payload.step : state.step + 1
    state.step = Math.max(state.step, reportedStep)

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
}

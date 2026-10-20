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

/** 配置可能未经 schema 处理（例如直接构造 apply），这里再兜一次底。 */
function resolveOptions(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const enabled = readOption(raw.enabled)
  const everyNSteps = readOption(raw.everyNSteps)
  const maxReportsPerTurn = readOption(raw.maxReportsPerTurn)
  const prompt = readOption(raw.prompt)
  const showPromptInChat = readOption(raw.showPromptInChat)
  return {
    enabled: enabled === undefined ? true : Boolean(enabled),
    everyNSteps: clampInt(everyNSteps, 5, 1, 500),
    maxReportsPerTurn: clampInt(maxReportsPerTurn, 0, 0, 1000),
    prompt:
      typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : DEFAULT_PROMPT,
    showPromptInChat: showPromptInChat === undefined ? false : Boolean(showPromptInChat),
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

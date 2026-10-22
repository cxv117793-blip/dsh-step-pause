/**
 * dsh-step-pause 的离线行为测试（不接触运行中的 profile）。
 * 用法：npm test（或 node test/index.test.mjs）
 */
import assert from 'node:assert/strict'
import {
  apply,
  Config,
  declaredComplete,
  endedWithToolCall,
  shouldAutoResume,
} from '../lib/index.js'

const handlers = []
/** 测试里可替换的 `agents` 服务；undefined 表示「注册表判不了」。 */
let registryValue
const fakeCtx = {
  on(name, fn, opts) {
    handlers.push({ name, fn, opts })
    return () => {}
  },
  get(name) {
    return name === 'agents' ? registryValue : undefined
  },
}

function setup(config, registry) {
  handlers.length = 0
  registryValue = registry
  apply(fakeCtx, config)
  const pre = handlers.filter((h) => h.name === 'agent/pre-step')
  assert.equal(pre.length, 1, '应只注册一个 pre-step 监听器')
  const h = pre[0]
  assert.deepEqual(h.opts, { prepend: true })
  return async (payload, decision) => h.fn(payload, async () => decision)
}

/** 取 `agent/turn-stopping` 监听器（甲方案的兜底钩子）。 */
function turnStoppingHandler() {
  const h = handlers.find((x) => x.name === 'agent/turn-stopping')
  assert.ok(h, '应注册一个 agent/turn-stopping 监听器')
  return h.fn
}

/**
 * 一个能记录 steer 的假 agent。
 * 返回 { agent, steered }，steered 里是每次 steer 收到的消息。
 *
 * 默认让 `session.deriveMessages()` 返回「纯文本收尾」（最后一条 assistant 消息没有
 * tool-call），因为插件的第五道刹车只在**确证是纯文本收尾**时才续跑——这也正是
 * 本机 245 个真实会话里 14/14 次停止的共同形态。
 */
function steerableAgent(extra = {}) {
  const steered = []
  const agent = {
    id: 'main',
    session: {
      id: 'main',
      header: { id: 'main' },
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '进度说明……' }] }],
    },
    steer(message) {
      steered.push(message)
    },
    ...extra,
  }
  return { agent, steered }
}

const agent = { id: 'a1' }
const base = { kind: 'enter', messages: [] }
const payloadOf = (step, turn = 1, extra = {}) => ({ agent, turn, step, signal: { aborted: false }, ...extra })

// 1. 只在第 N 步注入，且不重复
{
  const run = setup({ everyNSteps: 3 })
  const seen = []
  for (let step = 1; step <= 7; step++) {
    const d = await run(payloadOf(step), base)
    seen.push(d.messages.length)
  }
  assert.deepEqual(seen, [0, 0, 1, 0, 0, 1, 0], '应在第 3、6 步各注入一次')
}

// 2. 同一 step 重复回调（pre-step 被再次提议）不重复注入
{
  const run = setup({ everyNSteps: 3 })
  const first = await run(payloadOf(3), base)
  const again = await run(payloadOf(3), base)
  assert.equal(first.messages.length, 1)
  assert.equal(again.messages.length, 0, '同一步不应注入两次')
}

// 3. 消息形状与不可变性
{
  const run = setup({ everyNSteps: 2 })
  const d = await run(payloadOf(2), base)
  assert.equal(d.messages.length, 1)
  const m = d.messages[0]
  assert.equal(m.role, 'user')
  assert.equal(typeof m.id, 'string')
  assert.match(m.id, /^[0-9a-f-]{36}$/)
  assert.equal(m.content.length, 1)
  assert.equal(m.content[0].type, 'text')
  assert.ok(m.content[0].text.includes('第 2 步'), m.content[0].text.slice(0, 60))
  // 默认隐藏：source.kind 不是 'user'，客户端会归为 context 且不渲染，
  // 但 role 仍是 user，模型照常收到这条指令。
  assert.equal(m.source.kind, 'step-pause')
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.content))
}

// 3b. showPromptInChat=true 时才用 kind:'user' 显示成可见气泡
{
  const run = setup({ everyNSteps: 2, showPromptInChat: true })
  const d = await run(payloadOf(2), base)
  assert.equal(d.messages[0].source.kind, 'user', '开启时应显示')
}

// 4. 保留原批次顺序，自己的消息追加在尾部
{
  const run = setup({ everyNSteps: 2 })
  const existing = [{ id: 'x1', role: 'user', content: [], source: { kind: 'user' } }]
  const d = await run(payloadOf(2), { kind: 'enter', messages: existing })
  assert.equal(d.messages.length, 2)
  assert.equal(d.messages[0], existing[0])
  assert.equal(d.messages[1].source.kind, 'step-pause')
  assert.deepEqual(existing, [{ id: 'x1', role: 'user', content: [], source: { kind: 'user' } }], '不得改动原批次')
}

// 5. reject / aborted / 非 enter 一律原样返回
{
  const run = setup({ everyNSteps: 2 })
  const reject = { kind: 'reject' }
  assert.equal(await run(payloadOf(2), reject), reject)
  const aborted = await run(payloadOf(2, 1, { signal: { aborted: true } }), base)
  assert.deepEqual(aborted, base)
  const weird = await run(payloadOf(2), { kind: 'enter' })
  assert.deepEqual(weird, { kind: 'enter' })
}

// 6. 每个轮次重置计数与汇报配额
{
  // N=2 + 每轮上限 1：第 2 步报一次用掉配额，第 4 步同为检查点但配额已满 → 不报。
  // 换轮后配额重置，第 2 步又能报一次。
  const run = setup({ everyNSteps: 2, maxReportsPerTurn: 1 })
  const counts = []
  for (const [turn, step] of [[1, 1], [1, 2], [1, 3], [1, 4], [2, 1], [2, 2], [2, 3], [2, 4]]) {
    const d = await run(payloadOf(step, turn), base)
    counts.push(d.messages.length)
  }
  assert.deepEqual(counts, [0, 1, 0, 0, 0, 1, 0, 0], '每轮最多 1 次（第 1 步不报），换轮重置')
}

// 7. 自定义提示词占位符
{
  const run = setup({ everyNSteps: 2, prompt: 'S={{step}} E={{every}} T={{turn}}' })
  const d = await run(payloadOf(4, 3), base)
  assert.equal(d.messages[0].content[0].text, 'S=4 E=2 T=3')
}

// 8. enabled=false 仍然注册，但一次都不注入（可以热开关，不用重载插件）
{
  const run = setup({ enabled: false, everyNSteps: 2 })
  const d = await run(payloadOf(2), base)
  assert.equal(d.messages.length, 0, '关掉后不注入')
  assert.equal(d, base)
}

// 9. 配置 schema：八个字段都是 .volatile()（设置页只认 volatile 字段），默认值不变
{
  const defaults = Config({})
  for (const key of [
    'enabled',
    'everyNSteps',
    'maxReportsPerTurn',
    'prompt',
    'showPromptInChat',
    'mainAgentOnly',
    'autoResume',
    'maxAutoResumesPerTurn',
  ]) {
    assert.equal(typeof defaults[key], 'object', key + ' 应是 volatile 引用')
    assert.equal(typeof defaults[key].get, 'function', key + ' 应能 get()')
  }
  assert.equal(defaults.everyNSteps.get(), 10)
  assert.equal(defaults.enabled.get(), true)
  assert.equal(defaults.maxReportsPerTurn.get(), 0)
  assert.equal(defaults.showPromptInChat.get(), false, '默认隐藏提示词原文')
  assert.equal(defaults.mainAgentOnly.get(), true, '默认只在主智能体里汇报')
  assert.equal(defaults.autoResume.get(), true, '默认开启自动续跑')
  assert.equal(defaults.maxAutoResumesPerTurn.get(), 2, '默认每轮最多续跑 2 次')
  assert.ok(defaults.prompt.get().includes('{{step}}'))
}

// 10. 运行中改配置立即生效（volatile 引用是活的，不需要重新加载插件）
{
  const options = { everyNSteps: 3, enabled: true }
  const live = {
    get enabled() { return { get: () => options.enabled } },
    get everyNSteps() { return { get: () => options.everyNSteps } },
    get maxReportsPerTurn() { return { get: () => 0 } },
    get prompt() { return { get: () => 'P{{step}}' } },
  }
  const run = setup(live)
  const at3 = await run(payloadOf(3), base)
  assert.equal(at3.messages.length, 1, '第 3 步应注入')
  options.everyNSteps = 2
  const at4 = await run(payloadOf(4), base)
  assert.equal(at4.messages.length, 1, '改成 2 后第 4 步命中')
  assert.equal(at4.messages[0].content[0].text, 'P4', '改 N 后按新值判断')
  options.enabled = false
  const off = await run(payloadOf(6), base)
  assert.equal(off.messages.length, 0, '关掉立即生效')
}

// 11. 子智能体不汇报，只有主智能体汇报（mainAgentOnly，默认开）
{
  const run = setup({ everyNSteps: 2 })
  // 主智能体：没有 session header，或 header 里没有子会话标记
  const mainAgent = { id: 'main', session: { header: { id: 's1', isSeeded: false } } }
  const dMain = await run(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(dMain.messages.length, 1, '主智能体照常汇报')

  // 子智能体：origin === 'subagent'
  const sub1 = { id: 'sub1', session: { header: { id: 's2', origin: 'subagent', parentSession: 's1' } } }
  const dSub1 = await run(payloadOf(2, 1, { agent: sub1 }), base)
  assert.equal(dSub1.messages.length, 0, '子智能体（origin）不汇报')

  // 子智能体：delegationDepth > 0
  const sub2 = { id: 'sub2', session: { header: { id: 's3', delegationDepth: 2 } } }
  const dSub2 = await run(payloadOf(2, 1, { agent: sub2 }), base)
  assert.equal(dSub2.messages.length, 0, '子智能体（delegationDepth）不汇报')

  // fork（分叉会话）：有 parentSession 但没有 origin / delegationDepth，
  // 它属于用户自己会话的主智能体，必须照常汇报（本机 226 个真实日志里 3 个都是这样）。
  const fork = { id: 'fk', session: { header: { id: 's4', parentSession: 's1', isSeeded: true } } }
  const dFork = await run(payloadOf(2, 1, { agent: fork }), base)
  assert.equal(dFork.messages.length, 1, 'fork 会话按主智能体处理，照常汇报')

  // 读不到 header 且注册表也判不了时不要误伤：当作主智能体，照旧汇报
  const broken = { id: 'b1', session: {} }
  const dBroken = await run(payloadOf(2, 1, { agent: broken }), base)
  assert.equal(dBroken.messages.length, 1, '读不到 header 且无注册表时按主智能体处理')
  const noSession = { id: 'n1' }
  const dNoSession = await run(payloadOf(2, 1, { agent: noSession }), base)
  assert.equal(dNoSession.messages.length, 1, '没有 session 且无注册表时按主智能体处理')
}

// 11d. header 缺失时靠运行时归属兜底（v0.3.0 修的泄漏面）
// 旧版：读不到 header 就当成主智能体 → 没写 origin/delegationDepth 的派生路径
// （外部 SDK、IM 桥接）会被灌入提示词。现在用 AgentRegistry.roots() 判归属。
{
  const subNoHeader = { id: 'sub-no-header', session: { id: 'sub-no-header' } }
  // 注册表里它不在 roots → 是子 agent
  const registry = {
    roots: () => [{ id: 'main', session: { id: 'main' } }],
    get: (id) => (id === 'sub-no-header' ? subNoHeader : undefined),
  }
  const run = setup({ everyNSteps: 2 }, registry)
  const d = await run(payloadOf(2, 1, { agent: subNoHeader }), base)
  assert.equal(d.messages.length, 0, 'header 缺失但注册表判定为子 agent 时不汇报')

  // 同一个注册表里，root 里的主智能体照常汇报
  const mainAgent = { id: 'main', session: { id: 'main' } }
  const dMain = await run(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(dMain.messages.length, 1, 'root 里的主智能体照常汇报')

  // 没有 session 对象、只有 id 的 agent 也能靠注册表判定
  const bare = { id: 'sub-no-header' }
  const dBare = await run(payloadOf(2, 1, { agent: bare }), base)
  assert.equal(dBare.messages.length, 0, '没有 session 时也能靠 id 判定为子 agent')
}

// 11e. 注册表判不了（禁用/未加载/不认识这个 id）时不误伤主智能体
{
  const mainAgent = { id: 'unknown', session: { id: 'unknown' } }
  // 注册表不认识这个 id → 不下结论 → 回退「当作主智能体」
  const registry = { roots: () => [{ id: 'main' }], get: () => undefined }
  const run = setup({ everyNSteps: 2 }, registry)
  const d = await run(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d.messages.length, 1, '注册表不认识这个 agent 时按主智能体处理')

  // roots 为空（注册表还没登记任何 agent）同样不误伤
  const emptyRegistry = { roots: () => [], get: () => undefined }
  const run2 = setup({ everyNSteps: 2 }, emptyRegistry)
  const d2 = await run2(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d2.messages.length, 1, 'roots 为空时按主智能体处理')

  // 注册表本身抛错也不能弄坏主循环
  const boomRegistry = {
    roots: () => {
      throw new Error('boom')
    },
    get: () => undefined,
  }
  const run3 = setup({ everyNSteps: 2 }, boomRegistry)
  const d3 = await run3(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d3.messages.length, 1, '注册表抛错时按主智能体处理')

  // agent 的 session.header 是 getter 且抛错时，也要能靠注册表判定
  const throwyAgent = {
    id: 'sub-no-header',
    get session() {
      throw new Error('session unavailable')
    },
  }
  const run4 = setup({ everyNSteps: 2 }, registry)
  const d4 = await run4(payloadOf(2, 1, { agent: throwyAgent }), base)
  assert.equal(d4.messages.length, 1, 'header 读不到且注册表不认识该 id 时不误伤')
}

// 11f. header 明确说是子智能体时，优先级高于注册表（不必依赖注册表）
{
  const registry = { roots: () => [{ id: 'sub2', session: { id: 'sub2' } }], get: () => undefined }
  const run = setup({ everyNSteps: 2 }, registry)
  const sub = { id: 'sub2', session: { id: 'sub2', header: { id: 'sub2', origin: 'subagent' } } }
  const d = await run(payloadOf(2, 1, { agent: sub }), base)
  assert.equal(d.messages.length, 0, 'header 说是子智能体就按子智能体处理')
}

// 11b. mainAgentOnly=false 时子智能体也汇报（旧行为，可切回去）
{
  const run = setup({ everyNSteps: 2, mainAgentOnly: false })
  const sub = { id: 'sub', session: { header: { id: 's2', origin: 'subagent', parentSession: 's1' } } }
  const d = await run(payloadOf(2, 1, { agent: sub }), base)
  assert.equal(d.messages.length, 1, '关掉限制后子智能体也汇报')
}

// 11c. 主智能体与子智能体各自计数，互不干扰
{
  const run = setup({ everyNSteps: 3 })
  const mainAgent = { id: 'main', session: { header: { id: 's1' } } }
  const sub = { id: 'sub', session: { header: { id: 's2', origin: 'subagent' } } }
  const mainSteps = []
  const subSteps = []
  for (let step = 1; step <= 6; step++) {
    mainSteps.push((await run(payloadOf(step, 1, { agent: mainAgent }), base)).messages.length)
    subSteps.push((await run(payloadOf(step, 1, { agent: sub }), base)).messages.length)
  }
  assert.deepEqual(mainSteps, [0, 0, 1, 0, 0, 1], '主智能体按自己的步数汇报')
  assert.deepEqual(subSteps, [0, 0, 0, 0, 0, 0], '子智能体一次都不汇报')
}

// ── 甲方案：turn-stopping 自动续跑 + 四道刹车 ────────────────────────────
// 这一组是本插件唯一可能让对话停不下来的地方，所以每条刹车都单独钉住。

/** 把「第 step 步刚汇报完、模型就此停下」这个场景搭出来。 */
async function stopAtCheckpoint(config, { step = 10, turn = 1, registry, resumeable } = {}) {
  const run = setup(config, registry)
  const { agent, steered } = resumeable ?? steerableAgent()
  // 先走 pre-step 注入汇报提示，让状态记住「本轮在 step 步汇报过」。
  const d = await run(payloadOf(step, turn, { agent }), base)
  assert.equal(d.messages.length, 1, `第 ${step} 步应注入一次汇报提示`)
  const stop = turnStoppingHandler()
  stop({ agent, turn, signal: { aborted: false } })
  return { steered, agent, state: d }
}

// 12a. 正常形态：停在检查点上 → 会被拉回来一次
{
  const { steered } = await stopAtCheckpoint({ everyNSteps: 10 })
  assert.equal(steered.length, 1, '停在检查点时应 steer 一次续跑提示')
  const text = steered[0].content[0].text
  assert.ok(text.includes('续跑检查'), '续跑提示应带明确标记')
  assert.ok(text.includes('任务已完成'), '续跑提示必须留出「已完成」的退出出口')
}

// 12b. 刹车二：次数上限（默认 2）用完就不再拉
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  // 先注入第 10 步的汇报提示
  await run(payloadOf(10, 1, { agent }), base)
  // 反复触发 turn-stopping：每次都模拟「又停下了」
  for (let i = 0; i < 5; i++) stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 2, '默认上限 2：最多自动拉回两次，之后放手')
}

// 12c. 刹车二：把上限设成 0 等于彻底关闭自动续跑
{
  const { steered } = await stopAtCheckpoint({ everyNSteps: 10, maxAutoResumesPerTurn: 0 })
  assert.equal(steered.length, 0, '上限为 0 时一次都不续跑')
}

// 12d. 总开关 autoResume=false 时不续跑（只保留提示词引导）
{
  const { steered } = await stopAtCheckpoint({ everyNSteps: 10, autoResume: false })
  assert.equal(steered.length, 0, '关掉 autoResume 后不续跑')
}

// 12e. 刹车一：没到检查点就停（正常收尾）→ 绝不能拉回来
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  // 第 10 步汇报后模型继续干活，到第 17 步才自然收尾
  await run(payloadOf(10, 1, { agent }), base)
  await run(payloadOf(17, 1, { agent }), base)
  stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 0, '已经离检查点很远时视为正常收尾，不干预')
}

// 12f. 刹车一：这一步从没汇报过 → 不干预
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  // 只在第 3 步跑过，第 3 步不是检查点（10 的倍数），所以没有注入
  const d = await run(payloadOf(3, 1, { agent }), base)
  assert.equal(d.messages.length, 0)
  stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 0, '没有汇报记录时不续跑')
}

// 12g. 刹车三：本轮已被取消 → 绝不复活
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  await run(payloadOf(10, 1, { agent }), base)
  stop({ agent, turn: 1, signal: { aborted: true } })
  assert.equal(steered.length, 0, 'signal 已中止时不续跑')
}

// 12h. 刹车四：子智能体既不汇报也不续跑
{
  const run = setup({ everyNSteps: 10 })
  const sub = steerableAgent({
    id: 'sub',
    session: { id: 'sub', header: { id: 'sub', origin: 'subagent' } },
  })
  const stop = turnStoppingHandler()
  // 子智能体连提示词都收不到，自然也没有汇报记录
  const d = await run(payloadOf(10, 1, { agent: sub.agent }), base)
  assert.equal(d.messages.length, 0)
  stop({ agent: sub.agent, turn: 1, signal: { aborted: false } })
  assert.equal(sub.steered.length, 0, '子智能体不续跑')
}

// 12i. 插件关闭时不续跑
{
  const run = setup({ everyNSteps: 10, enabled: false })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  const d = await run(payloadOf(10, 1, { agent }), base)
  assert.equal(d.messages.length, 0, '关闭时不注入汇报提示')
  stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 0, '插件关闭时既不汇报也不续跑')
}

// 12j. 换轮之后上一轮的续跑配额与痕迹都清空
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent()
  const stop = turnStoppingHandler()
  // 第 1 轮：用光配额
  await run(payloadOf(10, 1, { agent }), base)
  for (let i = 0; i < 5; i++) stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 2)
  // 第 2 轮重新计数：第 10 步汇报后又能拉回
  await run(payloadOf(10, 2, { agent }), base)
  stop({ agent, turn: 2, signal: { aborted: false } })
  assert.equal(steered.length, 3, '新一轮重新发放续跑配额')
}

// 12k. turn-stopping 里 agent 没有 steer / 传空 payload 时不能抛错
{
  setup({ everyNSteps: 10 })
  const stop = turnStoppingHandler()
  assert.doesNotThrow(() => stop(undefined))
  assert.doesNotThrow(() => stop({}))
  assert.doesNotThrow(() => stop({ agent: { id: 'x' }, turn: 1, signal: { aborted: false } }))
  const throwing = {
    id: 'y',
    steer() {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(
    () => stop({ agent: throwing, turn: 1, signal: { aborted: false } }),
    'steer 抛错也不许弄坏主循环',
  )
}

// 12l. steer 抛错后不会重复计数（记账在 steer 之前）
{
  const run = setup({ everyNSteps: 10 })
  let calls = 0
  const agent = {
    id: 'main',
    session: {
      id: 'main',
      header: { id: 'main' },
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '进度说明……' }] }],
    },
    steer() {
      calls += 1
      throw new Error('boom')
    },
  }
  const stop = turnStoppingHandler()
  await run(payloadOf(10, 1, { agent }), base)
  for (let i = 0; i < 5; i++) stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(calls, 2, '即使 steer 一直抛错，配额也只消耗到上限为止')
}

// 12m. shouldAutoResume 纯函数直测（不经过事件，钉住每条判据）
{
  const okState = {
    turn: 1,
    step: 10,
    injectedTurn: 1,
    injectedStep: 10,
    autoResumes: 0,
    resumedStep: 0,
  }
  const opts = { enabled: true, autoResume: true, maxAutoResumesPerTurn: 2 }
  // endedWithToolCall: false = 确证是纯文本收尾（该救）；undefined / true 都不救。
  const baseInput = {
    state: okState,
    turn: 1,
    opts,
    aborted: false,
    isSubagent: false,
    endedWithToolCall: false,
  }
  assert.equal(shouldAutoResume(baseInput), true, '基准场景应续跑')

  assert.equal(shouldAutoResume({ ...baseInput, isSubagent: true }), false, '子智能体不续跑')
  assert.equal(shouldAutoResume({ ...baseInput, aborted: true }), false, '取消后不续跑')
  assert.equal(
    shouldAutoResume({ ...baseInput, opts: { ...opts, autoResume: false } }),
    false,
    '开关关闭不续跑',
  )
  assert.equal(
    shouldAutoResume({ ...baseInput, opts: { ...opts, enabled: false } }),
    false,
    '插件关闭不续跑',
  )
  assert.equal(
    shouldAutoResume({ ...baseInput, opts: { ...opts, maxAutoResumesPerTurn: 0 } }),
    false,
    '上限 0 不续跑',
  )
  assert.equal(
    shouldAutoResume({
      ...baseInput,
      state: { ...okState, autoResumes: 2 },
    }),
    false,
    '配额用尽不续跑',
  )
  assert.equal(
    shouldAutoResume({ ...baseInput, turn: 2 }),
    false,
    '跨轮不续跑（injectedTurn 不匹配）',
  )
  assert.equal(
    shouldAutoResume({ ...baseInput, state: { ...okState, step: 17 } }),
    false,
    '已离检查点很远时不续跑',
  )
  assert.equal(
    shouldAutoResume({ ...baseInput, state: { ...okState, injectedStep: 0 } }),
    false,
    '没有汇报记录时不续跑',
  )
  assert.equal(shouldAutoResume({ ...baseInput, state: undefined }), false, '无状态不续跑')
  assert.equal(shouldAutoResume({ ...baseInput, opts: undefined }), false, '无配置不续跑')
  assert.equal(shouldAutoResume(undefined), false, '空输入不续跑')

  // 上一次续跑落下的那一步也算「刚停下」，避免续跑一次后模型再次纯文本收尾时救不回来。
  assert.equal(
    shouldAutoResume({
      ...baseInput,
      state: { ...okState, step: 11, resumedStep: 11 },
    }),
    true,
    '停在续跑之后的那一步时也应再救一次（受配额限制）',
  )
}

// 12n. 刹车五：以 tool call 收尾（工具自己结束了轮次）→ 不救，哪怕正停在检查点上
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent({
    session: {
      id: 'main',
      header: { id: 'main' },
      // 最后一条 assistant 消息带 tool-call = 工具自己收尾，属正常结束。
      deriveMessages: () => [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '进度说明……' },
            { type: 'tool-call', toolName: 'todo_write', input: {} },
          ],
        },
      ],
    },
  })
  const stop = turnStoppingHandler()
  await run(payloadOf(10, 1, { agent }), base)
  stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 0, '工具自己收尾时不许强行续跑')
}

// 12o. 刹车五的保守面：读不出结束形态（没有 deriveMessages / 抛错）→ 不救
{
  const run = setup({ everyNSteps: 10 })
  const stop = turnStoppingHandler()

  // 有 session 但没有 deriveMessages。
  const noDerive = steerableAgent({ session: { id: 'main', header: { id: 'main' } } })
  await run(payloadOf(10, 1, { agent: noDerive.agent }), base)
  stop({ agent: noDerive.agent, turn: 1, signal: { aborted: false } })
  assert.equal(noDerive.steered.length, 0, '读不出结束形态时宁可不救')

  // deriveMessages 抛错。
  const setup2 = setup({ everyNSteps: 10 })
  const boomer = steerableAgent({
    session: {
      id: 'main',
      header: { id: 'main' },
      deriveMessages() {
        throw new Error('boom')
      },
    },
  })
  await setup2(payloadOf(10, 1, { agent: boomer.agent }), base)
  stop({ agent: boomer.agent, turn: 1, signal: { aborted: false } })
  assert.equal(boomer.steered.length, 0, 'deriveMessages 抛错时宁可不救')

  // 整个 agent 连 session 都没有。
  const run3 = setup({ everyNSteps: 10 })
  const bare = { id: 'main', steer() { bare.count = (bare.count ?? 0) + 1 } }
  await run3(payloadOf(10, 1, { agent: bare }), base)
  stop({ agent: bare, turn: 1, signal: { aborted: false } })
  assert.equal(bare.count ?? 0, 0, '没有 session 时宁可不救')
}

// 12p. endedWithToolCall 纯函数直测
{
  const withTool = { session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'tool-call' }] }] } }
  const withoutTool = { session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] } }
  assert.equal(endedWithToolCall(withTool), true, '带 tool-call 判 true')
  assert.equal(endedWithToolCall(withoutTool), false, '纯文本判 false')
  assert.equal(endedWithToolCall(undefined), undefined, '没 agent 判不了')
  assert.equal(endedWithToolCall({}), undefined, '没 session 判不了')
  assert.equal(endedWithToolCall({ session: {} }), undefined, '没有 deriveMessages 判不了')
  assert.equal(endedWithToolCall({ session: { deriveMessages: () => [] } }), undefined, '空历史判不了')
  assert.equal(
    endedWithToolCall({
      session: {
        deriveMessages: () => {
          throw new Error('boom')
        },
      },
    }),
    undefined,
    '抛错判不了',
  )

  // 尾部可能还挂着用户的续跑消息，要能跳过它们找到最后一条 assistant。
  const trailingUser = {
    session: {
      deriveMessages: () => [
        { role: 'assistant', content: [{ type: 'text', text: '进度' }] },
        { role: 'user', content: [{ type: 'text', text: '[自动 · 分步暂停 · 续跑检查]' }] },
      ],
    },
  }
  assert.equal(endedWithToolCall(trailingUser), false, '跳过尾部 user 消息，取最后一条 assistant')
}

// 12q. declaredComplete 纯函数直测：只认收尾处的宣告
{
  const withText = (text) => ({
    session: { deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text }] }] },
  })

  assert.equal(declaredComplete(withText('都做完了。\n\n任务已完成。')), true, '结尾写「任务已完成」应判完成')
  assert.equal(declaredComplete(withText('任务已完成。')), true, '只有一行也认得')
  assert.equal(declaredComplete(withText('原任务确实已全部完成，无需继续。')), true, '变体写法也认得')
  assert.equal(declaredComplete(withText('All done.')), true, '英文也认得')

  // 进度汇报里的「已完成什么：」不能误判成完成。
  assert.equal(
    declaredComplete(
      withText('1. 正在做什么：写文件\n2. 已完成什么：创建了 t1.txt\n3. 接下来做什么：创建 t2.txt'),
    ),
    false,
    '正文里的「已完成」不算完成',
  )
  // 完成宣告必须落在收尾处，正文中间提到不算。
  assert.equal(
    declaredComplete(withText('任务已完成的意思是全部做完。\n现在继续创建 t4.txt。')),
    false,
    '正文中间提到不算完成（收尾处还在干活）',
  )
  assert.equal(declaredComplete(withText('')), false, '空文本不判完成')
  assert.equal(declaredComplete(undefined), false, '没 agent 不判完成')
  assert.equal(declaredComplete({}), false, '没 session 不判完成')
  assert.equal(
    declaredComplete({
      session: {
        deriveMessages() {
          throw new Error('boom')
        },
      },
    }),
    false,
    '抛错不判完成（保守方向：宁可继续跑也不误判完成）',
  )
  assert.equal(
    declaredComplete({
      session: {
        deriveMessages: () => [
          { role: 'assistant', content: [{ type: 'text', text: '任务已完成。' }] },
          { role: 'user', content: [{ type: 'text', text: '[自动 · 分步暂停 · 续跑检查]' }] },
        ],
      },
    }),
    true,
    '跳过尾部 user 消息，取最后一条 assistant',
  )

  // 否定词：marker 是纯子串，'全部完成' 正好在「尚未全部完成」里。
  // 少这道检查，插件会在最该续跑的时刻放手。
  assert.equal(declaredComplete(withText('尚未全部完成，下一步继续处理 t3。')), false, '「尚未全部完成」不是完成')
  assert.equal(declaredComplete(withText('还没全部完成')), false, '「还没全部完成」不是完成')
  assert.equal(declaredComplete(withText('not all done yet')), false, '「not all done」不是完成')

  // marker 后面还跟着「继续/接下来」：那是在说下一步，不是在收尾。
  assert.equal(declaredComplete(withText('全部完成，现在继续创建 t4.txt。')), false, '宣告后还要继续，不算收尾')
  assert.equal(declaredComplete(withText('任务已完成。接下来处理 t5。')), false, '「接下来」同理')

  // 但被否掉的「无需继续」是收尾的一部分，不能因此误拒。
  assert.equal(
    declaredComplete(withText('原任务确实已全部完成，无需继续。')),
    true,
    '「无需继续」不应被当成还要干活',
  )
}

// 12r. 刹车六：模型宣告完成后，即使停在检查点也不救
{
  const run = setup({ everyNSteps: 10 })
  const { agent, steered } = steerableAgent({
    session: {
      id: 'main',
      header: { id: 'main' },
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '任务已完成。' }] }],
    },
  })
  const stop = turnStoppingHandler()
  await run(payloadOf(10, 1, { agent }), base)
  stop({ agent, turn: 1, signal: { aborted: false } })
  assert.equal(steered.length, 0, '模型说完成了就不许再拉回来')
}

// 12s. shouldAutoResume 的 declaredDone 判据直测
{
  const state = {
    turn: 1,
    step: 10,
    injectedTurn: 1,
    injectedStep: 10,
    autoResumes: 0,
    resumedStep: 0,
  }
  const opts = { enabled: true, autoResume: true, maxAutoResumesPerTurn: 2 }
  const baseInput = {
    state,
    turn: 1,
    opts,
    aborted: false,
    isSubagent: false,
    endedWithToolCall: false,
  }
  assert.equal(shouldAutoResume({ ...baseInput, declaredDone: true }), false, '宣告完成后不续跑')
  assert.equal(shouldAutoResume({ ...baseInput, declaredDone: false }), true, '没宣告完成才续跑')
  assert.equal(shouldAutoResume({ ...baseInput, declaredDone: undefined }), true, '未提供该字段时按未宣告处理')
}

// 13. 修饰决策时必须保留下游的其它字段（官方 agent-lifecycle 契约：
//     「listeners wrapping next() preserve downstream messages and startsRequestSeries
//      unless replacement is intentional」）。
{
  const run = setup({ everyNSteps: 2 })
  const decision = {
    kind: 'enter',
    messages: [],
    startsRequestSeries: true,
    futureField: 'keep-me',
  }
  const out = await run(payloadOf(2, 1), decision)
  assert.equal(out.kind, 'enter')
  assert.equal(out.messages.length, 1, '应追加一条提示')
  assert.equal(out.startsRequestSeries, true, 'startsRequestSeries 必须原样保留')
  assert.equal(out.futureField, 'keep-me', '未知字段也必须原样保留')
  assert.equal(decision.messages.length, 0, '不得就地修改下游决策对象')
}

// 13b. 不干预的路径必须**原样返回同一个对象**，不能包装成新对象。
{
  const run = setup({ everyNSteps: 3 })
  const decision = { kind: 'enter', messages: [], startsRequestSeries: true }
  const out = await run(payloadOf(1, 1), decision)
  assert.equal(out, decision, '不干预时必须返回原对象')
}

console.log('all green')
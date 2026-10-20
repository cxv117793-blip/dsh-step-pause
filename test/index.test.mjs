/**
 * dsh-step-pause 的离线行为测试（不接触运行中的 profile）。
 * 用法：npm test（或 node test/index.test.mjs）
 */
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'

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
  assert.equal(handlers.length, 1, '应只注册一个 pre-step 监听器')
  const h = handlers[0]
  assert.equal(h.name, 'agent/pre-step')
  assert.deepEqual(h.opts, { prepend: true })
  return async (payload, decision) => h.fn(payload, async () => decision)
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
  const run = setup({ everyNSteps: 1 })
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
  const run = setup({ everyNSteps: 1, showPromptInChat: true })
  const d = await run(payloadOf(2), base)
  assert.equal(d.messages[0].source.kind, 'user', '开启时应显示')
}

// 4. 保留原批次顺序，自己的消息追加在尾部
{
  const run = setup({ everyNSteps: 1 })
  const existing = [{ id: 'x1', role: 'user', content: [], source: { kind: 'user' } }]
  const d = await run(payloadOf(2), { kind: 'enter', messages: existing })
  assert.equal(d.messages.length, 2)
  assert.equal(d.messages[0], existing[0])
  assert.equal(d.messages[1].source.kind, 'step-pause')
  assert.deepEqual(existing, [{ id: 'x1', role: 'user', content: [], source: { kind: 'user' } }], '不得改动原批次')
}

// 5. reject / aborted / 非 enter 一律原样返回
{
  const run = setup({ everyNSteps: 1 })
  const reject = { kind: 'reject' }
  assert.equal(await run(payloadOf(2), reject), reject)
  const aborted = await run(payloadOf(2, 1, { signal: { aborted: true } }), base)
  assert.deepEqual(aborted, base)
  const weird = await run(payloadOf(2), { kind: 'enter' })
  assert.deepEqual(weird, { kind: 'enter' })
}

// 6. 每个轮次重置计数与汇报配额
{
  const run = setup({ everyNSteps: 1, maxReportsPerTurn: 2 })
  const counts = []
  for (const [turn, step] of [[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]]) {
    const d = await run(payloadOf(step, turn), base)
    counts.push(d.messages.length)
  }
  assert.deepEqual(counts, [0, 1, 1, 0, 1, 1], '每轮最多 2 次（第 1 步不报），换轮重置')
}

// 7. 自定义提示词占位符
{
  const run = setup({ everyNSteps: 2, prompt: 'S={{step}} E={{every}} T={{turn}}' })
  const d = await run(payloadOf(4, 3), base)
  assert.equal(d.messages[0].content[0].text, 'S=4 E=2 T=3')
}

// 8. enabled=false 仍然注册，但一次都不注入（可以热开关，不用重载插件）
{
  const run = setup({ enabled: false, everyNSteps: 1 })
  const d = await run(payloadOf(2), base)
  assert.equal(d.messages.length, 0, '关掉后不注入')
  assert.equal(d, base)
}

// 9. 配置 schema：六个字段都是 .volatile()（设置页只认 volatile 字段），默认值不变
{
  const defaults = Config({})
  for (const key of [
    'enabled',
    'everyNSteps',
    'maxReportsPerTurn',
    'prompt',
    'showPromptInChat',
    'mainAgentOnly',
  ]) {
    assert.equal(typeof defaults[key], 'object', key + ' 应是 volatile 引用')
    assert.equal(typeof defaults[key].get, 'function', key + ' 应能 get()')
  }
  assert.equal(defaults.everyNSteps.get(), 10)
  assert.equal(defaults.enabled.get(), true)
  assert.equal(defaults.maxReportsPerTurn.get(), 0)
  assert.equal(defaults.showPromptInChat.get(), false, '默认隐藏提示词原文')
  assert.equal(defaults.mainAgentOnly.get(), true, '默认只在主智能体里汇报')
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
  const run = setup({ everyNSteps: 1 })
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
  const run = setup({ everyNSteps: 1 }, registry)
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
  const run = setup({ everyNSteps: 1 }, registry)
  const d = await run(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d.messages.length, 1, '注册表不认识这个 agent 时按主智能体处理')

  // roots 为空（注册表还没登记任何 agent）同样不误伤
  const emptyRegistry = { roots: () => [], get: () => undefined }
  const run2 = setup({ everyNSteps: 1 }, emptyRegistry)
  const d2 = await run2(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d2.messages.length, 1, 'roots 为空时按主智能体处理')

  // 注册表本身抛错也不能弄坏主循环
  const boomRegistry = {
    roots: () => {
      throw new Error('boom')
    },
    get: () => undefined,
  }
  const run3 = setup({ everyNSteps: 1 }, boomRegistry)
  const d3 = await run3(payloadOf(2, 1, { agent: mainAgent }), base)
  assert.equal(d3.messages.length, 1, '注册表抛错时按主智能体处理')

  // agent 的 session.header 是 getter 且抛错时，也要能靠注册表判定
  const throwyAgent = {
    id: 'sub-no-header',
    get session() {
      throw new Error('session unavailable')
    },
  }
  const run4 = setup({ everyNSteps: 1 }, registry)
  const d4 = await run4(payloadOf(2, 1, { agent: throwyAgent }), base)
  assert.equal(d4.messages.length, 1, 'header 读不到且注册表不认识该 id 时不误伤')
}

// 11f. header 明确说是子智能体时，优先级高于注册表（不必依赖注册表）
{
  const registry = { roots: () => [{ id: 'sub2', session: { id: 'sub2' } }], get: () => undefined }
  const run = setup({ everyNSteps: 1 }, registry)
  const sub = { id: 'sub2', session: { id: 'sub2', header: { id: 'sub2', origin: 'subagent' } } }
  const d = await run(payloadOf(2, 1, { agent: sub }), base)
  assert.equal(d.messages.length, 0, 'header 说是子智能体就按子智能体处理')
}

// 11b. mainAgentOnly=false 时子智能体也汇报（旧行为，可切回去）
{
  const run = setup({ everyNSteps: 1, mainAgentOnly: false })
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

console.log('all green')
/**
 * dsh-step-pause 的离线行为测试（不接触运行中的 profile）。
 * 用法：npm test（或 node test/index.test.mjs）
 */
import assert from 'node:assert/strict'
import { apply, Config } from '../lib/index.js'

const handlers = []
const fakeCtx = {
  on(name, fn, opts) {
    handlers.push({ name, fn, opts })
    return () => {}
  },
}

function setup(config) {
  handlers.length = 0
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

// 9. 配置 schema：五个字段都是 .volatile()（设置页只认 volatile 字段），默认值不变
{
  const defaults = Config({})
  for (const key of ['enabled', 'everyNSteps', 'maxReportsPerTurn', 'prompt', 'showPromptInChat']) {
    assert.equal(typeof defaults[key], 'object', key + ' 应是 volatile 引用')
    assert.equal(typeof defaults[key].get, 'function', key + ' 应能 get()')
  }
  assert.equal(defaults.everyNSteps.get(), 10)
  assert.equal(defaults.enabled.get(), true)
  assert.equal(defaults.maxReportsPerTurn.get(), 0)
  assert.equal(defaults.showPromptInChat.get(), false, '默认隐藏提示词原文')
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

console.log('all green')

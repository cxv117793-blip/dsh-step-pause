/**
 * 客户端回归测试：用一个最小 React 运行时把 lib/client.js 真挂起来。
 *
 * lib/client.js 是浏览器半边，通过 window.__ModuleLoader__.load({id, factory})
 * 注册，factory(require) 里 require('react') / require('react/jsx-runtime')。
 * 它导出的 apply(ctx) 注册 slot，slot 的组件是 StepPausePage。
 *
 * 这里做的事：
 *   1. 手搓一个够用的 react（useState/useEffect/useRef），支持稳定化重渲染；
 *   2. 手搓 jsx/jsxs，直接产出可断言的节点树；
 *   3. 假 ctx（locale / effect / slots / configForms），把 apply() 跑起来，
 *      从 slots.register 拿回组件；
 *   4. 逐条断言缺陷修复后的行为。
 *
 * 渲染为什么要「稳定化」：effect 里 setState 之后，真实 React 会再渲染一遍；
 * 这个 stub 不会自动重入，所以 renderRoot 反复渲染到某一轮不再有 effect 执行为止。
 * 少了这一步，「外部 revision 变化时保留草稿」这类在 effect 里改状态的修复就测不到。
 */
import fs from 'node:fs'
import assert from 'node:assert/strict'

// ── 最小 React 运行时 ──────────────────────────────────────────────────
const hooks = { list: [], cursor: 0, effectRuns: 0 }

function installHooks() {
  hooks.cursor = 0
}

function useState(initial) {
  const i = hooks.cursor++
  if (!(i in hooks.list)) hooks.list[i] = typeof initial === 'function' ? initial() : initial
  const set = (next) => {
    const value = typeof next === 'function' ? next(hooks.list[i]) : next
    if (Object.is(value, hooks.list[i])) return
    hooks.list[i] = value
  }
  return [hooks.list[i], set]
}

function useEffect(fn, deps) {
  const i = hooks.cursor++
  const prev = hooks.list[i]
  const same =
    prev !== undefined &&
    deps !== undefined &&
    prev.deps.length === deps.length &&
    deps.every((d, k) => Object.is(d, prev.deps[k]))
  if (same) return
  hooks.list[i] = { deps, cleanup: fn() }
  hooks.effectRuns += 1
}

function useRef(initial) {
  const i = hooks.cursor++
  if (!(i in hooks.list)) hooks.list[i] = { current: initial }
  return hooks.list[i]
}

// ── 最小 jsx 运行时 ────────────────────────────────────────────────────
const flatten = (children) => {
  const out = []
  const walk = (c) => {
    if (c === null || c === undefined || c === false || c === true) return
    if (Array.isArray(c)) {
      c.forEach(walk)
      return
    }
    out.push(c)
  }
  walk(children)
  return out
}
const makeNode = (type, props) => ({ type, props: { ...props, children: flatten(props?.children) } })
const jsx = (type, props) => makeNode(type, props ?? {})
const jsxs = (type, props) => makeNode(type, props ?? {})

const reactStub = { useState, useEffect, useRef, createElement: jsx }

// ── 假模块加载器 ────────────────────────────────────────────────────────
let exported = null
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      exported = factory((id) => {
        if (id === 'react') return reactStub
        if (id === 'react/jsx-runtime') return { jsx, jsxs }
        throw new Error('unknown module: ' + id)
      })
      return exported
    }
  }
}

new Function(fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))()
assert.ok(exported, 'client.js 没有导出任何东西')

// ── 假 ctx ────────────────────────────────────────────────────────────
let registeredSlot = null
const formController = {
  snapshot: null,
  subscribers: [],
  calls: [],
  getSnapshot() {
    return this.snapshot
  },
  subscribe(fn) {
    this.subscribers.push(fn)
    return () => {
      this.subscribers = this.subscribers.filter((f) => f !== fn)
    }
  },
  emit() {
    this.subscribers.slice().forEach((fn) => fn())
  },
  bump(patch) {
    this.snapshot = { ...this.snapshot, ...patch, revision: this.snapshot.revision + 1 }
    this.emit()
  },
  async mutate(ops, revision) {
    this.calls.push({ kind: 'mutate', ops, revision })
    return true
  },
  async unset(key) {
    this.calls.push({ kind: 'unset', key })
    // 真实 Host 的 unset 会推动 revision —— 这正是缺陷 1 的触发条件：
    // 如果不占用 inFlight，revision 变化的 effect 会把别处草稿清掉。
    // 假实现必须复刻这一步，否则那条用例永远绿、等于没测。
    const nextValue = { ...this.snapshot.value }
    delete nextValue[key]
    this.bump({ value: nextValue })
    return true
  }
}

const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => {}
  },
  effect: (fn) => fn(),
  slots: {
    inject: (_name, fn) => fn(),
    register: (_meta, Comp) => {
      registeredSlot = Comp
      return () => {}
    }
  },
  configForms: {
    get: () => formController,
    whileServed: (_namespaces, fn) => fn()
  }
}

exported.apply(ctx)
assert.ok(registeredSlot, 'apply() 没有注册任何 slot 组件')
const component = registeredSlot

// ── 渲染 ───────────────────────────────────────────────────────────────
let root = null

// 展开函数子组件（Field 等）。根组件由 renderRoot 自己带 hook 上下文渲染。
function expand(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') {
    if (node.type === component) return node
    return expand(node.type(node.props))
  }
  return { ...node, props: { ...node.props, children: (node.props.children ?? []).map(expand) } }
}

// 反复渲染，直到某一轮没有 effect 执行（=状态稳定）。
function renderRoot() {
  for (let round = 0; round < 8; round++) {
    hooks.effectRuns = 0
    installHooks()
    root = expand(component({ stepPause: { controller: formController, t: (k) => k } }))
    if (hooks.effectRuns === 0) break
  }
  return root
}

// ── 查询工具 ───────────────────────────────────────────────────────────
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.props?.children ?? []).map(textOf).join('')
}

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, pred, out))
    return out
  }
  if (pred(node)) out.push(node)
  ;(node.props?.children ?? []).forEach((n) => findAll(n, pred, out))
  return out
}

const buttons = () => findAll(root, (n) => n.type === 'button')
const inputs = () => findAll(root, (n) => n.type === 'input' || n.type === 'textarea')
const byText = (txt) => {
  const hit = buttons().find((b) => textOf(b) === txt)
  assert.ok(hit, `没找到按钮「${txt}」，现有：${buttons().map((b) => JSON.stringify(textOf(b))).join(', ')}`)
  return hit
}
const numBox = (placeholder) => {
  const hit = inputs().find((n) => n.type === 'input' && String(n.props.placeholder) === placeholder)
  assert.ok(hit, `没找到 placeholder=${placeholder} 的数字框`)
  return hit
}
const promptArea = () => {
  const hit = inputs().find((n) => n.type === 'textarea')
  assert.ok(hit, '没找到 prompt 文本域')
  return hit
}
const resetButtons = () => buttons().filter((b) => /overridden/.test(textOf(b)))

function setSnapshot(patch = {}) {
  // 每个用例都从干净的状态树开始：hooks 按索引存，跨用例复用会把
  // phase="saving" 之类的中间态带进下一个用例。
  hooks.list.length = 0
  hooks.cursor = 0
  formController.calls.length = 0
  formController.subscribers.length = 0
  formController.snapshot = {
    status: 'ready',
    writable: true,
    revision: 0,
    value: {
      enabled: true,
      everyNSteps: 20,
      maxReportsPerTurn: 0,
      autoResume: true,
      maxAutoResumesPerTurn: 2,
      mainAgentOnly: true,
      showPromptInChat: false
    },
    user: {},
    ...patch
  }
  root = renderRoot()
}

// ── 断言 ───────────────────────────────────────────────────────────────
const results = []
// 用例必须串行：每个用例都会重设 formController 与 hooks，
// 并行跑会让后一个用例把前一个的调用记录清掉，报出误导性的失败。
let chain = Promise.resolve()
function check(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn()
      results.push(['PASS', name])
    } catch (e) {
      results.push(['FAIL', name + ' — ' + e.message])
    }
  })
  return chain
}

check('页面渲染出四个开关、三个数字框、一个 prompt 文本域', () => {
  setSnapshot()
  // 无覆盖时：4 个开关 + 保存 + 放弃 = 6 个按钮，没有「恢复默认」。
  assert.equal(buttons().length, 6, '按钮数量 ' + buttons().length)
  assert.equal(inputs().length, 4, '数字框 3 个 + prompt 文本域 1 个，实际 ' + inputs().length)
})

check('未覆盖任何值时，不出现「恢复默认」按钮', () => {
  setSnapshot()
  assert.equal(resetButtons().length, 0, '不该有重置按钮，实际 ' + resetButtons().length)
})

check('有 user 覆盖时，只给被覆盖的那个字段显示「恢复默认」', () => {
  setSnapshot({ user: { everyNSteps: 10 } })
  assert.equal(resetButtons().length, 1, '只有 everyNSteps 被覆盖，应恰好 1 个，实际 ' + resetButtons().length)
})

check('缺陷2：放弃修改会清掉数字框里残留的文本', () => {
  setSnapshot()
  numBox('20').props.onChange({ target: { value: '40' } })
  root = renderRoot()
  assert.equal(numBox('20').props.value, '40', '输入后应显示 40')
  byText('discard').props.onClick()
  root = renderRoot()
  assert.equal(numBox('20').props.value, '20', '放弃后应回到真实值 20')
})

check('缺陷4：清空 prompt 保存时发 unset，而不是把空串写进配置', async () => {
  // value 是「当前生效值」，prompt 已经有一个自定义值；user 说明它是被覆盖过的。
  const promptValue = '旧的自定义提示词'
  setSnapshot({
    value: { ...formController.snapshot?.value, prompt: promptValue },
    user: { prompt: promptValue }
  })
  promptArea().props.onChange({ target: { value: '   ' } })
  root = renderRoot()
  await byText('save').props.onClick()
  const m = formController.calls.find((c) => c.kind === 'mutate')
  assert.ok(m, '保存应调用 mutate')
  const op = m.ops.find((o) => o.path[0] === 'prompt')
  assert.ok(op, 'mutate 里应有 prompt，实际 ' + JSON.stringify(m.ops))
  assert.equal(op.op, 'unset', 'prompt 应发 unset，实际 ' + JSON.stringify(op))
})

check('缺陷3：外部更新时保留本地草稿，不清空', () => {
  setSnapshot()
  numBox('20').props.onChange({ target: { value: '33' } })
  root = renderRoot()
  assert.equal(numBox('20').props.value, '33', '输入后应显示 33')
  // 别的窗口保存了：revision 变化、值也变
  formController.bump({ value: { ...formController.snapshot.value, everyNSteps: 25 } })
  root = renderRoot()
  assert.equal(numBox('20').props.value, '33', '外部更新后本地草稿应保留 33，实际 ' + numBox('20').props.value)
})

check('缺陷1：点恢复默认清该键，但不连带清掉别处未保存的草稿', async () => {
  setSnapshot({ user: { enabled: false, everyNSteps: 40 } })
  promptArea().props.onChange({ target: { value: '我正在写的自定义提示词' } })
  root = renderRoot()
  assert.equal(promptArea().props.value, '我正在写的自定义提示词')

  formController.calls.length = 0
  const resetBtn = resetButtons()[0]
  assert.ok(resetBtn, '应有「恢复默认」按钮')
  await resetBtn.props.onClick()

  const unsetCall = formController.calls.find((c) => c.kind === 'unset')
  assert.ok(unsetCall, '恢复默认应调用 unset')
  root = renderRoot()
  assert.equal(
    promptArea().props.value,
    '我正在写的自定义提示词',
    '别处的草稿被连坐清掉了，实际 ' + JSON.stringify(promptArea().props.value)
  )
})

check('清空数字框：保存发 unset 而不是写 0', async () => {
  setSnapshot()
  numBox('20').props.onChange({ target: { value: '' } })
  root = renderRoot()
  formController.calls.length = 0
  await byText('save').props.onClick()
  const m = formController.calls.find((c) => c.kind === 'mutate')
  assert.ok(m, '保存应调用 mutate')
  const op = m.ops.find((o) => o.path[0] === 'everyNSteps')
  assert.ok(op && op.op === 'unset', '应发 unset，实际 ' + JSON.stringify(m.ops))
})

check('输入非法文本时不在草稿里写 NaN', () => {
  setSnapshot()
  numBox('20').props.onChange({ target: { value: 'abc' } })
  root = renderRoot()
  // 输入框显示原文，草稿存 undefined，保存时会 unset
  assert.equal(numBox('20').props.value, 'abc')
})

check('没改动时保存按钮是禁用的', () => {
  setSnapshot()
  assert.equal(byText('save').props.disabled, true, '未改动时保存应禁用')
})

// ── 汇总 ───────────────────────────────────────────────────────────────
await chain
const failed = results.filter((r) => r[0] === 'FAIL')
for (const [st, name] of results) console.log(`${st}  ${name}`)
console.log('')
if (failed.length) {
  console.log('client tests FAILED: ' + failed.length + '/' + results.length)
  process.exit(1)
}
console.log('client tests all green (' + results.length + ' checks)')

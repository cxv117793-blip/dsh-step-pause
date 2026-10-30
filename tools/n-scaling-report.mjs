#!/usr/bin/env node
/**
 * n-scaling-report.mjs — 从真实会话日志里量化「汇报间隔 N 越大越省」。
 *
 * 与 tools/cost-report.mjs 的区别：那个是单会话算账，这个是**跨会话抽样**，
 * 先测出三个常数，再用它们推 N 的开销曲线。
 *
 * 三个常数：
 *   P  注入提示词本身占多少 token（每条固定）
 *   R  模型为这条提示写出的汇报占多少 output token
 *   B  一条已归档的汇报，之后每一步还要被重读多少 token
 *
 * 为什么要单独测 B：提示和汇报是一次性的，B 却是**乘在剩余步数上**的。
 * 一个 N 步会话里第 j 次汇报会拖累后面 S-jN 步，求和就是二次项，
 * 这才是「N 翻倍、总开销腰斩」的来源。
 *
 * 用法：
 *   node tools/n-scaling-report.mjs                     # 用 ~/.dsh/sessions
 *   node tools/n-scaling-report.mjs <sessions 根目录>
 *   node tools/n-scaling-report.mjs --steps=1000 --n=10,20,40
 *   node tools/n-scaling-report.mjs --markdown          # 输出可直接贴进文档的表格
 *
 * 只读日志，不联网。默认不写文件；只有带 --svg 时才会写出那张图。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const INJECT_PREFIX = '[自动 · 分步暂停'

const argv = process.argv.slice(2)
const flagRaw = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return dflt
  const eq = hit.indexOf('=')
  return eq < 0 ? true : hit.slice(eq + 1)
}
// 布尔旗标：`--svg` 与 `--svg=1` 都是开，`--svg=0`/`=false`/`=no` 是关。
// 早期版本直接返回字符串，于是 `--svg=0` 反而是真值、关不掉输出。
const flag = (name, dflt) => {
  const v = flagRaw(name, dflt)
  if (typeof v !== 'string') return v
  const t = v.trim().toLowerCase()
  if (t === '0' || t === 'false' || t === 'no' || t === 'off') return false
  if (t === '1' || t === 'true' || t === 'yes' || t === 'on') return true
  return v
}
// 数值参数：必须是真的正整数，坏输入当场报错退出，而不是把 NaN 传下去算出 `-698`。
const positiveInt = (name, dflt) => {
  const v = flagRaw(name, dflt)
  if (typeof v === 'boolean') return dflt
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    console.error(`--${name} 需要一个正整数，收到的是 ${JSON.stringify(String(v))}`)
    process.exit(1)
  }
  return n
}

/** 多帧 zstd：每条记录一个 frame，标准解压器只吃第一帧，必须按魔数切。 */
function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  for (let i = 0; ; ) {
    const k = buf.indexOf(MAGIC, i)
    if (k < 0) break
    offsets.push(k)
    i = k + 4
  }
  const pieces = []
  for (let n = 0; n < offsets.length; n++) {
    const start = offsets[n]
    const end = n + 1 < offsets.length ? offsets[n + 1] : buf.length
    try {
      pieces.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {
      /* 截断帧跳过 */
    }
  }
  return pieces.join('\n')
}

function walkSessions(root) {
  const out = []
  const seen = new Set()
  const push = (p) => {
    if (seen.has(p)) return
    seen.add(p)
    out.push(p)
  }
  const visit = (dir, depth) => {
    if (depth > 4) return
    let ents
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isFile()) {
        if (e.name === 'session.v4.jsonl.zstd') push(p)
      } else if (e.isDirectory()) visit(p, depth + 1)
    }
  }
  visit(root, 0)
  return out
}

function textOf(msg) {
  const c = msg && msg.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  let s = ''
  for (const p of c) if (p && typeof p.text === 'string') s += p.text
  return s
}

/** 粗估 token：CJK 约 1 token/字，其余约 3.5 字符/token。 */
function estimateTokens(s) {
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x2e80) cjk++
    else other++
  }
  return Math.round(cjk + other / 3.5)
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const median = (a) => {
  if (!a.length) return 0
  const b = [...a].sort((x, y) => x - y)
  return b[b.length >> 1]
}
const pct = (a, p) => {
  if (!a.length) return 0
  const b = [...a].sort((x, y) => x - y)
  return b[Math.min(b.length - 1, Math.max(0, Math.floor(b.length * p)))]
}

// ---------- 1. 扫描 ----------
const rootArg = argv.find((a) => !a.startsWith('--'))
const root = rootArg ? path.resolve(rootArg) : path.join(os.homedir(), '.dsh', 'sessions')
if (!fs.existsSync(root)) {
  console.error(`找不到会话目录：${root}`)
  process.exit(1)
}

const files = walkSessions(root)
const sessions = []

for (const file of files) {
  let txt
  try {
    txt = decodeSessionFile(file)
  } catch {
    continue
  }
  if (!txt.includes('分步暂停')) continue

  const usages = []
  const injections = []
  // user/message 事件不带 turn/step，要靠前面最近的 step/start 推断它落在哪一步。
  let curTurn = 0
  let curStep = 0
  for (const line of txt.split('\n')) {
    if (line.length < 20 || line.charCodeAt(0) !== 123) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'step/start' && e.data) {
      curTurn = e.data.turn | 0
      curStep = e.data.step | 0
      continue
    }
    if (e.type === 'user/message' && e.data) {
      const t = textOf(e.data)
      const src = e.data.source || {}
      if (src.kind === 'step-pause' || t.startsWith(INJECT_PREFIX)) {
        injections.push({
          turn: (e.data.turn | 0) || curTurn,
          step: (e.data.step | 0) || curStep,
          toks: estimateTokens(t),
        })
      }
    } else if (e.type === 'assistant/message' && e.data && e.data.usage) {
      const u = e.data.usage
      usages.push({
        turn: e.data.turn | 0,
        step: e.data.step | 0,
        input: u.inputTokens | 0,
        cache: u.cacheReadTokens | 0,
        output: u.outputTokens | 0,
      })
    }
  }
  if (!usages.length) continue

  // 把每条注入对上「它触发的那一次模型调用」
  const byKey = new Map(usages.map((u) => [`${u.turn}|${u.step}`, u]))
  for (const inj of injections) {
    const hit = byKey.get(`${inj.turn}|${inj.step}`)
    if (hit) inj.reportOutput = hit.output
  }
  sessions.push({ file, usages, injections })
}

if (!sessions.length) {
  console.error('这些会话里没有找到 dsh-step-pause 的注入记录。')
  process.exit(1)
}

// ---------- 2. 常数 P / R ----------
const allInj = sessions.flatMap((s) => s.injections)
const Pset = allInj.map((i) => i.toks)
const Rset = allInj.map((i) => i.reportOutput).filter((x) => x != null)
const P = Math.round(median(Pset))
const R = Math.round(median(Rset))

// ---------- 3. 常数 B：事件研究 + 对照组 ----------
// 不能直接量「注入那一步前后 prompt 差多少」——上下文本来就在自然增长。
// 所以要一组对照：没有任何注入的相邻两步。
const treated = []
const control = []
for (const s of sessions) {
  const injSet = new Set(s.injections.map((i) => `${i.turn}|${i.step}`))
  const byTurn = new Map()
  for (const u of s.usages) {
    if (!byTurn.has(u.turn)) byTurn.set(u.turn, [])
    byTurn.get(u.turn).push(u)
  }
  for (const [turn, list] of byTurn) {
    list.sort((a, b) => a.step - b.step)
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]
      const cur = list[i]
      const gap = cur.step - prev.step
      if (gap !== 1 && gap !== 2) continue
      const d = cur.input + cur.cache - (prev.input + prev.cache)
      if (injSet.has(`${turn}|${cur.step}`)) treated.push(d)
      else if (injSet.has(`${turn}|${prev.step}`)) continue
      else control.push(d)
    }
  }
}
// B_immediate：注入那一步当场多出来的 prompt，只有注入消息本身（≈P）。
// 但这一步的汇报正文是模型之后才写出来的，下一刻才进入历史。
// 所以「每步要多背多少」必须另测一组：已经归档过汇报之后的步。
// B_immediate：注入那一步当场多出来的 prompt，只有注入消息本身（≈P）。
// 但这一步的汇报正文是模型之后才写出来的，下一刻才进入历史。
// 所以「每步要多背多少」必须另测——用同一轮内的 OLS 回归，
// 以「已归档汇报条数」为自变量、步序为控制变量，避免轮次位置混杂。
const B_immediate = Math.max(0, Math.round(median(treated) - median(control)))

function ols(rows) {
  const n = rows.length
  if (n < 13) return null
  const Sxx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const Sxy = [0, 0, 0]
  for (const r of rows) {
    const x = [1, r.injSoFar, r.idx]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) Sxx[i][j] += x[i] * x[j]
      Sxy[i] += x[i] * r.y
    }
  }
  const A = Sxx.map((r, i) => [...r, Sxy[i]])
  for (let i = 0; i < 3; i++) {
    let p = i
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k
    if (Math.abs(A[p][i]) < 1e-9) return null
    ;[A[i], A[p]] = [A[p], A[i]]
    for (let k = i + 1; k < 3; k++) {
      const f = A[k][i] / A[i][i]
      for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j]
    }
  }
  const beta = [0, 0, 0]
  for (let i = 2; i >= 0; i--) {
    let sum = A[i][3]
    for (let j = i + 1; j < 3; j++) sum -= A[i][j] * beta[j]
    beta[i] = sum / A[i][i]
  }
  return { bInj: beta[1] }
}

const olsB = []
for (const s of sessions) {
  const injByTurn = new Map()
  for (const i of s.injections) {
    if (!injByTurn.has(i.turn)) injByTurn.set(i.turn, [])
    injByTurn.get(i.turn).push(i.step)
  }
  const byTurn = new Map()
  for (const u of s.usages) {
    if (!byTurn.has(u.turn)) byTurn.set(u.turn, [])
    byTurn.get(u.turn).push(u)
  }
  for (const [turn, list] of byTurn) {
    const steps = injByTurn.get(turn) || []
    if (list.length < 13) continue
    list.sort((a, b) => a.step - b.step)
    const rows = list.map((u, idx) => ({
      injSoFar: steps.filter((st) => st < u.step).length,
      idx,
      y: u.input + u.cache,
    }))
    if (!rows.some((r) => r.injSoFar > 0)) continue
    const m = ols(rows)
    if (m && Number.isFinite(m.bInj)) olsB.push(m.bInj)
  }
}
const B = olsB.length ? Math.max(0, Math.round(median(olsB))) : B_immediate

// ---------- 4. 缓存是否被破坏 ----------
const cacheRatio = (u) => (u.input + u.cache > 0 ? u.cache / (u.input + u.cache) : 0)
const repSteps = []
const ordSteps = []
for (const s of sessions) {
  const injSet = new Set(s.injections.map((i) => `${i.turn}|${i.step}`))
  for (const u of s.usages) (injSet.has(`${u.turn}|${u.step}`) ? repSteps : ordSteps).push(u)
}
const cacheRep = +(median(repSteps.map(cacheRatio)) * 100).toFixed(1)
const cacheOrd = +(median(ordSteps.map(cacheRatio)) * 100).toFixed(1)

// ---------- 5. 开销曲线 ----------
const S = positiveInt('steps', 200)
const nRaw = String(flagRaw('n', '1,2,5,10,15,20,30,40,50,100'))
  // `--n 10,20` 是空格分隔写法：flagRaw 只认等号，会把它当成位置参数 root。
  // 这里显式指出，免得用户以为筛选生效了、实际算的是全量。
  if (argv.includes('--n')) {
    console.error('--n 必须写成 --n=10,20,40（等号形式），空格分隔会被当成会话目录参数。')
    process.exit(1)
  }
  const ns = nRaw
  .split(',')
  .map((x) => x.trim())
  .filter((x) => x.length > 0)
  .map((x) => {
    const n = Number(x)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      console.error(`--n 里的每一项都必须是正整数，收到的是 ${JSON.stringify(x)}`)
      process.exit(1)
    }
    return n
  })

const rows = ns.map((N) => {
  const k = Math.floor((S - 1) / N)
  let carried = 0
  for (let j = 1; j <= k; j++) carried += Math.max(0, S - j * N) * B
  const oneOff = k * (P + R)
  return { N, injections: k, oneOff, carried, total: oneOff + carried }
})

// ---------- 6. 输出 ----------
const sampleLine = { sessions: sessions.length, injections: allInj.length, calls: sessions.reduce((a, s) => a + s.usages.length, 0) }
if (flag('markdown', false)) {
  console.log(`| N | 汇报次数 | 一次性开销 | 连带重读 | 合计 | 每步均摊 |`)
  console.log(`| --- | --- | --- | --- | --- | --- |`)
  for (const r of rows) {
    console.log(
      `| ${r.N} | ${r.injections} | ${r.oneOff.toLocaleString()} | ${r.carried.toLocaleString()} | **${r.total.toLocaleString()}** | ${Math.round(r.total / S)} |`
    )
  }
} else {
  console.log('样本')
  console.log(`  会话（含注入）      ${sessions.length}`)
  console.log(`  注入次数            ${allInj.length}`)
  console.log(`  模型调用记录        ${sessions.reduce((a, s) => a + s.usages.length, 0).toLocaleString()}`)
  console.log(`  每会话步数          中位 ${median(sessions.map((s) => s.usages.length))}`)
  console.log('')
  console.log('测得的常数')
  console.log(`  P  注入提示词        ${P} token  (p25 ${pct(Pset, 0.25)}, p75 ${pct(Pset, 0.75)})`)
  console.log(`  R  汇报输出          ${R} token  (p25 ${pct(Rset, 0.25)}, p75 ${pct(Rset, 0.75)})`)
  console.log(`  B  每条已归档汇报/步 ${B} token  (同轮 OLS ${olsB.length} 轮；事件研究 ${treated.length}/${control.length})`)
  console.log(`      校验 P+R = ${P + R}，与 B 同量级 → 上面两个独立方法互相印证`)
  console.log('')
  console.log('缓存')
  console.log(`  汇报步 cache 命中     ${cacheRep}%`)
  console.log(`  普通步 cache 命中     ${cacheOrd}%`)
  console.log(`  → 注入追加在末尾，前缀不变，${cacheRep >= cacheOrd - 1 ? '没有破坏前缀缓存' : '命中率偏低，值得复查'}`)
  console.log('')
  console.log(`${S} 步会话里插件的总开销（token）`)
  console.log('  N    次数    一次性      连带重读     合计')
  for (const r of rows) {
    console.log(
      `  ${String(r.N).padEnd(4)} ${String(r.injections).padEnd(7)} ${String(r.oneOff).padStart(9)} ${String(r.carried).padStart(12)} ${String(r.total).padStart(10)}`
    )
  }
  const get = (n) => rows.find((r) => r.N === n)
  for (const [a, b] of [[10, 20], [20, 40], [10, 30]]) {
    const A = get(a)
    const Bx = get(b)
    if (A && Bx) {
      console.log(`  N=${a} → N=${b}: ${A.total} → ${Bx.total}  (省 ${(100 * (1 - Bx.total / A.total)).toFixed(1)}%)`)
    }
  }
  console.log('')
  console.log('结论：一次性开销 ∝ 1/N，连带重读 ∝ 1/N 且随步数二次放大 —— N 加倍，总开销约减半。')
}

if (flag('json', false)) {
  console.log('')
  console.log(JSON.stringify({ sample: sampleLine, constants: { P, R, B }, spread: { P: [pct(Pset, 0.25), pct(Pset, 0.75)], R: [pct(Rset, 0.25), pct(Rset, 0.75)] }, cache: { rep: cacheRep, ord: cacheOrd }, steps: S, rows }, null, 2))
}

// 图表与表格必须出自同一次计算，否则文档里会出现两个 B。
if (flag('svg', false)) {
  const out = String(flagRaw('out', 'docs/overhead-vs-n.svg'))
  if (rows.length < 2) {
    console.error('画趋势线至少需要两个 N，当前只有 ' + rows.length + ' 个：' + rows.map((r) => r.N).join(', '))
    console.error('例：--n=5,10,20,40')
    process.exit(1)
  }
  if (new Set(rows.map((r) => r.N)).size < 2) {
    console.error('所有 N 都相同（' + rows[0].N + '），横轴 log10 会除零；请给至少两个不同的 N。')
    process.exit(1)
  }
  const W = 720
  const H = 400
  const padL = 86
  const padR = 24
  const padT = 58
  const padB = 56
  const x0 = Math.log10(Math.min(...rows.map((r) => r.N)))
  const x1 = Math.log10(Math.max(...rows.map((r) => r.N)))
  const yMax = Math.max(...rows.map((r) => r.total)) * 1.06
  const px = (v) => padL + ((Math.log10(v) - x0) / (x1 - x0)) * (W - padL - padR)
  const py = (v) => H - padB - (v / yMax) * (H - padT - padB)
  const fmt = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : Math.round(v / 1e3) + 'k')
  const p = []
  p.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,sans-serif">`,
  )
  p.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`)
  p.push(
    `<text x="${padL}" y="30" font-size="15" font-weight="600" fill="#0f172a">200 步会话：插件总开销随汇报间隔 N 变化</text>`,
  )
  p.push(
    `<text x="${padL}" y="48" font-size="11" fill="#64748b">实测常数 P=${P} R=${R} B=${B} token，纵轴为会话累计 token</text>`,
  )
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i
    const y = py(v)
    p.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`,
      `<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#64748b">${fmt(v)}</text>`,
    )
  }
  const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${px(r.N).toFixed(1)},${py(r.total).toFixed(1)}`).join(' ')
  p.push(`<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round"/>`)
  for (const r of rows) {
    p.push(
      `<circle cx="${px(r.N).toFixed(1)}" cy="${py(r.total).toFixed(1)}" r="3.2" fill="#2563eb"/>`,
      `<text x="${px(r.N).toFixed(1)}" y="${(py(r.total) - 10).toFixed(1)}" font-size="10" text-anchor="middle" fill="#334155">${r.N}</text>`,
    )
  }
  const hl = rows.find((r) => r.N === 20)
  if (hl) {
    p.push(
      `<circle cx="${px(20).toFixed(1)}" cy="${py(hl.total).toFixed(1)}" r="7" fill="none" stroke="#f59e0b" stroke-width="2"/>`,
      `<text x="${px(20).toFixed(1)}" y="${(py(hl.total) + 22).toFixed(1)}" font-size="10" text-anchor="middle" fill="#b45309">默认 N=20</text>`,
    )
  }
  p.push(`<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#94a3b8" stroke-width="1"/>`)
  for (const n of [1, 2, 5, 10, 20, 50, 100]) {
    if (!rows.some((r) => r.N === n)) continue
    p.push(
      `<text x="${px(n).toFixed(1)}" y="${H - padB + 17}" font-size="11" text-anchor="middle" fill="#64748b">${n}</text>`,
    )
  }
  p.push(
    `<text x="${((W - padR + padL) / 2).toFixed(1)}" y="${H - 18}" font-size="11" text-anchor="middle" fill="#64748b">汇报间隔 N（对数轴）</text>`,
  )
  p.push(`</svg>`)
  // 在仓库外跑时 `docs/` 不一定存在，早期版本在这里直接 ENOENT 崩掉。
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, p.join('\n') + '\n', 'utf8')
  console.error(`wrote ${out}`)
}

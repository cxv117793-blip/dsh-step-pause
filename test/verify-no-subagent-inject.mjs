#!/usr/bin/env node
// 只读：验证「运行时不向子智能体注入提示词」这条需求，用本机真实会话日志。
//
// ==== 三次翻车的教训（都记下来，避免第四次）====
//
// 1) 第一版：**假通过**。会话日志不是 `<uuid>.jsonl`，而是
//    `<uuid>/session.v4.jsonl.zstd`，且是**多帧 zstd 拼接**。第一版按 `.jsonl`
//    过滤又没解压，扫到 0 个文件仍然打印 PASS。→ 现在 0 样本一律判 FAIL。
//
// 2) 第二版：**假失败**。按文本片段全文搜索（'[自动 · 分步暂停' 等），把
//    「任务提示词里举例引用」「子智能体读源码看到 DEFAULT_PROMPT」「LLM 起标题
//    时复述」「子智能体自己复述」全算成注入。→ 文本匹配不能全文搜。
//
// 3) 第三版：**又假通过**。只用结构化字段 source.kind === 'step-pause' 判定，
//    结果历史注入全部漏掉：v0.1.x 还没有 HIDDEN_SOURCE_KIND，注入消息的
//    source.kind 写的是 **'user'**。实测 `e1c1d4d9`（origin=subagent）的
//    seq=151 就是一条真注入，kind='user'，被这一版放过了。
//
// ==== 现在的判定（精确、双向覆盖）====
//
// 一条记录算「插件注入」，必须同时满足：
//   a) role === 'user'（插件注入的是 user 角色消息）；
//   b) source.kind ∈ {'step-pause', 'user'}（新版隐藏时是 step-pause，
//      旧版一律是 user，开启「显示提示词」时也是 user）；
//   c) **消息正文以插件的提示词签名开头**（默认 '[自动 · 分步暂停'）。
//      用「开头」而不是「包含」，才能把「任务里举例引用」排除掉——
//      引用不会出现在一条消息的最开头。
//
// 用法：node test/verify-no-subagent-inject.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ROOT = 'C:\\Users\\22866\\.dsh\\sessions'

/** 「不向子智能体注入」的修复提交 f64c87f 的时间：2026-10-20 17:14:09 +0800。 */
const FIX_MS = Date.parse('2026-10-20T17:14:09+08:00')

/** 插件注入消息的正文签名（正文必须**以它开头**）。 */
const PROMPT_PREFIXES = ['[自动 · 分步暂停', '分步暂停 · 第']
/** 允许的 source.kind：新版隐藏用 step-pause，旧版/显示模式用 user。 */
const INJECT_KINDS = new Set(['step-pause', 'user'])

function decompressAllFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  const parts = []
  let failed = 0
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      parts.push(zstdDecompressSync(slice))
    } catch {
      failed++
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length, failed }
}

function findLogs(dir, out = [], depth = 0) {
  if (depth > 4) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) findLogs(p, out, depth + 1)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

/** 取消息正文首段文本（去掉前导空白与行首标记）。 */
function leadingText(data) {
  if (!Array.isArray(data?.content)) return ''
  for (const part of data.content) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return part.text.trimStart().slice(0, 200)
    }
  }
  return ''
}

function isInjection(data) {
  if (data?.role !== 'user') return false
  const kind = data?.source?.kind
  if (!INJECT_KINDS.has(kind)) return false
  const head = leadingText(data)
  return PROMPT_PREFIXES.some((p) => head.startsWith(p))
}

const logs = findLogs(ROOT)
if (logs.length === 0) {
  console.error(`FAIL：在 ${ROOT} 下没有找到任何 *.jsonl.zstd —— 样本为 0，结论无效。`)
  process.exit(1)
}

let parsed = 0
let unreadable = 0
let frameFail = 0
const subs = []
const mains = []

for (const file of logs) {
  let buf
  try {
    buf = statSync(file).size > 0 ? readFileSync(file) : Buffer.alloc(0)
  } catch {
    unreadable++
    continue
  }
  const { text, failed } = decompressAllFrames(buf)
  frameFail += failed

  let header = null
  let injects = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec?.type === 'session') {
      if (header === null) header = rec
      continue
    }
    if (isInjection(rec?.data)) injects++
  }

  if (header === null) {
    unreadable++
    continue
  }
  parsed++

  const isSub =
    header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
  const createdAt = typeof header.createdAt === 'number' ? header.createdAt : null
  const entry = {
    id: header.id ?? '?',
    createdAt,
    afterFix: createdAt !== null && createdAt > FIX_MS,
    injects,
  }
  ;(isSub ? subs : mains).push(entry)
}

const subsAfterFix = subs.filter((s) => s.afterFix)
const leakedAfterFix = subsAfterFix.filter((s) => s.injects > 0)
const leakedAny = subs.filter((s) => s.injects > 0)
const mainsWithInject = mains.filter((m) => m.injects > 0)
const totalMainInjects = mainsWithInject.reduce((n, m) => n + m.injects, 0)

const fmt = (ms) => (ms === null ? '?' : new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))

console.log('')
console.log(`会话日志文件          : ${logs.length}`)
console.log(`解析成功              : ${parsed}`)
console.log(`解析失败/跳过         : ${unreadable}`)
console.log(`zstd 坏帧             : ${frameFail}`)
console.log('')
console.log(`主智能体会话          : ${mains.length}（带注入 ${mainsWithInject.length} 个，共 ${totalMainInjects} 条注入）`)
console.log(`子智能体会话          : ${subs.length}（带注入 ${leakedAny.length} 个）`)
console.log(`  └ 修复前创建        : ${subs.length - subsAfterFix.length}`)
console.log(`  └ 修复后创建        : ${subsAfterFix.length}`)
console.log('')

if (leakedAny.length > 0) {
  console.log('子智能体上检测到的注入（按创建时间）:')
  for (const s of leakedAny.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const tag = s.afterFix ? '修复后 ← 问题' : '修复前（历史遗留）'
    console.log(`  - ${s.id}  ${fmt(s.createdAt)}  ${s.injects} 条  ${tag}`)
  }
  console.log('')
}

if (subsAfterFix.length === 0) {
  console.log('SKIP：修复之后还没有新的子智能体会话，无法证明修复后的行为（这不是 PASS）。')
  process.exitCode = 2
} else if (leakedAfterFix.length === 0) {
  console.log(
    `PASS：修复后创建的 ${subsAfterFix.length} 个子智能体会话中，0 个检测到插件注入。` +
      (leakedAny.length > 0 ? `（修复前的 ${leakedAny.length} 个是历史遗留，不算在内）` : ''),
  )
} else {
  console.log(`FAIL：修复后仍有 ${leakedAfterFix.length} 个子智能体会话收到插件注入。`)
  process.exitCode = 1
}

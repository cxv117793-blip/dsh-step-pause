#!/usr/bin/env node
// 用本机真实会话日志验证「子智能体判定」，而不是只靠手写 fixture。
//
// 两个坑（都已绕过）：
// 1) 会话日志是**多帧 zstd 拼接**，`createZstdDecompress()` 只解第一帧就报
//    ZSTD_error_prefix_unknown，必须按魔数 28 B5 2F FD 切帧逐个解。
// 2) 日志里 header 字段在 `{"type":"session", ...}` 记录**顶层**，
//    而运行时 API 是 `agent.session.header`（形状来自 dsh-subagent 的
//    childSessionMeta()：{cwd, agentPreset, parentSession, isSeeded, origin, delegationDepth}）。
//    所以这里把顶层记录包成 { session: { header: record } } 再喂给真函数。
//
// 只读：不修改任何会话文件。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { isSubagent } from '../lib/index.js'

const ROOT = 'C:\\Users\\22866\\.dsh\\sessions'

/** zstd 帧魔数 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 把多帧 zstd 缓冲切成单帧再逐帧解压，拼成完整明文。 */
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

function sessionRecord(file) {
  const buf = statSync(file).size > 0 ? readFileSync(file) : Buffer.alloc(0)
  const { text } = decompressAllFrames(buf)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec?.type === 'session') return rec
  }
  return null
}

const files = findLogs(ROOT)
const subagents = []
const mains = []
let noRecord = 0

for (const f of files) {
  let rec
  try {
    rec = sessionRecord(f)
  } catch {
    rec = null
  }
  if (!rec) {
    noRecord++
    continue
  }
  // 真实运行时形状：agent.session.header
  const verdict = isSubagent({ session: { header: rec } })
  const row = {
    short: f.slice(ROOT.length + 1).split('\\')[1]?.slice(0, 8) ?? '?',
    origin: rec.origin,
    depth: rec.delegationDepth,
    parent: rec.parentSession,
    seeded: rec.isSeeded,
    verdict,
  }
  if (verdict) subagents.push(row)
  else mains.push(row)
}

console.log(`扫描 ${files.length} 个会话日志（解析失败 ${noRecord} 个）\n`)
console.log(`子智能体（isSubagent=true）：${subagents.length} 个`)
for (const s of subagents.slice(0, 6)) {
  console.log(`  ${s.short} origin=${s.origin} depth=${s.depth} parent=${s.parent?.slice(0, 20) ?? 'null'}`)
}
console.log(`主智能体（isSubagent=false）：${mains.length} 个`)
for (const m of mains.slice(0, 4)) {
  console.log(`  ${m.short} origin=${m.origin} depth=${m.depth} parent=${m.parent ?? 'null'}`)
}

// ---- 断言 ----
const subAllTrue = subagents.every((s) => s.verdict === true)
const mainAllFalse = mains.every((m) => m.verdict === false)
const withOrigin = subagents.filter((s) => s.origin === 'subagent').length
const withDepth = subagents.filter((s) => typeof s.depth === 'number' && s.depth > 0).length

// fork（分叉）会话：有 parentSession，但不是子智能体。它必须被判成主智能体，
// 否则用户 fork 出来的会话里再也不汇报。
const forks = mains.filter((m) => typeof m.parent === 'string' && m.parent.length > 0)

const checks = []
if (subagents.length > 0) {
  checks.push(['找到真实子智能体会话并全部判定为子智能体', subAllTrue])
  checks.push([`判定依据 origin 或 depth 命中（origin=${withOrigin} depth>0=${withDepth} / ${subagents.length}）`, withOrigin === subagents.length || withDepth === subagents.length])
} else {
  checks.push(['找到真实子智能体会话', false])
}
checks.push(['主智能体没有被误判', mainAllFalse])
checks.push([`fork 会话（有 parentSession 但非子智能体，${forks.length} 个）没有被误判成子智能体`, forks.every((f) => f.verdict === false)])
checks.push(['解析失败的日志为 0', noRecord === 0])

console.log('\n=== 断言 ===')
let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)

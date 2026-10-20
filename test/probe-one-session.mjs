#!/usr/bin/env node
// 只读：定死一个会话文件的真实身份与注入消息。
// 用法：node probe-one-session.mjs <sessionFile>
//
// 目的：解决「文本匹配说有 7 个子智能体被注入」与「结构化扫描说 0 个」的矛盾。
// 直接打印：header 的 origin/delegationDepth/parentSession，
// 以及每一条 role==='user' 消息的 source.kind 与正文开头。

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node probe-one-session.mjs <sessionFile>')
  process.exit(1)
}

function decompressAllFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
  }
  const parts = []
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      parts.push(zstdDecompressSync(slice))
    } catch {
      /* skip */
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const text = decompressAllFrames(readFileSync(file))
const lines = text.split('\n')

let header = null
const users = []

for (const line of lines) {
  if (!line.trim()) continue
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  if (rec?.type === 'session') {
    header = rec
    continue
  }
  // 消息体在 rec.data 下（这是实际格式）
  const d = rec?.data
  if (d && typeof d === 'object' && d.role === 'user') {
    const first = Array.isArray(d.content)
      ? (d.content.find((c) => c?.type === 'text')?.text ?? '').slice(0, 50)
      : ''
    users.push({
      type: rec.type,
      seq: rec.seq,
      kind: d.source?.kind,
      sourceKeys: d.source ? Object.keys(d.source).join(',') : '(无 source)',
      first: first.replace(/\n/g, ' '),
    })
  }
}

console.log(`文件: ${file}`)
console.log('')
console.log('=== header ===')
if (header === null) {
  console.log('（没有 type=session 记录）')
} else {
  const keys = ['id', 'origin', 'delegationDepth', 'parentSession', 'isSeeded', 'agentPreset', 'createdAt']
  for (const k of keys) console.log(`  ${k.padEnd(18)} = ${JSON.stringify(header[k])}`)
  if (typeof header.createdAt === 'number') {
    console.log(`  createdAt(本地)     = ${new Date(header.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`)
  }
}
console.log('')
console.log(`=== role=user 的消息（共 ${users.length} 条）===`)
for (const u of users) {
  const flag = u.kind === 'step-pause' ? '  <<< 插件注入' : ''
  console.log(`  seq=${String(u.seq).padEnd(6)} type=${u.type.padEnd(14)} source.kind=${String(u.kind).padEnd(12)} [${u.sourceKeys}]${flag}`)
  console.log(`        正文: ${u.first}`)
}

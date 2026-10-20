#!/usr/bin/env node
// 只读：看某个会话日志里命中标记的**上下文**，判断是真注入还是任务文本里提到过。
// 用法：node probe-match-context.mjs <sessionDirOrFile>

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('用法: node probe-match-context.mjs <sessionDirOrFile>')
  process.exit(1)
}

function findLogs(dir, out = [], depth = 0) {
  if (depth > 4) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) findLogs(p, out, depth + 1)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

const files = statSync(target).isDirectory() ? findLogs(target) : [target]

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

const MARKERS = ['[自动 · 分步暂停', '分步暂停 · 第', 'kind":"step-pause"', 'kind": "step-pause"']

for (const file of files) {
  const text = decompressAllFrames(readFileSync(file))
  console.log(`\n=== ${file} ===`)
  console.log(`明文长度 ${text.length}`)

  // 逐条记录扫描：看命中出现在哪种记录里
  const lines = text.split('\n')
  let lineNo = 0
  for (const line of lines) {
    lineNo++
    if (!line.trim()) continue
    const hits = MARKERS.filter((m) => line.includes(m))
    if (hits.length === 0) continue

    let rec = null
    try {
      rec = JSON.parse(line)
    } catch {
      console.log(`\n[行 ${lineNo}] 非 JSON 行命中 ${hits.join(', ')}`)
      continue
    }

    const type = rec?.type ?? rec?.kind ?? '?'
    const role = rec?.role ?? rec?.message?.role ?? '?'
    const srcKind = rec?.source?.kind ?? rec?.message?.source?.kind ?? '?'
    const id = rec?.id ?? rec?.message?.id ?? '?'
    console.log(`\n[行 ${lineNo}] type=${type} role=${role} source.kind=${srcKind} id=${id}`)
    console.log(`  命中标记: ${hits.join(' | ')}`)

    // 打印命中的文本片段上下文
    for (const m of hits) {
      const idx = line.indexOf(m)
      const from = Math.max(0, idx - 160)
      const to = Math.min(line.length, idx + 240)
      console.log(`  …${line.slice(from, to)}…`)
    }
  }
}

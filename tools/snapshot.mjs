/**
 * 一次扫描出全部「实测数据」节需要的数字，避免文档里出现两次快照。
 * 只读 ~/.dsh/sessions/**\/session.v4.jsonl.zstd，不写文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ROOT = 'C:/Users/22866/.dsh/sessions'
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const PREFIX = '[自动 · 分步暂停'
const RESUME_TAG = '续跑检查'

function decode(file) {
  const buf = fs.readFileSync(file)
  const cps = []
  let off = 0
  while (off < buf.length - 3) {
    if (buf[off] === 0x28 && buf[off + 1] === 0xb5 && buf[off + 2] === 0x2f && buf[off + 3] === 0xfd) {
      cps.push(off)
      off += 4
    } else off++
  }
  const parts = []
  for (let i = 0; i < cps.length; i++) {
    const end = i + 1 < cps.length ? cps[i + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(cps[i], end)).toString('utf8'))
    } catch {
      /* 跳过坏帧 */
    }
  }
  return parts.join('')
}

const files = []
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name === 'session.v4.jsonl.zstd') files.push(p)
  }
}
walk(ROOT)

let steps = 0
let injections = 0
let progress = 0
let resumes = 0
const sessionsWithInjection = new Set()
let maxSteps = 0
let maxInjections = 0
let maxStepsSession = ''
let parsed = 0
let failed = 0
const subagents = new Set()
const mains = new Set()

for (const f of files) {
  let text
  try {
    text = decode(f)
    parsed++
  } catch {
    failed++
    continue
  }
  let s = 0
  let inj = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    if (e.type === 'step/end') s++
    if (e.type === 'user/message') {
      const d = e.data
      const isStepPause = d?.source?.kind === 'step-pause'
      const t = d?.content?.[0]?.text
      const byText = typeof t === 'string' && t.startsWith(PREFIX)
      if (isStepPause || byText) {
        inj++
        if (typeof t === 'string' && t.includes(RESUME_TAG)) resumes++
        else progress++
      }
    }
    // 子智能体判定：会话首条 `{"type":"session", ...}` 记录的**顶层**字段
    //（形状同 dsh-subagent 的 childSessionMeta：origin / delegationDepth / parentSession）
    if (e.type === 'session') {
      const depth = Number(e.delegationDepth) || 0
      if (depth > 0 || e.origin === 'subagent') subagents.add(f)
      else mains.add(f)
    }
  }
  steps += s
  injections += inj
  if (inj > 0) sessionsWithInjection.add(f)
  if (s > maxSteps) {
    maxSteps = s
    maxStepsSession = path.basename(path.dirname(f))
  }
  if (inj > maxInjections) maxInjections = inj
}

const out = {
  files: files.length,
  parsed,
  failed,
  steps,
  injections,
  progress,
  resumes,
  sessionsWithInjection: sessionsWithInjection.size,
  maxSteps,
  maxInjections,
  maxStepsSession,
  subagents: subagents.size,
  mains: mains.size,
}
console.log(JSON.stringify(out, null, 2))

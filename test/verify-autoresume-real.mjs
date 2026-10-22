// 只读：在真实会话日志里统计「说了就停」与「自动续跑」。
// 逻辑对齐 _probe/cp-all.mjs（已验证过的判定方式），另加续跑提示的检测。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(file) {
  const buf = fs.readFileSync(file)
  const offs = []
  let i = 0
  for (;;) {
    const k = buf.indexOf(MAGIC, i)
    if (k < 0) break
    offs.push(k)
    i = k + 4
  }
  const out = []
  for (let n = 0; n < offs.length; n++) {
    const a = offs[n]
    const b = n + 1 < offs.length ? offs[n + 1] : buf.length
    let piece = null
    for (let end = b; end > a; end = a + Math.floor((end - a) * 0.7)) {
      try {
        piece = zlib.zstdDecompressSync(buf.subarray(a, end))
        break
      } catch {
        if (end - a < 32) break
      }
    }
    if (piece) out.push(piece.toString('utf8'))
  }
  return out.join('')
}

const txt = (m) =>
  !m || !Array.isArray(m.content)
    ? ''
    : m.content
        .filter((c) => c && (c.type === 'text' || c.type === 'input_text'))
        .map((c) => c.text || '')
        .join('')

const CHECKPOINT = '[自动 · 分步暂停 · 第'
const RESUME = '[自动 · 分步暂停 · 续跑检查]'
const ROOT = 'C:/Users/22866/.dsh/sessions'

const dirs = []
for (const w of fs.readdirSync(ROOT)) {
  const wd = path.join(ROOT, w)
  if (!fs.statSync(wd).isDirectory()) continue
  for (const s of fs.readdirSync(wd)) {
    const sd = path.join(wd, s)
    if (!fs.statSync(sd).isDirectory()) continue
    const f = path.join(sd, 'session.v4.jsonl.zstd')
    if (fs.existsSync(f)) dirs.push({ dir: sd, file: f })
  }
}

let total = 0
let stopped = 0
let resumes = 0
let resumedAndContinued = 0
const resumeSamples = []

for (const { dir, file } of dirs) {
  let recs
  try {
    recs = decode(file)
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    continue
  }
  recs.sort((a, b) => a.seq - b.seq)

  // 续跑提示只数 user/message
  for (const r of recs) {
    if (r.type !== 'user/message') continue
    const t = txt(r.data?.message || r.data)
    if (!t.startsWith(RESUME)) continue
    resumes++
    // 续跑之后这一轮有没有真的继续干活
    let continued = false
    for (let j = recs.indexOf(r) + 1; j < recs.length; j++) {
      if (recs[j].type === 'turn/end') break
      if (recs[j].type === 'assistant/message' || recs[j].type === 'tool/call') {
        continued = true
        break
      }
    }
    if (continued) resumedAndContinued++
    if (resumeSamples.length < 3) {
      resumeSamples.push({
        session: path.basename(dir).slice(8, 24),
        continued,
        text: t.slice(0, 120).replace(/\n+/g, ' | '),
      })
    }
  }

  // 检查点：与 cp-all.mjs 完全一致的判定
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type !== 'user/message') continue
    if (!txt(recs[i].data?.message || recs[i].data).startsWith(CHECKPOINT)) continue

    let firstAsst = -1
    for (let j = i + 1; j < recs.length; j++) {
      if (recs[j].type === 'assistant/message') {
        firstAsst = j
        break
      }
      if (recs[j].type === 'turn/end') break
    }
    if (firstAsst < 0) continue

    let continued = false
    for (let j = firstAsst + 1; j < recs.length; j++) {
      if (recs[j].type === 'turn/end') break
      if (recs[j].type === 'assistant/message' || recs[j].type === 'tool/call') {
        continued = true
        break
      }
    }
    total++
    if (!continued) stopped++
  }
}

console.log('检查点总数：', total)
console.log('说了就停：', stopped, total ? `(${((stopped / total) * 100).toFixed(1)}%)` : '')
console.log('自动续跑触发：', resumes, resumes ? `(其中真的继续干活 ${resumedAndContinued})` : '')
if (resumeSamples.length) {
  console.log('\n续跑样本：')
  for (const s of resumeSamples) console.log(` [${s.session}] continued=${s.continued} ${s.text}`)
} else {
  console.log('\n尚未出现续跑记录 —— v0.4.0 还没在真实会话里触发过。')
}

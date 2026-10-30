#!/usr/bin/env node
/**
 * cost-report.mjs — 用真实会话日志核算 dsh-step-pause 的 token 与费用开销。
 *
 * DSH 把每次模型调用的 usage 记在会话日志 `<session>/session.v4.jsonl.zstd` 的
 * `assistant/message` 记录里（data.usage = inputTokens / outputTokens /
 * cacheReadTokens / cacheWriteTokens / totalTokens）。本脚本读这份日志，
 * 把「进度汇报」与「普通步骤」分开统计，再按给定单价折算成钱。
 *
 * 用法：
 *   node tools/cost-report.mjs <session.v4.jsonl.zstd | 会话目录 | .dsh/sessions 根目录>
 *   node tools/cost-report.mjs <path> --model=pro --peak --marker="进度小结"
 *
 * 退出码：0 正常；1 找不到日志或没有 usage 记录。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]) // zstd frame magic

/**
 * 会话日志是多帧 zstd 拼接（每条记录一个 frame），
 * 标准解压器只吃第一帧，必须按魔数切开逐帧解。
 */
function decodeSessionFile(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  let i = 0
  for (;;) {
    const k = buf.indexOf(MAGIC, i)
    if (k < 0) break
    offsets.push(k)
    i = k + 4
  }
  const pieces = []
  for (let n = 0; n < offsets.length; n++) {
    const start = offsets[n]
    const hardEnd = n + 1 < offsets.length ? offsets[n + 1] : buf.length
    let out = null
    // 帧长度未知，从一个上界逐步回退，直到能解开为止。
    for (let end = hardEnd; end > start; end = start + Math.floor((end - start) * 0.7)) {
      try {
        out = zlib.zstdDecompressSync(buf.subarray(start, end))
        break
      } catch {
        if (end - start < 32) break
      }
    }
    if (out) pieces.push(out.toString('utf8'))
  }
  return pieces.join('\n')
}

function resolveSessionFile(arg) {
  const p = path.resolve(arg)
  if (!fs.existsSync(p)) return null
  const st = fs.statSync(p)
  if (st.isFile()) return p
  const direct = path.join(p, 'session.v4.jsonl.zstd')
  if (fs.existsSync(direct)) return direct
  // 传进来的是 sessions 根目录：取最近修改的那一个会话
  let best = null
  const walk = (dir, depth) => {
    if (depth > 3) return
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(full, depth + 1)
      else if (ent.name === 'session.v4.jsonl.zstd') {
        const m = fs.statSync(full).mtimeMs
        if (!best || m > best.m) best = { file: full, m }
      }
    }
  }
  walk(p, 0)
  return best ? best.file : null
}

function messageText(msg) {
  if (!msg || !Array.isArray(msg.content)) return ''
  return msg.content
    .filter((c) => c && (c.type === 'text' || c.type === 'input_text'))
    .map((c) => c.text || '')
    .join('')
}

function median(values) {
  if (!values.length) return 0
  const v = [...values].sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}

function mean(values) {
  if (!values.length) return 0
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

// 官方价（元 / 百万 token）。来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
const PRICING = {
  flash: { label: 'deepseek-flash', missOff: 1.0, missPeak: 2.0, hitOff: 0.02, hitPeak: 0.04, outOff: 4.0, outPeak: 8.0 },
  pro: { label: 'deepseek-v4-pro', missOff: 4.5, missPeak: 9.0, hitOff: 0.15, hitPeak: 0.3, outOff: 13.5, outPeak: 27.0 },
}

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('--'))
const model = (args.find((a) => a.startsWith('--model=')) || '--model=flash').split('=')[1]
const peak = args.includes('--peak')
const markerArg = args.find((a) => a.startsWith('--marker='))
// `--marker` 是用户输入的正则源码：写坏了（`--marker='['`）必须给一句人话，
// 而不是把 `SyntaxError: Unterminated character class` 原样抛到栈上。
let marker
if (markerArg) {
  const source = markerArg.split('=').slice(1).join('=')
  try {
    marker = new RegExp(source)
  } catch (error) {
    console.error(`--marker 不是合法的正则：${source}`)
    console.error(`  ${error.message}`)
    console.error('  例：--marker="进度小结（第\\\\s*\\\\d+\\\\s*步）"')
    process.exit(1)
  }
} else {
  marker = /进度小结（第\s*\d+\s*步）|^\s*\*\*进度小结/
}

if (!target) {
  console.error('用法: node tools/cost-report.mjs <session.v4.jsonl.zstd | 会话目录 | sessions 根目录> [--model=flash|pro] [--peak] [--marker=正则]')
  process.exit(1)
}
if (!PRICING[model]) {
  console.error(`未知模型 ${model}，可选: ${Object.keys(PRICING).join(' / ')}`)
  process.exit(1)
}

const file = resolveSessionFile(target)
if (!file) {
  console.error(`找不到会话日志: ${target}`)
  process.exit(1)
}

const records = decodeSessionFile(file)
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l) } catch { return null }
  })
  .filter(Boolean)

const checkpoints = []
const normals = []
let totalOut = 0, totalIn = 0, totalHit = 0, steps = 0
let injected = 0, injectedChars = 0

for (const r of records) {
  if (r.type === 'user/message') {
    const t = messageText(r.data?.message || r.data)
    if (t.startsWith('[自动 · 分步暂停')) { injected++; injectedChars += t.length }
    continue
  }
  if (r.type !== 'assistant/message') continue
  const u = r.data?.usage
  if (!u) continue
  steps++
  totalOut += u.outputTokens || 0
  totalIn += u.inputTokens || 0
  totalHit += u.cacheReadTokens || 0
  const t = messageText(r.data?.message)
  const item = { out: u.outputTokens || 0, chars: t.length }
  ;(marker.test(t) ? checkpoints : normals).push(item)
}

if (!steps) {
  console.error('日志里没有带 usage 的记录（可能不是 v4 日志，或该会话没有模型调用）')
  process.exit(1)
}

const model_ = PRICING[model]
const miss = peak ? model_.missPeak : model_.missOff
const hit = peak ? model_.hitPeak : model_.hitOff
const outPrice = peak ? model_.outPeak : model_.outOff

const ckOut = checkpoints.map((x) => x.out)
const avgInjectedTokens = injected ? Math.round((injectedChars / injected) * 0.66) : 0
const midOut = median(ckOut)
const avgOut = mean(ckOut)

const costOf = (inTok, outTok) => (inTok * miss + outTok * outPrice) / 1e6

const ckTotalOut = ckOut.reduce((a, b) => a + b, 0)
const ckTotalIn = injected * avgInjectedTokens

console.log(`\n## 会话成本报告\n`)
console.log(`- 日志：\`${file}\``)
console.log(`- 模型：**${model_.label}**（${peak ? '高峰价' : '空闲价'}）`)
console.log(`- 统计：${steps} 个模型步骤，其中 **${checkpoints.length}** 次进度汇报，注入提示 **${injected}** 条\n`)

console.log('| 指标 | 进度汇报 | 普通步骤 |')
console.log('| --- | --- | --- |')
console.log(`| 输出 token（均值） | ${avgOut} | ${mean(normals.map((x) => x.out))} |`)
console.log(`| 输出 token（中位） | ${midOut} | ${median(normals.map((x) => x.out))} |`)
console.log(`| 文本字符（均值） | ${mean(checkpoints.map((x) => x.chars))} | ${mean(normals.map((x) => x.chars))} |`)
console.log()
console.log(`- 注入提示：平均 **${avgInjectedTokens} token/条**（实测 ${injected} 条共 ${injectedChars} 字符）`)
console.log(`- 全部汇报累计输出：**${ckTotalOut} token**，占本会话总输出 ${totalOut} 的 **${totalOut > 0 ? `${((ckTotalOut / totalOut) * 100).toFixed(2)}%` : '－（本会话没有可统计的输出）'}**`)
console.log()
console.log('### 单次汇报成本\n')
console.log('```')
console.log(`输入  ${avgInjectedTokens} × ${miss}元/M = ${((avgInjectedTokens * miss) / 1e6).toFixed(6)} 元`)
console.log(`输出  ${midOut} × ${outPrice}元/M = ${((midOut * outPrice) / 1e6).toFixed(6)} 元   (中位)`)
console.log(`      ${avgOut} × ${outPrice}元/M = ${((avgOut * outPrice) / 1e6).toFixed(6)} 元   (均值)`)
console.log('```')
console.log(`**合计：${costOf(avgInjectedTokens, midOut).toFixed(5)} – ${costOf(avgInjectedTokens, avgOut).toFixed(5)} 元 / 次**\n`)
console.log(`- 本会话 ${checkpoints.length} 次汇报合计：**${costOf(ckTotalIn, ckTotalOut).toFixed(4)} 元**（其中输出 ${((ckTotalOut * outPrice) / 1e6).toFixed(4)} 元、输入 ${((ckTotalIn * miss) / 1e6).toFixed(4)} 元）`)
console.log(`- 缓存命中读取（几乎不花钱）：全程 ${totalHit} token 命中，按 ${hit}元/M 计 = ${((totalHit * hit) / 1e6).toFixed(4)} 元（含非插件内容）`)
console.log()
console.log('### 规模换算\n')
console.log('| 任务步数 | N=10 | N=20（默认） |')
console.log('| --- | --- | --- |')
for (const steps_ of [100, 500, 1000, 5000]) {
  const perReport = costOf(avgInjectedTokens, midOut)
  const n10 = (steps_ / 10) * perReport
  const n20 = (steps_ / 20) * perReport
  console.log(`| ${steps_} | ${n10.toFixed(3)} 元 | ${n20.toFixed(3)} 元 |`)
}
console.log()

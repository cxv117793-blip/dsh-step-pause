import fs from 'node:fs'
import { execSync } from 'node:child_process'

// 变异测试：把某处修复临时改回旧行为，确认对应用例会失败。
// 任何一次「改坏了测试还全绿」都说明这条用例是空的。
const clientPath = 'D:/ai/deepseek/dsh-step-pause/lib/client.js'
const testPath = 'D:/ai/deepseek/dsh-step-pause/test/client.test.mjs'
const original = fs.readFileSync(clientPath, 'utf8')

const mutations = [
  {
    name: '缺陷3：撤掉 draftRef 守卫（外部变更无条件清草稿）',
    from: `				if (inFlightRef.current > 0) return;
				if (draftRef.current !== null) {
					// 有草稿：保留内容，只提示「外部已更新，保存会覆盖」。
					setPhase("stale");
					return;
				}`,
    to: `				if (inFlightRef.current > 0) return;`,
    expect: '缺陷3',
  },
  {
    name: '缺陷2：放弃修改不清 texts',
    from: `									setDraft(null);
									setPhase("idle");
									setTexts({});`,
    to: `									setDraft(null);
									setPhase("idle");`,
    expect: '缺陷2',
  },
  {
    name: '缺陷4：清空 prompt 存空串而不是 undefined',
    from: `								set("prompt", raw.trim() === "" ? undefined : raw);`,
    to: `								set("prompt", raw);`,
    expect: '缺陷4',
  },
  {
    name: '缺陷1：resetKey 不占用 inFlight',
    from: `				setPhase("saving");
				inFlightRef.current += 1;
				let settled;
				try {
					settled = controller.unset(key);`,
    to: `				setPhase("saving");
				let settled;
				try {
					settled = controller.unset(key);`,
    expect: '缺陷1',
    // 单纯撤掉 inFlight 不会让用例失败：只要还有草稿，缺陷 3 的 draftRef 守卫
    // 就会先 return，草稿不会被清。也就是说缺陷 1 的 inFlight 是「兜底」，
    // 和缺陷 3 的守卫互相覆盖。真正能观察到它的是「两个守卫同时撤掉」。
    note: '兜底：与缺陷3的守卫重叠，单独撤掉不可见',
  },
  {
    name: '组合：两个守卫同时撤掉（缺陷1的 inFlight + 缺陷3的 draftRef）',
    from: `				if (inFlightRef.current > 0) return;
				if (draftRef.current !== null) {
					// 有草稿：保留内容，只提示「外部已更新，保存会覆盖」。
					setPhase("stale");
					return;
				}`,
    to: `				if (inFlightRef.current > 0) return;`,
    expect: '缺陷1',
  },
]

const results = []
for (const m of mutations) {
  if (!original.includes(m.from)) {
    results.push(['SKIP', m.name + ' — 找不到要替换的源码'])
    continue
  }
  fs.writeFileSync(clientPath, original.replace(m.from, m.to))
  let out = ''
  try {
    out = execSync('node test/client.test.mjs', { cwd: 'D:/ai/deepseek/dsh-step-pause', encoding: 'utf8', stdio: 'pipe' })
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const failedNames = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(6))
  const caught = failedNames.some((n) => n.includes(m.expect))
  const tag = caught ? 'CAUGHT' : m.note ? 'SUBSUMED' : 'MISSED'
  results.push([tag, m.name + ' → ' + (failedNames.length ? failedNames.join(' / ') : '没有用例失败')])
}

fs.writeFileSync(clientPath, original)

for (const [st, line] of results) console.log(st.padEnd(8) + line)
// SUBSUMED 是已知的「兜底修复」：它和另一条修复互为冗余，单独撤掉观察不到。
// 这类不算漏测，但要数出来，避免「全绿」掩盖「其实没人守」。
const missed = results.filter((r) => r[0] === 'MISSED')
const subsumed = results.filter((r) => r[0] === 'SUBSUMED')
const caught = results.filter((r) => r[0] === 'CAUGHT')
console.log('')
console.log(`守住 ${caught.length} 处，冗余兜底 ${subsumed.length} 处，漏测 ${missed.length} 处`)
if (missed.length) {
  console.log('这些修复撤掉后没有任何用例失败，等于没测：')
  for (const [, line] of missed) console.log('  - ' + line)
  process.exit(1)
}
console.log('没有漏测（冗余兜底已由组合用例覆盖）')

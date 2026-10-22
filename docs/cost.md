# 它要多花多少钱

一句话：**一次汇报约 0.002–0.003 元**（deepseek-flash，空闲时段），高峰时段翻倍；
一个 1,000 步、`everyNSteps=20` 的长任务，整程大约 **0.1 元**。

下面的数字不是估算，是从 DSH 会话日志里读出来的真实用量。

---

## 数据怎么来的

DSH 把每次模型调用的用量记在会话日志里：

```
<DSH_HOME>/sessions/<工作区>/<session-id>/session.v4.jsonl.zstd
```

每条 `assistant/message` 记录带 `data.usage`：

```json
{"inputTokens": 5973, "outputTokens": 95, "cacheReadTokens": 315136, "cacheWriteTokens": 0, "totalTokens": 321204}
```

（日志是多帧 zstd 拼接，标准解压器只吃第一帧，本仓库的脚本按帧魔数切开逐帧解。）

**样本**：一次真实的 2,428 步长任务（就是开发这个插件的过程本身）。

| 项目 | 数量 |
| --- | --- |
| 模型步骤 | 2,428 |
| 进度汇报 | 85 次 |
| 注入提示 | 88 条（平均 162 token） |

---

## 实测结果

| 指标 | 进度汇报 | 普通步骤 |
| --- | --- | --- |
| 输出 token（均值） | **767** | 542 |
| 输出 token（中位） | **482** | 255 |
| 文本字符（均值） | 509 | 35 |

- 注入提示：**平均 162 token/条**（88 条实测共 21,565 字符；提示词固定，长度几乎一致）
- 85 次汇报累计输出 **65,213 token**，占该会话总输出（1,335,723）的 **4.88%**
- 注入提示累计新增输入上下文：88 × 162 ≈ **14,256 token**

---

## 单价

`deepseek-flash`（DeepSeek-V4.1-Flash-1017），单位：**元 / 百万 token**。
数据取自官方定价页（2026-10 快照，价格会变，以官方页为准）。

| 项目 | 空闲时段 | 高峰时段 |
| --- | --- | --- |
| 输入 · 缓存未命中 | 1.00 | 2.00 |
| 输入 · 缓存命中 | 0.02 | 0.04 |
| 输出 | 4.00 | 8.00 |

> 高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（法定节假日除外）；
> 其余时间与周末全天都是空闲价，**空闲价正好是高峰价的一半**。

`deepseek-v4-pro` 约为上表的 3.4 倍（输出 13.5 / 27.0）。

---

## 单次汇报成本

一次汇报由三部分组成：

| 类型 | 数量 | 计费方式 |
| --- | --- | --- |
| 注入的提示词 | 162 token | 追加在缓存前缀之后 → **缓存未命中** |
| 模型写的汇报 | 482（中位）～767（均值） | **输出** |
| 后续步骤重读 | 645 token × 剩余步数 | 进入缓存前缀 → **缓存命中** |

**空闲时段**（按中位）：

```
输入  162 × 1.00/1e6 = 0.00016 元
输出  482 × 4.00/1e6 = 0.00193 元
                 合计 ≈ 0.0021 元   （约 0.21 分钱）
```

按均值：`162×1 + 767×4` = **0.0032 元**（0.32 分钱）。
**高峰时段**：以上翻倍，**0.0042–0.0064 元**。

后续重读几乎不花钱：一次汇报后即使还剩 20 步，
`20 × 645 × 0.02/1e6 ≈ 0.00026 元`，合 0.03 分钱。

---

## 规模换算

每次汇报成本 ×（步数 ÷ N）：

| 任务步数 | N=10（默认） | N=20 |
| --- | --- | --- |
| 100 步 | 0.021 元 | 0.010 元 |
| 500 步 | 0.104 元 | 0.052 元 |
| 1,000 步 | 0.209 元 | 0.104 元 |
| 5,000 步 | 1.044 元 | 0.522 元 |

参照物：读一个中等大小的源码文件，一次就是 2,000–10,000 token。
**一次汇报的开销，大约等于「读了三分之一个文件」。**

---

## 什么会让它变贵或变便宜

| 因素 | 影响 |
| --- | --- |
| `everyNSteps` 调大 | 成本**线性下降**（N=20 只有默认 N=10 的一半） |
| 缩短 `prompt` | 只省输入那 162 token；把四条要求压成一行可降到 ~40 |
| 换 `deepseek-v4-pro` | 约 **3.4 倍** |
| 高峰时段运行 | **2 倍** |
| 打开 `showPromptInChat` | **不影响花费**，只影响界面显不显示 |

---

## 三个容易误解的点

1. **它不是额外发起一次请求。** 提示是追加进「本来就要发出去的那一批消息」，
   所以不增加请求次数。
2. **但它确实占掉那一步的输出预算。** 模型把这一步用来写汇报，
   而不是继续干活——所以「不多花一次调用」不等于「完全免费」。
3. **隐藏提示词不省钱。** `showPromptInChat: false` 只是让界面上看不见，
   提示词照样进模型上下文，token 照花。

---

## 自己复现

```bash
# 默认按 deepseek-flash 空闲价
node tools/cost-report.mjs "<DSH_HOME>/sessions/<工作区>/<session-id>/session.v4.jsonl.zstd"

# 也可以直接给会话目录或 sessions 根目录（取最近修改的那个）
node tools/cost-report.mjs "$HOME/.dsh/sessions"

# 高峰价 / Pro 模型
node tools/cost-report.mjs <路径> --peak
node tools/cost-report.mjs <路径> --model=pro
```

脚本只读日志、不联网、不改任何文件；单价表写在脚本顶部的 `PRICING` 里，
官方调价后改那一处即可。

---

## English summary

Measured from real DSH session logs (not estimates): over a 2,428-step session with
85 progress reports injected every 20 steps, the plugin added **65,213 output tokens
(4.88% of the session's total output)** plus **~14,256 input tokens**.

At `deepseek-flash` list prices (CNY per million tokens: input miss ¥1/¥2,
cache hit ¥0.02/¥0.04, output ¥4/¥8, off-peak/peak), one report costs
**≈ ¥0.0021–0.0032 off-peak** and **≈ ¥0.0042–0.0064 at peak** — about a fifth of
a Chinese cent. A 1,000-step task with the default interval costs roughly **¥0.10**.

The cost scales linearly with step count and inversely with `everyNSteps`.
Hiding the injected prompt (`showPromptInChat: false`) does **not** reduce cost:
it only hides the text in the UI.

Reproduce it with `node tools/cost-report.mjs <session.v4.jsonl.zstd>`.

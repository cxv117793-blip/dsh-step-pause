# X（Twitter）推广文案 · dsh-step-pause v0.3.0

发布目标：`https://github.com/cxv117793-blip/dsh-step-pause`

说明：X 对 CJK 字符按 **2** 计权，单条上限 280。下面的每条都标了实测权重。
链接在 X 上会被 t.co 统一折叠成 **23** 字符，所以实际发出去还会比标称更短。

---

### A. 主推 · 中文

```
跑一个长任务，到第 40 步你已经不知道它在干嘛了。

dsh-step-pause 让 agent 每 10 步自己停下来，用 4 行说清楚：在做什么、做完什么、下一步、卡在哪，然后接着干。

不占额外回合，不等你点确认，也不生成任何文件。

DSH 插件 · v0.3.0
github.com/cxv117793-blip/dsh-step-pause
```

### B. 英文

```
Long agent runs go dark around step 40. You stop knowing what it's working on, or where it's stuck.

dsh-step-pause: the agent stops every 10 steps, says it in 4 lines, keeps going.

No extra turn. No waiting on you. No files.

https://github.com/cxv117793-blip/dsh-step-pause
```

### C. 短版 · 配 GIF / 视频

```
你以为 agent 跑到第 40 步还在埋头干活。

其实它只是在打字。

dsh-step-pause：每 10 步自己停下来汇报 4 行，说完接着干。
github.com/cxv117793-blip/dsh-step-pause
```

### D. 技术视角 · 面向 agent 开发者

```
DSH 插件：挂在 agent/pre-step waterfall 上，把一条消息追加进「本步」的输入批次。

所以汇报和后续动作在同一次响应里完成 —— 不产生额外回合，不烧第二次调用。

每 N 步一次，N 自己配。默认只在主智能体注入，子智能体一次都不发。
github.com/cxv117793-blip/dsh-step-pause
```

### E. 造轮子的由来

```
我的 agent 跑到第 80 步时，我看着满屏工具调用，完全不知道它在往哪走。

于是我写了个插件：每 10 步它自己停下来说 4 行，然后继续。

不用发「继续」，不用点确认，不用写文档。
github.com/cxv117793-blip/dsh-step-pause
```

---

## Thread（3 条）

### 1/3

```
agent 跑长任务时最大的问题不是能力不够，是你在第 40 步之后彻底失去了它。

它还在花钱、还在调工具，而你连它卡在哪个环节都不知道。

我写了个小插件解决这件事 🧵
```

### 2/3

```
机制很朴素：挂在 agent/pre-step 这个 waterfall 上，每 N 步往「本步」的输入批次里追加一条消息，让它先汇报再继续。

关键在「本步输入」—— 所以汇报和后续动作在同一次响应里完成，不产生额外回合，不烧第二次调用。
```

### 3/3

```
输出就 4 行：正在做什么 / 已完成 / 接下来 / 卡点。

不等你点确认，不生成文件，不写计划文档。

默认每 10 步，N 自己配；默认只在主智能体注入，子智能体一次都不发。

github.com/cxv117793-blip/dsh-step-pause
```

---

## 配图

| 图 | 内容 | 适合文案 |
|---|---|---|
| `x-card-before-after.png` | 痛点对比：左边一屏工具调用「第 41 步它还在跑，你在猜」，右边一张 4 行进度小结 | A / B / E / Thread 1 |
| `x-card-mechanism.png` | 原理：① 本步输入 → ② 追加一条 → ③ 一次响应，底部「另起一次请求 vs 追加进本步批次」 | D / Thread 2 |
| `poster.png` | 竖版封面 | A / C |
| `dsh-step-pause-promo-final.mp4` | 52 秒宣传片，可截 6 秒 GIF | C |

两张卡片都是 1200×675（16:9），X 单图与四图布局都能直接吃下。

发帖时间：工作日上午 9–11 点（北京时间）对开发者账号互动率最高。

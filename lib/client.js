/**
 * dsh-step-pause — 浏览器半边（骨架，给用户过目用）
 *
 * 目标：在「插件」页里，本插件那一行的「配置」页上，改 everyNSteps / enabled /
 * maxReportsPerTurn / prompt，而不是手改 cordis.patch.yml。
 *
 * 设计约束（来自安装里自带的官方技能 cordis-plugin-development）：
 *   1. 不 require('@deepseek-ai/dsh-client-ui-primitives') 等任何 Client 包
 *      —— 手写控件，只共用 --dsw-alias-* 主题 token。
 *   2. 跨插件协作走 cordis 服务（ctx.configForms / ctx.slots / ctx.locale），
 *      不走值导入。
 *   3. 所有注册都在 apply 里用 ctx.effect 包起来，随插件卸载自动撤销。
 *   4. factory 内无副作用；组件抛错会「blank」自己的槽位，所以控件逻辑保持笨。
 */
window.__ModuleLoader__.load({
	id: "dsh-step-pause",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { jsx, jsxs } = require("react/jsx-runtime");
		const react = require("react");

		// ── 身份常量 ─────────────────────────────────────────────────────────
		// NS 必须等于 cordis.patch.yml 里这一行的 id：Host 的 settings 服务按
		// 「profile 条目 id」把我 Config 里 .volatile() 的字段聚成命名空间。
		const NS = "dsh-step-pause";
		// 键格式 = `<组合包包名>#<行 id>`（插件页的 rowConfigKey）。
		const ROW_KEY = "dsh-step-pause#dsh-step-pause";
		const PAGE_LOCALE = "dsh-step-pause.page";

		// 必需服务：没有其中一个，插件不激活，而不是抛错。
		const inject = ["slots", "locale", "configForms"];

		// ── 文案 ─────────────────────────────────────────────────────────────
		const zh = {
			title: "步数暂停",
			summary: "每 N 个步骤在对话里汇报一次进度，然后继续。",
			enabled: "启用",
			enabledHint: "关掉后插件仍然加载，但不再汇报。",
			everyN: "每多少步汇报一次",
			everyNHint: "按 agent 的 step 计数，不是思考次数。工具调用每一步算一步。",
			maxReports: "每轮最多汇报几次",
			maxReportsHint: "0 表示不限制。防止一轮很长时反复插话。",
			prompt: "汇报指令",
			promptHint: "可用占位符：{{step}} {{every}} {{turn}}。",
			showPrompt: "在对话里显示这段提示词",
			showPromptHint: "关掉后会隐藏注入的提示词原文，只留你自己的进度小结；不影响模型是否收到指令。",
			mainAgentOnly: "只在主智能体里汇报",
			mainAgentOnlyHint: "打开后子智能体（派生出去的子任务）不汇报，只有你直接对话的这个主智能体出进度小结。关掉则每个智能体各报各的。",
			autoResume: "停下后自动拉回来继续",
			autoResumeHint: "打开后，如果汇报完这一轮就此结束了，插件会在回合关闭前塞一条续跑提示，让它接着干。关掉则只靠提示词引导。",
			maxAutoResumes: "每轮最多自动续跑几次",
			maxAutoResumesHint: "防止「对话停不下来」的硬上限，默认 2；填 0 等于关掉自动续跑。用完就放手，让它正常结束。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "没保存成功，值已保留供你修改。",
			discard: "撤销修改",
			reset: "恢复默认",
			overridden: "已覆盖",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			loading: "正在读取配置…",
			invalidNumber: "有数字框是空的：留空表示使用默认值，保存后会自动回落。"
		};

		const en = {
			title: "Step pause",
			summary: "Reports progress in the conversation every N steps, then continues.",
			enabled: "Enabled",
			enabledHint: "Off keeps the plugin loaded but silent.",
			everyN: "Report every N steps",
			everyNHint: "Counts agent steps, not model thoughts. Each tool call is a step.",
			maxReports: "Max reports per turn",
			maxReportsHint: "0 means unlimited. Keeps a long turn from over-reporting.",
			prompt: "Report instruction",
			promptHint: "Placeholders: {{step}} {{every}} {{turn}}.",
			showPrompt: "Show this prompt in the conversation",
			showPromptHint: "Off hides the injected prompt text and keeps only your progress summary; the model still receives it.",
			mainAgentOnly: "Report from the main agent only",
			mainAgentOnlyHint: "On: child agents (delegated subtasks) stay silent and only the agent you talk to reports. Off: every agent reports for itself.",
			autoResume: "Pull it back when it stops",
			autoResumeHint: "On: if the turn ends right after a report, the plugin nudges it before the turn closes so it keeps working. Off: rely on the prompt alone.",
			maxAutoResumes: "Max auto-resumes per turn",
			maxAutoResumesHint: "Hard cap that keeps a conversation from never ending. Default 2; 0 turns auto-resume off entirely.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "Not saved; your values are kept for correction.",
			discard: "Discard",
			reset: "Reset to default",
			overridden: "Overridden",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			loading: "Reading configuration…",
			invalidNumber: "A numeric box is empty: blank means the default value, applied on save."
		};

		// ── 样式：只用主题 token，类名带自己的前缀 ───────────────────────────
		const css = `
.dsh-step-pause-form{display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dsh-step-pause-field{display:flex;flex-direction:column;gap:6px}
.dsh-step-pause-label{display:flex;align-items:center;gap:8px;font-weight:500}
.dsh-step-pause-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsh-step-pause-input,.dsh-step-pause-area{box-sizing:border-box;width:100%;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;outline:none;padding:0 12px;height:36px}
.dsh-step-pause-area{height:auto;min-height:96px;padding:8px 12px;resize:vertical;font-family:var(--ds-font-family-code)}
.dsh-step-pause-input:focus,.dsh-step-pause-area:focus{border-color:var(--dsw-alias-state-business-primary)}
.dsh-step-pause-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-step-pause-row{display:flex;align-items:center;gap:10px}
.dsh-step-pause-switch{width:36px;height:20px;border-radius:10px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-bg-layer-4);position:relative;flex:none}
.dsh-step-pause-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}
.dsh-step-pause-switch:disabled{opacity:.5;cursor:default}
.dsh-step-pause-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .16s}
.dsh-step-pause-switch[aria-checked=true] .dsh-step-pause-knob{transform:translateX(16px)}
.dsh-step-pause-tag{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-step-pause-actions{display:flex;align-items:center;gap:12px}
.dsh-step-pause-btn{height:32px;padding:0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.dsh-step-pause-btn-primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dsh-step-pause-btn:disabled{opacity:.5;cursor:default}
.dsh-step-pause-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-step-pause-note[data-error=true]{color:var(--dsw-alias-state-error-primary)}
.dsh-step-pause-flat{background:0 0;border:0;padding:0;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline}
`;

		// ── 订阅 configForms 快照 ────────────────────────────────────────────
		// 服务是 ConfigFormController：getSnapshot() / subscribe(fn) / set() / unset() / mutate()
		function useSnapshot(form) {
			const [tick, setTick] = react.useState(0);
			react.useEffect(() => form.subscribe(() => setTick((n) => n + 1)), [form]);
			return form.getSnapshot();
		}

		// ── 单个字段控件 ─────────────────────────────────────────────────────
		function Field(props) {
			const { id, label, hint, invalid, tag, resetLabel, onReset, children } = props;
			return jsxs("div", {
				className: "dsh-step-pause-field",
				children: [
					jsx("label", { className: "dsh-step-pause-label", htmlFor: id, children: label }),
					children,
					hint ? jsx("p", { className: "dsh-step-pause-hint", children: hint }) : null,
					tag
						? jsx("button", {
								type: "button",
								className: "dsh-step-pause-flat",
								onClick: onReset,
								children: `${tag} · ${resetLabel}`
							})
						: null
				]
			});
		}

		// ── 页面本体 ─────────────────────────────────────────────────────────
		function StepPausePage(props) {
			// 注意：插件页自己会往 props 里塞 t / form（插件页自己的翻译函数与
			// `{state, mutate}` 快照），会覆盖同名的注入属性。所以注入值统一挂在
			// 唯一的 stepPause 键下，避免撞名。
			const injected = props.stepPause
			const controller = injected && injected.controller
			const t = (injected && injected.t) || ((key) => key)
			if (props.view === "summary") return t("summary")
			if (controller === undefined || typeof controller.getSnapshot !== "function") {
				return jsx("p", { className: "dsh-step-pause-note", children: t("unavailable") })
			}

			const state = useSnapshot(controller)
			const base = state.value ?? {};
			const [draft, setDraft] = react.useState(null);
			const [phase, setPhase] = react.useState("idle"); // idle | saving | failed
			// 数字框里「用户正在敲的原文」。和草稿里的数值分开存，理由见 numeric()。
			const [texts, setTexts] = react.useState({});
			// 一次写入失败时，Host 侧会 `recover()` → `mirror.load()`，revision 随之变化，
			// 于是下面那个 effect 会跑一遍。若不拦住，草稿就被清空 —— 用户刚敲的值凭空
			// 消失，而提示语还写着「值已保留供你修改」。
			// 用「有几个写入在飞」而不是一次性布尔：revision 的变化发生在 mutate 内部，
			// 早于我们拿到返回值，布尔标记会在错误的时机被消费掉。
			const inFlightRef = react.useRef(0);

			// 打开页面时用当前值初始化草稿；保存成功或外部变化时重置。
			react.useEffect(() => {
				if (inFlightRef.current > 0) return;
				setDraft(null);
				setPhase("idle");
				setTexts({});
			}, [state.revision]);

			const value = draft ?? base;
			const writable = state.writable && state.status === "ready";
			const set = (key, next) => setDraft({ ...value, [key]: next });
			const dirty = draft !== null;

			const save = async () => {
				if (!dirty) return;
				const ops = [];
				for (const key of ["enabled", "everyNSteps", "maxReportsPerTurn", "prompt", "showPromptInChat", "mainAgentOnly", "autoResume", "maxAutoResumesPerTurn"]) {
					if (Object.is(value[key], base[key])) continue;
					// 数字框被清空时草稿里是 undefined：这正好对应 Host 的 `unset`
					// （删除该键 = 回落到 schema 默认值），而不是把 ""/0 写进去。
					// 写成 set 会被 schemastery 在写盘前拒掉，一次连带所有字段都存不进去。
					if (value[key] === undefined) {
						ops.push({ op: "unset", path: [key] });
					} else {
						ops.push({ op: "set", path: [key], value: value[key] });
					}
				}
				if (ops.length === 0) {
					setDraft(null);
					return;
				}
				setPhase("saving");
				inFlightRef.current += 1;
				try {
					const ok = await controller.mutate(ops, state.revision);
					inFlightRef.current -= 1;
					if (ok) {
						setPhase("idle");
						setDraft(null);
					} else {
						setPhase("failed");
					}
				} catch {
					// mutate 在连接未就绪时会 reject；不能让它把 phase 永久卡在 saving
					// （那会让保存与撤销两个按钮同时永久禁用）。
					inFlightRef.current -= 1;
					setPhase("failed");
				}
			};

			if (state.status === "loading") return jsx("p", { className: "dsh-step-pause-note", children: t("loading") });
			if (state.status === "unavailable") return jsx("p", { className: "dsh-step-pause-note", children: t("unavailable") });

			const number = (key) => ({
				tag: state.user && key in state.user ? t("overridden") : undefined,
				resetLabel: t("reset"),
				onReset: () => {
					// 先清掉这一格的编辑原文，否则 unset 成功后输入框还停在旧文本。
					setTexts((prev) => {
						const next = { ...prev };
						delete next[key];
						return next;
					});
					// unset 在冲突或 controller 已释放时返回 false、连接异常时 reject，
					// 两种情况都要有反馈，否则界面毫无动静、用户以为按钮坏了。
					try {
						const settled = controller.unset(key);
						if (settled && typeof settled.then === "function") {
							settled.then((ok) => { if (!ok) setPhase("failed"); }).catch(() => setPhase("failed"));
						}
					} catch {
						setPhase("failed");
					}
				}
			});

			// 数字框：输入过程中**不要**把夹紧结果写回输入框。
			// 早期版本 onChange 里直接 `set(key, clamp(Number(raw)))`，而输入框的
			// value 又绑到草稿的数值上，于是「选中旧值 → 敲 1」立刻被夹成 2，
			// 再敲 0 就成了 20；清空后 value ?? 默认值 会把默认值渲染回来，
			// 接着敲 5 变成 105、再敲 1 变成 1051 → 夹到 500。真实界面实测：
			// 输入 "10" 得到 20，"15" 得到 500 —— 两位数根本打不进去。
			// 现在分两层：texts 存原始文本（输入框只读它），草稿里存解析后的数值
			// （保存时用），解析不出来的文本在失焦时才做最终夹紧。
			const numeric = (key, { min, max, fallback }) => {
				const shown = Object.prototype.hasOwnProperty.call(texts, key)
					? texts[key]
					: value[key] === undefined
						? ""
						: String(value[key]);
				const commit = (raw) => {
					if (raw.trim() === "") {
						// 留空 = 回落到默认值：草稿里放 undefined，保存时发 `unset`。
						set(key, undefined);
						return;
					}
					const n = Number(raw);
					if (!Number.isFinite(n)) {
						set(key, undefined);
						return;
					}
					set(key, Math.min(Math.max(Math.trunc(n), min), max));
				};
				return {
					shown,
					handlers: {
						onChange: (e) => {
							const raw = e.target.value;
							setTexts((prev) => ({ ...prev, [key]: raw }));
							commit(raw);
						},
						// 失焦时把文本归一化成真正生效的数字，用户能看到被夹成什么。
						onBlur: () => {
							const raw = Object.prototype.hasOwnProperty.call(texts, key) ? texts[key] : shown;
							if (raw.trim() === "") return;
							const n = Number(raw);
							const settled = Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), min), max) : undefined;
							setTexts((prev) => {
								const next = { ...prev };
								delete next[key];
								return next;
							});
							if (settled === undefined) {
								set(key, undefined);
							} else if (!Object.is(value[key], settled)) {
								set(key, settled);
							}
						}
					},
					placeholder: String(fallback)
				};
			};

			return jsxs("div", {
				className: "dsh-step-pause-form",
				children: [
					jsx("style", { children: css }),

					// 开关
					jsxs("div", {
						className: "dsh-step-pause-field",
						children: [
							jsxs("div", {
								className: "dsh-step-pause-row",
								children: [
									jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": value.enabled !== false,
										"aria-label": t("enabled"),
										disabled: !writable,
										className: "dsh-step-pause-switch",
										onClick: () => set("enabled", value.enabled === false),
										children: jsx("span", { className: "dsh-step-pause-knob" })
									}),
									jsx("span", { children: t("enabled") })
								]
							}),
							jsx("p", { className: "dsh-step-pause-hint", children: t("enabledHint") })
						]
					}),

					// 是否显示提示词原文
					jsxs("div", {
						className: "dsh-step-pause-field",
						children: [
							jsxs("div", {
								className: "dsh-step-pause-row",
								children: [
									jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": value.showPromptInChat === true,
										"aria-label": t("showPrompt"),
										disabled: !writable,
										className: "dsh-step-pause-switch",
										onClick: () => set("showPromptInChat", value.showPromptInChat !== true),
										children: jsx("span", { className: "dsh-step-pause-knob" })
									}),
									jsx("span", { children: t("showPrompt") })
								]
							}),
							jsx("p", { className: "dsh-step-pause-hint", children: t("showPromptHint") })
						]
					}),

					// 只在主智能体里汇报
					jsxs("div", {
						className: "dsh-step-pause-field",
						children: [
							jsxs("div", {
								className: "dsh-step-pause-row",
								children: [
									jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": value.mainAgentOnly !== false,
										"aria-label": t("mainAgentOnly"),
										disabled: !writable,
										className: "dsh-step-pause-switch",
										onClick: () => set("mainAgentOnly", value.mainAgentOnly === false),
										children: jsx("span", { className: "dsh-step-pause-knob" })
									}),
									jsx("span", { children: t("mainAgentOnly") })
								]
							}),
							jsx("p", { className: "dsh-step-pause-hint", children: t("mainAgentOnlyHint") })
						]
					}),

					// 停下后自动拉回来继续（甲方案）
					jsxs("div", {
						className: "dsh-step-pause-field",
						children: [
							jsxs("div", {
								className: "dsh-step-pause-row",
								children: [
									jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": value.autoResume !== false,
										"aria-label": t("autoResume"),
										disabled: !writable,
										className: "dsh-step-pause-switch",
										onClick: () => set("autoResume", value.autoResume === false),
										children: jsx("span", { className: "dsh-step-pause-knob" })
									}),
									jsx("span", { children: t("autoResume") })
								]
							}),
							jsx("p", { className: "dsh-step-pause-hint", children: t("autoResumeHint") })
						]
					}),

					// 每轮最多自动续跑几次
					jsx(Field, {
						id: "dsh-step-pause-max-auto",
						label: t("maxAutoResumes"),
						hint: t("maxAutoResumesHint"),
						...number("maxAutoResumesPerTurn"),
						invalid: typeof value.maxAutoResumesPerTurn !== "number",
						children: jsx("input", {
							id: "dsh-step-pause-max-auto",
							className: "dsh-step-pause-input",
							type: "number",
							"aria-label": t("maxAutoResumes"),
							"aria-invalid": typeof value.maxAutoResumesPerTurn !== "number",
							min: 0,
							max: 20,
							step: 1,
							disabled: !writable,
							...(() => {
								const box = numeric("maxAutoResumesPerTurn", { min: 0, max: 20, fallback: 2 });
								return { value: box.shown, placeholder: box.placeholder, ...box.handlers };
							})()
						})
					}),

					// 步数
					jsx(Field, {
						id: "dsh-step-pause-every",
						label: t("everyN"),
						hint: t("everyNHint"),
						...number("everyNSteps"),
						invalid: typeof value.everyNSteps !== "number",
						children: jsx("input", {
							id: "dsh-step-pause-every",
							className: "dsh-step-pause-input",
							type: "number",
							"aria-label": t("everyN"),
							"aria-invalid": typeof value.everyNSteps !== "number",
							min: 2,
							max: 500,
							step: 1,
							disabled: !writable,
							...(() => {
								const box = numeric("everyNSteps", { min: 2, max: 500, fallback: 20 });
								return { value: box.shown, placeholder: box.placeholder, ...box.handlers };
							})()
						})
					}),

					// 每轮配额
					jsx(Field, {
						id: "dsh-step-pause-max",
						label: t("maxReports"),
						hint: t("maxReportsHint"),
						...number("maxReportsPerTurn"),
						invalid: typeof value.maxReportsPerTurn !== "number",
						children: jsx("input", {
							id: "dsh-step-pause-max",
							className: "dsh-step-pause-input",
							type: "number",
							"aria-label": t("maxReports"),
							"aria-invalid": typeof value.maxReportsPerTurn !== "number",
							min: 0,
							max: 1000,
							step: 1,
							disabled: !writable,
							...(() => {
								const box = numeric("maxReportsPerTurn", { min: 0, max: 1000, fallback: 0 });
								return { value: box.shown, placeholder: box.placeholder, ...box.handlers };
							})()
						})
					}),

					// 汇报指令
					jsx(Field, {
						id: "dsh-step-pause-prompt",
						label: t("prompt"),
						hint: t("promptHint"),
						children: jsx("textarea", {
							id: "dsh-step-pause-prompt",
							className: "dsh-step-pause-area",
							"aria-label": t("prompt"),
							disabled: !writable,
							value: value.prompt ?? "",
							onChange: (e) => set("prompt", e.target.value)
						})
					}),

					// 动作
					jsx("div", {
						className: "dsh-step-pause-actions",
						children: [
							jsx("button", {
								type: "button",
								className: "dsh-step-pause-btn dsh-step-pause-btn-primary",
								disabled: !writable || !dirty || phase === "saving",
								onClick: save,
								children: phase === "saving" ? t("saving") : t("save")
							}),
							jsx("button", {
								type: "button",
								className: "dsh-step-pause-btn",
								disabled: !dirty || phase === "saving",
								onClick: () => {
									setDraft(null);
									setPhase("idle");
								},
								children: t("discard")
							}),
							!writable ? jsx("p", { className: "dsh-step-pause-note", children: t("readOnly") }) : null
						]
					}),

					phase === "failed" ? jsx("p", { className: "dsh-step-pause-note", role: "alert", "data-error": true, children: t("saveFailed") }) : null,

					// 有数字框被清空时给一句提示：清空不是"0"，而是回落到默认值。
					// 这不再是错误状态 —— 保存时会发 `unset`，Host 会把它变回默认值。
					[value.everyNSteps, value.maxReportsPerTurn, value.maxAutoResumesPerTurn].some(
						(entry) => entry === undefined
					)
						? jsx("p", { className: "dsh-step-pause-note", children: t("invalidNumber") })
						: null
				]
			});
		}

		// ── 挂载 ─────────────────────────────────────────────────────────────
		function apply(ctx) {
			const t = ctx.locale.bind(PAGE_LOCALE);
			ctx.effect(() => ctx.locale.register(PAGE_LOCALE, { zh, en }), "dsh-step-pause: dictionaries");

			// 一个表单控制器 = 一个 Host profile 条目。
			// **不要在这里 dispose()**：`get()` 返回的是 provider 缓存里的单例，
			// dispose 只置 disposed、不从 forms 里删除；bundle 一旦重建（HMR /
			// 重装 / 禁用再启用），重新 apply 时拿回的是同一个已 disposed 的实例 ——
			// 页面看起来完全正常，但之后每次保存都静默返回 false。
			// 释放统一交给 ConfigForms 自己的 provider 级 effect（官方其余插件
			// theme / locale / plugin-manager / session-log 也都是取了不自 dispose）。
			const form = ctx.configForms.get(NS);

			// 一份表单，两处入口，注入形状完全相同（都挂在 stepPause 键下）。
			const pageInjection = () => ({ stepPause: { controller: form, t } });

			// 只在 Host 确实服务这个命名空间时注册页面：插件禁用/未加载时页面不出现。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("plugins.row.config", () =>
							ctx.slots.register(
								{
									name: "plugins.row.config",
									key: ROW_KEY,
									label: () => t("title"),
									locale: PAGE_LOCALE,
									inject: pageInjection
								},
								StepPausePage
							)
						)
					),
				"dsh-step-pause: config page"
			);

			// 侧边栏左下角头像 →「设置」→ 本插件；和插件页那处是同一个表单控制器，
			// 任何一处保存，另一处立刻看到（都订阅同一个 form 快照）。
			// order 取 60：排在账号(-10)、模型(10)这些官方段之后，不插队。
			ctx.effect(
				() =>
					ctx.configForms.whileServed([NS], () =>
						ctx.slots.inject("settings.section", () =>
							ctx.slots.register(
								{
									name: "settings.section",
									id: "step-pause",
									order: 60,
									label: () => t("title"),
									locale: PAGE_LOCALE,
									inject: pageInjection
								},
								StepPausePage
							)
						)
					),
				"dsh-step-pause: settings section"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

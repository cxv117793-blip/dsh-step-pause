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
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			saveFailed: "没保存成功，值已保留供你修改。",
			discard: "撤销修改",
			reset: "恢复默认",
			overridden: "已覆盖",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			loading: "正在读取配置…",
			invalidNumber: "请填数字；留空表示使用默认值。"
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
			save: "Save",
			saving: "Saving…",
			saved: "Saved",
			saveFailed: "Not saved; your values are kept for correction.",
			discard: "Discard",
			reset: "Reset to default",
			overridden: "Overridden",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			loading: "Reading configuration…",
			invalidNumber: "Enter a number, or leave blank to use the default."
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

			// 打开页面时用当前值初始化草稿；保存成功或外部变化时重置。
			react.useEffect(() => {
				setDraft(null);
				setPhase("idle");
			}, [state.revision]);

			const value = draft ?? base;
			const writable = state.writable && state.status === "ready";
			const set = (key, next) => setDraft({ ...value, [key]: next });
			const dirty = draft !== null;

			const save = async () => {
				if (!dirty) return;
				const ops = [];
				for (const key of ["enabled", "everyNSteps", "maxReportsPerTurn", "prompt", "showPromptInChat"]) {
					if (!Object.is(value[key], base[key])) ops.push({ op: "set", path: [key], value: value[key] });
				}
				if (ops.length === 0) {
					setDraft(null);
					return;
				}
				setPhase("saving");
				const ok = await controller.mutate(ops, state.revision);
				setPhase(ok ? "idle" : "failed");
				if (ok) setDraft(null);
			};

			if (state.status === "loading") return jsx("p", { className: "dsh-step-pause-note", children: t("loading") });
			if (state.status === "unavailable") return jsx("p", { className: "dsh-step-pause-note", children: t("unavailable") });

			const number = (key) => ({
				tag: state.user && key in state.user ? t("overridden") : undefined,
				resetLabel: t("reset"),
				onReset: () => controller.unset(key)
			});

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

					// 步数
					jsx(Field, {
						id: "dsh-step-pause-every",
						label: t("everyN"),
						hint: t("everyNHint"),
						...number("everyNSteps"),
						children: jsx("input", {
							id: "dsh-step-pause-every",
							className: "dsh-step-pause-input",
							type: "number",
							min: 1,
							max: 500,
							step: 1,
							disabled: !writable,
							value: value.everyNSteps ?? 10,
							onChange: (e) => {
								const n = Number(e.target.value);
								set("everyNSteps", Number.isFinite(n) && n >= 1 ? Math.trunc(n) : e.target.value);
							}
						})
					}),

					// 每轮配额
					jsx(Field, {
						id: "dsh-step-pause-max",
						label: t("maxReports"),
						hint: t("maxReportsHint"),
						...number("maxReportsPerTurn"),
						tag: undefined,
						children: jsx("input", {
							id: "dsh-step-pause-max",
							className: "dsh-step-pause-input",
							type: "number",
							min: 0,
							step: 1,
							disabled: !writable,
							value: value.maxReportsPerTurn ?? 0,
							onChange: (e) => {
								const n = Number(e.target.value);
								set("maxReportsPerTurn", Number.isFinite(n) && n >= 0 ? Math.trunc(n) : e.target.value);
							}
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

					phase === "failed" ? jsx("p", { className: "dsh-step-pause-note", "data-error": true, children: t("saveFailed") }) : null,

					// 校验提示：数字框被清空时
					typeof value.everyNSteps !== "number"
						? jsx("p", { className: "dsh-step-pause-note", "data-error": true, children: t("invalidNumber") })
						: null
				]
			});
		}

		// ── 挂载 ─────────────────────────────────────────────────────────────
		function apply(ctx) {
			const t = ctx.locale.bind(PAGE_LOCALE);
			ctx.effect(() => ctx.locale.register(PAGE_LOCALE, { zh, en }), "dsh-step-pause: dictionaries");

			// 一个表单控制器 = 一个 Host profile 条目；随插件卸载释放。
			const form = ctx.configForms.get(NS);
			ctx.effect(
				() => () => {
					form.dispose();
				},
				"dsh-step-pause: form subscription"
			);

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
									inject: () => ({ stepPause: { controller: form, t } })
								},
								StepPausePage
							)
						)
					),
				"dsh-step-pause: config page"
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

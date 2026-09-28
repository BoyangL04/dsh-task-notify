/**
 * Browser half of `@local/dsh-task-notify`.
 *
 * Two things about a session are worth interrupting the user for, and both are
 * read from the Client session-status projection that `ui-session` publishes:
 *
 *   - **A turn finished** — the Agent went from running to idle.
 *   - **The Agent is blocked on the user** — a pending interaction appeared:
 *     a tool authorization (`approval`), a question (`question`), or a plan
 *     review (`plan-review`). These rows carry a stable `key`, so the same
 *     request is announced once however many times the projection republishes.
 *
 * Each event becomes two visible signals:
 *
 *   1. a toast in the frame-wide `shell.overlay` slot, and
 *   2. a desktop notification through the renderer's Notification API.
 *
 * Completions are announced only after the session has stayed idle for
 * `SETTLE_MS`, which keeps a multi-round goal or a Retry from firing once per
 * round. Interactions are announced after the shorter `ATTENTION_SETTLE_MS`,
 * which is long enough to swallow a request that is delegated to another
 * waterfall listener (for example the auto-review bundle) and so never really
 * reaches the user.
 *
 * The artifact is hand-written in the deployment's Client bundle format: a
 * lazy `window.__ModuleLoader__.load({ id, factory })` registration whose
 * factory returns the Cordis plugin face. React comes from the browser module
 * table, and no Harness Client package is loaded as a module.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-task-notify',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** How long a session must stay idle before its completion is announced. */
		const SETTLE_MS = 1200;
		/** How long a pending interaction must persist before it is announced. */
		const ATTENTION_SETTLE_MS = 600;
		/** How long one completion toast stays on screen, in milliseconds. */
		const TOAST_TTL_MS = 9000;
		/** How long one attention toast stays on screen — longer, it is actionable. */
		const ATTENTION_TTL_MS = 15000;
		/** Most toasts kept at once; older ones drop off the top. */
		const MAX_TOASTS = 3;
		/** Send the desktop notification even while the Harness window is in front. */
		const NATIVE_ALWAYS = true;
		/** Announce interactions raised inside subagent sessions too. */
		const ATTENTION_INCLUDE_SUBAGENTS = true;
		/** Longest question text carried into a desktop banner. */
		const NATIVE_CONTEXT_LIMIT = 140;
		/** Locale namespace this plugin owns. */
		const NAMESPACE = 'task-notify';
		/** Class-free marker so the toast is identifiable in the live page. */
		const ROOT_ATTRIBUTE = 'data-task-notify-root';

		const zh = {
			'toast.title': '任务完成',
			'toast.dismiss': '关闭通知',
			'toast.untitled': '未命名会话',
			'native.title': 'DeepSeek Harness',
			'native.body': '「{title}」任务已完成',
			'attention.approval.title': '需要你确认',
			'attention.approval.detail': '有一步操作等待你的授权',
			'attention.approval.detailNamed': '工具 {toolName} 等待你的授权',
			'attention.question.title': '需要你回答',
			'attention.question.detail': '有提问等待你回答',
			'attention.question.detailNamed': '等待你回答：{question}',
			'attention.plan.title': '计划待确认',
			'attention.plan.detail': '计划已就绪，等待你确认',
			'attention.generic.title': '需要你处理',
			'attention.generic.detail': '会话等待你的输入',
			'native.approval': '「{title}」需要你确认：{detail}',
			'native.question': '「{title}」需要你回答：{detail}',
			'native.plan': '「{title}」计划待确认：{detail}',
			'native.generic': '「{title}」需要你处理：{detail}',
		};
		const en = {
			'toast.title': 'Task complete',
			'toast.dismiss': 'Dismiss notification',
			'toast.untitled': 'Untitled session',
			'native.title': 'DeepSeek Harness',
			'native.body': '"{title}" finished',
			'attention.approval.title': 'Approval needed',
			'attention.approval.detail': 'An action is waiting for your authorization',
			'attention.approval.detailNamed': 'Tool {toolName} is waiting for your authorization',
			'attention.question.title': 'Question waiting',
			'attention.question.detail': 'A question is waiting for your answer',
			'attention.question.detailNamed': 'Waiting for your answer: {question}',
			'attention.plan.title': 'Plan ready',
			'attention.plan.detail': 'The plan is ready for your review',
			'attention.generic.title': 'Action needed',
			'attention.generic.detail': 'The session is waiting for your input',
			'native.approval': '"{title}" needs approval: {detail}',
			'native.question': '"{title}" is waiting for your answer: {detail}',
			'native.plan': '"{title}" has a plan to review: {detail}',
			'native.generic': '"{title}" needs your input: {detail}',
		};

		/** Shared empty toast list, so `useState` never churns a new reference. */
		const EMPTY_TOASTS = [];
		/** Selector that keeps the whole status snapshot. */
		const wholeSnapshot = (value) => value;
		/** Never-notifying store pair for a root hook this composition lacks. */
		const subscribeNever = () => () => {};
		const readUndefined = () => undefined;

		/**
		 * Shorten one line of user-facing text for a desktop banner.
		 * @param value - text to clip.
		 * @returns the text, clipped to {@link NATIVE_CONTEXT_LIMIT} characters.
		 */
		function clip(value) {
			if (typeof value !== 'string') return undefined;
			const trimmed = value.trim().replace(/\s+/g, ' ');
			if (trimmed === '') return undefined;
			return trimmed.length > NATIVE_CONTEXT_LIMIT ? `${trimmed.slice(0, NATIVE_CONTEXT_LIMIT - 1)}…` : trimmed;
		}

		/**
		 * Hook-shaped placeholder with the same call shape as a root observation
		 * hook, so a composition without the providing package keeps hook order.
		 * @returns always undefined.
		 */
		function useAbsentSnapshot() {
			return React.useSyncExternalStore(subscribeNever, readUndefined, readUndefined);
		}

		/**
		 * One row of the Client session-list projection.
		 * @param ctx - Client root context.
		 * @param sessionId - session to look up.
		 * @returns the summary row, or undefined when the projection is unavailable.
		 */
		function summaryOf(ctx, sessionId) {
			try {
				return ctx.get('sessions')?.list?.getSnapshot?.().byId?.[sessionId];
			} catch {
				return undefined;
			}
		}

		/**
		 * Whether this session's completion is worth interrupting the user for.
		 * Subagent children finish constantly and are not the user's own task.
		 * @param ctx - Client root context.
		 * @param sessionId - session that stopped running.
		 * @returns true when the session is a top-level session the user owns.
		 */
		function announceable(ctx, sessionId) {
			const summary = summaryOf(ctx, sessionId);
			if (summary === undefined) return true;
			if (summary.blank === true) return false;
			if (summary.origin === 'subagent') return false;
			return summary.parentId === undefined;
		}

		/**
		 * Whether a blocked session is worth interrupting the user for. Unlike a
		 * completion, an interaction genuinely blocks work, so a subagent's
		 * approval or question still concerns the user — a blocked child blocks
		 * the turn they are waiting on. Blank sessions have nothing to answer.
		 * @param ctx - Client root context.
		 * @param sessionId - session holding the pending interaction.
		 * @returns true when the session carries something the user must answer.
		 */
		function answerable(ctx, sessionId) {
			const summary = summaryOf(ctx, sessionId);
			if (summary === undefined) return true;
			if (summary.blank === true) return false;
			if (summary.origin === 'subagent' && !ATTENTION_INCLUDE_SUBAGENTS) return false;
			return true;
		}

		/**
		 * Normalize a pending interaction into one of the known families.
		 * @param interaction - row from the status projection, if any.
		 * @returns `approval`, `question`, `plan`, or `generic`.
		 */
		function attentionKind(interaction) {
			const kind = interaction?.kind;
			if (kind === 'approval') return 'approval';
			if (kind === 'plan-review') return 'plan';
			if (kind === 'question') return 'question';
			return 'generic';
		}

		/**
		 * Locale keys and interpolation for one pending interaction.
		 * @param kind - normalized family from {@link attentionKind}.
		 * @param interaction - the pending interaction itself.
		 * @returns headline key, detail key, and the detail's parameters.
		 */
		function attentionCopy(kind, interaction) {
			if (kind === 'approval') {
				const toolName = clip(interaction?.toolName);
				return toolName === undefined
					? { title: 'attention.approval.title', detail: 'attention.approval.detail', params: {} }
					: {
							title: 'attention.approval.title',
							detail: 'attention.approval.detailNamed',
							params: { toolName },
						};
			}
			if (kind === 'question') {
				const first = Array.isArray(interaction?.questions) ? interaction.questions[0] : undefined;
				const asked = clip(first?.question) ?? clip(first?.header);
				return asked === undefined
					? { title: 'attention.question.title', detail: 'attention.question.detail', params: {} }
					: {
							title: 'attention.question.title',
							detail: 'attention.question.detailNamed',
							params: { question: asked },
						};
			}
			if (kind === 'plan') {
				return { title: 'attention.plan.title', detail: 'attention.plan.detail', params: {} };
			}
			return { title: 'attention.generic.title', detail: 'attention.generic.detail', params: {} };
		}

		/**
		 * Bring the Harness forward and reveal the session that needs attention.
		 * @param ctx - Client root context.
		 * @param sessionId - session to reveal.
		 */
		function reveal(ctx, sessionId) {
			try {
				window.focus();
				ctx.get('uiWorkspace')?.openSession?.(sessionId);
			} catch (error) {
				console.warn('[task-notify] could not reveal the finished session', error);
			}
		}

		/**
		 * Desktop notification for one announced event.
		 * @param title - banner title, the product name.
		 * @param body - banner body.
		 * @param tag - replacement identity; distinct events keep distinct tags so a
		 *   completion banner never silently replaces an unanswered approval.
		 * @param onActivate - what a click on the notification runs.
		 */
		function notifyDesktop(title, body, tag, onActivate) {
			if (typeof Notification === 'undefined') return;
			if (Notification.permission === 'denied') return;
			if (!NATIVE_ALWAYS && document.visibilityState === 'visible') return;
			try {
				const notification = new Notification(title, { body, tag });
				notification.onclick = () => {
					try {
						onActivate();
					} finally {
						notification.close();
					}
				};
			} catch (error) {
				console.warn('[task-notify] desktop notification failed', error);
			}
		}

		/**
		 * Frame-wide toast styles. Geometry and tone follow the shipped Harness
		 * toast (fixed, top-centre, 14/22px); every colour is a theme token, and
		 * the toast-specific ones fall back to tokens the Theme catalog publishes
		 * so a renamed token degrades to the generic surface instead of nothing.
		 * The dot carries the event family: green for a completed task, amber for
		 * a session blocked on the user.
		 */
		const styles = {
			stack: {
				position: 'fixed',
				top: 40,
				left: '50%',
				transform: 'translateX(-50%)',
				zIndex: 1100,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				gap: 8,
				pointerEvents: 'none',
				maxWidth: 'min(520px, calc(100vw - 48px))',
			},
			toast: {
				pointerEvents: 'auto',
				cursor: 'pointer',
				display: 'flex',
				alignItems: 'flex-start',
				gap: 10,
				width: 'max-content',
				maxWidth: 'min(520px, calc(100vw - 48px))',
				padding: '12px 16px',
				borderRadius: 'var(--dsw-radius-lg, 12px)',
				background: 'var(--dsw-alias-toast-bg, var(--dsw-alias-bg-overlay))',
				color: 'var(--dsw-alias-toast-label, var(--dsw-alias-label-primary))',
				boxShadow: 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.18))',
				fontSize: 14,
				lineHeight: '22px',
			},
			dot: {
				flex: 'none',
				width: 8,
				height: 8,
				marginTop: 7,
				borderRadius: '50%',
			},
			body: { flex: '1 1 auto', minWidth: 0 },
			title: { fontWeight: 600 },
			detail: {
				color: 'var(--dsw-alias-label-secondary)',
				overflow: 'hidden',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			},
			dismiss: {
				flex: 'none',
				padding: '0 2px',
				border: 0,
				background: 'none',
				cursor: 'pointer',
				color: 'var(--dsw-alias-label-secondary)',
				fontSize: 14,
				lineHeight: '22px',
			},
		};

		/** Dot colours, one per event family. */
		const dotColor = {
			completion: 'var(--dsw-alias-state-success-primary)',
			attention: 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-error-primary))',
		};

		/**
		 * Client plugin body: own the locale namespace and the overlay entry.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'task-notify: dictionaries');

			// Chromium grants this silently inside the desktop shell; a refusal
			// leaves the in-app toast as the only signal, which is why the desktop
			// call above is allowed to fail.
			if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
				try {
					const asked = Notification.requestPermission();
					if (asked !== undefined && typeof asked.then === 'function') asked.then(undefined, () => {});
				} catch {
					/* the toast still carries the message */
				}
			}

			/**
			 * Toast stack plus completion and pending-interaction detection for
			 * every session.
			 * @param props - root Slot props, carrying the locale seat and the
			 *   session-status observation hook provided by `ui-session`.
			 * @returns the toast stack element.
			 */
			function TaskNotifier(props) {
				const t = props.t;
				const useSessionStatus = props.useSessionStatus ?? useAbsentSnapshot;
				const status = useSessionStatus(wholeSnapshot);

				const [toasts, setToasts] = React.useState(EMPTY_TOASTS);
				const previous = React.useRef(undefined);
				const latest = React.useRef(status);
				const pending = React.useRef(new Map());
				const pendingAttention = React.useRef(new Map());
				const announcedAttention = React.useRef(new Map());
				const toastTimers = React.useRef(new Map());
				const nextKey = React.useRef(0);
				latest.current = status;

				const dismiss = React.useCallback((key) => {
					const timer = toastTimers.current.get(key);
					if (timer !== undefined) {
						clearTimeout(timer);
						toastTimers.current.delete(key);
					}
					setToasts((current) => current.filter((toast) => toast.key !== key));
				}, []);

				/**
				 * Push one toast and its matching desktop banner.
				 * @param family - `completion` or `attention`, choosing dot and TTL.
				 * @param sessionId - session the toast reveals when clicked.
				 * @param headline - the toast's bold first line.
				 * @param detail - the toast's secondary line.
				 * @param body - the desktop banner body.
				 * @param tag - the desktop banner's replacement identity.
				 */
				const announce = React.useCallback(
					(family, sessionId, headline, detail, body, tag) => {
						const key = (nextKey.current += 1);
						const ttl = family === 'attention' ? ATTENTION_TTL_MS : TOAST_TTL_MS;
						setToasts((current) => {
							const grown = current.concat([{ key, family, headline, detail, sessionId }]);
							return grown.length > MAX_TOASTS ? grown.slice(grown.length - MAX_TOASTS) : grown;
						});
						toastTimers.current.set(
							key,
							setTimeout(() => dismiss(key), ttl),
						);
						notifyDesktop(t('native.title'), body, tag, () => reveal(ctx, sessionId));
					},
					[t, dismiss],
				);

				/** Announce a finished turn. */
				const announceCompletion = React.useCallback(
					(sessionId) => {
						const summary = summaryOf(ctx, sessionId);
						const title = summary?.displayTitle || t('toast.untitled');
						announce(
							'completion',
							sessionId,
							t('toast.title'),
							title,
							t('native.body', { title }),
							`dsh-task-notify:completion:${sessionId}`,
						);
					},
					[announce, t],
				);

				/** Announce a session that is now blocked on the user. */
				const announceAttention = React.useCallback(
					(sessionId, interaction) => {
						const summary = summaryOf(ctx, sessionId);
						const title = summary?.displayTitle || t('toast.untitled');
						const kind = attentionKind(interaction);
						const copy = attentionCopy(kind, interaction);
						const detail = t(copy.detail, copy.params);
						announce(
							'attention',
							sessionId,
							t(copy.title),
							detail,
							t(`native.${kind}`, { title, detail }),
							`dsh-task-notify:${kind}:${sessionId}`,
						);
					},
					[announce, t],
				);

				React.useEffect(() => {
					if (status === undefined) return;
					const before = previous.current;
					previous.current = status;
					// The first observation is the baseline: sessions already idle
					// when the page loaded never ran in this page's lifetime, and
					// interactions already pending were not raised for this page to
					// answer.
					if (before === undefined) return;

					for (const [sessionId, entry] of status) {
						// --- a turn finished -------------------------------------
						if (entry?.running === true) {
							// Running again — a follow-up round, a retry, or new input.
							const timer = pending.current.get(sessionId);
							if (timer !== undefined) {
								clearTimeout(timer);
								pending.current.delete(sessionId);
							}
						} else if (before.get(sessionId)?.running === true && announceable(ctx, sessionId)) {
							if (!pending.current.has(sessionId)) {
								pending.current.set(
									sessionId,
									setTimeout(() => {
										pending.current.delete(sessionId);
										if (latest.current?.get(sessionId)?.running === true) return;
										announceCompletion(sessionId);
									}, SETTLE_MS),
								);
							}
						}

						// --- the Agent is blocked on the user ---------------------
						const interaction = entry?.pendingInteraction;
						const identity = typeof interaction?.key === 'string' ? interaction.key : interaction === undefined ? undefined : 'present';
						if (identity === undefined) {
							// Answered, cancelled, or delegated: a later request for
							// this session is a new event and must be announced.
							announcedAttention.current.delete(sessionId);
							const timer = pendingAttention.current.get(sessionId);
							if (timer !== undefined) {
								clearTimeout(timer);
								pendingAttention.current.delete(sessionId);
							}
						} else if (
							announcedAttention.current.get(sessionId) !== identity &&
							!pendingAttention.current.has(sessionId) &&
							answerable(ctx, sessionId)
						) {
							pendingAttention.current.set(
								sessionId,
								setTimeout(() => {
									pendingAttention.current.delete(sessionId);
									const current = latest.current?.get(sessionId)?.pendingInteraction;
									const now = typeof current?.key === 'string' ? current.key : current === undefined ? undefined : 'present';
									// Still the same unanswered request?
									if (now !== identity) return;
									announcedAttention.current.set(sessionId, identity);
									announceAttention(sessionId, current);
								}, ATTENTION_SETTLE_MS),
							);
						}
					}

					for (const [sessionId, timer] of pending.current) {
						if (status.has(sessionId)) continue;
						clearTimeout(timer);
						pending.current.delete(sessionId);
					}
					for (const [sessionId, timer] of pendingAttention.current) {
						if (status.has(sessionId)) continue;
						clearTimeout(timer);
						pendingAttention.current.delete(sessionId);
					}
				}, [status, announceCompletion, announceAttention]);

				React.useEffect(
					() => () => {
						for (const timer of pending.current.values()) clearTimeout(timer);
						pending.current.clear();
						for (const timer of pendingAttention.current.values()) clearTimeout(timer);
						pendingAttention.current.clear();
						for (const timer of toastTimers.current.values()) clearTimeout(timer);
						toastTimers.current.clear();
					},
					[],
				);

				if (toasts.length === 0) return null;

				return h(
					'div',
					{ [ROOT_ATTRIBUTE]: '', style: styles.stack, role: 'status', 'aria-live': 'polite' },
					toasts.map((toast) =>
						h(
							'div',
							{
								key: toast.key,
								style: styles.toast,
								'data-task-notify-kind': toast.family,
								title: `${toast.headline} · ${toast.detail}`,
								onClick: () => {
									dismiss(toast.key);
									reveal(ctx, toast.sessionId);
								},
							},
							h('span', { style: { ...styles.dot, background: dotColor[toast.family] }, 'aria-hidden': true }),
							h(
								'div',
								{ style: styles.body },
								h('div', { style: styles.title }, toast.headline),
								h('div', { style: styles.detail }, toast.detail),
							),
							h(
								'button',
								{
									type: 'button',
									style: styles.dismiss,
									'aria-label': t('toast.dismiss'),
									onClick: (event) => {
										event.stopPropagation();
										dismiss(toast.key);
									},
								},
								'\u2715',
							),
						),
					),
				);
			}

			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'task-notify',
						order: 90,
						locale: NAMESPACE,
					},
					TaskNotifier,
				),
			);
		}

		return {
			inject: ['slots', 'locale'],
			apply,
		};
	},
});
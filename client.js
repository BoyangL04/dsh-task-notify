/**
 * Browser half of `@local/dsh-task-notify`.
 *
 * A session that stops running has finished the work the user asked for. This
 * module turns that transition — read from the Client session-status
 * projection — into two visible signals:
 *
 *   1. a toast in the frame-wide `shell.overlay` slot, and
 *   2. a desktop notification through the renderer's Notification API.
 *
 * Both are announced only after the session has stayed idle for `SETTLE_MS`,
 * which keeps a multi-round goal or a Retry from firing once per round.
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
		/** How long one toast stays on screen, in milliseconds. */
		const TOAST_TTL_MS = 9000;
		/** Most toasts kept at once; older ones drop off the top. */
		const MAX_TOASTS = 3;
		/** Send the desktop notification even while the Harness window is in front. */
		const NATIVE_ALWAYS = true;
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
		};
		const en = {
			'toast.title': 'Task complete',
			'toast.dismiss': 'Dismiss notification',
			'toast.untitled': 'Untitled session',
			'native.title': 'DeepSeek Harness',
			'native.body': '"{title}" finished',
		};

		/** Shared empty toast list, so `useState` never churns a new reference. */
		const EMPTY_TOASTS = [];
		/** Selector that keeps the whole status snapshot. */
		const wholeSnapshot = (value) => value;
		/** Never-notifying store pair for a root hook this composition lacks. */
		const subscribeNever = () => () => {};
		const readUndefined = () => undefined;

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
		 * Bring the Harness forward and reveal the finished session.
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
		 * Desktop notification for one finished session.
		 * @param t - locale translate seat.
		 * @param title - display title of the finished session.
		 * @param onActivate - what a click on the notification runs.
		 */
		function notifyDesktop(t, title, onActivate) {
			if (typeof Notification === 'undefined') return;
			if (Notification.permission === 'denied') return;
			if (!NATIVE_ALWAYS && document.visibilityState === 'visible') return;
			try {
				const notification = new Notification(t('native.title'), {
					body: t('native.body', { title }),
					tag: 'dsh-task-notify',
				});
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
				background: 'var(--dsw-alias-state-success-primary)',
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
			 * Toast stack plus completion detection for every session.
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

				const announce = React.useCallback(
					(sessionId) => {
						const summary = summaryOf(ctx, sessionId);
						const title = summary?.displayTitle || t('toast.untitled');
						const key = (nextKey.current += 1);
						setToasts((current) => {
							const grown = current.concat([{ key, sessionId, title }]);
							return grown.length > MAX_TOASTS ? grown.slice(grown.length - MAX_TOASTS) : grown;
						});
						toastTimers.current.set(
							key,
							setTimeout(() => dismiss(key), TOAST_TTL_MS),
						);
						notifyDesktop(t, title, () => reveal(ctx, sessionId));
					},
					[t, dismiss],
				);

				React.useEffect(() => {
					if (status === undefined) return;
					const before = previous.current;
					previous.current = status;
					// The first observation is the baseline: sessions already idle
					// when the page loaded never ran in this page's lifetime.
					if (before === undefined) return;

					for (const [sessionId, entry] of status) {
						if (entry?.running === true) {
							// Running again — a follow-up round, a retry, or new input.
							const timer = pending.current.get(sessionId);
							if (timer !== undefined) {
								clearTimeout(timer);
								pending.current.delete(sessionId);
							}
							continue;
						}
						if (before.get(sessionId)?.running !== true) continue;
						if (!announceable(ctx, sessionId)) continue;
						if (pending.current.has(sessionId)) continue;
						pending.current.set(
							sessionId,
							setTimeout(() => {
								pending.current.delete(sessionId);
								if (latest.current?.get(sessionId)?.running === true) return;
								announce(sessionId);
							}, SETTLE_MS),
						);
					}

					for (const [sessionId, timer] of pending.current) {
						if (status.has(sessionId)) continue;
						clearTimeout(timer);
						pending.current.delete(sessionId);
					}
				}, [status, announce]);

				React.useEffect(
					() => () => {
						for (const timer of pending.current.values()) clearTimeout(timer);
						pending.current.clear();
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
								title: t('native.body', { title: toast.title }),
								onClick: () => {
									dismiss(toast.key);
									reveal(ctx, toast.sessionId);
								},
							},
							h('span', { style: styles.dot, 'aria-hidden': true }),
							h(
								'div',
								{ style: styles.body },
								h('div', { style: styles.title }, t('toast.title')),
								h('div', { style: styles.detail }, toast.title),
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

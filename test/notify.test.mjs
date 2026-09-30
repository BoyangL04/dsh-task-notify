/**
 * Regression harness for the browser half of @local/dsh-task-notify.
 *
 * Runs the real `client.js` — the artifact the Harness Host serves to the page,
 * not a copy — inside a minimal React + cordis + fake-clock sandbox, and
 * asserts both announced families plus every case that must stay silent:
 *
 *   - a finished turn (`running: true -> false`), and
 *   - a session blocked on the user (`pendingInteraction`: approval, question,
 *     plan-review).
 *
 * Run it with `node test/notify.test.mjs`, or `npm test`.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT = new URL('../client.js', import.meta.url);
const source = readFileSync(CLIENT, 'utf8');

const failures = [];
let checks = 0;
const check = (label, condition, detail) => {
	checks += 1;
	if (condition) console.log(`  ok   ${label}`);
	else {
		failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
		console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
	}
};

/* ------------------------------------------------------------- zh dictionary */
/* Copied from client.js on purpose: a drifted key makes these checks fail loud. */
const ZH = {
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
const t = (key, params) => {
	const template = ZH[key] ?? `«missing:${key}»`;
	return params === undefined ? template : template.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
};

/* ---------------------------------------------------------------- fake clock */
const clock = (() => {
	let now = 0;
	let nextId = 1;
	const timers = new Map();
	return {
		setTimeout(fn, delay) {
			const id = nextId++;
			timers.set(id, { fn, at: now + (Number(delay) || 0) });
			return id;
		},
		clearTimeout(id) {
			timers.delete(id);
		},
		advance(ms) {
			const target = now + ms;
			for (;;) {
				let pick = null;
				for (const [id, timer] of timers) {
					if (timer.at > target) continue;
					if (pick === null || timer.at < pick.timer.at) pick = { id, timer };
				}
				if (pick === null) break;
				timers.delete(pick.id);
				now = pick.timer.at;
				pick.timer.fn();
			}
			now = target;
		},
	};
})();

/* ------------------------------------------------------------ React harness */
function createReact() {
	let hooks = [];
	let index = 0;
	let pendingEffects = [];
	let dirty = false;
	const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

	const React = {
		createElement(type, props, ...children) {
			return { type, props: props ?? {}, children };
		},
		useState(initial) {
			const i = index++;
			if (hooks[i] === undefined) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
			const slot = hooks[i];
			return [
				slot.value,
				(next) => {
					slot.value = typeof next === 'function' ? next(slot.value) : next;
					dirty = true;
				},
			];
		},
		useRef(initial) {
			const i = index++;
			if (hooks[i] === undefined) hooks[i] = { current: initial };
			return hooks[i];
		},
		useCallback(fn, deps) {
			const i = index++;
			const slot = hooks[i];
			if (slot === undefined || !sameDeps(slot.deps, deps)) hooks[i] = { deps, fn };
			return hooks[i].fn;
		},
		useEffect(fn, deps) {
			const i = index++;
			const slot = hooks[i] ?? (hooks[i] = {});
			if (!sameDeps(slot.deps, deps)) pendingEffects.push({ i, fn });
			slot.deps = deps;
		},
		useSyncExternalStore(subscribe, getSnapshot, _server, selector) {
			const i = index++;
			if (hooks[i] === undefined) hooks[i] = { unsub: subscribe(() => { dirty = true; }) };
			const snapshot = getSnapshot();
			return selector === undefined ? snapshot : selector(snapshot);
		},
	};

	const commit = () => {
		const list = pendingEffects;
		pendingEffects = [];
		for (const { i, fn } of list) {
			const slot = hooks[i];
			if (typeof slot.cleanup === 'function') slot.cleanup();
			const cleanup = fn();
			slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
		}
	};

	return {
		React,
		/** Drop every hook slot: the component mounted next starts from scratch. */
		reset() {
			hooks = [];
			index = 0;
			pendingEffects = [];
			dirty = false;
		},
		render(Component, props) {
			let tree;
			for (let pass = 0; pass < 25; pass++) {
				index = 0;
				pendingEffects = [];
				dirty = false;
				tree = Component(props);
				commit();
				if (!dirty) break;
			}
			if (dirty) throw new Error('render did not settle');
			return tree;
		},
	};
}

/* -------------------------------------------------------- sandbox + plugin load */
const notifications = [];
class FakeNotification {
	constructor(title, options) {
		this.title = title;
		this.body = options?.body;
		this.tag = options?.tag;
		this.closed = false;
		notifications.push(this);
	}
	close() {
		this.closed = true;
	}
}
FakeNotification.permission = 'granted';
FakeNotification.requestPermission = async () => 'granted';

let loaded;
const sandbox = {
	window: { __ModuleLoader__: { load: (d) => { loaded = d; } }, focus: () => {} },
	document: { visibilityState: 'visible' },
	console,
	Notification: FakeNotification,
	setTimeout: clock.setTimeout,
	clearTimeout: clock.clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

console.log('模块注册');
check('id 是包名', loaded?.id === '@local/dsh-task-notify', String(loaded?.id));
check('factory 是函数', typeof loaded?.factory === 'function');

const harnessSeed = createReact();
const face = loaded.factory((specifier) => {
	if (specifier === 'react') return harnessSeed.React;
	throw new Error(`unexpected require(${specifier})`);
});
check('inject 声明 slots + locale', JSON.stringify(face.inject) === '["slots","locale"]', JSON.stringify(face.inject));

/* ------------------------------------------------------------------ fake ctx */
const opened = [];
const localeNamespaces = [];
const registrations = [];
const byIdRef = { current: {} };
const ctx = {
	effect(fn) {
		const d = fn();
		return typeof d === 'function' ? d : () => {};
	},
	locale: {
		register(ns, dicts) {
			localeNamespaces.push({ ns, locales: Object.keys(dicts) });
			return () => {};
		},
	},
	slots: {
		inject: (_key, cb) => { cb(); return () => {}; },
		register(options, component) {
			registrations.push({ options, component });
			return () => {};
		},
	},
	get(name) {
		if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: byIdRef.current }) } };
		if (name === 'uiWorkspace') return { openSession: (id) => { opened.push(id); } };
		return undefined;
	},
};
face.apply(ctx);
const Component = registrations[0].component;
check('注册了一个 shell.overlay 条目', registrations.length === 1 && registrations[0].options.name === 'shell.overlay');
check('locale 字典含 zh + en', localeNamespaces[0]?.ns === 'task-notify' && localeNamespaces[0].locales.join(',') === 'zh,en');

/* --------------------------------------------------------------- scenario API */
const flatten = (children) => {
	const out = [];
	for (const child of children ?? []) {
		if (Array.isArray(child)) out.push(...flatten(child));
		else out.push(child);
	}
	return out;
};
const textOf = (node) => {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string' || typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(textOf).join('');
	return flatten(node.children).map(textOf).join('');
};

/** A fresh component mount with its own hooks, status source and fixtures. */
function mount(byId) {
	byIdRef.current = byId;
	// The component captured the factory's React object at load time, so every
	// scenario must drive THAT harness; reset() gives each one a fresh mount.
	harnessSeed.reset();
	let status = new Map();
	const useSessionStatus = (selector) =>
		harnessSeed.React.useSyncExternalStore(() => () => {}, () => status, undefined, selector);
	const props = { t, useSessionStatus };
	return {
		render: () => harnessSeed.render(Component, props),
		publish: (map) => { status = map; },
	};
}
const row = (running, pendingInteraction) => ({ running, pendingInteraction, completionUnread: false });
const toastNodes = (tree) => flatten(tree?.children).filter((n) => n && n.type === 'div' && n.props?.['data-task-notify-kind'] !== undefined);

const ROOT_SESSION = { root: { id: 'root', displayTitle: '重构通知模块', running: true, blank: false } };
const CHILD_SESSION = {
	root: { id: 'root', displayTitle: '重构通知模块', running: true, blank: false },
	child: { id: 'child', displayTitle: '子代理任务', running: true, blank: false, parentId: 'root', origin: 'subagent' },
};
const BLANK_SESSION = {
	root: { id: 'root', displayTitle: '重构通知模块', running: true, blank: false },
	blank: { id: 'blank', displayTitle: 'New Session', running: true, blank: true },
};

/* ============================== 完成路径 ============================== */
console.log('\n完成路径');
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	check('首帧只作基线，不提示', m.render() === null);

	m.publish(new Map([['root', row(false, undefined)]]));
	let tree = m.render();
	check('结算窗口内不提示', tree === null);
	clock.advance(1199);
	check('1199ms 仍不提示', m.render() === null);
	clock.advance(1);
	tree = m.render();
	const [toast] = toastNodes(tree);
	check('1200ms 后出现提示', toast !== undefined);
	check('family 是 completion', toast?.props?.['data-task-notify-kind'] === 'completion', JSON.stringify(toast?.props?.['data-task-notify-kind']));
	check('标题是「任务完成」', textOf(toast).includes('任务完成'), textOf(toast));
	check('副行是会话标题', textOf(toast).includes('重构通知模块'), textOf(toast));
	check('横幅标题是产品名', notifications[0]?.title === 'DeepSeek Harness');
	check('横幅正文含会话标题', notifications[0]?.body === '「重构通知模块」任务已完成', String(notifications[0]?.body));
	check('横幅 tag 是 completion 家族', notifications[0]?.tag === 'dsh-task-notify:completion:root', String(notifications[0]?.tag));
	clock.advance(9000);
	check('完成提示 9s 后自动消失', m.render() === null);
}
{
	const m = mount(CHILD_SESSION);
	notifications.length = 0;
	m.publish(new Map([['child', row(true, undefined)], ['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['child', row(false, undefined)], ['root', row(true, undefined)]]));
	m.render();
	clock.advance(3000);
	m.render();
	check('子代理跑完静默', notifications.length === 0, `count=${notifications.length}`);
}
{
	const m = mount(BLANK_SESSION);
	notifications.length = 0;
	m.publish(new Map([['blank', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['blank', row(false, undefined)]]));
	m.render();
	clock.advance(3000);
	m.render();
	check('空白会话跑完静默', notifications.length === 0, `count=${notifications.length}`);
}
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(false, undefined)]]));
	m.render();
	clock.advance(600);
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	clock.advance(5000);
	m.render();
	check('结算窗口内又跑起来(续跑/重试)则取消', notifications.length === 0, `count=${notifications.length}`);
}

/* ============================== 待处理路径 ============================== */
console.log('\n待处理路径：授权');
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	const approval = { kind: 'approval', key: 'approval:1', toolName: 'bash' };
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, approval)]]));
	let tree = m.render();
	check('交互出现后 600ms 内不提示', tree === null);
	clock.advance(599);
	check('599ms 仍不提示', m.render() === null);
	clock.advance(1);
	tree = m.render();
	const [toast] = toastNodes(tree);
	check('600ms 后出现提示（与完成不同，running 仍为 true）', toast !== undefined);
	check('family 是 attention', toast?.props?.['data-task-notify-kind'] === 'attention', JSON.stringify(toast?.props?.['data-task-notify-kind']));
	check('标题是「需要你确认」', textOf(toast).includes('需要你确认'), textOf(toast));
	check('副行带工具名', textOf(toast).includes('工具 bash 等待你的授权'), textOf(toast));
	check('横幅 tag 是 approval 家族', notifications[0]?.tag === 'dsh-task-notify:approval:root', String(notifications[0]?.tag));
	check('横幅正文带工具名', notifications[0]?.body === '「重构通知模块」需要你确认：工具 bash 等待你的授权', String(notifications[0]?.body));

	// 同一请求因任何原因重新发布（新对象、同 key）→ 不重复
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:1', toolName: 'bash' })]]));
	m.render();
	clock.advance(3000);
	m.render();
	check('同一 key 重复发布会去重', notifications.length === 1, `count=${notifications.length}`);
}
{
	// 被委派给下游监听者（auto-review）后消失 → 不该打扰用户
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:9', toolName: 'bash' })]]));
	m.render();
	clock.advance(300);
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	clock.advance(5000);
	m.render();
	check('600ms 内消失(已委派)则不提示', notifications.length === 0, `count=${notifications.length}`);
}
{
	// 答复后同一个会话的下一个请求仍要通知
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	// Baseline first: a request that was already pending when the page loaded
	// was never raised for this page to answer, so the baseline publishes it too.
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:1', toolName: 'bash' })]]));
	m.render();
	clock.advance(700);
	m.render();
	check('第一个请求通知一次', notifications.length === 1, `count=${notifications.length}`);
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:2', toolName: 'write' })]]));
	m.render();
	clock.advance(700);
	m.render();
	check('答复后的下一个请求会再次通知', notifications.length === 2, `count=${notifications.length}`);
	check('第二次带的是新请求的工具名', notifications[1]?.body?.includes('write') === true, String(notifications[1]?.body));
}
{
	// 没有 key 的交互：退化成 'present' 身份，仍应通知且不重复
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', toolName: 'bash' })]]));
	m.render();
	clock.advance(700);
	m.render();
	check('无 key 的交互仍会通知', notifications.length === 1, `count=${notifications.length}`);
	m.publish(new Map([['root', row(true, { kind: 'approval', toolName: 'other' })]]));
	m.render();
	clock.advance(700);
	m.render();
	check('无 key 时同一会话不重复通知', notifications.length === 1, `count=${notifications.length}`);
}

console.log('\n待处理路径：提问 / 计划确认 / 子代理 / 截断');
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'question', key: 'question:1', questions: [{ header: '选哪个', question: '用 A 还是 B？' }] })]]));
	m.render();
	clock.advance(700);
	const tree = m.render();
	const [toast] = toastNodes(tree);
	check('提问的标题是「需要你回答」', textOf(toast).includes('需要你回答'), textOf(toast));
	check('提问正文带问题文本', textOf(toast).includes('用 A 还是 B？'), textOf(toast));
	check('提问横幅 tag 是 question 家族', notifications[0]?.tag === 'dsh-task-notify:question:root', String(notifications[0]?.tag));
}
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'plan-review', key: 'question:7', questions: [{ header: '计划' }] })]]));
	m.render();
	clock.advance(700);
	const tree = m.render();
	const [toast] = toastNodes(tree);
	check('plan-review 映射为「计划待确认」', textOf(toast).includes('计划待确认'), textOf(toast));
	check('计划横幅 tag 是 plan 家族', notifications[0]?.tag === 'dsh-task-notify:plan:root', String(notifications[0]?.tag));
}
{
	const m = mount(CHILD_SESSION);
	notifications.length = 0;
	m.publish(new Map([['child', row(true, undefined)], ['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['child', row(true, { kind: 'approval', key: 'approval:3', toolName: 'bash' })], ['root', row(true, undefined)]]));
	m.render();
	clock.advance(700);
	m.render();
	check('子代理的授权照发（与完成不同）', notifications.length === 1, `count=${notifications.length}`);
	check('子代理授权用子会话的标题', notifications[0]?.body?.includes('子代理任务') === true, String(notifications[0]?.body));
}
{
	const m = mount(BLANK_SESSION);
	notifications.length = 0;
	m.publish(new Map([['blank', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['blank', row(true, { kind: 'approval', key: 'approval:4', toolName: 'bash' })]]));
	m.render();
	clock.advance(700);
	m.render();
	check('空白会话的交互静默', notifications.length === 0, `count=${notifications.length}`);
}
{
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	const longTool = 'x'.repeat(200);
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:5', toolName: longTool })]]));
	m.render();
	clock.advance(700);
	m.render();
	const body = String(notifications[0]?.body ?? '');
	const carried = body.replace('「重构通知模块」需要你确认：工具 ', '').replace(' 等待你的授权', '');
	check('超长工具名截断到 140 字符', carried.length === 140, `len=${carried.length}`);
	check('截断以省略号收尾', carried.endsWith('…'), carried.slice(-3));
}
{
	// 待处理提示停留 15s（比完成的 9s 长）
	const m = mount(ROOT_SESSION);
	notifications.length = 0;
	m.publish(new Map([['root', row(true, undefined)]]));
	m.render();
	m.publish(new Map([['root', row(true, { kind: 'approval', key: 'approval:6', toolName: 'bash' })]]));
	m.render();
	clock.advance(700);
	check('待处理提示已出现', toastNodes(m.render()).length > 0);
	clock.advance(9000);
	check('9s 时待处理提示仍在（不像完成那样消失）', toastNodes(m.render()).length > 0);
	clock.advance(6000);
	check('15s 后待处理提示消失', toastNodes(m.render()).length === 0);
}

console.log('');
if (failures.length > 0) {
	console.error(`${failures.length}/${checks} 项失败：`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exitCode = 1;
} else {
	console.log(`${checks} 项断言全部通过`);
}

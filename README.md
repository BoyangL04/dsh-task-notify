# 任务通知（@local/dsh-task-notify）

两种值得打断你的事件，各自给出两个提示：

- **任务完成**：Agent 从 `running` 变回 `idle`；
- **会话卡在你身上**：出现了待处理的交互——工具越权授权（`approval`）、提问（`question`）、计划待确认（`plan-review`）。

两个提示分别是：

- **应用内提示（toast）**：出现在页面顶部正中，和 Harness 自带 toast 同一位置与色调；
- **系统通知（macOS 横幅）**：走渲染进程的 Notification API，由 DeepSeek Harness 应用本身发出，点一下即可把 Harness 拉到前台并打开对应会话。

## 安装方式

已经装进 `desktop` profile，重启后仍然有效：

- `~/.dsh/profiles/desktop/package.json`：依赖 `"@local/dsh-task-notify": "link:/Users/maerceci/dsh-plugins/dsh-task-notify"`，并把 `@local/dsh-task-notify` 追加进 `dsh.profile.bundles`；
- `~/.dsh/profiles/desktop/node_modules/@local/dsh-task-notify` 是指向本目录的软链接；
- 因此**不要移动或删除本目录**，否则 profile 会加载失败（在 插件 页面取消勾选即可解除）。

本目录就是包的实体，改完保存即生效（Host 会监听 `client.js` 并热重载；必要时刷新页面 ⌘R）。

**换到另一台 Mac**：见 [MIGRATION.md](./MIGRATION.md)。三种方式（GitHub / 拷目录 `./install.sh` / 手动），包含前置运行时版本要求、三层验证方法和卸载回滚。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 清单：`dsh.bundle.patch` 指向本包的 patch，`dsh.client` 声明浏览器半边与加载顺序 |
| `cordis.patch.yml` | 向 profile 插入一行插件条目（id `task-notify`） |
| `index.js` | Host 半边，空实现——只在 Loader 里占一行，让 Client 扫描器发现本包 |
| `client.js` | 全部功能：读会话状态投影、判定完成与待处理交互、渲染 toast、发系统通知 |
| `install.sh` | 在另一台 Mac 上安置并安装（`--check` 只体检；`--profile` 指定 profile） |
| `MIGRATION.md` | 迁移到另一台 Mac 的完整步骤、验证方法、卸载回滚 |

## 判定规则

在客户端订阅 `ui-session` 提供的 `useSessionStatus`（即 `api-session/status` 的会话状态投影）。每行状态形如 `{ running, pendingInteraction, completionUnread }`，本插件只读前两个字段。

**任务完成**——只认 `running: true → false` 这个跳变：

- 首次拿到的快照只当基线，不通知（否则每次刷新页面都会炸一堆旧会话）；
- 变回 idle 后再等 `SETTLE_MS`（1.2 秒）才通知；期间若又变回 running（goal 自动续跑、重试、用户又发了一条），则取消，不会一个任务响好几次；
- 跳过子代理会话（`origin: 'subagent'` / 带 `parentId`）和空白会话（`blank`）——子代理频繁结束，不是「你的任务」。

**等待你处理**——只认 `pendingInteraction` 从无到有（它带一个稳定的 `key`）：

- 交互出现后等 `ATTENTION_SETTLE_MS`（0.6 秒）才通知；这个窗口足够让「被委托给下一个监听者」的请求（例如 `experimental-auto-review` 接管）在通知前就消失——那种请求根本没轮到你；
- 按 `key` 去重：状态投影因任何原因重新发布（同一个请求换了新对象）都不会重复通知；
- 请求被回答 / 取消后清除该会话的去重标记，所以同一个会话的下一个请求会正常通知；
- 一次请求被回答后，`running` 可能仍然为 `true`；此时只发「等待处理」，不会顺带发一条完成通知；
- 与完成不同，**子代理的授权 / 提问照发**（`ATTENTION_INCLUDE_SUBAGENTS`）：子代理卡住也就卡住了你正在等的那一轮。空白会话仍然跳过；
- 横幅正文会带上有用的上下文（工具名、提问文本，截断到 140 字符）。

系统通知在窗口可见时也照发（与 Codex 一致）。完成与等待处理用**不同的 tag**，所以一条完成通知不会悄悄顶掉一条还没处理的授权。

## 可调参数

都在 `client.js` 顶部：

| 常量 | 默认 | 含义 |
|---|---|---|
| `SETTLE_MS` | `1200` | 完成通知：idle 持续多久才通知；调大更不容易被续跑打断，调小更即时 |
| `ATTENTION_SETTLE_MS` | `600` | 等待处理通知：交互持续多久才通知；调大可吞掉更多「被委托掉」的请求 |
| `TOAST_TTL_MS` | `9000` | 完成提示停留时长 |
| `ATTENTION_TTL_MS` | `15000` | 等待处理提示停留时长（更长，因为它是待办的） |
| `MAX_TOASTS` | `3` | 同时最多堆几个提示 |
| `NATIVE_ALWAYS` | `true` | 改成 `false` 则只在页面不可见时才发系统通知 |
| `ATTENTION_INCLUDE_SUBAGENTS` | `true` | 改成 `false` 则子代理的授权 / 提问也静默 |
| `NATIVE_CONTEXT_LIMIT` | `140` | 横幅正文里上下文的最大字符数 |

提示点颜色区分事件类型：完成是绿色（`--dsw-alias-state-success-primary`），等待处理是琥珀色（`--dsw-alias-state-warn-primary`，缺失时回退到 error 色）。

## 文案

走 Harness 的 locale 服务（命名空间 `task-notify`），`zh` / `en` 两套字典就在 `client.js` 里，跟随界面语言切换。

## 卸载

用 `plugin_manager` 的 `remove_bundle`（target `@local/dsh-task-notify`），或在 设置 → 插件 里取消勾选 / 卸载；也可以直接删掉本目录再手动清理 profile 的 `package.json`。删除本目录前请先从 profile 里解除。

## 已验证 / 未验证

- 已验证：包被 profile 加载（Loader 条目 `include:task-notify`）、`client.js` 被实时以当前版本送到页面（改一次 rev 变一次）、`shell.overlay` 槽位里出现 `task-notify` 占用者且 `active: true`、槽位向该条目提供 `useSessionStatus`；`client.js` 的判定逻辑用桩 React + 假时钟跑过 32 项断言（结算窗口、续跑去重、子代理静默、空白会话静默、通知文案、点击打开会话、自动消失、授权 / 提问 / 计划三类交互、按 key 去重、被委托请求静默、回答后新请求重新通知、横幅文本截断、两类 TTL 与不同 tag）。
- 未验证：真实点击与系统横幅的实际观感，需要人眼确认一次。

# 任务完成通知（@local/dsh-task-notify）

会话把任务跑完（Agent 从 `running` 变回 `idle`）时给出两个提示：

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
| `client.js` | 全部功能：读会话状态投影、判定完成、渲染 toast、发系统通知 |
| `install.sh` | 在另一台 Mac 上安置并安装（`--check` 只体检；`--profile` 指定 profile） |
| `MIGRATION.md` | 迁移到另一台 Mac 的完整步骤、验证方法、卸载回滚 |

## 判定规则

在客户端订阅 `ui-session` 提供的 `useSessionStatus`（即 `api-session/status` 的会话状态投影），只认 **`running: true → false`** 这个跳变，并且：

- 首次拿到的快照只当基线，不通知（否则每次刷新页面都会炸一堆旧会话）；
- 变回 idle 后再等 `SETTLE_MS`（1.2 秒）才通知；期间若又变回 running（goal 自动续跑、重试、用户又发了一条），则取消，不会一个任务响好几次；
- 跳过子代理会话（`origin: 'subagent'` / 带 `parentId`）和空白会话（`blank`）——子代理频繁结束，不是「你的任务」；
- 系统通知在窗口可见时也照发（与 Codex 一致）。

## 可调参数

都在 `client.js` 顶部：

| 常量 | 默认 | 含义 |
|---|---|---|
| `SETTLE_MS` | `1200` | idle 持续多久才通知；调大更不容易被续跑打断，调小更即时 |
| `TOAST_TTL_MS` | `9000` | 应用内提示停留时长 |
| `MAX_TOASTS` | `3` | 同时最多堆几个提示 |
| `NATIVE_ALWAYS` | `true` | 改成 `false` 则只在页面不可见时才发系统通知 |

## 文案

走 Harness 的 locale 服务（命名空间 `task-notify`），`zh` / `en` 两套字典就在 `client.js` 里，跟随界面语言切换。

## 卸载

用 `plugin_manager` 的 `remove_bundle`（target `@local/dsh-task-notify`），或在 设置 → 插件 里取消勾选 / 卸载；也可以直接删掉本目录再手动清理 profile 的 `package.json`。删除本目录前请先从 profile 里解除。

## 已验证 / 未验证

- 已验证：包被 profile 加载（Loader 条目 `include:task-notify`）、`client.js` 被实时以当前版本送到页面、`shell.overlay` 槽位里出现 `task-notify` 占用者且 `active: true`、槽位向该条目提供 `useSessionStatus`；`client.js` 的判定逻辑用桩 React + 假时钟跑过 28 项断言（结算窗口、续跑去重、子代理静默、通知文案、点击打开会话、自动消失）。
- 未验证：真实点击与系统横幅的实际观感，需要人眼确认一次。

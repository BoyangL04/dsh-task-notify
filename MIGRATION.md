# 迁移到另一台 Mac

本插件是纯 JS + 声明式 bundle，没有构建步骤、没有依赖、没有二进制，迁移本质上就是「把 5 个文件放到某处，再让 profile 选中它」。

## 前置条件

- **目标机的 DSH 要够新**：运行时必须含 `@deepseek-ai/dsh-client-ui-session`（它提供本插件读取的 `useSessionStatus` 根 hook，以及状态投影里的 `pendingInteraction` 字段）。本插件在桌面版 **0.1.7-rc.2** 上验证通过；旧的 0.1.1 npm 版没有这个包，装上去不会报错，但**不会有任何提示**。
- **系统通知授权**：第一次没看到横幅时，去「系统设置 → 通知 → DeepSeek Harness」放行。
- 三条路都会把源码落在 `~/dsh-plugins/dsh-task-notify`（`install.sh` 负责安置），这样和原机器路径一致，文档里的命令可以照抄。

## 方式 A：GitHub（推荐，目标机最省事）

仓库根目录就是包本身（`package.json` 带 `dsh.bundle.patch` 在根上），所以可以直接用 git 地址安装。

在目标机上，让 DSH Agent 执行：

```
用 plugin_manager 的 install_bundle，target 用 https://github.com/BoyangL04/dsh-task-notify
```

`github:BoyangL04/dsh-task-notify` 这种简写 pnpm 也认，但完整 URL 最不容易有歧义。目标机有 `dsh` 命令行时也可以：

```bash
dsh plugin --profile desktop add https://github.com/BoyangL04/dsh-task-notify
```

要点：

- **公开仓库**时目标机不需要任何凭据；**私有仓库**需要目标机也能访问（ssh key 或凭据助手）。
- 锁版本：`github:BoyangL04/dsh-task-notify#v1.1.0`。
- `install_bundle` 会先 `git ls-remote` 探测仓库，所以目标机要有 `git`（装 Xcode Command Line Tools 即可）。
- **代价**：git 安装会把包拷进 profile，不再指向你的工作副本 —— 改本机 `client.js` 不会热重载。更新走 `dsh plugin --profile desktop update @local/dsh-task-notify`，或让 Agent 重新 install。想在原机器上继续「改一下保存就生效」，就保留现在的 `link:` 安装。

## 方式 B：拷目录（AirDrop / U 盘 / scp）

1. 把整个 `dsh-task-notify` 目录，或 `dsh-task-notify-1.0.0.tar.gz` 拷到目标机；
2. 解压后进入该目录，执行 `./install.sh`（先看一眼可以加 `--check`）；
3. 脚本会：检查运行时是否够新 → 把源码安置到 `~/dsh-plugins/dsh-task-notify` → 有 `dsh` 命令行就自动装，没有就打印一句可以直接发给应用内 Agent 的话。

## 方式 C：手动（不推荐，仅在 A / B 都不通时）

不要手写 profile 的 `package.json` / `cordis.patch.yml`，也不要在 profile 目录里直接跑 pnpm —— 官方入口是 `plugin_manager` 的 `install_bundle`。

真要手动，profile 侧其实只需要三件事同时成立，缺一个整个 profile 都起不来：

1. `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 加 `"@local/dsh-task-notify": "link:/绝对/路径"`；
2. 同一个文件的 `dsh.profile.bundles` 追加 `"@local/dsh-task-notify"`；
3. `~/.dsh/profiles/<profile>/node_modules/@local/dsh-task-notify` 是指向源码目录的软链接（目录要先 `mkdir -p`）。

## 装完怎么验证（三层，逐层递进）

1. **Loader 里有行**：`cordis_inspect_query`，platform `host`、provider `Config`、method `listConfigs`，`input.name` 传 `@local/dsh-task-notify`。应看到 `include:task-notify`；`status: "absent"` 是正常的（本插件没有 Config 声明）。
2. **客户端挂上了**：`cordis_inspect_query`，platform `client`、provider `Slots`、method `listSubTree`，`input.root` 传 `shell.overlay`。`selected.occupants` 里应有 `id: task-notify`、`active: true`，且 `catalog.standardProps` 里有 `useSessionStatus`。
3. **真弹窗**：让 Agent 跑一个几秒的任务，等它答完。约 1.2 秒后应看到页面顶部居中的「任务完成」提示（绿点）+ 一条系统横幅；点提示或横幅应把 Harness 拉到前台并打开那个会话。
4. **等待处理**：让 Agent 跑一个会触发授权（或提问 / 计划确认）的任务，别急着点。约 0.6 秒后应看到「需要你确认 / 需要你回答 / 计划待确认」提示（琥珀色点，停留 15 秒）+ 对应横幅；答完之后再触发下一次，应该照样通知。

## 卸载 / 回滚

- `plugin_manager` 的 `remove_bundle`，target `@local/dsh-task-notify`；或在 设置 → 插件 里取消勾选 / 卸载。
- 之后可以删掉 `~/dsh-plugins/dsh-task-notify`（**先解除再删**，因为 profile 里是软链接，删了会让 profile 加载失败）。
- 出问题时：`plugin_manager` 的 `list_bundles` 看该 bundle 是否 `error`；应用内 设置 → 插件 页面可以一键取消勾选恢复。

## 环境差异备忘

| 项 | 说明 |
|---|---|
| profile 名 | 桌面版是 `desktop`；`dsh web` 一般是 `web`；用 `--profile` 显式指定 |
| `dsh` 命令行 | 只有装过 npm 全局版才有；桌面版不附带，此时走应用内 Agent |
| profile 被占用 | 桌面版运行时 `dsh plugin ...` 可能拿不到 profile 锁，先退出应用 |
| 本插件的外部影响 | 不发网络请求、不读凭据、不写文件、不注册 Host 资源；只在浏览器侧注册一个 `shell.overlay` 槽位条目 |

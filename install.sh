#!/bin/bash
#
# 在另一台 Mac 上安置 @local/dsh-task-notify。
#
# 这个脚本只做两件事，都不碰 profile 的 package.json / cordis.patch.yml：
#   1. 把本包复制到固定的 $HOME/dsh-plugins/dsh-task-notify（路径和原机器一致）；
#   2. 检查这台机器上的 dsh 运行时是否具备本插件依赖的客户端能力。
# 真正的「装进 profile」交给 dsh 官方路径：dsh 命令行或应用内的 plugin_manager。
#
# 用法：
#   ./install.sh                     # 检查 + 安置 + 安装（能自动装就自动装）
#   ./install.sh --check             # 只检查与安置前的体检，不做任何安装
#   ./install.sh --profile web       # 目标 profile 不是 desktop 时指定
#
set -euo pipefail

PKG_NAME="@local/dsh-task-notify"
STAGE_DIR="$HOME/dsh-plugins/dsh-task-notify"
APP="/Applications/DeepSeek Harness.app"
APP_ASAR="$APP/Contents/Resources/app.asar"
REQUIRED_CLIENT_PKG="dsh-client-ui-session"

MODE=install
PROFILE="${DSH_PROFILE:-desktop}"

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check ;;
    --profile)
      [ $# -ge 2 ] || { echo "--profile 需要参数" >&2; exit 2; }
      PROFILE="$2"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
  shift
done

SRC="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/4  运行时检查 =="
# app.asar 的文件表是明文 JSON，位于归档开头；截一段出来用 grep 判断包是否存在。
# 不用管道接 grep -q：grep 提前退出会给 head 送 SIGPIPE，pipefail 会因此误判失败。
ASAR_HEAD=""
cleanup() { [ -n "$ASAR_HEAD" ] && rm -f "$ASAR_HEAD"; }
trap cleanup EXIT
FOUND=""
if [ -f "$APP_ASAR" ]; then
  ASAR_HEAD="$(mktemp -t dsh-asar-head)"
  head -c 4000000 "$APP_ASAR" > "$ASAR_HEAD" 2>/dev/null || true
  if grep -aq "$REQUIRED_CLIENT_PKG" "$ASAR_HEAD"; then
    VER="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist" 2>/dev/null || echo "?")"
    FOUND="桌面版 DeepSeek Harness $VER"
  fi
fi
if [ -z "$FOUND" ] && command -v dsh >/dev/null 2>&1; then
  BIN="$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)"
  PKGROOT="$(cd "$(dirname "$BIN")/.." && pwd)"
  if [ -d "$PKGROOT/node_modules/@deepseek-ai/$REQUIRED_CLIENT_PKG" ]; then
    FOUND="命令行 dsh（$PKGROOT）"
  fi
fi

if [ -n "$FOUND" ]; then
  echo "  ok   找到可用运行时：$FOUND"
else
  echo "  警告 没找到同时含 $REQUIRED_CLIENT_PKG 的 dsh 运行时。"
  echo "        本插件依赖较新的客户端会话状态投影（useSessionStatus）。"
  echo "        装上去不会报错，但任务完成时不会有任何提示。"
  echo "        请先把目标机的 DeepSeek Harness 更新到含该包的版本"
  echo "        （本机验证于 0.1.7-rc.2；旧的 0.1.1 npm 版没有这个包）。"
fi

echo
echo "== 2/4  安置源码 =="
mkdir -p "$(dirname "$STAGE_DIR")"
if [ "$SRC" = "$STAGE_DIR" ]; then
  echo "  ok   源码已在 $STAGE_DIR"
else
  if [ -e "$STAGE_DIR" ]; then
    BACKUP="$STAGE_DIR.bak-$(date +%Y%m%d%H%M%S)"
    mv "$STAGE_DIR" "$BACKUP"
    echo "  ok   已有同名目录，先移到 $BACKUP"
  fi
  mkdir -p "$STAGE_DIR"
  cp -R "$SRC/." "$STAGE_DIR/"
  echo "  ok   已复制到 $STAGE_DIR"
fi

echo
echo "== 3/4  目标 profile 状态 =="
PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
INSTALLED=0
if [ ! -d "$PROFILE_DIR" ]; then
  echo "  警告 找不到 profile 目录：$PROFILE_DIR"
  case "$PROFILE" in
    desktop) echo "        桌面版会自己创建它——先打开一次 DeepSeek Harness 再重跑本脚本。" ;;
    *) echo "        用 --profile 指定正确的 profile 名（如 web / headless）。" ;;
  esac
elif [ -f "$PROFILE_DIR/package.json" ] && grep -q "$PKG_NAME" "$PROFILE_DIR/package.json"; then
  INSTALLED=1
  echo "  ok   该 profile 已经声明了 $PKG_NAME"
else
  echo "  ·    该 profile 还没装本插件"
fi

echo
echo "== 4/4  安装 =="
if [ "$MODE" = check ]; then
  echo "  --check：到此为止，本次没有做任何安装写入。"
  exit 0
fi
if [ "$INSTALLED" = 1 ]; then
  echo "  已经装过了，无需重复安装。"
  echo "  改 $STAGE_DIR/client.js 保存即热重载；必要时刷新页面（⌘R）。"
  exit 0
fi
if command -v dsh >/dev/null 2>&1; then
  echo "  执行：dsh plugin --profile $PROFILE add $STAGE_DIR"
  echo "  （桌面版正在运行时它会占用 profile，请先退出应用）"
  dsh plugin --profile "$PROFILE" add "$STAGE_DIR"
  echo "  ok   完成。重新打开 DeepSeek Harness。"
else
  cat <<EOF
  这台机器上没有 dsh 命令行，改用应用内的 Agent 安装（官方路径，效果相同）：

    1. 打开 DeepSeek Harness，新建一个会话（工作目录随意）；
    2. 把下面这句话原样发给它：

         用 plugin_manager 的 install_bundle，把 $STAGE_DIR 装到当前 profile

    3. 等它回报 "application": "applied" 后，刷新页面（⌘R）或重开应用。

  装完想确认，可以让它再跑一次：

         用 cordis_inspect_query 查 client 的 Slots，root 选 shell.overlay，
         看看有没有 id 为 task-notify 的占用者，以及 standardProps 里有没有 useSessionStatus
EOF
fi

#!/bin/bash
# 仅用于 Mac 假邮件 SQLCipher 功能探针：不安装、不签名、不迁移用户邮箱。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "仅支持 macOS 开发机" >&2
  exit 2
fi
if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "缺少 Xcode xcodebuild" >&2
  exit 2
fi
if [[ -z "${SQLCIPHER_PREFIX:-}" ]]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "需要显式 SQLCIPHER_PREFIX，或安装 Homebrew SQLCipher" >&2
    exit 2
  fi
  SQLCIPHER_PREFIX="$(brew --prefix sqlcipher)"
fi
export SQLCIPHER_PREFIX

BUILD_ROOT="$ROOT/.build/sqlcipher-sync"
if [[ -e "$BUILD_ROOT" ]]; then
  echo "临时编译目录已存在；请先确认内容，拒绝覆盖：$BUILD_ROOT" >&2
  exit 2
fi
mkdir -p "$(dirname "$BUILD_ROOT")"
node "$ROOT/scripts/sqlcipher/prepare-sync-source.mjs" "$BUILD_ROOT"

# 仍为开发者专用无签名版本；正式发行须使用可信产物及自身代码签名。
xcodebuild -project "$BUILD_ROOT/MailSync.xcodeproj" \
  -target mailsync -configuration Release \
  CODE_SIGNING_ALLOWED=NO \
  CONFIGURATION_BUILD_DIR="$BUILD_ROOT/bin" \
  build
OUTPUT="$BUILD_ROOT/bin/mailsync"
if [[ ! -x "$OUTPUT" ]]; then
  echo "C++ 引擎未生成预期产物，不得发布" >&2
  exit 1
fi
if ! otool -L "$OUTPUT" | grep -qi sqlcipher; then
  echo "引擎没有链接到 SQLCipher，禁止发布" >&2
  exit 1
fi
echo "C++ 仅开发编译输出: $OUTPUT"
echo "下一步使用全新假数据 profile 调用 scripts/sqlcipher/probe.mjs 验证；不触碰真实邮箱。"

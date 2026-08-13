#!/usr/bin/env bash
# MeetingBoard 启动脚本（macOS / Linux）
cd "$(dirname "$0")" || exit 1
export PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请安装 Node.js LTS: https://nodejs.org"
  echo "Node.js not found. Please install Node.js LTS: https://nodejs.org"
  exit 1
fi

echo "正在启动会议排班台 Starting MeetingBoard..."
echo "浏览器打开 http://localhost:${PORT}"
node server.js

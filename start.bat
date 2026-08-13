@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 会议排班台 MeetingBoard

where node >nul 2>nul
if %errorlevel%==0 (
  set "NODE_CMD=node"
) else (
  if exist "runtime\node.exe" (
    set "NODE_CMD=runtime\node.exe"
  ) else (
    echo [1/2] 未检测到 Node.js，正在下载便携版运行时（约 40MB，仅首次需要）...
    echo [1/2] Node.js not found. Downloading portable runtime (40MB, first run only)...
    if not exist runtime mkdir runtime
    curl -L -o runtime\node.zip https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip
    if errorlevel 1 (
      echo.
      echo 下载失败。请手动安装 Node.js LTS 后重新运行：https://nodejs.org
      echo Download failed. Please install Node.js LTS manually: https://nodejs.org
      pause
      exit /b 1
    )
    tar -xf runtime\node.zip -C runtime
    del runtime\node.zip
    for /d %%d in (runtime\node-v*) do set "NODE_CMD=%%d\node.exe"
    echo 便携版运行时就绪 Runtime ready.
  )
)

echo.
echo 正在启动会议排班台 Starting MeetingBoard...
echo 启动后请在浏览器打开  http://localhost:3000
echo 局域网其他成员请访问  http://本机IP:3000 （本机IP见下方提示）
"%NODE_CMD%" server.js
echo.
echo 服务已停止 Server stopped.
pause

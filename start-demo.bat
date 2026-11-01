@echo off
chcp 65001 >nul
setlocal
title AnswerY智能客服中台 - 一键启动

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"

rem Node 优先用 PATH，其次在常见安装位置里自动找（官方安装包 / fnm）
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  for /d %%D in ("%USERPROFILE%\.fnm\node-portable\*") do if exist "%%D\node.exe" set "PATH=%%D;%PATH%"
)
where node >nul 2>nul
if errorlevel 1 (
  echo [x] 未找到 node，请安装 Node.js 20+ 并加入 PATH，或改用 npm run dev 手动启动前端
  pause
  exit /b 1
)

if not exist "%BACKEND%\.venv\Scripts\python.exe" (
  echo [x] 未找到后端虚拟环境：%BACKEND%\.venv
  echo     请先创建虚拟环境并安装 requirements.txt
  pause
  exit /b 1
)

echo [1/5] 启动 MySQL / Redis 容器 ...
docker info >nul 2>nul
if errorlevel 1 (
  echo [x] Docker Desktop 未运行，请先启动 Docker Desktop 后重试。
  pause
  exit /b 1
)
docker compose -f "%BACKEND%\docker-compose.yml" up -d

set /a TRIES=0
:wait_mysql
docker inspect --format "{{.State.Health.Status}}" ecom-mysql 2>nul | findstr "healthy" >nul && goto mysql_ok
set /a TRIES+=1
if %TRIES% GEQ 30 goto mysql_slow
ping -n 3 127.0.0.1 >nul
goto wait_mysql
:mysql_slow
echo     MySQL 启动较慢，先继续启动后端（后端会自行重试连接）
goto mysql_done
:mysql_ok
echo     MySQL / Redis 已就绪
:mysql_done

echo [2/5] 关闭旧的后端 / 前端进程 ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'uvicorn' -and $_.CommandLine -match 'app.main' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'node_modules.next.dist.bin.next' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
for %%P in (8000 3000) do (
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do taskkill /f /pid %%I >nul 2>nul
)
ping -n 3 127.0.0.1 >nul

echo [3/5] 启动后端 FastAPI（http://127.0.0.1:8000）...
start "DEMO-Backend" /D "%BACKEND%" "%BACKEND%\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000

echo [4/5] 启动前端 Next.js（生产模式 http://localhost:3000）...
set "NEED_BUILD="
powershell -NoProfile -Command "$b=(Get-Item '%FRONTEND%\.next\BUILD_ID' -ErrorAction SilentlyContinue).LastWriteTime; if(-not $b){exit 1}; $s=Get-ChildItem '%FRONTEND%\app','%FRONTEND%\components','%FRONTEND%\lib','%FRONTEND%\next.config.mjs','%FRONTEND%\package.json' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1; if($s){exit 1} else {exit 0}"
if errorlevel 1 set "NEED_BUILD=1"
if defined NEED_BUILD (
  echo     检测到源码有更新，首次构建约 30-60 秒 ...
  start "DEMO-Frontend" /D "%FRONTEND%" cmd /k "npm run build && npm start"
) else (
  start "DEMO-Frontend" /D "%FRONTEND%" cmd /k "npm start"
)

echo [5/5] 等待服务就绪 ...
set /a TRIES=0
:wait_backend
set /a TRIES+=1
set "CODE=000"
for /f %%S in ('powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8000/health).StatusCode}catch{0}"') do set "CODE=%%S"
if "%CODE%"=="200" goto backend_ok
if %TRIES% GEQ 30 goto backend_fail
ping -n 2 127.0.0.1 >nul
goto wait_backend
:backend_fail
echo     [!] 后端启动超时，请查看 DEMO-Backend 窗口中的报错
goto backend_done
:backend_ok
echo     后端健康检查通过
:backend_done

set /a TRIES=0
:wait_front
set /a TRIES+=1
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul && goto front_ok
if %TRIES% GEQ 180 goto front_fail
ping -n 2 127.0.0.1 >nul
goto wait_front
:front_fail
echo     [!] 前端启动超时，请查看 DEMO-Frontend 窗口中的报错
goto front_done
:front_ok
echo     前端已就绪
:front_done

set "ACCESS=yc-demo-2026"
for /f "tokens=2 delims==" %%A in ('findstr /b "DEMO_ACCESS_TOKEN=" "%FRONTEND%\.env.local" 2^>nul') do set "ACCESS=%%A"
start "" "http://localhost:3000/?k=%ACCESS%"

echo.
echo ============================================================
echo  演示环境已启动：
echo    前端     http://localhost:3000/?k=%ACCESS%
echo    后端     http://127.0.0.1:8000/health
echo    API 文档 http://127.0.0.1:8000/docs
echo  关闭：直接关闭两个黑色窗口即可
echo ============================================================
ping -n 6 127.0.0.1 >nul
endlocal

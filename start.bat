@echo off
chcp 65001 >nul
echo ========================================
echo   상세페이지 분석기 시작
echo ========================================
echo.

cd /d "%~dp0"

if not exist node_modules (
    echo [설치] 패키지 설치 중...
    call npm install
    echo.
    echo [설치] Playwright 브라우저 설치 중...
    npx playwright install chromium
    echo.
)

:: 포트 사용 중인지 체크
netstat -ano | findstr :8150 | findstr LISTENING >nul 2>&1
if %errorlevel%==0 (
    echo [알림] 이미 실행 중입니다. 브라우저를 엽니다.
    start http://localhost:8150
    pause
    exit /b
)

echo [시작] 서버 실행 중...
echo http://localhost:8150 에서 접속하세요
echo.
echo Ctrl+C 로 서버를 종료할 수 있습니다.
echo.
start http://localhost:8150
node server.js
pause

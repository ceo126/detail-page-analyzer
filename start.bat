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
)

echo [시작] 서버 실행 중...
echo http://localhost:8150 에서 접속하세요
echo.
start http://localhost:8150
node server.js
pause

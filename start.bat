@echo off
chcp 65001 >NUL
cd /d "%~dp0"

:: ANSI 색상 코드 활성화
for /f "tokens=3" %%a in ('reg query "HKCU\Console" /v VirtualTerminalLevel 2^>nul') do set "VT=%%a"
if not defined VT (
    reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >NUL 2>&1
)

:: ESC 문자 정의
for /f %%a in ('echo prompt $E ^| cmd') do set "ESC=%%a"

:: 색상 정의
set "GREEN=%ESC%[92m"
set "CYAN=%ESC%[96m"
set "YELLOW=%ESC%[93m"
set "RED=%ESC%[91m"
set "BOLD=%ESC%[1m"
set "RESET=%ESC%[0m"

echo.
echo %CYAN%========================================%RESET%
echo %BOLD%%CYAN%   상세페이지 분석기 서버%RESET%
echo %CYAN%========================================%RESET%
echo.

:: Node.js 설치 확인
where node >NUL 2>&1
if %errorlevel% neq 0 (
    echo %RED%[오류] Node.js가 설치되어 있지 않습니다!%RESET%
    echo %YELLOW%       https://nodejs.org 에서 Node.js를 설치해주세요.%RESET%
    echo.
    pause
    exit /b 1
)

:: Node.js 버전 표시
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo %GREEN%[확인]%RESET% Node.js %NODE_VER% 감지됨

:: node_modules 존재 확인
if not exist node_modules (
    echo.
    echo %YELLOW%[설치]%RESET% node_modules가 없습니다. 패키지를 설치합니다...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo %RED%[오류] npm install 실패!%RESET%
        pause
        exit /b 1
    )
    echo.
    echo %YELLOW%[설치]%RESET% Playwright 브라우저 설치 중...
    npx playwright install chromium
    echo.
    echo %GREEN%[완료]%RESET% 패키지 설치 완료!
    echo.
)

:: 포트 사용 중인지 체크
netstat -ano | findstr :8150 | findstr LISTENING >NUL 2>&1
if %errorlevel%==0 (
    echo.
    echo %YELLOW%[알림]%RESET% 이미 포트 %BOLD%8150%RESET%에서 실행 중입니다. 브라우저를 엽니다.
    start http://localhost:8150
    pause
    exit /b
)

echo.
echo %GREEN%[시작]%RESET% 서버를 실행합니다...
echo.
echo   %BOLD%%CYAN%포트: 8150%RESET%
echo   %BOLD%%CYAN%주소: http://localhost:8150%RESET%
echo.
echo %YELLOW%Ctrl+C%RESET% 로 서버를 종료할 수 있습니다.
echo.

:: 브라우저 자동 열기
start http://localhost:8150

:: 서버 실행
node server.js
pause
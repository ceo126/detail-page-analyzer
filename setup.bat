@echo off
chcp 65001 >/dev/null
echo ==========================================
echo   18.상세페이지분석기 - 초기 설정
echo ==========================================
echo.

REM 1. npm 패키지 설치
echo [1/2] npm install 실행 중...
cd /d "
call npm install
echo.

REM 2. .env 설정 안내
if not exist .env (
    echo [2/2] .env 파일이 없습니다.
    echo .env.example 파일을 참고하여 .env 파일을 만들어주세요.
    echo.
    echo 필요한 키:
    type .env.example
    echo.
    copy .env.example .env >/dev/null
    echo .env 파일이 생성되었습니다. 값을 채워주세요.
) else (
    echo [2/2] .env 파일 확인됨
)
echo.
echo ==========================================
echo   설정 완료!necho   start.bat 으로 실행
echo ==========================================
pause
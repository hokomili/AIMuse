@echo off
if "%AIMUSE_NODE24_EXE%"=="" exit /b 1
if "%AIMUSE_NPM_CLI%"=="" exit /b 1
"%AIMUSE_NODE24_EXE%" "%AIMUSE_NPM_CLI%" %*

@echo off
setlocal enabledelayedexpansion

REM Registers this package globally via `npm link`, so its `bin` command
REM (unofficial-vwo-mcp-server) resolves on PATH exactly as if it had been
REM `npm install -g`'d from the registry -- without publishing anywhere.
REM
REM Useful for MCP host configs: once linked, "command": "unofficial-vwo-mcp-server"
REM works in place of "command": "node", "args": ["C:\\absolute\\path\\dist\\index.js"].
REM
REM Usage: scripts\install_package_locally.bat
REM Undo:  npm unlink -g unofficial-vwo-mcp-server

cd /d "%~dp0.."

for /f "delims=" %%i in ('node -p "require('./package.json').name"') do set PACKAGE_NAME=%%i
for /f "delims=" %%i in ('node -p "Object.keys(require('./package.json').bin)[0]"') do set BIN_NAME=%%i

echo ==^> Installing dependencies
call npm install
if errorlevel 1 (
    echo npm install failed.
    exit /b 1
)

echo ==^> Building
call npm run build
if errorlevel 1 (
    echo Build failed.
    exit /b 1
)

echo ==^> Linking %PACKAGE_NAME% globally
call npm link
if errorlevel 1 (
    echo npm link failed.
    exit /b 1
)

echo.
where %BIN_NAME% >nul 2>nul
if errorlevel 1 (
    echo npm link succeeded, but %BIN_NAME% isn't on PATH yet.
    echo Check that npm's global bin directory is on PATH: npm config get prefix
) else (
    echo Linked. %BIN_NAME% resolves to:
    where %BIN_NAME%
    echo Use it in an MCP config as: "command": "%BIN_NAME%"
)

echo To undo: npm unlink -g %PACKAGE_NAME%

endlocal

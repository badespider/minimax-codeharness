@echo off
setlocal DisableDelayedExpansion
if not "%~1"=="" (
  >&2 echo This launcher does not accept arguments. Run it from your project folder.
  exit /b 2
)
set "MINIMAX_CHATGPT_NODE="
set "MINIMAX_CHATGPT_MODEL="
set "MINIMAX_CHATGPT_PREFLIGHT=%~dp0mcode-chatgpt-preflight.ps1"
rem Encoded command is: & $env:MINIMAX_CHATGPT_PREFLIGHT
for /f "tokens=1,* delims=|" %%A in ('""%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand JgAgACQAZQBuAHYAOgBNAEkATgBJAE0AQQBYAF8AQwBIAEEAVABHAFAAVABfAFAAUgBFAEYATABJAEcASABUAA=="') do (
  set "MINIMAX_CHATGPT_NODE=%%A"
  set "MINIMAX_CHATGPT_MODEL=%%B"
)
if not defined MINIMAX_CHATGPT_NODE exit /b 1
if not defined MINIMAX_CHATGPT_MODEL exit /b 1
"%MINIMAX_CHATGPT_NODE%" "%~dp0..\..\dist\cli.js" -m "openai-siwc-experimental/%MINIMAX_CHATGPT_MODEL%"
exit /b %ERRORLEVEL%

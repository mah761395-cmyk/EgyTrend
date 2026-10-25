@echo off
setlocal
REM EgyTrend daily DB backup — schedule this file from Task Scheduler.
REM Use EGYTREND_RUNTIME to override the Node/Bun executable when needed.
set "PROJECT_ROOT=%~dp0.."
if not defined EGYTREND_RUNTIME set "EGYTREND_RUNTIME=node"
if not exist "%PROJECT_ROOT%\backups" mkdir "%PROJECT_ROOT%\backups"
"%EGYTREND_RUNTIME%" "%PROJECT_ROOT%\scripts\backup-db.mjs" >> "%PROJECT_ROOT%\backups\task-run.log" 2>&1
endlocal

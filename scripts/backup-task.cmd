@echo off
setlocal
REM EgyTrend daily DB backup — schedule this file from Task Scheduler.
REM Use EGYTREND_RUNTIME to override the Node/Bun executable when needed.
set "PROJECT_ROOT=%~dp0.."
if not defined EGYTREND_RUNTIME set "EGYTREND_RUNTIME=node"
if not exist "%PROJECT_ROOT%\backups" mkdir "%PROJECT_ROOT%\backups"
REM NTFS hardening: Unix-style 0700/0600 modes are NOT enforced by Windows,
REM so lock the backup folder down to the current user only. Failures here
REM are non-fatal (logged) but backups then rely on encryption (EGYTREND_BACKUP_KEY)
REM for protection.
icacls "%PROJECT_ROOT%\backups" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /deny "Everyone:(OI)(CI)F" >nul 2>&1
"%EGYTREND_RUNTIME%" "%PROJECT_ROOT%\scripts\backup-db.mjs" >> "%PROJECT_ROOT%\backups\task-run.log" 2>&1
endlocal

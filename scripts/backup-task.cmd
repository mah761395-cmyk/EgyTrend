@echo off
REM EgyTrend daily DB backup — launched by Task Scheduler ("EgyTrend DB Backup", daily 03:00)
REM Logs everything to backups\task-run.log; the script itself also appends to backups\backup.log
"C:\Users\TBARK\AppData\Local\Programs\@codebufffreebuff-desktop\resources\bun\bun.exe" "C:\Users\TBARK\Desktop\egytrendd\EgyTrend\scripts\backup-db.mjs" >> "C:\Users\TBARK\Desktop\egytrendd\EgyTrend\backups\task-run.log" 2>&1

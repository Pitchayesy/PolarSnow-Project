@echo off
echo ============================
echo   🛑 กำลังปิดระบบ Polar Snow
echo ============================
echo.
FOR /F "tokens=5" %%P IN ('netstat -aon ^| find ":3000" ^| find "LISTEN"') DO taskkill /F /PID %%P
echo ระบบถูกปิดเรียบร้อยแล้ว
pause

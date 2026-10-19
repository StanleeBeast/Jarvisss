@echo off
rem Entfernt den Autostart der JARVIS Home-Station. Die Energieeinstellungen bleiben unveraendert.
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JARVIS Home-Station.cmd" 2>nul
echo  Autostart entfernt. Die Station startet nur noch, wenn du start.bat doppelklickst.
pause

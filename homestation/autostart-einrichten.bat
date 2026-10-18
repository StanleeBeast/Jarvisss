@echo off
rem Startet die JARVIS Home-Station automatisch nach jeder Windows-Anmeldung (minimiert).
chcp 65001 >nul
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
(
  echo @echo off
  echo start "JARVIS Home-Station" /min "%~dp0start.bat"
) > "%STARTUP%\JARVIS Home-Station.cmd"
if exist "%STARTUP%\JARVIS Home-Station.cmd" (
  echo  Autostart eingerichtet: Die Station startet ab jetzt nach jeder Anmeldung.
) else (
  echo  Autostart konnte nicht eingerichtet werden.
)
echo.
echo  Damit JARVIS dauerhaft Mails abholen kann, darf der Laptop am Strom nicht schlafen.
choice /c JN /m " Energiesparmodus am Strom ausschalten und beim Zuklappen weiterlaufen lassen"
if errorlevel 2 goto done
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
echo  Erledigt: Am Strom geht der Laptop nicht mehr in den Energiesparmodus, Zuklappen ist erlaubt.
echo  Der Bildschirm darf trotzdem ausgehen - das spart Strom und stoert nicht.
:done
echo.
pause

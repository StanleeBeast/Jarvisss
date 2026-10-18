@echo off
rem JARVIS Home-Station starten. Startet nach einem Absturz automatisch neu.
chcp 65001 >nul
title JARVIS Home-Station
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js fehlt auf diesem Laptop.
  echo  Bitte die LTS-Version von https://nodejs.org installieren ^(alles mit "Weiter" bestaetigen^)
  echo  und danach start.bat erneut doppelklicken.
  echo.
  start "" "https://nodejs.org/de/download"
  pause
  exit /b 1
)
:loop
echo  JARVIS Home-Station laeuft. Einrichtung im Browser: http://127.0.0.1:7777
echo  Dieses Fenster offen lassen ^(darf minimiert sein^). Schliessen beendet die Station.
echo.
node "%~dp0jarvis-station.cjs"
if "%errorlevel%"=="3" (
  echo  Die Station laeuft bereits in einem anderen Fenster.
  timeout /t 8 >nul
  exit /b 0
)
echo.
echo  Die Station wurde beendet. Neustart in 15 Sekunden ... ^(Fenster schliessen zum Beenden^)
timeout /t 15 /nobreak >nul
goto loop

# J.A.R.V.I.S. für iPad — Prototyp 0.2

## Inhalt
- `index.html`: die vollständige App
- `manifest.webmanifest` und `sw.js`: PWA-Installation und App-Shell-Cache
- `icon-192.png`, `icon-512.png`: App-Symbole
- `JARVIS_iPad_Prototype.html`: Einzeldatei liegt separat in `/mnt/data`

## Auf dem iPad installieren
Eine installierbare Web-App muss über eine HTTPS-Adresse geöffnet werden. Die HTML-Datei direkt aus „Dateien“ zu öffnen reicht nicht für die PWA-Installation.

1. Entpacke diese ZIP-Datei auf einem Gerät oder lade die enthaltenen Dateien in einen statischen Website-Host hoch.
2. Veröffentliche alle Dateien im selben Ordner über HTTPS (z. B. GitHub Pages oder einen anderen statischen Host).
3. Öffne die HTTPS-Adresse in Safari auf dem iPad.
4. Tippe auf „Teilen“ → „Zum Home-Bildschirm“ (je nach iPadOS: „Zum Home-Bildschirm hinzufügen“). Aktiviere „Als Web-App öffnen“, falls angezeigt.
5. Öffne das neue JARVIS-Symbol auf dem Home-Bildschirm.

## Funktionen
- Lila, responsives JARVIS-Dashboard
- Uhr/Datum, Online-Wetter für Dresden und öffentliche Nachrichten-Schlagzeilen (Netzwerkdienste können ausfallen)
- Sprachausgabe über verfügbare Stimmen im Browser
- Spracheingabe, falls der Browser SpeechRecognition unterstützt
- Persönlichkeitsprofil und bewusst hinzugefügte lokale Erinnerungen
- Lokaler Aufgaben-/Terminplaner mit Export als `.ics` für Apple Kalender
- WhatsApp-Nachricht vorbereiten und öffnen; Senden bleibt beim Nutzer
- E-Mail-Entwurf über Mail-App
- Lokaler Speicher im aktuellen Browser

## Bewusste Grenzen
- Diese PWA hat kein serverseitiges KI-Modell. Sie verwendet Regeln und lokal gespeicherte Einstellungen, nicht freies Schlussfolgern.
- Termine werden nicht automatisch mit iCloud synchronisiert. Die `.ics`-Datei muss in Apple Kalender geöffnet und bestätigt werden.
- WhatsApp kann nicht beliebig ausgelesen oder automatisch bedient werden.
- Eine normale iPad-Web-App darf nicht dauerhaft im Hintergrund das Mikrofon aktiv halten. Kein Wake Word „Jarvis“ bei geschlossener App.
- Erinnerungen in diesem Prototyp sind keine zuverlässigen Hintergrundalarme.
- Wetter und Schlagzeilen benötigen Internet. PWA-Cache speichert nur die Oberfläche.
- Profil/Erinnerungen bleiben im Browser-Speicher auf diesem Gerät; Browserdaten löschen entfernt sie.

## Datenschutz
Keine Passwörter oder hochsensiblen Informationen in die Erinnerungen schreiben. „Meine Daten exportieren“ erstellt eine lokale JSON-Datei. „Lokale App-Daten zurücksetzen“ entfernt die Browserdaten dieses Prototyps.

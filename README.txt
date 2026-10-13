# J.A.R.V.I.S.S.S. für iPad — statische PWA

## Aktueller Stand
Das Repository enthält eine statische Progressive Web App. Sie kann über HTTPS auf GitHub Pages bereitgestellt und auf einem iPad über Safari zum Home-Bildschirm hinzugefügt werden.

## Vorhandene Funktionen
- Responsives Dashboard mit futuristischem Orb und Zeitanzeige
- Wetterdaten von Open-Meteo und Schlagzeilen über öffentliche RSS-Quellen via Drittanbieter-Proxy
- Browser-Sprachausgabe und optionale Spracherkennung, abhängig von iPadOS/Safari
- Lokal gespeichertes Profil, Gesprächsverlauf, Erinnerungen und Aufgaben
- Erinnerungen ansehen, bearbeiten und löschen
- Kalendertermine als .ics-Datei exportieren
- WhatsApp-Text und E-Mail-Entwurf zur manuellen Prüfung vorbereiten
- Designstudio mit Presets, Akzentfarbe, Glow-Intensität, Animationseinstellung und gespeicherten Designs
- Optionaler KI-Backend-Endpunkt; JSON-Antwort erwartet `reply` und optional `model`

## Einrichtung einer echten KI
Die Website ist statisch und kann selbst keine geheimen Schlüssel schützen. In „Designstudio“ oder „Einstellungen“ eine eigene HTTPS-Backend-URL eintragen. Das Backend muss:
- den POST-Endpunkt bereitstellen;
- JSON mit `reply` (und optional `model`) zurückgeben;
- API-Schlüssel ausschließlich serverseitig als Umgebungsvariablen halten;
- Authentifizierung oder Zugriffskontrolle, CORS-Allowlist, Größenlimits, Rate Limits und Timeouts implementieren;
- Nutzereingaben und den übergebenen Kontext als nicht vertrauenswürdige Daten behandeln.

Erwartete Anfragefelder: `messages`, `profile`, `memories`, `feedback`, `timezone`. Der Verbindungstest sendet `mode: "healthcheck"`. Diese Frontend-Erweiterung enthält bewusst keine API-Zugangsdaten und stellt kein bereits funktionsfähiges Backend vor.

## GitHub Pages
1. Repository öffnen.
2. Settings → Pages.
3. Als Quelle „Deploy from a branch“, Branch `main`, Ordner `/ (root)` auswählen.
4. Speichern und den von GitHub angezeigten Veröffentlichungsstatus bzw. Link prüfen.
5. Auf dem iPad in Safari öffnen → Teilen → Zum Home-Bildschirm.

## Grenzen, die weiterhin gelten
- Ohne Backend-URL ist die Unterhaltung weiterhin regelbasiert.
- KI-Anfragen funktionieren erst, wenn Backend, Modell, Authentifizierung und CORS korrekt eingerichtet sind.
- Langzeitgedächtnis liegt derzeit nur im lokalen Browser-Speicher. Keine geräteübergreifende Synchronisierung und keine verschlüsselte Serverdatenbank.
- Kein dauerhaftes Wake Word bei geschlossener App und keine verlässlichen Hintergrundalarme.
- Spotify wird nur geöffnet; direkte Spotify-Web-API-Steuerung ist nicht enthalten.
- Nachrichtenversand und Kalenderübertragung benötigen weiterhin deine manuelle Prüfung bzw. Bestätigung.
- Keine native iPad-App und kein direkter Zugriff auf EventKit, Telefonbuch oder systemweite Anruffunktionen.

## Datenschutz
Das lokale Profil und der Verlauf verbleiben im Browser, bis du die App-Daten löschst. Wenn du eine KI-URL setzt, werden bei KI-Anfragen die letzten Chatnachrichten, Profil, gespeicherte Erinnerungen, Feedback und Zeitzone an diesen Backend-Anbieter übertragen. Trage nur einen Anbieter ein, dem du diese Daten anvertrauen willst. API-Schlüssel gehören nie in GitHub oder Frontend-JavaScript.


## Backend-Proxy mit Cloudflare Workers (Code vorbereitet, Deployment benötigt Kontozugang)

Im Ordner `backend/` liegt ein Cloudflare Worker als Vermittlung zwischen der PWA und der OpenAI API. GitHub Pages führt diesen Code nicht aus; der Worker wird separat veröffentlicht. Eine manuell auslösbare GitHub-Actions-Bereitstellung ist vorbereitet.

### Einmalige Einrichtung (auch vom iPad aus möglich)
1. Du brauchst ein Cloudflare-Konto sowie einen OpenAI API-Schlüssel. Eine ChatGPT-Mitgliedschaft enthält kein API-Guthaben; API-Nutzung kann zusätzliche Kosten verursachen. Prüfe Abrechnung und Nutzungsgrenzen, bevor du Anfragen aktivierst.
2. Erstelle in Cloudflare einen API-Token, der Worker bereitstellen und Worker-Secrets verwalten darf, und notiere die Cloudflare Account ID.
3. Öffne im GitHub-Repository `Settings → Secrets and variables → Actions → New repository secret` und füge diese vier Repository-Secrets hinzu:
   - `CLOUDFLARE_API_TOKEN` — Cloudflare-API-Token
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Account ID
   - `OPENAI_API_KEY` — OpenAI API-Schlüssel
   - `JARVIS_ACCESS_TOKEN` — ein eigenes, langes, zufälliges Zugangstoken, nicht dein OpenAI-Schlüssel
4. Öffne `Actions → Deploy JARVIS AI worker → Run workflow`. Der Workflow veröffentlicht den Worker und setzt die beiden Worker-Secrets serverseitig.
5. Nach erfolgreichem Lauf findest du die Worker-URL im Cloudflare-Dashboard. Der Chat-Endpunkt lautet `https://DEIN-WORKER.workers.dev/api/chat`; der Healthcheck lautet `https://DEIN-WORKER.workers.dev/health`.
6. Trage in JARVIS unter Designstudio/Einstellungen die vollständige URL mit `/api/chat` und dasselbe `JARVIS_ACCESS_TOKEN` ein und führe den Verbindungstest aus. Das Token wird lokal im Browser gespeichert; nutze diese private App nicht auf gemeinsam verwendeten Geräten.

**Sicherheit:** Niemals API-Schlüssel oder Tokens in Chatnachrichten, Dateien, Screenshots oder normalen GitHub-Code posten. Nur in GitHub-Repository-Secrets bzw. Cloudflare-Worker-Secrets speichern. Falls ein Schlüssel versehentlich veröffentlicht wurde, sofort widerrufen und neu erstellen.

### Sicherheitsdetails und Grenzen
- OpenAI-Schlüssel bleiben als Cloudflare Worker Secret serverseitig.
- Ein separates Bearer-Token schützt den persönlichen Endpoint; CORS beschränkt Browser-Ursprünge, ersetzt aber keine Authentifizierung.
- Anfragegröße, Anzahl der Nachrichten, Textlänge und Antwortlänge sind begrenzt; upstream-Fehler werden ohne vertrauliche Antwortdetails gemeldet. Ein robustes, globales Rate-Limit ist noch nicht eingerichtet; Token vertraulich halten und Nutzungs-/Kostenlimits beim Anbieter setzen.
- Für öffentliche oder mehrere Nutzer braucht es zusätzlich robuste Rate Limits, Nutzerkonten und gegebenenfalls eine Datenbank. Dieser Worker ist für eine private Einzelperson-Instanz gedacht, nicht als offener öffentlicher Dienst.
- Das Backend speichert keine Gespräche. Profil und Erinnerungen werden für die jeweilige Anfrage vom Browser mitgeschickt.
- Es wurde hier kein Cloudflare-Account verbunden, kein API-Key eingerichtet und kein Worker deployed. Die Dateien sind vorbereitet; erst nach diesen manuellen Schritten funktioniert die echte Modellanbindung.


## Automatisierte Backend-Tests

- Im Ordner `backend/` liegt eine Node.js-Test-Suite für Authentifizierung, CORS, fehlende Secrets, ungültiges JSON und eine simulierte Modellantwort.
- GitHub Actions führt diese Tests bei Pushes und Pull Requests auf `main` aus: https://github.com/StanleeBeast/Jarvisss/actions
- Die Tests verwenden nur eine simulierte Modellantwort; sie testen keine echte OpenAI-Verbindung und beweisen nicht, dass der Worker deployed ist.

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


## Backend-Proxy mit Cloudflare Workers (bereitgestellt, noch nicht deployed)
Im Ordner `backend/` liegt ein Cloudflare Worker als sichere Vermittlung zwischen der PWA und der OpenAI API. GitHub Pages führt diesen Code nicht aus; der Worker muss separat veröffentlicht werden.

### Einrichtung
1. Ein Cloudflare-Konto öffnen und Node.js/npm auf einem Computer installieren. Das iPad allein ist für die lokale CLI-Einrichtung unpraktisch.
2. `backend/wrangler.toml` prüfen und im Ordner `backend/` ausführen: `npx wrangler login`, danach `npx wrangler secret put OPENAI_API_KEY` und `npx wrangler secret put JARVIS_ACCESS_TOKEN`.
3. Für `JARVIS_ACCESS_TOKEN` ein eigenes, langes zufälliges Token verwenden. Es ist NICHT dein OpenAI API-Key. Niemals einen dieser Werte committen oder in öffentlichen Screenshots teilen.
4. Worker veröffentlichen: `npx wrangler deploy`. Die URL wird von Wrangler ausgegeben.
5. In JARVIS unter Designstudio/Einstellungen die Worker-URL mit Pfad `/api/chat` sowie dasselbe `JARVIS_ACCESS_TOKEN` eintragen. Das Token wird lokal im Browser gespeichert; nutze diese private App nicht auf gemeinsam verwendeten Geräten.
6. Wenn du eine eigene Domain verwendest, setze `ALLOWED_ORIGINS` in den Worker-Secrets/Variablen auf genau die erlaubte Website-Origin. Für GitHub Pages ist das `https://stanleebeast.github.io`.

### Sicherheitsdetails und Grenzen
- OpenAI-Schlüssel bleiben als Cloudflare Worker Secret serverseitig.
- Ein separates Bearer-Token schützt den persönlichen Endpoint; CORS beschränkt Browser-Ursprünge, ersetzt aber keine Authentifizierung.
- Anfragegröße, Anzahl der Nachrichten, Textlänge und Antwortlänge sind begrenzt; upstream-Fehler werden ohne vertrauliche Antwortdetails gemeldet.
- Für öffentliche oder mehrere Nutzer braucht es zusätzlich robuste Rate Limits, Nutzerkonten und gegebenenfalls eine Datenbank. Dieser Worker ist für eine private Einzelperson-Instanz gedacht, nicht als offener öffentlicher Dienst.
- Das Backend speichert keine Gespräche. Profil und Erinnerungen werden für die jeweilige Anfrage vom Browser mitgeschickt.
- Es wurde hier kein Cloudflare-Account verbunden, kein API-Key eingerichtet und kein Worker deployed. Die Dateien sind vorbereitet; erst nach diesen manuellen Schritten funktioniert die echte Modellanbindung.

# J.A.R.V.I.S.S. – Bestandsaufnahme, Status und Fahrplan

Stand: 16.10.2026 · Build 0.6.0 (Phase 0, 1, 2b und 3) · Branch `claude/jarvisss-audit-stabilize-piq5ze`

Diese Datei ist die verbindliche Übersicht darüber, was tatsächlich funktioniert. „Getestet“ heißt hier: durch automatisierte Tests oder einen echten Browserlauf geprüft. Ein Test auf deinem iPad und ein Test gegen echtes Cloudflare/OpenAI stehen jeweils separat aus und sind so gekennzeichnet.

---

## 1. Ausgangslage (vor dieser Änderung)

| Bereich | Befund |
|---|---|
| Repository | `main` mit einer einzigen `index.html` (~700 Zeilen, davon ~450 Zeilen übereinander gestapelte CSS-Schichten aus mehreren Redesigns), `sw.js`, Manifest, Icons, `backend/worker.js`. |
| Branches | `main`, `feature/durable-task-foundation` (PR #1, Entwurf, CI grün). |
| PR #1 | Aufgaben-API (`/api/tasks`), D1-Migration, Einrichtungsanleitung, Validierungs-Workflow. Sauber, aber ohne Tests der API, ohne Frontend und ohne Möglichkeit, D1 ohne Datei-Bearbeitung anzubinden. |
| Oberfläche | Die aktuelle „JARVIS ONE“-Oberfläche blendet die alte Oberfläche per CSS vollständig aus. Dadurch waren **Gedächtnis, Feedback, Planung, Designstudio, Chatverlauf und WhatsApp-Entwurf nicht mehr erreichbar**, obwohl ihr Code lief. |
| Tests | 8 Backend-Tests (Auth, CORS, Fehlerfälle), keine Frontend-Tests. |

### Gefundene Fehler (alle in diesem Schritt behoben)

1. **Einfrieren der Seite**: Ein Beobachter entfernte Emojis aus den Nachrichten-Überschriften, änderte dabei bei jedem Aufruf den Text und löste sich selbst endlos neu aus. Die Seite hing, sobald Nachrichten nach dem Start (z. B. über „↻“) geladen wurden.
2. **CORS ohne `PATCH`**: Der Browser hätte jede Aufgabenänderung (erledigt/verworfen) blockiert.
3. **Agentenschleife**: Bei mehreren Werkzeugaufrufen in einer Modellantwort wurde nur der erste beantwortet. Die OpenAI-API lehnt die nächste Runde dann ab.
4. **Systemprompt widersprach sich**: „Du hast keine Tools außer Textgenerierung“, obwohl Werkzeuge übergeben wurden.
5. **„Stimme stoppen“** stoppte die KI-Stimme (MP3) nicht, nur die Systemstimme. Kein Zeitlimit für die Sprachausgabe-Anfrage.
6. **Spracheingabe** aktualisierte nicht die sichtbare Antwortkarte. Der „Zuhören“-Zustand war ein fester 6,5-Sekunden-Timer statt des echten Mikrofonzustands. Kein Unterschied zwischen „Zugriff verweigert“, „nichts gehört“ usw.
7. **„SYSTEM ONLINE“** war fest eingetragen und wurde nie geprüft.
8. **iPad hochkant (601–900 px)**: Das Eingabefeld wurde auf wenige Zeichen zusammengequetscht.
9. Nach dem Verbinden des Backends wurden die Nachrichten nicht neu geladen. Der Platzhalter „Nachrichten werden geladen …“ blieb stehen.
10. Doppelter Eintrag „Violet“ in den Farbsignaturen. Das Morgenbriefing erschien nur im unsichtbaren Chat.
11. Der Service Worker lieferte JS-Dateien „Cache zuerst“. Neue Deployments wurden nur sichtbar, wenn jemand an die Cache-Version gedacht hatte.

---

## 2. Funktionsstatus nach dieser Änderung

Legende: ✅ vorhanden und getestet · 🟡 vorhanden, nicht ausreichend getestet · 🟠 teilweise · ⬜ nicht implementiert · ⛔ technisch nicht oder nur eingeschränkt möglich

### Kern
| Funktion | Status | Anmerkung |
|---|---|---|
| PWA, Installation über Safari | 🟡 | Manifest und Service Worker geprüft. Installation auf echtem iPad steht aus. |
| Offline-Verhalten | ✅ | Netzwerk zuerst, Cache als Rückfall. ORB und Statuszeile zeigen „OFFLINE“ (Browsertest). |
| Startsequenz | 🟡 | Vorhanden, überspringbar, reduzierte Bewegung wird respektiert. |
| ORB-Zustände | ✅ | Bereit, Zuhören, Verarbeite, Spricht, Bestätigt, Hinweis, Fehler, Offline. Nur aus echten Ereignissen abgeleitet. „Recherchiert“/„Führt aus“ fehlen bewusst, da das Backend Zwischenschritte noch nicht live meldet. Stattdessen zeigt die Antwortkarte, welche Werkzeuge tatsächlich liefen. |
| Systemstatus-Ansicht | ✅ | Gerät + Backend. Jeder Eintrag zeigt „geprüft“ oder „nicht live geprüft“. Echter KI-Test per Knopf (kostet wenige Tokens). |
| Kontrollzentrum (Einstellungen) | ✅ | Tabs: System, Aufgaben, Stimme & KI, Gedächtnis, Planung & Entwürfe, Design, Verlauf. |

### KI und Agent
| Funktion | Status | Anmerkung |
|---|---|---|
| Chat über Cloudflare Worker | ✅ | Mit simuliertem Modell getestet. Test gegen echtes OpenAI steht aus. |
| Werkzeugregister | ✅ | Name, Beschreibung, Schema, Zugriffsart (lesen/vorbereiten), Bestätigungspflicht, Zeitlimit, Verfügbarkeit. |
| Werkzeuge | ✅ | `get_current_time`, `get_news`, `list_tasks` (nur mit D1), `draft_task` (nur Entwurf). Keine verändernden Werkzeuge für das Modell. |
| Grenzen | ✅ | Max. 4 Runden, max. 3 Werkzeugaufrufe pro Runde, Zeitlimit pro Werkzeug und pro Modellaufruf, Größenlimits. |
| Lokaler Regelmodus ohne Backend | 🟡 | Uhrzeit, Wetter, Briefing, „Merk dir: …“, Planung öffnen. |
| Vorschlag statt Ausführung | ✅ | `propose_task`, `propose_task_update`, `propose_memory` erzeugen nur Vorschläge. Die App zeigt eine Karte mit „Speichern“ und „Verwerfen“. Gespeichert wird erst nach dem Tipp, „gespeichert“ erscheint erst nach Bestätigung der Datenbank. Getestet: API (nichts gespeichert vor Bestätigung) und Browser. |
| Zeitangaben | ✅ | Das Modell kennt Datum, Uhrzeit und Zeitzone. Der Server rechnet die lokale Zeit in UTC um, inklusive Sommerzeit (getestet: 25.10.2026), und gibt das Datum mit Wochentag zur Bestätigung zurück. Bei mehrdeutigen Uhrzeiten fragt JARVIS nach. |
| Mehrstufige Planung | 🟡 | „Bereite meinen Tag vor“: Der Agent ruft Uhrzeit, Wetter, Aufgaben und Nachrichten selbst ab (bis zu 5 Runden, 4 Werkzeuge pro Runde). Mit echtem Modell noch nicht live getestet. |
| Abbruch laufender Anfragen | ✅ | Knopf „Abbrechen“ in der Antwortkarte. Ein bereits laufender Serverschritt kann zu Ende laufen, gespeichert wird dabei nichts. |
| Kostenlimits | ✅ | Tageslimits für KI-Anfragen, Tokens und Sprachausgabe (D1, Tag nach deutscher Zeit). Bei Überschreitung wird das Modell gar nicht erst aufgerufen. Anzeige unter System → Kosten & Nutzung. |
| Berechtigungsübersicht | ✅ | System → Berechtigungen des Agenten: welches Werkzeug liest, welches nur vorschlägt, was der Agent nicht kann. |
| Wetter als Werkzeug | ✅ | Open-Meteo, Ort über `WEATHER_LAT`/`WEATHER_LON`/`WEATHER_NAME` im Worker änderbar (Standard: Miltitz). |
| Hörbare Erinnerung zur Uhrzeit | ⬜ | Eine fällige Aufgabe löst noch keinen Ton und keine Benachrichtigung aus. JARVIS sagt das ehrlich. Kommt in Phase 4 (Web-Push bzw. Kurzbefehle). |

### Sprache
| Funktion | Status | Anmerkung |
|---|---|---|
| KI-Stimme (OpenAI `gpt-4o-mini-tts`) | ✅ | Stimme wählbar (Allow-List), stoppbar, mit Zeitlimit, Rückfall auf Systemstimme. |
| Systemstimme | 🟡 | Stimme, Tempo, Tonhöhe, Lautstärke. Klang hängt vom Gerät ab. |
| Spracheingabe | 🟡 | Echter Mikrofonzustand, genaue Fehlermeldungen, optional „vor dem Senden prüfen“. Test auf iPad-Safari steht aus. |
| Wake Word „JARVIS“ im Hintergrund | ⛔ | Für Websites auf iPadOS nicht erlaubt. Alternativen: Mikrofonknopf, Kurzbefehle (Phase 4). |

### Daten und Gedächtnis
| Funktion | Status | Anmerkung |
|---|---|---|
| Aufgaben in D1 (anlegen, lesen, erledigen, verwerfen, wieder öffnen) | ✅ | 11 API-Tests gegen echtes SQLite mit der echten Migration, plus Browsertest. **Läuft bei dir erst nach der D1-Einrichtung (Abschnitt 4).** |
| Gedächtnis (Erinnerungen, Stilhinweise) in D1 | ✅ | Anlegen, Lesen auf einem anderen Gerät, Bearbeiten, Löschen (mit Bestätigung) getestet (API + 2-Geräte-Browsertest). Vorher nur lokal gespeicherte Einträge werden **erst nach deiner ausdrücklichen Zustimmung** hochgeladen. Ohne D1 bleibt alles lokal. |
| Gerätesitzungen statt gemeinsamem Token | ✅ | Eigener, rotierender Schlüssel pro Gerät, 15-Minuten-Zugangsschlüssel, Kopplung per Einmal-Code, Widerruf und Abmeldung, Sperre bei Wiederverwendung eines alten Schlüssels. Siehe Abschnitt 5. |
| Aktionsprotokoll | ✅ | Anmeldungen, Kopplungen, Widerrufe, Aufgaben- und Gedächtnisänderungen, **ohne Inhalte**. Sichtbar unter Einstellungen → Geräte. |
| Profil, Stimme, Design | 🟡 | Weiterhin **nur lokal** im Browser. |
| Routinen, Projekte als eigene Strukturen | ⬜ | Gedächtnisarten `routine` und `project` existieren, eigene Ansichten mit Zeiten und Status folgen (Phase 2c/8). |

### Integrationen
| Funktion | Status | Anmerkung |
|---|---|---|
| Nachrichten (Google-News-RSS über Worker) | ✅ | Mit Quelle und Uhrzeit. Echter Abruf ist nur nach Deployment prüfbar. |
| Wetter (Open-Meteo) | 🟡 | Fester Ort Miltitz/Nebelschütz. In der Testumgebung nicht erreichbar, daher dort ungetestet. |
| Kalender | 🟠 | Nur `.ics`-Export. ⛔ Direkter iCloud-Zugriff ist aus einer Website nicht möglich und braucht eine native App (EventKit, Phase 5). |
| WhatsApp / E-Mail | 🟠 | Nur vorbereiteter Entwurf, Versand durch dich. ⛔ Kein offizieller Zugriff auf private Chats. |
| Goodnotes / Lernassistent | ⬜ | Phase 6, zuerst PDF-Import. ⛔ Kein direkter Zugriff auf die Goodnotes-Bibliothek. |
| Automatisierungen / Zeitpläne | ⬜ | Phase 4. |
| Designstudio | 🟠 | Farbsignatur, Akzentfarbe, Glow und Animationen wirken auf die Hauptansicht. Layout-Varianten sind deaktiviert und klar gekennzeichnet. Speicherung nur lokal. |

---

## 3. Prioritäten und Abhängigkeiten

```
[Phase 1 Stabilität]  ✅ erledigt (dieser PR)
        │
[D1 einrichten]  ← DU (Abschnitt 4, ca. 10 Min. im Browser)
        │
[Phase 2a Aufgaben]  ✅ Code fertig, wartet auf D1
        │
[Phase 2b: Gerätesitzungen + Gedächtnis-Sync] ✅ erledigt ──► [Phase 2c: Routinen/Projekte/Präferenzen strukturiert]
        │                              │
        ▼                              ▼
[Phase 3 Agent: verändernde Werkzeuge mit Bestätigung, Planung, Abbruch, Kostenlimit pro Tag]
        │
        ├─► [Phase 4 Automatisierungen: Cron-Briefing, Kurzbefehle, Web-Push]
        ├─► [Phase 6 Lernassistent: PDF-Import → Lernzettel/Karteikarten/Quiz]
        ├─► [Phase 7 Nachrichten-Import (manuell)]
        └─► [Phase 8 Tagesplaner]  ◄── braucht Aufgaben + Routinen (+ Kalender)
[Phase 5 Kalender]  braucht native Begleit-App (Mac + Xcode nötig)
[Phase 9 Design]  parallel möglich
```

Nächster sinnvoller Schritt: **Phase 4 (Automatisierungen)**: Morgenbriefing zur gewünschten Uhrzeit, Erinnerungen zu fälligen Aufgaben per Web-Push (iOS 16.4+ für Home-Bildschirm-Web-Apps), Cloudflare-Cron für serverseitige Zeitpläne und Apple-Kurzbefehle für „Ankunft zu Hause“ bzw. „Wecker stellen“.

---

## 4. Was du selbst tun musst (alles im iPad-Browser möglich)

> Niemals Schlüssel oder Tokens in den Chat, in Issues oder in Dateien schreiben. Nur in GitHub-Secrets bzw. Cloudflare.

### 4.1 Prüfen, ob das Backend schon deployed ist
1. JARVIS öffnen → **Einstellungen → System → „Jetzt prüfen“**.
2. „Backend nicht bereit“ bedeutet: noch nicht eingerichtet oder nicht deployed. Dann zuerst die Schritte im README (Abschnitt „Backend-Proxy“).
3. Meldung „Der deployte Worker ist älter als dieses Frontend“: Nach dem Merge **Actions → Deploy JARVIS AI worker → Run workflow** ausführen.

### 4.2 D1-Datenbank für Aufgaben einrichten
1. Cloudflare-Dashboard → **Storage & Databases → D1 → Create** → Name `jarvisss-db`.
2. Die angezeigte **Database ID** kopieren. Sie ist Konfiguration, kein Geheimnis.
3. Der vorhandene Cloudflare-API-Token braucht zusätzlich die Berechtigung **Account → D1 → Edit**. Im Dashboard unter *My Profile → API Tokens* bearbeiten.
4. GitHub → Repository → **Settings → Secrets and variables → Actions → Reiter „Variables“ → New repository variable**: Name `D1_DATABASE_ID`, Wert = Database ID.
5. **Actions → Deploy JARVIS AI worker → Run workflow.** Der Workflow führt zuerst die Tests aus, bindet dann die Datenbank an, wendet die Migration an und deployt.
6. In JARVIS: **System → Jetzt prüfen** → „Datenbank (D1): Verbunden“. Danach unter **Aufgaben** eine Aufgabe anlegen.

### 4.3 Auf dem iPad testen (steht aus)
- Safari → Website öffnen → Teilen → **Zum Home-Bildschirm**. Die App vom Home-Bildschirm starten.
- Mikrofon antippen, Zugriff erlauben, „Welche Aufgaben habe ich?“ sagen.
- „Stimme stoppen“ während einer Antwort. Flugmodus an: ORB wird grau, Status „OFFLINE“.
- Probleme bitte mit Screenshot der Ansicht **System** melden (enthält keine Geheimnisse).

---

## 5. Authentifizierung (umgesetzt in Build 0.5.0)

| Schlüssel | Lebensdauer | Wo gespeichert | Zweck |
|---|---|---|---|
| Admin-Schlüssel `JARVIS_ACCESS_TOKEN` | dauerhaft | GitHub-/Cloudflare-Secret; auf dem Gerät nur bis zur Anmeldung | Ersteinrichtung, Notfallzugang |
| Geräteschlüssel | 30 Tage, verlängert sich bei Nutzung, **rotiert bei jeder Erneuerung** | `localStorage` des Geräts; auf dem Server nur als SHA-256-Hash | Erneuerung des Zugangsschlüssels |
| Zugangsschlüssel | 15 Minuten | nur im Arbeitsspeicher | jede API-Anfrage |
| Kopplungscode | 10 Minuten, einmalig, max. 5 Fehlversuche | auf dem Server nur als Hash | neues Gerät ohne Admin-Schlüssel anmelden |

Ablauf:
1. Erstes Gerät: Backend-URL und Admin-Schlüssel eintragen. Ist D1 eingerichtet, tauscht JARVIS den Admin-Schlüssel **automatisch** gegen eine Gerätesitzung und entfernt ihn vom Gerät.
2. Weitere Geräte: Auf einem angemeldeten Gerät unter **Einstellungen → Geräte → Kopplungscode erzeugen**. Auf dem neuen Gerät unter **Geräte → Mit Code anmelden** URL und Code eingeben.
3. Verlorenes Gerät: Unter **Geräte → Widerrufen**. Das wirkt sofort, weil der Server bei jeder Anfrage prüft, ob das Gerät noch aktiv ist.
4. Wird ein bereits ersetzter Geräteschlüssel später erneut benutzt (z. B. eine gestohlene Kopie), sperrt der Server das Gerät automatisch.

Grenzen: Der Geräteschlüssel liegt im Browser-Speicher. Wer das entsperrte Gerät in der Hand hat, kann JARVIS nutzen. Schutz bieten die Gerätesperre (Face ID/Code) und der Widerruf. Passkeys (WebAuthn) sind als spätere Verbesserung möglich. Der Admin-Schlüssel funktioniert weiterhin. Bewahre ihn wie ein Passwort auf (z. B. im iCloud-Schlüsselbund) und tausche ihn aus, falls er bekannt wird: neues GitHub-Secret setzen und den Deploy-Workflow ausführen. Ein neuer Admin-Schlüssel macht auch alle Zugangsschlüssel ungültig, die Geräte erneuern sich dann über ihren Geräteschlüssel.

## 6. Kosten und externe Dienste

| Dienst | Wofür | Schlüssel | Kosten |
|---|---|---|---|
| GitHub Pages / Actions | Frontend, Deployment | – | kostenlos (öffentliches Repo) |
| Cloudflare Workers | Backend | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Free-Tarif: 100.000 Anfragen/Tag |
| Cloudflare D1 | Aufgaben | über den API-Token | Free-Tarif reicht für eine Person deutlich |
| OpenAI Chat (`gpt-4.1-mini`) | KI-Antworten | `OPENAI_API_KEY` | nutzungsabhängig, Cent-Bereich pro Gespräch. **Nicht im ChatGPT-Abo enthalten.** |
| OpenAI TTS (`gpt-4o-mini-tts`) | KI-Stimme | dieselbe | nutzungsabhängig. Mit „Nur Systemstimme“ (Einstellungen) kostenlos. |
| Google News RSS, Open-Meteo | Nachrichten, Wetter | – | kostenlos |

Kostenkontrolle heute:
- Größen-, Runden- und Zeitlimits im Worker.
- **Tageslimits** (ab Build 0.6.0, benötigen D1):

| Worker-Variable | Standard | Wirkung |
|---|---|---|
| `DAILY_MAX_CHAT_REQUESTS` | 300 | KI-Anfragen pro Tag |
| `DAILY_MAX_TOKENS` | 400.000 | Ein- und Ausgabe-Tokens pro Tag |
| `DAILY_MAX_TTS_CHARS` | 150.000 | Zeichen Sprachausgabe pro Tag |

Ändern: Cloudflare-Dashboard → Workers & Pages → jarvisss-ai → Settings → Variables and Secrets → Add (Typ „Text“). Die heutige Nutzung siehst du in JARVIS unter **System → Kosten & Nutzung**.

**Zusätzlich empfohlen:** Im OpenAI-Dashboard unter *Settings → Limits* ein monatliches Budget setzen. Das ist die letzte Sicherung, falls etwas am Worker vorbeigeht.

---

## 7. Tests

| Test | Wo | Ergebnis |
|---|---|---|
| Backend: 52 Tests (Phase 3: Vorschläge speichern nichts vor Bestätigung, ungültige Zeiten werden zurückgemeldet, Änderungen nur an existierenden Aufgaben, ohne D1 nur Text-Entwürfe, Sommerzeit-Umstellung, Wetter, Tageslimits für Chat und Sprachausgabe, Werkzeugkatalog; dazu Gerätesitzungen: Anmeldung, gefälschte/abgelaufene Schlüssel, Rotation, Wiederverwendungs-Sperre, Kopplung inkl. Fehlversuchs-Limit und Ablauf, Widerruf, Abmeldung, Protokoll ohne Inhalte; Gedächtnis: anlegen, auf zweitem Gerät lesen, bearbeiten, löschen mit Bestätigung; dazu Auth, CORS inkl. PATCH, Größenlimits, ungültiges JSON, fehlende Secrets, Aufgaben anlegen/abrufen/ändern/ungültig/404/Reihenfolge, D1 fehlt/kaputt/ohne Migration, Systemstatus, Agent mit mehreren Werkzeugaufrufen, Werkzeug ohne D1 verweigert, Schrittlimit, Modell 429/unerreichbar, TTS-Stimmen-Allow-List) | `backend/*.test.js`, CI | ✅ bestanden |
| Frontend statisch: Syntax aller Skripte, eindeutige IDs, alle referenzierten IDs vorhanden, Service-Worker-Dateien, Manifest, keine Schlüssel im Code | `tests/frontend.test.mjs`, CI | ✅ bestanden |
| Browser-Ende-zu-Ende: echter Worker-Code + SQLite-D1 + simuliertes OpenAI, Chromium in iPad- und iPhone-Größe (38 Prüfungen: Status, Aufgaben, Tabs, Gedächtnis, Agent liest Aufgaben, Offline, Nachrichten-Refresh ohne Einfrieren, keine JS-Fehler, kein horizontales Scrollen) | lokal | ✅ bestanden (nicht in CI) |
| Browser Phase 3 auf iPad und iPhone (28 Prüfungen): Vorschlagskarte, nichts gespeichert vor Bestätigung, Speichern mit Datenbank-Bestätigung, Verwerfen ändert nichts, Erinnerung vorschlagen und synchronisieren, Abbrechen, Kosten- und Berechtigungsanzeige, kein seitliches Scrollen | lokal | ✅ bestanden (nicht in CI) |
| Browser mit zwei Geräten gleichzeitig (iPad + iPhone, 17 Prüfungen): automatische Umstellung auf Gerätesitzung, Admin-Token vom Gerät entfernt, Kopplung per Code, Gedächtnis und Aufgaben auf beiden Geräten, unbemerkte Sitzungserneuerung, Widerruf wirkt sofort, Protokoll | lokal | ✅ bestanden (nicht in CI) |
| Echtes iPad / Safari / Installation | – | ⏳ ausstehend (du) |
| Echtes Cloudflare + D1 + OpenAI | – | ⏳ ausstehend (nach Deployment) |
| Zeitumstellung, doppelte Zeitpläne | – | ⏳ ab Phase 4 (es gibt noch keine Zeitpläne) |

Lokal ausführen (falls einmal ein Computer verfügbar ist): `cd backend && npm test` sowie `node --test tests/*.test.mjs` im Hauptordner.

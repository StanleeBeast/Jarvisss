# JARVIS Tasks API – Einrichtung

## Status

Die Tasks-API ist implementiert, getestet und in der JARVIS-Oberfläche unter **Einstellungen → Aufgaben** nutzbar. Sie ist **noch nicht produktiv aktiv**, solange in Cloudflare keine D1-Datenbank als `DB` gebunden und die Migration angewendet wurde. Ohne diese Bindung antwortet die API mit `503 storage_not_configured`; es werden keine Aufgaben gespeichert.

Der KI-Agent kann Aufgaben über das Werkzeug `list_tasks` **nur lesen**. `draft_task` bleibt ein Entwurf. Gespeichert oder geändert wird nur über eine bewusste Aktion in der Oberfläche.

## 1. D1-Datenbank anlegen

1. Öffne das Cloudflare-Dashboard und wähle **Workers & Pages → D1 SQL Database**.
2. Erstelle eine Datenbank mit dem Namen `jarvisss-db`.
3. Kopiere die von Cloudflare angezeigte Database ID. Teile diese ID nicht mit einem Passwort oder API-Token; sie ist Konfiguration, kein Geheimnis.

Alternativ kann eine lokal installierte Wrangler-CLI mit dem bereits autorisierten Cloudflare-Konto verwendet werden:

```bash
npx wrangler d1 create jarvisss-db
```

## 2. Worker an D1 binden (empfohlen, iPad-tauglich)

1. Der Cloudflare-API-Token im GitHub-Secret `CLOUDFLARE_API_TOKEN` braucht zusätzlich die Berechtigung **Account → D1 → Edit**.
2. GitHub → **Settings → Secrets and variables → Actions → Reiter „Variables“ → New repository variable**:
   - `D1_DATABASE_ID` = die Database ID aus Schritt 1
   - optional `D1_DATABASE_NAME`, wenn die Datenbank nicht `jarvisss-db` heißt
3. **Actions → Deploy JARVIS AI worker → Run workflow.**

Der Workflow führt zuerst alle Tests aus. Dann ergänzt er die D1-Bindung nur für dieses Deployment in `wrangler.toml`, wendet alle Migrationen in `migrations/` remote an (bereits angewendete werden übersprungen) und deployt den Worker. Die Datei im Repository bleibt unverändert. Ohne die Variable wird wie bisher ohne Datenbank deployt.

Migrationen: `0001_tasks.sql` (Aufgaben) `0002_devices_memories.sql` (Gerätesitzungen, Kopplungscodes, Gedächtnis, Aktionsprotokoll) `0003_usage.sql` (Nutzungszähler für Tageslimits) und `0004_automation.sql` (Push-Abos, Routinen, geplante Benachrichtigungen, Briefings).

### Alternative mit Computer und Wrangler-CLI

```toml
[[d1_databases]]
binding = "DB"
database_name = "jarvisss-db"
database_id = "<DATABASE_ID>"
migrations_dir = "migrations"
```

```bash
npx wrangler d1 migrations apply jarvisss-db --remote --config wrangler.toml
```

Wird die Bindung direkt in `wrangler.toml` eingetragen, darf die Variable `D1_DATABASE_ID` nicht zusätzlich gesetzt sein. Sonst entsteht eine doppelte Bindung.

## 3. Prüfen

In JARVIS **Einstellungen → System → Jetzt prüfen**. Erwartet wird „Datenbank (D1): Verbunden“ und „Aufgaben-API: Verfügbar“. „Migration fehlt“ bedeutet: Datenbank erreichbar, Tabelle fehlt. Dann den Workflow erneut ausführen.

## 4. Secrets

Erwartete GitHub-Actions-Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `OPENAI_API_KEY`, `JARVIS_ACCESS_TOKEN`. Diese Werte niemals in Quellcode, Issues, Chat-Nachrichten oder Screenshots einfügen.

## 5. API-Vertrag

Alle Endpunkte benötigen:

```http
Authorization: Bearer <JARVIS_ACCESS_TOKEN>
Content-Type: application/json
```

- `GET /api/tasks?status=open&limit=50` – offene Aufgaben abrufen.
- `GET /api/tasks?status=all` – alle Aufgaben abrufen.
- `POST /api/tasks` – Aufgabe nach einer bewussten Nutzeraktion speichern.
- `PATCH /api/tasks/{id}` – Titel, Details, Fälligkeit, Priorität oder Status ändern.

Beispiel für das bewusste Erstellen:

```json
{
  "title": "Lernzettel Herz-Kreislauf wiederholen",
  "details": "Mit 10 Quizfragen abschließen",
  "dueAt": "2026-10-17T16:30:00.000Z",
  "priority": "high"
}
```

Erlaubte Prioritäten: `low`, `normal`, `high`. Erlaubte Statuswerte: `open`, `done`, `cancelled`. Ein neues Element startet immer im Status `open`. Aufgaben werden nicht über diese API endgültig gelöscht.

## 6. Abnahmetests vor produktiver Nutzung

- Anfrage ohne Token liefert `401 unauthorized`.
- Datenbank nicht gebunden liefert `503 storage_not_configured`.
- Gültige Aufgabe wird gespeichert und nach erneutem Abruf zurückgegeben.
- Ungültiger Titel, Status, Priorität oder Datumswert wird abgewiesen.
- PATCH einer nicht existierenden ID liefert `404 task_not_found`.
- Als erledigt markierte Aufgabe enthält einen Zeitstempel; zurück auf offen löscht ihn.
- Das Deployment ist erfolgreich und `GET /api/status` (mit Token) meldet `storage: connected`. `GET /health` allein beweist nicht, dass die Tasks-API und D1 funktionieren.
- Automatisiert geprüft: `backend/tasks.test.js` testet alle Punkte gegen eine echte SQLite-Datenbank mit der echten Migration.

## Sicherheitsgrenze

Diese erste Version ist ein Single-User-Grundgerüst, das durch das bestehende gemeinsame JARVIS-Zugriffstoken geschützt wird. Es bietet noch keine getrennten Benutzerkonten, Geräte-Sitzungen oder detaillierte Rollen. Der KI-Agent hat nur Lesezugriff (`list_tasks`). `draft_task` schreibt nichts. Geplant sind Gerätesitzungen statt des gemeinsamen Tokens (siehe `docs/BESTANDSAUFNAHME.md`, Abschnitt 5).

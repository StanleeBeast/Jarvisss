# JARVIS Tasks API – Einrichtung

## Status

Die Tasks-API ist im Branch `feature/durable-task-foundation` vorbereitet. Sie ist **noch nicht produktiv aktiv**, solange in Cloudflare keine D1-Datenbank als `DB` gebunden und die Migration angewendet wurde. Ohne diese Bindung antwortet die API mit `503 storage_not_configured`; es werden keine Aufgaben gespeichert.

Die bestehende Chat-Funktion und das bisherige Tool `draft_task` bleiben davon getrennt. Ein KI-Entwurf wird nicht automatisch in die Datenbank geschrieben. Das Speichern muss über eine bewusste UI-Aktion erfolgen.

## 1. D1-Datenbank anlegen

1. Öffne das Cloudflare-Dashboard und wähle **Workers & Pages → D1 SQL Database**.
2. Erstelle eine Datenbank mit dem Namen `jarvisss-db`.
3. Kopiere die von Cloudflare angezeigte Database ID. Teile diese ID nicht mit einem Passwort oder API-Token; sie ist Konfiguration, kein Geheimnis.

Alternativ kann eine lokal installierte Wrangler-CLI mit dem bereits autorisierten Cloudflare-Konto verwendet werden:

```bash
npx wrangler d1 create jarvisss-db
```

## 2. Worker an D1 binden

Ergänze in `backend/wrangler.toml` die folgende Konfiguration und ersetze `<DATABASE_ID>` durch die tatsächliche ID:

```toml
[[d1_databases]]
binding = "DB"
database_name = "jarvisss-db"
database_id = "<DATABASE_ID>"
migrations_dir = "migrations"
```

Die Platzhalter-ID darf nicht stehen bleiben. Bis zur Einrichtung sollte die bestehende Konfiguration unverändert bleiben, damit ein Deployment nicht versehentlich fehlschlägt.

## 3. Migration anwenden

Im Verzeichnis `backend` ausführen:

```bash
npx wrangler d1 migrations apply jarvisss-db --remote --config wrangler.toml
```

Die Migration `migrations/0001_tasks.sql` legt die Tabelle `tasks` und zwei Indizes an. Die Migration zuerst prüfen, bevor sie auf einer Datenbank mit vorhandenen Daten ausgeführt wird.

## 4. Secrets und Deployment

Das bestehende Deployment erwartet die GitHub Actions Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `OPENAI_API_KEY`
- `JARVIS_ACCESS_TOKEN`

Diese Werte niemals in Quellcode, Issues, Chat-Nachrichten oder Screenshots einfügen. Die vorhandene Deployment-Workflow-Datei setzt bisher keine D1-Migration automatisch auf. Nach dem Einrichten der Datenbank muss die Migration daher separat angewendet werden. Erst danach kann der Worker über **Actions → Deploy JARVIS AI worker → Run workflow** bereitgestellt werden.

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
- Das Deployment ist erfolgreich und `GET /health` meldet den Worker-Status. Ein Healthcheck allein beweist nicht, dass die Tasks-API und D1 vollständig funktionieren.

## Sicherheitsgrenze

Diese erste Version ist ein Single-User-Grundgerüst, das durch das bestehende gemeinsame JARVIS-Zugriffstoken geschützt wird. Es bietet noch keine getrennten Benutzerkonten, Geräte-Sitzungen oder detaillierte Rollen. Die Tasks-API ist noch nicht mit dem KI-Agenten verbunden; `draft_task` bleibt daher nur ein Entwurf und schreibt nichts automatisch.

# JARVIS Home-Station auf dem Windows-Laptop

Die Home-Station läuft dauerhaft auf deinem alten Laptop. Sie

- holt alle 5 Minuten neue Mails aus **Gmail** und **iCloud Mail** (Apple Mail) und markiert sie dabei **nicht** als gelesen,
- schickt sie zum Sortieren an dein JARVIS-Backend. Dort stuft die KI jede Mail nach Wichtigkeit (1–5) ein, fasst sie zusammen und schreibt, wenn nötig, einen Antwortentwurf,
- sendet eine Antwort **nur**, wenn du sie in der JARVIS-App ausdrücklich mit „Senden“ bestätigt hast.

Deine Mail-Passwörter bleiben auf dem Laptop. Windows verschlüsselt sie für deinen Benutzer. Im Backend landen nur Absender, Betreff, Datum, ein kurzer Auszug (280 Zeichen), die Einstufung und der Entwurf. Der vollständige Mailtext wird dort nicht gespeichert.

Zeitbedarf: etwa 20 Minuten, einmalig.

---

## 1. Node.js installieren (einmalig)

1. Öffne auf dem Laptop **https://nodejs.org/de/download**.
2. Lade den **Windows Installer (.msi)** der **LTS-Version** herunter.
3. Starte ihn und klicke überall auf **Weiter**. Den Haken bei „Tools for Native Modules“ brauchst du **nicht**.

## 2. Home-Station herunterladen

1. Öffne **https://github.com/StanleeBeast/Jarvisss**.
2. Klicke auf **Code** und dann auf **Download ZIP**.
3. Rechtsklick auf die ZIP-Datei → **Eigenschaften**. Setze unten den Haken **„Zulassen“**, falls er angezeigt wird, und klicke auf **OK**. Danach meldet sich Windows nicht bei jedem Start.
4. Rechtsklick auf die ZIP-Datei → **Alle extrahieren …**
5. Kopiere den Ordner **`homestation`** an einen festen Ort, zum Beispiel `Dokumente\JARVIS\homestation`.

## 3. Starten

Doppelklicke im Ordner `homestation` auf **`start.bat`**.

- Erscheint „Der Computer wurde durch Windows geschützt“: Klicke auf **Weitere Informationen** und dann auf **Trotzdem ausführen**.
- Erscheint eine Frage der Windows-Firewall: Du kannst **Abbrechen** wählen. Die Station braucht keine eingehenden Verbindungen.
- Ein schwarzes Fenster bleibt offen. Das ist die Station. Lass es offen; minimieren ist in Ordnung.
- Der Browser öffnet die Einrichtungsseite **http://127.0.0.1:7777**. Diese Seite ist nur auf diesem Laptop erreichbar.

## 4. Einrichten (auf der Seite http://127.0.0.1:7777)

**Backend:** Trage die Adresse deines Workers ein, also dieselbe wie in der JARVIS-App unter *Einstellungen → Stimme & KI*, zum Beispiel `https://jarvisss-ai.….workers.dev`. Klicke auf **Speichern & prüfen**.

**Koppeln:**
1. Öffne auf dem iPad oder iPhone die JARVIS-App → **Geräte** → **Gerät koppeln**.
2. Trage den 8-stelligen Code auf der Einrichtungsseite ein und klicke auf **Koppeln**.

Die Station erscheint danach in der App unter *Geräte* als eigenes Gerät. Dort kannst du sie jederzeit abmelden.

**Postfächer:** Du brauchst für jedes Postfach ein **app-spezifisches Passwort**. Dein normales Passwort funktioniert hier nicht und gehört auch nicht hierher.

| Anbieter | So bekommst du das Passwort |
|---|---|
| **Gmail** | myaccount.google.com → **Sicherheit** → **Bestätigung in zwei Schritten** einschalten. Danach in der Suche oben „**App-Passwörter**“ eingeben, als Namen „JARVIS“ eintragen und auf **Erstellen** klicken. Du bekommst 16 Zeichen; die Leerzeichen sind egal. |
| **iCloud (Apple Mail)** | account.apple.com → **Anmeldung und Sicherheit** → **App-spezifische Passwörter** → **+**, als Namen „JARVIS“ eintragen. Als Mailadresse gibst du deine `@icloud.com`-Adresse ein (oder `@me.com`). |

Wähle den Anbieter, trage die Adresse und das App-Passwort ein und klicke auf **Testen & speichern**. Die Station prüft die Anmeldung beim Abholen (IMAP) und beim Senden (SMTP). Gespeichert wird nur, wenn beides klappt. Der erste Abruf holt die Mails der letzten 3 Tage, höchstens 30.

## 5. Dauerbetrieb einrichten

Doppelklicke auf **`autostart-einrichten.bat`**:

- Die Station startet ab jetzt nach jeder Windows-Anmeldung, minimiert.
- Auf die Frage nach dem Energiesparmodus antwortest du mit **J**. Dann schläft der Laptop am Strom nicht mehr ein und läuft auch zugeklappt weiter. Der Bildschirm darf trotzdem ausgehen.

Zusätzlich empfohlen:

- **Automatische Anmeldung:** Nach einem Windows-Update startet der Laptop neu. Die Station läuft erst wieder, wenn sich jemand an Windows anmeldet. Bleibt der Laptop zu Hause, kannst du eine automatische Anmeldung einrichten (Windows-Taste + R → `netplwiz`). Ob dir das sicher genug ist, entscheidest du selbst. Ohne automatische Anmeldung meldet die App „Home-Station offline“, bis du dich angemeldet hast.
- **WLAN:** *Einstellungen → Netzwerk → WLAN → Hardwareeigenschaften / Adapteroptionen*. Schalte dort, falls vorhanden, „Computer kann das Gerät ausschalten, um Energie zu sparen“ aus.
- **Akku:** Bleibt der Laptop dauerhaft am Strom, ist ein Ladelimit (falls der Hersteller eins anbietet, etwa 80 %) gut für den Akku.

Entfernen kannst du den Autostart mit **`autostart-entfernen.bat`**.

## So siehst du, ob alles läuft

- **In der JARVIS-App unter „Mails“:** Oben steht „Home-Station online“ und der Stand deiner Postfächer.
- **Auf der Einrichtungsseite:** Status und Protokoll der letzten Vorgänge.
- **Protokolldatei:** `%APPDATA%\JarvisStation\station.log`

## Wichtig zu wissen (ehrliche Grenzen)

- **Nur mit dem Laptop:** Ist er aus, schläft er oder hat er kein WLAN, kommen keine neuen Mails an und Antworten bleiben in der App auf „wird gesendet“. Bei einem fehlgeschlagenen Versand zeigt die App das an.
- **Gesendete Mails:**
  - **Gmail** legt gesendete Antworten selbst unter „Gesendet“ ab.
  - **iCloud** macht das nicht von selbst. Die Station legt sie dort zusätzlich ab, und wenn das scheitert, steht es im Protokoll.
- **Postfach bleibt unverändert:** Gelesen-Status, Ordner und Löschen in deinem echten Postfach ändert JARVIS nicht. „Erledigt“ oder „Löschen“ in der App betrifft nur die Liste in JARVIS.
- **Nur Posteingang:** Abgeholt wird nur der Posteingang. Bei Gmail gehören dazu alle Kategorien des Posteingangs.
- **Antwort trotz Fehlermeldung möglich:** Stürzt die Station genau während des Sendens ab, meldet die App nach 10 Minuten „fehlgeschlagen“, obwohl die Mail vielleicht schon raus ist. Schau im Zweifel unter „Gesendet“ nach.
- **Neu koppeln nötig:** Meldest du die Station in der App ab oder läuft sie länger als 30 Tage nicht, musst du sie neu koppeln.
- **Passwörter neu eintragen:** Die Verschlüsselung der Passwörter gilt nur für deinen Windows-Benutzer auf diesem Laptop. Kopierst du den Ordner `%APPDATA%\JarvisStation` auf einen anderen Rechner, musst du die Passwörter dort neu eintragen.

## Aktualisieren

1. Lade die ZIP neu herunter wie in Schritt 2.
2. Ersetze im Ordner `homestation` die Datei **`jarvis-station.cjs`**, oder den ganzen Ordner.
3. Schließe das schwarze Fenster und starte `start.bat` neu.

Deine Einstellungen liegen getrennt unter `%APPDATA%\JarvisStation` und bleiben erhalten.

## Entfernen

1. In der App unter *Geräte* die Station abmelden.
2. `autostart-entfernen.bat` ausführen.
3. Den Ordner `homestation` und `%APPDATA%\JarvisStation` löschen.
4. Die App-Passwörter bei Google und Apple widerrufen.

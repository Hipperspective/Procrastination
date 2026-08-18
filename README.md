# 🌀 Procrastination Lists – Web App

Deine Aufgabenlisten, Arbeitszeitaufzeichnung und Statistik aus „Wheel of Procrastination" – als Web-App, synchron auf **iPhone, iPad und Mac** (ohne Wheel).

Die App besteht nur aus statischen Dateien (kein eigener Server nötig). Die Daten liegen in einer kostenlosen **Supabase**-Datenbank, gehostet wird die App kostenlos auf **GitHub Pages**.

---

## Teil 1: Supabase einrichten (einmalig, ca. 5 Minuten)

1. Gehe auf https://supabase.com und erstelle einen kostenlosen Account.
2. Klicke auf **New Project**, gib einen Namen (z.B. `procrastination`) und ein Datenbank-Passwort ein (nur merken, wird in der App nicht gebraucht). Region: am besten `eu-central` (Frankfurt).
3. Warte ~1 Minute, bis das Projekt bereit ist.
4. Öffne links den **SQL Editor**, klicke **New query**, füge den kompletten Inhalt der Datei `supabase-schema.sql` ein und klicke **Run**. Es sollte „Success" erscheinen.
5. **Empfohlen:** Gehe zu **Authentication → Sign In / Providers → Email** und schalte **„Confirm email" aus**. Dann kannst du dich ohne Bestätigungs-Mail registrieren. (Wenn du es an lässt, musst du nach der Registrierung einmal den Link in der Mail klicken.)
6. Gehe zu **Project Settings (Zahnrad) → API** und kopiere dir:
   - **Project URL** (z.B. `https://abcdefgh.supabase.co`)
   - **anon public** Key (der lange Text unter „Project API keys")

## Teil 2: Keys in die App eintragen

Öffne `index.html` in einem Texteditor und ersetze ganz unten im `<script>`-Block:

```js
const SUPABASE_URL = "HIER_DEINE_SUPABASE_URL";
const SUPABASE_ANON_KEY = "HIER_DEIN_ANON_KEY";
```

durch deine echten Werte. Speichern – fertig.

> Der „anon public" Key darf öffentlich sichtbar sein. Deine Daten sind trotzdem geschützt: Jeder Zugriff braucht deinen Login, und die Datenbank gibt per Row Level Security nur die Daten des eingeloggten Nutzers heraus.

## Teil 3: Auf GitHub Pages veröffentlichen

1. Erstelle einen Account auf https://github.com (falls noch nicht vorhanden).
2. Klicke oben rechts **+ → New repository**. Name z.B. `listen`. Wähle **Public**. → **Create repository**.
3. Klicke auf **uploading an existing file** und ziehe alle Dateien aus diesem Ordner hinein (`index.html`, `app.js`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`). → **Commit changes**.
4. Gehe im Repository auf **Settings → Pages**. Unter „Branch" wähle `main` und `/ (root)` → **Save**.
5. Nach 1–2 Minuten ist deine App erreichbar unter:
   `https://DEINBENUTZERNAME.github.io/listen/`

## Teil 4: Auf den Geräten „installieren"

Öffne die URL im Browser und registriere dich einmal mit E-Mail + Passwort. Auf allen Geräten mit demselben Login anmelden – dann ist alles synchron (live, ohne neu laden).

- **iPhone / iPad:** In Safari öffnen → Teilen-Symbol → **„Zum Home-Bildschirm"**. Die App läuft dann im Vollbild wie eine echte App.
- **Mac:** In Safari: **Ablage → Zum Dock hinzufügen**. Oder in Chrome: Installieren-Symbol in der Adressleiste.

---

## Was die App kann

- **Aufgaben:** einmalig oder wiederkehrend (täglich / wöchentlich / alle X Tage), Wochentagsplan, Priorität ⭐, Fälligkeitsdatum, Startdatum, Abhängigkeiten („erst nach…"), Wiederholungen pro Tag (z.B. 3× Wasser trinken) mit Cooldown, Unteraufgaben mit Fortschritt, Tags, Notizen.
- **Orte/Listen:** wie in der iOS-App (Home, Work, …), als Filter-Chips oben. Orte verwaltest du unter ⚙️. Ein Ort kann als **Arbeitsort** 💼 markiert werden – dort erledigte Aufgaben buchen automatisch Arbeitszeit.
- **Arbeitszeit:** Stempeluhr (Ein-/Ausstempeln, Pausen), manuelle Einträge, Soll pro Woche oder Monat, Fortschrittsbalken und Überstunden-Saldo.
- **Statistik:** Tage-Streak 🔥, Erledigungen heute/Woche, 14-Tage-Diagramm, Top-Aufgaben.
- **Archiv:** erledigte einmalige Aufgaben, wiederherstellbar.

## Daten aus der iOS-App übernehmen?

Die Web-App startet leer. Wenn du deine bestehenden Aufgaben aus der iOS-App übernehmen willst: exportiere sie dort als Backup (BackupManager) und sag mir Bescheid – ich baue dir gern einen Import.

/**
 * End-to-End-Test in einem echten Chrome mit vorgeladener Extension.
 *
 * Startet eine eigene Chrome-Instanz mit eigenem Profil, registriert den
 * Native Host in diesem Profil, öffnet eine YouTube-Videoseite und prüft
 * die ganze Kette bis zur fertigen Datei auf der Platte.
 *
 *   node tests/e2e.mjs [--headful] [--keep]
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { removeTestDir } from './safe-cleanup.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXTENSION = path.join(ROOT, 'extension');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOST_NAME = 'com.yannik.ytdl_host';

// Kurzes, seit 2005 unverändertes Video — 19 Sekunden, ~500 KB.
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const OUT_DIR = 'Downloads/YouTube-E2E';
const ABS_OUT = path.join(os.homedir(), OUT_DIR);

const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');
const SHOTS = path.join(ROOT, 'tests', 'screenshots');

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const mark = passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wartet auf eine Bedingung statt auf eine Uhrzeit. Feste Wartezeiten
 * erzeugen Tests, die mal durchgehen und mal nicht — und dann sucht man
 * den Fehler im Produkt statt im Test.
 */
async function waitUntil(check, { timeout = 20000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
}

/**
 * Fotografiert ein Element (auch im Shadow Root). Ein Clip-Rechteck ist hier
 * unbrauchbar: Puppeteer scrollt dafür die Seite, das verankerte Panel klappt
 * daraufhin zu — der Test würde sein eigenes Prüfobjekt schließen.
 */
async function shot(page, selectorFn, file) {
  const handle = await page.evaluateHandle(selectorFn);
  const element = handle.asElement();
  if (element) await element.screenshot({ path: file });
  await handle.dispose();
}

const PANEL_EL = () => document.getElementById('ytdl-panel-host')
  .shadowRoot.querySelector('.panel');

async function main() {
  removeTestDir(ABS_OUT);
  fs.mkdirSync(SHOTS, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-e2e-'));
  const extId = fs.readFileSync(path.join(ROOT, 'keys', 'extension_id.txt'), 'utf8').trim();

  // Native-Host-Manifest in DIESES Profil legen: Chrome leitet den Suchpfad
  // vom user-data-dir ab, das globale Manifest gilt hier nicht.
  const nmDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, `${HOST_NAME}.json`), JSON.stringify({
    name: HOST_NAME,
    description: 'Lokaler Downloader mit yt-dlp und ffmpeg',
    path: path.join(ROOT, 'native-host', 'run_host.sh'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  }, null, 2));

  console.log(`\nProfil:    ${profile}`);
  console.log(`Extension: ${EXTENSION}`);
  console.log(`ID:        ${extId}\n`);

  // Chrome 137+ ignoriert --load-extension. Der unterstützte Weg ist
  // Extensions.loadUnpacked über das DevTools-Protokoll; Puppeteer setzt
  // dafür enableExtensions + pipe voraus.
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADFUL ? false : 'new',
    userDataDir: profile,
    enableExtensions: true,
    pipe: true,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      '--lang=de-DE',
    ],
  });

  try {
    console.log('── Extension');

    const installedId = await browser.installExtension(EXTENSION);
    check('Extension geladen', installedId === extId,
      installedId === extId ? installedId
        : `erwartet ${extId}, geliefert ${installedId}`);

    // Der Service Worker meldet sich als eigenes Target.
    let worker = null;
    for (let i = 0; i < 40 && !worker; i += 1) {
      const targets = await browser.targets();
      worker = targets.find((t) => t.type() === 'service_worker'
        && t.url().includes(extId)) || null;
      if (!worker) await sleep(250);
    }
    check('Service Worker läuft', Boolean(worker), worker ? worker.url() : 'nicht gefunden');
    if (!worker) throw new Error('Extension wurde nicht geladen');

    const workerContext = await worker.worker();

    // Nachrichten an den Service Worker müssen aus einem anderen Kontext
    // kommen — er empfängt sein eigenes sendMessage nicht.
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extId}/options/options.html`,
      { waitUntil: 'domcontentloaded' });

    // --- Native Host anpingen ---------------------------------------------
    const ping = await control.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'ping' }));
    check('Native Host antwortet', Boolean(ping && ping.ok),
      ping && ping.ok
        ? `yt-dlp ${ping.data.ytdlp.version}, ffmpeg ${ping.data.ffmpeg.version}`
        : (ping && ping.error) || 'keine Antwort');

    // --- Zielordner für den Test setzen -----------------------------------
    await control.evaluate((dir) => chrome.runtime.sendMessage({
      type: 'saveSettings',
      patch: { outputDir: dir, height: 360, mode: 'video', notify: false },
    }), OUT_DIR);

    // --- YouTube öffnen ---------------------------------------------------
    console.log('\n── YouTube');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Zustimmungsdialog eines frischen Profils überspringen.
    await browser.setCookie(
      { name: 'SOCS', value: 'CAISNQgQEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNzE2LjA2X3AwGgJkZSACGgYIgLD-tAY',
        domain: '.youtube.com', path: '/' },
      { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
    );

    await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('ytd-watch-metadata', { timeout: 45000 })
      .catch(() => null);
    await sleep(2500);

    const consent = await page.$('button[aria-label*="Alle akzeptieren"], button[aria-label*="Accept all"]');
    if (consent) { await consent.click(); await sleep(3000); }

    // --- Button eingehängt? -----------------------------------------------
    const pill = await page.waitForSelector('#ytdl-pill-host', { timeout: 30000 })
      .catch(() => null);
    check('Button in der Action-Leiste', Boolean(pill));
    if (!pill) {
      await page.screenshot({ path: path.join(SHOTS, 'fehler-kein-button.png') });
      throw new Error('Der Button wurde nicht eingehängt');
    }

    const pillInfo = await page.evaluate(() => {
      const host = document.getElementById('ytdl-pill-host');
      const button = host.shadowRoot.querySelector('.pill');
      const native = document.querySelector('ytd-download-button-renderer');
      const bar = host.parentElement;
      return {
        label: button.textContent.trim(),
        visible: button.getBoundingClientRect().width > 0,
        nativeHidden: native ? native.style.display === 'none' : null,
        barId: bar ? (bar.id || bar.tagName.toLowerCase()) : null,
        siblings: bar ? [...bar.children].map((c) =>
          c.id || c.tagName.toLowerCase()).join(', ') : '',
      };
    });
    check('Button ist sichtbar', pillInfo.visible, `„${pillInfo.label}"`);
    check('Sitzt in der Buttonleiste', Boolean(pillInfo.barId),
      `${pillInfo.barId} → [${pillInfo.siblings}]`);
    check('YouTubes Download-Button ersetzt',
      pillInfo.nativeHidden !== false,
      pillInfo.nativeHidden === null ? 'kein nativer Button auf dieser Seite'
        : 'nativer Button ausgeblendet');

    await shot(page, () => document.getElementById('ytdl-pill-host').parentElement,
      path.join(SHOTS, '1-actionbar.png'));

    // --- Panel öffnen ------------------------------------------------------
    console.log('\n── Panel');
    await page.evaluate(() => {
      document.getElementById('ytdl-pill-host').shadowRoot
        .querySelector('.pill').click();
    });
    await sleep(600);

    const panelOpen = await page.evaluate(() =>
      Boolean(document.getElementById('ytdl-panel-host')
        && document.getElementById('ytdl-panel-host').style.display !== 'none'));
    check('Panel öffnet sich', panelOpen);

    // Auf das Ergebnis der Formatabfrage warten
    await waitUntil(() => page.evaluate(() => {
      const root = document.getElementById('ytdl-panel-host')?.shadowRoot;
      const spec = root?.querySelector('.spec')?.textContent || '';
      return /\d+p/.test(spec);
    }), { timeout: 45000 });
    const panelInfo = await page.evaluate(() => {
      const root = document.getElementById('ytdl-panel-host').shadowRoot;
      const chips = [...root.querySelectorAll('.chip')];
      return {
        title: root.querySelector('.title')?.textContent.trim(),
        sub: root.querySelector('.sub')?.textContent.trim(),
        spec: root.querySelector('.spec')?.textContent.trim(),
        status: root.querySelector('.status')?.textContent.trim(),
        chips: chips.map((c) => `${c.textContent.trim()}${c.disabled ? '(aus)' : ''}`),
        checked: (() => {
          const c = chips.find((x) => x.getAttribute('aria-checked') === 'true');
          return c ? `${c.textContent.trim()}${c.disabled ? '(aus)' : ''}` : null;
        })(),
        action: root.querySelector('.go')?.textContent.trim(),
      };
    });
    check('Titel im Panel', Boolean(panelInfo.title), panelInfo.title);
    check('Ausgewählte Stufe ist verfügbar',
      Boolean(panelInfo.checked) && !panelInfo.checked.includes('(aus)'),
      `ausgewählt: ${panelInfo.checked}`);
    // Nur die Auflösungen, die es für dieses Video wirklich gibt.
    // „Me at the zoo" von 2005 hat genau 240p und 144p.
    check('Nur vorhandene Auflösungen',
      panelInfo.chips.length > 0 && !panelInfo.chips.some((c) => c.includes('(aus)')),
      panelInfo.chips.join(' '));
    check('Spezifikationszeile', Boolean(panelInfo.spec), panelInfo.spec);

    await shot(page, PANEL_EL, path.join(SHOTS, '2-panel.png'));

    // --- Download auslösen -------------------------------------------------
    console.log('\n── Download');
    await page.evaluate(() => {
      const root = document.getElementById('ytdl-panel-host').shadowRoot;
      const button = root.querySelector('[data-act="start"], [data-act="resume"]');
      button.click();
    });

    let sawProgress = false;
    let stayedOpen = true;
    let finished = null;
    for (let i = 0; i < 300; i += 1) {
      await sleep(200);
      const snapshot = await page.evaluate(() => {
        const host = document.getElementById('ytdl-panel-host');
        const root = host.shadowRoot;
        const pillRoot = document.getElementById('ytdl-pill-host').shadowRoot;
        return {
          open: host.style.display !== 'none',
          status: root.querySelector('.status')?.textContent.trim(),
          action: root.querySelector('.go')?.textContent.trim(),
          fill: root.querySelector('.strip')?.style.getPropertyValue('--p'),
          pill: pillRoot.querySelector('.label')?.textContent.trim(),
          banner: root.querySelector('.banner')?.textContent.trim() || null,
        };
      });
      if (!snapshot.open) stayedOpen = false;
      // Beleg für laufenden Fortschritt: die Pille zeigt etwas anderes als
      // im Ruhezustand, oder der Balken ist gefüllt. Bei einem 466-KB-Video
      // ist der Prozentwert oft schon vorbei, bevor man ihn ablesen kann.
      const filled = parseFloat(snapshot.fill) > 0;
      if (filled) sawProgress = true;
      if (snapshot.pill && !/^Herunterladen$|^Fortsetzen$/.test(snapshot.pill)) {
        sawProgress = true;
      }
      if (snapshot.action && snapshot.action.includes('Noch einmal')) {
        finished = snapshot; break;
      }
      if (snapshot.banner) { finished = snapshot; break; }
    }

    check('Fortschritt sichtbar', sawProgress);
    check('Panel bleibt während des Downloads offen', stayedOpen,
      stayedOpen ? '' : 'es hat sich zwischendurch geschlossen');
    check('Download abgeschlossen',
      Boolean(finished && !finished.banner),
      finished ? (finished.banner || finished.status) : 'Zeitüberschreitung');

    if (finished && !finished.banner) {
      await shot(page, PANEL_EL, path.join(SHOTS, '3-fertig.png'));
    }

    // --- Datei wirklich da? ------------------------------------------------
    const files = fs.existsSync(ABS_OUT)
      ? fs.readdirSync(ABS_OUT).filter((f) => !f.startsWith('.'))
      : [];
    check('Datei liegt im Zielordner', files.length > 0, files.join(', '));

    if (files.length) {
      const file = path.join(ABS_OUT, files[0]);
      const size = fs.statSync(file).size;
      let probe = '';
      try {
        probe = execSync(
          `/opt/homebrew/bin/ffprobe -v error -show_entries format=duration `
          + `-show_entries stream=codec_type -of default=nw=1 ${JSON.stringify(file)}`,
          { encoding: 'utf8' }).trim().replace(/\n/g, ' ');
      } catch { probe = 'ffprobe fehlgeschlagen'; }
      check('Datei ist abspielbar', probe.includes('duration'),
        `${(size / 1024).toFixed(0)} KB · ${probe}`);

      // Die angekündigte Größe muss die tatsächliche treffen.
      const announced = (panelInfo.spec || '').match(/([\d.,]+)\s*(KB|MB|GB)/);
      if (announced) {
        const factor = { KB: 1024, MB: 1048576, GB: 1073741824 }[announced[2]];
        const predicted = parseFloat(announced[1].replace(',', '.')) * factor;
        const deviation = Math.abs(predicted - size) / size;
        check('Größenvorhersage trifft zu', deviation < 0.1,
          `angekündigt ${announced[0]}, tatsächlich ${(size / 1024).toFixed(0)} KB `
          + `— Abweichung ${(deviation * 100).toFixed(1)} %`);
      }
    }

    // --- Popup -------------------------------------------------------------
    console.log('\n── Popup');
    const popup = await browser.newPage();
    await popup.setViewport({ width: 400, height: 700 });
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`,
      { waitUntil: 'domcontentloaded' });
    await waitUntil(() => popup.evaluate(() =>
      document.getElementById('status-text')?.textContent.trim() !== 'Wird geprüft …'));
    const popupInfo = await popup.evaluate(() => ({
      status: document.getElementById('status-text')?.textContent.trim(),
      detail: document.getElementById('status-detail')?.textContent.trim(),
      history: document.querySelectorAll('#history .item').length,
    }));
    check('Popup zeigt Bereitschaft', popupInfo.status === 'Bereit',
      `${popupInfo.status} — ${popupInfo.detail}`);
    check('Historie gefüllt', popupInfo.history > 0, `${popupInfo.history} Eintrag/Einträge`);
    await popup.screenshot({ path: path.join(SHOTS, '4-popup.png'), fullPage: true });

    // --- Einstellungen -----------------------------------------------------
    console.log('\n── Einstellungen');
    const options = control;
    await options.setViewport({ width: 760, height: 1200 });
    await options.reload({ waitUntil: 'domcontentloaded' });
    await waitUntil(() => options.evaluate(() =>
      (document.getElementById('tool-list')?.textContent || '').includes('yt-dlp')));
    const optionsInfo = await options.evaluate(() => ({
      tools: document.getElementById('tool-list')?.textContent.replace(/\s+/g, ' ').trim(),
      note: document.getElementById('tool-note')?.textContent.trim(),
    }));
    check('Einstellungen zeigen die Werkzeuge',
      optionsInfo.tools.includes('yt-dlp') && !optionsInfo.note,
      optionsInfo.tools.slice(0, 90));
    await options.screenshot({ path: path.join(SHOTS, '5-optionen.png'), fullPage: true });

    // --- Fehler in den Konsolen? -------------------------------------------
    console.log('\n── Konsolen');
    const workerErrors = await workerContext.evaluate(() => globalThis.__errors || []);
    check('Keine Fehler im Service Worker', workerErrors.length === 0,
      workerErrors.join(' | '));

  } finally {
    if (!KEEP) {
      await browser.close();
      fs.rmSync(profile, { recursive: true, force: true });
    } else {
      console.log(`\nBrowser bleibt offen. Profil: ${profile}`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  const failed = results.filter((r) => !r.passed);
  console.log(`${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  console.log(`Aufnahmen: ${SHOTS}`);
  if (failed.length) {
    console.log('\nFehlgeschlagen:');
    failed.forEach((r) => console.log(`  · ${r.name}${r.detail ? ` — ${r.detail}` : ''}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nAbbruch:', error.message);
  process.exit(1);
});

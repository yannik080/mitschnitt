/**
 * Sichtprüfung: öffnet YouTube mit geladener Extension und legt
 * Aufnahmen der Oberfläche ab — heller und dunkler Modus.
 *
 *   node tests/visual.mjs [--headful]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXTENSION = path.join(ROOT, 'extension');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = path.join(ROOT, 'tests', 'screenshots');
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
// Muss sich vom Auslieferungszustand unterscheiden.
const TEST_DIR = 'Downloads/Mitschnitt-Visualtest';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fotografiert ein Element im Shadow Root. Ein Clip-Rechteck taugt hier
 * nicht: Puppeteer scrollt dafür die Seite, und ein position:fixed-Panel
 * wandert dabei mit aus dem Bild.
 */
async function shotShadow(page, selectorFn, file) {
  const handle = await page.evaluateHandle(selectorFn);
  const element = handle.asElement();
  if (!element) throw new Error(`Element nicht gefunden für ${file}`);
  await element.screenshot({ path: file });
  await handle.dispose();
}

const PANEL_EL = () => document.getElementById('ytdl-panel-host')
  .shadowRoot.querySelector('.panel');

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-vis-'));
  const extId = fs.readFileSync(path.join(ROOT, 'keys', 'extension_id.txt'), 'utf8').trim();

  const nmDir = path.join(profile, 'NativeMessagingHosts');
  fs.mkdirSync(nmDir, { recursive: true });
  fs.writeFileSync(path.join(nmDir, 'com.yannik.ytdl_host.json'), JSON.stringify({
    name: 'com.yannik.ytdl_host',
    description: 'Lokaler Downloader mit yt-dlp und ffmpeg',
    path: path.join(ROOT, 'native-host', 'run_host.sh'),
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extId}/`],
  }));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: process.argv.includes('--headful') ? false : 'new',
    userDataDir: profile,
    enableExtensions: true,
    pipe: true,
    args: ['--no-first-run', '--no-default-browser-check',
           '--window-size=1440,950', '--lang=de-DE'],
  });

  try {
    await browser.installExtension(EXTENSION);
    await sleep(2500);

    // Eigener Zielordner für den Test. Niemals der voreingestellte:
    // dort liegen die echten Downloads des Nutzers.
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extId}/options/options.html`,
      { waitUntil: 'domcontentloaded' });
    await control.evaluate((dir) => chrome.runtime.sendMessage({
      type: 'saveSettings', patch: { outputDir: dir, notify: false },
    }), TEST_DIR);
    await control.close();

    await browser.setCookie(
      { name: 'CONSENT', value: 'YES+cb', domain: '.youtube.com', path: '/' },
      { name: 'SOCS', value: 'CAI', domain: '.youtube.com', path: '/' },
    );

    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 950, deviceScaleFactor: 2 });
      await page.emulateMediaFeatures([
        { name: 'prefers-color-scheme', value: theme },
      ]);
      await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('ytd-watch-metadata', { timeout: 45000 }).catch(() => null);
      await sleep(3000);

      // YouTubes eigenes Thema passend schalten
      await page.evaluate((mode) => {
        if (mode === 'dark') document.documentElement.setAttribute('dark', '');
        else document.documentElement.removeAttribute('dark');
      }, theme);
      await sleep(1200);

      await page.waitForSelector('#ytdl-pill-host', { timeout: 30000 });

      // Zur Buttonleiste scrollen, damit alles im Bild ist
      await page.evaluate(() => {
        document.getElementById('ytdl-pill-host')
          .scrollIntoView({ block: 'center' });
      });
      await sleep(900);

      await page.screenshot({ path: path.join(SHOTS, `v-${theme}-1-leiste.png`) });

      await page.evaluate(() => {
        document.getElementById('ytdl-pill-host').shadowRoot
          .querySelector('.pill').click();
      });
      await sleep(7000);   // Formatabfrage abwarten

      const box = await page.evaluate(() => {
        const r = document.getElementById('ytdl-panel-host').shadowRoot
          .querySelector('.panel').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
                 sx: window.scrollX, sy: window.scrollY };
      });
      console.log(`${theme}: Panel bei x=${box.x.toFixed(0)} y=${box.y.toFixed(0)} `
        + `${box.w.toFixed(0)}×${box.h.toFixed(0)}  (scroll ${box.sx},${box.sy})`);

      await page.screenshot({ path: path.join(SHOTS, `v-${theme}-2-panel-seite.png`) });
      await shotShadow(page, PANEL_EL, path.join(SHOTS, `v-${theme}-3-panel.png`));

      // Audio-Ansicht
      await page.evaluate(() => {
        document.getElementById('ytdl-panel-host').shadowRoot
          .querySelector('[data-mode="audio"]').click();
      });
      await sleep(500);
      const box2 = await page.evaluate(() => {
        const r = document.getElementById('ytdl-panel-host').shadowRoot
          .querySelector('.panel').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
                 sx: window.scrollX, sy: window.scrollY };
      });
      await shotShadow(page, PANEL_EL, path.join(SHOTS, `v-${theme}-4-audio.png`));

      // Laufender Download für den Fortschrittsbalken
      await page.evaluate(() => {
        const root = document.getElementById('ytdl-panel-host').shadowRoot;
        root.querySelector('[data-mode="video"]').click();
      });
      await sleep(300);
      await page.evaluate(() => {
        const root = document.getElementById('ytdl-panel-host').shadowRoot;
        const go = root.querySelector('[data-act="start"], [data-act="resume"]');
        if (go) go.click();
      });

      // Warten bis der Balken sichtbar gefüllt ist
      for (let i = 0; i < 60; i += 1) {
        await sleep(700);
        const p = await page.evaluate(() => {
          const m = document.getElementById('ytdl-panel-host').shadowRoot
            .querySelector('.mask');
          return m ? parseFloat(m.style.getPropertyValue('--p')) || 0 : 0;
        });
        if (p > 12) break;
      }
      const box3 = await page.evaluate(() => {
        const r = document.getElementById('ytdl-panel-host').shadowRoot
          .querySelector('.panel').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
                 sx: window.scrollX, sy: window.scrollY };
      });
      await shotShadow(page, PANEL_EL, path.join(SHOTS, `v-${theme}-5-fortschritt.png`));
      // Die Pille während des Downloads
      const pillBox = await page.evaluate(() => {
        const r = document.getElementById('ytdl-pill-host').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height,
                 sx: window.scrollX, sy: window.scrollY };
      });
      await shotShadow(page, () => document.getElementById('ytdl-pill-host')
        .parentElement, path.join(SHOTS, `v-${theme}-6-pille.png`));

      await page.evaluate(() => {
        const root = document.getElementById('ytdl-panel-host').shadowRoot;
        const cancel = root.querySelector('[data-act="cancel"]');
        if (cancel) cancel.click();
      });
      await sleep(1500);
      await page.close();
    }

    // Popup und Einstellungen in beiden Themen
    for (const theme of ['dark', 'light']) {
      const popup = await browser.newPage();
      await popup.setViewport({ width: 380, height: 640, deviceScaleFactor: 2 });
      await popup.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await popup.goto(`chrome-extension://${extId}/popup/popup.html`,
        { waitUntil: 'domcontentloaded' });
      await sleep(3500);
      await popup.screenshot({ path: path.join(SHOTS, `v-${theme}-7-popup.png`),
        fullPage: true });
      await popup.close();

      const options = await browser.newPage();
      await options.setViewport({ width: 800, height: 1100, deviceScaleFactor: 2 });
      await options.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
      await options.goto(`chrome-extension://${extId}/options/options.html`,
        { waitUntil: 'domcontentloaded' });
      await sleep(3500);
      await options.screenshot({ path: path.join(SHOTS, `v-${theme}-8-optionen.png`),
        fullPage: true });
      await options.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), TEST_DIR), { recursive: true, force: true });
  }
  console.log(`\nAufnahmen in ${SHOTS}`);
}

main().catch((e) => { console.error('Abbruch:', e.message); process.exit(1); });

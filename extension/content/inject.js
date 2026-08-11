/**
 * Ersetzt YouTubes Download-Button und rendert das Download-Panel.
 *
 * Alles läuft in einem Shadow Root: YouTubes Styles können nichts
 * überschreiben und wir hinterlassen keine Styles auf der Seite.
 */

const PILL_ID = 'ytdl-pill-host';
const PANEL_ID = 'ytdl-panel-host';

const DEFAULTS = {
  mode: 'video',
  height: 1080,
  container: 'mp4',
  forceH264: false,
  audioFormat: 'mp3',
  subs: false,
  subLangs: 'de,en',
  chapters: true,
  metadata: true,
  thumbnail: false,
  sponsorblock: false,
  replaceNativeButton: true,
  autoProbe: true,
};

// Solange die Formate noch nicht abgefragt sind, die übliche Leiter.
// Danach zeigt das Panel die Stufen, die es für dieses Video wirklich gibt.
const FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

const AUDIO_FORMATS = [
  { value: 'mp3', label: 'MP3', note: '320 kbit/s · überall abspielbar' },
  { value: 'm4a', label: 'M4A', note: 'AAC · Original ohne Neukodierung' },
  { value: 'opus', label: 'OPUS', note: 'beste Qualität pro Byte' },
  { value: 'flac', label: 'FLAC', note: 'verlustfrei aus verlustbehaftet' },
  { value: 'wav', label: 'WAV', note: 'unkomprimiert · sehr groß' },
];

// Ersatz, falls die Seite keinen eigenen Download-Button hergibt. Gefüllt
// wie YouTubes Icons, nicht als Kontur — sonst wirkt es zwischen den
// Nachbarn zu leicht.
const ICON_DOWNLOAD =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.58 6.29 9.87 ' +
  '7.7 8.46 11 11.75V3h2v8.75l3.29-3.29 1.42 1.41L12 15.58zM5 18h14v2H5z"/></svg>';

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.55 17.6 4 12.05l' +
  '1.41-1.41 4.14 4.13 9.04-9.03L20 7.15 9.55 17.6z"/></svg>';

const ICON_ALERT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 1.5 20.5h21' +
  'L12 3.5zm.9 13.6h-1.8v-1.8h1.8v1.8zm0-3.3h-1.8V9.9h1.8v3.9z"/></svg>';

// ------------------------------------------------------------------ Zustand ---

const state = {
  settings: { ...DEFAULTS },
  videoId: null,
  probe: null,
  probePending: false,
  job: null,          // { id, percent, stage, status }
  result: null,       // { path, filename, size }
  error: null,
  resumable: false,   // Fehler war eine Störung, kein endgültiges Nein
  partialBytes: 0,    // was von diesem Video schon auf der Platte liegt
  panelOpen: false,
};

let pillHost = null;
let pillRoot = null;
let pillWidth = 0;
let restyleTimer = null;
let panelHost = null;
let panelRoot = null;
let contextLost = false;

// ------------------------------------------------------------------ Helfer ---

function bytes(value) {
  if (!value && value !== 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function clock(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return null;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function currentVideoId() {
  try {
    const url = new URL(location.href);
    if (url.pathname.startsWith('/shorts/')) {
      return url.pathname.split('/')[2] || null;
    }
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

function pageTitle() {
  const node =
    document.querySelector('ytd-watch-metadata h1 yt-formatted-string') ||
    document.querySelector('ytd-watch-metadata #title h1') ||
    document.querySelector('h1.ytd-watch-metadata');
  return node ? node.textContent.trim() : document.title.replace(/ - YouTube$/, '');
}

function pageChannel() {
  const node =
    document.querySelector('ytd-video-owner-renderer #channel-name a') ||
    document.querySelector('#owner #channel-name a') ||
    document.querySelector('ytd-channel-name a');
  return node ? node.textContent.trim() : '';
}

/**
 * Liest Maße und Farben von einem echten YouTube-Button aus derselben
 * Leiste. Abgeschriebene Zahlen veralten mit jedem YouTube-Umbau; die
 * abgelesenen bleiben richtig.
 */
function readReferenceStyle() {
  const bar = findActionBar();
  const reference = bar && (
    bar.querySelector('yt-button-view-model button') ||
    bar.querySelector('button.yt-spec-button-shape-next') ||
    bar.querySelector('.yt-spec-button-shape-next') ||
    bar.querySelector('button'));
  if (!reference) return null;

  const style = getComputedStyle(reference);
  const icon = reference.querySelector('svg');

  // Den Icon-Rand aus der Geometrie ableiten statt aus dem Wrapper: YouTube
  // hängt den Wrapper manchmal erst nach, dann läse man 0 statt -6px.
  let iconMarginLeft = '-6px';
  let iconMarginRight = '6px';
  if (icon) {
    const box = reference.getBoundingClientRect();
    const iconBox = icon.getBoundingClientRect();
    const padLeft = parseFloat(style.paddingLeft) || 0;
    if (box.width > 0 && iconBox.width > 0) {
      const offset = Math.round(iconBox.left - box.left - padLeft);
      if (offset >= -16 && offset <= 0) {
        iconMarginLeft = `${offset}px`;
        iconMarginRight = `${-offset}px`;
      }
    }
  }

  return {
    height: style.height,
    padding: style.padding,
    radius: style.borderRadius,
    background: style.backgroundColor,
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    iconSize: icon ? `${Math.round(icon.getBoundingClientRect().width) || 24}px` : '24px',
    iconMarginLeft,
    iconMarginRight,
  };
}

function parseColor(value) {
  const match = String(value || '').match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i);
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3],
           a: match[4] === undefined ? 1 : +match[4] };
}

/** YouTubes Hover ist genau die doppelte Deckkraft der Grundfläche. */
function doubleAlpha(value, factor = 2) {
  const c = parseColor(value);
  if (!c) return value;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.min(1, c.a * factor).toFixed(3)})`;
}

function isLightColor(value) {
  const c = parseColor(value);
  if (!c) return false;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5;
}

function isDark() {
  // Die Textfarbe eines echten Buttons ist das verlässlichste Signal —
  // das Attribut fehlt manchmal, und die Systemeinstellung sagt nichts
  // darüber, welches Thema YouTube gerade anzeigt.
  const reference = readReferenceStyle();
  if (reference && reference.color) return isLightColor(reference.color);
  return document.documentElement.hasAttribute('dark');
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const text = chrome.runtime.lastError.message || '';
          if (text.includes('context invalidated') || text.includes('Receiving end')) {
            contextLost = true;
          }
          resolve({ ok: false, error: text });
          return;
        }
        resolve(response || { ok: true });
      });
    } catch (err) {
      contextLost = true;
      resolve({ ok: false, error: String(err) });
    }
  });
}

// -------------------------------------------------------------------- Styles ---

const PILL_CSS = `
:host { display: inline-flex; align-items: center; }
* { box-sizing: border-box; }
.pill {
  position: relative;
  display: inline-flex; align-items: center; justify-content: center;
  /* Alle Maße stammen vom Nachbarbutton, damit nichts hervorsticht. */
  height: var(--h, 40px);
  padding: var(--pad, 0 16px);
  border: 0; border-radius: var(--radius, 20px);
  background: var(--bg, rgba(255,255,255,.1));
  color: var(--fg, #f1f1f1);
  font-family: var(--font, Roboto, "Helvetica Neue", Arial, sans-serif);
  font-size: var(--size, 14px);
  font-weight: var(--weight, 500);
  letter-spacing: var(--tracking, normal);
  line-height: 1;
  cursor: pointer; overflow: hidden; white-space: nowrap;
  -webkit-font-smoothing: antialiased;
  transition: background-color .12s ease;
}
.pill:hover { background: var(--bg-hover, rgba(255,255,255,.2)); }
.pill:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }

/* Fortschritt bleibt farblos: die Farbe gehört ins Panel, nicht in die
   Leiste. Der Streifen ist derselbe Ton wie der Hover-Zustand. */
.fill {
  position: absolute; inset: 0 auto 0 0; width: var(--p, 0%);
  background: var(--bg-hover, rgba(255,255,255,.2));
  transition: width .3s ease; pointer-events: none;
}
.inner { position: relative; display: inline-flex; align-items: center; }
svg {
  width: var(--icon, 24px); height: var(--icon, 24px); flex: none;
  margin-left: var(--icon-ml, -6px); margin-right: var(--icon-mr, 6px);
  fill: currentColor;
}
svg path { fill: currentColor; }
.label {
  /* Ziffern gleicher Breite: der Prozentwert darf nicht zappeln. Die
     Schrift bleibt dabei dieselbe wie bei den Nachbarbuttons. */
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1;
}
@media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
`;

const PANEL_CSS = `
* { box-sizing: border-box; }
:host {
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
  position: fixed; top: 0; left: 0; z-index: 2147483000;
}
.panel {
  width: 372px; max-width: calc(100vw - 24px);
  background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 14px;
  box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 18px 44px -8px rgba(0,0,0,.42);
  font-family: var(--ui);
  overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
  transform-origin: var(--origin, top left);
  animation: pop .15s cubic-bezier(.2,.8,.3,1);
}
@keyframes pop { from { opacity: 0; transform: scale(.965) translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { .panel { animation: none; } }

/* --- Kopf --- */
.head { display: flex; gap: 11px; padding: 13px 14px 12px; }
.thumb {
  width: 92px; height: 52px; flex: none; border-radius: 7px;
  object-fit: cover; background: var(--surface);
}
.head-text { min-width: 0; padding-top: 1px; }
.title {
  margin: 0 0 4px; font-size: 13.5px; font-weight: 600; line-height: 1.32;
  letter-spacing: -.005em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.sub {
  margin: 0; font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  letter-spacing: .01em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Umschalter Video/Audio --- */
.seg {
  display: grid; grid-template-columns: 1fr 1fr; gap: 2px;
  margin: 0 14px; padding: 2px; background: var(--surface);
  border-radius: 9px;
}
.seg button {
  border: 0; background: transparent; color: var(--muted); cursor: pointer;
  padding: 7px 0; border-radius: 7px; font-family: var(--mono);
  font-size: 10.5px; font-weight: 600; letter-spacing: .1em;
  text-transform: uppercase; transition: background-color .12s, color .12s;
}
.seg button:hover { color: var(--fg); }
.seg button[aria-selected="true"] { background: var(--raised); color: var(--fg); }
.seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

/* --- Abschnitte --- */
.section { padding: 13px 14px 0; }
.legend {
  margin: 0 0 8px; font-family: var(--mono); font-size: 9.5px; font-weight: 600;
  letter-spacing: .12em; text-transform: uppercase; color: var(--muted);
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
}
.legend em { font-style: normal; color: var(--faint); letter-spacing: .06em; }

.chips { display: flex; flex-wrap: wrap; gap: 5px; align-content: flex-start; }
/* Zwei Reihen Platz halten: sonst rutscht das Panel, sobald die
   Formatabfrage die Liste der Auflösungen austauscht. */
.chips.rows2 { min-height: 59px; }
.chip {
  border: 1px solid var(--line); background: transparent; color: var(--fg);
  border-radius: 7px; padding: 5px 9px; cursor: pointer;
  font-family: var(--mono); font-size: 11.5px; font-weight: 500;
  letter-spacing: .01em; font-variant-numeric: tabular-nums;
  transition: border-color .12s, background-color .12s, color .12s;
}
.chip:hover:not([disabled]) { border-color: var(--line-strong); background: var(--surface); }
.chip[aria-checked="true"] {
  border-color: var(--accent); color: var(--accent-ink);
  background: var(--accent-soft);
}
.chip[disabled] { opacity: .32; cursor: not-allowed; }
.chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.spec {
  margin: 9px 0 0; font-family: var(--mono); font-size: 10.5px;
  color: var(--muted); letter-spacing: .01em; min-height: 13px;
  font-variant-numeric: tabular-nums;
}

.toggles { display: flex; flex-wrap: wrap; gap: 5px; }
.toggle {
  display: inline-flex; align-items: center; gap: 5px;
  border: 1px solid var(--line); background: transparent; color: var(--muted);
  border-radius: 7px; padding: 5px 9px 5px 7px; cursor: pointer;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .04em;
  transition: border-color .12s, color .12s, background-color .12s;
}
.toggle:hover { border-color: var(--line-strong); color: var(--fg); }
.toggle .box {
  width: 11px; height: 11px; border-radius: 3px; flex: none;
  border: 1.5px solid var(--line-strong); transition: background-color .12s, border-color .12s;
}
.toggle[aria-pressed="true"] { color: var(--accent-ink); border-color: var(--accent); }
.toggle[aria-pressed="true"] .box { background: var(--accent); border-color: var(--accent); }
.toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* --- Aktion --- */
.foot { padding: 14px; }
.go {
  width: 100%; border: 0; border-radius: 9px; padding: 11px 14px; cursor: pointer;
  font-family: var(--ui); font-size: 13.5px; font-weight: 600; letter-spacing: -.005em;
  background: var(--accent); color: var(--on-accent);
  transition: filter .12s, background-color .12s;
}
.go:hover { filter: brightness(1.08); }
.go:active { filter: brightness(.96); }
.go:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.go[data-variant="ghost"] {
  background: var(--surface); color: var(--fg);
  box-shadow: inset 0 0 0 1px var(--line);
}
.go[disabled] { opacity: .5; cursor: default; filter: none; }

.actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 7px; }
.actions .go { font-size: 12.5px; padding: 9px 10px; }

/* --- Fortschritt: SMPTE-Farbbalken ---
   Der Balken wächst als vollständiges Testbild mit: schon bei wenigen
   Prozent sind alle sieben Farben da. Ein bloßes Aufdecken von links
   würde die ersten 15 % nur Grau zeigen. */
.bars {
  position: relative; height: 6px; margin: 12px 0 0;
  border-radius: 3px; overflow: hidden; background: var(--surface);
}
.strip {
  position: absolute; top: 0; bottom: 0; left: 0;
  width: var(--p, 0%); display: flex; transition: width .25s ease;
}
.strip i { flex: 1; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .strip { transition: none; } }

.status {
  display: flex; align-items: center; gap: 6px; margin: 9px 0 0;
  font-family: var(--mono); font-size: 10.5px; letter-spacing: .01em;
  color: var(--muted); font-variant-numeric: tabular-nums;
  min-height: 14px;
}
.status svg { width: 13px; height: 13px; flex: none; }
.status[data-tone="ok"] { color: var(--accent-ink); }
.status[data-tone="error"] { color: var(--danger); }
.status .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }

.hint {
  margin: 0; padding: 9px 14px 11px; border-top: 1px solid var(--line);
  font-family: var(--mono); font-size: 10px; color: var(--faint);
  letter-spacing: .02em;
}
.hint button {
  border: 0; background: none; padding: 0; cursor: pointer; color: var(--muted);
  font: inherit; text-decoration: underline; text-underline-offset: 2px;
}
.hint button:hover { color: var(--fg); }
.hint button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.banner {
  margin: 0 14px; padding: 9px 11px; border-radius: 8px;
  background: var(--danger-soft); color: var(--danger);
  font-family: var(--mono); font-size: 10.5px; line-height: 1.45;
}
/* Eine Unterbrechung ist keine Störung im Sinne eines Fehlers —
   sie bekommt deshalb den Akzent, nicht die Warnfarbe. */
.banner[data-tone="pause"] {
  background: var(--accent-soft); color: var(--accent-ink);
}
.sr {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;

const THEME_DARK = `
--bg: #0B0B0D; --surface: #17171B; --raised: #26262E;
--line: #2A2A33; --line-strong: #3D3D48;
--fg: #F2F2F5; --muted: #9A9AA6; --faint: #6A6A76;
--accent: #3ED8D8; --accent-ink: #5FE6E6; --accent-soft: rgba(62,216,216,.14);
--on-accent: #05252B; --danger: #FF7A6B; --danger-soft: rgba(255,122,107,.12);
--bg-hover: rgba(255,255,255,.16);
`;

const THEME_LIGHT = `
--bg: #FFFFFF; --surface: #F2F2F5; --raised: #FFFFFF;
--line: #E2E2E8; --line-strong: #C6C6D0;
--fg: #0B0B0D; --muted: #5C5C68; --faint: #8A8A96;
--accent: #0E9C9C; --accent-ink: #0A7E7E; --accent-soft: rgba(14,156,156,.10);
--on-accent: #FFFFFF; --danger: #C0392B; --danger-soft: rgba(192,57,43,.09);
--bg-hover: rgba(0,0,0,.09);
`;

function themeVars() {
  return isDark() ? THEME_DARK : THEME_LIGHT;
}

// SMPTE-Farbbalken bei 75 % Amplitude — das Testbild der Videotechnik.
const SMPTE = ['#BFBFBF', '#BFBF00', '#00BFBF', '#00BF00', '#BF00BF', '#BF0000', '#0000BF'];

// ------------------------------------------------------------------- Pille ---

/** Holt YouTubes eigenes Download-Icon, solange es auf der Seite liegt. */
function downloadIconMarkup() {
  try {
    const native = findNativeDownloadButton();
    const svg = native && native.querySelector('svg');
    if (svg) {
      const clone = svg.cloneNode(true);
      clone.removeAttribute('class');
      clone.removeAttribute('style');
      clone.removeAttribute('width');
      clone.removeAttribute('height');
      clone.setAttribute('aria-hidden', 'true');
      return clone.outerHTML;
    }
  } catch { /* Seite ist gerade im Umbau */ }
  return ICON_DOWNLOAD;
}

function pillThemeCss() {
  const ref = readReferenceStyle();
  if (!ref) {
    const dark = document.documentElement.hasAttribute('dark');
    return `--h:40px;--pad:0 16px;--radius:20px;--icon:24px;` +
      `--icon-ml:-6px;--icon-mr:6px;--font:Roboto,"Helvetica Neue",Arial,sans-serif;` +
      `--size:14px;--weight:500;--tracking:normal;` +
      (dark
        ? '--fg:#f1f1f1;--bg:rgba(255,255,255,.1);--bg-hover:rgba(255,255,255,.2);'
        : '--fg:#0f0f0f;--bg:rgba(0,0,0,.05);--bg-hover:rgba(0,0,0,.1);');
  }
  return [
    `--h:${ref.height}`,
    `--pad:${ref.padding}`,
    `--radius:${ref.radius}`,
    `--bg:${ref.background}`,
    `--bg-hover:${doubleAlpha(ref.background)}`,
    `--fg:${ref.color}`,
    `--font:${ref.fontFamily}`,
    `--size:${ref.fontSize}`,
    `--weight:${ref.fontWeight}`,
    `--tracking:${ref.letterSpacing}`,
    `--icon:${ref.iconSize}`,
    `--icon-ml:${ref.iconMarginLeft}`,
    `--icon-mr:${ref.iconMarginRight}`,
  ].join(';') + ';';
}

function buildPill() {
  const host = document.createElement('div');
  host.id = PILL_ID;
  host.style.display = 'inline-flex';
  host.style.alignItems = 'center';
  // YouTube setzt den Abstand links am Element selbst, nicht rechts am
  // Vorgänger. Andersherum klebt der Button am Nachbarn.
  host.style.marginLeft = '8px';

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{${pillThemeCss()}}` + PILL_CSS;
  root.appendChild(style);

  const button = document.createElement('button');
  button.className = 'pill';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<span class="fill"></span>' +
    `<span class="inner">${downloadIconMarkup()}<span class="label">Herunterladen</span></span>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    togglePanel();
  });
  root.appendChild(button);

  pillHost = host;
  pillRoot = root;
  pillWidth = 0;
  return host;
}

/**
 * Friert die Breite auf die des Ruhezustands ein. Ohne das springt die
 * ganze Buttonleiste, sobald aus „Herunterladen" ein Prozentwert wird.
 * Gemessen wird immer mit der längsten Beschriftung, unabhängig davon,
 * welcher Zustand gerade angezeigt wird.
 */
function lockPillWidth(remeasure) {
  if (!pillRoot) return;
  const button = pillRoot.querySelector('.pill');
  const inner = pillRoot.querySelector('.inner');
  if (!button || !inner || !button.isConnected) return;

  if (!pillWidth || remeasure) {
    const current = inner.innerHTML;
    button.style.width = '';
    inner.innerHTML = `${downloadIconMarkup()}<span class="label">Herunterladen</span>`;
    const measured = button.getBoundingClientRect().width;
    inner.innerHTML = current;
    if (measured > 40) pillWidth = Math.round(measured);
  }
  if (pillWidth) button.style.width = `${pillWidth}px`;
}

function renderPill() {
  if (!pillRoot) return;
  const button = pillRoot.querySelector('.pill');
  const inner = pillRoot.querySelector('.inner');
  const fill = pillRoot.querySelector('.fill');
  if (!button || !inner) return;

  button.setAttribute('aria-expanded', String(state.panelOpen));

  let icon = downloadIconMarkup();
  let label = 'Herunterladen';
  let title = 'Mit yt-dlp herunterladen';
  let percent = 0;

  if (state.job) {
    const value = state.job.percent;
    percent = (value === null || value === undefined) ? 0 : value;
    // Kurze Beschriftungen: alles muss in die eingefrorene Breite passen.
    label = (value === null || value === undefined) ? '…' : `${value.toFixed(0)} %`;
    title = state.job.stage || 'Download läuft';
    button.setAttribute('aria-live', 'polite');
  } else if (state.result) {
    icon = ICON_CHECK;
    label = 'Fertig';
    title = state.result.filename || 'Fertig';
    button.removeAttribute('aria-live');
  } else if (state.error) {
    icon = ICON_ALERT;
    label = 'Fehler';
    title = state.error;
    button.removeAttribute('aria-live');
  } else if (state.partialBytes > 0) {
    label = 'Fortsetzen';
    title = `${bytes(state.partialBytes)} sind bereits geladen`;
    button.removeAttribute('aria-live');
  } else {
    button.removeAttribute('aria-live');
  }

  inner.innerHTML = `${icon}<span class="label">${escapeHtml(label)}</span>`;
  fill.style.setProperty('--p', `${percent}%`);
  button.title = title;
  lockPillWidth();
}

// -------------------------------------------------------------------- Panel ---

function buildPanel() {
  const host = document.createElement('div');
  host.id = PANEL_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{${themeVars()}}` + PANEL_CSS;
  root.appendChild(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Video herunterladen');
  panel.addEventListener('click', (event) => event.stopPropagation());
  root.appendChild(panel);

  document.body.appendChild(host);
  panelHost = host;
  panelRoot = root;
  return host;
}

function specLine() {
  const { settings, probe } = state;
  if (settings.mode === 'audio') {
    const format = AUDIO_FORMATS.find((f) => f.value === settings.audioFormat);
    const size = probe && probe.audioSize;
    const estimate = settings.audioFormat === 'm4a' && size ? ` · ~${bytes(size)}` : '';
    return `${settings.audioFormat} · ${format ? format.note : ''}${estimate}`;
  }
  const parts = [settings.container];
  parts.push(settings.forceH264 ? 'H.264 + AAC' : 'beste Codecs');
  if (probe && probe.heights && probe.heights.length) {
    const wanted = effectiveHeight();
    const match = probe.heights.find((h) => h.height === wanted) || probe.heights[0];
    if (match) {
      parts.push(`${match.height}p`);
      if (match.size) parts.push(bytes(match.size));
    }
  }
  return parts.join(' · ');
}

/**
 * Die Stufe, die für dieses Video wirklich herauskommt. Steht die
 * Voreinstellung auf 1080p und das Video hat nur 240p, wird 1080p nicht
 * als ausgewählt markiert — sonst zeigt die Oberfläche etwas an, das es
 * nicht gibt. Die gespeicherte Voreinstellung bleibt davon unberührt.
 */
function heightOptions() {
  const list = state.probe && state.probe.heights;
  if (list && list.length) {
    return list.map((item) => ({ value: item.height, size: item.size }));
  }
  return FALLBACK_HEIGHTS.map((value) => ({ value, size: null }));
}

function effectiveHeight() {
  const list = state.probe && state.probe.heights;
  if (!list || !list.length) return state.settings.height;
  // Die Liste kommt absteigend: die erste Stufe, die nicht über der
  // Voreinstellung liegt, ist die, die yt-dlp nehmen wird.
  const match = list.find((item) => item.height <= state.settings.height);
  return match ? match.height : list[0].height;
}

/** Geschätzte Endgröße der aktuellen Auswahl, für „x von y". */
function expectedSize() {
  const { settings, probe } = state;
  if (!probe) return null;
  if (settings.mode === 'audio') return probe.audioSize || null;
  if (!probe.heights || !probe.heights.length) return null;
  const wanted = effectiveHeight();
  const match = probe.heights.find((h) => h.height === wanted) || probe.heights[0];
  return match ? match.size : null;
}

function renderPanel() {
  if (!panelRoot) return;
  const panel = panelRoot.querySelector('.panel');
  const { settings, probe, job, result, error } = state;

  const title = (probe && probe.title) || pageTitle();
  const channel = (probe && probe.uploader) || pageChannel();
  const duration = probe && probe.duration ? clock(probe.duration) : null;
  const thumb = state.videoId
    ? `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`
    : '';

  const subParts = [];
  if (channel) subParts.push(channel);
  if (duration) subParts.push(duration);
  if (!probe && state.probePending) subParts.push('Formate werden geladen …');

  const busy = Boolean(job);

  // ---- Kopf
  let html = `
    <div class="head">
      ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : '<div class="thumb"></div>'}
      <div class="head-text">
        <h2 class="title">${escapeHtml(title)}</h2>
        <p class="sub">${escapeHtml(subParts.join('  ·  ')) || '&nbsp;'}</p>
      </div>
    </div>`;

  // ---- Video / Audio
  html += `
    <div class="seg" role="tablist" aria-label="Was heruntergeladen wird">
      <button role="tab" type="button" data-mode="video"
        aria-selected="${settings.mode === 'video'}" ${busy ? 'disabled' : ''}>Video</button>
      <button role="tab" type="button" data-mode="audio"
        aria-selected="${settings.mode === 'audio'}" ${busy ? 'disabled' : ''}>Audio</button>
    </div>`;

  // ---- Qualität
  if (settings.mode === 'video') {
    const shown = effectiveHeight();
    const chips = heightOptions().map((item) => `
      <button class="chip" type="button" role="radio" data-height="${item.value}"
        aria-checked="${shown === item.value}"
        ${busy ? 'disabled' : ''}>${item.value}p</button>`).join('');
    html += `
      <div class="section">
        <p class="legend">Auflösung</p>
        <div class="chips rows2" role="radiogroup" aria-label="Auflösung">${chips}</div>
        <p class="spec">${escapeHtml(specLine())}</p>
      </div>`;
  } else {
    const chips = AUDIO_FORMATS.map((item) => `
      <button class="chip" type="button" role="radio" data-audio="${item.value}"
        aria-checked="${settings.audioFormat === item.value}"
        ${busy ? 'disabled' : ''}>${item.label}</button>`).join('');
    html += `
      <div class="section">
        <p class="legend">Format</p>
        <div class="chips" role="radiogroup" aria-label="Audioformat">${chips}</div>
        <p class="spec">${escapeHtml(specLine())}</p>
      </div>`;
  }

  // ---- Zusatzoptionen
  const toggles = settings.mode === 'video'
    ? [
        { key: 'subs', label: 'Untertitel' },
        { key: 'chapters', label: 'Kapitel' },
        { key: 'forceH264', label: 'H.264' },
        { key: 'sponsorblock', label: 'SponsorBlock' },
      ]
    : [
        { key: 'thumbnail', label: 'Cover' },
        { key: 'metadata', label: 'Metadaten' },
        { key: 'sponsorblock', label: 'SponsorBlock' },
      ];
  html += `
    <div class="section">
      <p class="legend">Extras</p>
      <div class="toggles">
        ${toggles.map((t) => `
          <button class="toggle" type="button" data-toggle="${t.key}"
            aria-pressed="${Boolean(settings[t.key])}" ${busy ? 'disabled' : ''}>
            <span class="box"></span>${t.label}
          </button>`).join('')}
      </div>
    </div>`;

  // ---- Fehlerbanner
  if (error && !busy) {
    html += `<div class="section"><div class="banner"
      ${state.resumable ? 'data-tone="pause"' : ''}>${escapeHtml(error)}</div></div>`;
  }

  // ---- Aktion + Fortschritt
  let percent = job && job.percent !== null && job.percent !== undefined
    ? job.percent : (result ? 100 : 0);
  if (!job && !result && state.partialBytes > 0) {
    const total = expectedSize();
    if (total) percent = Math.min(100, (state.partialBytes / total) * 100);
  }

  // Jeder Zustand hat dieselbe Aufteilung: eine Haupttat, zwei Nebentaten,
  // Balken, Statuszeile. Nur so bleibt die Höhe konstant und das Panel
  // hüpft nicht, sobald der Download beginnt oder fertig wird.
  let primary;
  let secondary;
  if (busy) {
    primary = { act: 'cancel', label: 'Abbrechen', ghost: true };
    secondary = [{ act: 'openDir', label: 'Zielordner' },
                 { act: 'options', label: 'Einstellungen' }];
  } else if (result) {
    primary = { act: 'restart', label: 'Noch einmal laden' };
    secondary = [{ act: 'reveal', label: 'Im Finder zeigen' },
                 { act: 'play', label: 'Abspielen' }];
  } else if (state.partialBytes > 0) {
    primary = { act: 'resume', label: 'Fortsetzen' };
    secondary = [{ act: 'fresh', label: 'Neu beginnen' },
                 { act: 'discard', label: 'Verwerfen' }];
  } else {
    primary = { act: 'start',
                label: settings.mode === 'audio' ? 'Audio laden' : 'Video laden' };
    secondary = [{ act: 'openDir', label: 'Zielordner' },
                 { act: 'options', label: 'Einstellungen' }];
  }

  html += `
    <div class="foot">
      <button class="go" type="button" data-act="${primary.act}"
        ${primary.ghost ? 'data-variant="ghost"' : ''}>${primary.label}</button>
      <div class="actions">
        ${secondary.map((item) => `<button class="go" type="button"
          data-act="${item.act}" data-variant="ghost">${item.label}</button>`).join('')}
      </div>
      <div class="bars" role="progressbar" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow="${Math.round(percent)}" aria-label="Fortschritt">
        <div class="strip" style="--p:${percent}%">${
          SMPTE.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      </div>
      <p class="status" data-tone="${result ? 'ok' : error ? 'error' : ''}">${statusHtml()}</p>
    </div>`;

  // ---- Fußzeile
  html += '<p class="hint"><span>yt-dlp + ffmpeg · lokal auf diesem Rechner</span></p>';

  panel.innerHTML = html;
  bindPanel(panel);
}

function statusHtml() {
  const { job, result, error } = state;
  if (job) {
    const bits = [];
    if (job.stage) bits.push(job.stage);
    else bits.push('Lädt');
    if (job.speed) bits.push(`${bytes(job.speed)}/s`);
    if (job.eta !== null && job.eta !== undefined) bits.push(`noch ${clock(job.eta)}`);
    if (job.total && job.downloaded !== null && job.downloaded !== undefined) {
      bits.push(`${bytes(job.downloaded)} von ${bytes(job.total)}`);
    }
    return `<span class="grow">${escapeHtml(bits.join('  ·  '))}</span>`;
  }
  if (result) {
    return `${ICON_CHECK}<span class="grow">${escapeHtml(result.filename)}</span>` +
      `<span>${bytes(result.size) || ''}</span>`;
  }
  if (error) {
    return `${ICON_ALERT}<span class="grow">${
      state.resumable ? 'Unterbrochen' : 'Fehlgeschlagen'}</span>`;
  }
  if (state.partialBytes > 0) {
    const total = expectedSize();
    return `<span class="grow">${bytes(state.partialBytes)}${
      total ? ` von ${bytes(total)}` : ''} bereits geladen</span>`;
  }
  return '<span class="grow">Bereit</span>';
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindPanel(panel) {
  panel.querySelectorAll('[data-mode]').forEach((node) => {
    node.addEventListener('click', () => {
      state.settings.mode = node.dataset.mode;
      persist({ mode: state.settings.mode });
      state.error = null;
      renderPanel();
      // Video und Audio sind unterschiedlich hoch: neu ausrichten, damit
      // das Panel unten am Button bleibt statt eine Lücke zu lassen.
      positionPanel();
    });
  });

  panel.querySelectorAll('[data-height]').forEach((node) => {
    node.addEventListener('click', () => {
      state.settings.height = Number(node.dataset.height);
      persist({ height: state.settings.height });
      renderPanel();
    });
  });

  panel.querySelectorAll('[data-audio]').forEach((node) => {
    node.addEventListener('click', () => {
      state.settings.audioFormat = node.dataset.audio;
      persist({ audioFormat: state.settings.audioFormat });
      renderPanel();
    });
  });

  panel.querySelectorAll('[data-toggle]').forEach((node) => {
    node.addEventListener('click', () => {
      const key = node.dataset.toggle;
      state.settings[key] = !state.settings[key];
      persist({ [key]: state.settings[key] });
      renderPanel();
    });
  });

  const act = (name, handler) => {
    const node = panel.querySelector(`[data-act="${name}"]`);
    if (node) node.addEventListener('click', handler);
  };
  act('start', startDownload);
  act('resume', startDownload);          // yt-dlp setzt selbst an der Bruchstelle an
  act('fresh', async () => {
    await send({ type: 'discardPartials', videoId: state.videoId });
    state.partialBytes = 0;
    state.error = null;
    startDownload();
  });
  act('discard', async () => {
    await send({ type: 'discardPartials', videoId: state.videoId });
    state.partialBytes = 0;
    state.error = null;
    state.resumable = false;
    renderPanel();
    renderPill();
  });
  act('restart', () => { state.result = null; state.error = null; startDownload(); });
  act('cancel', cancelDownload);
  act('reveal', () => state.result && send({ type: 'reveal', path: state.result.path }));
  act('play', () => state.result && send({ type: 'open', path: state.result.path }));
  act('options', () => send({ type: 'openOptions' }));
  act('openDir', () => send({ type: 'openDir' }));

  // Pfeiltasten innerhalb der Chip-Gruppen
  panel.querySelectorAll('[role="radiogroup"]').forEach((group) => {
    group.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
      if (!keys.includes(event.key)) return;
      const chips = [...group.querySelectorAll('.chip:not([disabled])')];
      const index = chips.indexOf(panelRoot.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      const next = chips[(index + step + chips.length) % chips.length];
      next.focus();
      next.click();
    });
  });
}

function positionPanel() {
  if (!panelHost || !pillHost) return;
  const rect = pillHost.getBoundingClientRect();
  const panel = panelRoot.querySelector('.panel');
  if (!panel) return;

  const gap = 8;
  const margin = 12;

  // Ohne Begrenzung messen — sonst schrumpft das Panel bei jedem Aufruf.
  panel.style.maxHeight = '';
  const width = panel.offsetWidth || 372;
  const height = panel.offsetHeight || 420;

  const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;

  let top;
  let origin;
  let available;
  if (height <= spaceBelow) {
    top = rect.bottom + gap; origin = 'top left'; available = spaceBelow;
  } else if (height <= spaceAbove) {
    top = rect.top - gap - height; origin = 'bottom left'; available = spaceAbove;
  } else if (spaceBelow >= spaceAbove) {
    top = rect.bottom + gap; origin = 'top left'; available = spaceBelow;
  } else {
    top = margin; origin = 'bottom left'; available = spaceAbove;
  }

  // Passt es auf keine Seite ganz, scrollt das Panel innen — es schiebt
  // sich nie über den Button, der es geöffnet hat.
  // Die Mindesthöhe muss unter dem liegen, was ein niedriges Fenster
  // hergibt — sonst erzwingt sie genau die Überlappung, die sie
  // verhindern soll.
  if (height > available) {
    panel.style.maxHeight = `${Math.max(140, Math.round(available))}px`;
  }

  let left = rect.left;
  if (left + width > window.innerWidth - margin) {
    left = window.innerWidth - width - margin;
  }
  if (left < margin) left = margin;

  panelHost.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  panel.style.setProperty('--origin', origin);
}

function anchorVisible() {
  if (!pillHost) return false;
  const rect = pillHost.getBoundingClientRect();
  return rect.width > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

/**
 * Reaktion auf Scrollen und Größenänderung. Nur hier wird geschlossen —
 * beim Neuzeichnen während eines Downloads darf das Panel nicht
 * verschwinden, bloß weil YouTube kurz das Layout verschiebt.
 */
function onViewportChange() {
  if (!state.panelOpen) return;
  if (!anchorVisible()) { closePanel(); return; }
  positionPanel();
}

function togglePanel() {
  if (state.panelOpen) closePanel();
  else openPanel();
}

function openPanel() {
  if (!panelHost) buildPanel();
  const style = panelRoot.querySelector('style');
  style.textContent = `:host{${themeVars()}}` + PANEL_CSS;
  state.panelOpen = true;
  panelHost.style.display = 'block';
  renderPanel();
  positionPanel();
  renderPill();

  requestAnimationFrame(() => {
    const first = panelRoot.querySelector('.go, .seg button');
    if (first) first.focus({ preventScroll: true });
  });

  document.addEventListener('click', onOutsideClick, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);

  if (state.settings.autoProbe && !state.probe && !state.probePending) probe();
}

function closePanel() {
  state.panelOpen = false;
  if (panelHost) panelHost.style.display = 'none';
  document.removeEventListener('click', onOutsideClick, true);
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
  renderPill();
}

function onOutsideClick(event) {
  const path = event.composedPath();
  if (path.includes(panelHost) || path.includes(pillHost)) return;
  closePanel();
}

function onKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closePanel();
    const button = pillRoot && pillRoot.querySelector('.pill');
    if (button) button.focus();
  }
}

// ------------------------------------------------------------------ Aktionen ---

function persist(patch) {
  send({ type: 'saveSettings', patch });
}

async function probe() {
  if (!state.videoId) return;
  state.probePending = true;
  renderPanel();
  const response = await send({ type: 'probe', url: watchUrl() });
  state.probePending = false;
  if (response && response.ok && response.data) {
    state.probe = response.data;
    state.partialBytes = response.data.partialBytes || 0;
  }
  if (state.panelOpen) { renderPanel(); positionPanel(); }
}

function watchUrl() {
  return `https://www.youtube.com/watch?v=${state.videoId}`;
}

async function startDownload() {
  if (!state.videoId) return;
  state.error = null;
  state.result = null;
  state.job = { id: null, percent: null, stage: 'Wird vorbereitet' };
  renderPanel();
  renderPill();

  const response = await send({
    type: 'download',
    url: watchUrl(),
    opts: { ...state.settings },
  });

  if (!response || !response.ok) {
    state.job = null;
    state.error = (response && response.error) ||
      'Der Native Host antwortet nicht. Läuft install.sh?';
    renderPanel();
    renderPill();
    return;
  }
  state.job.id = response.id;
}

function cancelDownload() {
  if (!state.job || !state.job.id) return;
  send({ type: 'cancel', id: state.job.id });
  state.job.stage = 'Wird abgebrochen';
  renderPanel();
}

// ------------------------------------------------------- Nachrichten vom SW ---

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;
  const job = state.job;

  switch (message.type) {
    case 'progress':
      if (!job || (job.id && message.id !== job.id)) break;
      // „Wird vorbereitet" darf nicht stehen bleiben, sobald Daten fließen.
      state.job = {
        ...job, id: message.id, ...message.data,
        stage: message.data.status === 'downloading' ? null : job.stage,
      };
      break;
    case 'stage':
      if (!job || (job.id && message.id !== job.id)) break;
      state.job = { ...job, stage: message.stage };
      break;
    case 'meta':
      if (!job || (job.id && message.id !== job.id)) break;
      state.job = { ...job, title: message.title };
      break;
    case 'done':
      if (job && job.id && message.id !== job.id) break;
      state.job = null;
      state.result = message.data;
      state.error = null;
      state.resumable = false;
      state.partialBytes = 0;
      break;
    case 'failed':
      if (job && job.id && message.id !== job.id) break;
      state.job = null;
      state.error = message.error;
      state.resumable = Boolean(message.resumable);
      state.partialBytes = message.partialBytes || state.partialBytes;
      break;
    case 'cancelled':
      if (job && job.id && message.id !== job.id) break;
      state.job = null;
      state.error = null;
      state.resumable = false;
      state.partialBytes = message.partialBytes || 0;
      break;
    default:
      return;
  }

  renderPill();
  if (state.panelOpen) { renderPanel(); positionPanel(); }
});

// --------------------------------------------------------------- Einhängen ---

function findActionBar() {
  const selectors = [
    'ytd-watch-metadata #top-level-buttons-computed',
    '#actions-inner #top-level-buttons-computed',
    'ytd-watch-flexy #top-level-buttons-computed',
    '#menu-container #top-level-buttons-computed',
    'ytd-watch-metadata #actions #menu ytd-menu-renderer #top-level-buttons-computed',
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node && node.isConnected) return node;
  }
  return null;
}

function findNativeDownloadButton() {
  return document.querySelector('ytd-watch-metadata ytd-download-button-renderer') ||
    document.querySelector('#top-level-buttons-computed ytd-download-button-renderer') ||
    document.querySelector('ytd-download-button-renderer');
}

function mount() {
  const videoId = currentVideoId();
  if (!videoId) { unmount(); return; }

  if (videoId !== state.videoId) {
    state.videoId = videoId;
    state.probe = null;
    state.probePending = false;
    state.result = null;
    state.error = null;
    state.resumable = false;
    state.partialBytes = 0;
    if (state.panelOpen) closePanel();
  }

  const bar = findActionBar();
  if (!bar) return;

  const existing = document.getElementById(PILL_ID);
  if (existing && existing.parentElement === bar) { renderPill(); return; }
  if (existing) existing.remove();

  const host = pillHost && !pillHost.isConnected ? pillHost : buildPill();

  const native = findNativeDownloadButton();
  if (native && state.settings.replaceNativeButton) {
    // Erst das Icon übernehmen, dann ausblenden — danach ist es weg.
    if (native.parentElement === bar) bar.insertBefore(host, native);
    else bar.appendChild(host);
    refreshPillStyle();
    native.style.display = 'none';
    native.setAttribute('aria-hidden', 'true');
  } else {
    if (native) { native.style.display = ''; native.removeAttribute('aria-hidden'); }
    bar.appendChild(host);
    refreshPillStyle();
  }
  renderPill();
  lockPillWidth(true);

  // YouTube baut die Leiste schrittweise auf — später noch einmal messen.
  clearTimeout(restyleTimer);
  restyleTimer = setTimeout(() => {
    if (!pillRoot || !pillHost || !pillHost.isConnected) return;
    refreshPillStyle();
    renderPill();
    lockPillWidth(true);
  }, 1200);
}

/** Übernimmt Maße und Farben erneut — YouTube baut die Leiste oft nach. */
function refreshPillStyle() {
  if (!pillRoot) return;
  const style = pillRoot.querySelector('style');
  if (style) style.textContent = `:host{${pillThemeCss()}}` + PILL_CSS;
}

function unmount() {
  const existing = document.getElementById(PILL_ID);
  if (existing) existing.remove();
  if (state.panelOpen) closePanel();
  state.videoId = null;
}

let mountTimer = null;
function scheduleMount() {
  clearTimeout(mountTimer);
  mountTimer = setTimeout(() => {
    if (contextLost) return;
    try { mount(); } catch (err) { /* YouTube baut gerade um */ }
  }, 120);
}

async function init() {
  const response = await send({ type: 'getSettings' });
  if (response && response.ok && response.settings) {
    state.settings = { ...DEFAULTS, ...response.settings };
  }

  new MutationObserver(scheduleMount).observe(document.documentElement, {
    childList: true, subtree: true,
  });
  window.addEventListener('yt-navigate-finish', scheduleMount);
  window.addEventListener('popstate', scheduleMount);

  // YouTubes Themenwechsel ohne Neuladen mitnehmen
  new MutationObserver(() => {
    if (pillHost) { pillHost.remove(); pillHost = null; pillRoot = null; }
    if (panelHost) { panelHost.remove(); panelHost = null; panelRoot = null; state.panelOpen = false; }
    scheduleMount();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });

  scheduleMount();
}

init();

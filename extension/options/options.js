const el = (id) => document.getElementById(id);

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360]
  .map((value) => ({ value, label: `${value}p` }));
const AUDIO = ['mp3', 'm4a', 'opus', 'flac', 'wav'];
const CONTAINERS = ['mp4', 'mkv'];

const EXTRAS = [
  { key: 'subs', label: 'Untertitel' },
  { key: 'chapters', label: 'Kapitel' },
  { key: 'metadata', label: 'Metadaten' },
  { key: 'thumbnail', label: 'Cover' },
  { key: 'sponsorblock', label: 'SponsorBlock' },
  { key: 'forceH264', label: 'H.264 erzwingen' },
];

const BEHAVIOUR = [
  { key: 'autoResume', label: 'Nach Verbindungsabriss weitermachen' },
  { key: 'notify', label: 'Mitteilung wenn fertig' },
  { key: 'replaceNativeButton', label: 'Vorhandenen Download-Button ersetzen' },
  { key: 'autoProbe', label: 'Formate beim Öffnen prüfen' },
];

let settings = {};

function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({
    ok: false, error: String(err && err.message ? err.message : err),
  }));
}

function bytes(value) {
  if (!value && value !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

let savedTimer = null;
async function save(patch) {
  Object.assign(settings, patch);
  await send({ type: 'saveSettings', patch });
  const note = el('saved-note');
  note.textContent = 'Gespeichert';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { note.textContent = ''; }, 1600);
}

// ------------------------------------------------------------------ Chips ---

function renderChoice(container, items, current, onPick) {
  container.innerHTML = items.map((item) => `
    <button class="chip" type="button" role="radio" data-value="${item.value}"
      aria-checked="${String(item.value) === String(current)}">${item.label}</button>`).join('');
  container.querySelectorAll('.chip').forEach((node) => {
    node.addEventListener('click', () => {
      onPick(node.dataset.value);
      container.querySelectorAll('.chip').forEach((other) => {
        other.setAttribute('aria-checked', String(other === node));
      });
    });
  });
}

function renderToggles(container, items) {
  container.innerHTML = items.map((item) => `
    <button class="chip" type="button" data-key="${item.key}"
      aria-pressed="${Boolean(settings[item.key])}">${item.label}</button>`).join('');
  container.querySelectorAll('.chip').forEach((node) => {
    node.addEventListener('click', () => {
      const next = !(node.getAttribute('aria-pressed') === 'true');
      node.setAttribute('aria-pressed', String(next));
      save({ [node.dataset.key]: next });
    });
  });
}

function bindText(id, key, transform = (v) => v) {
  const node = el(id);
  node.value = settings[key] ?? '';
  node.addEventListener('change', () => save({ [key]: transform(node.value.trim()) }));
}

// ------------------------------------------------------------- Werkzeuge ---

function renderTools(info, error) {
  const list = el('tool-list');
  const note = el('tool-note');

  if (!info) {
    list.innerHTML = `<dt>Native Host</dt>
      <dd class="mono" data-state="missing">nicht erreichbar</dd>`;
    note.dataset.tone = 'error';
    note.textContent = error || 'Starte die Einrichtung im Programmordner erneut.';
    return;
  }

  const rows = [
    ['Native Host', info.hostVersion ? `${info.hostVersion} · Python ${info.python}` : '—',
      Boolean(info.hostVersion)],
    ['yt-dlp', info.ytdlp && info.ytdlp.version
      ? `${info.ytdlp.version}\n${info.ytdlp.path}` : 'nicht gefunden',
      Boolean(info.ytdlp && info.ytdlp.version)],
    ['ffmpeg', info.ffmpeg && info.ffmpeg.version
      ? `${info.ffmpeg.version}\n${info.ffmpeg.path}` : 'nicht gefunden',
      Boolean(info.ffmpeg && info.ffmpeg.version)],
    ['Standardordner', info.defaultDir || '—', true],
  ];

  list.innerHTML = rows.map(([term, value, ok]) => `
    <dt>${term}</dt>
    <dd class="mono" data-state="${ok ? 'ok' : 'missing'}">${
      String(value).split('\n').map(escapeHtml).join('<br>')}</dd>`).join('');

  if (!info.ready) {
    note.dataset.tone = 'error';
    note.textContent = 'Es fehlt ein Werkzeug. Starte die Einrichtung im '
      + 'Programmordner erneut — sie lädt es nach.';
  } else {
    note.dataset.tone = '';
    note.textContent = '';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function checkTools() {
  el('tool-note').textContent = '';
  const response = await send({ type: 'ping' });
  if (response && response.ok && response.data) renderTools(response.data);
  else renderTools(null, response && response.error);
}

// --------------------------------------------------- Angefangene Downloads ---

async function loadPartials() {
  const list = el('partials');
  const note = el('partials-note');
  const response = await send({ type: 'partials' });

  if (!response || !response.ok) {
    list.innerHTML = '';
    note.textContent = 'Konnte nicht gelesen werden.';
    return;
  }
  const items = (response.data && response.data.items) || [];
  if (!items.length) {
    list.innerHTML = '';
    note.textContent = 'Keine angefangenen Downloads.';
    el('discard-partials').hidden = true;
    return;
  }
  el('discard-partials').hidden = false;
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  list.innerHTML = items.map((item) => `
    <li>
      <span class="name">${escapeHtml(item.name)}</span>
      <span class="size">${bytes(item.bytes)}</span>
    </li>`).join('');
  note.textContent = `${items.length} angefangen · ${bytes(total)} belegt. `
    + 'Diese Downloads laufen an derselben Stelle weiter.';
}

// ------------------------------------------------------------------ Start ---

async function init() {
  const state = await send({ type: 'getState' });
  settings = (state && state.settings) || {};

  bindText('outputDir', 'outputDir');
  bindText('filenameTemplate', 'filenameTemplate');
  bindText('rateLimit', 'rateLimit');
  bindText('subLangs', 'subLangs');

  el('concurrentFragments').value = String(settings.concurrentFragments ?? 4);
  el('concurrentFragments').addEventListener('change', (event) => {
    save({ concurrentFragments: Number(event.target.value) });
  });

  renderChoice(el('height-chips'), HEIGHTS, settings.height,
    (value) => save({ height: Number(value) }));
  renderChoice(el('audio-chips'), AUDIO.map((v) => ({ value: v, label: v.toUpperCase() })),
    settings.audioFormat, (value) => save({ audioFormat: value }));
  renderChoice(el('container-chips'), CONTAINERS.map((v) => ({ value: v, label: v.toUpperCase() })),
    settings.container, (value) => save({ container: value }));

  renderToggles(el('extra-toggles'), EXTRAS);
  renderToggles(el('behaviour-toggles'), BEHAVIOUR);

  el('ext-id').textContent = chrome.runtime.id;

  checkTools();
  loadPartials();
}

el('recheck').addEventListener('click', () => { checkTools(); loadPartials(); });

el('update-ytdlp').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const note = el('tool-note');
  button.disabled = true;
  note.dataset.tone = '';
  note.textContent = 'yt-dlp wird aktualisiert — das kann eine Minute dauern …';
  const response = await send({ type: 'update' });
  button.disabled = false;
  if (response && response.ok && response.data) {
    note.dataset.tone = 'ok';
    note.textContent = `yt-dlp ist jetzt auf ${response.data.version || 'der neuesten Version'}.`;
    checkTools();
  } else {
    note.dataset.tone = 'error';
    note.textContent = `Aktualisieren fehlgeschlagen: ${
      response ? response.error : 'unbekannt'}`;
  }
});

el('discard-partials').addEventListener('click', async () => {
  await send({ type: 'discardPartials' });
  loadPartials();
});

init();

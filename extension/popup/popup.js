const SMPTE = ['#BFBFBF', '#BFBF00', '#00BFBF', '#00BF00', '#BF00BF', '#BF0000', '#0000BF'];

const el = (id) => document.getElementById(id);
let jobs = new Map();

function bytes(value) {
  if (!value && value !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value; let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function clock(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function ago(timestamp) {
  const diff = (Date.now() - timestamp) / 1000;
  if (diff < 60) return 'gerade eben';
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} h`;
  return new Date(timestamp).toLocaleDateString('de-DE',
    { day: '2-digit', month: '2-digit' });
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({
    ok: false, error: String(err && err.message ? err.message : err),
  }));
}

function barsMarkup(percent) {
  return `<span class="bars">
    <span class="strip" style="--p:${percent}%">${
      SMPTE.map((c) => `<i style="background:${c}"></i>`).join('')}</span>
  </span>`;
}

// ----------------------------------------------------------------- Status ---

function renderStatus(status) {
  const dot = el('status-dot');
  const text = el('status-text');
  const detail = el('status-detail');
  const actions = el('status-actions');

  if (!status || !status.checked) {
    dot.dataset.state = '';
    text.textContent = 'Wird geprüft …';
    detail.textContent = '';
    actions.hidden = true;
    return;
  }

  if (status.ready) {
    const info = status.info || {};
    dot.dataset.state = 'ok';
    text.textContent = 'Bereit';
    detail.textContent = [
      info.ytdlp && info.ytdlp.version ? `yt-dlp ${info.ytdlp.version}` : null,
      info.ffmpeg && info.ffmpeg.version ? `ffmpeg ${info.ffmpeg.version}` : null,
    ].filter(Boolean).join('  ·  ');
    actions.hidden = true;
    el('version').textContent = info.hostVersion ? `Host ${info.hostVersion}` : '';
  } else {
    dot.dataset.state = 'error';
    text.textContent = 'Nicht bereit';
    detail.textContent = status.error || 'Der Native Host antwortet nicht.';
    actions.hidden = false;
  }
}

// ------------------------------------------------------------------- Jobs ---

function renderJobs() {
  const list = el('jobs');
  const block = el('jobs-block');
  if (!jobs.size) { block.hidden = true; list.innerHTML = ''; return; }
  block.hidden = false;

  list.innerHTML = [...jobs.values()].map((job) => {
    const percent = job.percent ?? 0;
    const meta = [
      job.percent !== null && job.percent !== undefined ? `${job.percent.toFixed(0)} %` : '…',
      job.speed ? `${bytes(job.speed)}/s` : null,
      job.eta !== null && job.eta !== undefined ? `noch ${clock(job.eta)}` : null,
    ].filter(Boolean).join('  ·  ');

    return `<li class="item" data-id="${job.id}">
      <span class="name">${escapeHtml(job.title || job.stage || 'Wird geladen …')}</span>
      <span class="meta">${escapeHtml(meta)}</span>
      ${barsMarkup(percent)}
      <span class="row"><button data-cancel="${job.id}">Abbrechen</button></span>
    </li>`;
  }).join('');

  list.querySelectorAll('[data-cancel]').forEach((node) => {
    node.addEventListener('click', () => send({ type: 'cancel', id: node.dataset.cancel }));
  });
}

// ------------------------------------------------------- Unterbrochene ---

function renderInterrupted(items, online) {
  const block = el('interrupted-block');
  const list = el('interrupted');
  const note = el('interrupted-note');

  if (!items || !items.length) {
    block.hidden = true;
    list.innerHTML = '';
    return;
  }
  block.hidden = false;

  list.innerHTML = items.map((entry) => {
    const key = entry.videoId || entry.url;
    const reason = entry.reason === 'network'
      ? 'Verbindung abgerissen'
      : 'von Hand abgebrochen';
    // Der Grund gehört in die Metazeile, nicht zwischen die Aktionen —
    // dort läse er sich wie ein dritter Knopf.
    return `<li class="item">
      <span class="name" title="${escapeHtml(entry.title || entry.url)}">${
        escapeHtml(entry.title || entry.url)}</span>
      <span class="meta">${[entry.bytes ? bytes(entry.bytes) : null, reason]
        .filter(Boolean).join('  ·  ')}</span>
      <span class="row">
        <button data-resume="${escapeHtml(key)}">Fortsetzen</button>
        <button data-drop="${escapeHtml(key)}">Verwerfen</button>
      </span>
    </li>`;
  }).join('');

  const autoPending = items.some((entry) => entry.reason === 'network');
  note.textContent = autoPending
    ? (online
      ? 'Wird von allein fortgesetzt, sobald nichts anderes läuft.'
      : 'Kein Netz — wird fortgesetzt, sobald die Verbindung zurück ist.')
    : '';

  list.querySelectorAll('[data-resume]').forEach((node) => {
    node.addEventListener('click', async () => {
      node.disabled = true;
      await send({ type: 'resume', key: node.dataset.resume });
      refresh();
    });
  });
  list.querySelectorAll('[data-drop]').forEach((node) => {
    node.addEventListener('click', async () => {
      await send({ type: 'discardPartials', videoId: node.dataset.drop });
      refresh();
    });
  });
}

// ---------------------------------------------------------------- Historie ---

function renderHistory(history) {
  const list = el('history');
  const empty = el('history-empty');
  const clear = el('clear-history');

  if (!history || !history.length) {
    list.innerHTML = '';
    empty.hidden = false;
    clear.hidden = true;
    return;
  }
  empty.hidden = true;
  clear.hidden = false;

  list.innerHTML = history.slice(0, 8).map((entry) => `
    <li class="item">
      <span class="name" title="${escapeHtml(entry.filename)}">${escapeHtml(entry.filename)}</span>
      <span class="meta">${bytes(entry.size)}  ·  ${ago(entry.finishedAt)}</span>
      <span class="row">
        <button data-reveal="${escapeHtml(entry.path)}">Im Finder zeigen</button>
        <button data-play="${escapeHtml(entry.path)}">Abspielen</button>
      </span>
    </li>`).join('');

  list.querySelectorAll('[data-reveal]').forEach((node) => {
    node.addEventListener('click', () => send({ type: 'reveal', path: node.dataset.reveal }));
  });
  list.querySelectorAll('[data-play]').forEach((node) => {
    node.addEventListener('click', () => send({ type: 'open', path: node.dataset.play }));
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ------------------------------------------------------------------ Start ---

async function refresh() {
  const state = await send({ type: 'getState' });
  if (!state || !state.ok) return;
  jobs = new Map((state.jobs || []).map((job) => [job.id, job]));
  renderJobs();
  renderInterrupted(state.interrupted, state.online);
  renderHistory(state.history);
  renderStatus(state.hostStatus);
}

async function checkHost() {
  renderStatus(null);
  const response = await send({ type: 'ping' });
  if (response && response.ok && response.data) {
    renderStatus({ checked: true, ready: response.data.ready, info: response.data,
      error: response.data.ready ? null : 'yt-dlp oder ffmpeg wurde nicht gefunden.' });
  } else {
    renderStatus({ checked: true, ready: false,
      error: (response && response.error) || 'Keine Antwort vom Native Host.' });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;
  switch (message.type) {
    case 'jobUpdate':
      jobs.set(message.id, message.job);
      renderJobs();
      break;
    case 'jobDone':
    case 'jobFailed':
    case 'jobCancelled':
      jobs.delete(message.id);
      renderJobs();
      refresh();
      break;
    case 'hostStatus':
      renderStatus(message.status);
      break;
    case 'interruptedChanged':
    case 'autoResumed':
      refresh();
      break;
    default:
      break;
  }
});

el('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
el('retry').addEventListener('click', checkHost);
el('open-dir').addEventListener('click', () => send({ type: 'openDir' }));
el('discard-all').addEventListener('click', async () => {
  await send({ type: 'discardPartials' });
  refresh();
});

el('clear-history').addEventListener('click', async () => {
  await send({ type: 'clearHistory' });
  refresh();
});

el('fetch').addEventListener('click', async () => {
  const url = el('url').value.trim();
  const detail = el('url-detail');
  if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)/i.test(url)) {
    detail.textContent = 'Bitte eine YouTube-URL einfügen.';
    return;
  }
  detail.textContent = 'Wird gestartet …';
  const response = await send({ type: 'download', url });
  detail.textContent = response && response.ok
    ? 'Läuft. Fortschritt siehe oben.'
    : `Fehlgeschlagen: ${response ? response.error : 'unbekannt'}`;
  if (response && response.ok) el('url').value = '';
  refresh();
});

el('url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') el('fetch').click();
});

refresh();
checkHost();

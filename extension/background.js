/**
 * Service Worker: einzige Brücke zwischen den Oberflächen der Extension
 * und dem Native Messaging Host.
 *
 * Der Host schickt alle 15 Sekunden einen Heartbeat, solange Downloads
 * laufen. Diese eingehenden Nachrichten halten den Service Worker am
 * Leben — ohne sie würde Chrome ihn nach 30 Sekunden Leerlauf beenden
 * und den laufenden Download mitreißen.
 */

const HOST_NAME = 'com.yannik.ytdl_host';
const HISTORY_LIMIT = 30;

const DEFAULTS = {
  outputDir: '',
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
  concurrentFragments: 4,
  rateLimit: '',
  filenameTemplate: '%(title)s [%(id)s].%(ext)s',
  playlist: false,
  notify: true,
  autoResume: true,
  replaceNativeButton: true,
  autoProbe: true,
};

let port = null;
let hostStatus = { ready: false, checked: false, error: null };

const jobs = new Map();      // jobId -> { tabId, url, title, percent, startedAt }
const pending = new Map();   // requestId -> { resolve, timer }
let counter = 0;

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

// ------------------------------------------------------------ Native Port ---

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (err) {
    hostStatus = { ready: false, checked: true, error: String(err) };
    port = null;
    return null;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    const reason = error && error.message
      ? error.message
      : 'Die Verbindung zum Native Host wurde beendet.';
    port = null;
    hostStatus = { ready: false, checked: true, error: humanizeHostError(reason) };

    // Alle laufenden Jobs sind mit dem Host gestorben.
    for (const [id, job] of jobs) {
      notifyTab(job.tabId, { type: 'failed', id, error: hostStatus.error });
      jobs.delete(id);
    }
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: hostStatus.error });
    }
    pending.clear();
    broadcast({ type: 'hostStatus', status: hostStatus });
  });
  return port;
}

function humanizeHostError(raw) {
  const text = String(raw || '');
  if (/not found|Specified native messaging host not found/i.test(text)) {
    return 'Der Native Host ist nicht registriert. Starte die Einrichtung erneut.';
  }
  if (/forbidden|not allowed/i.test(text)) {
    return 'Der Native Host erlaubt diese Extension-ID nicht. Starte die Einrichtung erneut.';
  }
  if (/Native host has exited|exited/i.test(text)) {
    return 'Der Native Host wurde beendet. Details: ~/Library/Logs/Mitschnitt/host.log';
  }
  return text;
}

function post(message) {
  const active = connect();
  if (!active) {
    return { ok: false, error: hostStatus.error || 'Native Host nicht erreichbar.' };
  }
  try {
    active.postMessage(message);
    return { ok: true };
  } catch (err) {
    port = null;
    return { ok: false, error: String(err) };
  }
}

/** Sendet und wartet auf genau eine Antwort (ping, probe, reveal …). */
function request(message, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const id = message.id || nextId('req');
    message.id = id;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'Zeitüberschreitung beim Native Host.' });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    const result = post(message);
    if (!result.ok) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(result);
    }
  });
}

function settleRequest(message) {
  const entry = pending.get(message.id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(message.id);
  entry.resolve(
    message.type === 'error'
      ? { ok: false, error: message.message }
      : { ok: true, data: message },
  );
  return true;
}

// ---------------------------------------------------- Nachrichten vom Host ---

async function onHostMessage(message) {
  if (!message || !message.type) return;

  if (message.type === 'heartbeat') return;   // hält nur den Worker wach

  if (message.type === 'pong') {
    hostStatus = {
      ready: Boolean(message.ready),
      checked: true,
      error: message.ready ? null : 'yt-dlp oder ffmpeg fehlt.',
      info: message,
    };
    broadcast({ type: 'hostStatus', status: hostStatus });
  }

  // Einmalige Antworten (ping/probe/reveal/open/update) auflösen.
  if (settleRequest(message)) return;

  const job = jobs.get(message.id);
  if (!job) return;

  switch (message.type) {
    case 'started':
      job.outputDir = message.outputDir;
      break;

    case 'meta':
      job.title = message.title;
      notifyTab(job.tabId, { type: 'meta', id: message.id, title: message.title });
      break;

    case 'progress':
      job.percent = message.percent;
      job.speed = message.speed;
      job.eta = message.eta;
      notifyTab(job.tabId, {
        type: 'progress',
        id: message.id,
        data: {
          percent: message.percent,
          speed: message.speed,
          eta: message.eta,
          total: message.total,
          downloaded: message.downloaded,
          status: message.status,
        },
      });
      broadcast({ type: 'jobUpdate', id: message.id, job: publicJob(message.id, job) });
      break;

    case 'stage':
      job.stage = message.stage;
      notifyTab(job.tabId, { type: 'stage', id: message.id, stage: message.stage });
      broadcast({ type: 'jobUpdate', id: message.id, job: publicJob(message.id, job) });
      break;

    case 'done': {
      jobs.delete(message.id);
      const entry = {
        id: message.id,
        title: message.title || job.title || '',
        filename: message.filename,
        path: message.path,
        size: message.size,
        url: job.url,
        finishedAt: Date.now(),
        seconds: message.seconds,
      };
      await addHistory(entry);
      notifyTab(job.tabId, { type: 'done', id: message.id, data: entry });
      broadcast({ type: 'jobDone', id: message.id, entry });
      await maybeNotify(entry);
      break;
    }

    case 'error':
      jobs.delete(message.id);
      if (message.resumable && job.opts) {
        await rememberInterrupted({
          url: job.url,
          videoId: videoIdFrom(job.url),
          title: job.title || '',
          opts: job.opts,
          bytes: message.partialBytes || null,
          reason: 'network',
        });
      }
      notifyTab(job.tabId, {
        type: 'failed',
        id: message.id,
        error: message.message,
        resumable: Boolean(message.resumable),
        partialBytes: message.partialBytes || null,
      });
      broadcast({ type: 'jobFailed', id: message.id, error: message.message });
      break;

    case 'cancelled':
      jobs.delete(message.id);
      // Von Hand abgebrochen: merken, aber nie von allein weiterlaufen lassen.
      if (message.partialBytes && job.opts) {
        await rememberInterrupted({
          url: job.url,
          videoId: videoIdFrom(job.url),
          title: job.title || '',
          opts: job.opts,
          bytes: message.partialBytes,
          reason: 'cancelled',
        });
      }
      notifyTab(job.tabId, {
        type: 'cancelled',
        id: message.id,
        partialBytes: message.partialBytes || null,
      });
      broadcast({ type: 'jobCancelled', id: message.id });
      break;

    default:
      break;
  }
}

function publicJob(id, job) {
  return {
    id,
    title: job.title || '',
    url: job.url,
    percent: job.percent ?? null,
    speed: job.speed ?? null,
    eta: job.eta ?? null,
    stage: job.stage || null,
    startedAt: job.startedAt,
  };
}

function notifyTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => { /* Tab ist zu */ });
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => { /* niemand hört zu */ });
}

// -------------------------------------------- Unterbrochene Downloads ---

const MAX_AUTO_ATTEMPTS = 60;

function videoIdFrom(url) {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.split('/')[2] || null;
    if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
    return parsed.searchParams.get('v');
  } catch {
    return null;
  }
}

async function getInterrupted() {
  const stored = await chrome.storage.local.get('interrupted');
  return stored.interrupted || [];
}

/**
 * Merkt sich einen unterbrochenen Download. Pro Video bleibt genau ein
 * Eintrag bestehen — sonst sammeln sich Duplikate bei jedem Fehlversuch.
 */
async function rememberInterrupted(entry) {
  const list = await getInterrupted();
  const key = entry.videoId || entry.url;
  const previous = list.find((item) => (item.videoId || item.url) === key);
  const next = list.filter((item) => (item.videoId || item.url) !== key);
  next.unshift({
    ...entry,
    attempts: entry.reason === 'network' ? ((previous && previous.attempts) || 0) + 1 : 0,
    at: Date.now(),
  });
  await chrome.storage.local.set({ interrupted: next.slice(0, 20) });
  await syncResumeAlarm();
  broadcast({ type: 'interruptedChanged' });
}

async function forgetInterrupted(key) {
  const list = await getInterrupted();
  const next = list.filter((item) => (item.videoId || item.url) !== key);
  await chrome.storage.local.set({ interrupted: next });
  await syncResumeAlarm();
  broadcast({ type: 'interruptedChanged' });
}

/** Startet einen gemerkten Download erneut; yt-dlp setzt selbst fort. */
async function resumeEntry(entry, tabId = null) {
  const id = nextId('job');
  jobs.set(id, {
    tabId,
    url: entry.url,
    title: entry.title || '',
    percent: null,
    startedAt: Date.now(),
    resumed: true,
  });
  jobs.get(id).opts = entry.opts;
  const result = post({ cmd: 'download', id, url: entry.url, opts: entry.opts });
  if (!result.ok) {
    jobs.delete(id);
    return { ok: false, error: result.error };
  }
  await forgetInterrupted(entry.videoId || entry.url);
  broadcast({ type: 'jobUpdate', id, job: publicJob(id, jobs.get(id)) });
  return { ok: true, id };
}

/**
 * Nimmt abgebrochene Netzwerk-Downloads wieder auf, sobald wieder eine
 * Verbindung besteht. Von Hand abgebrochene Downloads bleiben liegen —
 * ein Abbruch ist eine Entscheidung, keine Störung.
 */
async function resumeInterrupted(trigger) {
  if (!navigator.onLine) return;
  const settings = await getSettings();
  if (!settings.autoResume) return;

  const list = await getInterrupted();
  const candidates = list.filter((entry) =>
    entry.reason === 'network' && (entry.attempts || 0) < MAX_AUTO_ATTEMPTS);
  if (!candidates.length) return;

  // Einer nach dem anderen: parallele Anläufe würden sich die Bandbreite
  // nehmen und dieselbe Datei doppelt anfassen.
  if (jobs.size > 0) return;

  const entry = candidates[0];
  const result = await resumeEntry(entry);
  if (result.ok) {
    broadcast({ type: 'autoResumed', url: entry.url, trigger });
  }
}

/**
 * Der Weckruf läuft nur, solange tatsächlich etwas wartet. Ein dauerhafter
 * Minutentakt würde den Service Worker rund um die Uhr aufwecken.
 */
async function syncResumeAlarm() {
  const list = await getInterrupted();
  const waiting = list.some((entry) =>
    entry.reason === 'network' && (entry.attempts || 0) < MAX_AUTO_ATTEMPTS);
  if (waiting) chrome.alarms.create('resume-check', { periodInMinutes: 1 });
  else await chrome.alarms.clear('resume-check');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'resume-check') resumeInterrupted('alarm');
});
self.addEventListener('online', () => resumeInterrupted('online'));
syncResumeAlarm();

// ------------------------------------------------------------ Einstellungen ---

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function addHistory(entry) {
  const stored = await chrome.storage.local.get('history');
  const history = [entry, ...(stored.history || [])].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ history });
}

async function maybeNotify(entry) {
  const settings = await getSettings();
  if (!settings.notify) return;
  try {
    await chrome.notifications.create(`done:${entry.path}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Download fertig',
      message: entry.filename,
      silent: true,
    });
  } catch { /* Benachrichtigungen abgeschaltet */ }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('done:')) {
    post({ cmd: 'reveal', id: nextId('rev'), path: id.slice(5) });
    chrome.notifications.clear(id);
  }
});

// ------------------------------------------- Nachrichten aus der Extension ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  });
  return true;   // Antwort kommt asynchron
});

async function handleMessage(message, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;

  switch (message.type) {
    case 'getSettings':
      return { ok: true, settings: await getSettings() };

    case 'saveSettings':
      return { ok: true, settings: await saveSettings(message.patch || {}) };

    case 'getState': {
      const stored = await chrome.storage.local.get('history');
      return {
        ok: true,
        settings: await getSettings(),
        history: stored.history || [],
        interrupted: await getInterrupted(),
        jobs: [...jobs.entries()].map(([id, job]) => publicJob(id, job)),
        hostStatus,
        online: navigator.onLine,
      };
    }

    case 'ping': {
      const response = await request({ cmd: 'ping' }, 20000);
      return response;
    }

    case 'probe': {
      const settings = await getSettings();
      return request(
        { cmd: 'probe', url: message.url, outputDir: settings.outputDir }, 60000);
    }

    case 'download': {
      const settings = await getSettings();
      const opts = { ...settings, ...(message.opts || {}) };
      const id = nextId('job');
      jobs.set(id, {
        tabId,
        url: message.url,
        title: message.title || '',
        opts,
        percent: null,
        startedAt: Date.now(),
      });
      const result = post({ cmd: 'download', id, url: message.url, opts });
      if (!result.ok) {
        jobs.delete(id);
        return { ok: false, error: result.error };
      }
      return { ok: true, id };
    }

    case 'cancel':
      post({ cmd: 'cancel', id: nextId('cnc'), target: message.id });
      return { ok: true };

    case 'reveal':
      return request({ cmd: 'reveal', path: message.path }, 10000);

    case 'open':
      return request({ cmd: 'open', path: message.path }, 10000);

    case 'openDir':
      return request({ cmd: 'openDir', path: message.path }, 10000);

    case 'update':
      return request({ cmd: 'update' }, 300000);

    case 'openOptions':
      await chrome.runtime.openOptionsPage();
      return { ok: true };

    case 'getInterrupted':
      return { ok: true, items: await getInterrupted() };

    case 'resume': {
      const list = await getInterrupted();
      const key = message.key;
      const entry = list.find((item) => (item.videoId || item.url) === key);
      if (!entry) return { ok: false, error: 'Kein gemerkter Download für diesen Eintrag.' };
      return resumeEntry(entry, tabId);
    }

    case 'discardPartials': {
      const settings = await getSettings();
      const response = await request({
        cmd: 'discardPartials',
        outputDir: settings.outputDir,
        videoId: message.videoId || null,
      }, 20000);
      if (message.videoId) await forgetInterrupted(message.videoId);
      else await chrome.storage.local.set({ interrupted: [] });
      await syncResumeAlarm();
      broadcast({ type: 'interruptedChanged' });
      return response;
    }

    case 'partials': {
      const settings = await getSettings();
      return request({ cmd: 'partials', outputDir: settings.outputDir }, 20000);
    }

    case 'clearHistory':
      await chrome.storage.local.set({ history: [] });
      return { ok: true };

    default:
      return { ok: false, error: `Unbekannte Nachricht: ${message.type}` };
  }
}

// Beim Installieren einmal prüfen, ob der Host erreichbar ist.
chrome.runtime.onInstalled.addListener(() => {
  request({ cmd: 'ping' }, 15000);
});

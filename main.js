const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const RELAY_PORT = 4567;

// Auto-découverte : on publie l'URL publique active vers un Worker Cloudflare,
// pour que le site web la récupère et bascule automatiquement (URL trycloudflare
// éphémère → le site n'a plus besoin d'une saisie manuelle à chaque redémarrage).
const POINTER_URL = 'https://restream-pointer.khalilbenaz.workers.dev/current';
const POINTER_SECRET = '55f40493adf04737101d9ed2c1247331d950cb04eb4086a8';

function publishPointer(streamUrl) {
  try {
    const u = new URL(POINTER_URL);
    const body = JSON.stringify({ url: streamUrl || '' });
    const r = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Auth': POINTER_SECRET,
      },
    }, (res) => { res.resume(); });
    r.on('error', () => {});
    r.write(body); r.end();
  } catch {}
}
const relay = { proc: null, server: null, dir: null, url: '', stopping: false, restarts: 0, restartTimer: null, stableTimer: null };
const tunnel = { proc: null, url: '' };

let ffmpegPath = require('ffmpeg-static');
// In packaged app the binary lives in app.asar.unpacked
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const recordings = new Map(); // id -> { proc, file }
let win;

// Filet de sécurité : ne jamais laisser une erreur tuer le process principal
function notifyError(msg) {
  try { if (win && !win.isDestroyed()) win.webContents.send('main-error', { msg: String(msg) }); } catch {}
}
process.on('uncaughtException', (e) => { console.error('uncaught:', e); notifyError(e && e.message); });
process.on('unhandledRejection', (e) => { console.error('unhandled:', e); notifyError(e && e.message); });

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    title: 'IPTV Live',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
}

// ---------- Vérification de mise à jour (app non signée : on propose, on n'auto-installe pas) ----------
const REPO = 'khalilbenaz/iptv-live';
function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
  return 0;
}
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'IPTV-Live', 'Accept': 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return fetchJson(res.headers.location).then(resolve, reject);
      }
      let d = ''; res.on('data', (c) => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function checkForUpdates(silent) {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const latest = rel.tag_name || '';
    if (!latest) throw new Error('no tag');
    if (cmpVer(latest, app.getVersion()) <= 0) {
      if (!silent && win) dialog.showMessageBox(win, { type: 'info', message: 'IPTV Live est à jour', detail: 'Version ' + app.getVersion(), buttons: ['OK'] });
      return;
    }
    const dmg = (rel.assets || []).find((a) => /\.dmg$/i.test(a.name));
    const r = await dialog.showMessageBox(win, {
      type: 'info',
      message: `Nouvelle version disponible : ${latest}`,
      detail: `Tu utilises la ${app.getVersion()}.\n\n${(rel.body || '').slice(0, 400)}`,
      buttons: ['Télécharger', 'Plus tard'],
      defaultId: 0, cancelId: 1,
    });
    if (r.response === 0) {
      shell.openExternal(dmg ? dmg.browser_download_url : (rel.html_url || `https://github.com/${REPO}/releases/latest`));
    }
  } catch (e) {
    if (!silent && win) dialog.showMessageBox(win, { type: 'warning', message: 'Vérification impossible', detail: e.message, buttons: ['OK'] });
  }
}
ipcMain.handle('check-update', () => checkForUpdates(false));

// ---------- EPG externe (XMLTV) : secours quand le fournisseur n'a pas d'EPG ----------
const zlib = require('zlib');
const XMLTV_DEFAULT = [
  'https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_BEIN1.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_AR1.xml.gz',
];
const xmltv = { index: new Map(), loadedAt: 0, loading: null };
let providerEpgUrl = '';   // EPG complet du fournisseur Xtream (xmltv.php), défini après connexion

const SUP_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const XMLTV_NOISE = new Set(['hd','fhd','uhd','sd','4k','8k','hevc','h265','h264','raw','backup','vip','multi','full','plus','digital','mono','stereo','english','french','arabic','arabe','ar','en','fr','tr','hq','channel','tv','live','d']);
function xmlNorm(s) {
  const x = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (m) => SUP_DIGITS.indexOf(m))
    .replace(/[ᴴᴰᵁᴷᶠˢᴾ]/g, ' ');
  return x.split(/[^a-z0-9]+/).filter((t) => t && !XMLTV_NOISE.has(t)).join('');
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function parseXmltvTs(s) { // "20260616120000 +0200"
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(s || '');
  if (!m) return 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[7]) { const sign = m[7][0] === '-' ? 1 : -1; t += sign * ((+m[7].slice(1, 3)) * 60 + (+m[7].slice(3, 5))) * 60000; }
  return Math.floor(t / 1000);
}
function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'IPTV-Live' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return fetchBuf(r.headers.location).then(resolve, reject); }
      if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
}
async function buildXmltv(sources) {
  const names = new Map();   // channelId -> [display-names]
  const progs = new Map();   // channelId -> [{title,st,en}]
  for (const url of sources) {
    let xml;
    try {
      const buf = await fetchBuf(url);
      xml = (/\.gz$/i.test(url) ? zlib.gunzipSync(buf) : buf).toString('utf8');
    } catch { continue; }
    let m;
    const chRe = /<channel id="([^"]+)">([\s\S]*?)<\/channel>/g;
    while ((m = chRe.exec(xml))) {
      names.set(m[1], [...m[2].matchAll(/<display-name[^>]*>([^<]+)</g)].map((x) => decodeEntities(x[1])));
    }
    const pRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    while ((m = pRe.exec(xml))) {
      const attrs = m[1];
      const id = (/channel="([^"]+)"/.exec(attrs) || [])[1];
      if (!id) continue;
      const st = parseXmltvTs((/start="([^"]+)"/.exec(attrs) || [])[1]);
      const en = parseXmltvTs((/stop="([^"]+)"/.exec(attrs) || [])[1]);
      const tm = /<title[^>]*>([^<]*)</.exec(m[2]);
      const title = tm ? decodeEntities(tm[1]).trim() : '';
      if (!title || !st) continue;
      if (!progs.has(id)) progs.set(id, []);
      progs.get(id).push({ title, st, en });
    }
  }
  const index = new Map();
  for (const [id, nm] of names) {
    const pl = progs.get(id);
    if (!pl || !pl.length) continue;
    pl.sort((a, b) => a.st - b.st);
    for (const n of nm) { const k = xmlNorm(n); if (k && !index.has(k)) index.set(k, pl); }
  }
  return index;
}
function ensureXmltv() {
  if (getSettings().xmltvEnabled === false) return Promise.resolve();
  if (xmltv.index.size && Date.now() - xmltv.loadedAt < 6 * 3600 * 1000) return Promise.resolve();
  if (xmltv.loading) return xmltv.loading;
  // l'EPG du fournisseur en priorité (couvre tes chaînes exactes), puis les sources publiques
  const sources = [providerEpgUrl, ...(getSettings().xmltvSources || XMLTV_DEFAULT)].filter(Boolean);
  xmltv.loading = buildXmltv(sources)
    .then((idx) => { if (idx.size) { xmltv.index = idx; xmltv.loadedAt = Date.now(); } })
    .catch(() => {})
    .finally(() => { xmltv.loading = null; });
  return xmltv.loading;
}
ipcMain.handle('epg-lookup', async (e, { name } = {}) => {
  if (getSettings().xmltvEnabled === false) return null;
  await ensureXmltv();
  const pl = xmltv.index.get(xmlNorm(name));
  if (!pl) return null;
  const now = Date.now() / 1000;
  const cur = pl.find((p) => p.st <= now && now < p.en) || null;
  const next = pl.find((p) => p.st > now) || null;
  return { cur, next };
});
ipcMain.handle('set-provider-epg', (e, { url } = {}) => {
  if (url && url !== providerEpgUrl) {
    providerEpgUrl = url;
    xmltv.index = new Map(); xmltv.loadedAt = 0;   // forcera un rechargement incluant le fournisseur
    if (getSettings().xmltvEnabled !== false) ensureXmltv();
  }
  return { ok: true };
});
ipcMain.handle('xmltv-status', () => ({
  enabled: getSettings().xmltvEnabled !== false,
  channels: xmltv.index.size,
  loadedAt: xmltv.loadedAt,
  sources: getSettings().xmltvSources || XMLTV_DEFAULT,
}));
ipcMain.handle('xmltv-config', (e, { enabled, sources } = {}) => {
  const s = getSettings();
  if (enabled !== undefined) s.xmltvEnabled = enabled;
  if (Array.isArray(sources)) s.xmltvSources = sources.filter(Boolean);
  saveSettings();
  xmltv.index = new Map(); xmltv.loadedAt = 0;  // forcera un rechargement
  if (s.xmltvEnabled !== false) ensureXmltv();
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
  setTimeout(() => checkForUpdates(true), 4000); // vérif discrète au démarrage
  setTimeout(() => { try { ensureXmltv(); } catch {} }, 6000); // précharge l'EPG externe
});
app.on('window-all-closed', () => {
  // stop everything
  for (const { proc } of recordings.values()) try { proc.kill('SIGKILL'); } catch {}
  stopRelay();
  stopTunnel();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Réglages persistants (dossier d'enregistrement choisi, etc.)
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
let _settings = null;
function getSettings() {
  if (!_settings) { try { _settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { _settings = {}; } }
  return _settings;
}
function saveSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify(_settings)); } catch {} }

// Dossier d'enregistrement : dossier choisi par l'utilisateur, sinon racine du
// profil (NON surveillée par « Accès contrôlé aux dossiers » de Windows)
function recordingsDir() {
  const s = getSettings();
  const dir = s.recDir || path.join(app.getPath('home'), 'IPTV Live Recordings');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

ipcMain.handle('get-recordings-dir', () => recordingsDir());

ipcMain.handle('open-recordings-dir', () => {
  shell.openPath(recordingsDir());
});

// Lit la durée (secondes) depuis l'atome mvhd d'un MP4, sans lancer ffmpeg.
// Fiable sur nos fichiers finalisés/exportés (+faststart => moov au début).
function mp4DurationSec(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.min(fs.fstatSync(fd).size, 4 * 1024 * 1024); // 4 Mo suffisent (faststart)
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    const i = buf.indexOf('mvhd');
    if (i < 0) return null;
    const ver = buf[i + 4];
    let ts, dur;
    if (ver === 1) { ts = buf.readUInt32BE(i + 4 + 16); dur = Number(buf.readBigUInt64BE(i + 4 + 20)); }
    else { ts = buf.readUInt32BE(i + 4 + 12); dur = buf.readUInt32BE(i + 4 + 16); }
    if (!ts) return null;
    return dur / ts;
  } catch { return null; }
}

// Liste les enregistrements locaux (vidéos du dossier), récents d'abord.
ipcMain.handle('list-recordings', () => {
  const dir = recordingsDir();
  let out = [];
  try {
    const exts = new Set(['.mp4', '.mov', '.mkv', '.ts']);
    out = fs.readdirSync(dir)
      .filter((f) => exts.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const full = path.join(dir, f);
        let st = {};
        try { st = fs.statSync(full); } catch {}
        return {
          name: f,
          path: full,
          size: st.size || 0,
          mtime: st.mtimeMs || 0,
          duration: mp4DurationSec(full),
          isWhatsapp: /_whatsapp\.mp4$/i.test(f),
        };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  return { dir, files: out };
});

ipcMain.handle('reveal-file', (e, { file }) => { if (file) shell.showItemInFolder(file); return { ok: true }; });
ipcMain.handle('open-file', async (e, { file }) => { const err = file ? await shell.openPath(file) : 'no file'; return { ok: !err, error: err || undefined }; });

ipcMain.handle('delete-recording', async (e, { file }) => {
  // sécurité : ne supprime que dans le dossier d'enregistrement
  try {
    const dir = recordingsDir();
    if (!file || path.dirname(file) !== dir) return { ok: false, error: 'hors dossier' };
    fs.unlinkSync(file);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Ré-encode un enregistrement en MP4 compatible WhatsApp (H264 main + AAC-LC + 30 fps).
// Les flux IPTV sont souvent en HE-AAC / 50 fps, que le transcodeur WhatsApp gère mal
// (résultat sans son). On normalise pour un partage fiable.
ipcMain.handle('export-whatsapp', async (e, { file } = {}) => {
  let src = file;
  if (!src) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choisir un enregistrement à exporter pour WhatsApp',
      defaultPath: recordingsDir(),
      filters: [{ name: 'Vidéos', extensions: ['mp4', 'mov', 'mkv', 'ts'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    src = r.filePaths[0];
  }
  const dir = path.dirname(src);
  const base = path.basename(src).replace(/\.[^.]+$/, '');
  const out = path.join(dir, `${base}_whatsapp.mp4`);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', src,
    '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-r', '30', '-crf', '23', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    '-y', out
  ];
  return await new Promise((resolve) => {
    let err = '';
    const ff = spawn(ffmpegPath, args);
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', (er) => resolve({ ok: false, error: er.message }));
    ff.on('close', (code) => {
      if (code === 0 && fs.existsSync(out)) {
        shell.showItemInFolder(out);
        resolve({ ok: true, file: out });
      } else {
        resolve({ ok: false, error: err.slice(-300) || ('ffmpeg code ' + code) });
      }
    });
  });
});

ipcMain.handle('pick-recordings-dir', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choisir le dossier d'enregistrement",
    defaultPath: recordingsDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true, dir: recordingsDir() };
  // test d'écriture pour éviter un dossier non accessible (ex: disque retiré)
  try {
    fs.mkdirSync(r.filePaths[0], { recursive: true });
    const probe = path.join(r.filePaths[0], '.iptv_write_test');
    fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
  } catch (e) {
    return { canceled: false, error: "Dossier non accessible en écriture : " + e.message, dir: recordingsDir() };
  }
  getSettings().recDir = r.filePaths[0];
  saveSettings();
  return { canceled: false, dir: r.filePaths[0] };
});

function sanitize(name) {
  return (name || 'stream').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

// Start recording a stream URL with ffmpeg (stream copy -> mp4)
ipcMain.handle('record-start', async (e, { url, name }) => {
  const id = String(Date.now()) + Math.floor(Math.random() * 1000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(recordingsDir(), `${sanitize(name)}_${stamp}.mp4`);
  // On enregistre d'abord dans un .part fragmenté (résistant aux coupures),
  // puis on le "finalise" en MP4 normal à l'arrêt (cf. finalizeRecording).
  const part = file + '.part';

  // 1 seule connexion fournisseur : on s'assure que le relais local tourne,
  // puis on enregistre DEPUIS le HLS local (aucune connexion supplémentaire).
  let startedRelay = false;
  if (!relay.proc) {
    await startRelayInternal(url, name);
    startedRelay = true;
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', LOCAL_URL,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    // MP4 fragmenté : chaque fragment est auto-suffisant, donc le fichier reste
    // récupérable même si l'enregistrement est coupé brutalement.
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    '-y', part
  ];

  const proc = spawn(ffmpegPath, args);
  recordings.set(id, { proc, file, part, name, startedRelay });

  let errBuf = '';
  proc.on('error', (e) => { notifyError('ffmpeg (enregistrement) : ' + e.message); });
  proc.stderr.on('data', (d) => { errBuf += d.toString(); });
  proc.on('close', (code) => {
    const wasAuto = (recordings.get(id) || {}).startedRelay;
    recordings.delete(id);
    // Finalise : remux du .part fragmenté -> MP4 normal (moov complet = bonne
    // durée affichée dans le Finder/QuickTime et partage intégral).
    finalizeRecording(part, file, (finalFile) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('record-stopped', { id, file: finalFile, code, startedRelay: wasAuto, error: errBuf.slice(-500) });
      }
    });
  });

  return { id, file, local: LOCAL_URL, startedRelay };
});

// Remux du fichier fragmenté (.part) en MP4 standard avec un moov complet :
// corrige la durée (le Finder/le partage lisaient 00:02 sur le fragmenté).
function finalizeRecording(part, file, done) {
  try {
    if (!fs.existsSync(part) || fs.statSync(part).size === 0) { done(file); return; }
  } catch { done(file); return; }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', part,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', file,
  ];
  const ff = spawn(ffmpegPath, args);
  ff.on('error', () => {
    // échec du remux : on garde au moins le .part (lisible VLC) en le renommant
    try { fs.renameSync(part, file); } catch {}
    done(file);
  });
  ff.on('close', (code) => {
    if (code === 0) {
      try { fs.unlinkSync(part); } catch {}
      done(file);
    } else {
      try { fs.renameSync(part, file); } catch {}
      done(file);
    }
  });
}

ipcMain.handle('record-stop', (e, { id }) => {
  const rec = recordings.get(id);
  if (!rec) return { ok: false };
  // arrêt propre : 'q' pour finir le fragment en cours, SIGKILL en secours
  try { rec.proc.stdin.write('q'); } catch {}
  setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} }, 3000);
  return { ok: true, file: rec.file };
});

ipcMain.handle('record-list', () => {
  return [...recordings.entries()].map(([id, r]) => ({ id, file: r.file, name: r.name }));
});

/* ---------- Restream : 1 connexion montante -> N clients LAN ---------- */
function lanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name]) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function stopRelay() {
  relay.stopping = true;
  if (relay.restartTimer) { clearTimeout(relay.restartTimer); relay.restartTimer = null; }
  if (relay.stableTimer) { clearTimeout(relay.stableTimer); relay.stableTimer = null; }
  if (relay.proc) { try { relay.proc.kill('SIGKILL'); } catch {} relay.proc = null; }
  if (relay.server) { try { relay.server.close(); } catch {} relay.server = null; }
}

// Lance (ou relance) le ffmpeg du relais. Reconnexion auto si le flux fournisseur
// hoquette, et redémarrage si ffmpeg meurt malgré tout (tant que le relais est voulu actif).
function spawnRelayFfmpeg() {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'IPTV-Live',
    // résilience du flux montant (HTTP) : on ne lâche pas au moindre hoquet
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-i', relay.url,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(relay.dir, 'seg%05d.ts'),
    path.join(relay.dir, 'index.m3u8')
  ];
  relay.proc = spawn(ffmpegPath, args);
  relay.proc.on('error', (e) => { notifyError('ffmpeg (relais) : ' + e.message); });

  // si le relais tient 20 s, on considère qu'il est stable et on remet le compteur à zéro
  if (relay.stableTimer) clearTimeout(relay.stableTimer);
  relay.stableTimer = setTimeout(() => { relay.restarts = 0; }, 20000);

  relay.proc.on('close', () => {
    relay.proc = null;
    if (relay.stableTimer) { clearTimeout(relay.stableTimer); relay.stableTimer = null; }
    if (relay.stopping) return;                       // arrêt volontaire
    if (relay.restarts < 20) {                        // mort inattendue -> on relance
      relay.restarts++;
      if (win && !win.isDestroyed()) win.webContents.send('tunnel-status', { msg: 'Flux interrompu, reconnexion…' });
      relay.restartTimer = setTimeout(() => { if (!relay.stopping) spawnRelayFfmpeg(); }, 2000);
    } else if (win && !win.isDestroyed()) {
      win.webContents.send('relay-stopped', {});      // trop d'échecs : on abandonne
    }
  });
}

const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };

const LOCAL_URL = `http://127.0.0.1:${RELAY_PORT}/index.m3u8`;

// Démarre le relais : 1 SEULE connexion fournisseur -> HLS local servi en HTTP.
// Lecture, enregistrement et restream se branchent tous dessus = 1 connexion totale.
async function startRelayInternal(url, name) {
  if (relay.proc) {
    // déjà actif (même chaîne) : on réutilise
    const ip = lanIp();
    return { local: LOCAL_URL, lan: `http://${ip}:${RELAY_PORT}/index.m3u8`, ip, port: RELAY_PORT, name, reused: true };
  }
  const dir = path.join(os.tmpdir(), 'iptv-relay');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  relay.dir = dir;
  relay.url = url;
  relay.stopping = false;
  relay.restarts = 0;

  spawnRelayFfmpeg();

  relay.server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(req.url.split('?')[0]) || 'index.m3u8');
    const ext = path.extname(file);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });

  // listen + gestion EADDRINUSE (port resté occupé par une instance précédente)
  await new Promise((resolve, reject) => {
    const onErr = (e) => { reject(e); };
    relay.server.once('error', onErr);
    relay.server.listen(RELAY_PORT, '0.0.0.0', () => {
      relay.server.removeListener('error', onErr);
      relay.server.on('error', (e) => notifyError('serveur relais : ' + e.message));
      resolve();
    });
  }).catch((e) => {
    // nettoie le ffmpeg lancé si le serveur n'a pas pu démarrer
    try { relay.proc && relay.proc.kill('SIGKILL'); } catch {}
    relay.proc = null; relay.server = null;
    throw new Error(e.code === 'EADDRINUSE'
      ? `Le port ${RELAY_PORT} est déjà utilisé. Fermez l'autre instance ou changez de chaîne, puis réessayez.`
      : e.message);
  });

  // attend l'apparition du 1er segment pour que les clients ne reçoivent pas de 404
  await waitForFile(path.join(dir, 'index.m3u8'), 12000);

  const ip = lanIp();
  return { local: LOCAL_URL, lan: `http://${ip}:${RELAY_PORT}/index.m3u8`, ip, port: RELAY_PORT, name };
}

function waitForFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

ipcMain.handle('relay-start', (e, { url, name }) => startRelayInternal(url, name));

ipcMain.handle('relay-stop', () => {
  // ne pas couper si un enregistrement est en cours sur le relais
  if (recordings.size === 0) { stopRelay(); stopTunnel(); }
  return { ok: true };
});

/* ---------- Tunnel public (Cloudflare, gratuit, sans compte) ---------- */
function cfAsset() {
  if (process.platform === 'win32') return { name: 'cloudflared-windows-amd64.exe', tgz: false };
  if (process.platform === 'darwin') return {
    name: process.arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz',
    tgz: true,
  };
  return { name: process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64', tgz: false };
}

// Les apps GUI macOS/Linux n'héritent pas du PATH du shell : on cherche
// cloudflared dans les emplacements d'installation courants (Homebrew, etc.).
function findSystemCloudflared() {
  const candidates = [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/bin/cloudflared',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u, redirects) => {
      if (redirects > 6) return reject(new Error('Trop de redirections'));
      https.get(u, { headers: { 'User-Agent': 'IPTV-Live' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return go(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    };
    go(url, 0);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(cmd + ' a échoué (code ' + code + ')')));
  });
}

async function ensureCloudflared() {
  const dir = app.getPath('userData');
  const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const exe = path.join(dir, exeName);

  // 1) binaire déjà téléchargé par l'app
  if (fs.existsSync(exe)) return exe;

  // 2) binaire installé sur le système (les apps GUI n'ont pas le PATH du shell)
  if (process.platform !== 'win32') {
    const sys = findSystemCloudflared();
    if (sys) return sys;
  }

  // 3) téléchargement du binaire officiel (extraction du .tgz sur macOS)
  const asset = cfAsset();
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.name}`;
  if (win && !win.isDestroyed()) win.webContents.send('tunnel-status', { msg: 'Téléchargement de cloudflared…' });

  if (asset.tgz) {
    const tgz = path.join(dir, 'cloudflared.tgz');
    await download(url, tgz);
    await run('tar', ['-xzf', tgz, '-C', dir]);   // l'archive contient le binaire « cloudflared »
    try { fs.unlinkSync(tgz); } catch {}
    if (!fs.existsSync(exe)) throw new Error('cloudflared introuvable après extraction');
    fs.chmodSync(exe, 0o755);
  } else {
    await download(url, exe);
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
  }
  return exe;
}

function stopTunnel() {
  if (tunnel.proc) { try { tunnel.proc.kill('SIGKILL'); } catch {} tunnel.proc = null; }
  tunnel.url = '';
  publishPointer('');   // efface le pointeur : le site n'affiche plus d'URL morte
}

ipcMain.handle('tunnel-start', async () => {
  stopTunnel();
  const bin = await ensureCloudflared();
  return new Promise((resolve, reject) => {
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${RELAY_PORT}`];
    const p = spawn(bin, args);
    tunnel.proc = p;
    let settled = false;
    const onData = (buf) => {
      const s = buf.toString();
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (m && !settled) {
        settled = true;
        tunnel.url = m[0];
        publishPointer(m[0] + '/index.m3u8');   // le site bascule automatiquement
        resolve({ url: m[0] });
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => {
      if (win && !win.isDestroyed()) win.webContents.send('tunnel-stopped', {});
      if (!settled) { settled = true; reject(new Error('cloudflared fermé sans URL')); }
    });
    p.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('Délai dépassé')); } }, 30000);
  });
});

ipcMain.handle('tunnel-stop', () => { stopTunnel(); return { ok: true }; });

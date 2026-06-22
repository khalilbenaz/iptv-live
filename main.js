const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

// Nom affiché dans la barre de menu macOS ("KTV", "Quitter KTV"…) — sinon
// Electron prend le "name" du package.json (iptv-live).
try { app.setName('KTV'); } catch {}

// Au démarrage : tue les ffmpeg orphelins d'une instance KTV précédente
// (relais/enregistrement laissés vivants après un crash ou un force-quit).
// Sans ça, l'orphelin garde la connexion fournisseur ouverte → la lecture
// live ouvre une 2e connexion et se fait couper (abonnement 1 connexion).
function killStrayFfmpeg() {
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/F', '/IM', 'ffmpeg.exe', '/FI', 'WINDOWTITLE eq iptv-relay*']); } catch {}
    return;
  }
  // Cible le relais KTV (dossier temp 'iptv-relay'), très spécifique.
  try { execFile('pkill', ['-9', '-f', 'iptv-relay']); } catch {}
}

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
const relay = { proc: null, server: null, dir: null, url: '', token: '', transcode: false, stopping: false, restarts: 0, restartTimer: null, stableTimer: null };
const tunnel = { proc: null, url: '' };

let ffmpegPath = require('ffmpeg-static');
// In packaged app the binary lives in app.asar.unpacked
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}

const recordings = new Map(); // id -> { proc, file }
const schedules = new Map();  // id -> { timer, url, name, startAt, durationSec }
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
    title: 'KTV',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.maximize();
  win.loadFile('index.html');
}

// ---------- Vérification de mise à jour (app non signée : on propose, on n'auto-installe pas) ----------
const REPO = 'khalilbenaz/ktv';
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
      if (!silent && win) dialog.showMessageBox(win, { type: 'info', message: 'KTV est à jour', detail: 'Version ' + app.getVersion(), buttons: ['OK'] });
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
// index = nom normalisé -> [{id,pl}] (candidats) ; byId = tvg-id minuscule -> pl ;
// byIdName = nom normalisé du tvg-id -> [{id,pl}]
const xmltv = { index: new Map(), byId: new Map(), byIdName: new Map(), names: new Map(), loadedAt: 0, loading: null };
let providerEpgUrl = '';   // EPG complet du fournisseur Xtream (xmltv.php), défini après connexion

const SUP_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';
// Lettres en exposant utilisées comme suffixes de qualité (ᴴᴰ, ᴿᴬᵂ, ʰᵉᵛᶜ…)
const SUP_LETTERS = { 'ᴴ':'h','ᴰ':'d','ᵁ':'u','ᴷ':'k','ᶠ':'f','ˢ':'s','ᴾ':'p','ᴿ':'r','ᴬ':'a','ᵂ':'w','ʰ':'h','ᵉ':'e','ᵛ':'v','ᶜ':'c','ᵖ':'p','ᵈ':'d','ᴺ':'n','ᴹ':'m','ᵃ':'a','ⁿ':'n','ᵗ':'t','ʜ':'h','ᴅ':'d' };
// Mots à ignorer : qualité, langue, codes pays/package — pour matcher les variantes
const XMLTV_NOISE = new Set(['hd','fhd','uhd','sd','4k','8k','hevc','h265','h264','raw','backup','vip','multi','full','plus','digital','mono','stereo','english','french','arabic','arabe','ar','en','fr','tr','hq','channel','tv','live','d','bk','lq','event','only','prime','fm','nm','ss','be','sa','us','uk','au','world','cup','stable','epl','f','direkte','exclusive','ppv','gold','next','new']);
const TOKEN_ALIASES = { sports: 'sport', sptv: 'sport', bn: 'bein', bsport: 'beinsport' };
function xmlNorm(s) {
  let x = String(s || '').replace(/⚽/g, 'o').replace(/◉/g, ' ');           // ballon stylisé = "o"
  x = x.split('').map((c) => SUP_LETTERS[c] || c).join('');                  // exposants -> lettres
  x = x.replace(/^[^:|]{1,12}[:|]\s*/, '');                                  // retire un préfixe "FR:" / "TR|"
  x = x.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (m) => SUP_DIGITS.indexOf(m));
  const k = x.split(/[^a-z0-9]+/)
    .map((t) => TOKEN_ALIASES[t] || t)
    .filter((t) => t && !XMLTV_NOISE.has(t)).join('');
  // "BEIN MAX 4" (fournisseur) == "beIN SPORTS MAX 4" (EPG) -> même clé
  return k.replace(/^beinmax(\d)/, 'beinsportmax$1');
}
// Indices de langue/pays trouvés dans le nom brut, pour départager les candidats
function ccHints(name) {
  const m = String(name || '').toLowerCase().match(/\b(fr|en|ar|tr|us|uk|au|be|sa|qa|de|es|it)\b/g);
  return new Set(m || []);
}
// Choisit le meilleur tvg-id parmi des candidats selon la langue de la chaîne
function pickCandidate(cands, name) {
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];
  const hints = ccHints(name);
  for (const c of cands) { const suf = c.id.split('.').pop().toLowerCase(); if (hints.has(suf)) return c; }
  for (const pref of ['fr', 'qa', 'tr']) { const c = cands.find((c) => c.id.toLowerCase().endsWith('.' + pref)); if (c) return c; }
  return cands[0];
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
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function fetchBuf(url, ua) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    mod.get(url, { headers: { 'User-Agent': ua || 'IPTV-Live' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return fetchBuf(new URL(r.headers.location, url).href, ua).then(resolve, reject); }
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
  const index = new Map();      // nom normalisé -> [{id,pl}]
  const byId = new Map();       // tvg-id minuscule -> pl
  const byIdName = new Map();   // nom normalisé du tvg-id -> [{id,pl}]
  const push = (map, k, id, pl) => { if (!k) return; if (!map.has(k)) map.set(k, []); if (!map.get(k).some((c) => c.id === id)) map.get(k).push({ id, pl }); };
  // tous les ids ayant des programmes (même sans bloc <channel>)
  const allIds = new Set([...names.keys(), ...progs.keys()]);
  for (const id of allIds) {
    const pl = progs.get(id);
    if (!pl || !pl.length) continue;
    pl.sort((a, b) => a.st - b.st);
    byId.set(id.toLowerCase(), pl);
    for (const n of (names.get(id) || [])) push(index, xmlNorm(n), id, pl);
    push(byIdName, xmlNorm(id.split('.')[0]), id, pl);
  }
  const nameById = new Map();      // tvg-id -> nom d'affichage (1er) ; pour la recherche EPG
  for (const [id, arr] of names) { if (arr && arr.length) nameById.set(id, arr[0]); }
  return { index, byId, byIdName, names: nameById };
}
function ensureXmltv() {
  if (getSettings().xmltvEnabled === false) return Promise.resolve();
  if ((xmltv.index.size || xmltv.byId.size) && Date.now() - xmltv.loadedAt < 6 * 3600 * 1000) return Promise.resolve();
  if (xmltv.loading) return xmltv.loading;
  // l'EPG du fournisseur en priorité (couvre tes chaînes exactes), puis les sources publiques
  const sources = [providerEpgUrl, ...(getSettings().xmltvSources || XMLTV_DEFAULT)].filter(Boolean);
  xmltv.loading = buildXmltv(sources)
    .then((r) => { if (r.index.size || r.byId.size) { xmltv.index = r.index; xmltv.byId = r.byId; xmltv.byIdName = r.byIdName; xmltv.names = r.names || new Map(); xmltv.loadedAt = Date.now(); } })
    .catch(() => {})
    .finally(() => { xmltv.loading = null; });
  return xmltv.loading;
}
/* ---------- EPG web "sport" via l'API KTV (Cloudflare Worker) ----------
   Secours pour les chaînes sport (beIN, Canal+, Eurosport…) non taguées par le
   fournisseur. Le Worker scrape/normalise les sources publiques côté serveur
   (corrigeable sans rebuild de l'app) et renvoie déjà des epochs UTC ;
   l'app affiche en heure LOCALE (ex. Maroc) → conversion automatique.
   Les clés de chaînes sont normalisées avec le MÊME algo que xmlNorm. */
const KTV_EPG_API = 'https://ktv-epg.khalilbenaz.workers.dev';
const webEpg = { index: new Map(), loadedAt: 0, loading: null };
async function buildWebEpg() {
  const data = JSON.parse((await fetchBuf(KTV_EPG_API + '/sport', BROWSER_UA)).toString('utf8'));
  const index = new Map();
  for (const [chan, list] of Object.entries(data.channels || {})) {
    if (Array.isArray(list) && list.length) index.set(chan, list);   // [{st,en,title}] (epoch UTC)
  }
  return index;
}
function ensureWebEpg() {
  if (getSettings().xmltvEnabled === false) return Promise.resolve();
  if (webEpg.index.size && Date.now() - webEpg.loadedAt < 30 * 60 * 1000) return Promise.resolve();
  if (webEpg.loading) return webEpg.loading;
  webEpg.loading = buildWebEpg()
    .then((idx) => { if (idx.size) { webEpg.index = idx; webEpg.loadedAt = Date.now(); } })
    .catch(() => {})
    .finally(() => { webEpg.loading = null; });
  return webEpg.loading;
}
// Repli flou : correspondance par préfixe/inclusion (ex: "beinsport1" ⊂ "beinsport1mena")
function fuzzyXmltvLookup(key, name) {
  if (!key || key.length < 5) return null;
  let cands = [], bestLen = Infinity;
  for (const [k, list] of xmltv.index) {
    if (k === key || k.startsWith(key) || key.startsWith(k)) {
      if (k.length < bestLen) { cands = list; bestLen = k.length; }
    }
  }
  const c = pickCandidate(cands, name);
  return c && c.pl;
}
// Résout les programmes d'une chaîne : tvg-id exact, puis nom normalisé, puis flou
function resolveEpg(name, tvgId) {
  const tid = String(tvgId || '').trim().toLowerCase();
  if (tid && xmltv.byId.has(tid)) return xmltv.byId.get(tid);
  const key = xmlNorm(name);
  if (!key) return null;
  let c = pickCandidate(xmltv.index.get(key), name) || pickCandidate(xmltv.byIdName.get(key), name);
  if (c) return c.pl;
  return fuzzyXmltvLookup(key, name) || webEpg.index.get(key) || null;
}
ipcMain.handle('epg-lookup', async (e, { name, tvgId } = {}) => {
  if (getSettings().xmltvEnabled === false) return null;
  await Promise.all([ensureXmltv(), ensureWebEpg()]);
  const pl = resolveEpg(name, tvgId);
  if (!pl) return null;
  const now = Date.now() / 1000;
  const cur = pl.find((p) => p.st <= now && now < p.en) || null;
  const next = pl.find((p) => p.st > now) || null;
  return { cur, next };
});
ipcMain.handle('set-provider-epg', (e, { url } = {}) => {
  if (url && url !== providerEpgUrl) {
    providerEpgUrl = url;
    xmltv.index = new Map(); xmltv.byId = new Map(); xmltv.byIdName = new Map(); xmltv.loadedAt = 0;   // forcera un rechargement incluant le fournisseur
    if (getSettings().xmltvEnabled !== false) ensureXmltv();
  }
  return { ok: true };
});
ipcMain.handle('xmltv-status', () => ({
  enabled: getSettings().xmltvEnabled !== false,
  channels: xmltv.byId.size || xmltv.index.size,
  loadedAt: xmltv.loadedAt,
  sources: getSettings().xmltvSources || XMLTV_DEFAULT,
}));
ipcMain.handle('xmltv-config', (e, { enabled, sources } = {}) => {
  const s = getSettings();
  if (enabled !== undefined) s.xmltvEnabled = enabled;
  if (Array.isArray(sources)) s.xmltvSources = sources.filter(Boolean);
  saveSettings();
  xmltv.index = new Map(); xmltv.byId = new Map(); xmltv.byIdName = new Map(); xmltv.loadedAt = 0;  // forcera un rechargement
  if (s.xmltvEnabled !== false) ensureXmltv();
  return { ok: true };
});

// Recherche dans l'EPG : renvoie les programmes (en cours / à venir) dont le
// titre contient la requête, tous canaux confondus (guide externe XMLTV).
ipcMain.handle('epg-search', async (e, { q, limit } = {}) => {
  if (getSettings().xmltvEnabled === false) return [];
  try { await ensureXmltv(); } catch {}
  const query = String(q || '').trim().toLowerCase();
  if (query.length < 2) return [];
  const cap = Math.min(Number(limit) || 60, 200);
  const now = Date.now() / 1000;
  const out = [];
  outer:
  for (const [id, pl] of xmltv.byId) {
    const name = xmltv.names.get(id) || id;
    for (const p of pl) {
      if ((p.en || p.st) < now) continue;          // déjà terminé
      if (p.title && p.title.toLowerCase().includes(query)) {
        out.push({ channel: name, title: p.title, st: p.st, en: p.en });
        if (out.length >= cap * 4) break outer;     // assez de candidats
      }
    }
  }
  out.sort((a, b) => a.st - b.st);
  return out.slice(0, cap);
});

// Récupère et décompresse une playlist M3U (sources multiples / fusion).
ipcMain.handle('m3u-fetch', async (e, { url } = {}) => {
  try {
    const buf = await fetchBuf(url, BROWSER_UA);
    const text = (/\.gz($|\?)/i.test(url) ? zlib.gunzipSync(buf) : buf).toString('utf8');
    return { ok: true, text };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// Ouvre une URL dans le navigateur par défaut (liaison Trakt, etc.).
ipcMain.handle('open-external', (e, { url } = {}) => {
  try { if (url) shell.openExternal(url); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});

app.whenReady().then(() => {
  killStrayFfmpeg();                              // libère la connexion d'un orphelin éventuel
  createWindow();
  setTimeout(() => checkForUpdates(true), 4000); // vérif discrète au démarrage
  setTimeout(() => { try { ensureXmltv(); } catch {} }, 6000); // précharge l'EPG externe
});
app.on('window-all-closed', () => {
  // stop everything
  for (const { proc } of recordings.values()) try { proc.kill('SIGKILL'); } catch {}
  for (const { timer } of schedules.values()) try { clearTimeout(timer); } catch {}
  schedules.clear();
  stopRelay();
  stopTunnel();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => {
  // Cmd+Q ne déclenche pas window-all-closed sur macOS → on nettoie ici aussi
  // pour ne PAS laisser d'ffmpeg orphelin garder la connexion fournisseur.
  for (const { proc } of recordings.values()) try { proc.kill('SIGKILL'); } catch {}
  for (const { timer } of schedules.values()) try { clearTimeout(timer); } catch {}
  schedules.clear();
  stopRelay();
  stopTunnel();
  killStrayFfmpeg();
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

// Dossier par défaut : racine du profil (NON surveillée par « Accès contrôlé
// aux dossiers » de Windows).
function defaultRecordingsDir() { return path.join(app.getPath('home'), 'IPTV Live Recordings'); }

// Crée le dossier si besoin et vérifie qu'il est accessible en écriture.
function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch { return false; }
}

// Dossier d'enregistrement : dossier choisi par l'utilisateur s'il existe et
// est accessible en écriture ; sinon repli automatique sur le dossier par
// défaut (cas du disque externe débranché ou du dossier supprimé). On NE
// supprime PAS la préférence : si le disque revient, on le réutilise.
function recordingsDir() {
  const s = getSettings();
  if (s.recDir && ensureWritableDir(s.recDir)) return s.recDir;
  const def = defaultRecordingsDir();
  ensureWritableDir(def);
  return def;
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

// ---------- Téléchargements (films / épisodes) ----------
function downloadsDir() {
  const s = getSettings();
  const dir = s.dlDir || path.join(app.getPath('home'), 'IPTV Live Downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function sendDl(channel, payload) { try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch {} }

const downloads = new Map(); // id -> { req, out, part, file, aborted, url }
let dlSeq = 0;

// File d'attente séquentielle : le fournisseur n'autorise qu'UNE seule
// connexion à la fois, donc on télécharge un épisode après l'autre.
const dlQueue = [];   // [id]
let dlActiveId = null;
function pumpQueue() {
  if (dlActiveId) return;
  let id;
  while ((id = dlQueue.shift())) {
    const entry = downloads.get(id);
    if (entry && !entry.aborted) break;   // ignore les annulés
    id = null;
  }
  if (!id) return;
  const entry = downloads.get(id);
  dlActiveId = id;
  httpDownload(id, entry.url, entry, 0);
}
// Appelé à chaque fin de téléchargement (succès, échec ou annulation) pour
// libérer la connexion et démarrer le suivant.
function jobDone(id) {
  if (dlActiveId === id) { dlActiveId = null; pumpQueue(); }
}

ipcMain.handle('downloads-dir', () => downloadsDir());
ipcMain.handle('open-downloads-dir', () => { shell.openPath(downloadsDir()); return { ok: true }; });
ipcMain.handle('list-downloads', () => {
  const dir = downloadsDir();
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => !f.startsWith('.') && !f.endsWith('.part'))
      .map((name) => { const p = path.join(dir, name); const st = fs.statSync(p); return { name, path: p, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
    return { dir, files };
  } catch { return { dir, files: [] }; }
});

ipcMain.handle('download-start', (e, { url, name, ext } = {}) => {
  const id = 'dl' + (++dlSeq);
  const safe = sanitize(name) + '.' + String(ext || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5);
  const file = path.join(downloadsDir(), safe);
  const part = file + '.part';
  const entry = { aborted: false, file, part, url };
  downloads.set(id, entry);
  dlQueue.push(id);
  // Position dans la file (0 = démarre tout de suite)
  const queued = dlActiveId ? dlQueue.length : 0;
  pumpQueue();
  return { id, file, name: safe, queued };
});

ipcMain.handle('download-cancel', (e, { id } = {}) => {
  const entry = downloads.get(id);
  if (entry) {
    entry.aborted = true;
    try { entry.req && entry.req.destroy(); } catch {}
    try { entry.out && entry.out.destroy(); } catch {}
    try { fs.unlinkSync(entry.part); } catch {}
    downloads.delete(id);
    jobDone(id);   // libère la connexion et lance le suivant
  }
  return { ok: true };
});

function httpDownload(id, url, entry, redirects) {
  const mod = url.startsWith('https') ? https : http;
  let req;
  try { req = mod.get(url, { headers: { 'User-Agent': 'IPTV-Live' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 10) {
      res.resume();
      return httpDownload(id, new URL(res.headers.location, url).href, entry, redirects + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      if (!entry.aborted) sendDl('download-done', { id, ok: false, error: 'HTTP ' + res.statusCode });
      downloads.delete(id);
      jobDone(id);
      return;
    }
    const total = Number(res.headers['content-length']) || 0;
    let received = 0, lastPct = -1;
    const out = fs.createWriteStream(entry.part);
    entry.out = out;
    res.on('data', (c) => {
      received += c.length;
      const pct = total ? Math.round(received / total * 100) : 0;
      if (pct !== lastPct) { lastPct = pct; sendDl('download-progress', { id, received, total, pct }); }
    });
    res.pipe(out);
    out.on('finish', () => out.close(() => {
      if (entry.aborted) { try { fs.unlinkSync(entry.part); } catch {} jobDone(id); return; }
      try { fs.renameSync(entry.part, entry.file); } catch (err) { sendDl('download-done', { id, ok: false, error: err.message }); downloads.delete(id); jobDone(id); return; }
      sendDl('download-done', { id, ok: true, file: entry.file });
      downloads.delete(id);
      jobDone(id);
    }));
  }); } catch (err) {
    sendDl('download-done', { id, ok: false, error: err.message });
    downloads.delete(id);
    jobDone(id);
    return;
  }
  entry.req = req;
  req.on('error', (err) => {
    if (entry.aborted) return;
    try { entry.out && entry.out.destroy(); } catch {}
    try { fs.unlinkSync(entry.part); } catch {}
    sendDl('download-done', { id, ok: false, error: err.message });
    downloads.delete(id);
    jobDone(id);
  });
}

// Start recording a stream URL with ffmpeg (stream copy -> mp4).
// durationSec > 0 => ffmpeg s'arrête tout seul après cette durée (auto-stop).
async function startRecordingInternal({ url, name, durationSec }) {
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

  const dur = Math.max(0, Math.floor(Number(durationSec) || 0));
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
  ];
  // Auto-stop : -t arrête proprement ffmpeg après `dur` secondes.
  if (dur > 0) args.push('-t', String(dur));
  args.push('-y', part);

  const proc = spawn(ffmpegPath, args);
  recordings.set(id, { proc, file, part, name, startedRelay, durationSec: dur });

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

  return { id, file, local: LOCAL_URL, startedRelay, durationSec: dur };
}

ipcMain.handle('record-start', async (e, { url, name, durationSec }) => {
  return startRecordingInternal({ url, name, durationSec });
});

/* ---------- Enregistrements programmés (planification + auto-stop) ---------- */
function scheduleSnapshot() {
  return [...schedules.entries()].map(([id, s]) => ({
    id, name: s.name, startAt: s.startAt, durationSec: s.durationSec,
  }));
}

// Programme un enregistrement : démarre à `startAt` (epoch ms) pour `durationSec`.
ipcMain.handle('schedule-add', (e, { url, name, startAt, durationSec }) => {
  const id = 'sch' + String(Date.now()) + Math.floor(Math.random() * 1000);
  const when = Math.max(0, Number(startAt) - Date.now());
  const dur = Math.max(0, Math.floor(Number(durationSec) || 0));

  const timer = setTimeout(async () => {
    schedules.delete(id);
    try {
      const rec = await startRecordingInternal({ url, name, durationSec: dur });
      if (win && !win.isDestroyed()) {
        win.webContents.send('schedule-fired', {
          scheduleId: id, id: rec.id, name, file: rec.file,
          local: rec.local, startedRelay: rec.startedRelay, durationSec: dur,
        });
      }
    } catch (err) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('schedule-error', { scheduleId: id, name, error: err.message });
      }
    }
  }, when);

  schedules.set(id, { timer, url, name, startAt: Number(startAt), durationSec: dur });
  return { id, startAt: Number(startAt), durationSec: dur, list: scheduleSnapshot() };
});

ipcMain.handle('schedule-list', () => scheduleSnapshot());

ipcMain.handle('schedule-cancel', (e, { id }) => {
  const s = schedules.get(id);
  if (s) { try { clearTimeout(s.timer); } catch {} schedules.delete(id); }
  return { ok: !!s, list: scheduleSnapshot() };
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
  return [...recordings.entries()].map(([id, r]) => {
    let size = 0;
    try { size = fs.statSync(r.part).size; } catch {}
    return { id, file: r.file, name: r.name, size, durationSec: r.durationSec || 0 };
  });
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
// Choisit (une seule fois) le meilleur encodeur H.264 disponible selon la
// plateforme/GPU : on teste chaque candidat par un mini-encodage et on garde
// le 1er qui marche. Repli logiciel libx264 garanti.
let chosenVcodec = null;
function detectEncoder() {
  if (chosenVcodec) return chosenVcodec;
  const candidates = process.platform === 'darwin'
    ? ['h264_videotoolbox']
    : process.platform === 'win32'
      ? ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']
      : ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'libx264'];
  for (const enc of candidates) {
    try {
      execFileSync(ffmpegPath, ['-hide_banner', '-f', 'lavfi', '-i',
        'testsrc=size=320x240:rate=10', '-t', '0.2', '-c:v', enc, '-f', 'null', '-'],
        { stdio: 'ignore', timeout: 8000 });
      chosenVcodec = enc; break;
    } catch {}
  }
  if (!chosenVcodec) chosenVcodec = 'libx264';
  return chosenVcodec;
}

// Décodage accéléré du flux d'entrée (HEVC 10 bits) selon la plateforme.
function decodeAccelArgs() {
  if (process.platform === 'darwin') return ['-hwaccel', 'videotoolbox'];
  return ['-hwaccel', 'auto'];     // d3d11va/cuda/qsv… ou logiciel en repli
}

// Arguments d'encodage vidéo selon l'encodeur retenu (≈ 20 Mbit/s, temps réel).
function transcodeVideoArgs() {
  const enc = detectEncoder();
  const base = ['-c:v', enc, '-pix_fmt', 'yuv420p'];
  switch (enc) {
    case 'h264_videotoolbox': return [...base, '-b:v', '20M', '-realtime', '1'];
    case 'h264_nvenc':        return [...base, '-preset', 'p4', '-tune', 'll', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M'];
    case 'h264_qsv':          return [...base, '-preset', 'veryfast', '-b:v', '20M', '-maxrate', '25M'];
    case 'h264_amf':          return [...base, '-quality', 'speed', '-b:v', '20M'];
    case 'h264_vaapi':        return [...base, '-b:v', '20M'];
    default:                  return [...base, '-preset', 'veryfast', '-b:v', '20M', '-maxrate', '25M', '-bufsize', '40M']; // libx264
  }
}

function spawnRelayFfmpeg() {
  const input = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'IPTV-Live',
    // résilience du flux montant (HTTP) : on ne lâche pas au moindre hoquet
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
  ];
  // Mode transcodage matériel (chaînes 4K que le lecteur ne décode pas) :
  // décodage + encodage H.264 accéléré par le GPU (VideoToolbox sur Mac,
  // NVENC/QSV/AMF sur Windows, sinon libx264 logiciel). Sinon copie.
  const codec = relay.transcode
    ? [...decodeAccelArgs(), '-i', relay.url, ...transcodeVideoArgs(), '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
    : ['-i', relay.url, '-c', 'copy'];
  const args = [
    ...input,
    ...codec,
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '10',          // ~20 s de flux dispo (était 8 ≈ 16 s)
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
async function startRelayInternal(url, name, opts = {}) {
  if (relay.proc) {
    // déjà actif (même chaîne) : on réutilise
    const ip = lanIp();
    return { local: LOCAL_URL, lan: `http://${ip}:${RELAY_PORT}/${relay.token}/index.m3u8`, ip, port: RELAY_PORT, name, reused: true };
  }
  // Token aléatoire par session : exigé pour tout accès non-loopback (LAN + tunnel).
  relay.token = crypto.randomBytes(16).toString('hex');
  relay.transcode = !!opts.transcode;
  const dir = path.join(os.tmpdir(), 'iptv-relay');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dir, { recursive: true });
  relay.dir = dir;
  relay.url = url;
  relay.stopping = false;
  relay.restarts = 0;

  spawnRelayFfmpeg();

  relay.server = http.createServer((req, res) => {
    // Loopback (lecture/enregistrement locaux) : libre. Tout le reste (LAN, tunnel)
    // doit présenter le token de session dans le chemin : /<token>/index.m3u8.
    // Les segments .ts héritent du token via la résolution d'URL relative HLS.
    const remote = req.socket.remoteAddress || '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    let reqPath = req.url.split('?')[0];
    const tokenPrefix = `/${relay.token}/`;
    if (reqPath.startsWith(tokenPrefix)) {
      reqPath = reqPath.slice(tokenPrefix.length - 1);   // garde le slash menant
    } else if (!isLoopback) {
      res.writeHead(403); res.end(); return;
    }
    const file = path.join(dir, path.basename(reqPath) || 'index.m3u8');
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
  return { local: LOCAL_URL, lan: `http://${ip}:${RELAY_PORT}/${relay.token}/index.m3u8`, ip, port: RELAY_PORT, name };
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

// Lecture 4K : on fait transiter la chaîne par le relais en transcodage matériel
// (HEVC 10 bits → H.264) car le lecteur ne décode pas ce format. Gère le switch.
ipcMain.handle('live-transcode-tune', async (e, { url, name }) => {
  try {
    if (relay.proc && relay.url === url && relay.transcode) {
      return { local: LOCAL_URL, reused: true };
    }
    if (relay.proc && (relay.url !== url || !relay.transcode)) {
      if (recordings.size > 0) return { error: "Un enregistrement est en cours." };
      stopRelay();
      await new Promise((r) => setTimeout(r, 500));
    }
    await startRelayInternal(url, name, { transcode: true });
    return { local: LOCAL_URL };
  } catch (err) {
    return { error: err.message };
  }
});

// Sonde rapide d'un flux : renvoie la VRAIE résolution vidéo (pour décider si
// une chaîne est réellement de l'UHD et mérite le transcodage). On tue ffmpeg
// dès que la ligne "Video: …WxH" est lue (~2-4 s). Ouvre 1 connexion le temps
// de la sonde puis la referme.
ipcMain.handle('probe-stream', (e, { url }) => new Promise((resolve) => {
  let buf = '';
  let p;
  try {
    p = spawn(ffmpegPath, ['-hide_banner', '-user_agent', 'IPTV-Live',
      '-analyzeduration', '3000000', '-probesize', '3000000', '-i', url]);
  } catch { return resolve({ error: true }); }
  const finish = () => {
    const m = buf.match(/Video:[^\n]*?(\d{3,5})x(\d{3,5})/);
    const codec = (buf.match(/Video:\s*([a-z0-9]+)/i) || [])[1] || '';
    const pix = (buf.match(/Video:[^\n]*?(yuv\w+)/i) || [])[1] || '';
    resolve(m ? { width: +m[1], height: +m[2], codec, pix } : { error: true });
  };
  const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 12000);
  p.stderr.on('data', (d) => {
    buf += d.toString();
    if (/Video:[^\n]*\d{3,5}x\d{3,5}/.test(buf)) { clearTimeout(t); try { p.kill('SIGKILL'); } catch {} }
  });
  p.on('close', () => { clearTimeout(t); finish(); });
  p.on('error', () => { clearTimeout(t); resolve({ error: true }); });
}));

// Arrête le relais s'il n'est plus utile (quitte une chaîne 4K / repasse en
// direct), sauf si un enregistrement ou un restream l'utilise encore.
ipcMain.handle('relay-stop-idle', () => {
  if (recordings.size === 0) { stopRelay(); stopTunnel(); return { stopped: true }; }
  return { stopped: false };
});

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
  if (!relay.proc || !relay.token) throw new Error('Démarrez le restream avant de créer un lien public.');
  stopTunnel();
  const bin = await ensureCloudflared();
  const streamPath = `/${relay.token}/index.m3u8`;   // chemin protégé par le token de session
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
        publishPointer(m[0] + streamPath);   // le site bascule automatiquement
        resolve({ url: m[0], stream: m[0] + streamPath });
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

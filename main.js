const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const RELAY_PORT = 4567;
const relay = { proc: null, server: null, dir: null };
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

app.whenReady().then(createWindow);
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
    '-f', 'mp4',
    '-movflags', '+faststart',
    '-y', file
  ];

  const proc = spawn(ffmpegPath, args);
  recordings.set(id, { proc, file, name, startedRelay });

  let errBuf = '';
  proc.on('error', (e) => { notifyError('ffmpeg (enregistrement) : ' + e.message); });
  proc.stderr.on('data', (d) => { errBuf += d.toString(); });
  proc.on('close', (code) => {
    const wasAuto = (recordings.get(id) || {}).startedRelay;
    recordings.delete(id);
    if (win && !win.isDestroyed()) {
      win.webContents.send('record-stopped', { id, file, code, startedRelay: wasAuto, error: errBuf.slice(-500) });
    }
  });

  return { id, file, local: LOCAL_URL, startedRelay };
});

ipcMain.handle('record-stop', (e, { id }) => {
  const rec = recordings.get(id);
  if (!rec) return { ok: false };
  // graceful: send 'q' then kill fallback
  try { rec.proc.stdin.write('q'); } catch {}
  setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch {} }, 1500);
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
  if (relay.proc) { try { relay.proc.kill('SIGKILL'); } catch {} relay.proc = null; }
  if (relay.server) { try { relay.server.close(); } catch {} relay.server = null; }
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

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', 'IPTV-Live',
    '-i', url,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '8',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8')
  ];
  relay.proc = spawn(ffmpegPath, args);
  relay.proc.on('error', (e) => { notifyError('ffmpeg (relais) : ' + e.message); });
  relay.proc.on('close', () => {
    relay.proc = null;
    if (win && !win.isDestroyed()) win.webContents.send('relay-stopped', {});
  });

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
function cfBinName() {
  if (process.platform === 'win32') return 'cloudflared-windows-amd64.exe';
  if (process.platform === 'darwin') return process.arch === 'arm64'
    ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  return 'cloudflared-linux-amd64';
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

async function ensureCloudflared() {
  // Windows seulement pour le binaire .exe direct ; mac/linux peuvent l'avoir dans le PATH
  const dir = app.getPath('userData');
  const exe = path.join(dir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(exe)) return exe;
  if (process.platform !== 'win32') {
    // tente le binaire système si présent
    return 'cloudflared';
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${cfBinName()}`;
  if (win && !win.isDestroyed()) win.webContents.send('tunnel-status', { msg: 'Téléchargement de cloudflared…' });
  await download(url, exe);
  return exe;
}

function stopTunnel() {
  if (tunnel.proc) { try { tunnel.proc.kill('SIGKILL'); } catch {} tunnel.proc = null; }
  tunnel.url = '';
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

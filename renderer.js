'use strict';

const $ = (id) => document.getElementById(id);

// Ne garder que : chaînes Françaises, Marocaines, beIN Sports Arabe
function categoryAllowed(name) {
  const n = (name || '').toUpperCase();
  if (n.startsWith('FR|')) return true;                              // France
  if (n.includes('MOROCCO') || name.includes('المغرب')) return true; // Maroc
  if (n.startsWith('AR|') && n.includes('BEIN SPORTS')) return true; // beIN Sports Arabe (pas TR)
  return false;
}

const state = {
  srv: '', usr: '', pwd: '',
  categories: [],
  channels: [],     // current category's streams
  allByCat: {},     // cache
  info: null,       // user_info + server_info from login
  current: null,    // current stream object
  player: null,     // hls or mpegts instance
  recId: null,      // active recording id
  recStart: 0,
  recTimer: null,
  recStartedRelay: false,
  relaying: false,
  relayLan: '',
  tunnelUrl: ''
};

/* ---------- Xtream API ---------- */
function apiBase() { return state.srv.replace(/\/+$/, ''); }

async function xtreamApi(params) {
  const url = `${apiBase()}/player_api.php?username=${encodeURIComponent(state.usr)}&password=${encodeURIComponent(state.pwd)}&${params}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Déduit la qualité depuis le nom (gère aussi les exposants Unicode ⁸ᴷ ᵁᴴᴰ …)
function detectQuality(name) {
  const n = name || '';
  const u = n.toUpperCase();
  if (u.includes('8K') || n.includes('⁸ᴷ')) return '8K';
  if (u.includes('4K') || u.includes('UHD') || n.includes('ᵁᴴᴰ') || n.includes('³⁸⁴⁰ᴾ') || u.includes('2160')) return '4K';
  if (u.includes('FHD') || u.includes('1080') || n.includes('ᶠᴴᴰ')) return 'FHD';
  if (u.includes('HD') || n.includes('ᴴᴰ') || u.includes('720')) return 'HD';
  if (u.includes('SD') || n.includes('ˢᴰ')) return 'SD';
  return '';
}

function streamUrl(id, ext) {
  return `${apiBase()}/live/${encodeURIComponent(state.usr)}/${encodeURIComponent(state.pwd)}/${id}.${ext}`;
}

/* ---------- Login ---------- */
async function connect() {
  const srv = $('srv').value.trim();
  const usr = $('usr').value.trim();
  const pwd = $('pwd').value.trim();
  const msg = $('loginMsg');
  msg.textContent = '';
  if (!srv || !usr || !pwd) { msg.textContent = 'Remplissez tous les champs.'; return; }

  let s = srv;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  state.srv = s; state.usr = usr; state.pwd = pwd;

  $('connectBtn').disabled = true;
  $('connectBtn').textContent = 'Connexion…';
  try {
    const info = await xtreamApi('');
    if (!info || !info.user_info || info.user_info.auth === 0) {
      throw new Error('Identifiants invalides');
    }
    state.info = info;
    localStorage.setItem('xtream', JSON.stringify({ srv: s, usr, pwd }));
    await loadCategories();
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
  } catch (e) {
    msg.textContent = 'Échec : ' + e.message;
  } finally {
    $('connectBtn').disabled = false;
    $('connectBtn').textContent = 'Se connecter';
  }
}

async function loadCategories() {
  const cats = await xtreamApi('action=get_live_categories');
  state.categories = (Array.isArray(cats) ? cats : []).filter(c => categoryAllowed(c.category_name));
  const sel = $('catSelect');
  sel.innerHTML = '';
  for (const c of state.categories) {
    const o = document.createElement('option');
    o.value = c.category_id;
    o.textContent = c.category_name;
    sel.appendChild(o);
  }
  const firstCat = state.categories[0] ? state.categories[0].category_id : null;
  if (!firstCat) return;
  sel.value = firstCat;
  await loadChannels(firstCat);
}

async function loadChannels(catId) {
  let list;
  if (catId === 'all') {
    if (!state.allByCat['all']) {
      list = await xtreamApi('action=get_live_streams');
      state.allByCat['all'] = Array.isArray(list) ? list : [];
    }
    list = state.allByCat['all'];
  } else {
    if (!state.allByCat[catId]) {
      list = await xtreamApi('action=get_live_streams&category_id=' + catId);
      state.allByCat[catId] = Array.isArray(list) ? list : [];
    }
    list = state.allByCat[catId];
  }
  state.channels = list;
  renderChannels();
}

function renderChannels() {
  const q = $('search').value.trim().toLowerCase();
  const qual = $('qualSelect').value;
  const ul = $('channels');
  ul.innerHTML = '';
  let items = state.channels;
  if (q) items = items.filter(c => (c.name || '').toLowerCase().includes(q));
  if (qual) items = items.filter(c => detectQuality(c.name) === qual);

  const frag = document.createDocumentFragment();
  for (const c of items.slice(0, 2000)) {
    const li = document.createElement('li');
    li.dataset.id = c.stream_id;
    if (state.current && state.current.stream_id === c.stream_id) li.classList.add('active');
    const img = document.createElement('img');
    img.src = c.stream_icon || '';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const span = document.createElement('span');
    span.textContent = c.name || ('Chaîne ' + c.stream_id);
    li.appendChild(img);
    li.appendChild(span);
    const tier = detectQuality(c.name);
    if (tier) {
      const b = document.createElement('span');
      b.className = 'badge q' + tier;
      b.textContent = tier;
      li.appendChild(b);
    }
    li.onclick = () => play(c);
    frag.appendChild(li);
  }
  ul.appendChild(frag);
}

/* ---------- Playback ---------- */
let suppressResume = false; // true pendant un arrêt volontaire (pour ne pas relancer)

function destroyPlayer() {
  suppressResume = true;
  const v = $('video');
  if (state.player) {
    try { state.player.destroy(); } catch {}
    state.player = null;
  }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
}

function play(channel) {
  state.current = channel;
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  $('overlay').classList.add('hidden');
  $('recBtn').disabled = false;
  $('relayBtn').disabled = false;
  // Changer de chaîne coupe un éventuel restream (1 seule connexion)
  if (state.relaying) stopRelay();
  // mark active
  document.querySelectorAll('#channels li').forEach(li => {
    li.classList.toggle('active', li.dataset.id == channel.stream_id);
  });

  destroyPlayer();
  const v = $('video');
  const tsUrl = streamUrl(channel.stream_id, 'ts');
  const hlsUrl = streamUrl(channel.stream_id, 'm3u8');

  // Prefer MPEG-TS (native Xtream live), fall back to HLS
  if (window.mpegts && mpegts.isSupported()) {
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: tsUrl },
      {
        enableWorker: true,
        // Lecture stable plutôt que basse latence : pas de saut/accélération
        liveBufferLatencyChasing: false,
        liveSync: false,
        lazyLoad: false,
        autoCleanupSourceBuffer: true,
        stashInitialSize: 1024 * 1024,   // pré-buffer ~1 Mo avant lecture
        enableStashBuffer: true
      }
    );
    p.attachMediaElement(v);
    p.load();
    suppressResume = false;
    p.play().catch(() => {});
    p.on(mpegts.Events.ERROR, () => playHls(hlsUrl));
    state.player = p;
  } else {
    playHls(hlsUrl);
  }
}

function playHls(url, retries = 6) {
  destroyPlayer();
  const v = $('video');
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 4, manifestLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800 });
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => { suppressResume = false; v.play().catch(() => {}); });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retries > 0) {
        // manifeste pas encore prêt (relais qui démarre) : on retente
        setTimeout(() => { if (state.player === hls) playHls(url, retries - 1); }, 1000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch {}
      }
    });
    state.player = hls;
  } else {
    v.src = url; // Safari native HLS
    suppressResume = false;
    v.play().catch(() => {});
  }
}

/* ---------- Recording ---------- */
async function toggleRecord() {
  const btn = $('recBtn');
  if (state.recId) {
    await window.api.recordStop(state.recId);
    // UI reset happens on record-stopped event, but reset button immediately
    stopRecUI();
  } else {
    if (!state.current) return;
    btn.disabled = true;
    btn.textContent = '⏺ Démarrage…';
    try {
      const url = streamUrl(state.current.stream_id, 'ts');
      const res = await window.api.recordStart(url, state.current.name);
      state.recId = res.id;
      state.recStartedRelay = res.startedRelay;
      state.recStart = Date.now();
      // L'enregistrement passe par le relais local : on y bascule aussi la lecture
      if (res.local && !state.relaying) { destroyPlayer(); playHls(res.local); }
      btn.classList.add('recording');
      btn.textContent = '⏹ Arrêter';
      $('recDot').classList.remove('hidden');
      state.recTimer = setInterval(updateRecTime, 1000);
      updateRecTime();
    } catch (e) {
      alert('Enregistrement impossible : ' + e.message);
      btn.textContent = '⏺ Enregistrer';
    } finally {
      btn.disabled = false;
    }
  }
}

// Reprend la lecture directe (1 connexion) sur la chaîne courante
function resumeDirect() {
  if (state.current) play(state.current);
}

function updateRecTime() {
  const s = Math.floor((Date.now() - state.recStart) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  $('recTime').textContent = `${mm}:${ss}`;
}

function stopRecUI() {
  state.recId = null;
  clearInterval(state.recTimer);
  const btn = $('recBtn');
  btn.classList.remove('recording');
  btn.textContent = '⏺ Enregistrer';
  $('recDot').classList.add('hidden');
}

/* ---------- Restream ---------- */
async function toggleRelay() {
  if (state.relaying) { stopRelay(); return; }
  if (!state.current) return;
  const btn = $('relayBtn');
  btn.disabled = true;
  btn.textContent = '📡 Démarrage…';
  try {
    const url = streamUrl(state.current.stream_id, 'ts');
    const r = await window.api.relayStart(url, state.current.name);
    state.relaying = true;
    state.relayLan = r.lan;
    // Basculer NOTRE lecture sur le relais local : 1 seule connexion fournisseur
    destroyPlayer();
    playHls(r.local);
    $('relayName').textContent = state.current.name || '—';
    $('relayLan').textContent = r.lan;
    $('relayModal').classList.remove('hidden');
    btn.classList.add('live');
    btn.textContent = '📡 Arrêter le restream';
  } catch (e) {
    alert('Restream impossible : ' + e.message);
    btn.textContent = '📡 Restreamer';
  } finally {
    btn.disabled = false;
  }
}

function stopRelay() {
  window.api.relayStop();
  state.relaying = false;
  state.tunnelUrl = '';
  const btn = $('relayBtn');
  btn.classList.remove('live');
  btn.textContent = '📡 Restreamer';
  $('relayModal').classList.add('hidden');
  resetTunnelUI();
}

function resetTunnelUI() {
  $('tunnelResult').classList.add('hidden');
  $('tunnelStatus').textContent = '';
  $('tunnelBtn').classList.remove('hidden');
  $('tunnelBtn').disabled = false;
  $('tunnelBtn').textContent = '🌍 Créer un lien public';
}

async function startTunnel() {
  const btn = $('tunnelBtn');
  btn.disabled = true;
  btn.textContent = 'Connexion…';
  $('tunnelStatus').textContent = '';
  try {
    const r = await window.api.tunnelStart();
    state.tunnelUrl = r.url + '/index.m3u8';
    $('tunnelUrl').textContent = state.tunnelUrl;
    $('tunnelResult').classList.remove('hidden');
    btn.classList.add('hidden');
  } catch (e) {
    $('tunnelStatus').textContent = 'Échec : ' + e.message;
    btn.disabled = false;
    btn.textContent = '🌍 Réessayer';
  }
}

/* ---------- Détails IPTV ---------- */
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  return isNaN(d) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function showInfo() {
  const i = state.info || {};
  const ui = i.user_info || {};
  const si = i.server_info || {};
  let recDir = '—';
  try { recDir = await window.api.getRecordingsDir(); } catch {}
  const rows = [
    ['Message', ui.message || '—'],
    ['Statut', ui.status || '—', ui.status === 'Active' ? 'ok' : 'bad'],
    ['Essai', ui.is_trial === '1' ? 'Oui' : 'Non'],
    ['Expiration', ui.exp_date ? fmtDate(ui.exp_date) : 'Illimité'],
    ['Connexions', `${ui.active_cons || 0} / ${ui.max_connections || '—'}`],
    ['Créé le', fmtDate(ui.created_at)],
    ['Formats', (ui.allowed_output_formats || []).join(', ') || '—'],
    ['Serveur', `${si.url || apiBase().replace(/^https?:\/\//, '')}${si.port ? ':' + si.port : ''}`],
    ['Fuseau', si.timezone || '—'],
    ['Utilisateur', state.usr]
  ];
  $('infoBody').innerHTML = rows.map(([k, v, cls]) =>
    `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`
  ).join('') +
    `<div class="row"><span class="k">Dossier d'enregistrement</span><span class="v" id="recDirVal">${recDir}</span></div>` +
    `<button id="pickDirBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);">📁 Changer le dossier…</button>`;
  $('pickDirBtn').onclick = async () => {
    const r = await window.api.pickRecordingsDir();
    if (r.error) { alert(r.error); return; }
    if (!r.canceled) $('recDirVal').textContent = r.dir;
  };
  $('infoModal').classList.remove('hidden');
}

/* ---------- Wire up ---------- */
window.addEventListener('DOMContentLoaded', () => {
  // restore creds
  try {
    const saved = JSON.parse(localStorage.getItem('xtream') || 'null');
    if (saved) { $('srv').value = saved.srv; $('usr').value = saved.usr; $('pwd').value = saved.pwd; }
  } catch {}

  // Live TV : un clic sur la vidéo ne doit pas mettre en pause -> on relance
  const vid = $('video');
  vid.addEventListener('pause', () => {
    if (suppressResume || vid.ended || !state.current) return;
    vid.play().catch(() => {});
  });

  $('connectBtn').onclick = connect;
  ['srv', 'usr', 'pwd'].forEach(id =>
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); }));

  $('catSelect').onchange = (e) => loadChannels(e.target.value);
  $('search').addEventListener('input', renderChannels);
  $('qualSelect').addEventListener('change', renderChannels);
  $('recBtn').onclick = toggleRecord;
  $('recFolderBtn').onclick = () => window.api.openRecordingsDir();
  $('toggleSidebar').onclick = () => $('app').classList.toggle('collapsed');
  $('infoBtn').onclick = showInfo;
  $('relayBtn').onclick = toggleRelay;
  $('relayClose').onclick = () => $('relayModal').classList.add('hidden');
  $('relayCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.relayLan); $('relayCopy').textContent = 'Copié ✓'; setTimeout(() => $('relayCopy').textContent = 'Copier le lien', 1500); } catch {}
  };
  window.api.onRelayStopped(() => { if (state.relaying) stopRelay(); });
  $('tunnelBtn').onclick = startTunnel;
  $('tunnelCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.tunnelUrl); $('tunnelCopy').textContent = 'Copié ✓'; setTimeout(() => $('tunnelCopy').textContent = 'Copier le lien public', 1500); } catch {}
  };
  window.api.onMainError((d) => { if (d && d.msg) console.error('main:', d.msg); });
  window.api.onTunnelStatus((d) => { $('tunnelStatus').textContent = d.msg || ''; });
  window.api.onTunnelStopped(() => { resetTunnelUI(); state.tunnelUrl = ''; });
  $('infoClose').onclick = () => $('infoModal').classList.add('hidden');
  $('infoModal').onclick = (e) => { if (e.target.id === 'infoModal') $('infoModal').classList.add('hidden'); };
  $('logoutBtn').onclick = () => {
    destroyPlayer();
    if (state.recId) window.api.recordStop(state.recId);
    if (state.relaying) stopRelay();
    stopRecUI();
    localStorage.removeItem('xtream');
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  };

  window.api.onRecordStopped((data) => {
    stopRecUI();
    // si le relais n'avait été lancé que pour enregistrer, on le coupe et on revient au direct
    if (data.startedRelay && !state.relaying) {
      window.api.relayStop();
      resumeDirect();
    }
  });
});

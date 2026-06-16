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
  tunnelUrl: '',
  favs: []          // chaînes favorites (objets {stream_id, name, stream_icon})
};

/* ---------- Favoris ---------- */
function loadFavs() {
  try { state.favs = JSON.parse(localStorage.getItem('iptv_favs') || '[]'); }
  catch { state.favs = []; }
}
function saveFavs() { try { localStorage.setItem('iptv_favs', JSON.stringify(state.favs)); } catch {} }
function isFav(id) { return state.favs.some((f) => f.stream_id == id); }
function toggleFav(ch) {
  if (isFav(ch.stream_id)) state.favs = state.favs.filter((f) => f.stream_id != ch.stream_id);
  else state.favs.push({ stream_id: ch.stream_id, name: ch.name, stream_icon: ch.stream_icon || '', category_id: ch.category_id });
  saveFavs();
  // rafraîchit le compteur dans le sélecteur + la liste si on est sur Favoris
  const opt = $('catSelect').querySelector('option[value="favs"]');
  if (opt) opt.textContent = `★ Favoris (${state.favs.length})`;
}

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
  const favOpt = document.createElement('option');
  favOpt.value = 'favs';
  favOpt.textContent = `★ Favoris (${state.favs.length})`;
  sel.appendChild(favOpt);
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
  if (catId === 'favs') {
    state.channels = state.favs;
    renderChannels();
    return;
  }
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
    const star = document.createElement('button');
    star.className = 'fav-btn' + (isFav(c.stream_id) ? ' on' : '');
    star.textContent = isFav(c.stream_id) ? '★' : '☆';
    star.title = 'Favori';
    star.onclick = (ev) => {
      ev.stopPropagation();
      toggleFav(c);
      const on = isFav(c.stream_id);
      star.classList.toggle('on', on);
      star.textContent = on ? '★' : '☆';
      if ($('catSelect').value === 'favs') loadChannels('favs'); // retire de la liste
    };
    li.appendChild(star);
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

// Décode un texte EPG (base64 -> UTF-8)
function decodeEpg(b64) {
  try { return decodeURIComponent(escape(atob(b64 || ''))).trim(); }
  catch { try { return atob(b64 || ''); } catch { return ''; } }
}

// Récupère le programme en cours / suivant pour la chaîne et l'affiche dans la barre
let epgReq = 0;
async function loadEpg(streamId) {
  const el = $('nowEpg');
  el.textContent = '';
  const my = ++epgReq;
  try {
    const data = await xtreamApi('action=get_short_epg&stream_id=' + streamId + '&limit=6');
    if (my !== epgReq) return; // une autre chaîne a été sélectionnée entre-temps
    const items = (((data && data.epg_listings) || [])
      .map((x) => ({ title: decodeEpg(x.title), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st)
      .sort((a, b) => a.st - b.st));
    if (!items.length) return;
    const now = Date.now() / 1000;
    const t = (s) => { const d = new Date(s * 1000); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    const cur = items.find((p) => p.st <= now && now < p.en);
    const nxt = items.find((p) => p.st > now);
    let txt = cur ? `🔴 ${t(cur.st)} ${cur.title}` : '';
    if (nxt) txt += `${txt ? '   ·   ' : ''}⏭ ${t(nxt.st)} ${nxt.title}`;
    el.textContent = txt;
  } catch { /* EPG indisponible : on ignore */ }
}

/* ---------- Guide des programmes (grille EPG) ---------- */
const EPG_MAX = 300;            // limite de chaînes scannées (perf)
let epgGuideToken = 0;

async function openEpgGuide() {
  $('epgModal').classList.remove('hidden');
  await buildEpgGuide();
}

async function buildEpgGuide() {
  const token = ++epgGuideToken;
  const ul = $('epgList');
  const all = state.channels || [];
  const list = all.slice(0, EPG_MAX);
  $('epgHint').textContent = all.length > EPG_MAX
    ? `${EPG_MAX} premières chaînes sur ${all.length} (affine la catégorie/recherche)`
    : `${all.length} chaîne(s)`;
  ul.innerHTML = '';

  // crée les lignes (EPG "chargement…"), puis remplit en parallèle limité
  const rows = list.map((c) => {
    const li = document.createElement('li');
    li.className = 'epg-item';
    li.dataset.name = (c.name || '').toLowerCase();
    li.innerHTML =
      `<img src="${escapeHtml(c.stream_icon || '')}">` +
      `<div class="epg-col"><span class="epg-ch">${escapeHtml(c.name || ('Chaîne ' + c.stream_id))}</span>` +
      `<span class="epg-now">…</span>` +
      `<div class="epg-bar"><i></i></div>` +
      `<span class="epg-next"></span></div>`;
    const im = li.querySelector('img');
    im.onerror = () => { im.style.visibility = 'hidden'; };
    li.onclick = () => { play(c); $('epgModal').classList.add('hidden'); };
    ul.appendChild(li);
    return { c, li };
  });
  if (!rows.length) { ul.innerHTML = '<li class="rec-empty">Aucune chaîne dans cette sélection.</li>'; return; }

  // pool de concurrence
  let idx = 0;
  const worker = async () => {
    while (idx < rows.length) {
      if (token !== epgGuideToken) return; // guide fermé/rafraîchi
      const { c, li } = rows[idx++];
      await fillEpgRow(c, li);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function fillEpgRow(c, li) {
  const nowEl = li.querySelector('.epg-now');
  const nextEl = li.querySelector('.epg-next');
  const bar = li.querySelector('.epg-bar');
  const fill = li.querySelector('.epg-bar i');
  try {
    const data = await xtreamApi('action=get_short_epg&stream_id=' + c.stream_id + '&limit=6');
    const items = (((data && data.epg_listings) || [])
      .map((x) => ({ title: decodeEpg(x.title), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st)
      .sort((a, b) => a.st - b.st));
    if (!items.length) { nowEl.textContent = 'Pas de programme'; nowEl.classList.add('muted'); bar.style.display = 'none'; return; }
    const now = Date.now() / 1000;
    const t = (s) => { const d = new Date(s * 1000); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    const cur = items.find((p) => p.st <= now && now < p.en);
    const nxt = items.find((p) => p.st > now);   // 1er programme à venir

    if (cur) {
      nowEl.textContent = `${t(cur.st)} ${cur.title}`;
      if (cur.en > cur.st) { fill.style.width = Math.round(((now - cur.st) / (cur.en - cur.st)) * 100) + '%'; }
      else bar.style.display = 'none';
    } else {
      nowEl.textContent = 'Hors programme'; nowEl.classList.add('muted'); bar.style.display = 'none';
    }
    nextEl.textContent = nxt ? `⏭ ${t(nxt.st)} ${nxt.title}` : '';
  } catch {
    nowEl.textContent = 'EPG indisponible'; nowEl.classList.add('muted'); bar.style.display = 'none';
  }
}

function play(channel) {
  state.current = channel;
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  loadEpg(channel.stream_id);
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
    `<button id="pickDirBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);">📁 Changer le dossier…</button>` +
    `<button id="updBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);margin-top:8px;">🔄 Vérifier les mises à jour</button>`;
  $('pickDirBtn').onclick = async () => {
    const r = await window.api.pickRecordingsDir();
    if (r.error) { alert(r.error); return; }
    if (!r.canceled) $('recDirVal').textContent = r.dir;
  };
  $('updBtn').onclick = () => window.api.checkUpdate();
  $('infoModal').classList.remove('hidden');
}

/* ---------- Wire up ---------- */
window.addEventListener('DOMContentLoaded', () => {
  loadFavs();
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
  $('recFolderBtn').onclick = openRecModal;
  $('recModalClose').onclick = () => $('recModal').classList.add('hidden');
  $('recOpenFolder').onclick = () => window.api.openRecordingsDir();
  $('recExportAll').onclick = exportAllWhatsapp;
  $('recFilter').onchange = (e) => { recView.channel = e.target.value; recView.page = 1; renderRecPage(); };
  $('recSearch').addEventListener('input', (e) => { recView.q = e.target.value; recView.page = 1; renderRecPage(); });
  $('toggleSidebar').onclick = () => $('app').classList.toggle('collapsed');
  $('infoBtn').onclick = showInfo;
  $('guideBtn').onclick = openEpgGuide;
  $('epgClose').onclick = () => { epgGuideToken++; $('epgModal').classList.add('hidden'); };
  $('epgModal').onclick = (e) => { if (e.target.id === 'epgModal') { epgGuideToken++; $('epgModal').classList.add('hidden'); } };
  $('epgRefresh').onclick = buildEpgGuide;
  $('epgSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#epgList .epg-item').forEach((li) => {
      li.style.display = (!q || li.dataset.name.includes(q)) ? '' : 'none';
    });
  });
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
    // mémorise le dernier fichier et propose l'export WhatsApp
    if (data.file) {
      state.lastRecFile = data.file;
      if (confirm('Enregistrement terminé.\n\nL\'exporter maintenant pour WhatsApp (son garanti + 30 fps) ?')) {
        exportWhatsapp(data.file);
      }
    }
  });
});

// Convertit un fichier en MP4 compatible WhatsApp. `btn` optionnel = feedback visuel.
async function exportWhatsapp(file, btn) {
  const old = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const r = await window.api.exportWhatsapp(file || null);
    if (r && r.ok) { if (btn) btn.textContent = '✓'; }
    else if (r && r.canceled) { if (btn) btn.textContent = old; }
    else { alert('Export WhatsApp échoué : ' + ((r && r.error) || 'inconnu')); if (btn) btn.textContent = old; }
    return r;
  } catch (e) {
    alert('Export WhatsApp échoué : ' + e.message); if (btn) btn.textContent = old;
  } finally {
    if (btn) setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2000);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Menu "Mes enregistrements" ----------
const recView = { all: [], page: 1, perPage: 8, channel: '', q: '' };

// Déduit le nom de chaîne à partir du nom de fichier "<chaîne>_<date>(_whatsapp).mp4"
function channelOf(name) {
  let s = name.replace(/\.[^.]+$/, '');
  s = s.replace(/_whatsapp$/i, '');
  s = s.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, '');
  return s || name;
}

async function openRecModal() {
  $('recModal').classList.remove('hidden');
  await loadRecordings();
}

async function loadRecordings() {
  const ul = $('recList');
  ul.innerHTML = '<li class="rec-empty">Chargement…</li>';
  let data;
  try { data = await window.api.listRecordings(); }
  catch (e) { ul.innerHTML = '<li class="rec-empty">Erreur de lecture du dossier</li>'; return; }
  $('recDirHint').textContent = data.dir;
  recView.all = (data.files || []).map((f) => ({ ...f, channel: channelOf(f.name) }));

  // remplit le filtre par chaîne (en conservant la sélection courante)
  const channels = [...new Set(recView.all.map((f) => f.channel))].sort((a, b) => a.localeCompare(b));
  const sel = $('recFilter');
  const prev = recView.channel;
  sel.innerHTML = `<option value="">Toutes les chaînes (${recView.all.length})</option>` +
    channels.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = channels.includes(prev) ? prev : '';
  recView.channel = sel.value;
  recView.page = 1;
  renderRecPage();
}

function filteredRecordings() {
  const q = recView.q.trim().toLowerCase();
  return recView.all.filter((f) =>
    (!recView.channel || f.channel === recView.channel) &&
    (!q || f.name.toLowerCase().includes(q))
  );
}

function renderRecPage() {
  const ul = $('recList');
  const list = filteredRecordings();
  const pages = Math.max(1, Math.ceil(list.length / recView.perPage));
  if (recView.page > pages) recView.page = pages;
  const start = (recView.page - 1) * recView.perPage;
  const slice = list.slice(start, start + recView.perPage);

  ul.innerHTML = '';
  if (!slice.length) {
    ul.innerHTML = '<li class="rec-empty">Aucun enregistrement.</li>';
  } else {
    slice.forEach((f) => ul.appendChild(recRow(f)));
  }

  // pagination
  const pager = $('recPager');
  if (list.length <= recView.perPage) { pager.innerHTML = ''; return; }
  pager.innerHTML = '';
  const prevB = document.createElement('button');
  prevB.className = 'ghost'; prevB.textContent = '‹'; prevB.disabled = recView.page <= 1;
  prevB.onclick = () => { recView.page--; renderRecPage(); };
  const label = document.createElement('span');
  label.className = 'rec-pageinfo';
  label.textContent = `Page ${recView.page} / ${pages} · ${list.length} fichiers`;
  const nextB = document.createElement('button');
  nextB.className = 'ghost'; nextB.textContent = '›'; nextB.disabled = recView.page >= pages;
  nextB.onclick = () => { recView.page++; renderRecPage(); };
  pager.append(prevB, label, nextB);
}

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, '0'), sss = String(ss).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${sss}` : `${m}:${sss}`;
}

function recRow(f) {
  const mb = (f.size / 1048576).toFixed(1);
  const d = new Date(f.mtime);
  const date = isNaN(d.getTime()) ? '' : d.toLocaleString();
  const dur = fmtDuration(f.duration);
  const li = document.createElement('li');
  li.className = 'rec-item';
  li.innerHTML =
    `<div class="rec-meta"><span class="rec-name">${f.isWhatsapp ? '📱 ' : ''}${escapeHtml(f.name)}</span>` +
    `<span class="rec-sub">${dur ? '⏱ ' + dur + ' · ' : ''}${mb} Mo · ${date}</span></div>`;
  const actions = document.createElement('div');
  actions.className = 'rec-actions';

  const playB = document.createElement('button');
  playB.className = 'ghost'; playB.textContent = '▶️'; playB.title = 'Lire';
  playB.onclick = () => window.api.openFile(f.path);
  actions.appendChild(playB);

  if (!f.isWhatsapp) {
    const waB = document.createElement('button');
    waB.className = 'ghost'; waB.textContent = '📱'; waB.title = 'Exporter pour WhatsApp (son + 30 fps)';
    waB.onclick = async () => { const r = await exportWhatsapp(f.path, waB); if (r && r.ok) loadRecordings(); };
    actions.appendChild(waB);
  }

  const revB = document.createElement('button');
  revB.className = 'ghost'; revB.textContent = '📁'; revB.title = 'Révéler dans le Finder';
  revB.onclick = () => window.api.revealFile(f.path);
  actions.appendChild(revB);

  const delB = document.createElement('button');
  delB.className = 'ghost danger'; delB.textContent = '🗑'; delB.title = 'Supprimer';
  delB.onclick = async () => {
    if (!confirm('Supprimer définitivement :\n\n' + f.name + ' ?')) return;
    const r = await window.api.deleteRecording(f.path);
    if (r && r.ok) loadRecordings();
    else alert('Suppression impossible : ' + ((r && r.error) || 'inconnu'));
  };
  actions.appendChild(delB);

  li.appendChild(actions);
  return li;
}

// Convertit tous les fichiers filtrés (non déjà WhatsApp) à la suite
async function exportAllWhatsapp() {
  const targets = filteredRecordings().filter((f) => !f.isWhatsapp);
  if (!targets.length) { alert('Rien à convertir (déjà fait ou aucun fichier).'); return; }
  if (!confirm(`Convertir ${targets.length} fichier(s) pour WhatsApp ?\nCela peut prendre un moment.`)) return;
  const btn = $('recExportAll');
  const old = btn.textContent; btn.disabled = true;
  let done = 0;
  for (const f of targets) {
    btn.textContent = `📱 Conversion ${++done}/${targets.length}…`;
    try { await window.api.exportWhatsapp(f.path); } catch {}
  }
  btn.textContent = '✓ Terminé'; btn.disabled = false;
  await loadRecordings();
  setTimeout(() => { btn.textContent = old; }, 2500);
}

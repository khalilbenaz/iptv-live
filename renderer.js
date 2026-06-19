'use strict';

const $ = (id) => document.getElementById(id);
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Ne garder que : chaînes Françaises, Marocaines, beIN Sports Arabe (LIVE uniquement)
function categoryAllowed(name) {
  const n = (name || '').toUpperCase();
  if (n.startsWith('FR|')) return true;                              // France
  if (n.includes('MOROCCO') || name.includes('المغرب')) return true; // Maroc
  if (n.startsWith('AR|') && n.includes('BEIN SPORTS')) return true; // beIN Sports Arabe (pas TR)
  return false;
}

// Films / séries : ne garder que les catégories françaises
function frCategoryAllowed(name) {
  const n = (name || '').toUpperCase().trim();
  return n.startsWith('FR|') || n.startsWith('FR ') || n.startsWith('FR-') || n.startsWith('FR_') || n === 'FR'
    || n.includes('FRANCE') || n.includes('FRENCH') || n.includes('FRANÇAIS') || n.includes('VOSTFR') || n.includes('TRUEFRENCH');
}

// Détecte les fausses entrées (séparateurs "###", titres de section, symboles seuls)
function isJunkChannel(c) {
  const n = (c && c.name || '').trim();
  if (!n) return true;
  if (n.includes('##') || n.includes('===') || n.includes('▬') || n.includes('●●')) return true;
  if (!/[A-Za-z0-9À-ÿ؀-ۿ]/.test(n)) return true; // que des symboles
  return false;
}

const state = {
  srv: '', usr: '', pwd: '',
  categories: [],
  channels: [],     // current category's streams
  allByCat: {},     // cache live par catégorie
  info: null,
  current: null,    // contenu live courant
  player: null,
  recId: null,
  recStart: 0,
  recTimer: null,
  recDuration: 0,
  recLocal: '',          // URL HLS locale du relais pendant un enregistrement
  recChannelName: '',    // nom de la chaîne en cours d'enregistrement
  recStartedRelay: false,
  relaying: false,
  relayLan: '',
  tunnelUrl: '',
  favs: [],         // chaînes favorites {stream_id, name, stream_icon}
  recent: [],       // vu récemment
  // navigation
  view: 'home',     // vue affichée
  browse: 'home',   // dernière vue de navigation (pour le retour depuis le lecteur)
  // VOD / séries
  vod: null, vodCats: [],
  series: null, seriesCats: [],
  // caches EPG (cartes live + guide)
  epgCache: {}
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
}

/* ---------- Vu récemment ---------- */
function loadRecent() {
  try { state.recent = JSON.parse(localStorage.getItem('iptv_recent') || '[]'); }
  catch { state.recent = []; }
}
function saveRecent() { try { localStorage.setItem('iptv_recent', JSON.stringify(state.recent.slice(0, 24))); } catch {} }
function pushRecent(item) {
  state.recent = state.recent.filter((r) => !(r.type === item.type && r.id == item.id));
  state.recent.unshift(item);
  state.recent = state.recent.slice(0, 24);
  saveRecent();
}

/* ---------- Xtream API ---------- */
function apiBase() { return state.srv.replace(/\/+$/, ''); }

async function xtreamApi(params) {
  const url = `${apiBase()}/player_api.php?username=${encodeURIComponent(state.usr)}&password=${encodeURIComponent(state.pwd)}&${params}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

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
function vodUrl(id, ext) {
  return `${apiBase()}/movie/${encodeURIComponent(state.usr)}/${encodeURIComponent(state.pwd)}/${id}.${ext || 'mp4'}`;
}
function seriesUrl(id, ext) {
  return `${apiBase()}/series/${encodeURIComponent(state.usr)}/${encodeURIComponent(state.pwd)}/${id}.${ext || 'mp4'}`;
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
    if (!info || !info.user_info || info.user_info.auth === 0) throw new Error('Identifiants invalides');
    state.info = info;
    localStorage.setItem('xtream', JSON.stringify({ srv: s, usr, pwd }));
    try {
      window.api.setProviderEpg(`${apiBase()}/xmltv.php?username=${encodeURIComponent(usr)}&password=${encodeURIComponent(pwd)}`);
    } catch {}
    await loadCategories();
    updateAcctChip();
    buildHome();
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    showView('home');
  } catch (e) {
    msg.textContent = 'Échec : ' + e.message;
  } finally {
    $('connectBtn').disabled = false;
    $('connectBtn').textContent = 'Se connecter';
  }
}

function updateAcctChip() {
  const ui = (state.info && state.info.user_info) || {};
  if (ui.status && ui.status !== 'Active') { $('acctTxt').textContent = ui.status; return; }
  const exp = ui.exp_date ? `expire le ${fmtDate(ui.exp_date)}` : 'illimité';
  $('acctTxt').textContent = `Compte actif · ${exp}`;
}

async function loadCategories() {
  const cats = await xtreamApi('action=get_live_categories');
  state.categories = (Array.isArray(cats) ? cats : []).filter((c) => categoryAllowed(c.category_name));
  fillCatSelect($('catSelect'), true);
  fillCatSelect($('guideCat'), false);
}

// Remplit un <select> de catégories live. withFav = ajoute l'entrée Favoris.
function fillCatSelect(sel, withFav) {
  sel.innerHTML = '';
  if (withFav) {
    const o = document.createElement('option');
    o.value = 'favs'; o.textContent = `★ Favoris (${state.favs.length})`;
    sel.appendChild(o);
  }
  for (const c of state.categories) {
    const o = document.createElement('option');
    o.value = c.category_id; o.textContent = c.category_name;
    sel.appendChild(o);
  }
}

/* ---------- Routeur de vues ---------- */
function showView(name) {
  const leaving = state.view;
  state.view = name;
  // Quitter le lecteur coupe la lecture (sinon le son continue en arrière-plan)
  if (leaving === 'player' && name !== 'player') {
    destroyPlayer();
    state.current = null;
    state.playQueue = null;
    $('overlay').classList.remove('hidden');
    $('overlay').textContent = 'Sélectionnez un contenu';
  }
  if (name !== 'player') {
    state.browse = name;
    document.querySelectorAll('.rail .nav').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('search').value = '';
  }
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  // chargement paresseux par section
  if (name === 'live') ensureLive();
  else if (name === 'movies') ensureVod();
  else if (name === 'series') ensureSeries();
  else if (name === 'guide') ensureGuide();
  else if (name === 'recordings') loadRecordings();
  else if (name === 'settings') buildSettings();
}

function onSearch() {
  if (state.view === 'live') renderLiveGrid();
  else if (state.view === 'movies') renderMovies();
  else if (state.view === 'series') renderSeries();
}

/* ---------- LIVE ---------- */
async function ensureLive() {
  if (!state.categories.length) return;
  const cat = $('catSelect').value || state.categories[0].category_id;
  $('catSelect').value = cat;
  if (state.curLiveCat === cat) { renderLiveGrid(); return; }
  await loadChannels(cat);
}

async function loadChannels(catId) {
  let list;
  if (catId === 'favs') { state.channels = state.favs; state.curLiveCat = 'favs'; renderLiveGrid(); return; }
  if (!state.allByCat[catId]) {
    list = await xtreamApi('action=get_live_streams&category_id=' + catId);
    state.allByCat[catId] = Array.isArray(list) ? list : [];
  }
  state.channels = state.allByCat[catId];
  state.curLiveCat = catId;
  renderLiveGrid();
}

function filteredChannels() {
  const q = $('search').value.trim().toLowerCase();
  const qual = $('qualSelect').value;
  let items = state.channels.filter((c) => !isJunkChannel(c));
  if (q) items = items.filter((c) => (c.name || '').toLowerCase().includes(q));
  if (qual) items = items.filter((c) => detectQuality(c.name) === qual);
  return items;
}

function renderLiveGrid() {
  const grid = $('liveGrid');
  const items = filteredChannels();
  $('liveCount').textContent = `${items.length} chaîne(s)`;
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const c of items.slice(0, 1500)) frag.appendChild(channelCard(c, true));
  grid.appendChild(frag);
  observeEpgCards();
}

// Carte chaîne (live grid + accueil). epgLazy = charger EPG quand visible.
function channelCard(c, epgLazy) {
  const card = document.createElement('div');
  card.className = 'chan-card';
  card.dataset.id = c.stream_id;
  if (state.current && state.current.stream_id == c.stream_id) card.classList.add('active');

  const head = document.createElement('div');
  head.className = 'cc-head';
  const lg = document.createElement('div');
  lg.className = 'cc-logo';
  if (c.stream_icon) {
    const img = document.createElement('img');
    img.src = c.stream_icon; img.loading = 'lazy';
    img.onerror = () => { lg.textContent = initials(c.name); };
    lg.appendChild(img);
  } else lg.textContent = initials(c.name);
  head.appendChild(lg);

  const meta = document.createElement('div');
  meta.className = 'cc-meta';
  const nm = document.createElement('div');
  nm.className = 'cc-name'; nm.textContent = c.name || ('Chaîne ' + c.stream_id);
  meta.appendChild(nm);
  const tier = detectQuality(c.name);
  const sub = document.createElement('div');
  sub.className = 'cc-sub';
  sub.innerHTML = `<span class="live-dot">● EN DIRECT</span>${tier ? ` · <span class="qtag q${tier}">${tier}</span>` : ''}`;
  meta.appendChild(sub);
  head.appendChild(meta);

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
    const opt = $('catSelect').querySelector('option[value="favs"]');
    if (opt) opt.textContent = `★ Favoris (${state.favs.length})`;
    if (state.view === 'live' && $('catSelect').value === 'favs') loadChannels('favs');
  };
  head.appendChild(star);
  card.appendChild(head);

  const now = document.createElement('div');
  now.className = 'cc-now'; now.dataset.epg = c.stream_id;
  card.appendChild(now);

  card.onclick = () => play(c);
  if (epgLazy) card.dataset.lazyepg = '1';
  return card;
}

function initials(name) {
  return (name || '?').replace(/[^A-Za-z0-9À-ÿ ]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

// IntersectionObserver pour charger l'EPG des cartes visibles
let epgObserver = null;
function observeEpgCards() {
  if (!('IntersectionObserver' in window)) return;
  if (!epgObserver) {
    epgObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const card = e.target;
        epgObserver.unobserve(card);
        fillCardEpg(card);
      }
    }, { rootMargin: '120px' });
  }
  document.querySelectorAll('.chan-card[data-lazyepg]').forEach((card) => {
    card.removeAttribute('data-lazyepg');
    epgObserver.observe(card);
  });
}

async function fillCardEpg(card) {
  const id = card.dataset.id;
  const slot = card.querySelector('.cc-now');
  if (!slot) return;
  const ch = (state.channels || []).find((c) => c.stream_id == id) || { stream_id: id };
  const e = await getChannelEpg(ch);
  if (!e || (!e.cur && !e.next)) return;
  if (e.cur) {
    slot.innerHTML = `<span class="cc-prog">▶ ${escapeHtml(e.cur.title)}</span>`;
    if (e.cur.en > e.cur.st) {
      const pct = Math.max(0, Math.min(100, Math.round(((Date.now() / 1000 - e.cur.st) / (e.cur.en - e.cur.st)) * 100)));
      slot.innerHTML += `<div class="cc-bar"><i style="width:${pct}%"></i></div>`;
    }
  } else if (e.next) {
    slot.innerHTML = `<span class="cc-prog muted">⏭ ${epgTime(e.next.st)} ${escapeHtml(e.next.title)}</span>`;
  }
}

/* ---------- FILMS (VOD) ---------- */
// Charge films FR (catégories + streams) une seule fois.
async function loadVodData() {
  if (state.vod) return;
  const cats = await xtreamApi('action=get_vod_categories');
  state.vodCats = (Array.isArray(cats) ? cats : []).filter((c) => frCategoryAllowed(c.category_name));
  const allowed = new Set(state.vodCats.map((c) => String(c.category_id)));
  const list = await xtreamApi('action=get_vod_streams');
  state.vod = (Array.isArray(list) ? list : []).filter((m) => allowed.has(String(m.category_id)));
}

async function ensureVod() {
  if (!state.vod) {
    $('movieGrid').innerHTML = '<div class="loading">Chargement des films…</div>';
    try { await loadVodData(); }
    catch (e) { $('movieGrid').innerHTML = `<div class="loading">Impossible de charger les films : ${escapeHtml(e.message)}</div>`; state.vod = state.vod || []; return; }
  }
  fillContentCat($('vodCat'), state.vodCats, state.vod.length);
  renderMovies();
}

function fillContentCat(sel, cats, total) {
  sel.innerHTML = `<option value="">Toutes les catégories (${total})</option>`;
  for (const c of cats) {
    const o = document.createElement('option');
    o.value = c.category_id; o.textContent = c.category_name;
    sel.appendChild(o);
  }
}

function renderMovies() {
  const grid = $('movieGrid');
  const cat = $('vodCat').value;
  const q = $('search').value.trim().toLowerCase();
  let items = state.vod || [];
  if (cat) items = items.filter((m) => m.category_id == cat);
  if (q) items = items.filter((m) => (m.name || '').toLowerCase().includes(q));
  $('movieCount').textContent = `${items.length} film(s)`;
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = '<div class="loading">Aucun film.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const m of items.slice(0, 600)) {
    frag.appendChild(posterCard({
      title: m.name, cover: m.stream_icon || m.cover, rating: m.rating,
      onClick: () => playMovie(m),
      onDownload: () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); }
    }));
  }
  grid.appendChild(frag);
}

function playMovie(m) {
  const ext = m.container_extension || 'mp4';
  pushRecent({ type: 'movie', id: m.stream_id, name: m.name, icon: m.stream_icon || m.cover, ext });
  playMedia(vodUrl(m.stream_id, ext), m.name || 'Film', false, '🎬 Films');
}

/* ---------- SÉRIES ---------- */
// Charge séries FR (catégories + liste) une seule fois.
async function loadSeriesData() {
  if (state.series) return;
  const cats = await xtreamApi('action=get_series_categories');
  state.seriesCats = (Array.isArray(cats) ? cats : []).filter((c) => frCategoryAllowed(c.category_name));
  const allowed = new Set(state.seriesCats.map((c) => String(c.category_id)));
  const list = await xtreamApi('action=get_series');
  state.series = (Array.isArray(list) ? list : []).filter((s) => allowed.has(String(s.category_id)));
}

async function ensureSeries() {
  if (!state.series) {
    $('seriesGrid').innerHTML = '<div class="loading">Chargement des séries…</div>';
    try { await loadSeriesData(); }
    catch (e) { $('seriesGrid').innerHTML = `<div class="loading">Impossible de charger les séries : ${escapeHtml(e.message)}</div>`; state.series = state.series || []; return; }
  }
  fillContentCat($('seriesCat'), state.seriesCats, state.series.length);
  renderSeries();
}

function renderSeries() {
  const grid = $('seriesGrid');
  const cat = $('seriesCat').value;
  const q = $('search').value.trim().toLowerCase();
  let items = state.series || [];
  if (cat) items = items.filter((s) => s.category_id == cat);
  if (q) items = items.filter((s) => (s.name || '').toLowerCase().includes(q));
  $('seriesCount').textContent = `${items.length} série(s)`;
  grid.innerHTML = '';
  if (!items.length) { grid.innerHTML = '<div class="loading">Aucune série.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (const s of items.slice(0, 600)) {
    frag.appendChild(posterCard({
      title: s.name, cover: s.cover || s.stream_icon, rating: s.rating,
      onClick: () => openSeries(s)
    }));
  }
  grid.appendChild(frag);
}

let curSeries = null;
async function openSeries(s) {
  curSeries = { ...s, episodes: null };
  $('seriesTitle').textContent = s.name || 'Série';
  $('seriesPlot').textContent = 'Chargement…';
  $('seasonSelect').innerHTML = '';
  $('episodeList').innerHTML = '';
  const cover = $('seriesCover');
  cover.innerHTML = (s.cover || s.stream_icon) ? `<img src="${escapeHtml(s.cover || s.stream_icon)}">` : '🎞️';
  $('seriesModal').classList.remove('hidden');
  try {
    const info = await xtreamApi('action=get_series_info&series_id=' + s.series_id);
    curSeries.episodes = (info && info.episodes) || {};
    const plot = (info && info.info && (info.info.plot || info.info.description)) || '';
    $('seriesPlot').textContent = plot || 'Aucune description.';
    const seasons = Object.keys(curSeries.episodes).sort((a, b) => Number(a) - Number(b));
    if (!seasons.length) { $('episodeList').innerHTML = '<li class="rec-empty">Aucun épisode.</li>'; return; }
    $('seasonSelect').innerHTML = seasons.map((n) => `<option value="${escapeHtml(n)}">Saison ${escapeHtml(n)}</option>`).join('');
    renderEpisodes(seasons[0]);
  } catch (e) {
    $('seriesPlot').textContent = 'Impossible de charger les épisodes : ' + e.message;
  }
}

let curSeason = null;
function renderEpisodes(season) {
  curSeason = season;
  const eps = (curSeries.episodes && curSeries.episodes[season]) || [];
  const cover = curSeries.cover || curSeries.stream_icon;
  const ul = $('episodeList');
  ul.innerHTML = '';
  eps.forEach((ep, i) => {
    const li = document.createElement('li');
    li.className = 'ep-item';
    const info = ep.info || {};
    const dur = info.duration || '';
    const meta = document.createElement('div');
    meta.className = 'ep-meta';
    meta.innerHTML = `<span class="ep-t">${escapeHtml(ep.title || ('Épisode ' + ep.episode_num))}</span><span class="ep-s">${escapeHtml(dur)}</span>`;
    const n = document.createElement('span');
    n.className = 'ep-n'; n.textContent = String(ep.episode_num || (i + 1));
    const dl = document.createElement('button');
    dl.className = 'ep-dl'; dl.textContent = '⬇'; dl.title = 'Télécharger cet épisode';
    dl.onclick = (ev) => { ev.stopPropagation(); const ext = ep.container_extension || 'mp4'; startDownload(seriesUrl(ep.id, ext), `${curSeries.name} S${season}E${ep.episode_num}`, ext); };
    const play = document.createElement('span');
    play.className = 'ep-play'; play.textContent = '▶';
    li.append(n, meta, dl, play);
    li.onclick = () => playEpisodeAt({ eps, idx: i, season, name: curSeries.name, cover });
    ul.appendChild(li);
  });
}

// Lance un épisode et mémorise la file pour l'enchaînement automatique
function playEpisodeAt(q) {
  const ep = q.eps[q.idx];
  if (!ep) return;
  const ext = ep.container_extension || 'mp4';
  const label = `${q.name} · S${q.season}E${ep.episode_num}`;
  pushRecent({ type: 'series', id: ep.id, name: label, icon: q.cover, ext });
  $('seriesModal').classList.add('hidden');
  playMedia(seriesUrl(ep.id, ext), label, false, '🎞️ Séries');
  state.playQueue = q; // après playMedia (qui réinitialise la file)
}

// Télécharge tous les épisodes de la saison courante.
// Les téléchargements sont mis en file et traités un par un côté main
// (le fournisseur n'autorise qu'une seule connexion à la fois).
function downloadSeason() {
  const eps = (curSeries.episodes && curSeries.episodes[curSeason]) || [];
  if (!eps.length) return;
  for (const ep of eps) {
    const ext = ep.container_extension || 'mp4';
    startDownload(seriesUrl(ep.id, ext), `${curSeries.name} S${curSeason}E${ep.episode_num}`, ext);
  }
}

// Télécharge tous les épisodes de toutes les saisons (même file séquentielle).
function downloadSeries() {
  if (!curSeries || !curSeries.episodes) return;
  const seasons = Object.keys(curSeries.episodes).sort((a, b) => Number(a) - Number(b));
  let count = 0;
  for (const season of seasons) {
    for (const ep of curSeries.episodes[season] || []) {
      const ext = ep.container_extension || 'mp4';
      startDownload(seriesUrl(ep.id, ext), `${curSeries.name} S${season}E${ep.episode_num}`, ext);
      count++;
    }
  }
  if (count) $('seriesModal').classList.add('hidden');
}

/* ---------- Carte affiche (films/séries) ---------- */
function posterCard({ title, cover, rating, onClick, onDownload }) {
  const card = document.createElement('div');
  card.className = 'poster';
  const img = document.createElement('div');
  img.className = 'p-img';
  if (cover) {
    const im = document.createElement('img');
    im.src = cover; im.loading = 'lazy';
    im.onerror = () => { im.remove(); img.classList.add('noimg'); img.textContent = '🎬'; };
    img.appendChild(im);
  } else { img.classList.add('noimg'); img.textContent = '🎬'; }
  if (rating && Number(rating) > 0) {
    const r = document.createElement('span');
    r.className = 'p-rate'; r.textContent = '★ ' + Number(rating).toFixed(1);
    img.appendChild(r);
  }
  if (onDownload) {
    const dl = document.createElement('button');
    dl.className = 'p-dl'; dl.textContent = '⬇'; dl.title = 'Télécharger';
    dl.onclick = (ev) => { ev.stopPropagation(); onDownload(); };
    img.appendChild(dl);
  }
  const t = document.createElement('div');
  t.className = 'p-title'; t.textContent = title || '—';
  card.appendChild(img); card.appendChild(t);
  card.onclick = onClick;
  return card;
}

/* ---------- GUIDE (timeline EPG) ---------- */
const GUIDE_MAX = 80;
let guideToken = 0;
async function ensureGuide() {
  // remplit le sélecteur de catégorie guide (mêmes catégories live)
  if ($('guideCat').value === '' && state.categories[0]) $('guideCat').value = state.categories[0].category_id;
  buildGuideGrid();
}

async function buildGuideGrid() {
  const token = ++guideToken;
  const cat = $('guideCat').value || (state.categories[0] && state.categories[0].category_id);
  const grid = $('guideGrid');
  if (!cat) { grid.innerHTML = '<div class="loading">Aucune catégorie.</div>'; return; }
  grid.innerHTML = '<div class="loading">Chargement du guide…</div>';
  let list;
  try {
    if (!state.allByCat[cat]) {
      const r = await xtreamApi('action=get_live_streams&category_id=' + cat);
      state.allByCat[cat] = Array.isArray(r) ? r : [];
    }
    list = state.allByCat[cat];
  } catch (e) { grid.innerHTML = `<div class="loading">Erreur : ${escapeHtml(e.message)}</div>`; return; }
  if (token !== guideToken) return;
  const chans = list.filter((c) => !isJunkChannel(c)).slice(0, GUIDE_MAX);
  $('guideHint').textContent = list.length > GUIDE_MAX ? `${GUIDE_MAX} sur ${list.length} chaînes` : `${list.length} chaîne(s)`;
  grid.innerHTML = '';
  const rows = chans.map((c) => {
    const row = document.createElement('div');
    row.className = 'g-row';
    row.innerHTML =
      `<div class="g-ch"><div class="g-logo">${c.stream_icon ? `<img src="${escapeHtml(c.stream_icon)}">` : escapeHtml(initials(c.name))}</div>` +
      `<span class="g-name">${escapeHtml(c.name || ('Chaîne ' + c.stream_id))}</span></div>` +
      `<div class="g-progs"><span class="muted">…</span></div>`;
    const im = row.querySelector('img');
    if (im) im.onerror = () => { im.replaceWith(document.createTextNode(initials(c.name))); };
    row.querySelector('.g-ch').onclick = () => play(c);
    grid.appendChild(row);
    return { c, row };
  });
  if (!rows.length) { grid.innerHTML = '<div class="loading">Aucune chaîne.</div>'; return; }
  let idx = 0;
  const worker = async () => {
    while (idx < rows.length) {
      if (token !== guideToken) return;
      const { c, row } = rows[idx++];
      await fillGuideRow(c, row);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function fillGuideRow(c, row) {
  const slot = row.querySelector('.g-progs');
  let progs = [];
  try {
    const data = await xtreamApi('action=get_short_epg&stream_id=' + c.stream_id + '&limit=8');
    progs = (((data && data.epg_listings) || [])
      .map((x) => ({ title: decodeEpg(x.title), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st).sort((a, b) => a.st - b.st));
  } catch {}
  if (!progs.length) {
    const e = await getChannelEpg(c);
    if (e && e.cur) progs = [e.cur, e.next].filter(Boolean);
  }
  if (!progs.length) { slot.innerHTML = '<span class="muted">Pas de programme</span>'; return; }
  const now = Date.now() / 1000;
  slot.innerHTML = '';
  for (const p of progs.slice(0, 6)) {
    const live = p.st <= now && now < (p.en || p.st);
    const block = document.createElement('div');
    block.className = 'g-prog' + (live ? ' live' : '');
    const span = (p.en && p.en > p.st) ? Math.round((p.en - p.st) / 60) : 0;
    block.style.flex = span ? Math.max(1, Math.min(6, span / 30)) : 1;
    block.innerHTML = `<span class="gp-t">${escapeHtml(p.title)}</span><span class="gp-h">${epgTime(p.st)}</span>`;
    if (live && p.en > p.st) {
      const pct = Math.round(((now - p.st) / (p.en - p.st)) * 100);
      block.innerHTML += `<div class="gp-bar"><i style="width:${pct}%"></i></div>`;
    }
    block.onclick = () => play(c);
    slot.appendChild(block);
  }
}

/* ---------- ACCUEIL ---------- */
// Catégories choisies pour l'accueil : [{kind:'live'|'movie'|'series', id, name}]
function loadHomeCats() { try { return JSON.parse(localStorage.getItem('home_cats') || '[]'); } catch { return []; } }
function saveHomeCats(arr) { try { localStorage.setItem('home_cats', JSON.stringify(arr)); } catch {} }

function buildHome() {
  const root = $('homeRows');
  root.innerHTML = '';

  // Hero : reprend le 1er "vu récemment" ou 1er favori
  const heroItem = state.recent[0] || (state.favs[0] && { type: 'live', id: state.favs[0].stream_id, name: state.favs[0].name, icon: state.favs[0].stream_icon });
  if (heroItem) root.appendChild(buildHero(heroItem));

  if (state.recent.length) root.appendChild(makeRow('Reprendre la lecture', state.recent.map(recentCard)));
  if (state.favs.length) root.appendChild(makeRow('Chaînes favorites', state.favs.map((f) => channelCard(f, false)), () => { $('catSelect').value = 'favs'; showView('live'); }));

  // Catégories choisies dans les Réglages (s'ajoutent aux rangées par défaut)
  const cats = loadHomeCats();
  if (cats.length) {
    const rows = cats.map((c) => {
      const row = makeRow(c.name, [loadingTile()], () => seeAll(c));
      root.appendChild(row);
      return row;
    });
    fillCategoryRows(cats, rows);
  }

  // Toujours présentes : films & séries récemment ajoutés
  const moviesRow = makeRow('Films récemment ajoutés', [loadingTile()], () => showView('movies'));
  const seriesRow = makeRow('Séries', [loadingTile()], () => showView('series'));
  root.appendChild(moviesRow); root.appendChild(seriesRow);
  fillHomeContent(moviesRow, seriesRow);
}

// Remplit les rangées de catégories choisies (max 20 éléments + "tout voir")
async function fillCategoryRows(cats, rows) {
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i], row = rows[i];
    try {
      if (c.kind === 'live') {
        if (!state.allByCat[c.id]) {
          const r = await xtreamApi('action=get_live_streams&category_id=' + c.id);
          state.allByCat[c.id] = Array.isArray(r) ? r : [];
        }
        const items = state.allByCat[c.id].filter((x) => !isJunkChannel(x)).slice(0, 20);
        if (items.length) setRowCards(row, items.map((x) => channelCard(x, false))); else row.remove();
      } else if (c.kind === 'movie') {
        await loadVodData();
        const items = (state.vod || []).filter((m) => String(m.category_id) === String(c.id)).slice(0, 20);
        if (items.length) setRowCards(row, items.map((m) => posterCard({
          title: m.name, cover: m.stream_icon || m.cover, rating: m.rating,
          onClick: () => playMovie(m),
          onDownload: () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); }
        }))); else row.remove();
      } else {
        await loadSeriesData();
        const items = (state.series || []).filter((s) => String(s.category_id) === String(c.id)).slice(0, 20);
        if (items.length) setRowCards(row, items.map((s) => posterCard({ title: s.name, cover: s.cover || s.stream_icon, rating: s.rating, onClick: () => openSeries(s) }))); else row.remove();
      }
    } catch { row.remove(); }
  }
}

// "tout voir" : ouvre la section filtrée sur la catégorie (tous les éléments)
async function seeAll(c) {
  if (c.kind === 'live') { $('catSelect').value = c.id; showView('live'); }
  else if (c.kind === 'movie') {
    showView('movies'); await ensureVod();
    if ($('vodCat').querySelector(`option[value="${c.id}"]`)) { $('vodCat').value = c.id; renderMovies(); }
  } else {
    showView('series'); await ensureSeries();
    if ($('seriesCat').querySelector(`option[value="${c.id}"]`)) { $('seriesCat').value = c.id; renderSeries(); }
  }
}

async function fillHomeContent(moviesRow, seriesRow) {
  try {
    await loadVodData();
    const recent = [...(state.vod || [])].sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0)).slice(0, 18);
    if (recent.length) setRowCards(moviesRow, recent.map((m) => posterCard({ title: m.name, cover: m.stream_icon || m.cover, rating: m.rating, onClick: () => playMovie(m) })));
    else moviesRow.remove();
  } catch { moviesRow.remove(); }
  try {
    await loadSeriesData();
    const recent = [...(state.series || [])].sort((a, b) => (Number(b.last_modified) || 0) - (Number(a.last_modified) || 0)).slice(0, 18);
    if (recent.length) setRowCards(seriesRow, recent.map((s) => posterCard({ title: s.name, cover: s.cover || s.stream_icon, rating: s.rating, onClick: () => openSeries(s) })));
    else seriesRow.remove();
  } catch { seriesRow.remove(); }
}

function makeRow(title, cards, onSeeAll) {
  const row = document.createElement('div');
  row.className = 'home-row';
  const h = document.createElement('h2'); h.textContent = title;
  if (onSeeAll) {
    const a = document.createElement('span');
    a.className = 'see-all'; a.textContent = 'tout voir ›';
    a.onclick = onSeeAll;
    h.appendChild(a);
  }
  const track = document.createElement('div'); track.className = 'track';
  cards.forEach((c) => track.appendChild(c));
  row.appendChild(h); row.appendChild(track);
  return row;
}
function setRowCards(row, cards) {
  const track = row.querySelector('.track');
  track.innerHTML = '';
  cards.forEach((c) => track.appendChild(c));
}
function loadingTile() { const d = document.createElement('div'); d.className = 'loading'; d.textContent = 'Chargement…'; return d; }
function emptyTile(t) { const d = document.createElement('div'); d.className = 'loading'; d.textContent = t; return d; }

// Carte "Reprendre" — vignette paysage uniforme quel que soit le type
function recentCard(r) {
  const card = document.createElement('div');
  card.className = 'recent-card';
  const th = document.createElement('div');
  th.className = 'rc-thumb' + (r.type === 'live' ? ' live' : '');
  if (r.icon) {
    const im = document.createElement('img');
    im.src = r.icon; im.loading = 'lazy';
    im.onerror = () => { im.remove(); th.textContent = r.type === 'live' ? '📺' : '🎬'; };
    th.appendChild(im);
  } else th.textContent = r.type === 'live' ? '📺' : '🎬';
  const badge = document.createElement('span');
  badge.className = 'rc-badge';
  badge.textContent = r.type === 'live' ? 'EN DIRECT' : (r.type === 'movie' ? 'FILM' : 'SÉRIE');
  th.appendChild(badge);
  const t = document.createElement('div');
  t.className = 'rc-title'; t.textContent = r.name || '—';
  card.appendChild(th); card.appendChild(t);
  card.onclick = () => {
    if (r.type === 'live') play({ stream_id: r.id, name: r.name, stream_icon: r.icon, category_id: r.cat });
    else playMedia(r.type === 'movie' ? vodUrl(r.id, r.ext) : seriesUrl(r.id, r.ext), r.name, false, r.type === 'movie' ? '🎬 Films' : '🎞️ Séries');
  };
  return card;
}

function buildHero(item) {
  const hero = document.createElement('div');
  hero.className = 'hero';
  const live = item.type === 'live';
  hero.innerHTML =
    `<div class="hero-art"></div><div class="hero-grad"></div>` +
    `<div class="hero-info"><div class="hero-tag">${live ? '● Reprendre en direct' : '● Reprendre'}</div>` +
    `<h1>${escapeHtml(item.name || '—')}</h1>` +
    `<button class="btn play">▶ Regarder</button></div>`;
  hero.querySelector('.btn.play').onclick = () => {
    if (live) play({ stream_id: item.id, name: item.name, stream_icon: item.icon, category_id: item.cat });
    else playMedia(item.type === 'movie' ? vodUrl(item.id, item.ext) : seriesUrl(item.id, item.ext), item.name, false, item.type === 'movie' ? '🎬 Films' : '🎞️ Séries');
  };
  return hero;
}

/* ---------- Lecteur ---------- */
let suppressResume = false;

function enterPlayer(crumb, isLive) {
  $('playerCrumb').textContent = crumb || '';
  $('liveActions').style.display = isLive ? '' : 'none';
  showView('player');
}

function destroyPlayer() {
  suppressResume = true;
  const v = $('video');
  if (state.player) { try { state.player.destroy(); } catch {} state.player = null; }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
}

// Lecture VOD / épisode (fichier direct)
function playMedia(url, title, isLive, crumb) {
  state.current = null;
  state.playQueue = null;
  enterPlayer(crumb || title, false);
  $('chanSidebar').classList.add('hidden');
  $('sidebarToggle').classList.add('hidden');
  $('nowTitle').textContent = title || '—';
  $('nowEpg').textContent = '';
  $('overlay').classList.add('hidden');
  $('recBtn').disabled = true; $('relayBtn').disabled = true; $('scheduleBtn').disabled = true;
  if (state.relaying) stopRelay();
  destroyPlayer();
  const v = $('video');
  suppressResume = false;
  v.onerror = () => {
    $('overlay').classList.remove('hidden');
    $('overlay').textContent = 'Lecture impossible : format non supporté par le lecteur (souvent .mkv/.avi). Ouvre le fichier dans VLC.';
  };
  if (/\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(url);
    hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    state.player = hls;
  } else {
    v.src = url;
    v.play().catch(() => {});
  }
}

function decodeEpg(b64) {
  try { return decodeURIComponent(escape(atob(b64 || ''))).trim(); }
  catch { try { return atob(b64 || ''); } catch { return ''; } }
}
function epgTime(s) { const d = new Date((Number(s) || 0) * 1000); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

async function getChannelEpg(channel) {
  if (state.epgCache[channel.stream_id]) return state.epgCache[channel.stream_id];
  let result = null;
  try {
    const data = await xtreamApi('action=get_short_epg&stream_id=' + channel.stream_id + '&limit=6');
    const items = (((data && data.epg_listings) || [])
      .map((x) => ({ title: decodeEpg(x.title), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st).sort((a, b) => a.st - b.st));
    if (items.length) {
      const now = Date.now() / 1000;
      result = { cur: items.find((p) => p.st <= now && now < p.en) || null, next: items.find((p) => p.st > now) || null, src: 'xtream' };
    }
  } catch {}
  if (!result) {
    try {
      const r = await window.api.epgLookup(channel.name, channel.epg_channel_id);
      if (r && (r.cur || r.next)) result = { cur: r.cur, next: r.next, src: 'xmltv' };
    } catch {}
  }
  if (result) state.epgCache[channel.stream_id] = result;
  return result;
}

let epgReq = 0;
async function loadEpg(channel) {
  const el = $('nowEpg');
  el.textContent = '';
  const my = ++epgReq;
  const e = await getChannelEpg(channel);
  if (my !== epgReq || !e) return;
  let txt = e.cur ? `🔴 ${epgTime(e.cur.st)} ${e.cur.title}` : '';
  if (e.next) txt += `${txt ? '   ·   ' : ''}⏭ ${epgTime(e.next.st)} ${e.next.title}`;
  if (e.src === 'xmltv' && txt) txt += '   · (guide externe)';
  el.textContent = txt;
}

// Lecture LIVE
function play(channel) {
  // Garde "1 connexion" : si un enregistrement tourne, on ne peut pas ouvrir
  // un 2e flux fournisseur.
  if (state.recId) {
    const sameChannel = state.recChannelName && channel.name === state.recChannelName;
    if (sameChannel && state.recLocal) {
      // On regarde la chaîne en cours d'enregistrement → via le relais local,
      // aucune connexion fournisseur supplémentaire.
      watchRecordingLive(channel);
      return;
    }
    if (!sameChannel) {
      const ok = confirm(
        `⏺ Un enregistrement est en cours sur « ${state.recChannelName || 'une chaîne'} ».\n\n` +
        `Ton abonnement n'autorise qu'un seul flux à la fois : regarder « ${channel.name || 'cette chaîne'} » ` +
        `va ARRÊTER l'enregistrement en cours.\n\nContinuer ?`
      );
      if (!ok) return;
      try { window.api.recordStop(state.recId); } catch {}
      stopRecUI();
    }
  }

  state.current = channel;
  state.playQueue = null;
  pushRecent({ type: 'live', id: channel.stream_id, name: channel.name, icon: channel.stream_icon, cat: channel.category_id });
  enterPlayer(channel.name || ('Chaîne ' + channel.stream_id), true);
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  $('overlay').classList.add('hidden');
  loadEpg(channel);
  $('recBtn').disabled = false;
  $('relayBtn').disabled = false;
  $('scheduleBtn').disabled = false;
  if (state.relaying) stopRelay();
  document.querySelectorAll('.chan-card').forEach((c) => c.classList.toggle('active', c.dataset.id == channel.stream_id));
  buildPlayerSidebar(channel);

  destroyPlayer();
  const v = $('video');
  const tsUrl = streamUrl(channel.stream_id, 'ts');
  const hlsUrl = streamUrl(channel.stream_id, 'm3u8');

  if (window.mpegts && mpegts.isSupported()) {
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: tsUrl },
      { enableWorker: true, liveBufferLatencyChasing: false, liveSync: false, lazyLoad: false,
        autoCleanupSourceBuffer: true, stashInitialSize: 1024 * 1024, enableStashBuffer: true }
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

// Regarder la chaîne actuellement enregistrée via le relais local (sans
// ouvrir de 2e connexion fournisseur). On ne touche NI au relais NI à
// l'enregistrement en cours.
function watchRecordingLive(channel) {
  state.current = channel;
  state.playQueue = null;
  pushRecent({ type: 'live', id: channel.stream_id, name: channel.name, icon: channel.stream_icon, cat: channel.category_id });
  enterPlayer(channel.name || ('Chaîne ' + channel.stream_id), true);
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  $('overlay').classList.add('hidden');
  loadEpg(channel);
  $('recBtn').disabled = false;
  $('relayBtn').disabled = false;
  $('scheduleBtn').disabled = false;
  document.querySelectorAll('.chan-card').forEach((c) => c.classList.toggle('active', c.dataset.id == channel.stream_id));
  buildPlayerSidebar(channel);
  destroyPlayer();
  playHls(state.recLocal);
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
        setTimeout(() => { if (state.player === hls) playHls(url, retries - 1); }, 1000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); } catch {}
      }
    });
    state.player = hls;
  } else {
    v.src = url;
    suppressResume = false;
    v.play().catch(() => {});
  }
}

/* ---------- Sidebar chaînes (player) ---------- */
let csEpgObserver = null;
async function loadCategoryChannels(catId) {
  if (!state.allByCat[catId]) {
    const list = await xtreamApi('action=get_live_streams&category_id=' + catId);
    state.allByCat[catId] = Array.isArray(list) ? list : [];
  }
  return state.allByCat[catId];
}
async function buildPlayerSidebar(active) {
  const aside = $('chanSidebar'), list = $('csList'), toggle = $('sidebarToggle');
  let chans = (state.channels || []).filter((c) => !isJunkChannel(c));
  let inList = active && chans.some((c) => c.stream_id == active.stream_id);
  // chaîne lancée hors de la liste courante (ex. "Reprendre") : charger sa catégorie
  if (active && !inList && active.category_id) {
    try {
      const cat = String(active.category_id);
      state.channels = await loadCategoryChannels(cat);
      state.curLiveCat = cat;
      chans = (state.channels || []).filter((c) => !isJunkChannel(c));
      inList = chans.some((c) => c.stream_id == active.stream_id);
    } catch {}
  }
  // seulement si la chaîne jouée appartient à la catégorie courante (même liste)
  if (!active || chans.length < 2 || !inList) { aside.classList.add('hidden'); toggle.classList.add('hidden'); return; }
  toggle.classList.remove('hidden');
  aside.classList.remove('hidden');
  aside.classList.toggle('collapsed', localStorage.getItem('player_sidebar') === '0');
  // Même catégorie déjà construite : on met juste à jour la chaîne active (garde le scroll)
  if (state.sidebarCat === state.curLiveCat && list.childElementCount) {
    list.querySelectorAll('.cs-item').forEach((el) => {
      const on = el.dataset.id == active.stream_id;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    return;
  }
  state.sidebarCat = state.curLiveCat;
  $('csTitle').textContent = `Chaînes (${chans.length})`;
  list.innerHTML = '';
  if (!csEpgObserver) {
    csEpgObserver = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { csEpgObserver.unobserve(e.target); fillSidebarEpg(e.target); } });
    }, { root: list, rootMargin: '200px' });
  }
  for (const c of chans) {
    const el = document.createElement('div');
    el.className = 'cs-item' + (c.stream_id == active.stream_id ? ' active' : '');
    el.dataset.id = c.stream_id;
    const logo = c.stream_icon
      ? `<img src="${escapeHtml(c.stream_icon)}" loading="lazy" onerror="this.remove()">`
      : escapeHtml((c.name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
    el.innerHTML = `<div class="cs-logo">${logo}</div><div class="cs-info">` +
      `<span class="cs-name">${escapeHtml(c.name || ('Chaîne ' + c.stream_id))}</span>` +
      `<span class="cs-prog muted">…</span></div>`;
    el.onclick = () => play(c);
    list.appendChild(el);
    csEpgObserver.observe(el);
  }
  const act = list.querySelector('.cs-item.active');
  if (act) act.scrollIntoView({ block: 'center' });
}
async function fillSidebarEpg(el) {
  const ch = (state.channels || []).find((c) => c.stream_id == el.dataset.id);
  const prog = el.querySelector('.cs-prog');
  if (!ch || !prog) return;
  const e = await getChannelEpg(ch);
  if (e && e.cur) { prog.textContent = e.cur.title; prog.classList.remove('muted'); }
  else if (e && e.next) { prog.textContent = '⏭ ' + e.next.title; }
  else { prog.textContent = ''; }
}
function togglePlayerSidebar() {
  const collapsed = $('chanSidebar').classList.toggle('collapsed');
  localStorage.setItem('player_sidebar', collapsed ? '0' : '1');
}

/* ---------- Enregistrement ---------- */
async function toggleRecord() {
  const btn = $('recBtn');
  if (state.recId) {
    await window.api.recordStop(state.recId);
    stopRecUI();
  } else {
    if (!state.current) return;
    btn.disabled = true;
    btn.textContent = '⏺ Démarrage…';
    try {
      const url = streamUrl(state.current.stream_id, 'ts');
      const res = await window.api.recordStart(url, state.current.name);
      beginRecUI(res, true);
    } catch (e) {
      alert('Enregistrement impossible : ' + e.message);
      btn.textContent = '⏺ Enregistrer';
    } finally {
      btn.disabled = false;
    }
  }
}

// Met l'UI en mode "enregistrement en cours". switchPlayer=true bascule le
// lecteur sur le flux local (cas d'un enregistrement lancé manuellement) ;
// false pour un enregistrement programmé qui ne doit pas voler l'écran.
function beginRecUI(res, switchPlayer) {
  state.recId = res.id;
  state.recStartedRelay = res.startedRelay;
  state.recStart = Date.now();
  state.recDuration = Math.floor(Number(res.durationSec) || 0);
  state.recLocal = res.local || '';
  state.recChannelName = res.name || (state.current && state.current.name) || '';
  if (switchPlayer && res.local && !state.relaying) { destroyPlayer(); playHls(res.local); }
  const btn = $('recBtn');
  btn.classList.add('recording');
  btn.textContent = '⏹ Arrêter';
  $('recDot').classList.remove('hidden');
  clearInterval(state.recTimer);
  state.recTimer = setInterval(updateRecTime, 1000);
  updateRecTime();
}

function resumeDirect() { if (state.current) play(state.current); }

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// Durée lisible : "1 h 30", "45 min", "2 h".
function fmtDur(sec) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h && rm) return `${h} h ${rm}`;
  if (h) return `${h} h`;
  return `${m} min`;
}

function updateRecTime() {
  const s = Math.floor((Date.now() - state.recStart) / 1000);
  if (state.recDuration > 0) {
    // Compte à rebours : temps écoulé / durée totale programmée.
    $('recTime').textContent = `${fmtClock(s)} / ${fmtClock(state.recDuration)}`;
  } else {
    $('recTime').textContent = fmtClock(s);
  }
}

function stopRecUI() {
  state.recId = null;
  state.recDuration = 0;
  state.recLocal = '';
  state.recChannelName = '';
  clearInterval(state.recTimer);
  const btn = $('recBtn');
  btn.classList.remove('recording');
  btn.textContent = '⏺ Enregistrer';
  $('recDot').classList.add('hidden');
}

/* ---------- Programmation d'enregistrement ---------- */
// Met à jour la pastille de comptage + l'état "armé" du bouton Programmer.
function updateScheduleBadge(n) {
  const badge = $('schCount'); const btn = $('scheduleBtn');
  if (!badge || !btn) return;
  if (n > 0) { badge.textContent = n; badge.classList.remove('hidden'); btn.classList.add('armed'); }
  else { badge.classList.add('hidden'); btn.classList.remove('armed'); }
}

function schStartMode() { return document.querySelector('input[name="schStart"]:checked').value; }
function schEndMode() { return document.querySelector('input[name="schEnd"]:checked').value; }

// Pré-remplit un datetime-local au format local (sans décalage UTC).
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openScheduleModal() {
  if (!state.current) return;
  $('schChan').textContent = state.current.name || ('Chaîne ' + state.current.stream_id);
  // valeurs par défaut : début maintenant, durée 60 min
  document.querySelector('input[name="schStart"][value="now"]').checked = true;
  document.querySelector('input[name="schEnd"][value="dur"]').checked = true;
  $('schDur').value = 60;
  const now = new Date();
  $('schStartAt').value = toLocalInput(new Date(now.getTime() + 5 * 60000));
  $('schEndAt').value = toLocalInput(new Date(now.getTime() + 65 * 60000));
  $('schError').textContent = '';
  syncScheduleFields();
  $('scheduleModal').classList.remove('hidden');
  refreshScheduleList();
}

function syncScheduleFields() {
  $('schStartAt').disabled = (schStartMode() !== 'at');
  const em = schEndMode();
  $('schDurWrap').classList.toggle('hidden', em !== 'dur');
  $('schEndAt').classList.toggle('hidden', em !== 'at');
  updateScheduleSummary();
}

// Calcule { startAt, durationSec } d'après les choix UI. Lance une erreur si invalide.
function computeSchedule() {
  const startAt = schStartMode() === 'now' ? Date.now() : new Date($('schStartAt').value).getTime();
  if (!startAt || isNaN(startAt)) throw new Error('Heure de début invalide.');
  if (startAt < Date.now() - 60000) throw new Error('L\'heure de début est déjà passée.');

  const em = schEndMode();
  let durationSec = 0;
  if (em === 'dur') {
    const min = Number($('schDur').value);
    if (!min || min <= 0) throw new Error('Durée invalide.');
    durationSec = Math.round(min * 60);
  } else if (em === 'at') {
    const endAt = new Date($('schEndAt').value).getTime();
    if (!endAt || isNaN(endAt)) throw new Error('Heure de fin invalide.');
    durationSec = Math.round((endAt - startAt) / 1000);
    if (durationSec <= 0) throw new Error('La fin doit être après le début.');
  } // em === 'none' => durationSec 0 (illimité)
  return { startAt, durationSec };
}

function updateScheduleSummary() {
  try {
    const { startAt, durationSec } = computeSchedule();
    const when = schStartMode() === 'now'
      ? 'maintenant'
      : new Date(startAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const how = durationSec > 0 ? `pendant ${fmtDur(durationSec)}` : 'jusqu\'à arrêt manuel';
    $('schSummary').textContent = `▶︎ Démarre ${when}, ${how}.`;
    $('schError').textContent = '';
  } catch (e) {
    $('schSummary').textContent = '';
  }
}

async function confirmSchedule() {
  $('schError').textContent = '';
  let plan;
  try { plan = computeSchedule(); }
  catch (e) { $('schError').textContent = e.message; return; }

  const url = streamUrl(state.current.stream_id, 'ts');
  const name = state.current.name || ('Chaîne ' + state.current.stream_id);
  const btn = $('schConfirm');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '…';
  try {
    await window.api.scheduleAdd(url, name, plan.startAt, plan.durationSec);
    await refreshScheduleList();
    btn.textContent = '✓ Programmé';
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
  } catch (e) {
    $('schError').textContent = 'Échec : ' + e.message;
    btn.textContent = old; btn.disabled = false;
  }
}

// Remplit une <ul> avec la liste des programmations (modale + écran enregistrements).
function renderScheduleInto(ul, list) {
  if (!ul) return;
  if (!list.length) { ul.innerHTML = '<li class="sch-empty">Aucun enregistrement programmé.</li>'; return; }
  ul.innerHTML = '';
  for (const s of list) {
    const li = document.createElement('li');
    const when = new Date(s.startAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    const dur = s.durationSec > 0 ? fmtDur(s.durationSec) : '∞';
    const info = document.createElement('span');
    info.className = 'sch-info';
    info.textContent = `🕒 ${when} · ${dur} · ${s.name}`;
    const cancel = document.createElement('button');
    cancel.className = 'sch-cancel'; cancel.textContent = '✕'; cancel.title = 'Annuler';
    cancel.onclick = async () => { await window.api.scheduleCancel(s.id); refreshScheduleList(); };
    li.appendChild(info); li.appendChild(cancel);
    ul.appendChild(li);
  }
}

async function refreshScheduleList() {
  let list = [];
  try { list = await window.api.scheduleList(); } catch {}
  updateScheduleBadge(list.length);
  list.sort((a, b) => a.startAt - b.startAt);
  renderScheduleInto($('schList'), list);       // dans la modale Programmer
  renderScheduleInto($('recSchList'), list);    // dans l'écran Mes enregistrements
}

// Liste des enregistrements actuellement en cours (écran Mes enregistrements).
async function refreshActiveRecordings() {
  const box = $('recActiveBox'); const ul = $('recActiveList');
  if (!box || !ul) return;
  let list = [];
  try { list = await window.api.recordList(); } catch {}
  if (!list.length) { box.classList.add('hidden'); ul.innerHTML = ''; return; }
  box.classList.remove('hidden');
  ul.innerHTML = '';
  for (const r of list) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.className = 'sch-info';
    info.textContent = `🔴 ${r.name}`;
    const stop = document.createElement('button');
    stop.className = 'sch-cancel'; stop.textContent = '⏹'; stop.title = 'Arrêter';
    stop.onclick = async () => { await window.api.recordStop(r.id); setTimeout(refreshActiveRecordings, 600); };
    li.appendChild(info); li.appendChild(stop);
    ul.appendChild(li);
  }
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

/* ---------- Détails / réglages ---------- */
function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts) * 1000);
  return isNaN(d) ? '—' : d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

async function buildSettings() {
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
  $('settingsBody').innerHTML = rows.map(([k, v, cls]) =>
    `<div class="row"><span class="k">${k}</span><span class="v ${cls || ''}">${v}</span></div>`
  ).join('') +
    `<div class="row"><span class="k">Dossier d'enregistrement</span><span class="v" id="recDirVal">${recDir}</span></div>` +
    `<button id="pickDirBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);">📁 Changer le dossier…</button>` +
    `<button id="updBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);margin-top:8px;">🔄 Vérifier les mises à jour</button>` +
    `<div class="row" style="margin-top:6px;"><span class="k">EPG externe (guide de secours)</span><span class="v" id="xmltvVal">…</span></div>` +
    `<button id="xmltvBtn" class="copy" style="background:var(--panel2);border:1px solid var(--line);color:var(--txt);">📡 Activer/désactiver l'EPG externe</button>`;
  $('pickDirBtn').onclick = async () => {
    const r = await window.api.pickRecordingsDir();
    if (r.error) { alert(r.error); return; }
    if (!r.canceled) $('recDirVal').textContent = r.dir;
  };
  $('updBtn').onclick = () => window.api.checkUpdate();
  const refreshXmltv = async () => {
    try {
      const s = await window.api.xmltvStatus();
      $('xmltvVal').textContent = s.enabled ? (s.channels ? `activé · ${s.channels} chaînes` : 'activé · chargement…') : 'désactivé';
    } catch { $('xmltvVal').textContent = '—'; }
  };
  refreshXmltv();
  $('xmltvBtn').onclick = async () => {
    const s = await window.api.xmltvStatus();
    await window.api.xmltvConfig({ enabled: !s.enabled });
    setTimeout(refreshXmltv, 800);
  };

  renderHomeCatPicker();
}

// Sélecteur des catégories affichées sur l'accueil (Live / Films / Séries)
async function renderHomeCatPicker() {
  const host = document.createElement('div');
  host.className = 'settings-section';
  host.innerHTML = `<h3>🏠 Catégories affichées sur l'accueil</h3>` +
    `<p class="hint">Coche les catégories à afficher en rangées sur l'accueil. Vide = Films &amp; Séries récents par défaut. Chaque rangée a un « tout voir » pour afficher tout son contenu.</p>` +
    `<div class="cat-pick-groups"><div class="loading">Chargement des catégories…</div></div>`;
  $('settingsBody').appendChild(host);
  try { await loadVodData(); } catch {}
  try { await loadSeriesData(); } catch {}

  const sel = loadHomeCats();
  const isOn = (kind, id) => sel.some((c) => c.kind === kind && String(c.id) === String(id));
  const groups = [
    ['live', '📺 Live TV', state.categories.map((c) => ({ id: c.category_id, name: c.category_name }))],
    ['movie', '🎬 Films', (state.vodCats || []).map((c) => ({ id: c.category_id, name: c.category_name }))],
    ['series', '🎞️ Séries', (state.seriesCats || []).map((c) => ({ id: c.category_id, name: c.category_name }))]
  ];
  const wrap = host.querySelector('.cat-pick-groups');
  wrap.innerHTML = '';
  for (const [kind, label, list] of groups) {
    if (!list.length) continue;
    const g = document.createElement('div');
    g.className = 'cat-group';
    g.innerHTML = `<div class="cat-group-h">${label}</div>`;
    const box = document.createElement('div');
    box.className = 'cat-checks';
    for (const cat of list) {
      const lbl = document.createElement('label');
      lbl.className = 'cat-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = isOn(kind, cat.id);
      cb.onchange = () => {
        let arr = loadHomeCats();
        if (cb.checked) { if (!arr.some((x) => x.kind === kind && String(x.id) === String(cat.id))) arr.push({ kind, id: cat.id, name: cat.name }); }
        else arr = arr.filter((x) => !(x.kind === kind && String(x.id) === String(cat.id)));
        saveHomeCats(arr);
        buildHome();
      };
      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(' ' + cat.name));
      box.appendChild(lbl);
    }
    g.appendChild(box);
    wrap.appendChild(g);
  }
  if (!wrap.children.length) wrap.innerHTML = '<p class="hint">Aucune catégorie disponible.</p>';
}

/* ---------- Réglage export WhatsApp après enregistrement ---------- */
function getAskWa() { return localStorage.getItem('rec_ask_whatsapp') !== '0'; }
function setAskWa(on) { localStorage.setItem('rec_ask_whatsapp', on ? '1' : '0'); }

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

/* ---------- Menu "Mes enregistrements" ---------- */
const recView = { all: [], page: 1, perPage: 8, channel: '', q: '' };

function channelOf(name) {
  let s = name.replace(/\.[^.]+$/, '');
  s = s.replace(/_whatsapp$/i, '');
  s = s.replace(/_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/, '');
  return s || name;
}

async function loadRecordings() {
  refreshScheduleList();
  refreshActiveRecordings();
  const ul = $('recList');
  ul.innerHTML = '<li class="rec-empty">Chargement…</li>';
  let data;
  try { data = await window.api.listRecordings(); }
  catch (e) { ul.innerHTML = '<li class="rec-empty">Erreur de lecture du dossier</li>'; return; }
  $('recDirHint').textContent = data.dir;
  recView.all = (data.files || []).map((f) => ({ ...f, channel: channelOf(f.name) }));

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

function dayKey(mtime) {
  const d = new Date(mtime);
  if (isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayLabel(mtime) {
  const k = dayKey(mtime);
  if (!k) return 'Date inconnue';
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  const yest = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (k === today) return "Aujourd'hui";
  if (k === yest) return 'Hier';
  return new Date(mtime).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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
    let lastDay = null;
    slice.forEach((f) => {
      const k = dayKey(f.mtime);
      if (k !== lastDay) {
        lastDay = k;
        const head = document.createElement('li');
        head.className = 'rec-day';
        head.textContent = dayLabel(f.mtime);
        ul.appendChild(head);
      }
      ul.appendChild(recRow(f));
    });
  }

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

/* ---------- Téléchargements (tiroir) ---------- */
const dlItems = {}; // id -> { el, bar, pct, cancel }

function startDownload(url, name, ext) {
  window.api.downloadStart(url, name, ext).then((r) => {
    if (r && r.id) addDlItem(r.id, r.name || name, r.queued);
  }).catch(() => {});
}

function addDlItem(id, name, queued) {
  $('dlTray').classList.remove('hidden');
  const el = document.createElement('div');
  el.className = 'dl-item';
  const start = queued ? '⏳ en file' : '0%';
  el.innerHTML = `<div class="dl-row"><span class="dl-name">${escapeHtml(name)}</span><span class="dl-pct">${start}</span>` +
    `<button class="dl-cancel" title="Annuler">✕</button></div><div class="dl-bar"><i></i></div>`;
  const cancel = el.querySelector('.dl-cancel');
  cancel.onclick = () => { window.api.downloadCancel(id); removeDlItem(id); };
  $('dlList').prepend(el);
  dlItems[id] = { el, bar: el.querySelector('.dl-bar i'), pct: el.querySelector('.dl-pct'), cancel };
}

function removeDlItem(id) {
  const it = dlItems[id];
  if (it) { it.el.remove(); delete dlItems[id]; }
  if (!Object.keys(dlItems).length) $('dlTray').classList.add('hidden');
}

/* ---------- Wire up ---------- */
window.addEventListener('DOMContentLoaded', () => {
  loadFavs();
  loadRecent();
  let autoConnect = false;
  try {
    const saved = JSON.parse(localStorage.getItem('xtream') || 'null');
    if (saved && saved.srv && saved.usr && saved.pwd) {
      $('srv').value = saved.srv; $('usr').value = saved.usr; $('pwd').value = saved.pwd;
      autoConnect = true;
    }
  } catch {}

  const vid = $('video');
  vid.addEventListener('pause', () => {
    if (suppressResume || vid.ended || !state.current) return;
    vid.play().catch(() => {});
  });
  // Enchaînement automatique de l'épisode suivant
  vid.addEventListener('ended', () => {
    const q = state.playQueue;
    if (q && q.idx + 1 < q.eps.length) playEpisodeAt({ ...q, idx: q.idx + 1 });
  });

  // Login
  $('connectBtn').onclick = connect;
  $('pwdToggle').onclick = () => {
    const p = $('pwd');
    const show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('pwdToggle').textContent = show ? '🙈' : '👁';
    $('pwdToggle').setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
    p.focus();
  };
  ['srv', 'usr', 'pwd'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); }));

  // Nav rail
  document.querySelectorAll('.rail .nav[data-view]').forEach((b) => {
    b.onclick = () => showView(b.dataset.view);
  });
  $('navLogout').onclick = () => {
    destroyPlayer();
    if (state.recId) window.api.recordStop(state.recId);
    if (state.relaying) stopRelay();
    stopRecUI();
    localStorage.removeItem('xtream');
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  };
  $('railToggle').onclick = () => $('app').classList.toggle('rail-collapsed');

  // Recherche + filtres
  $('search').addEventListener('input', onSearch);
  $('catSelect').onchange = (e) => loadChannels(e.target.value);
  $('qualSelect').addEventListener('change', renderLiveGrid);
  $('vodCat').onchange = renderMovies;
  $('seriesCat').onchange = renderSeries;
  $('guideCat').onchange = buildGuideGrid;
  $('guideRefresh').onclick = () => { state.epgCache = {}; buildGuideGrid(); };

  // Lecteur
  $('playerBack').onclick = () => showView(state.browse);
  $('sidebarToggle').onclick = togglePlayerSidebar;
  $('csCollapse').onclick = togglePlayerSidebar;
  $('recBtn').onclick = toggleRecord;
  $('relayBtn').onclick = toggleRelay;
  $('scheduleBtn').onclick = openScheduleModal;

  // Programmation
  $('scheduleClose').onclick = () => $('scheduleModal').classList.add('hidden');
  $('scheduleModal').onclick = (e) => { if (e.target.id === 'scheduleModal') $('scheduleModal').classList.add('hidden'); };
  document.querySelectorAll('input[name="schStart"], input[name="schEnd"]').forEach((r) => r.addEventListener('change', syncScheduleFields));
  $('schStartAt').addEventListener('change', updateScheduleSummary);
  $('schEndAt').addEventListener('change', updateScheduleSummary);
  $('schDur').addEventListener('input', updateScheduleSummary);
  document.querySelectorAll('.sch-presets button').forEach((b) => {
    b.onclick = () => {
      document.querySelector('input[name="schEnd"][value="dur"]').checked = true;
      $('schDur').value = b.dataset.min;
      syncScheduleFields();
    };
  });
  $('schConfirm').onclick = confirmSchedule;

  // Séries
  $('seriesClose').onclick = () => $('seriesModal').classList.add('hidden');
  $('seriesModal').onclick = (e) => { if (e.target.id === 'seriesModal') $('seriesModal').classList.add('hidden'); };
  $('seasonSelect').onchange = (e) => renderEpisodes(e.target.value);
  $('dlSeasonBtn').onclick = downloadSeason;
  $('dlSeriesBtn').onclick = downloadSeries;

  // Téléchargements
  window.api.onDownloadProgress((d) => {
    const it = dlItems[d.id];
    if (it) { it.bar.style.width = d.pct + '%'; it.pct.textContent = d.pct + '%'; }
  });
  window.api.onDownloadDone((d) => {
    const it = dlItems[d.id];
    if (!it) return;
    if (d.ok) {
      it.bar.style.width = '100%'; it.pct.textContent = '✓'; it.el.classList.add('done');
      it.cancel.textContent = '✓';
      setTimeout(() => removeDlItem(d.id), 5000);
    } else {
      it.pct.textContent = '⚠'; it.el.classList.add('failed'); it.el.title = d.error || 'échec';
    }
  });
  $('dlOpenFolder').onclick = () => window.api.openDownloadsDir();
  $('dlHide').onclick = () => $('dlTray').classList.add('hidden');

  // Enregistrements
  $('recOpenFolder').onclick = () => window.api.openRecordingsDir();
  $('recExportAll').onclick = exportAllWhatsapp;
  $('recAskWa').checked = getAskWa();
  $('recAskWa').onchange = (e) => setAskWa(e.target.checked);
  $('recFilter').onchange = (e) => { recView.channel = e.target.value; recView.page = 1; renderRecPage(); };
  $('recSearch').addEventListener('input', (e) => { recView.q = e.target.value; recView.page = 1; renderRecPage(); });

  // Restream / tunnel
  $('relayClose').onclick = () => $('relayModal').classList.add('hidden');
  $('relayCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.relayLan); $('relayCopy').textContent = 'Copié ✓'; setTimeout(() => $('relayCopy').textContent = 'Copier le lien LAN', 1500); } catch {}
  };
  window.api.onRelayStopped(() => { if (state.relaying) stopRelay(); });
  $('tunnelBtn').onclick = startTunnel;
  $('tunnelCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(state.tunnelUrl); $('tunnelCopy').textContent = 'Copié ✓'; setTimeout(() => $('tunnelCopy').textContent = 'Copier le lien public', 1500); } catch {}
  };
  window.api.onMainError((d) => { if (d && d.msg) console.error('main:', d.msg); });
  window.api.onTunnelStatus((d) => { $('tunnelStatus').textContent = d.msg || ''; });
  window.api.onTunnelStopped(() => { resetTunnelUI(); state.tunnelUrl = ''; });

  // Un enregistrement programmé vient de démarrer.
  window.api.onScheduleFired((data) => {
    refreshScheduleList();
    refreshActiveRecordings();
    // Si l'utilisateur regarde la chaîne concernée, on bascule sur le flux local.
    const watching = state.current && (state.current.name === data.name);
    beginRecUI({ id: data.id, name: data.name, startedRelay: data.startedRelay, local: data.local, durationSec: data.durationSec }, watching);
    try { new Notification('⏺ Enregistrement programmé démarré', { body: data.name }); } catch {}
  });
  window.api.onScheduleError((data) => {
    refreshScheduleList();
    console.error('schedule:', data.error);
    try { new Notification('⚠ Enregistrement programmé échoué', { body: (data.name || '') + ' — ' + data.error }); } catch {}
  });

  window.api.onRecordStopped((data) => {
    stopRecUI();
    refreshActiveRecordings();
    if (data.startedRelay && !state.relaying) {
      window.api.relayStop();
      resumeDirect();
    }
    if (data.file) {
      state.lastRecFile = data.file;
      if (getAskWa() && confirm('Enregistrement terminé.\n\nL\'exporter maintenant pour WhatsApp (son garanti + 30 fps) ?')) {
        exportWhatsapp(data.file);
      }
    }
  });

  // État initial de la pastille des enregistrements programmés
  refreshScheduleList();

  // Reconnexion automatique au lancement si des identifiants sont mémorisés
  if (autoConnect) connect();
});

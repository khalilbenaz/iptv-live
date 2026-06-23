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
  recBadgeMin: localStorage.getItem('rec_badge_min') !== '0', // badge détaillé réduit ? (réduit par défaut)
  recStartedRelay: false,
  relaying: false,
  relayLan: '',
  tunnelUrl: '',
  favs: [],         // chaînes favorites {stream_id, name, stream_icon}
  watched: {},      // contenus vus : { 'movie:id'|'series:epId': timestamp }
  recent: [],       // vu récemment / historique
  reminders: [],    // rappels de programme {id, streamId, name, icon, cat, title, startAt}
  // navigation
  view: 'home',     // vue affichée
  browse: 'home',   // dernière vue de navigation (pour le retour depuis le lecteur)
  // VOD / séries
  vod: null, vodCats: [],
  series: null, seriesCats: [],
  vodPage: 1, seriesPage: 1,   // pagination des grilles films / séries
  resumeKey: null,   // clé de reprise du contenu en cours (VOD / série)
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
/* ---------- Vu / déjà visionné (films & séries) ---------- */
function loadWatched() { try { state.watched = JSON.parse(localStorage.getItem('iptv_watched') || '{}'); } catch { state.watched = {}; } }
function saveWatched() { try { localStorage.setItem('iptv_watched', JSON.stringify(state.watched)); } catch {} }
function isWatched(key) { return !!(key && state.watched && state.watched[key]); }
function setWatched(key, on) {
  if (!key) return;
  if (!state.watched) state.watched = {};
  if (on) state.watched[key] = Date.now(); else delete state.watched[key];
  saveWatched();
}
function toggleWatched(key) { setWatched(key, !isWatched(key)); }
function isSeasonWatched(eps) { return !!(eps && eps.length && eps.every((ep) => isWatched('series:' + ep.id))); }
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
function saveRecent() { try { localStorage.setItem('iptv_recent', JSON.stringify(state.recent.slice(0, 100))); } catch {} }
function pushRecent(item) {
  state.recent = state.recent.filter((r) => !(r.type === item.type && r.id == item.id));
  state.recent.unshift(Object.assign({ at: Date.now() }, item));
  state.recent = state.recent.slice(0, 100);   // conservé pour l'historique de visionnage
  saveRecent();
}

/* ---------- Rappels de programme (EPG) ---------- */
function loadReminders() {
  try { state.reminders = JSON.parse(localStorage.getItem('iptv_reminders') || '[]'); }
  catch { state.reminders = []; }
}
function saveReminders() { try { localStorage.setItem('iptv_reminders', JSON.stringify(state.reminders)); } catch {} }
function reminderId(streamId, startAt) { return String(streamId) + '@' + startAt; }
function isReminded(streamId, startAt) { return state.reminders.some((r) => r.id === reminderId(streamId, startAt)); }
function toggleReminder(channel, prog) {
  const id = reminderId(channel.stream_id, prog.st);
  if (isReminded(channel.stream_id, prog.st)) {
    state.reminders = state.reminders.filter((r) => r.id !== id);
  } else {
    state.reminders.push({ id, streamId: channel.stream_id, name: channel.name, icon: channel.stream_icon || channel.icon || '', cat: channel.category_id, title: prog.title, startAt: prog.st * 1000 });
    if (typeof ktvToast === 'function') ktvToast('🔔 Rappel ajouté : ' + prog.title);
  }
  saveReminders();
  armReminders();
}
const reminderTimers = [];
function armReminders() {
  while (reminderTimers.length) clearTimeout(reminderTimers.pop());
  const now = Date.now();
  // purge les rappels passés (> 5 min après le début)
  state.reminders = (state.reminders || []).filter((r) => r.startAt > now - 300000);
  saveReminders();
  for (const r of state.reminders) {
    const delay = r.startAt - now;
    if (delay <= 0) { fireReminder(r); continue; }
    if (delay > 25 * 86400000) continue;                 // setTimeout max ~24.8 j
    reminderTimers.push(setTimeout(() => fireReminder(r), delay));
  }
}
function fireReminder(r) {
  state.reminders = state.reminders.filter((x) => x.id !== r.id);
  saveReminders();
  const open = () => { showView('live'); play({ stream_id: r.streamId, name: r.name, stream_icon: r.icon, category_id: r.cat }); };
  try {
    const n = new Notification('🔔 ' + r.title, { body: 'Commence maintenant sur ' + (r.name || 'la chaîne') });
    n.onclick = () => { try { window.focus(); } catch {} open(); };
  } catch {}
  if (typeof ktvToast === 'function') ktvToast('🔔 « ' + r.title +' » commence sur ' + (r.name || ''));
}

/* ---------- Profils (multi-fournisseurs) ---------- */
function profileId(srv, usr) { return (srv + '|' + usr).toLowerCase(); }
function profileLabel(srv, usr) {
  try { return usr + ' @ ' + new URL(/^https?:\/\//i.test(srv) ? srv : 'http://' + srv).host; }
  catch { return usr; }
}
function loadProfiles() {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem('xtream_profiles') || '[]'); } catch {}
  if (!Array.isArray(arr)) arr = [];
  // Migration de l'ancien format mono-compte (clé « xtream »).
  if (!arr.length) {
    try {
      const legacy = JSON.parse(localStorage.getItem('xtream') || 'null');
      if (legacy && legacy.srv && legacy.usr && legacy.pwd) {
        arr = [{ id: profileId(legacy.srv, legacy.usr), label: profileLabel(legacy.srv, legacy.usr), srv: legacy.srv, usr: legacy.usr, pwd: legacy.pwd }];
        localStorage.setItem('xtream_profiles', JSON.stringify(arr));
      }
    } catch {}
  }
  return arr;
}
function saveProfiles(arr) { try { localStorage.setItem('xtream_profiles', JSON.stringify(arr)); } catch {} }
function upsertProfile(srv, usr, pwd) {
  const arr = loadProfiles();
  const id = profileId(srv, usr);
  const entry = { id, label: profileLabel(srv, usr), srv, usr, pwd };
  const i = arr.findIndex((p) => p.id === id);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  saveProfiles(arr);
  localStorage.setItem('xtream_active', id);
}
function removeProfile(id) {
  saveProfiles(loadProfiles().filter((p) => p.id !== id));
  if (localStorage.getItem('xtream_active') === id) localStorage.removeItem('xtream_active');
  renderLoginProfiles();
}
function renderLoginProfiles() {
  const box = $('loginProfiles');
  if (!box) return;
  const arr = loadProfiles();
  box.innerHTML = '';
  if (!arr.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  arr.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'profile-chip';
    el.innerHTML = '<span class="pc-ic">👤</span><div class="pc-body"><div class="pc-name"></div><div class="pc-srv"></div></div><button class="pc-del" title="Supprimer ce profil">✕</button>';
    el.querySelector('.pc-name').textContent = p.label || p.usr;
    el.querySelector('.pc-srv').textContent = p.srv;
    el.onclick = () => { $('srv').value = p.srv; $('usr').value = p.usr; $('pwd').value = p.pwd; connect(); };
    el.querySelector('.pc-del').onclick = (ev) => { ev.stopPropagation(); removeProfile(p.id); };
    box.appendChild(el);
  });
  const or = document.createElement('div');
  or.className = 'login-or'; or.textContent = '— ou nouveau compte —';
  box.appendChild(or);
}
// Vide les caches de contenu (au changement de fournisseur).
function resetProviderState() {
  state.categories = []; state.channels = []; state.allByCat = {};
  state.vod = null; state.vodCats = []; state.series = null; state.seriesCats = [];
  state.epgCache = {}; state.current = null; state.playQueue = null;
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
    resetProviderState();
    upsertProfile(s, usr, pwd);
    try {
      window.api.setProviderEpg(`${apiBase()}/xmltv.php?username=${encodeURIComponent(usr)}&password=${encodeURIComponent(pwd)}`);
    } catch {}
    await loadCategories();
    try { if (typeof ktvApplySources === 'function') await ktvApplySources(); } catch {}
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
  // Les favoris ne sont plus en tête du sélecteur : ils ont leur propre rail
  // dédié au-dessus de la liste (voir #liveFavRail / ktvRenderLiveFavs).
  fillCatSelect($('catSelect'), false);
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
  if (typeof ktvStopPreview === 'function') ktvStopPreview();   // coupe l'aperçu au survol
  if (typeof hideGpTip === 'function') hideGpTip();
  // Quitter le lecteur coupe la lecture (sinon le son continue en arrière-plan)
  if (leaving === 'player' && name !== 'player') {
    destroyPlayer();
    try { window.api.vodRemuxStop(); } catch {}                 // arrête le remux VOD éventuel
    // libère le relais 4K (si pas d'enregistrement/restream en cours)
    if (!state.relaying && !state.recId) { try { window.api.relayStopIdle(); } catch {} }
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
  if (name === 'home') renderHomeDynamic();   // reflète la lecture récente en temps réel
  else if (name === 'live') ensureLive();
  else if (name === 'movies') ensureVod();
  else if (name === 'series') ensureSeries();
  else if (name === 'guide') ensureGuide();
  else if (name === 'history') buildHistory();
  else if (name === 'recordings') loadRecordings();
  else if (name === 'settings') buildSettings();
}

function onSearch() {
  // Recherche globale (chaînes + films + séries + EPG) gérée par features.js.
  if (typeof ktvSearchInput === 'function') return ktvSearchInput();
  if (state.view === 'live') renderLiveGrid();
  else if (state.view === 'movies') { state.vodPage = 1; renderMovies(); }
  else if (state.view === 'series') { state.seriesPage = 1; renderSeries(); }
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
  if (typeof ktvRenderLiveFavs === 'function') ktvRenderLiveFavs();
  if (typeof ktvWireHoverPreview === 'function') ktvWireHoverPreview();
}

// Carte chaîne (live grid + accueil). epgLazy = charger EPG quand visible.
function channelCard(c, epgLazy) {
  const card = document.createElement('div');
  card.className = 'chan-card';
  card.dataset.id = c.stream_id;
  card._ch = c;                       // réf. chaîne pour l'aperçu au survol
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
    if (typeof ktvRenderLiveFavs === 'function') ktvRenderLiveFavs();
  };
  head.appendChild(star);
  card.appendChild(head);

  const now = document.createElement('div');
  now.className = 'cc-now'; now.dataset.epg = c.stream_id;
  if (epgLazy) now.innerHTML = '<span class="cc-prog muted">⏳ …</span>';   // placeholder de chargement
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
  if (!e || (!e.cur && !e.next)) { slot.innerHTML = ''; return; }   // pas d'EPG → retire le placeholder
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
  if (typeof ktvTraktApplyWatched === 'function') ktvTraktApplyWatched();   // marque vus depuis Trakt
}

async function ensureVod() {
  if (!state.vod) {
    $('movieGrid').innerHTML = '<div class="loading">Chargement des films…</div>';
    try { await loadVodData(); }
    catch (e) { $('movieGrid').innerHTML = `<div class="loading">Impossible de charger les films : ${escapeHtml(e.message)}</div>`; state.vod = state.vod || []; return; }
  }
  fillContentCat($('vodCat'), state.vodCats, state.vod.length);
  renderMovies();
  const v = document.getElementById('view-movies'); if (v) v.scrollTop = 0;
}

function fillContentCat(sel, cats, total) {
  sel.innerHTML = `<option value="">Toutes les catégories (${total})</option>`;
  for (const c of cats) {
    const o = document.createElement('option');
    o.value = c.category_id; o.textContent = c.category_name;
    sel.appendChild(o);
  }
}

// Hero « à la une » (backdrop TMDB) en tête des vues Films / Séries.
function buildVodHero(m, kind) {
  const IMG = 'https://image.tmdb.org/t/p/';
  const isSeries = kind === 'series';
  const hero = document.createElement('div'); hero.className = 'hero';
  const art = document.createElement('div'); art.className = 'hero-art';
  const poster = m.stream_icon || m.cover; if (poster) art.style.backgroundImage = `url(${poster})`;
  const grad = document.createElement('div'); grad.className = 'hero-grad';
  const info = document.createElement('div'); info.className = 'hero-info';
  const tag = document.createElement('div'); tag.className = 'hero-tag'; tag.textContent = isSeries ? 'SÉRIE À LA UNE' : 'FILM À LA UNE';
  const h1 = document.createElement('h1'); h1.textContent = m.name || '—';
  const meta = document.createElement('div'); meta.className = 'hero-meta';
  if (m.rating && Number(m.rating) > 0) meta.textContent = '★ ' + Number(m.rating).toFixed(1);
  const plot = document.createElement('p'); plot.className = 'hero-plot';
  const btns = document.createElement('div'); btns.className = 'hero-btns';
  const playBtn = document.createElement('button'); playBtn.className = 'btn play'; playBtn.textContent = isSeries ? '▶ Voir la série' : '▶ Regarder';
  playBtn.onclick = () => { if (isSeries) openSeries(m); else (typeof ktvOpenMovie === 'function' ? ktvOpenMovie(m) : playMovie(m)); };
  btns.appendChild(playBtn);
  info.append(tag, h1, meta, plot, btns);
  hero.append(art, grad, info);
  const tmdbOn = (typeof ktvSetting === 'function') && ktvSetting('tmdbEnabled');
  if (tmdbOn && typeof ktvTmdbSearch === 'function') {
    (async () => {
      try {
        const type = isSeries ? 'tv' : 'movie';
        const yr = (!isSeries && typeof yearOf === 'function') ? yearOf(m.name) : undefined;
        const hit = await ktvTmdbSearch(type, m.name, yr);
        if (!hit) return;
        if (hit.backdrop_path) art.style.backgroundImage = `url(${IMG}w1280${hit.backdrop_path})`;
        if (hit.overview) plot.textContent = hit.overview;
        const mb = []; const y = (hit.release_date || hit.first_air_date || '').slice(0, 4); if (y) mb.push(y);
        if (hit.vote_average > 0) mb.push('★ ' + Number(hit.vote_average).toFixed(1));
        if (mb.length) meta.textContent = mb.join('  ·  ');
      } catch {}
    })();
  }
  return hero;
}

// Une vignette pour un rail de showcase (avec rang optionnel).
function vodShowcaseCard(m, kind, rank) {
  const isSeries = kind === 'series';
  const card = posterCard({
    title: m.name, cover: m.stream_icon || m.cover, rating: m.rating,
    progress: isSeries ? 0 : resumeProgress('movie:' + m.stream_id),
    remaining: isSeries ? 0 : resumeRemaining('movie:' + m.stream_id),
    watchedKey: isSeries ? 'serieswatched:' + (m.series_id || m.stream_id) : 'movie:' + m.stream_id,
    onClick: () => (isSeries ? openSeries(m) : (typeof ktvOpenMovie === 'function' ? ktvOpenMovie(m) : playMovie(m))),
    tmdb: isSeries ? { type: 'tv', title: m.name } : { type: 'movie', title: m.name, year: (typeof yearOf === 'function' ? yearOf(m.name) : '') },
  });
  if (rank) { const img = card.querySelector('.p-img'); if (img) { const rk = document.createElement('span'); rk.className = 'rank-badge'; rk.textContent = String(rank); img.appendChild(rk); } }
  return card;
}

// Hero + plusieurs rails (Tendances, Récemment ajoutés, 4K…) en tête de Films / Séries.
// `pool` = liste déjà filtrée par catégorie (les rails restent donc contextuels).
function renderVodShowcase(kind, show, pool) {
  const isSeries = kind === 'series';
  const heroSlot = document.getElementById(isSeries ? 'seriesHero' : 'moviesHero');
  const railSlot = document.getElementById(isSeries ? 'seriesTrending' : 'moviesTrending');
  const all = pool || (isSeries ? state.series : state.vod) || [];
  // Garde : ne rien reconstruire si l'état n'a pas changé (le showcase est global/constant,
  // donc inchangé quand on change juste de catégorie → pas de clignotement ni de saut).
  const sig = show ? ('on:' + all.length) : 'off';
  if (railSlot && railSlot.dataset.sig === sig) return;
  if (heroSlot) { heroSlot.innerHTML = ''; heroSlot.dataset.sig = sig; }
  if (railSlot) { railSlot.innerHTML = ''; railSlot.dataset.sig = sig; }
  if (!show) return;
  if (!all.length) return;
  const rated = all.filter((x) => Number(x.rating) > 0).sort((a, b) => Number(b.rating) - Number(a.rating));
  const featured = rated[0] || all[0];
  if (heroSlot && featured) heroSlot.appendChild(buildVodHero(featured, kind));
  if (!railSlot) return;

  const recent = all.slice().sort((a, b) => (Number(isSeries ? b.last_modified : b.added) || 0) - (Number(isSeries ? a.last_modified : a.added) || 0)).slice(0, 18);
  const uhd = all.filter((x) => { const qy = detectQuality(x.name); return qy === '4K' || qy === '8K'; }).slice(0, 18);
  const fhd = all.filter((x) => detectQuality(x.name) === 'FHD').slice(0, 18);
  const yrOf = (x) => Number((x.releaseDate ? String(x.releaseDate).slice(0, 4) : '') || (typeof yearOf === 'function' ? yearOf(x.name) : '') || 0);
  const released = all.map((x) => ({ x, y: yrOf(x) })).filter((o) => o.y > 1950).sort((a, b) => b.y - a.y).map((o) => o.x).slice(0, 18);

  const addRail = (title, items, numbered) => {
    if (!items || !items.length) return;
    const cards = items.map((m, i) => vodShowcaseCard(m, kind, numbered ? i + 1 : 0));
    railSlot.appendChild(makeRow(title, cards));
  };
  addRail('Tendances', rated.slice(0, 16), true);
  addRail('Dernières sorties', released, false);
  addRail(isSeries ? 'Récemment mises à jour' : 'Récemment ajoutés', recent, false);
  addRail('4K • UHD', uhd, false);
  if (!uhd.length) addRail('Full HD', fhd, false);
}

const PAGE_SIZE = 60;

// Liste de catégories cliquable (chips) pour Films / Séries — synchronisée avec le <select>.
function renderCatChips(kind) {
  const isSeries = kind === 'series';
  const wrap = document.getElementById(isSeries ? 'seriesCatChips' : 'vodCatChips');
  const sel = $(isSeries ? 'seriesCat' : 'vodCat');
  if (!wrap || !sel) return;
  const cats = (isSeries ? state.seriesCats : state.vodCats) || [];
  const cur = sel.value;
  // Si les chips existent déjà et que la liste n'a pas changé : on met juste à jour
  // l'état actif (sans reconstruire → pas de saut de défilement ni de focus).
  const bringIntoView = (active) => {
    if (!active) return;
    const left = active.offsetLeft, right = left + active.offsetWidth;
    if (left < wrap.scrollLeft) wrap.scrollLeft = left - 16;
    else if (right > wrap.scrollLeft + wrap.clientWidth) wrap.scrollLeft = right - wrap.clientWidth + 16;
  };
  if (wrap.children.length === cats.length + 1) {
    let active = null;
    [...wrap.children].forEach((b) => { const on = String(b.dataset.val ?? '') === String(cur); b.classList.toggle('active', on); if (on) active = b; });
    bringIntoView(active);
    return;
  }
  const sl = wrap.scrollLeft;
  wrap.innerHTML = '';
  const mk = (val, label) => {
    const b = document.createElement('button');
    b.className = 'cat-chip' + (String(cur) === String(val) ? ' active' : '');
    b.textContent = label;
    b.dataset.val = val;
    b.onclick = () => {
      sel.value = val;
      if (isSeries) { state.seriesPage = 1; renderSeries(); } else { state.vodPage = 1; renderMovies(); }
    };
    return b;
  };
  wrap.appendChild(mk('', 'Toutes'));
  cats.forEach((c) => wrap.appendChild(mk(c.category_id, c.category_name)));
  wrap.scrollLeft = sl;
}

// Amène le haut de la grille (chips) juste sous le haut de la vue, sans remonter au hero.
function scrollToGridTop(view, target) {
  if (!view || !target) return;
  const top = target.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - 12;
  view.scrollTop = Math.max(0, top);
}

// Barre de pagination (Précédent · pages · Suivant).
function renderPager(containerId, page, totalPages, onGo) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  if (totalPages <= 1) return;
  const btn = (label, target, opts = {}) => {
    const b = document.createElement('button');
    b.className = 'pg-btn' + (opts.active ? ' active' : '');
    b.textContent = label;
    if (opts.disabled) b.disabled = true; else b.onclick = () => onGo(target);
    return b;
  };
  el.appendChild(btn('‹', page - 1, { disabled: page <= 1 }));
  const win = 2;
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= page - win && p <= page + win)) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  pages.forEach((p) => { if (p === '…') { const s = document.createElement('span'); s.className = 'pg-dots'; s.textContent = '…'; el.appendChild(s); } else el.appendChild(btn(String(p), p, { active: p === page })); });
  el.appendChild(btn('›', page + 1, { disabled: page >= totalPages }));
}

function renderMovies() {
  const grid = $('movieGrid');
  const view = grid.closest('.view');
  const gBefore = grid.getBoundingClientRect().top; // ancrage : garder la grille fixe à l'écran
  const cat = $('vodCat').value;
  const q = $('search').value.trim().toLowerCase();
  renderCatChips('movie');
  // Le showcase (hero + rails) reste global et constant ; seule la grille filtre.
  renderVodShowcase('movie', !q, state.vod || []);
  const catItems = (state.vod || []).filter((m) => !cat || m.category_id == cat);
  let items = q ? catItems.filter((m) => (m.name || '').toLowerCase().includes(q)) : catItems;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.vodPage > totalPages) state.vodPage = 1;
  const page = state.vodPage;
  $('movieCount').textContent = `${total} film(s)` + (totalPages > 1 ? ` · page ${page}/${totalPages}` : '');
  grid.innerHTML = '';
  if (!total) { grid.innerHTML = '<div class="loading">Aucun film.</div>'; renderPager('moviePager', 1, 1); return; }
  const frag = document.createDocumentFragment();
  for (const m of items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
    frag.appendChild(posterCard({
      title: m.name, cover: m.stream_icon || m.cover, rating: m.rating,
      progress: resumeProgress('movie:' + m.stream_id), remaining: resumeRemaining('movie:' + m.stream_id),
      watchedKey: 'movie:' + m.stream_id,
      onClick: () => (typeof ktvOpenMovie === 'function' ? ktvOpenMovie(m) : playMovie(m)),
      tmdb: { type: 'movie', title: m.name, year: (typeof yearOf === 'function' ? yearOf(m.name) : '') },
      onDownload: () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); }
    }));
  }
  grid.appendChild(frag);
  renderPager('moviePager', page, totalPages, (p) => { state.vodPage = p; renderMovies(); scrollToGridTop(view, $('vodCatChips') || grid); });
  if (view) { const d = grid.getBoundingClientRect().top - gBefore; if (d) view.scrollTop += d; }
}

function playMovie(m) {
  const ext = m.container_extension || 'mp4';
  pushRecent({ type: 'movie', id: m.stream_id, name: m.name, icon: m.stream_icon || m.cover, ext });
  playMedia(vodUrl(m.stream_id, ext), m.name || 'Film', false, '🎬 Films', 'movie:' + m.stream_id);
  state.nowMeta = { type: 'movie', title: m.name, year: (typeof yearOf === 'function' ? yearOf(m.name) : ''), tmdbId: m._tmdbId };
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
  const v = document.getElementById('view-series'); if (v) v.scrollTop = 0;
}

function renderSeries() {
  const grid = $('seriesGrid');
  const view = grid.closest('.view');
  const gBefore = grid.getBoundingClientRect().top; // ancrage : garder la grille fixe à l'écran
  const cat = $('seriesCat').value;
  const q = $('search').value.trim().toLowerCase();
  renderCatChips('series');
  // Le showcase (hero + rails) reste global et constant ; seule la grille filtre.
  renderVodShowcase('series', !q, state.series || []);
  const catItems = (state.series || []).filter((s) => !cat || s.category_id == cat);
  let items = q ? catItems.filter((s) => (s.name || '').toLowerCase().includes(q)) : catItems;
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.seriesPage > totalPages) state.seriesPage = 1;
  const page = state.seriesPage;
  $('seriesCount').textContent = `${total} série(s)` + (totalPages > 1 ? ` · page ${page}/${totalPages}` : '');
  grid.innerHTML = '';
  if (!total) { grid.innerHTML = '<div class="loading">Aucune série.</div>'; renderPager('seriesPager', 1, 1); return; }
  const frag = document.createDocumentFragment();
  for (const s of items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) {
    frag.appendChild(posterCard({
      title: s.name, cover: s.cover || s.stream_icon, rating: s.rating,
      watchedKey: 'serieswatched:' + (s.series_id || s.stream_id),
      onClick: () => openSeries(s), tmdb: { type: 'tv', title: s.name }
    }));
  }
  grid.appendChild(frag);
  renderPager('seriesPager', page, totalPages, (p) => { state.seriesPage = p; renderSeries(); scrollToGridTop(view, $('seriesCatChips') || grid); });
  if (view) { const d = grid.getBoundingClientRect().top - gBefore; if (d) view.scrollTop += d; }
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
  // Marquer la série entière comme vue (+ synchro Trakt show)
  const swBtn = $('seriesWatched');
  if (swBtn) {
    const swKey = 'serieswatched:' + (s.series_id || s.stream_id);
    const setSw = () => { const on = isWatched(swKey); swBtn.textContent = on ? '✓ Vu' : '☆ Vu'; swBtn.classList.toggle('on', on); };
    setSw();
    swBtn.onclick = () => {
      const nowOn = !isWatched(swKey);
      toggleWatched(swKey); setSw();
      if (typeof ktvTraktSetWatched === 'function') ktvTraktSetWatched({ type: 'show', title: s.name, year: (typeof yearOf === 'function' ? yearOf(s.name) : undefined), tmdbId: curSeries && curSeries._tmdbId }, nowOn);
    };
  }
  $('seriesModal').classList.remove('hidden');
  try {
    const info = await xtreamApi('action=get_series_info&series_id=' + s.series_id);
    curSeries.episodes = (info && info.episodes) || {};
    const plot = (info && info.info && (info.info.plot || info.info.description)) || '';
    $('seriesPlot').textContent = plot || 'Aucune description.';
    if (typeof ktvEnrichSeriesModal === 'function') ktvEnrichSeriesModal(curSeries, info);
    const seasons = Object.keys(curSeries.episodes).sort((a, b) => Number(a) - Number(b));
    if (!seasons.length) { $('episodeList').innerHTML = '<li class="rec-empty">Aucun épisode.</li>'; return; }
    $('seasonSelect').innerHTML = seasons.map((n) => `<option value="${escapeHtml(n)}">Saison ${escapeHtml(n)}${isSeasonWatched(curSeries.episodes[n]) ? ' ✓' : ''}</option>`).join('');
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
    // Marque vu depuis Trakt (appariement série + saison + épisode).
    if (typeof ktvTraktEpWatched === 'function' && !isWatched('series:' + ep.id)
        && ktvTraktEpWatched(curSeries.name, season, ep.episode_num)) setWatched('series:' + ep.id, true);
    const epWatched = isWatched('series:' + ep.id);
    meta.innerHTML = `<span class="ep-t">${escapeHtml(ep.title || ('Épisode ' + ep.episode_num))}${epWatched ? '<span class="ep-watched" title="Vu">✓</span>' : ''}</span><span class="ep-s">${escapeHtml(dur)}</span>`;
    const epProg = resumeProgress('series:' + ep.id);
    if (epProg > 0) {
      meta.appendChild(progressBar('ep-prog', epProg));
      li.classList.add('resuming');
    }
    const n = document.createElement('span');
    n.className = 'ep-n'; n.textContent = String(ep.episode_num || (i + 1));
    const dl = document.createElement('button');
    dl.className = 'ep-dl'; dl.textContent = '⬇'; dl.title = 'Télécharger cet épisode';
    dl.onclick = (ev) => { ev.stopPropagation(); const ext = ep.container_extension || 'mp4'; startDownload(seriesUrl(ep.id, ext), `${curSeries.name} S${season}E${ep.episode_num}`, ext); };
    // Marquer l'épisode comme vu (+ synchro Trakt)
    const ew = document.createElement('button');
    const ewKey = 'series:' + ep.id;
    const setEw = () => { const on = isWatched(ewKey); ew.textContent = on ? '✓' : '☆'; ew.classList.toggle('on', on); };
    ew.className = 'ep-watch'; ew.title = 'Marquer comme vu'; setEw();
    ew.onclick = (ev) => {
      ev.stopPropagation();
      const on = !isWatched(ewKey);
      toggleWatched(ewKey); setEw();
      if (typeof ktvTraktSetWatched === 'function') ktvTraktSetWatched({ type: 'episode', showTitle: curSeries.name, season: Number(season), episode: Number(ep.episode_num), tmdbId: curSeries && curSeries._tmdbId }, on);
    };
    const play = document.createElement('span');
    play.className = 'ep-play'; play.textContent = '▶';
    li.append(n, meta, ew, dl, play);
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
  pushRecent({ type: 'series', id: ep.id, name: label, icon: q.cover, ext, show: q.name, season: Number(q.season), episode: Number(ep.episode_num) });
  $('seriesModal').classList.add('hidden');
  playMedia(seriesUrl(ep.id, ext), label, false, '🎞️ Séries', 'series:' + ep.id);
  state.nowMeta = { type: 'episode', showTitle: q.name, season: Number(q.season), episode: Number(ep.episode_num), tmdbId: curSeries && curSeries._tmdbId };
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
function posterCard({ title, cover, rating, onClick, onDownload, tmdb, progress, remaining, watchedKey }) {
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
  if (remaining && remaining > 60) {
    const left = document.createElement('span');
    left.className = 'p-left'; left.textContent = fmtRemaining(remaining);
    img.appendChild(left);
  }
  if (progress && progress > 0) img.appendChild(progressBar('p-prog', progress));
  if (watchedKey) {
    const setWb = (wb) => { const on = isWatched(watchedKey); wb.classList.toggle('on', on); wb.textContent = on ? '✓ Vu' : '✓'; wb.title = on ? 'Marquer comme non vu' : 'Marquer comme vu'; card.classList.toggle('is-watched', on); };
    const wb = document.createElement('button');
    wb.className = 'p-watch';
    wb.onclick = (ev) => {
      ev.stopPropagation();
      const nowOn = !isWatched(watchedKey);
      toggleWatched(watchedKey); setWb(wb);
      // Synchro Trakt (film ou série entière) — on résout d'abord l'ID TMDB exact
      // (sinon Trakt peut apparier le mauvais titre, ex. une autre « Mentalist »).
      if (tmdb && typeof ktvTraktSetWatched === 'function') {
        const isTv = tmdb.type === 'tv';
        const sync = (id) => ktvTraktSetWatched(isTv ? { type: 'show', title: tmdb.title, tmdbId: id } : { type: 'movie', title: tmdb.title, year: tmdb.year, tmdbId: id }, nowOn);
        if (typeof ktvTmdbSearch === 'function') ktvTmdbSearch(isTv ? 'tv' : 'movie', tmdb.title, tmdb.year).then((h) => sync(h && h.id)).catch(() => sync(null));
        else sync(null);
      }
    };
    img.appendChild(wb); setWb(wb);
  }
  const t = document.createElement('div');
  t.className = 'p-title'; t.textContent = title || '—';
  card.appendChild(img); card.appendChild(t);
  card.onclick = onClick;
  if (tmdb && typeof ktvPosterEnrich === 'function') ktvPosterEnrich(card, tmdb);
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
      `<span class="g-name">${escapeHtml(c.name || ('Chaîne ' + c.stream_id))}</span>` +
      `<button class="g-catchup" title="Rediffusions (catch-up)">⏪</button>` +
      `</div>` +
      `<div class="g-progs"><span class="muted">…</span></div>`;
    const im = row.querySelector('img');
    if (im) im.onerror = () => { im.replaceWith(document.createTextNode(initials(c.name))); };
    row.querySelector('.g-ch').onclick = () => play(c);
    const cu = row.querySelector('.g-catchup');
    if (cu) cu.onclick = (e) => { e.stopPropagation(); if (typeof ktvOpenCatchup === 'function') ktvOpenCatchup(c); };
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
      .map((x) => ({ title: decodeEpg(x.title), desc: decodeEpg(x.description || ''), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st).sort((a, b) => a.st - b.st));
  } catch {}
  if (!progs.length) {
    const e = await getChannelEpg(c);
    if (e && e.cur) progs = [e.cur, e.next].filter(Boolean);
  }
  if (!progs.length) { slot.innerHTML = '<span class="muted">Pas de programme</span>'; return; }
  // Enrichissement : si le fournisseur ne donne pas de description, on complète
  // depuis le XMLTV (provider xmltv.php / sources XMLTV) en appariant par horaire.
  if (progs.some((p) => !p.desc)) {
    try {
      const xpl = await window.api.epgPrograms(c.name, c.epg_channel_id);
      if (xpl && xpl.length) {
        for (const p of progs) {
          if (p.desc) continue;
          const x = xpl.find((q) => Math.abs(q.st - p.st) <= 300)
            || xpl.find((q) => q.title && p.title && q.title.toLowerCase() === p.title.toLowerCase());
          if (x && x.desc) p.desc = x.desc;
        }
      }
    } catch {}
  }
  const now = Date.now() / 1000;
  slot.innerHTML = '';
  const canArch = typeof chHasArchive === 'function' && chHasArchive(c);
  for (const p of progs.slice(0, 6)) {
    const live = p.st <= now && now < (p.en || p.st);
    const past = (p.en || p.st) <= now;
    const archive = past && canArch;
    const block = document.createElement('div');
    block.className = 'g-prog' + (live ? ' live' : '') + (archive ? ' archive' : '');
    const span = (p.en && p.en > p.st) ? Math.round((p.en - p.st) / 60) : 0;
    block.style.flex = span ? Math.max(1, Math.min(6, span / 30)) : 1;
    const range = p.en && p.en > p.st ? `${epgTime(p.st)} – ${epgTime(p.en)}` : epgTime(p.st);
    block.innerHTML = `<span class="gp-t">${live ? '🔴 ' : (archive ? '⏪ ' : '')}${escapeHtml(p.title)}</span>` +
      `<span class="gp-h">${range}</span>` +
      (p.desc ? `<span class="gp-d">${escapeHtml(p.desc)}</span>` : '');
    if (live && p.en > p.st) {
      const pct = Math.round(((now - p.st) / (p.en - p.st)) * 100);
      block.innerHTML += `<div class="gp-bar"><i style="width:${pct}%"></i></div>`;
    }
    block.title = (archive ? '⏪ Revoir (catch-up)' : '');
    block.onclick = archive ? (() => ktvPlayArchive(c, p)) : (() => play(c));
    // Survol : affiche le synopsis complet (popover) — le bloc le tronque à 2 lignes.
    if (p.desc) {
      block.addEventListener('mouseenter', () => showGpTip(block, p, range));
      block.addEventListener('mouseleave', hideGpTip);
    }
    // Programme à venir : bouton « Me rappeler » 🔔
    if (p.st > now) {
      const rb = document.createElement('button');
      rb.className = 'gp-rem' + (isReminded(c.stream_id, p.st) ? ' on' : '');
      rb.textContent = '🔔';
      rb.title = 'Me rappeler quand ça commence';
      rb.onclick = (ev) => { ev.stopPropagation(); toggleReminder(c, p); rb.classList.toggle('on', isReminded(c.stream_id, p.st)); };
      block.appendChild(rb);
    }
    slot.appendChild(block);
  }
}

// Popover du synopsis complet au survol d'un programme du Guide.
let gpTipEl = null;
function showGpTip(block, p, range) {
  if (!gpTipEl) {
    gpTipEl = document.createElement('div');
    gpTipEl.id = 'gpTip'; gpTipEl.className = 'gp-tip';
    document.body.appendChild(gpTipEl);
    window.addEventListener('scroll', hideGpTip, true);
  }
  gpTipEl.innerHTML = `<div class="gp-tip-t">${escapeHtml(p.title)}</div>` +
    `<div class="gp-tip-h">${escapeHtml(range || '')}</div>` +
    `<div class="gp-tip-d">${escapeHtml(p.desc)}</div>`;
  gpTipEl.classList.add('show');
  const r = block.getBoundingClientRect();
  const W = 340, M = 10;
  gpTipEl.style.width = W + 'px';
  let left = Math.min(Math.max(M, r.left), window.innerWidth - W - M);
  gpTipEl.style.left = left + 'px';
  // au-dessus si la place manque en bas
  const h = gpTipEl.offsetHeight || 140;
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - M) top = Math.max(M, r.top - h - 8);
  gpTipEl.style.top = top + 'px';
}
function hideGpTip() { if (gpTipEl) gpTipEl.classList.remove('show'); }

/* ---------- ACCUEIL ---------- */
// Catégories choisies pour l'accueil : [{kind:'live'|'movie'|'series', id, name}]
function loadHomeCats() { try { return JSON.parse(localStorage.getItem('home_cats') || '[]'); } catch { return []; } }
function saveHomeCats(arr) { try { localStorage.setItem('home_cats', JSON.stringify(arr)); } catch {} }

// Zone dynamique de l'accueil (hero « Reprendre » + rangées récents/favoris).
// Ne dépend QUE de l'état local (state.recent / state.favs) → aucun réseau,
// rafraîchie à chaque visite de l'accueil pour refléter la lecture en temps réel.
function renderHomeDynamic(dyn) {
  dyn = dyn || document.getElementById('homeDynamic');
  if (!dyn) return;
  dyn.innerHTML = '';
  // Hero : reprend le 1er "vu récemment" ou 1er favori
  const heroItem = state.recent[0] || (state.favs[0] && { type: 'live', id: state.favs[0].stream_id, name: state.favs[0].name, icon: state.favs[0].stream_icon });
  if (heroItem) dyn.appendChild(buildHero(heroItem));
  if (state.recent.length) dyn.appendChild(makeRow('Reprendre la lecture', state.recent.slice(0, 18).map(recentCard), () => showView('history')));
  if (state.favs.length) dyn.appendChild(makeRow('Chaînes favorites', state.favs.map((f) => channelCard(f, false)), () => {
    showView('live');
    const rail = $('liveFavRail');
    if (rail) rail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// Vue Historique : tout le « vu récemment » (jusqu'à 100), reprise rapide,
// chargement progressif (infinite loading) par lots.
let historyObs = null;
function fmtWatchDate(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "Aujourd'hui · " + hm;
  if (sameDay(d, yest)) return 'Hier · ' + hm;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' · ' + hm;
}
function buildHistory() {
  const grid = $('historyGrid');
  if (!grid) return;
  if (historyObs) { historyObs.disconnect(); historyObs = null; }
  grid.innerHTML = '';
  if (!state.recent.length) { grid.innerHTML = '<p class="muted">Aucun historique pour le moment.</p>'; return; }
  // Trié par date de visionnage (plus récent d'abord).
  const items = state.recent.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const BATCH = 24;
  let shown = 0;
  const sentinel = document.createElement('div');
  sentinel.style.cssText = 'grid-column:1/-1;height:1px;';
  const renderMore = () => {
    const frag = document.createDocumentFragment();
    items.slice(shown, shown + BATCH).forEach((r) => {
      const card = recentCard(r);
      const dt = document.createElement('div'); dt.className = 'rc-date';
      dt.textContent = r.at ? ('🕘 ' + fmtWatchDate(r.at)) : '🕘 Vu récemment';
      card.appendChild(dt);
      frag.appendChild(card);
    });
    grid.insertBefore(frag, sentinel);
    shown += BATCH;
    if (shown >= items.length && historyObs) historyObs.disconnect();
    if (typeof ktvWireHoverPreview === 'function') ktvWireHoverPreview();   // aperçu au survol
  };
  grid.appendChild(sentinel);
  renderMore();
  if ('IntersectionObserver' in window) {
    historyObs = new IntersectionObserver((es) => {
      if (es[0].isIntersecting && shown < items.length) renderMore();
    }, { rootMargin: '300px' });
    historyObs.observe(sentinel);
  }
}

function buildHome() {
  const root = $('homeRows');
  root.innerHTML = '';

  // Partie dynamique (mise à jour à chaque retour sur l'accueil)
  const dyn = document.createElement('div');
  dyn.id = 'homeDynamic';
  root.appendChild(dyn);
  renderHomeDynamic(dyn);

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
          progress: resumeProgress('movie:' + m.stream_id), remaining: resumeRemaining('movie:' + m.stream_id),
          watchedKey: 'movie:' + m.stream_id,
          onClick: () => (typeof ktvOpenMovie === 'function' ? ktvOpenMovie(m) : playMovie(m)),
          tmdb: { type: 'movie', title: m.name, year: (typeof yearOf === 'function' ? yearOf(m.name) : '') },
          onDownload: () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); }
        }))); else row.remove();
      } else {
        await loadSeriesData();
        const items = (state.series || []).filter((s) => String(s.category_id) === String(c.id)).slice(0, 20);
        if (items.length) setRowCards(row, items.map((s) => posterCard({ title: s.name, cover: s.cover || s.stream_icon, rating: s.rating, watchedKey: 'serieswatched:' + (s.series_id || s.stream_id), onClick: () => openSeries(s), tmdb: { type: 'tv', title: s.name } }))); else row.remove();
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
    if (recent.length) setRowCards(moviesRow, recent.map((m) => posterCard({ title: m.name, cover: m.stream_icon || m.cover, rating: m.rating, progress: resumeProgress('movie:' + m.stream_id), remaining: resumeRemaining('movie:' + m.stream_id), watchedKey: 'movie:' + m.stream_id, onClick: () => (typeof ktvOpenMovie === 'function' ? ktvOpenMovie(m) : playMovie(m)), tmdb: { type: 'movie', title: m.name, year: (typeof yearOf === 'function' ? yearOf(m.name) : '') } })));
    else moviesRow.remove();
  } catch { moviesRow.remove(); }
  try {
    await loadSeriesData();
    const recent = [...(state.series || [])].sort((a, b) => (Number(b.last_modified) || 0) - (Number(a.last_modified) || 0)).slice(0, 18);
    if (recent.length) setRowCards(seriesRow, recent.map((s) => posterCard({ title: s.name, cover: s.cover || s.stream_icon, rating: s.rating, watchedKey: 'serieswatched:' + (s.series_id || s.stream_id), onClick: () => openSeries(s), tmdb: { type: 'tv', title: s.name } })));
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
  // Aperçu au survol (accueil) : seulement pour les chaînes live (flux .ts/mpegts).
  if (r.type === 'live') card._ch = { stream_id: r.id, name: r.name, stream_icon: r.icon };
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
  // Saison / épisode pour les séries : champs dédiés, sinon parsés du titre (anciennes entrées).
  let se = null;
  if (r.type === 'series') {
    if (r.season != null && r.episode != null) se = { s: r.season, e: r.episode };
    else { const m = /S(\d+)\s*E(\d+)/i.exec(r.name || ''); if (m) se = { s: Number(m[1]), e: Number(m[2]) }; }
  }
  if (se) {
    const ep = document.createElement('span');
    ep.className = 'rc-ep';
    ep.textContent = `S${se.s} · E${se.e}`;
    th.appendChild(ep);
  }
  const key = recentResumeKey(r);
  const prog = key ? resumeProgress(key) : 0;
  const remain = key ? resumeRemaining(key) : 0;
  if (remain > 60) {
    const left = document.createElement('span');
    left.className = 'rc-left';
    left.textContent = fmtRemaining(remain);
    th.appendChild(left);
  }
  if (prog > 0) th.appendChild(progressBar('rc-prog', prog));
  const t = document.createElement('div');
  t.className = 'rc-title';
  t.textContent = (r.type === 'series' && r.show) ? r.show : (r.name || '—');
  card.appendChild(th); card.appendChild(t);
  // Sous-titre « Continue - S01, E02 » (séries) ou « Reprendre » (films en cours)
  let subTxt = '';
  if (se) subTxt = `Continuer · S${String(se.s).padStart(2, '0')}, E${String(se.e).padStart(2, '0')}`;
  else if (r.type === 'movie' && prog > 0) subTxt = 'Continuer le film';
  else if (r.type === 'live') subTxt = 'En direct';
  if (subTxt) {
    const sub = document.createElement('div'); sub.className = 'rc-sub'; sub.textContent = subTxt; card.appendChild(sub);
    // Chaînes live : remplace « En direct » par le programme EPG en cours (async).
    if (r.type === 'live') {
      getChannelEpg({ stream_id: r.id, name: r.name }).then((e) => {
        if (e && e.cur && e.cur.title) { sub.textContent = '▶ ' + e.cur.title; sub.title = e.cur.title; }
      }).catch(() => {});
    }
  }
  card.onclick = () => {
    if (r.type === 'live') play({ stream_id: r.id, name: r.name, stream_icon: r.icon, category_id: r.cat });
    else playMedia(r.type === 'movie' ? vodUrl(r.id, r.ext) : seriesUrl(r.id, r.ext), r.name, false, r.type === 'movie' ? '🎬 Films' : '🎞️ Séries', key);
  };
  return card;
}

function buildHero(item) {
  const IMG = 'https://image.tmdb.org/t/p/';
  const hero = document.createElement('div');
  hero.className = 'hero';
  const live = item.type === 'live';
  const isSeries = item.type === 'series';
  const key = recentResumeKey(item);
  const prog = key ? resumeProgress(key) : 0;
  const remain = key ? resumeRemaining(key) : 0;

  const art = document.createElement('div'); art.className = 'hero-art';
  if (live) {
    // Pas de backdrop pour les chaînes → dégradé de marque + logo centré (au lieu
    // d'un logo étiré en fond, qui rendait le hero tout noir).
    art.classList.add('hero-art--live');
    if (item.icon) {
      const logo = document.createElement('img'); logo.className = 'hero-logo';
      logo.src = item.icon; logo.onerror = () => logo.remove();
      art.appendChild(logo);
    }
  } else if (item.icon) {
    art.style.backgroundImage = `url(${item.icon})`;
  }
  const grad = document.createElement('div'); grad.className = 'hero-grad';
  const info = document.createElement('div'); info.className = 'hero-info';

  const tag = document.createElement('div'); tag.className = 'hero-tag';
  tag.textContent = live ? '● EN DIRECT' : (item.type === 'movie' ? 'FILM' : 'SÉRIE');
  const h1 = document.createElement('h1');
  h1.textContent = (isSeries && item.show) ? item.show : (item.name || '—');
  info.append(tag, h1);

  // Saison / épisode (séries)
  let se = null;
  if (isSeries) {
    if (item.season != null && item.episode != null) se = { s: item.season, e: item.episode };
    else { const m = /S(\d+)\s*E(\d+)/i.exec(item.name || ''); if (m) se = { s: Number(m[1]), e: Number(m[2]) }; }
  }
  if (se) { const sub = document.createElement('div'); sub.className = 'hero-se'; sub.textContent = `S${String(se.s).padStart(2, '0')}, E${String(se.e).padStart(2, '0')}`; info.appendChild(sub); }

  // Barre de progression + temps restant
  if (!live && (prog > 0 || remain > 60)) {
    const wrap = document.createElement('div'); wrap.className = 'hero-prog-wrap';
    wrap.appendChild(progressBar('hero-prog', prog > 0 ? prog : 0.02));
    if (remain > 60) { const rl = document.createElement('span'); rl.className = 'hero-remain'; rl.textContent = fmtRemaining(remain).replace('⏳ ', '') + ' restant'; wrap.appendChild(rl); }
    info.appendChild(wrap);
  }

  const plot = document.createElement('p'); plot.className = 'hero-plot';
  info.appendChild(plot);

  // Chaîne live : programme EPG en cours (titre + description) + suivant.
  if (live) {
    plot.textContent = '⏳ Chargement du programme…';
    getChannelEpg({ stream_id: item.id, name: item.name }).then((e) => {
      if (!e || !e.cur) { plot.textContent = ''; return; }
      let t = '▶ ' + e.cur.title;
      if (e.cur.desc) t += ' — ' + e.cur.desc;
      if (e.next) t += `\n⏭ ${e.next.title}`;
      plot.textContent = t;
      plot.style.whiteSpace = 'pre-line';
    }).catch(() => { plot.textContent = ''; });
  }

  const btns = document.createElement('div'); btns.className = 'hero-btns';
  const playBtn = document.createElement('button'); playBtn.className = 'btn play';
  playBtn.textContent = (!live && prog > 0) ? '▶ Reprendre' : '▶ Regarder';
  playBtn.onclick = () => {
    if (live) play({ stream_id: item.id, name: item.name, stream_icon: item.icon, category_id: item.cat });
    else playMedia(item.type === 'movie' ? vodUrl(item.id, item.ext) : seriesUrl(item.id, item.ext), item.name, false, item.type === 'movie' ? '🎬 Films' : '🎞️ Séries', key);
  };
  btns.appendChild(playBtn);
  info.appendChild(btns);

  hero.append(art, grad, info);

  // Enrichissement TMDB (backdrop plein cadre + synopsis + bande-annonce)
  const tmdbOn = (typeof ktvSetting === 'function') && ktvSetting('tmdbEnabled');
  if (!live && tmdbOn && typeof ktvTmdbSearch === 'function') {
    (async () => {
      try {
        const type = isSeries ? 'tv' : 'movie';
        const title = (isSeries && item.show) ? item.show : (item.name || '').replace(/\s*·\s*S\d+E\d+.*$/i, '');
        const yr = (!isSeries && typeof yearOf === 'function') ? yearOf(item.name) : undefined;
        const hit = await ktvTmdbSearch(type, title, yr);
        if (!hit) return;
        if (hit.backdrop_path) art.style.backgroundImage = `url(${IMG}w1280${hit.backdrop_path})`;
        if (hit.overview && !plot.textContent) plot.textContent = hit.overview;
      } catch {}
    })();
  }
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
  try { v.pause(); v.removeAttribute('src'); v.onerror = null; v.load(); } catch {}
}

// Lecture VOD / épisode (fichier direct)
// Conteneurs que Chromium ne sait pas ouvrir → passage par le relais VOD (remux/transcode).
function isRemuxContainer(url) {
  return /\.(mkv|avi|wmv|flv|m2ts|mts|vob|ogm|divx|mpg|mpeg|3gp|rmvb)(\?|$)/i.test(String(url || ''));
}
// Lecture d'un fichier non lisible nativement : ffmpeg le convertit en HLS local (relais VOD).
async function startRemuxPlayback(url, title, crumb, resumeKey) {
  if (state.relaying) stopRelay();
  enterPlayer(crumb || title, false);
  $('chanSidebar').classList.add('hidden'); $('sidebarToggle').classList.add('hidden');
  $('nowTitle').textContent = title || '—';
  $('nowEpg').textContent = ''; epgReq++;
  $('recBtn').disabled = true; $('relayBtn').disabled = true; $('scheduleBtn').disabled = true;
  destroyPlayer();
  $('overlay').classList.remove('hidden');
  $('overlay').textContent = '⚙️ Préparation de la lecture (conversion du format)…';
  try {
    const r = await window.api.vodRemux(url, title);
    if (state.view !== 'player') { try { window.api.vodRemuxStop(); } catch {} return; }   // l'utilisateur a quitté
    if (!r || !r.local) throw new Error((r && r.error) || 'échec');
    $('overlay').classList.add('hidden');
    playMedia(r.local, title, false, crumb, resumeKey);
  } catch (e) {
    $('overlay').classList.remove('hidden');
    $('overlay').textContent = 'Lecture impossible (format non supporté). Essaie d’ouvrir le fichier dans VLC. ' + (e && e.message ? '(' + e.message + ')' : '');
  }
}

function playMedia(url, title, isLive, crumb, resumeKey) {
  // Conteneur non lisible par Chromium → conversion via le relais VOD (sauf flux local déjà converti).
  if (!isLive && isRemuxContainer(url) && !String(url).startsWith('http://127.0.0.1:')) {
    return startRemuxPlayback(url, title, crumb, resumeKey);
  }
  state.current = null;
  state.playQueue = null;
  state.nowMeta = (typeof ktvMetaFromPlay === 'function') ? ktvMetaFromPlay(resumeKey, title) : null;
  state.scrobbled = false;
  state.resumeKey = resumeKey || null;
  resetPlayerTools();
  enterPlayer(crumb || title, false);
  $('chanSidebar').classList.add('hidden');
  $('sidebarToggle').classList.add('hidden');
  $('nowTitle').textContent = title || '—';
  $('nowEpg').textContent = ''; epgReq++;   // invalide un loadEpg live en attente (sinon l'EPG d'une chaîne précédente s'affiche sur le film)
  $('overlay').classList.add('hidden');
  $('recBtn').disabled = true; $('relayBtn').disabled = true; $('scheduleBtn').disabled = true;
  if (state.relaying) stopRelay();
  // Lecture d'un flux normal → on libère un remux VOD éventuellement resté actif.
  if (!String(url).startsWith('http://127.0.0.1:')) { try { window.api.vodRemuxStop(); } catch {} }
  destroyPlayer();
  const v = $('video');
  suppressResume = false;
  v._remuxTried = false;
  v.onerror = () => {
    // Codec non décodé (ex. HEVC) sur un conteneur a priori lisible → on tente une conversion.
    if (!isLive && !v._remuxTried && !String(url).startsWith('http://127.0.0.1:')) {
      v._remuxTried = true;
      startRemuxPlayback(url, title, crumb, resumeKey);
      return;
    }
    $('overlay').classList.remove('hidden');
    $('overlay').textContent = 'Lecture impossible : format non supporté par le lecteur (souvent .mkv/.avi). Ouvre le fichier dans VLC.';
  };
  if (/\.m3u8(\?|$)/i.test(url) && window.Hls && Hls.isSupported()) {
    const hls = new Hls(typeof ktvHlsConfig === 'function' ? ktvHlsConfig() : {});
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
  if (!channel._noXtreamEpg) try {
    const data = await xtreamApi('action=get_short_epg&stream_id=' + channel.stream_id + '&limit=6');
    const items = (((data && data.epg_listings) || [])
      .map((x) => ({ title: decodeEpg(x.title), desc: decodeEpg(x.description || ''), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
      .filter((p) => p.title && p.st).sort((a, b) => a.st - b.st));
    if (items.length) {
      const now = Date.now() / 1000;
      result = { cur: items.find((p) => p.st <= now && now < (p.en || p.st + 3600)) || null, next: items.find((p) => p.st > now) || null, src: 'xtream' };
    }
  } catch {}
  // Repli XMLTV si AUCUN résultat, OU si le fournisseur n'a pas de programme EN COURS
  // (cur=null) : certaines grilles Xtream ont des trous (ex. TF1) alors que le XMLTV
  // a bien le programme du moment.
  if (!result || !result.cur) {
    try {
      const r = await window.api.epgLookup(channel.name, channel.epg_channel_id);
      if (r && (r.cur || r.next)) {
        if (!result) result = { cur: r.cur, next: r.next, src: 'xmltv' };
        else { result.cur = result.cur || r.cur; result.next = result.next || r.next; }
      }
    } catch {}
  }
  // On ne met en cache que si on a un programme en cours (sinon on retentera).
  if (result && result.cur) state.epgCache[channel.stream_id] = result;
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
async function play(channel) {
  try { window.api.vodRemuxStop(); } catch {}              // libère un remux VOD éventuel
  // Garde "1 connexion" : si un enregistrement tourne, on ne peut pas ouvrir
  // un 2e flux fournisseur.
  if (state.recId) {
    // Comparer par stream_id (les noms se répètent entre catégories/sources, BUG-F) ;
    // repli sur le nom si l'id de la chaîne enregistrée est inconnu.
    const sameChannel = state.recStreamId != null
      ? channel.stream_id == state.recStreamId
      : (state.recChannelName && channel.name === state.recChannelName);
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
  state.resumeKey = null;
  state.nowMeta = null;
  resetPlayerTools();
  pushRecent({ type: 'live', id: channel.stream_id, name: channel.name, icon: channel.stream_icon, cat: channel.category_id });
  enterPlayer(channel.name || ('Chaîne ' + channel.stream_id), true);
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  $('btnFav').classList.remove('hidden'); updateFavBtn();   // favori dispo dans le lecteur (live)
  $('overlay').classList.add('hidden');
  loadEpg(channel);
  $('recBtn').disabled = false;
  $('relayBtn').disabled = false;
  $('scheduleBtn').disabled = false;
  if (typeof ktvUpdateCatchupBtn === 'function') ktvUpdateCatchupBtn(channel);
  if (state.relaying) stopRelay();
  document.querySelectorAll('.chan-card').forEach((c) => c.classList.toggle('active', c.dataset.id == channel.stream_id));
  buildPlayerSidebar(channel);

  // Décision AUTOMATIQUE : on transcode seulement si le flux est RÉELLEMENT
  // de l'UHD (≥ 2160p), vérifié en sondant la vraie résolution. Le nom n'est
  // qu'un pré-filtre (des milliers de chaînes "4K" sont en fait du 1080p).
  if (nameHintUhd(channel)) {
    destroyPlayer();                                   // libère la connexion avant la sonde
    $('overlay').classList.remove('hidden');
    $('overlay').textContent = '⚙️ Analyse du flux…';
    const transcode = await needsTranscode(channel);
    if (state.current !== channel) return;             // l'utilisateur a déjà zappé
    $('overlay').classList.add('hidden');
    if (transcode) { loadTranscodedLive(channel); return; }
  }

  // Lecture directe : on libère un éventuel relais 4K resté actif.
  if (!state.recId && !state.relaying) { try { window.api.relayStopIdle(); } catch {} }
  loadDirect(channel);
}

// Pré-filtre léger : le nom évoque-t-il de l'UHD ? (évite de sonder les
// dizaines de milliers de chaînes sans le moindre indice). On ignore les
// préfixes catégorie ("8k:", "fr:"…) et les marqueurs HD/SD explicites.
function nameHintUhd(ch) {
  let s = ((ch && ch.name) || '').toLowerCase();
  s = s.replace(/^\s*[a-z0-9+]{1,5}\s*[:|]\s*/i, '');
  if (/\b(hd|fhd|sd|hevc)\b/.test(s)) return false;
  return /\b(4k|uhd|2160p?|4320p?)\b/.test(s) || /\b8k\b/.test(s);
}

// Décide AUTOMATIQUEMENT du transcodage : sonde la vraie résolution (≥ 2160p
// = vrai UHD à transcoder). Résultat mémorisé par chaîne pour ne sonder qu'une
// fois (les lectures suivantes sont instantanées).
const resCache = (() => { try { return JSON.parse(localStorage.getItem('res_cache') || '{}'); } catch { return {}; } })();
async function needsTranscode(channel) {
  const id = channel.stream_id;
  if (id in resCache) return resCache[id];
  let decision = false;
  try {
    const r = await window.api.probeStream(typeof liveTs === 'function' ? liveTs(channel) : streamUrl(id, 'ts'));
    if (r && r.height) decision = r.height >= 1600;    // 2160p (et marge) = vrai UHD
  } catch {}
  resCache[id] = decision;
  try { localStorage.setItem('res_cache', JSON.stringify(resCache)); } catch {}
  return decision;
}

// Lecture directe via mpegts (flux .ts), fallback HLS. Comportement d'origine.
function loadDirect(channel) {
  destroyPlayer();
  const v = $('video');
  const tsUrl = typeof liveTs === 'function' ? liveTs(channel) : streamUrl(channel.stream_id, 'ts');
  const hlsUrl = typeof liveHls === 'function' ? liveHls(channel) : streamUrl(channel.stream_id, 'm3u8');
  // Les chaînes M3U (URL directe, souvent .m3u8) passent directement par HLS/natif.
  if (window.mpegts && mpegts.isSupported() && !channel._url) {
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: tsUrl },
      typeof ktvMpegtsConfig === 'function' ? ktvMpegtsConfig()
        : { enableWorker: true, liveBufferLatencyChasing: false, liveSync: false, lazyLoad: false,
            autoCleanupSourceBuffer: true, stashInitialSize: 4 * 1024 * 1024, enableStashBuffer: true }
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

// Lecture d'une chaîne 4K via le relais transcodé en matériel (M1).
async function loadTranscodedLive(channel) {
  destroyPlayer();
  $('overlay').classList.remove('hidden');
  $('overlay').textContent = '⚙️ Préparation 4K (transcodage matériel)…';
  try {
    const r = await window.api.liveTranscodeTune(typeof liveTs === 'function' ? liveTs(channel) : streamUrl(channel.stream_id, 'ts'), channel.name);
    if (state.current !== channel) return;          // l'utilisateur a déjà zappé
    if (!r || !r.local) throw new Error((r && r.error) || 'relais indisponible');
    $('overlay').classList.add('hidden');
    playHls(r.local);
  } catch (e) {
    if (state.current !== channel) return;
    $('overlay').classList.add('hidden');
    loadDirect(channel);                             // repli : lecture directe
  }
}

// Regarder la chaîne actuellement enregistrée via le relais local (sans
// ouvrir de 2e connexion fournisseur). On ne touche NI au relais NI à
// l'enregistrement en cours.
function watchRecordingLive(channel) {
  state.current = channel;
  state.playQueue = null;
  state.resumeKey = null;
  state.nowMeta = null;
  resetPlayerTools();
  pushRecent({ type: 'live', id: channel.stream_id, name: channel.name, icon: channel.stream_icon, cat: channel.category_id });
  enterPlayer(channel.name || ('Chaîne ' + channel.stream_id), true);
  $('nowTitle').textContent = channel.name || ('Chaîne ' + channel.stream_id);
  $('btnFav').classList.remove('hidden'); updateFavBtn();   // favori dispo dans le lecteur (live)
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

// Aller regarder la chaîne en cours d'enregistrement (via le relais local,
// donc sans 2e connexion). Appelé depuis la puce/badge REC.
function watchCurrentRecording() {
  if (!state.recId || !state.recLocal) return;
  let ch = null;
  const matches = (c) => c && (state.recStreamId != null ? c.stream_id == state.recStreamId : c.name === state.recChannelName);
  if (matches(state.current)) ch = state.current;
  else if (Array.isArray(state.channels)) ch = state.channels.find(matches);
  if (ch) { watchRecordingLive(ch); return; }
  // Fallback minimal : on lit le relais sans objet chaîne complet.
  state.current = null;
  enterPlayer(state.recChannelName || 'Enregistrement en cours', true);
  $('nowTitle').textContent = state.recChannelName || '—';
  $('nowEpg').textContent = '';
  $('overlay').classList.add('hidden');
  $('chanSidebar').classList.add('hidden');
  $('sidebarToggle').classList.add('hidden');
  $('recBtn').disabled = false; $('relayBtn').disabled = true; $('scheduleBtn').disabled = true;
  destroyPlayer();
  playHls(state.recLocal);
}

function playHls(url, retries = 6) {
  destroyPlayer();
  const v = $('video');
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls(typeof ktvHlsConfig === 'function' ? ktvHlsConfig() : {
      liveSyncDurationCount: 6,        // ~12 s derrière le bord live (était 4 ≈ 8 s)
      liveMaxLatencyDurationCount: 12, // tolère plus de retard avant de sauter
      maxBufferLength: 30,             // jusqu'à 30 s de tampon en avant
      manifestLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800,
      fragLoadingMaxRetry: 8,
    });
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
// Remplit le sélecteur de catégorie de la sidebar (catégories live + sources + favoris).
function fillSidebarCatSelect(selectedCat) {
  const sel = $('csCat');
  if (!sel) return;
  sel.innerHTML = '';
  if (state.favs && state.favs.length) {
    const o = document.createElement('option');
    o.value = 'favs'; o.textContent = `★ Favoris (${state.favs.length})`;
    sel.appendChild(o);
  }
  for (const c of state.categories) {
    const o = document.createElement('option');
    o.value = c.category_id; o.textContent = c.category_name;
    sel.appendChild(o);
  }
  if (selectedCat != null) sel.value = String(selectedCat);
}

async function buildPlayerSidebar(active) {
  const aside = $('chanSidebar'), toggle = $('sidebarToggle');
  if (!active || !state.categories || !state.categories.length) { aside.classList.add('hidden'); toggle.classList.add('hidden'); return; }
  toggle.classList.remove('hidden');
  aside.classList.remove('hidden');
  aside.classList.toggle('collapsed', localStorage.getItem('player_sidebar') === '0');
  // Catégorie affichée = celle de la chaîne jouée si connue, sinon la dernière affichée / la 1re.
  let cat = active.category_id != null ? String(active.category_id) : null;
  if (!cat || !state.categories.some((c) => String(c.category_id) === cat)) {
    cat = state.sidebarCat || state.curLiveCat || (state.categories[0] && String(state.categories[0].category_id));
  }
  fillSidebarCatSelect(cat);
  // Même catégorie déjà affichée : on met juste à jour la surbrillance (garde le scroll).
  if (state.sidebarCat === String(cat) && $('csList').childElementCount) {
    $('csList').querySelectorAll('.cs-item').forEach((el) => {
      const on = el.dataset.id == active.stream_id;
      el.classList.toggle('active', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
    return;
  }
  await renderSidebarCategory(cat, active.stream_id);
}

// Charge et affiche les chaînes d'une catégorie dans la sidebar (sans changer la lecture).
async function renderSidebarCategory(catId, activeId) {
  const list = $('csList');
  list.innerHTML = '<div class="cs-empty">Chargement…</div>';
  let chans;
  if (String(catId) === 'favs') chans = state.favs || [];
  else { try { chans = await loadCategoryChannels(String(catId)); } catch { chans = []; } }
  chans = (chans || []).filter((c) => !isJunkChannel(c));
  state.sidebarChans = chans;
  state.sidebarCat = String(catId);
  $('csTitle').textContent = `Chaînes (${chans.length})`;
  list.innerHTML = '';
  if (!chans.length) { list.innerHTML = '<div class="cs-empty">Aucune chaîne.</div>'; return; }
  if (!csEpgObserver) {
    csEpgObserver = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { csEpgObserver.unobserve(e.target); fillSidebarEpg(e.target); } });
    }, { root: list, rootMargin: '200px' });
  }
  for (const c of chans) {
    const el = document.createElement('div');
    el.className = 'cs-item' + (c.stream_id == activeId ? ' active' : '');
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

// Changement manuel de catégorie depuis la sidebar (ne change pas la lecture en cours).
function onSidebarCatChange(catId) {
  renderSidebarCategory(catId, state.current && state.current.stream_id);
}

async function fillSidebarEpg(el) {
  const ch = (state.sidebarChans || state.channels || []).find((c) => c.stream_id == el.dataset.id);
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
      const url = typeof liveTs === 'function' ? liveTs(state.current) : streamUrl(state.current.stream_id, 'ts');
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
  state.recStreamId = (state.current && state.current.stream_id) || null;
  if (switchPlayer && res.local && !state.relaying) { destroyPlayer(); playHls(res.local); }
  const btn = $('recBtn');
  btn.classList.add('recording');
  btn.textContent = '⏹ Arrêter';
  $('recDot').classList.remove('hidden');
  // Indicateurs globaux : puce topbar (toujours) + badge détaillé (si non réduit)
  $('rbChan').textContent = state.recChannelName || '—';
  $('rbStart').textContent = '🕐 Début ' + new Date(state.recStart).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('rbSize').textContent = '';
  $('rcSize').textContent = '';
  $('recChip').classList.remove('hidden');
  applyRecBadgeMin();
  clearInterval(state.recTimer);
  state.recTimer = setInterval(recTick, 1000);
  recTick();
}

// Affiche/masque le badge détaillé selon l'état "réduit".
function applyRecBadgeMin() {
  const min = state.recBadgeMin;
  $('recBadge').classList.toggle('hidden', !state.recId || min);
  $('rcToggle').textContent = min ? '▾' : '▴';
}

function toggleRecBadgeMin() {
  state.recBadgeMin = !state.recBadgeMin;
  localStorage.setItem('rec_badge_min', state.recBadgeMin ? '1' : '0');
  applyRecBadgeMin();
}

// Une "tick" par seconde : met à jour minuteur + badge + taille fichier.
function recTick() {
  updateRecTime();
  fetchRecSize();
}

function resumeDirect() { if (state.current) play(state.current); }

function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  // mm:ss sous 1 h (compatible minuteurs REC) ; h:mm:ss au-delà (films longs).
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
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
  // Barre du lecteur
  if (state.recDuration > 0) {
    $('recTime').textContent = `${fmtClock(s)} / ${fmtClock(state.recDuration)}`;
  } else {
    $('recTime').textContent = fmtClock(s);
  }
  // Puce topbar : temps écoulé (compact)
  $('rcTime').textContent = fmtClock(s);
  // Badge global : écoulé, restant, progression
  $('rbTime').textContent = '⏱ ' + fmtClock(s);
  const bar = $('rbProgress').parentElement;
  if (state.recDuration > 0) {
    const rem = Math.max(0, state.recDuration - s);
    $('rbRemain').textContent = '· reste ' + fmtClock(rem);
    bar.classList.remove('indeterminate');
    $('rbProgress').style.width = Math.min(100, (s / state.recDuration) * 100) + '%';
  } else {
    $('rbRemain').textContent = '· illimité';
    bar.classList.add('indeterminate');
  }
}

// Taille lisible (Mo / Go).
function fmtSize(bytes) {
  const mb = (bytes || 0) / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' Go';
  return Math.max(0, Math.round(mb)) + ' Mo';
}

// Récupère la taille du fichier en cours depuis le process principal.
async function fetchRecSize() {
  if (!state.recId) return;
  try {
    const list = await window.api.recordList();
    const r = list.find((x) => x.id === state.recId);
    if (r) {
      $('rbSize').textContent = '· 💾 ' + fmtSize(r.size);
      $('rcSize').textContent = '· ' + fmtSize(r.size);
    }
  } catch {}
}

function stopRecUI() {
  state.recId = null;
  state.recDuration = 0;
  state.recLocal = '';
  state.recChannelName = '';
  state.recStreamId = null;
  clearInterval(state.recTimer);
  const btn = $('recBtn');
  btn.classList.remove('recording');
  btn.textContent = '⏺ Enregistrer';
  $('recDot').classList.add('hidden');
  $('recBadge').classList.add('hidden');
  $('recChip').classList.add('hidden');
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

  const url = typeof liveTs === 'function' ? liveTs(state.current) : streamUrl(state.current.stream_id, 'ts');
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
    const url = typeof liveTs === 'function' ? liveTs(state.current) : streamUrl(state.current.stream_id, 'ts');
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
    state.tunnelUrl = r.stream || (r.url + '/index.m3u8');
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

// Petit utilitaire : crée une section de réglages avec titre + (sous-titre).
function settingsSection(title, hint) {
  const s = document.createElement('div');
  s.className = 'settings-section';
  s.innerHTML = `<h3>${title}</h3>` + (hint ? `<p class="hint">${hint}</p>` : '');
  return s;
}
// Bouton « secondaire » uniforme (fond panel, pleine largeur).
function settingsBtn(label) {
  const b = document.createElement('button');
  b.className = 'set-btn';
  b.textContent = label;
  return b;
}

async function buildSettings() {
  const i = state.info || {};
  const ui = i.user_info || {};
  const si = i.server_info || {};
  let recDir = '—';
  try { recDir = await window.api.getRecordingsDir(); } catch {}
  const body = $('settingsBody');
  body.innerHTML = '';

  /* --- Compte & abonnement (grille compacte) --- */
  const acct = settingsSection('👤 Compte &amp; abonnement');
  const rows = [
    ['Statut', ui.status || '—', ui.status === 'Active' ? 'ok' : 'bad'],
    ['Expiration', ui.exp_date ? fmtDate(ui.exp_date) : 'Illimité'],
    ['Connexions', `${ui.active_cons || 0} / ${ui.max_connections || '—'}`],
    ['Essai', ui.is_trial === '1' ? 'Oui' : 'Non'],
    ['Utilisateur', state.usr],
    ['Serveur', `${si.url || apiBase().replace(/^https?:\/\//, '')}${si.port ? ':' + si.port : ''}`],
    ['Créé le', fmtDate(ui.created_at)],
    ['Fuseau', si.timezone || '—'],
    ['Formats', (ui.allowed_output_formats || []).join(', ') || '—'],
  ];
  const grid = document.createElement('div');
  grid.className = 'set-grid';
  grid.innerHTML = rows.map(([k, v, cls]) =>
    `<div class="set-cell"><span class="k">${k}</span><span class="v ${cls || ''}">${escapeHtml(String(v))}</span></div>`).join('');
  acct.appendChild(grid);
  if (ui.message) { const m = document.createElement('p'); m.className = 'hint'; m.style.marginTop = '10px'; m.textContent = ui.message; acct.appendChild(m); }
  body.appendChild(acct);

  /* --- Enregistrement --- */
  const rec = settingsSection('💾 Enregistrement', 'Dossier où sont stockés les enregistrements et téléchargements.');
  const recVal = document.createElement('div'); recVal.className = 'set-line';
  recVal.innerHTML = `<span class="k">Dossier</span><span class="v" id="recDirVal">${escapeHtml(recDir)}</span>`;
  const pickBtn = settingsBtn('📁 Changer le dossier…');
  pickBtn.onclick = async () => {
    const r = await window.api.pickRecordingsDir();
    if (r.error) { alert(r.error); return; }
    if (!r.canceled) $('recDirVal').textContent = r.dir;
  };
  rec.appendChild(recVal); rec.appendChild(pickBtn);
  body.appendChild(rec);

  /* --- EPG externe --- */
  const epg = settingsSection('🗓️ EPG externe', 'Guide de secours (XMLTV) quand le fournisseur n’a pas d’EPG.');
  const epgVal = document.createElement('div'); epgVal.className = 'set-line';
  epgVal.innerHTML = `<span class="k">État</span><span class="v" id="xmltvVal">…</span>`;
  const epgBtn = settingsBtn('📡 Activer / désactiver l’EPG externe');
  epg.appendChild(epgVal); epg.appendChild(epgBtn);
  body.appendChild(epg);
  const refreshXmltv = async () => {
    try {
      const s = await window.api.xmltvStatus();
      $('xmltvVal').textContent = s.enabled ? (s.channels ? `activé · ${s.channels} chaînes` : 'activé · chargement…') : 'désactivé';
    } catch { $('xmltvVal').textContent = '—'; }
  };
  refreshXmltv();
  epgBtn.onclick = async () => {
    const s = await window.api.xmltvStatus();
    await window.api.xmltvConfig({ enabled: !s.enabled });
    setTimeout(refreshXmltv, 800);
  };

  /* --- Catalogue VOD (films & séries) --- */
  const cat = settingsSection('🎬 Catalogue', 'Recharge la liste des films et séries depuis le fournisseur (après ajout de nouveaux contenus).');
  const btnMovies = settingsBtn('🎬 Rafraîchir les films');
  const btnSeries = settingsBtn('🎞️ Rafraîchir les séries');
  const btnBoth = settingsBtn('🔄 Tout rafraîchir');
  const catMsg = document.createElement('span'); catMsg.className = 'hint'; catMsg.style.marginLeft = '10px';
  const refreshCatalog = async (kind) => {
    const doMovies = kind === 'movies' || kind === 'both';
    const doSeries = kind === 'series' || kind === 'both';
    [btnMovies, btnSeries, btnBoth].forEach((b) => { b.disabled = true; });
    catMsg.textContent = '⏳ Actualisation…';
    try {
      const parts = [];
      if (doMovies) {
        state.vod = null; state.vodCats = [];
        await loadVodData();
        parts.push(`${(state.vod || []).length} films`);
        if (state.view === 'movies') { fillContentCat($('vodCat'), state.vodCats, state.vod.length); renderMovies(); }
      }
      if (doSeries) {
        state.series = null; state.seriesCats = [];
        await loadSeriesData();
        parts.push(`${(state.series || []).length} séries`);
        if (state.view === 'series') { fillContentCat($('seriesCat'), state.seriesCats, state.series.length); renderSeries(); }
      }
      catMsg.textContent = '✓ ' + parts.join(' · ') + ' à jour';
    } catch (e) {
      catMsg.textContent = '⚠️ ' + ((e && e.message) ? e.message : 'échec du rafraîchissement');
    } finally {
      [btnMovies, btnSeries, btnBoth].forEach((b) => { b.disabled = false; });
    }
  };
  btnMovies.onclick = () => refreshCatalog('movies');
  btnSeries.onclick = () => refreshCatalog('series');
  btnBoth.onclick = () => refreshCatalog('both');
  cat.appendChild(btnMovies); cat.appendChild(btnSeries); cat.appendChild(btnBoth); cat.appendChild(catMsg);
  body.appendChild(cat);

  /* --- Mise à jour de l'application --- */
  const upd = settingsSection('⬆️ Application', 'Vérifie les nouvelles versions sur GitHub.');
  const updBtn = settingsBtn('🔄 Vérifier les mises à jour');
  updBtn.onclick = () => window.api.checkUpdate();
  upd.appendChild(updBtn);
  body.appendChild(upd);

  /* --- Sections additionnelles (features.js) : Lecture, Diagnostic, MAJ auto, TMDB, Trakt, Sources --- */
  if (typeof ktvBuildSettingsExtras === 'function') ktvBuildSettingsExtras();

  /* --- Accueil (catégories) --- */
  renderHomeCatPicker();

  ktvSettingsTabs();
}

// Transforme la longue liste de réglages en onglets (nav à gauche, une section visible).
function ktvSettingsTabs() {
  const body = $('settingsBody');
  const nav = $('settingsNav');
  if (!body || !nav) return;
  // Aplatit les sections imbriquées (wrapper .ktv-extra) en enfants directs.
  body.querySelectorAll('.settings-section.ktv-extra').forEach((host) => {
    while (host.firstChild) body.insertBefore(host.firstChild, host);
    host.remove();
  });
  const sections = [...body.children].filter((el) => el.classList.contains('settings-section') && el.querySelector(':scope > h3'));
  nav.innerHTML = '';
  if (sections.length < 2) { sections.forEach((s) => { s.style.display = ''; }); return; }
  const show = (i) => {
    sections.forEach((s, j) => { s.style.display = j === i ? '' : 'none'; });
    [...nav.children].forEach((n, j) => n.classList.toggle('active', j === i));
    body.scrollTop = 0; const v = document.getElementById('view-settings'); if (v) v.scrollTop = 0;
  };
  sections.forEach((sec, i) => {
    const h = sec.querySelector(':scope > h3');
    const b = document.createElement('button');
    b.className = 'settings-tab';
    b.textContent = h ? h.textContent : ('Section ' + (i + 1));
    b.onclick = () => show(i);
    nav.appendChild(b);
  });
  show(0);
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
/* ---------- Reprise de lecture (VOD / séries) ---------- */
// Cache mémoire : évite de parser localStorage à chaque vignette (rendu de 600 cartes).
// Durée exploitable du média courant. Les VOD Xtream sont souvent servies en
// flux (transfert chunked) → vid.duration vaut Infinity ; on retombe alors sur
// la fin de la plage « seekable » que Chromium connaît une fois le moov lu.
function effDuration(v) {
  if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
  try {
    if (v && v.seekable && v.seekable.length) {
      const e = v.seekable.end(v.seekable.length - 1);
      if (isFinite(e) && e > 0) return e;
    }
  } catch {}
  return 0;
}
let _resumeCache = null;
function loadResumeMap() {
  if (_resumeCache) return _resumeCache;
  try { _resumeCache = JSON.parse(localStorage.getItem('ktv_resume') || '{}'); } catch { _resumeCache = {}; }
  return _resumeCache;
}
function saveResumeMap(m) { _resumeCache = m; try { localStorage.setItem('ktv_resume', JSON.stringify(m)); } catch {} }
function getResume(key) { return key ? (loadResumeMap()[key] || null) : null; }
// Progression de reprise (0..1) pour une clé, ou 0 si rien / quasi-fini / au tout début.
function resumeProgress(key) {
  const r = getResume(key);
  if (!r || !r.d) return 0;
  const p = r.t / r.d;
  // saveResume n'enregistre déjà que t >= 15 s (début significatif) et efface
  // la quasi-fin → on montre la barre dès qu'une position existe.
  return (p > 0 && p < 0.99) ? p : 0;
}
// Temps restant (secondes) d'après la position sauvegardée, 0 si rien.
function resumeRemaining(key) {
  const r = getResume(key);
  if (!r || !r.d) return 0;
  const rem = r.d - r.t;
  return rem > 0 ? rem : 0;
}
// Format compact du temps restant : « ⏳ 1 h 05 » / « ⏳ 12 min ».
function fmtRemaining(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h > 0) return `⏳ ${h} h ${String(m).padStart(2, '0')}`;
  return `⏳ ${m} min`;
}
// Clé de reprise d'un élément "récent" (film / épisode de série). Null pour le live.
function recentResumeKey(r) {
  if (!r) return null;
  if (r.type === 'movie') return 'movie:' + r.id;
  if (r.type === 'series') return 'series:' + r.id;
  return null;
}
// Petite barre de progression réutilisable (vignettes, cartes, épisodes).
function progressBar(cls, p) {
  const bar = document.createElement('div');
  bar.className = cls;
  const fill = document.createElement('div');
  // Largeur minimale visible (~4 %) pour qu'un début de lecture reste perceptible.
  const pct = p > 0 ? Math.max(4, Math.min(100, p * 100)) : 0;
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  return bar;
}
function clearResume(key) {
  if (!key) return;
  const m = loadResumeMap();
  if (m[key]) { delete m[key]; saveResumeMap(m); }
}
function saveResume(key, t, d) {
  if (!key || !d) return;
  // Ignore le tout début et la quasi-fin (= terminé).
  if (t < 15 || t > d - 30) { clearResume(key); return; }
  const m = loadResumeMap();
  m[key] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };
  const keys = Object.keys(m);
  if (keys.length > 200) { keys.sort((a, b) => (m[a].at || 0) - (m[b].at || 0)); delete m[keys[0]]; }
  saveResumeMap(m);
}
let lastResumeSave = 0;
function showResumeToast(t) {
  const el = $('resumeToast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.innerHTML = `▶ Reprise à <b>${fmtClock(t)}</b>`;
  const btn = document.createElement('button');
  btn.textContent = 'Recommencer';
  btn.onclick = (e) => { e.stopPropagation(); const v = $('video'); try { v.currentTime = 0; } catch {} hideResumeToast(); };
  el.append(span, btn);
  el.classList.remove('hidden');
  clearTimeout(showResumeToast._t);
  showResumeToast._t = setTimeout(hideResumeToast, 6000);
}
function hideResumeToast() { const el = $('resumeToast'); if (el) el.classList.add('hidden'); }

/* ---------- Pistes audio / sous-titres ---------- */
function getTracks() {
  const v = $('video');
  const out = { audio: [], subs: [] };
  const p = state.player;
  if (p && window.Hls && p instanceof Hls) {
    (p.audioTracks || []).forEach((t, i) => out.audio.push({
      label: t.name || t.lang || ('Piste ' + (i + 1)),
      active: p.audioTrack === i, set: () => { p.audioTrack = i; }
    }));
    const subTracks = p.subtitleTracks || [];
    if (subTracks.length) {
      out.subs.push({ label: 'Désactivés', active: p.subtitleTrack === -1 || !p.subtitleDisplay, set: () => { p.subtitleDisplay = false; p.subtitleTrack = -1; } });
      subTracks.forEach((t, i) => out.subs.push({
        label: t.name || t.lang || ('Sous-titres ' + (i + 1)),
        active: p.subtitleDisplay && p.subtitleTrack === i, set: () => { p.subtitleDisplay = true; p.subtitleTrack = i; }
      }));
    }
  } else {
    const at = v.audioTracks;
    if (at && at.length) for (let i = 0; i < at.length; i++) {
      const tr = at[i];
      out.audio.push({ label: tr.label || tr.language || ('Piste ' + (i + 1)), active: tr.enabled, set: () => { for (let j = 0; j < at.length; j++) at[j].enabled = j === i; } });
    }
    const tt = v.textTracks;
    if (tt && tt.length) {
      out.subs.push({ label: 'Désactivés', active: ![...tt].some((t) => t.mode === 'showing'), set: () => { for (const t of tt) t.mode = 'disabled'; } });
      for (let i = 0; i < tt.length; i++) {
        const tr = tt[i];
        out.subs.push({ label: tr.label || tr.language || ('Sous-titres ' + (i + 1)), active: tr.mode === 'showing', set: () => { for (let j = 0; j < tt.length; j++) tt[j].mode = j === i ? 'showing' : 'disabled'; } });
      }
    }
  }
  return out;
}
function refreshTrackButtons() {
  const t = getTracks();
  $('btnAudio').classList.toggle('hidden', t.audio.length < 2);
  $('btnSubs').classList.toggle('hidden', t.subs.length < 2);
}
function closeTrackMenu() { $('trackMenu').classList.add('hidden'); }
function openTrackMenu(kind) {
  const menu = $('trackMenu');
  const t = getTracks();
  const list = kind === 'audio' ? t.audio : t.subs;
  menu.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tm-head';
  head.textContent = kind === 'audio' ? 'Piste audio' : 'Sous-titres';
  menu.appendChild(head);
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'tm-empty'; e.textContent = 'Aucune piste disponible'; menu.appendChild(e);
  }
  list.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'tm-item' + (it.active ? ' active' : '');
    el.textContent = it.label;
    el.onclick = () => { try { it.set(); } catch {} closeTrackMenu(); setTimeout(refreshTrackButtons, 300); };
    menu.appendChild(el);
  });
  menu.classList.remove('hidden');
  menu.dataset.kind = kind;
}
function toggleTrackMenu(kind) {
  const m = $('trackMenu');
  if (!m.classList.contains('hidden') && m.dataset.kind === kind) closeTrackMenu();
  else openTrackMenu(kind);
}
// Réinitialise les outils du lecteur à chaque nouveau contenu.
function resetPlayerTools() {
  closeTrackMenu(); hideResumeToast();
  $('btnAudio').classList.add('hidden');
  $('btnSubs').classList.add('hidden');
  $('btnFav').classList.add('hidden');     // réaffiché par play() pour les chaînes live
}

// Met à jour le bouton favori du lecteur selon la chaîne en cours.
function updateFavBtn() {
  const fb = $('btnFav'); if (!fb) return;
  const on = !!(state.current && isFav(state.current.stream_id));
  fb.textContent = on ? '★' : '☆';
  fb.classList.toggle('on', on);
  fb.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
}

/* ---------- Picture-in-Picture / plein écran ---------- */
async function togglePip() {
  const v = $('video');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else if (document.pictureInPictureEnabled && v.requestPictureInPicture) await v.requestPictureInPicture();
  } catch {}
}
function toggleFullscreen() {
  const wrap = document.querySelector('.player-wrap');
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (wrap.requestFullscreen) wrap.requestFullscreen();
    else if ($('video').requestFullscreen) $('video').requestFullscreen();
  } catch {}
}

/* ---------- Thème clair / sombre ---------- */
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.classList.toggle('light', light);
  const btn = $('themeToggle');
  if (btn) { btn.textContent = light ? '🌙' : '☀️'; btn.title = light ? 'Passer en thème sombre' : 'Passer en thème clair'; }
}
function toggleTheme() {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  localStorage.setItem('ktv_theme', next);
  applyTheme(next);
}

window.addEventListener('DOMContentLoaded', () => {
  loadFavs();
  loadRecent();
  loadWatched();
  loadReminders();
  armReminders();
  if (typeof ktvTraktPullWatched === 'function') setTimeout(() => ktvTraktPullWatched(), 1500);  // Trakt -> vus locaux
  applyTheme(localStorage.getItem('ktv_theme') || 'dark');
  let autoConnect = false;
  try {
    const profiles = loadProfiles();
    const activeId = localStorage.getItem('xtream_active');
    // Auto-connexion uniquement si un profil actif est défini, ou s'il n'y en
    // a qu'un seul. Sinon on affiche le sélecteur de profils.
    const active = profiles.find((p) => p.id === activeId) || (profiles.length === 1 ? profiles[0] : null);
    if (active) {
      $('srv').value = active.srv; $('usr').value = active.usr; $('pwd').value = active.pwd;
      autoConnect = true;
    }
  } catch {}
  renderLoginProfiles();

  const vid = $('video');
  vid.addEventListener('pause', () => {
    if (suppressResume || vid.ended || !state.current) return;
    vid.play().catch(() => {});
  });
  // Enchaînement automatique de l'épisode suivant
  vid.addEventListener('ended', () => {
    setWatched(state.resumeKey, true);                   // fin = vu (films & séries)
    clearResume(state.resumeKey);
    if (!state.scrobbled && typeof ktvTraktOnFinished === 'function') { state.scrobbled = true; ktvTraktOnFinished(state.nowMeta); }
    const q = state.playQueue;
    if (q && q.idx + 1 < q.eps.length) {
      playEpisodeAt({ ...q, idx: q.idx + 1 });                 // épisode suivant (même saison)
    } else if (q && curSeries && curSeries.episodes) {
      // Fin de saison → enchaîne sur la 1re de la saison suivante (si dispo).
      const seasons = Object.keys(curSeries.episodes).sort((a, b) => Number(a) - Number(b));
      const i = seasons.indexOf(String(q.season));
      const ns = i >= 0 ? seasons[i + 1] : null;
      const neps = ns && curSeries.episodes[ns];
      if (neps && neps.length) playEpisodeAt({ eps: neps, idx: 0, season: ns, name: q.name, cover: q.cover });
    }
  });

  // Reprise de lecture : applique la position sauvegardée (VOD / séries).
  vid.addEventListener('loadedmetadata', () => {
    refreshTrackButtons();
    if (!state.resumeKey) return;
    const r = getResume(state.resumeKey);
    if (r && r.t > 15 && (!isFinite(vid.duration) || r.t < vid.duration - 30)) {
      try { vid.currentTime = r.t; } catch {}
      showResumeToast(r.t);
    }
  });
  // Sauvegarde périodique de la position de lecture.
  vid.addEventListener('timeupdate', () => {
    const dur = effDuration(vid);
    if (!dur) return;
    // Marque « vu » sur Trakt à ~90 % (avant le générique). On exige une VRAIE
    // durée connue (isFinite) : sinon `effDuration` retombe sur `seekable.end()`
    // qui croît au chargement et déclenche un faux « vu » au bout de ~2 min (BUG-G).
    if (!state.scrobbled && isFinite(vid.duration) && vid.duration > 0
        && vid.currentTime / vid.duration >= 0.9) {
      state.scrobbled = true;
      setWatched(state.resumeKey, true);                 // « vu » local (films & séries)
      if (state.nowMeta && typeof ktvTraktOnFinished === 'function') ktvTraktOnFinished(state.nowMeta);
    }
    if (!state.resumeKey) return;
    const now = Date.now();
    if (now - lastResumeSave < 5000) return;
    lastResumeSave = now;
    saveResume(state.resumeKey, vid.currentTime, dur);
  });
  // Les pistes audio/sous-titres apparaissent après le démarrage du flux.
  ['playing', 'canplay'].forEach((ev) => vid.addEventListener(ev, refreshTrackButtons));

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
    // Garde les profils enregistrés : on efface seulement la session active.
    localStorage.removeItem('xtream_active');
    $('pwd').value = '';
    renderLoginProfiles();
    $('app').classList.add('hidden');
    $('login').classList.remove('hidden');
  };
  $('railToggle').onclick = () => $('app').classList.toggle('rail-collapsed');

  // Recherche + filtres
  $('search').addEventListener('input', onSearch);
  $('catSelect').onchange = (e) => loadChannels(e.target.value);
  $('qualSelect').addEventListener('change', renderLiveGrid);
  $('vodCat').onchange = () => { state.vodPage = 1; renderMovies(); };
  $('seriesCat').onchange = () => { state.seriesPage = 1; renderSeries(); };
  $('guideCat').onchange = buildGuideGrid;
  $('guideRefresh').onclick = () => { state.epgCache = {}; buildGuideGrid(); };
  $('historyClear').onclick = () => {
    if (!state.recent.length || confirm("Vider tout l'historique de visionnage ?")) { state.recent = []; saveRecent(); buildHistory(); }
  };

  // Lecteur
  $('playerBack').onclick = () => showView(state.browse);
  $('sidebarToggle').onclick = togglePlayerSidebar;
  $('csCollapse').onclick = togglePlayerSidebar;
  $('csCat').onchange = (e) => onSidebarCatChange(e.target.value);
  $('recBtn').onclick = toggleRecord;
  $('relayBtn').onclick = toggleRelay;
  $('scheduleBtn').onclick = openScheduleModal;

  // Thème clair / sombre
  $('themeToggle').onclick = toggleTheme;

  // Outils du lecteur : favori, audio, sous-titres, PiP, plein écran
  $('btnFav').onclick = (e) => {
    e.stopPropagation();
    if (!state.current) return;
    toggleFav(state.current);
    updateFavBtn();
    if (typeof ktvRenderLiveFavs === 'function') ktvRenderLiveFavs();
    // reflète l'étoile sur la carte correspondante de la grille live
    const star = document.querySelector('.chan-card[data-id="' + state.current.stream_id + '"] .fav-btn');
    if (star) { const on = isFav(state.current.stream_id); star.classList.toggle('on', on); star.textContent = on ? '★' : '☆'; }
  };
  $('btnAudio').onclick = (e) => { e.stopPropagation(); toggleTrackMenu('audio'); };
  $('btnSubs').onclick = (e) => { e.stopPropagation(); toggleTrackMenu('subs'); };
  $('btnPip').onclick = togglePip;
  $('btnFs').onclick = toggleFullscreen;
  if (document.pictureInPictureEnabled) $('btnPip').classList.remove('hidden');
  // Ferme le menu de pistes au clic à l'extérieur.
  document.addEventListener('click', (e) => {
    const m = $('trackMenu');
    if (m.classList.contains('hidden')) return;
    if (!m.contains(e.target) && e.target !== $('btnAudio') && e.target !== $('btnSubs')) closeTrackMenu();
  });

  // Raccourcis clavier (uniquement dans le lecteur, hors champs de saisie).
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'player') return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const v = $('video');
    const isVod = isFinite(v.duration) && !state.current;   // VOD/série = pas de chaîne live
    switch (e.key) {
      case ' ': case 'k':
        e.preventDefault();
        if (v.paused) { suppressResume = false; v.play().catch(() => {}); }
        else { suppressResume = true; v.pause(); }
        break;
      case 'ArrowRight': if (isVod) { e.preventDefault(); v.currentTime = Math.min(v.duration, v.currentTime + 10); } break;
      case 'ArrowLeft': if (isVod) { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); } break;
      case 'ArrowUp': e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
      case 'ArrowDown': e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
      case 'm': v.muted = !v.muted; break;
      case 'f': toggleFullscreen(); break;
      case 'p': togglePip(); break;
      case 'a': toggleTrackMenu('audio'); break;
      case 'c': toggleTrackMenu('subs'); break;
      case 'n': { const q = state.playQueue; if (q && q.idx + 1 < q.eps.length) playEpisodeAt({ ...q, idx: q.idx + 1 }); break; }
      case 'Escape': closeTrackMenu(); break;
      default: break;
    }
  });

  // Indicateurs d'enregistrement (puce topbar + badge détaillé)
  const stopRec = () => { if (state.recId) { window.api.recordStop(state.recId); stopRecUI(); } };
  // Puce topbar
  $('rcWatch').onclick = watchCurrentRecording;
  $('rcToggle').onclick = (e) => { e.stopPropagation(); toggleRecBadgeMin(); };
  $('rcStop').onclick = (e) => { e.stopPropagation(); stopRec(); };
  // Badge détaillé : clic = regarder, boutons = réduire / arrêter
  $('recBadge').onclick = watchCurrentRecording;
  $('rbWatch').onclick = (e) => { e.stopPropagation(); watchCurrentRecording(); };
  $('rbMin').onclick = (e) => { e.stopPropagation(); toggleRecBadgeMin(); };
  $('rbStop').onclick = (e) => { e.stopPropagation(); stopRec(); };

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
    // Un live est-il déjà à l'écran ? (sinon on reste en arrière-plan)
    const watchingLive = !!state.current;
    beginRecUI({ id: data.id, name: data.name, startedRelay: data.startedRelay, local: data.local, durationSec: data.durationSec }, false);
    // ⚠️ 1 connexion : si une chaîne est déjà en lecture, on ne peut pas garder
    // ce flux EN PLUS de l'enregistrement → on bascule le lecteur sur la chaîne
    // enregistrée (via le relais). Sans ça, la 2e connexion coupait la lecture.
    if (watchingLive) watchCurrentRecording();
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
    if (data.file) state.lastRecFile = data.file;
    // L'export WhatsApp reste disponible à la demande dans "Mes enregistrements".
  });

  // État initial de la pastille des enregistrements programmés
  refreshScheduleList();

  // Initialisation des fonctionnalités additionnelles (features.js)
  if (typeof initFeatures === 'function') initFeatures();

  // Reconnexion automatique au lancement si des identifiants sont mémorisés
  if (autoConnect) connect();
});

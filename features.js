'use strict';
/* =====================================================================
   KTV — Fonctionnalités additionnelles
   - Tampon / cache configurable + statistiques réseau
   - Test de débit / diagnostic fournisseur
   - Mise à jour automatique programmée du contenu
   - Recherche globale (chaînes + films + séries + EPG)
   - Enrichissement TMDB (affiches, notes, synopsis, casting)
   - Synchronisation Trakt (OAuth device flow, scrobble, watchlist)
   - Sources multiples / fusion de playlists (M3U + Xtream secondaire)
   Ce fichier est chargé APRÈS renderer.js : toutes les fonctions globales
   de renderer.js sont disponibles à l'exécution.
   ===================================================================== */

/* ---------- Réglages unifiés (localStorage: ktv_settings) ---------- */
const KTV_DEFAULTS = {
  bufferProfile: 'balanced',         // 'low' | 'balanced' | 'stable'
  tmdbEnabled: true,
  // Par défaut, les appels TMDB passent par le proxy KTV (token côté serveur, non
  // embarqué). Un utilisateur avancé peut renseigner sa propre clé v4 (tmdbKey) :
  // les appels se font alors en direct vers api.themoviedb.org.
  tmdbKey: '',
  tmdbProxy: 'https://ktv-tmdb.khalilbenaz.workers.dev',
  tmdbLang: 'fr-FR',
  traktClientId: '',
  traktSecret: '',
  traktScrobble: true,
  autoRefreshMin: 0,                 // 0 = désactivé
  hoverPreview: true,                // aperçu d'une chaîne au survol (Live TV)
  fusion: true,
  sources: [],                       // [{id,type:'m3u'|'xtream',name,url?,srv?,usr?,pwd?,enabled}]
  lastRefresh: 0,
};
function ktvSettings() {
  try { return Object.assign({}, KTV_DEFAULTS, JSON.parse(localStorage.getItem('ktv_settings') || '{}')); }
  catch { return Object.assign({}, KTV_DEFAULTS); }
}
function ktvSaveSettings(s) { try { localStorage.setItem('ktv_settings', JSON.stringify(s)); } catch {} }
function ktvSetting(k) { return ktvSettings()[k]; }
function ktvSetSetting(k, v) { const s = ktvSettings(); s[k] = v; ktvSaveSettings(s); }

/* ---------- Toast ---------- */
function ktvToast(msg) {
  let el = document.getElementById('ktvToast');
  if (!el) { el = document.createElement('div'); el.id = 'ktvToast'; el.className = 'ktv-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(ktvToast._t);
  ktvToast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Titres : nettoyage pour TMDB / Trakt ---------- */
function yearOf(name) { const m = String(name || '').match(/\b(19|20)\d{2}\b/); return m ? m[0] : ''; }
function cleanTitle(name) {
  let s = String(name || '');
  s = s.replace(/[ᴴᴰᵁᴷᶠˢᴾᴿᴬᵂʰᵉᵛᶜᵖᵈᴺᴹᵃⁿᵗʜᴅ⁰¹²³⁴⁵⁶⁷⁸⁹]/g, ' ');          // exposants (ᴴᴰ, ⁴ᴷ…)
  // Préfixes courts répétés "4K-FR - ", "VOD: ", "FR | " (boucle : plusieurs préfixes empilés)
  let _p; do { _p = s; s = s.replace(/^\s*[A-Za-z0-9]{1,4}\s*[-|:•▎–]\s*/, ''); } while (s !== _p);
  s = s.replace(/[\[\(][^\]\)]*[\]\)]/g, ' ');                             // (…) [..]
  s = s.replace(/\b(19|20)\d{2}\b/g, ' ');                                 // année
  s = s.replace(/\b\d{3,4}p\b/gi, ' ');                                    // 2160p / 1080p / 720p
  s = s.replace(/\b(4K|8K|UHD|QHD|FHD|HD|SD|HDR10?|HDR|DV|DOLBY|ATMOS|IMAX|REMUX|BLU[\-\. ]?RAY|BDRIP|BRRIP|WEB[\-\. ]?RIP|WEB[\-\. ]?DL|HDRIP|DVD[\-\. ]?RIP|AMZN|NF|DSNP|ATVP|MAX|MULTI|VFF|VFQ|VF2|VFI|VOF|VF|VO|VOST(?:FR)?|TRUE[\-\. ]?FRENCH|SUB[\-\. ]?FRENCH|FRENCH|H\.?264|H\.?265|X264|X265|HEVC|AVC|AAC|AC3|EAC3|DTS|DDP?5\.1|10\s?BITS?)\b/gi, ' ');
  s = s.replace(/[._]+/g, ' ');
  s = s.replace(/[^\p{L}\p{N} :!?'&-]/gu, ' ');                            // retire emojis / symboles
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s:–·\-]+|[\s:–·\-]+$/g, '').trim();
  return s || String(name || '').trim();
}

/* =====================================================================
   1) TAMPON / CACHE + STATISTIQUES RÉSEAU
   ===================================================================== */
function ktvBufferProfiles() {
  return {
    low: {
      hls: { liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, maxBufferLength: 12, backBufferLength: 30 },
      mpegts: { stashInitialSize: 256 * 1024, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 3.0, liveBufferLatencyMinRemain: 0.5 },
    },
    balanced: {
      hls: { liveSyncDurationCount: 6, liveMaxLatencyDurationCount: 12, maxBufferLength: 30, backBufferLength: 60 },
      mpegts: { stashInitialSize: 4 * 1024 * 1024, liveBufferLatencyChasing: false },
    },
    stable: {
      hls: { liveSyncDurationCount: 10, liveMaxLatencyDurationCount: 20, maxBufferLength: 60, backBufferLength: 120 },
      mpegts: { stashInitialSize: 8 * 1024 * 1024, liveBufferLatencyChasing: false },
    },
  };
}
function ktvHlsConfig(extra) {
  const p = ktvBufferProfiles()[ktvSetting('bufferProfile')] || ktvBufferProfiles().balanced;
  return Object.assign({ manifestLoadingMaxRetry: 8, manifestLoadingRetryDelay: 800, fragLoadingMaxRetry: 8 }, p.hls, extra || {});
}
function ktvMpegtsConfig() {
  const p = ktvBufferProfiles()[ktvSetting('bufferProfile')] || ktvBufferProfiles().balanced;
  return Object.assign({ enableWorker: true, liveSync: false, lazyLoad: false, autoCleanupSourceBuffer: true, enableStashBuffer: true }, p.mpegts);
}

let ktvStatsOn = false, ktvStatsTimer = null;
function ktvToggleStats() {
  ktvStatsOn = !ktvStatsOn;
  const o = document.getElementById('statsOverlay');
  const b = document.getElementById('btnStats');
  if (b) b.classList.toggle('active', ktvStatsOn);
  if (o) o.classList.toggle('hidden', !ktvStatsOn);
  if (ktvStatsOn) ktvStatsTick(); else clearTimeout(ktvStatsTimer);
}
function ktvStatsTick() {
  clearTimeout(ktvStatsTimer);
  if (!ktvStatsOn) return;
  const o = document.getElementById('statsOverlay');
  const v = document.getElementById('video');
  if (o && v) {
    const lines = [];
    if (v.videoWidth && v.videoHeight) lines.push(`Résolution&nbsp;: ${v.videoWidth}×${v.videoHeight}`);
    try { const q = v.getVideoPlaybackQuality && v.getVideoPlaybackQuality(); if (q) lines.push(`Images perdues&nbsp;: ${q.droppedVideoFrames} / ${q.totalVideoFrames || 0}`); } catch {}
    let ahead = 0; try { const tr = v.buffered; if (tr && tr.length) ahead = tr.end(tr.length - 1) - v.currentTime; } catch {}
    lines.push(`Tampon en avance&nbsp;: ${Math.max(0, ahead).toFixed(1)} s`);
    const p = state.player;
    if (p && window.Hls && p instanceof Hls) {
      if (p.bandwidthEstimate) lines.push(`Bande passante&nbsp;: ${(p.bandwidthEstimate / 1e6).toFixed(2)} Mbps`);
      const lv = (p.levels && p.currentLevel >= 0) ? p.levels[p.currentLevel] : null;
      if (lv && lv.bitrate) lines.push(`Débit du flux&nbsp;: ${(lv.bitrate / 1e6).toFixed(2)} Mbps`);
      try { if (p.latency != null) lines.push(`Latence live&nbsp;: ${Number(p.latency).toFixed(1)} s`); } catch {}
      lines.push('Moteur&nbsp;: HLS');
    } else if (p) { lines.push('Moteur&nbsp;: MPEG-TS'); }
    else { lines.push('Moteur&nbsp;: natif'); }
    o.innerHTML = '<div class="st-h">📊 Statistiques réseau</div>' + lines.map((l) => `<div>${l}</div>`).join('');
  }
  ktvStatsTimer = setTimeout(ktvStatsTick, 1000);
}

/* =====================================================================
   2) SOURCES MULTIPLES / FUSION (M3U + Xtream secondaire)
   Helpers d'URL « conscients de la source » : les chaînes synthétiques
   portent _url (M3U) ou _src (creds Xtream secondaire).
   ===================================================================== */
function xtUrl(src, kind, id, ext) {
  const base = String(src.srv || '').replace(/\/+$/, '');
  return `${base}/${kind}/${encodeURIComponent(src.usr)}/${encodeURIComponent(src.pwd)}/${id}.${ext}`;
}
function liveTs(ch) {
  if (ch && ch._url) return ch._url;
  if (ch && ch._src && ch._src.type === 'xtream') return xtUrl(ch._src, 'live', ch.stream_id, 'ts');
  return streamUrl(ch.stream_id, 'ts');
}
function liveHls(ch) {
  if (ch && ch._url) return ch._url;
  if (ch && ch._src && ch._src.type === 'xtream') return xtUrl(ch._src, 'live', ch.stream_id, 'm3u8');
  return streamUrl(ch.stream_id, 'm3u8');
}

function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = []; let cur = null;
  for (const ln of lines) {
    if (/^#EXTINF/i.test(ln)) {
      const name = (ln.split(',').slice(1).join(',') || '').trim();
      const attr = (re) => { const m = ln.match(re); return m ? m[1] : ''; };
      cur = { name, logo: attr(/tvg-logo="([^"]*)"/i), group: attr(/group-title="([^"]*)"/i) || 'Autres', tvg: attr(/tvg-id="([^"]*)"/i) };
    } else if (ln && !/^#/.test(ln)) {
      if (cur) { cur.url = ln.trim(); out.push(cur); cur = null; }
    }
  }
  return out;
}
async function ktvLoadM3uSource(src) {
  const r = await window.api.m3uFetch(src.url);
  if (!r || !r.ok) throw new Error((r && r.error) || 'fetch');
  const items = parseM3U(r.text);
  const byGroup = {};
  items.forEach((it, i) => {
    const g = it.group || 'Autres';
    const catId = 'm3u:' + src.id + ':' + g;
    (byGroup[catId] = byGroup[catId] || []).push({
      stream_id: 'm3u_' + src.id + '_' + i, name: it.name, stream_icon: it.logo || '',
      category_id: catId, epg_channel_id: it.tvg || '', _url: it.url, _noXtreamEpg: true, _srcName: src.name,
    });
  });
  for (const catId in byGroup) {
    const g = catId.split(':').slice(2).join(':');
    if (!state.categories.some((c) => c.category_id === catId)) state.categories.push({ category_id: catId, category_name: '📁 ' + src.name + ' · ' + g });
    state.allByCat[catId] = byGroup[catId];
  }
}
async function ktvLoadXtreamSource(src) {
  const base = String(src.srv || '').replace(/\/+$/, '');
  const q = (p) => fetch(`${base}/player_api.php?username=${encodeURIComponent(src.usr)}&password=${encodeURIComponent(src.pwd)}&${p}`).then((r) => r.json());
  const cats = await q('action=get_live_categories');
  const streams = await q('action=get_live_streams');
  const catName = {}; (Array.isArray(cats) ? cats : []).forEach((c) => { catName[c.category_id] = c.category_name; });
  const byCat = {};
  (Array.isArray(streams) ? streams : []).forEach((st) => {
    const cid = 'xt:' + src.id + ':' + st.category_id;
    (byCat[cid] = byCat[cid] || []).push(Object.assign({}, st, {
      category_id: cid, _noXtreamEpg: true, _srcName: src.name,
      _src: { type: 'xtream', srv: src.srv, usr: src.usr, pwd: src.pwd },
    }));
  });
  for (const cid in byCat) {
    const orig = cid.split(':').slice(2).join(':');
    if (!state.categories.some((c) => c.category_id === cid)) state.categories.push({ category_id: cid, category_name: '🔗 ' + src.name + ' · ' + (catName[orig] || orig) });
    state.allByCat[cid] = byCat[cid];
  }
}
async function ktvApplySources() {
  const s = ktvSettings();
  if (!s.fusion || !(s.sources || []).length) return;
  for (const src of s.sources) {
    if (src.enabled === false) continue;
    try {
      if (src.type === 'm3u') await ktvLoadM3uSource(src);
      else if (src.type === 'xtream') await ktvLoadXtreamSource(src);
    } catch (e) { console.error('source', src.name, e); }
  }
  // Favoris hors du sélecteur (rail dédié en Live TV) — cohérent avec loadCategories.
  try { fillCatSelect($('catSelect'), false); } catch {}
  try { fillCatSelect($('guideCat'), false); } catch {}
}

/* =====================================================================
   2b) CATCH-UP / ARCHIVE (timeshift Xtream)
   URL: {base}/timeshift/{user}/{pass}/{durMin}/{Y-m-d:H-i}/{streamId}.ts
   ===================================================================== */
function chHasArchive(ch) {
  return !!(ch && !ch._url && (ch.tv_archive == 1 || Number(ch.tv_archive) > 0 || Number(ch.tv_archive_duration) > 0));
}
function ktvArchiveCreds(ch) {
  if (ch && ch._src && ch._src.type === 'xtream') return { base: String(ch._src.srv).replace(/\/+$/, ''), usr: ch._src.usr, pwd: ch._src.pwd };
  return { base: apiBase(), usr: state.usr, pwd: state.pwd };
}
function ktvFmtArchiveStart(ts) {
  const d = new Date(ts * 1000); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}:${p(d.getHours())}-${p(d.getMinutes())}`;
}
function ktvArchiveUrl(ch, startTs, durMin, ext) {
  const a = ktvArchiveCreds(ch);
  return `${a.base}/timeshift/${encodeURIComponent(a.usr)}/${encodeURIComponent(a.pwd)}/${durMin}/${ktvFmtArchiveStart(startTs)}/${ch.stream_id}.${ext || 'ts'}`;
}
// EPG complet d'une chaîne (passé + futur) pour le catch-up.
async function ktvChannelEpgFull(ch) {
  const a = ktvArchiveCreds(ch);
  const url = `${a.base}/player_api.php?username=${encodeURIComponent(a.usr)}&password=${encodeURIComponent(a.pwd)}&action=get_simple_data_table&stream_id=${ch.stream_id}`;
  const r = await fetch(url);
  const d = await r.json();
  return (((d && d.epg_listings) || [])
    .map((x) => ({ title: decodeEpg(x.title), st: Number(x.start_timestamp) || 0, en: Number(x.stop_timestamp) || 0 }))
    .filter((p) => p.title && p.st));
}
function ktvUpdateCatchupBtn(ch) {
  const b = $('catchupBtn'); if (!b) return;
  // Toujours proposé pour le live (la modale indique « aucune rediffusion » si vide).
  b.classList.toggle('hidden', !(ch && !ch._url));
}
async function ktvOpenCatchup(channel) {
  const ch = channel || state.current; if (!ch) return;
  const modal = $('catchupModal'), list = $('catchupList');
  if (!modal) return;
  $('catchupChan').textContent = ch.name || 'Chaîne';
  list.innerHTML = '<li class="rec-empty">Chargement du catalogue…</li>';
  modal.classList.remove('hidden');
  let progs = [];
  try { progs = await ktvChannelEpgFull(ch); } catch {}
  const now = Date.now() / 1000;
  const days = Number(ch.tv_archive_duration) || 7;
  const minTs = now - days * 86400;
  const past = progs.filter((p) => (p.en || p.st) <= now && p.st >= minTs).sort((a, b) => b.st - a.st).slice(0, 250);
  if (!past.length) { list.innerHTML = '<li class="rec-empty">Aucune rediffusion disponible.</li>'; return; }
  list.innerHTML = '';
  let lastDay = null;
  for (const p of past) {
    const d = new Date(p.st * 1000);
    const dk = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (dk !== lastDay) { lastDay = dk; const h = document.createElement('li'); h.className = 'rec-day'; h.textContent = dk; list.appendChild(h); }
    const li = document.createElement('li'); li.className = 'rec-item';
    const t = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<div class="rec-meta"><span class="rec-name">${escapeHtml(p.title)}</span><span class="rec-sub">⏪ ${t}</span></div>`;
    const b = document.createElement('button'); b.className = 'ghost'; b.textContent = '▶️'; b.title = 'Revoir';
    const go = () => { modal.classList.add('hidden'); ktvPlayArchive(ch, p); };
    b.onclick = (e) => { e.stopPropagation(); go(); };
    li.onclick = go; li.appendChild(b);
    list.appendChild(li);
  }
}
function ktvPlayArchive(ch, prog) {
  if (!ch || !prog || !prog.st) return;
  const dur = Math.max(1, Math.ceil(((prog.en || (prog.st + 3600)) - prog.st) / 60));
  const url = ktvArchiveUrl(ch, prog.st, dur, 'ts');
  const hls = ktvArchiveUrl(ch, prog.st, dur, 'm3u8');
  const label = `${ch.name || 'Chaîne'} — ⏪ ${prog.title || ''}`;
  state.current = null; state.playQueue = null; state.nowMeta = null; state.resumeKey = null;
  resetPlayerTools();
  enterPlayer(label, false);
  $('chanSidebar').classList.add('hidden'); $('sidebarToggle').classList.add('hidden');
  $('nowTitle').textContent = label; $('nowEpg').textContent = 'Rediffusion (catch-up)';
  $('overlay').classList.add('hidden');
  if (state.relaying) stopRelay();
  destroyPlayer();
  const v = $('video');
  suppressResume = false;
  if (window.mpegts && mpegts.isSupported()) {
    const p = mpegts.createPlayer({ type: 'mpegts', isLive: false, url }, ktvMpegtsConfig());
    p.attachMediaElement(v); p.load(); p.play().catch(() => {});
    p.on(mpegts.Events.ERROR, () => playHls(hls));
    state.player = p;
  } else { playHls(hls); }
}

/* =====================================================================
   3) RECHERCHE GLOBALE (chaînes + films + séries + EPG)
   ===================================================================== */
let ktvSearchTimer = null, ktvSearchSeq = 0, ktvAllChannels = null;
function ktvSearchInput() {
  const q = ($('search').value || '').trim();
  clearTimeout(ktvSearchTimer);
  if (q.length < 2) {
    if (state.view === 'search') showView(state.browse || 'home');
    return;
  }
  ktvSearchTimer = setTimeout(() => ktvRunSearch(q), 250);
}
function ktvShowSearchView() {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-search'));
  state.view = 'search';
}
async function ktvEnsureAllChannels() {
  if (ktvAllChannels) return ktvAllChannels;
  let all = [];
  try {
    const r = await xtreamApi('action=get_live_streams');
    const allowed = new Set(state.categories.filter((c) => !String(c.category_id).includes(':')).map((c) => String(c.category_id)));
    all = (Array.isArray(r) ? r : []).filter((c) => allowed.has(String(c.category_id)));
  } catch {}
  for (const cid in state.allByCat) { if (String(cid).includes(':')) all = all.concat(state.allByCat[cid] || []); }
  ktvAllChannels = all;
  return all;
}
function ktvResultSection(title, count, cards, gridClass) {
  const sec = document.createElement('div');
  sec.className = 'sr-section';
  const h = document.createElement('h2');
  h.className = 'sr-h';
  h.textContent = title + (count != null ? ` (${count})` : '');
  sec.appendChild(h);
  if (!cards || !cards.length) {
    const e = document.createElement('div'); e.className = 'sr-empty'; e.textContent = 'Aucun résultat'; sec.appendChild(e);
  } else {
    const g = document.createElement('div'); g.className = gridClass || 'poster-grid';
    cards.forEach((c) => g.appendChild(c));
    sec.appendChild(g);
  }
  return sec;
}
async function ktvRunSearch(q) {
  const seq = ++ktvSearchSeq;
  ktvShowSearchView();
  const root = $('searchResults');
  if (!root) return;
  root.innerHTML = '<div class="loading">Recherche…</div>';
  const ql = q.toLowerCase();
  const chans = await ktvEnsureAllChannels();
  let vod = [], series = [];
  try { await loadVodData(); vod = state.vod || []; } catch {}
  try { await loadSeriesData(); series = state.series || []; } catch {}
  if (seq !== ktvSearchSeq) return;

  const chHit = chans.filter((c) => !isJunkChannel(c) && (c.name || '').toLowerCase().includes(ql)).slice(0, 60);
  const vHit = vod.filter((m) => (m.name || '').toLowerCase().includes(ql)).slice(0, 60);
  const sHit = series.filter((s) => (s.name || '').toLowerCase().includes(ql)).slice(0, 60);

  root.innerHTML = '';
  root.appendChild(ktvResultSection('📺 Chaînes', chHit.length, chHit.map((c) => channelCard(c, true)), 'chan-grid'));
  if (typeof observeEpgCards === 'function') try { observeEpgCards(); } catch {}
  root.appendChild(ktvResultSection('🎬 Films', vHit.length, vHit.map((m) => posterCard({
    title: m.name, cover: m.stream_icon || m.cover, rating: m.rating,
    progress: (typeof resumeProgress === 'function' ? resumeProgress('movie:' + m.stream_id) : 0),
    remaining: (typeof resumeRemaining === 'function' ? resumeRemaining('movie:' + m.stream_id) : 0),
    watchedKey: 'movie:' + m.stream_id,
    onClick: () => ktvOpenMovie(m), tmdb: { type: 'movie', title: m.name, year: yearOf(m.name) },
    onDownload: () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); },
  }))));
  root.appendChild(ktvResultSection('🎞️ Séries', sHit.length, sHit.map((s) => posterCard({
    title: s.name, cover: s.cover || s.stream_icon, rating: s.rating, watchedKey: 'serieswatched:' + (s.series_id || s.stream_id), onClick: () => openSeries(s), tmdb: { type: 'tv', title: s.name },
  }))));

  // EPG (asynchrone) — programmes en cours / à venir
  const epgSec = document.createElement('div');
  epgSec.className = 'sr-section';
  epgSec.innerHTML = '<h2 class="sr-h">🗓️ Programmes (EPG)</h2><div class="loading">…</div>';
  root.appendChild(epgSec);
  let progs = [];
  try { progs = await window.api.epgSearch(q, 40); } catch {}
  if (seq !== ktvSearchSeq) return;
  epgSec.innerHTML = `<h2 class="sr-h">🗓️ Programmes (EPG) (${progs.length})</h2>`;
  if (!progs.length) { const e = document.createElement('div'); e.className = 'sr-empty'; e.textContent = 'Aucun programme trouvé'; epgSec.appendChild(e); }
  else {
    const ul = document.createElement('ul'); ul.className = 'sr-epg';
    for (const p of progs) {
      const li = document.createElement('li');
      const d = new Date((p.st || 0) * 1000);
      const when = isNaN(d) ? '' : d.toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      li.innerHTML = `<span class="sre-t">${escapeHtml(p.title)}</span><span class="sre-c">${escapeHtml(p.channel)}</span><span class="sre-h">${when}</span>`;
      const match = chans.find((c) => (c.name || '').toLowerCase().includes((p.channel || '').toLowerCase().slice(0, 8)));
      if (match) { li.classList.add('playable'); li.title = 'Regarder ' + match.name; li.onclick = () => play(match); }
      ul.appendChild(li);
    }
    epgSec.appendChild(ul);
  }
}

/* =====================================================================
   4) ENRICHISSEMENT TMDB
   ===================================================================== */
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
async function ktvTmdb(pathQ) {
  const lang = ktvSetting('tmdbLang') || 'fr-FR';
  const sep = pathQ.includes('?') ? '&' : '?';
  const qs = sep + 'language=' + encodeURIComponent(lang);
  const key = ktvSetting('tmdbKey');
  let url, headers;
  if (key) {
    // Clé perso → appel direct TMDB.
    url = 'https://api.themoviedb.org/3' + pathQ + qs;
    headers = { Authorization: 'Bearer ' + key, accept: 'application/json' };
  } else {
    // Défaut → proxy KTV (token côté serveur).
    const base = (ktvSetting('tmdbProxy') || 'https://ktv-tmdb.khalilbenaz.workers.dev').replace(/\/+$/, '');
    url = base + '/3' + pathQ + qs;
    headers = { accept: 'application/json' };
  }
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('tmdb ' + r.status);
  return r.json();
}
function ktvTmdbCacheGet(k) {
  try { const m = JSON.parse(localStorage.getItem('tmdb_cache') || '{}'); const e = m[k]; if (e && Date.now() - e.at < 30 * 86400000) return e.v; } catch {}
  return undefined;
}
function ktvTmdbCacheSet(k, v) {
  try {
    const m = JSON.parse(localStorage.getItem('tmdb_cache') || '{}');
    m[k] = { v, at: Date.now() };
    const keys = Object.keys(m);
    if (keys.length > 1000) delete m[keys[0]];
    localStorage.setItem('tmdb_cache', JSON.stringify(m));
  } catch {}
}
// Normalise un titre pour comparaison (sans accents/ponctuation/casse).
function ktvNormTitle(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
// Choisit le MEILLEUR résultat dont le titre correspond vraiment à la requête
// (évite les fausses affiches : TMDB renvoie souvent un film sans rapport en 1er).
function ktvPickResult(results, query, year) {
  const qn = ktvNormTitle(query);
  if (!qn) return null;
  let best = null, bestScore = -1;
  for (const r of (results || []).slice(0, 8)) {
    const titles = [r.title, r.original_title, r.name, r.original_name].filter(Boolean).map(ktvNormTitle);
    let s = 0;
    for (const t of titles) {
      if (!t) continue;
      if (t === qn) s = Math.max(s, 100);
      else if (t.startsWith(qn + ' ') || qn.startsWith(t + ' ')) s = Math.max(s, 85);
      else if (t.includes(qn) || qn.includes(t)) s = Math.max(s, 62);
    }
    if (s <= 0) continue;
    if (r.poster_path) s += 4;
    if (r.overview) s += 2;
    s += Math.min(6, (Number(r.popularity) || 0) / 15);
    const ry = (r.release_date || r.first_air_date || '').slice(0, 4);
    if (year && ry && String(year) === ry) s += 12;          // bon millésime = bonus fort
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore >= 60 ? best : null;                       // sinon : pas d'enrichissement (mieux qu'une fausse affiche)
}
async function ktvTmdbSearch(type, title, year) {
  if (!ktvSetting('tmdbEnabled')) return null;
  const ck = 's4|' + type + '|' + title + '|' + (year || '');   // s4 = invalide les mauvais matches mis en cache
  const c = ktvTmdbCacheGet(ck); if (c !== undefined) return c;
  const q = cleanTitle(title);
  const yr = year || yearOf(title);
  const tryQ = async (query, y) => {
    if (!query || query.length < 2) return null;
    const path = '/search/' + (type === 'tv' ? 'tv' : 'movie') + '?query=' + encodeURIComponent(query) + (y ? ('&' + (type === 'tv' ? 'first_air_date_year' : 'year') + '=' + y) : '');
    try { const d = await ktvTmdb(path); return ktvPickResult(d && d.results, query, y); } catch { return null; }
  };
  // 1) titre + année · 2) sans année · 3) partie avant un séparateur
  let v = await tryQ(q, yr);
  if (!v) v = await tryQ(q, '');
  if (!v) { const short = q.split(/\s[:–-]\s|:/)[0].trim(); if (short && short !== q) v = await tryQ(short, ''); }
  ktvTmdbCacheSet(ck, v);
  return v;
}
async function ktvTmdbDetails(type, id) {
  const ck = 'd|' + type + '|' + id;
  const c = ktvTmdbCacheGet(ck); if (c !== undefined) return c;
  let v = null;
  try { v = await ktvTmdb('/' + (type === 'tv' ? 'tv' : 'movie') + '/' + id + '?append_to_response=credits'); } catch {}
  ktvTmdbCacheSet(ck, v);
  return v;
}

let ktvTmdbObs = null;
function ktvTmdbObserver() {
  if (!ktvTmdbObs && 'IntersectionObserver' in window) {
    ktvTmdbObs = new IntersectionObserver((ents) => {
      ents.forEach((e) => { if (e.isIntersecting) { ktvTmdbObs.unobserve(e.target); ktvPosterFetch(e.target); } });
    }, { rootMargin: '200px' });
  }
  return ktvTmdbObs;
}
function ktvPosterEnrich(card, hint) {
  if (!ktvSetting('tmdbEnabled') || !hint || !hint.title) return;
  card._tmdbHint = hint;
  const obs = ktvTmdbObserver();
  if (obs) obs.observe(card); else ktvPosterFetch(card);
}
async function ktvPosterFetch(card) {
  const hint = card._tmdbHint; if (!hint) return;
  const needPoster = !!card.querySelector('.p-img.noimg');
  const hasRate = !!card.querySelector('.p-rate');
  if (!needPoster && hasRate) return;            // déjà complet
  const res = await ktvTmdbSearch(hint.type, hint.title, hint.year);
  if (!res) return;
  if (needPoster && res.poster_path) {
    const box = card.querySelector('.p-img');
    if (box) {
      box.classList.remove('noimg'); box.textContent = '';
      const im = document.createElement('img'); im.loading = 'lazy'; im.src = TMDB_IMG + 'w342' + res.poster_path;
      box.insertBefore(im, box.firstChild);
    }
  }
  if (!hasRate && res.vote_average > 0) {
    const box = card.querySelector('.p-img');
    if (box) { const r = document.createElement('span'); r.className = 'p-rate'; r.textContent = '★ ' + Number(res.vote_average).toFixed(1); box.appendChild(r); }
  }
}

// Rangée de portraits du casting (photo TMDB + nom + rôle).
function ktvRenderCast(el, cast) {
  if (!el) return;
  const list = (cast || []).filter(Boolean).slice(0, 15);
  if (!list.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = '<div class="cast-h">Casting</div><div class="cast-row">' + list.map((c) => {
    const img = c.profile_path
      ? `<img class="cast-img" loading="lazy" src="${TMDB_IMG}w185${c.profile_path}">`
      : `<div class="cast-img cast-ph">${escapeHtml((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</div>`;
    return `<div class="cast-item">${img}<span class="cast-n">${escapeHtml(c.name || '')}</span>` +
      (c.character ? `<span class="cast-c">${escapeHtml(c.character)}</span>` : '') + '</div>';
  }).join('') + '</div>';
}

/* Fiche film (modale) avec données TMDB */
let ktvCurMovie = null;
async function ktvOpenMovie(m) {
  ktvCurMovie = m;
  const modal = $('movieModal'); if (!modal) { playMovie(m); return; }
  $('movieTitle').textContent = m.name || 'Film';
  $('moviePlot').textContent = 'Chargement…';
  $('movieMeta').textContent = '';
  $('movieCast').textContent = '';
  const back = $('movieBackdrop'); back.style.backgroundImage = '';
  const cover = $('movieCover');
  cover.innerHTML = (m.stream_icon || m.cover) ? `<img src="${escapeHtml(m.stream_icon || m.cover)}">` : '🎬';
  modal.classList.remove('hidden');
  // boutons
  $('moviePlay').onclick = () => { modal.classList.add('hidden'); playMovie(m); };
  $('movieDownload').onclick = () => { const ext = m.container_extension || 'mp4'; startDownload(vodUrl(m.stream_id, ext), m.name || 'Film', ext); };
  const wl = $('movieWatchlist');
  wl.classList.toggle('hidden', !ktvTraktConnected());
  wl.onclick = () => ktvTraktWatchlist({ type: 'movie', title: m.name, year: yearOf(m.name), tmdbId: m._tmdbId });
  // Marquer comme vu (+ synchro Trakt)
  const mwBtn = $('movieWatched');
  if (mwBtn) {
    const mwKey = 'movie:' + m.stream_id;
    const setMw = () => { const on = isWatched(mwKey); mwBtn.textContent = on ? '✓ Vu' : '☆ Vu'; mwBtn.classList.toggle('on', on); };
    setMw();
    mwBtn.onclick = () => {
      const nowOn = !isWatched(mwKey);
      toggleWatched(mwKey); setMw();
      if (typeof ktvTraktSetWatched === 'function') ktvTraktSetWatched({ type: 'movie', title: m.name, year: yearOf(m.name), tmdbId: m._tmdbId }, nowOn);
    };
  }

  if (!ktvSetting('tmdbEnabled')) { $('moviePlot').textContent = m.plot || m.description || 'Aucune description.'; return; }
  try {
    const hit = await ktvTmdbSearch('movie', m.name, yearOf(m.name));
    if (ktvCurMovie !== m) return;
    if (!hit) { $('moviePlot').textContent = 'Aucune information TMDB.'; return; }
    m._tmdbId = hit.id;
    wl.onclick = () => ktvTraktWatchlist({ type: 'movie', title: m.name, year: yearOf(m.name), tmdbId: hit.id });
    if (hit.backdrop_path) back.style.backgroundImage = `url(${TMDB_IMG}w780${hit.backdrop_path})`;
    // On GARDE l'affiche du fournisseur (cohérence avec la liste) ; TMDB seulement en repli.
    if (hit.poster_path && !(m.stream_icon || m.cover)) cover.innerHTML = `<img src="${TMDB_IMG}w342${hit.poster_path}">`;
    const det = await ktvTmdbDetails('movie', hit.id);
    if (ktvCurMovie !== m) return;
    const info = det || hit;
    $('moviePlot').textContent = info.overview || 'Aucune description.';
    const bits = [];
    const yr = (info.release_date || '').slice(0, 4) || yearOf(m.name); if (yr) bits.push(yr);
    if (info.runtime) bits.push(info.runtime + ' min');
    if (info.genres && info.genres.length) bits.push(info.genres.map((g) => g.name).slice(0, 3).join(', '));
    if (info.vote_average > 0) bits.push('★ ' + Number(info.vote_average).toFixed(1));
    $('movieMeta').textContent = bits.join('  ·  ');
    ktvRenderCast($('movieCast'), info.credits && info.credits.cast);
  } catch { $('moviePlot').textContent = m.plot || 'Aucune information.'; }
}

async function ktvEnrichSeriesModal(s, info) {
  if (!ktvSetting('tmdbEnabled')) return;
  try {
    const hit = await ktvTmdbSearch('tv', s.name);
    if (!hit) return;
    s._tmdbId = hit.id;
    const plotEl = $('seriesPlot');
    const cur = plotEl.textContent || '';
    if (hit.overview && (cur.length < 40 || cur === 'Aucune description.')) plotEl.textContent = hit.overview;
    if (hit.vote_average > 0) {
      const bits = [];
      const yr = (hit.first_air_date || '').slice(0, 4); if (yr) bits.push(yr);
      bits.push('★ ' + Number(hit.vote_average).toFixed(1) + ' (TMDB)');
      const meta = document.createElement('div'); meta.className = 'series-tmdb'; meta.textContent = bits.join('  ·  ');
      plotEl.parentElement.insertBefore(meta, plotEl);
    }
    if (hit.poster_path) { const cov = $('seriesCover'); if (cov && !cov.querySelector('img')) cov.innerHTML = `<img src="${TMDB_IMG}w342${hit.poster_path}">`; }
    const det = await ktvTmdbDetails('tv', hit.id);
    if (det && det.credits) ktvRenderCast($('seriesCast'), det.credits.cast);
  } catch {}
}

/* =====================================================================
   5) SYNCHRONISATION TRAKT (device OAuth)
   ===================================================================== */
const TRAKT_API = 'https://api.trakt.tv';
function ktvTrakt() { try { return JSON.parse(localStorage.getItem('ktv_trakt') || 'null'); } catch { return null; } }
function ktvTraktSaveTok(t) { if (t) localStorage.setItem('ktv_trakt', JSON.stringify(t)); else localStorage.removeItem('ktv_trakt'); }
function ktvTraktConnected() { const t = ktvTrakt(); return !!(t && t.access_token); }
async function ktvTraktReq(path, method, body) {
  const cid = ktvSetting('traktClientId'); if (!cid) throw new Error('Trakt non configuré');
  const t = ktvTrakt();
  const headers = { 'Content-Type': 'application/json', 'trakt-api-version': '2', 'trakt-api-key': cid };
  if (t && t.access_token) headers.Authorization = 'Bearer ' + t.access_token;
  let r = await fetch(TRAKT_API + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && await ktvTraktRefresh()) {
    const t2 = ktvTrakt(); if (t2) headers.Authorization = 'Bearer ' + t2.access_token;
    r = await fetch(TRAKT_API + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  }
  if (!r.ok) throw new Error('trakt ' + r.status);
  return r.status === 204 ? {} : r.json();
}
async function ktvTraktRefresh() {
  const t = ktvTrakt(); const cid = ktvSetting('traktClientId'), secret = ktvSetting('traktSecret');
  if (!t || !t.refresh_token || !cid) return false;
  try {
    const r = await fetch(TRAKT_API + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: t.refresh_token, client_id: cid, client_secret: secret, grant_type: 'refresh_token', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }) });
    if (!r.ok) return false;
    const nt = await r.json(); nt.obtained_at = Date.now(); ktvTraktSaveTok(nt); return true;
  } catch { return false; }
}
async function ktvTraktConnect() {
  const cid = ktvSetting('traktClientId');
  if (!cid) { alert('Renseigne d’abord ton Client ID Trakt dans les Réglages (crée une appli sur trakt.tv/oauth/applications).'); return; }
  let d;
  try {
    const r = await fetch(TRAKT_API + '/oauth/device/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: cid }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d = await r.json();
  } catch (e) { alert('Trakt : échec de la demande de code (' + e.message + ')'); return; }
  ktvShowTraktModal(d);
  ktvTraktPoll(d);
}
function ktvShowTraktModal(d) {
  const modal = $('traktModal'); if (!modal) return;
  $('traktCode').textContent = d.user_code || '—';
  $('traktUrl').textContent = d.verification_url || 'trakt.tv/activate';
  $('traktMsg').textContent = 'En attente de validation…';
  $('traktOpen').onclick = () => { try { window.api.openExternal(d.verification_url); } catch {} };
  modal.classList.remove('hidden');
}
function ktvHideTraktModal() { const m = $('traktModal'); if (m) m.classList.add('hidden'); }
function ktvTraktModalMsg(t) { const e = $('traktMsg'); if (e) e.textContent = t; }
function ktvTraktPoll(d) {
  const cid = ktvSetting('traktClientId'), secret = ktvSetting('traktSecret');
  const start = Date.now();
  const interval = (d.interval || 5) * 1000;
  const expires = (d.expires_in || 600) * 1000;
  const tick = async () => {
    if ($('traktModal').classList.contains('hidden')) return;          // annulé
    if (Date.now() - start > expires) { ktvTraktModalMsg('⌛ Code expiré, réessaie.'); return; }
    try {
      const r = await fetch(TRAKT_API + '/oauth/device/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: d.device_code, client_id: cid, client_secret: secret }) });
      if (r.status === 200) { const t = await r.json(); t.obtained_at = Date.now(); ktvTraktSaveTok(t); ktvHideTraktModal(); ktvToast('✓ Trakt connecté'); if (state.view === 'settings') buildSettings(); ktvTraktPullWatched(); return; }
      if (r.status === 400) { setTimeout(tick, interval); return; }    // en attente
      if (r.status === 429) { setTimeout(tick, interval * 2); return; } // throttle
      if (r.status === 409) { ktvTraktModalMsg('Déjà validé.'); return; }
      if (r.status === 410) { ktvTraktModalMsg('⌛ Code expiré.'); return; }
      if (r.status === 418) { ktvHideTraktModal(); return; }           // refusé
      ktvTraktModalMsg('Échec (' + r.status + ')');
    } catch { setTimeout(tick, interval); }
  };
  setTimeout(tick, interval);
}
function ktvTraktDisconnect() { ktvTraktSaveTok(null); ktvToast('Trakt déconnecté'); if (state.view === 'settings') buildSettings(); }
// Méthode PIN : ouvre la page d'autorisation puis échange le code saisi.
function ktvTraktOpenAuthorize() {
  const cid = ktvSetting('traktClientId');
  if (!cid) { alert('Renseigne d’abord le Client ID.'); return; }
  const url = 'https://trakt.tv/oauth/authorize?response_type=code&client_id=' + encodeURIComponent(cid) + '&redirect_uri=urn:ietf:wg:oauth:2.0:oob';
  try { window.api.openExternal(url); } catch {}
}
async function ktvTraktPinConnect() {
  const cid = ktvSetting('traktClientId'), secret = ktvSetting('traktSecret');
  if (!cid || !secret) { alert('Renseigne le Client ID ET le Client Secret avant de coller le PIN.'); return; }
  const pin = prompt('Colle le code PIN affiché par Trakt :');
  if (!pin) return;
  try {
    const r = await fetch(TRAKT_API + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pin.trim(), client_id: cid, client_secret: secret, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'authorization_code' }) });
    if (!r.ok) { alert('Échec (' + r.status + '). Le PIN est peut-être expiré ou le Client Secret incorrect — régénère un PIN et réessaie.'); return; }
    const t = await r.json(); t.obtained_at = Date.now(); ktvTraktSaveTok(t);
    ktvToast('✓ Trakt connecté'); if (state.view === 'settings') buildSettings(); ktvTraktPullWatched();
  } catch (e) { alert('Erreur : ' + e.message); }
}
// Déduit les métadonnées Trakt depuis la clé de reprise + le titre affiché
// (couvre aussi les lectures lancées depuis « Reprendre » / hero d'accueil).
function ktvMetaFromPlay(resumeKey, title) {
  if (!resumeKey) return null;
  const type = String(resumeKey).split(':')[0];
  if (type === 'movie') return { type: 'movie', title, year: yearOf(title) };
  if (type === 'series') {
    const m = String(title || '').match(/^(.*?)\s*·?\s*S\s*(\d+)\s*E\s*(\d+)/i);
    if (m) return { type: 'episode', showTitle: m[1].trim(), season: Number(m[2]), episode: Number(m[3]) };
    return { type: 'episode', showTitle: title };
  }
  return null;
}
async function ktvTraktOnFinished(meta) {
  if (!meta || !ktvSetting('traktScrobble') || !ktvTraktConnected()) return;
  try {
    let body;
    if (meta.type === 'movie') body = meta.tmdbId ? { movies: [{ ids: { tmdb: meta.tmdbId } }] } : { movies: [{ title: cleanTitle(meta.title), year: Number(meta.year) || undefined }] };
    else if (meta.type === 'episode') {
      const show = meta.tmdbId ? { ids: { tmdb: meta.tmdbId } } : { title: cleanTitle(meta.showTitle) };
      body = { shows: [{ ...show, seasons: [{ number: meta.season, episodes: [{ number: meta.episode }] }] }] };
    } else return;
    await ktvTraktReq('/sync/history', 'POST', body);
    ktvToast('✓ Marqué vu sur Trakt');
  } catch {}
}
// Synchronise l'état « vu » avec Trakt (ajout/retrait de l'historique) — appelé
// par la bascule manuelle ✓. `on` = vu (ajout) ; sinon retrait.
async function ktvTraktSetWatched(meta, on) {
  if (!meta || !ktvTraktConnected()) return;
  try {
    let body;
    if (meta.type === 'movie') body = meta.tmdbId ? { movies: [{ ids: { tmdb: meta.tmdbId } }] } : { movies: [{ title: cleanTitle(meta.title), year: Number(meta.year) || undefined }] };
    else if (meta.type === 'episode') {
      // ID TMDB du show si dispo (sinon titre) → évite d'apparier la mauvaise série.
      const show = meta.tmdbId ? { ids: { tmdb: meta.tmdbId } } : { title: cleanTitle(meta.showTitle) };
      body = { shows: [{ ...show, seasons: [{ number: meta.season, episodes: [{ number: meta.episode }] }] }] };
    } else if (meta.type === 'show') {
      body = { shows: [ meta.tmdbId ? { ids: { tmdb: meta.tmdbId } } : { title: cleanTitle(meta.title), year: Number(meta.year) || undefined } ] };
    } else return;
    await ktvTraktReq(on ? '/sync/history' : '/sync/history/remove', 'POST', body);
    ktvToast(on ? '✓ Marqué vu sur Trakt' : '↩︎ Retiré de l’historique Trakt');
  } catch {}
}
// ---- Trakt -> KTV : marque vus en local les contenus déjà vus sur Trakt ----
let ktvTW = null;   // { movies:Set('titre|année'), eps:Set('série|S|E') }
function ktvWKey(title, year) { return cleanTitle(title || '') + '|' + (Number(year) || ''); }
async function ktvTraktPullWatched() {
  if (!ktvTraktConnected()) return;
  try {
    const [movies, shows] = await Promise.all([
      ktvTraktReq('/sync/watched/movies').catch(() => []),
      ktvTraktReq('/sync/watched/shows').catch(() => []),
    ]);
    const tw = { movies: new Set(), eps: new Set() };
    (movies || []).forEach((it) => { const m = it.movie || {}; if (m.title) tw.movies.add(ktvWKey(m.title, m.year)); });
    (shows || []).forEach((it) => {
      const st = cleanTitle((it.show || {}).title || '');
      (it.seasons || []).forEach((se) => (se.episodes || []).forEach((ep) => tw.eps.add(st + '|' + se.number + '|' + ep.number)));
    });
    ktvTW = tw;
    ktvTraktApplyWatched();
  } catch {}
}
// Marque vus en local les films du catalogue qui figurent dans l'historique Trakt.
function ktvTraktApplyWatched() {
  if (!ktvTW || typeof setWatched !== 'function' || !window.state) return;
  let changed = false;
  if (Array.isArray(state.vod)) {
    for (const m of state.vod) {
      const key = 'movie:' + m.stream_id;
      if (!isWatched(key) && ktvTW.movies.has(ktvWKey(m.name, (typeof yearOf === 'function' ? yearOf(m.name) : '')))) { setWatched(key, true); changed = true; }
    }
  }
  if (changed && state.view === 'movies' && typeof renderMovies === 'function') renderMovies();
}
// Épisode vu sur Trakt ? (appariement série + saison + épisode)
function ktvTraktEpWatched(show, season, episode) {
  return !!(ktvTW && ktvTW.eps.has(cleanTitle(show || '') + '|' + Number(season) + '|' + Number(episode)));
}
function ktvTraktWatchlist(meta) {
  if (!ktvTraktConnected()) { alert('Connecte Trakt dans les Réglages.'); return; }
  const body = meta.type === 'movie'
    ? (meta.tmdbId ? { movies: [{ ids: { tmdb: meta.tmdbId } }] } : { movies: [{ title: cleanTitle(meta.title), year: Number(meta.year) || undefined }] })
    : { shows: [{ title: cleanTitle(meta.title) }] };
  ktvTraktReq('/sync/watchlist', 'POST', body).then(() => ktvToast('✓ Ajouté à la watchlist Trakt')).catch(() => alert('Échec watchlist'));
}

/* =====================================================================
   6) TEST DE DÉBIT / DIAGNOSTIC FOURNISSEUR
   ===================================================================== */
async function ktvSpeedTest(box) {
  box.innerHTML = '<div class="loading">Test en cours… (ferme la lecture en cours sur les abonnements 1 connexion)</div>';
  const res = {};
  // 1) Latence : 4 appels à player_api.php
  const url = `${apiBase()}/player_api.php?username=${encodeURIComponent(state.usr)}&password=${encodeURIComponent(state.pwd)}&_=`;
  const lat = [];
  for (let i = 0; i < 4; i++) { const t = performance.now(); try { await fetch(url + i, { cache: 'no-store' }); lat.push(performance.now() - t); } catch {} }
  res.latency = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  // 2) Débit : lecture d'un flux live ~6 s
  res.mbps = null;
  try {
    let ch = (state.channels || []).find((c) => !isJunkChannel(c)) || null;
    if (!ch && state.categories[0]) { try { const list = await loadCategoryChannels(state.categories[0].category_id); ch = (list || []).find((c) => !isJunkChannel(c)); } catch {} }
    if (ch) {
      const ctrl = new AbortController();
      const t0 = performance.now(); let bytes = 0;
      const r = await fetch(liveTs(ch), { signal: ctrl.signal });
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (performance.now() - t0 > 6000) { try { ctrl.abort(); } catch {} break; }
      }
      const sec = (performance.now() - t0) / 1000;
      if (sec > 0 && bytes > 0) res.mbps = +((bytes * 8 / 1e6) / sec).toFixed(2);
    }
  } catch {}
  // 3) Compte
  try { const info = await xtreamApi(''); if (info && info.user_info) state.info = info; } catch {}
  const ui = (state.info && state.info.user_info) || {};
  res.maxCon = ui.max_connections; res.activeCon = ui.active_cons; res.exp = ui.exp_date;
  ktvRenderSpeed(box, res);
}
function ktvVerdict(ok, mid, val) { return val == null ? '—' : (ok ? '🟢' : (mid ? '🟠' : '🔴')); }
function ktvRenderSpeed(box, res) {
  const latV = res.latency == null ? '—' : res.latency + ' ms ' + ktvVerdict(res.latency < 250, res.latency < 600, res.latency);
  const mbV = res.mbps == null ? '—' : res.mbps + ' Mbps ' + ktvVerdict(res.mbps > 8, res.mbps > 3, res.mbps);
  const exp = res.exp ? (typeof fmtDate === 'function' ? fmtDate(res.exp) : res.exp) : 'Illimité';
  box.innerHTML =
    `<div class="row"><span class="k">Latence API</span><span class="v">${latV}</span></div>` +
    `<div class="row"><span class="k">Débit flux</span><span class="v">${mbV}</span></div>` +
    `<div class="row"><span class="k">Connexions</span><span class="v">${res.activeCon != null ? res.activeCon : '?'} / ${res.maxCon != null ? res.maxCon : '?'}</span></div>` +
    `<div class="row"><span class="k">Expiration</span><span class="v">${exp}</span></div>`;
}

/* =====================================================================
   7) MISE À JOUR AUTOMATIQUE PROGRAMMÉE
   ===================================================================== */
let ktvRefreshTimer = null;
function ktvSetupAutoRefresh() {
  clearInterval(ktvRefreshTimer);
  const min = Number(ktvSetting('autoRefreshMin')) || 0;
  if (min <= 0) return;
  ktvRefreshTimer = setInterval(() => { ktvRefreshAll(false); }, min * 60 * 1000);
}
async function ktvRefreshAll(manual) {
  state.allByCat = {}; state.vod = null; state.series = null; state.epgCache = {};
  ktvAllChannels = null;
  if (state.curLiveCat) state.curLiveCat = null;
  try { await loadCategories(); } catch {}
  try { await ktvApplySources(); } catch {}
  try { window.api.xmltvConfig({}); } catch {}        // force le rechargement EPG externe
  const v = state.view;
  try {
    if (v === 'live') ensureLive();
    else if (v === 'movies') ensureVod();
    else if (v === 'series') ensureSeries();
    else if (v === 'guide') buildGuideGrid();
    else if (v === 'home') buildHome();
  } catch {}
  ktvSetSetting('lastRefresh', Date.now());
  if (manual) ktvToast('🔄 Contenu actualisé');
}

/* =====================================================================
   8) RÉGLAGES — section additionnelle (rendue dans #settingsBody)
   ===================================================================== */
function ktvRow(label, controlEl) {
  const r = document.createElement('div'); r.className = 'ktv-row';
  const k = document.createElement('span'); k.className = 'k'; k.textContent = label;
  r.appendChild(k); r.appendChild(controlEl); return r;
}
function ktvBuildSettingsExtras() {
  const body = $('settingsBody'); if (!body) return;
  const s = ktvSettings();
  const host = document.createElement('div');
  host.className = 'settings-section ktv-extra';
  body.appendChild(host);

  /* --- Lecture : tampon --- */
  const sec1 = document.createElement('div'); sec1.className = 'settings-section';
  sec1.innerHTML = '<h3>▶️ Lecture &amp; tampon</h3><p class="hint">« Faible latence » = plus proche du direct (plus de coupures sur réseau lent). « Stable » = gros tampon, moins de coupures.</p>';
  const bufSel = document.createElement('select');
  [['low', 'Faible latence'], ['balanced', 'Équilibré (défaut)'], ['stable', 'Stable (gros tampon)']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (s.bufferProfile === v) o.selected = true; bufSel.appendChild(o); });
  bufSel.onchange = () => { ktvSetSetting('bufferProfile', bufSel.value); ktvToast('Tampon : ' + bufSel.options[bufSel.selectedIndex].text + ' (prochaine lecture)'); };
  sec1.appendChild(ktvRow('Profil de tampon', bufSel));
  const prevCb = document.createElement('label'); prevCb.className = 'cat-check';
  const pcb = document.createElement('input'); pcb.type = 'checkbox'; pcb.checked = s.hoverPreview !== false;
  pcb.onchange = () => { ktvSetSetting('hoverPreview', pcb.checked); if (!pcb.checked && typeof ktvStopPreview === 'function') ktvStopPreview(); };
  prevCb.appendChild(pcb); prevCb.appendChild(document.createTextNode(' Aperçu de la chaîne au survol (Live TV)'));
  sec1.appendChild(prevCb);
  host.appendChild(sec1);

  /* --- Sport / Match Center --- */
  const secSport = document.createElement('div'); secSport.className = 'settings-section';
  secSport.innerHTML = '<h3>⚽ Sport — Match Center</h3><p class="hint">Ajoute un onglet « Sport » pour suivre les scores en direct, buts, cartons (données Sofascore via le navigateur intégré).</p>';
  const spLbl = document.createElement('label'); spLbl.className = 'cat-check';
  const spChk = document.createElement('input'); spChk.type = 'checkbox'; spChk.checked = s.sportEnabled === true;
  spChk.onchange = () => { ktvSetSetting('sportEnabled', spChk.checked); if (typeof ktvApplySportSetting === 'function') ktvApplySportSetting(); ktvToast(spChk.checked ? 'Menu Sport activé' : 'Menu Sport désactivé'); };
  spLbl.appendChild(spChk); spLbl.appendChild(document.createTextNode(' Activer le menu Sport'));
  secSport.appendChild(spLbl);
  host.appendChild(secSport);

  /* --- Diagnostic / débit --- */
  const sec2 = document.createElement('div'); sec2.className = 'settings-section';
  sec2.innerHTML = '<h3>📶 Diagnostic du fournisseur</h3><p class="hint">Teste la latence de l’API, le débit du flux et l’état de l’abonnement.</p>';
  const diagBox = document.createElement('div'); diagBox.className = 'ktv-diag';
  const diagBtn = document.createElement('button'); diagBtn.className = 'copy'; diagBtn.textContent = '🚀 Lancer le test de débit';
  diagBtn.onclick = () => ktvSpeedTest(diagBox);
  sec2.appendChild(diagBtn); sec2.appendChild(diagBox);
  host.appendChild(sec2);

  /* --- Mise à jour auto --- */
  const sec3 = document.createElement('div'); sec3.className = 'settings-section';
  sec3.innerHTML = '<h3>🔄 Mise à jour automatique</h3><p class="hint">Recharge périodiquement chaînes, films, séries et EPG en arrière-plan.</p>';
  const refSel = document.createElement('select');
  [[0, 'Désactivée'], [30, 'Toutes les 30 min'], [60, 'Toutes les heures'], [180, 'Toutes les 3 h'], [360, 'Toutes les 6 h']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (Number(s.autoRefreshMin) === v) o.selected = true; refSel.appendChild(o); });
  refSel.onchange = () => { ktvSetSetting('autoRefreshMin', Number(refSel.value)); ktvSetupAutoRefresh(); ktvToast('Mise à jour auto : ' + refSel.options[refSel.selectedIndex].text); };
  sec3.appendChild(ktvRow('Fréquence', refSel));
  const refBtn = document.createElement('button'); refBtn.className = 'copy'; refBtn.style.marginTop = '8px'; refBtn.textContent = '🔄 Actualiser maintenant';
  refBtn.onclick = () => ktvRefreshAll(true);
  sec3.appendChild(refBtn);
  if (s.lastRefresh) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Dernière actualisation : ' + new Date(s.lastRefresh).toLocaleString('fr-FR'); sec3.appendChild(p); }
  host.appendChild(sec3);

  /* --- TMDB --- */
  const sec4 = document.createElement('div'); sec4.className = 'settings-section';
  sec4.innerHTML = '<h3>🎬 Enrichissement TMDB</h3><p class="hint">Affiches, notes, synopsis et casting pour les films &amp; séries.</p>';
  const tmdbCb = document.createElement('label'); tmdbCb.className = 'cat-check';
  const tcb = document.createElement('input'); tcb.type = 'checkbox'; tcb.checked = s.tmdbEnabled !== false;
  tcb.onchange = () => { ktvSetSetting('tmdbEnabled', tcb.checked); };
  tmdbCb.appendChild(tcb); tmdbCb.appendChild(document.createTextNode(' Activer TMDB'));
  sec4.appendChild(tmdbCb);
  const langSel = document.createElement('select');
  [['fr-FR', 'Français'], ['en-US', 'English'], ['ar', 'العربية']].forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; if (s.tmdbLang === v) o.selected = true; langSel.appendChild(o); });
  langSel.onchange = () => ktvSetSetting('tmdbLang', langSel.value);
  sec4.appendChild(ktvRow('Langue des métadonnées', langSel));
  host.appendChild(sec4);

  /* --- Trakt --- */
  const sec5 = document.createElement('div'); sec5.className = 'settings-section';
  sec5.innerHTML = '<h3>🅣 Synchronisation Trakt</h3><p class="hint">Marque automatiquement films/épisodes comme vus. Crée une appli sur <b>trakt.tv/oauth/applications</b> et colle Client ID + Secret.</p>';
  const cidIn = document.createElement('input'); cidIn.type = 'text'; cidIn.placeholder = 'Client ID'; cidIn.value = s.traktClientId || ''; cidIn.className = 'ktv-input';
  cidIn.onchange = () => ktvSetSetting('traktClientId', cidIn.value.trim());
  const secIn = document.createElement('input'); secIn.type = 'password'; secIn.placeholder = 'Client Secret'; secIn.value = s.traktSecret || ''; secIn.className = 'ktv-input';
  secIn.onchange = () => ktvSetSetting('traktSecret', secIn.value.trim());
  sec5.appendChild(cidIn); sec5.appendChild(secIn);
  const scrobCb = document.createElement('label'); scrobCb.className = 'cat-check';
  const scb = document.createElement('input'); scb.type = 'checkbox'; scb.checked = s.traktScrobble !== false;
  scb.onchange = () => ktvSetSetting('traktScrobble', scb.checked);
  scrobCb.appendChild(scb); scrobCb.appendChild(document.createTextNode(' Marquer vu automatiquement à la fin'));
  sec5.appendChild(scrobCb);
  const tBtn = document.createElement('button'); tBtn.className = 'copy'; tBtn.style.marginTop = '8px';
  if (ktvTraktConnected()) {
    tBtn.textContent = '✓ Trakt connecté — Déconnecter'; tBtn.onclick = ktvTraktDisconnect;
    sec5.appendChild(tBtn);
  } else {
    tBtn.textContent = '🔗 Connecter (code device)'; tBtn.onclick = ktvTraktConnect;
    sec5.appendChild(tBtn);
    const authBtn = document.createElement('button'); authBtn.className = 'copy'; authBtn.style.marginTop = '8px';
    authBtn.textContent = '1) Obtenir un PIN sur Trakt'; authBtn.onclick = ktvTraktOpenAuthorize;
    const pinBtn = document.createElement('button'); pinBtn.className = 'copy'; pinBtn.style.marginTop = '8px';
    pinBtn.textContent = '2) Coller le PIN et lier'; pinBtn.onclick = ktvTraktPinConnect;
    sec5.appendChild(authBtn); sec5.appendChild(pinBtn);
  }
  host.appendChild(sec5);

  /* --- Sources multiples --- */
  const sec6 = document.createElement('div'); sec6.className = 'settings-section';
  sec6.innerHTML = '<h3>📡 Sources multiples / fusion</h3><p class="hint">Ajoute des playlists M3U ou des comptes Xtream secondaires : leurs chaînes apparaissent dans Live TV.</p>';
  const fusCb = document.createElement('label'); fusCb.className = 'cat-check';
  const fcb = document.createElement('input'); fcb.type = 'checkbox'; fcb.checked = s.fusion !== false;
  fcb.onchange = () => { ktvSetSetting('fusion', fcb.checked); ktvToast('Fusion ' + (fcb.checked ? 'activée' : 'désactivée') + ' — actualise pour appliquer'); };
  fusCb.appendChild(fcb); fusCb.appendChild(document.createTextNode(' Fusionner les sources dans Live TV'));
  sec6.appendChild(fusCb);
  const srcList = document.createElement('div'); srcList.className = 'ktv-src-list';
  const renderSrc = () => {
    const cur = ktvSettings().sources || [];
    srcList.innerHTML = '';
    if (!cur.length) { srcList.innerHTML = '<p class="hint">Aucune source ajoutée.</p>'; return; }
    cur.forEach((src) => {
      const row = document.createElement('div'); row.className = 'ktv-src';
      row.innerHTML = `<span class="ks-ic">${src.type === 'm3u' ? '📁' : '🔗'}</span><span class="ks-name">${escapeHtml(src.name || src.url || src.srv || '—')}</span>`;
      const en = document.createElement('input'); en.type = 'checkbox'; en.checked = src.enabled !== false; en.title = 'Activer';
      en.onchange = () => { const a = ktvSettings(); const f = a.sources.find((x) => x.id === src.id); if (f) f.enabled = en.checked; ktvSaveSettings(a); };
      const del = document.createElement('button'); del.className = 'ks-del'; del.textContent = '✕';
      del.onclick = () => { const a = ktvSettings(); a.sources = a.sources.filter((x) => x.id !== src.id); ktvSaveSettings(a); renderSrc(); };
      row.appendChild(en); row.appendChild(del); srcList.appendChild(row);
    });
  };
  renderSrc();
  sec6.appendChild(srcList);
  const addM3u = document.createElement('button'); addM3u.className = 'copy'; addM3u.style.marginTop = '8px'; addM3u.textContent = '➕ Ajouter une playlist M3U';
  addM3u.onclick = () => {
    const url = prompt('URL de la playlist M3U / M3U8 :'); if (!url) return;
    const name = prompt('Nom de la source :', 'M3U') || 'M3U';
    const a = ktvSettings(); a.sources = a.sources || [];
    a.sources.push({ id: 's' + Date.now().toString(36) + a.sources.length, type: 'm3u', name, url: url.trim(), enabled: true });
    ktvSaveSettings(a); renderSrc(); ktvToast('Source ajoutée — actualise pour charger');
  };
  const addXt = document.createElement('button'); addXt.className = 'copy'; addXt.style.marginTop = '8px'; addXt.textContent = '➕ Ajouter un compte Xtream';
  addXt.onclick = () => {
    const srv = prompt('Serveur (http://host:port) :'); if (!srv) return;
    const usr = prompt('Utilisateur :'); if (!usr) return;
    const pwd = prompt('Mot de passe :'); if (pwd == null) return;
    const name = prompt('Nom de la source :', usr) || usr;
    let s2 = srv.trim(); if (!/^https?:\/\//i.test(s2)) s2 = 'http://' + s2;
    const a = ktvSettings(); a.sources = a.sources || [];
    a.sources.push({ id: 's' + Date.now().toString(36) + a.sources.length, type: 'xtream', name, srv: s2, usr: usr.trim(), pwd, enabled: true });
    ktvSaveSettings(a); renderSrc(); ktvToast('Source ajoutée — actualise pour charger');
  };
  sec6.appendChild(addM3u); sec6.appendChild(addXt);
  host.appendChild(sec6);
}

/* =====================================================================
   INIT — appelé depuis le DOMContentLoaded de renderer.js
   ===================================================================== */
function initFeatures() {
  const sb = $('btnStats');
  if (sb) { sb.classList.remove('hidden'); sb.onclick = (e) => { e.stopPropagation(); ktvToggleStats(); }; }
  // Modales
  const mc = $('movieClose'); if (mc) mc.onclick = () => $('movieModal').classList.add('hidden');
  const mm = $('movieModal'); if (mm) mm.onclick = (e) => { if (e.target.id === 'movieModal') mm.classList.add('hidden'); };
  const tc = $('traktClose'); if (tc) tc.onclick = ktvHideTraktModal;
  const tm = $('traktModal'); if (tm) tm.onclick = (e) => { if (e.target.id === 'traktModal') ktvHideTraktModal(); };
  const cb = $('catchupBtn'); if (cb) cb.onclick = ktvOpenCatchup;
  const cc = $('catchupClose'); if (cc) cc.onclick = () => $('catchupModal').classList.add('hidden');
  const cm = $('catchupModal'); if (cm) cm.onclick = (e) => { if (e.target.id === 'catchupModal') cm.classList.add('hidden'); };
  ktvSetupAutoRefresh();
  // Câble l'aperçu au survol sur les conteneurs statiques (Live TV + accueil).
  if (typeof ktvWireHoverPreview === 'function') ktvWireHoverPreview();
}
window.initFeatures = initFeatures;

/* ===========================================================================
   Live TV — Rail Favoris (séparé de la liste) + Aperçu au survol
   =========================================================================== */

// Rail horizontal des chaînes favorites, affiché AU-DESSUS de la liste Live TV
// (et non plus en tête de la liste / du sélecteur de catégories).
function ktvRenderLiveFavs() {
  const host = document.getElementById('liveFavRail');
  if (!host) return;
  const favs = (typeof state !== 'undefined' && Array.isArray(state.favs)) ? state.favs : [];
  if (!favs.length) { host.style.display = 'none'; host.innerHTML = ''; return; }
  host.style.display = '';
  host.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'favrail-h';
  h.innerHTML = `<span>★ Favoris</span><span class="favrail-count">${favs.length}</span>`;
  const track = document.createElement('div');
  track.className = 'favrail-track';
  favs.forEach((f) => { if (typeof channelCard === 'function') track.appendChild(channelCard(f, false)); });
  host.appendChild(h);
  host.appendChild(track);
}

// ---- Aperçu (mini-lecteur muet) d'une chaîne au survol de la souris ----
let ktvPrevTimer = null, ktvPrevPlayer = null, ktvPrevCard = null;

function ktvPreviewEnabled() {
  if (ktvSetting('hoverPreview') === false) return false;
  // Respecte la limite « 1 connexion » : pas d'aperçu si une connexion fournisseur
  // est déjà prise — enregistrement, relais/restream, OU une lecture en cours
  // (state.current/state.player). Sinon l'aperçu ouvrirait un 2e flux et couperait
  // la lecture active (BUG-B).
  if (typeof state !== 'undefined' && (state.recId || state.relaying || state.current || state.player)) return false;
  return !!(window.mpegts && mpegts.isSupported());
}

function ktvStopPreview() {
  clearTimeout(ktvPrevTimer); ktvPrevTimer = null;
  if (ktvPrevPlayer) { try { ktvPrevPlayer.destroy(); } catch {} ktvPrevPlayer = null; }
  const ov = document.getElementById('chanPreview');
  if (ov) {
    ov.classList.remove('show', 'loading');
    const v = ov.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  }
  ktvPrevCard = null;
}

function ktvPositionPreview(ov, card) {
  const r = card.getBoundingClientRect();
  const W = ov.offsetWidth || 360, H = ov.offsetHeight || 230, M = 10;
  let left = r.right + 12;
  if (left + W > window.innerWidth - M) left = r.left - W - 12;   // bascule à gauche
  left = Math.min(Math.max(M, left), window.innerWidth - W - M);
  let top = r.top + r.height / 2 - H / 2;
  top = Math.min(Math.max(M, top), window.innerHeight - H - M);
  ov.style.left = left + 'px';
  ov.style.top = top + 'px';
}

function ktvStartPreview(card) {
  if (!ktvPreviewEnabled()) return;
  const ch = card && card._ch;
  const ov = document.getElementById('chanPreview');
  if (!ch || !ov) return;
  if (ktvPrevPlayer) { try { ktvPrevPlayer.destroy(); } catch {} ktvPrevPlayer = null; }
  const v = ov.querySelector('video');
  ov.querySelector('.cp-title').textContent = ch.name || '';
  ov.classList.add('show', 'loading');
  ktvPositionPreview(ov, card);
  const tsUrl = (typeof liveTs === 'function') ? liveTs(ch)
    : (typeof streamUrl === 'function' ? streamUrl(ch.stream_id, 'ts') : null);
  if (!tsUrl || ch._url) {                                   // sources M3U directes : pas d'aperçu TS
    if (ch._url) { try { v.src = ch._url; v.muted = false; v.play().catch(() => {}); ov.classList.remove('loading'); } catch {} }
    return;
  }
  try {
    // Même config que le lecteur normal (avec tampon) → aperçu fluide. La config
    // « faible latence » (latency-chasing, sans stash) faisait saccader l'aperçu.
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: tsUrl },
      typeof ktvMpegtsConfig === 'function' ? ktvMpegtsConfig()
        : { enableWorker: true, lazyLoad: false, autoCleanupSourceBuffer: true, enableStashBuffer: true }
    );
    // Assigner AVANT load/play : sinon un ktvStopPreview concurrent (sortie souris
    // pendant la création) ne verrait pas ce player et le laisserait orphelin (BUG-D).
    ktvPrevPlayer = p;
    p.attachMediaElement(v);
    v.muted = false;                 // aperçu AVEC le son
    p.load();
    p.play().catch(() => {});
    p.on(mpegts.Events.MEDIA_INFO, () => ov.classList.remove('loading'));
    p.on(mpegts.Events.ERROR, () => ktvStopPreview());
    // La souris a quitté la carte pendant la création async → on annule.
    if (!card.isConnected || card !== ktvPrevCard) ktvStopPreview();
  } catch { ktvStopPreview(); }
}

// Délégation des événements de survol. Zones : liste Live TV, rail Favoris, et
// l'accueil (#homeRows → « Reprendre la lecture » + favoris). Le sélecteur couvre
// les cartes chaîne (.chan-card) et les cartes « récent » (.recent-card) ; seules
// celles portant `_ch` (chaînes live) déclenchent réellement un aperçu.
const CP_SEL = '.chan-card, .recent-card';
function ktvWireHoverPreview() {
  const zones = [
    document.getElementById('liveGrid'),
    document.getElementById('liveFavRail'),
    document.getElementById('homeRows'),
    document.getElementById('historyGrid'),
  ].filter(Boolean);
  zones.forEach((z) => {
    if (z._cpWired) return;
    z._cpWired = true;
    z.addEventListener('mouseover', (e) => {
      const card = e.target.closest(CP_SEL);
      if (!card || !card._ch || card === ktvPrevCard) return;   // sans _ch (VOD) → pas d'aperçu
      clearTimeout(ktvPrevTimer);
      ktvPrevCard = card;
      ktvPrevTimer = setTimeout(() => ktvStartPreview(card), 550);   // anti-rebond
    });
    z.addEventListener('mouseout', (e) => {
      const card = e.target.closest(CP_SEL);
      if (!card) return;
      if (e.relatedTarget && card.contains(e.relatedTarget)) return; // déplacement interne
      if (card === ktvPrevCard) ktvStopPreview();
    });
    // Clic pour lire : on libère immédiatement la connexion de l'aperçu.
    z.addEventListener('mousedown', () => ktvStopPreview());
  });
  if (!window._cpScrollWired) {
    window._cpScrollWired = true;
    window.addEventListener('scroll', () => ktvStopPreview(), true);
  }
}

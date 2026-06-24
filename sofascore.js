// sofascore.js — Match Center pour KTV (extraction de page)
//
// IMPORTANT : l'API REST publique de Sofascore (api.sofascore.com) est désormais
// bloquée par Cloudflare ("challenge" 403) pour tout appel direct — y compris
// depuis un vrai Chromium et même en same-origin. La seule voie fiable est donc
// d'extraire les données du SITE rendu, ce que permet Electron (vrai navigateur) :
//   • Recherche  → on charge /search?q=… et on lit les liens de résultats du DOM.
//   • Match      → on charge la page du match et on lit __NEXT_DATA__
//                  (props.pageProps.event + incidents), pré-rendu côté serveur.
// Les onglets Statistiques / Compositions détaillées / Forme sont chargés en RSC
// à la demande et ne sont pas dans le payload initial : best-effort, dégradation
// propre si indisponible.

const { BrowserWindow } = require('electron');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ORIGIN = 'https://www.sofascore.com';

const TTL_LIVE = 30 * 1000;
const TTL_DONE = 24 * 60 * 60 * 1000;
const TTL_SEARCH = 5 * 60 * 1000;

let winPromise = null;
const cache = new Map();   // key -> { at, ttl, data }

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }
function log(...a) { try { console.log('[sofascore]', ...a); } catch (_) {} }

// --- fenêtre Chromium cachée, lazy ------------------------------------------
function getWin() {
  if (winPromise) return winPromise;
  winPromise = new Promise((resolve) => {
    const w = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
    });
    w.webContents.setUserAgent(UA);
    w.on('closed', () => { winPromise = null; });
    resolve(w);
  });
  return winPromise;
}

// Navigue puis attend que `readyExpr` (évaluée dans la page) soit vraie.
// On vide d'abord via about:blank : la page précédente (recherche live) garde
// des websockets ouverts qui font traîner loadURL, et son __NEXT_DATA__ fausserait
// le polling. On lance ensuite loadURL sans l'attendre (les SPA rejettent souvent
// en ERR_ABORTED) et on sonde l'apparition de la nouvelle page.
async function navigate(url, readyExpr, timeoutMs = 12000) {
  const w = await getWin();
  try { w.webContents.stop(); } catch (_) {}
  try { await w.loadURL('about:blank'); } catch (_) {}
  w.loadURL(url).catch(() => {});   // ne pas attendre : peut rejeter/traîner sur SPA
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ok = false;
    try { ok = await w.webContents.executeJavaScript(readyExpr, true); } catch (_) {}
    if (ok) { await delay(400); return w; }   // petit délai pour laisser l'hydratation finir
    await delay(300);
  }
  return w; // on tente l'extraction même si le ready a expiré
}

function extractNextData(w) {
  // Lit __NEXT_DATA__ et renvoie un objet match allégé (event + incidents).
  const code = `(() => {
    try {
      const el = document.getElementById('__NEXT_DATA__');
      if (!el) return { error: 'no __NEXT_DATA__' };
      const pp = (JSON.parse(el.textContent).props || {}).pageProps || {};
      const ev = pp.event || {};
      const team = (t) => t ? { id: t.id, name: t.name, slug: t.slug, shortName: t.shortName } : null;
      const score = (s) => s ? { current: s.current, display: s.display, period1: s.period1, period2: s.period2 } : null;
      const incidents = (pp.incidents || []).map((i) => ({
        incidentType: i.incidentType, incidentClass: i.incidentClass, time: i.time,
        addedTime: i.addedTime, isHome: i.isHome,
        player: i.player ? { name: i.player.name || i.player.shortName } : null,
        playerIn: i.playerIn ? { name: i.playerIn.name } : null,
        playerOut: i.playerOut ? { name: i.playerOut.name } : null,
        assist1: i.assist1 ? { name: i.assist1.name } : null,
        homeScore: i.homeScore, awayScore: i.awayScore, text: i.text
      }));
      return {
        event: {
          id: ev.id, customId: ev.customId, slug: ev.slug,
          tournament: ev.tournament ? ((ev.tournament.uniqueTournament && ev.tournament.uniqueTournament.name) || ev.tournament.name) : null,
          season: ev.season ? ev.season.name : null,
          round: ev.roundInfo ? ev.roundInfo.round : null,
          startTimestamp: ev.startTimestamp,
          status: ev.status ? { type: ev.status.type, description: ev.status.description } : null,
          homeTeam: team(ev.homeTeam), awayTeam: team(ev.awayTeam),
          homeScore: score(ev.homeScore), awayScore: score(ev.awayScore),
          winnerCode: ev.winnerCode,
          venue: ev.venue && ev.venue.stadium ? ev.venue.stadium.name : null,
          referee: ev.referee ? ev.referee.name : null
        },
        incidents: incidents,
        hasLineups: !!pp.initialHasLineups
      };
    } catch (e) { return { error: String(e) }; }
  })()`;
  return w.webContents.executeJavaScript(code, true);
}

function eventTtl(ev) { return ev && ev.status && ev.status.type === 'finished' ? TTL_DONE : TTL_LIVE; }

// --- API publique ------------------------------------------------------------

function parseEventId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/[#,&?]id[:=](\d+)/i) || s.match(/\/(\d{5,})(?:[/#?]|$)/);
  return m ? Number(m[1]) : null;
}

// Construit l'URL de page match : préfère l'URL collée, sinon /event/{id}.
function matchUrl(input) {
  const s = String(input || '').trim();
  if (/^https?:\/\/(www\.)?sofascore\.com\//i.test(s)) return s.split('#')[0];
  const id = parseEventId(s);
  return id ? ORIGIN + '/event/' + id : null; // /event/{id} redirige vers la page sluguée
}

function title(s) { return String(s || '').replace(/\b[a-z]/g, (c) => c.toUpperCase()); }
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }

// Noms FR → slug EN (équipes nationales fréquentes). Permet à "maroc" de trouver "morocco".
const COUNTRY_FR = {
  maroc: 'morocco', espagne: 'spain', allemagne: 'germany', angleterre: 'england', ecosse: 'scotland',
  bresil: 'brazil', italie: 'italy', paysbas: 'netherlands', hollande: 'netherlands', belgique: 'belgium',
  croatie: 'croatia', argentine: 'argentina', portugal: 'portugal', france: 'france', suisse: 'switzerland',
  suede: 'sweden', danemark: 'denmark', norvege: 'norway', pologne: 'poland', japon: 'japan',
  coreedusud: 'southkorea', coree: 'korea', etatsunis: 'usa', mexique: 'mexico', canada: 'canada',
  senegal: 'senegal', tunisie: 'tunisia', algerie: 'algeria', egypte: 'egypt', nigeria: 'nigeria',
  ghana: 'ghana', cameroun: 'cameroon', cotedivoire: 'cotedivoire', afriquedusud: 'southafrica',
  australie: 'australia', uruguay: 'uruguay', colombie: 'colombia', equateur: 'ecuador', perou: 'peru',
  turquie: 'turkiye', grece: 'greece', autriche: 'austria', tchequie: 'czechia', haiti: 'haiti',
  republiquedemocratiqueducongo: 'drcongo', congo: 'congo', ouzbekistan: 'uzbekistan', irak: 'iraq',
  curacao: 'curacao', panama: 'panama'
};

// Recherche : URL/ID collé → résolution directe ; sinon filtre le feed des matchs.
async function search(q) {
  const query = String(q || '').trim();
  if (!query) return { events: [] };

  // URL ou ID → on résout directement le match.
  if (/sofascore\.com\//i.test(query) || /^\d+$/.test(query)) {
    try { const m = await getMatch(query); return { events: [m.event] }; }
    catch (e) { log('resolve direct failed', e.message); }
  }

  // Termes recherchés (mots normalisés + alias FR→EN).
  const terms = new Set();
  query.split(/\s+/).forEach((wd) => {
    const n = norm(wd); if (n.length < 2) return;
    terms.add(n);
    if (COUNTRY_FR[n]) terms.add(norm(COUNTRY_FR[n]));
  });
  const whole = norm(query); if (whole && COUNTRY_FR[whole]) terms.add(norm(COUNTRY_FR[whole]));
  const termList = [...terms];

  // Feed des matchs (page d'accueil), mis en cache court.
  const rows = await fetchFeed();

  // Filtrage + score (nb de termes correspondant à une équipe).
  const scored = [];
  for (const r of rows) {
    if (r.status !== 'live') continue; // matchs en direct uniquement
    const toks = rowTokens(r);
    if (!toks.length) continue;
    let score = 0;
    for (const t of termList) {
      if (t.length < 3) continue;
      if (toks.some((tok) => tok.length >= 3 && (tok.includes(t) || t.includes(tok)))) score++;
    }
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score);

  return { events: scored.slice(0, 25).map(({ r }) => rowToEvent(r)) };
}

// Tokens normalisés d'un match (noms réels + slug) pour le filtrage.
function rowTokens(r) {
  const toks = [];
  (r.home + ' ' + r.away).split(/\s+/).forEach((w) => { const n = norm(w); if (n) toks.push(n); });
  (r.slug || '').split('-').forEach((w) => { const n = norm(w); if (n && !/^[0-9a-f]{8,}$/.test(n)) toks.push(n); });
  return toks;
}

// Construit un event léger depuis une ligne de feed (vrais noms ordonnés si dispo).
function rowToEvent(r) {
  const parts = (r.slug || '').split('-');
  const mid = Math.ceil(parts.length / 2);
  return {
    id: r.id, url: ORIGIN + r.href.split('#')[0],
    homeTeam: { name: r.home || title(parts.slice(0, mid).join(' ')) },
    awayTeam: { name: r.away || title(parts.slice(mid).join(' ')) },
    status: r.status === 'live' ? { type: 'inprogress' } : (r.status === 'upcoming' ? { type: 'notstarted' } : null)
  };
}

// Tous les matchs actuellement en direct (sans recherche) — pour l'overlay du lecteur.
async function liveMatches() {
  const rows = await fetchFeed();
  return { events: rows.filter((r) => r.status === 'live' && rowTokens(r).length).map(rowToEvent) };
}

// Liste des matchs du feed (page d'accueil) : [{id, slug, href}], cache 2 min.
async function fetchFeed() {
  const key = 'feed';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  const w = await navigate(ORIGIN + '/', `!!document.querySelector('a[href*="/match/"]')`, 9000);
  const code = `(() => {
    const out = []; const seen = new Set();
    const statusOf = (txt) => {
      if (/canceled|postponed|abandoned|annul/i.test(txt)) return 'canceled';
      const minute = /(^|\\D)\\d{1,3}'(\\+\\d+)?/.test(txt) || /\\bHT\\b/.test(txt);
      const clock = /\\b\\d{1,2}:\\d{2}\\b/.test(txt);
      const score = /\\d+\\s*-\\s*\\d+/.test(txt);
      if (minute) return 'live';
      if (score && !clock) return 'finished';
      if (clock) return 'upcoming';
      return 'unknown';
    };
    document.querySelectorAll('a[href*="/match/"]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const idm = href.match(/#id:(\\d+)/);
      const id = idm ? Number(idm[1]) : null;
      if (!id || seen.has(id)) return; seen.add(id);
      const slugm = href.match(/\\/match\\/([^/]+)\\//);
      // Les alt d'images donnent les vrais noms d'équipes dans l'ordre domicile/extérieur.
      const names = [...a.querySelectorAll('img[alt]')].map((i) => i.alt).filter(Boolean);
      out.push({ id, href, slug: slugm ? slugm[1] : '', status: statusOf((a.textContent || '').replace(/\\s+/g, ' ')), home: names[0] || '', away: names[1] || '' });
    });
    return out;
  })()`;
  let rows = [];
  try { rows = await w.webContents.executeJavaScript(code, true); } catch (e) { log('feed extract', e.message); }
  cache.set(key, { at: Date.now(), ttl: 2 * 60 * 1000, data: rows });
  return rows;
}

// Match complet : event (score & infos) + incidents (buts/cartons/rempl.).
async function getMatch(input) {
  const url = matchUrl(input);
  if (!url) throw new Error('URL/ID Sofascore invalide');
  const key = 'match:' + url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;

  const w = await navigate(url, `!!document.getElementById('__NEXT_DATA__')`, 9000);
  const data = await extractNextData(w);
  if (!data || data.error || !data.event || data.event.id == null) {
    throw new Error('Extraction impossible' + (data && data.error ? ' (' + data.error + ')' : ''));
  }
  data.event.url = url;
  cache.set(key, { at: Date.now(), ttl: eventTtl(data.event), data });
  return data;
}

// Best-effort : stats chiffrées (souvent indisponibles dans le payload initial).
async function getStats(input) {
  // Non disponible de façon fiable via l'extraction de page (onglet RSC).
  return { available: false, groups: [] };
}

// Best-effort : compos détaillées (onglet RSC). On renvoie au moins le drapeau.
async function getLineups(input) {
  try { const m = await getMatch(input); return { available: false, hasLineups: !!m.hasLineups, incidents: m.incidents || [] }; }
  catch (_) { return { available: false, hasLineups: false, incidents: [] }; }
}

// Forme d'une équipe via sa page (/team/<slug>/<id>) — best-effort.
async function getTeamForm(team) {
  const id = typeof team === 'object' ? team.id : team;
  const slug = typeof team === 'object' ? (team.slug || '') : '';
  if (!id) return [];
  const url = ORIGIN + (slug ? '/team/' + slug + '/' + id : '/team/' + id);
  try {
    const w = await navigate(url, `!!document.getElementById('__NEXT_DATA__')`, 8000);
    const code = `(() => {
      try {
        const pp = (JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props || {}).pageProps || {};
        const evs = pp.lastEvents || pp.events || (pp.team && pp.team.lastEvents) || [];
        const sc = (s) => s ? s.current : null;
        return (evs || []).slice(0, 10).map((e) => ({
          id: e.id,
          homeTeam: e.homeTeam ? { id: e.homeTeam.id, name: e.homeTeam.name } : null,
          awayTeam: e.awayTeam ? { id: e.awayTeam.id, name: e.awayTeam.name } : null,
          homeScore: { current: sc(e.homeScore) }, awayScore: { current: sc(e.awayScore) },
          startTimestamp: e.startTimestamp
        }));
      } catch (e) { return []; }
    })()`;
    const rows = await w.webContents.executeJavaScript(code, true);
    return Array.isArray(rows) ? rows : [];
  } catch (_) { return []; }
}

function dispose() {
  try { if (winPromise) winPromise.then((w) => { try { w.destroy(); } catch (_) {} }); } catch (_) {}
  winPromise = null; cache.clear();
}

module.exports = { parseEventId, search, liveMatches, getMatch, getStats, getLineups, getTeamForm, dispose };

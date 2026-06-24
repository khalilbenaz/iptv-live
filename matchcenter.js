// matchcenter.js — UI du Match Center (Sofascore) pour KTV
// Deux surfaces : l'onglet "Sport" (recherche + détail) et un overlay sur le player.
(function () {
  'use strict';
  const api = window.api || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // "varDecision" / "goalAwarded" → "Decision" / "Goal awarded" (texte lisible).
  const humanize = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).trim();
  const VAR_FR = { goalAwarded: 'but accordé', goalNotAwarded: 'but refusé', penaltyAwarded: 'penalty accordé', penaltyNotAwarded: 'penalty refusé', penaltyNotGiven: 'penalty refusé', cardUpgrade: 'carton aggravé', redCardGiven: 'carton rouge', cardGiven: 'carton', mistakenIdentity: 'erreur d’identité' };

  // --- helpers d'affichage ---------------------------------------------------
  function scoreLine(ev) {
    const h = ev.homeScore && ev.homeScore.current, a = ev.awayScore && ev.awayScore.current;
    return (h != null && a != null) ? `${h} - ${a}` : 'vs';
  }
  function statusBadge(ev) {
    const t = ev.status && ev.status.type;
    if (t === 'inprogress') return '<span class="sc-live">● LIVE</span>';
    if (t === 'finished') return '<span class="sc-fin">Terminé</span>';
    if (t === 'notstarted' && !ev.startTimestamp) return '<span class="sc-up">À venir</span>';
    if (ev.startTimestamp) {
      const d = new Date(ev.startTimestamp * 1000);
      return '<span class="sc-up">' + d.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</span>';
    }
    return '';
  }
  function matchHeader(ev) {
    const tourn = [ev.tournament, ev.round ? 'J' + ev.round : ''].filter(Boolean).join(' · ');
    return `<div class="sc-match">
      <div class="sc-team sc-team-h">${esc(ev.homeTeam && ev.homeTeam.name)}</div>
      <div class="sc-center"><div class="sc-score">${scoreLine(ev)}</div><div class="sc-status">${statusBadge(ev)}</div></div>
      <div class="sc-team sc-team-a">${esc(ev.awayTeam && ev.awayTeam.name)}</div>
    </div>${tourn ? '<div class="sc-tourn">' + esc(tourn) + '</div>' : ''}`;
  }

  function renderResults(box, data, onPick) {
    box.innerHTML = '';
    const events = (data && data.events) || [];
    if (!events.length) { box.innerHTML = '<div class="sc-empty">Aucun match trouvé.<br>Essaie un autre nom, ou colle l’URL Sofascore du match.</div>'; return; }
    events.forEach((ev) => {
      const c = el('div', 'sc-card');
      c.innerHTML = matchHeader(ev);
      c.onclick = () => onPick(ev);
      box.appendChild(c);
    });
  }

  // --- vue détail (réutilisée par l'onglet ET l'overlay) ---------------------
  // `match` = { event, incidents } renvoyé par sofaMatch.
  // Forme & Statistiques ne sont pas disponibles via l'extraction de page → non affichées.
  function renderDetail(container, match) {
    const ev = match.event || match;
    container.innerHTML = '';
    const meta = [ev.venue, ev.referee ? '🧑‍⚖️ ' + ev.referee : ''].filter(Boolean).join(' · ');
    const head = el('div', 'sc-detail-head', matchHeader(ev) + (meta ? '<div class="sc-tourn">' + esc(meta) + '</div>' : ''));
    container.appendChild(head);

    const incs = (match.incidents || []).filter((i) => i.incidentType !== 'period' && i.incidentType !== 'injuryTime');
    if (!incs.length) {
      container.appendChild(el('div', 'sc-empty', 'Pas encore de fait de match.'));
      return;
    }
    container.appendChild(el('h4', 'sc-sec-title', '⚽ Faits du match'));
    const time = el('div', 'sc-timeline');
    incs.forEach((i) => {
      let ico = '•', who = '', cls = 'sc-ev';
      if (i.incidentType === 'goal') { ico = '⚽'; cls += ' sc-ev-goal'; who = esc((i.player && i.player.name) || ''); if (i.assist1 && i.assist1.name) who += ' <span class="sc-assist">passe ' + esc(i.assist1.name) + '</span>'; }
      else if (i.incidentType === 'card') { ico = (i.incidentClass === 'yellow' ? '🟨' : (i.incidentClass === 'yellowRed' ? '🟨🟥' : '🟥')); who = esc((i.player && i.player.name) || ''); }
      else if (i.incidentType === 'substitution') { ico = '🔁'; who = '<span class="sc-sub-in">↑ ' + esc((i.playerIn && i.playerIn.name) || '') + '</span> <span class="sc-sub-out">↓ ' + esc((i.playerOut && i.playerOut.name) || '') + '</span>'; }
      else if (i.incidentType === 'varDecision') { ico = '📺'; const lbl = VAR_FR[i.incidentClass] || humanize(i.incidentClass) || 'décision'; who = '<span class="sc-var">VAR — ' + esc(lbl) + '</span>' + (i.player && i.player.name ? ' ' + esc(i.player.name) : ''); }
      else { who = esc(i.player && i.player.name ? i.player.name : humanize(i.text || i.incidentType || '')); }
      const t = (i.time != null ? i.time + "'" : '') + (i.addedTime ? '+' + i.addedTime : '');
      const sc = (i.incidentType === 'goal' && i.homeScore != null && i.awayScore != null) ? `<span class="sc-ev-sc">${i.homeScore}-${i.awayScore}</span>` : '';
      const side = i.isHome === true ? 'sc-side-h' : (i.isHome === false ? 'sc-side-a' : '');
      const row = el('div', 'sc-ev-row ' + side);
      row.innerHTML = `<span class="sc-ev-min">${esc(t)}</span><span class="sc-ev-ico">${ico}</span><span class="sc-ev-txt">${who}</span>${sc}`;
      time.appendChild(row);
    });
    container.appendChild(time);
  }

  // --- onglet Sport ----------------------------------------------------------
  let tabInit = false;
  function initTab() {
    if (tabInit) return; tabInit = true;
    const input = $('scQuery'), btn = $('scSearchBtn'), results = $('scResults'), detail = $('scDetail');
    if (!input) return;
    const pick = async (ev) => {
      detail.innerHTML = '<div class="sc-empty">Chargement du match…</div>';
      try { const full = await api.sofaMatch(ev.url || ev.id); renderDetail(detail, full); detail.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      catch (e) { detail.innerHTML = '<div class="sc-empty">Erreur : ' + esc(e.message) + '</div>'; }
    };
    const run = async () => {
      const q = input.value.trim(); if (!q) return;
      results.innerHTML = '<div class="sc-empty">Recherche…</div>'; detail.innerHTML = '';
      try { const data = await api.sofaSearch(q); renderResults(results, data, pick); if (data.events && data.events.length === 1) pick(data.events[0]); }
      catch (e) { results.innerHTML = '<div class="sc-empty">Erreur : ' + esc(e.message) + ' (Cloudflare bloque ? réessayez).</div>'; }
    };
    btn.onclick = run;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  // --- overlay sur le player : carte flottante déplaçable --------------------
  let ov;
  function ensureOverlay() {
    if (ov) return ov;
    ov = el('div', 'sc-overlay hidden');               // calque non bloquant (la vidéo reste cliquable)
    ov.innerHTML = `<div class="sc-float">
      <div class="sc-float-head" id="scOvHead">
        <span class="sc-float-title">⚽ Match Center</span>
        <button id="scOvMin" class="icon-btn" title="Réduire / agrandir">▭</button>
        <button id="scOvClose" class="icon-btn" title="Fermer">✕</button>
      </div>
      <div class="sc-float-body">
        <div class="sc-searchbar"><input id="scOvQuery" type="text" placeholder="Match ? ex: Maroc ou URL…"/><button id="scOvBtn" class="btn">OK</button></div>
        <div id="scOvResults" class="sc-results"></div>
        <div id="scOvDetail" class="sc-detail"></div>
      </div>
    </div>`;
    document.body.appendChild(ov);
    const float = ov.querySelector('.sc-float');
    // Position mémorisée (coin haut-droit par défaut).
    try { const p = JSON.parse(localStorage.getItem('scFloatPos') || 'null'); if (p) { float.style.left = p.left; float.style.top = p.top; float.style.right = 'auto'; } } catch (_) {}
    if (localStorage.getItem('scFloatMin') === '1') float.classList.add('sc-min');

    ov.querySelector('#scOvClose').onclick = () => ov.classList.add('hidden');
    ov.querySelector('#scOvMin').onclick = () => {
      const m = float.classList.toggle('sc-min');
      localStorage.setItem('scFloatMin', m ? '1' : '0');
    };

    // Déplacement par la barre de titre.
    const head = ov.querySelector('#scOvHead');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      const r = float.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const x = Math.max(4, Math.min(window.innerWidth - 80, e.clientX - drag.dx));
      const y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - drag.dy));
      float.style.left = x + 'px'; float.style.top = y + 'px'; float.style.right = 'auto';
    });
    window.addEventListener('mouseup', () => {
      if (drag) { localStorage.setItem('scFloatPos', JSON.stringify({ left: float.style.left, top: float.style.top })); drag = null; }
    });

    const input = ov.querySelector('#scOvQuery'), results = ov.querySelector('#scOvResults'), detail = ov.querySelector('#scOvDetail');
    const pick = async (ev) => {
      detail.innerHTML = '<div class="sc-empty">Chargement…</div>'; results.innerHTML = '';
      try { const full = await api.sofaMatch(ev.url || ev.id); renderDetail(detail, full); }
      catch (e) { detail.innerHTML = '<div class="sc-empty">Erreur : ' + esc(e.message) + '</div>'; }
    };
    const run = async () => {
      const q = input.value.trim(); if (!q) return;
      results.innerHTML = '<div class="sc-empty">Recherche…</div>'; detail.innerHTML = '';
      try { const data = await api.sofaSearch(q); renderResults(results, data, pick); if (data.events && data.events.length === 1) pick(data.events[0]); }
      catch (e) { results.innerHTML = '<div class="sc-empty">Erreur : ' + esc(e.message) + '</div>'; }
    };
    ov.querySelector('#scOvBtn').onclick = run;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    return ov;
  }
  function toggleOverlay() {
    const o = ensureOverlay();
    o.classList.toggle('hidden');
    if (!o.classList.contains('hidden')) {
      const i = o.querySelector('#scOvQuery');
      if (i) {
        // Pré-remplit avec le programme EPG en cours s'il ressemble à un match (contient un séparateur).
        const hint = window._scEpgTitle || '';
        if (!i.value && /[-–:vV] | vs /.test(hint)) i.value = hint;
        i.focus(); i.select();
      }
    }
  }

  // --- détection chaîne sportive --------------------------------------------
  // Couvre les nommages courants des bouquets (FR/EN/AR) de catégories & chaînes.
  const SPORT_RE = /\b(sport|sports|bein|be\s?in|espn|dazn|eurosport|canal\+?\s*sport|sky\s*spo|ssc|supersport|tnt\s*sport|football|foot|soccer|rugby|tennis|basket|nba|nfl|nhl|mlb|f1|formula|moto\s?gp|ufc|mma|boxe|boxing|premier\s*league|la\s*liga|serie\s*a|bundesliga|ligue\s*1|champions|uefa|caf|fifa|astro\s*supersport|fanatik|match\b|s[-\s]?sport)\b/i;
  function isSport(channel, catName) {
    return SPORT_RE.test(catName || '') || SPORT_RE.test((channel && channel.name) || '');
  }
  // Appelé par renderer.play() : montre ⚽ seulement sur le sport et mémorise un
  // pré-remplissage de recherche (nom de chaîne nettoyé) pour l'overlay.
  window.ktvUpdateMatchBtn = function (channel, catName) {
    const btn = $('btnMatch'); if (!btn) return;
    if (isSport(channel, catName)) {
      btn.classList.remove('hidden');
      const raw = (channel && channel.name) || '';
      // Retire les préfixes type "BEIN SPORTS 1 HD :" pour proposer une requête utile.
      window._scSuggest = raw.replace(/\b(hd|fhd|4k|uhd|sd|vip|fr|ar|en)\b/gi, '').replace(/[|:\-•]+/g, ' ').replace(/\s+/g, ' ').trim();
    } else {
      btn.classList.add('hidden');
      window._scSuggest = '';
    }
  };

  // --- bandeau de progression de mise à jour ---------------------------------
  function updateProgress(p) {
    let bar = $('scUpdBar');
    if (!bar) {
      bar = el('div', 'sc-upd', '<span class="sc-upd-lbl"></span><div class="sc-upd-track"><div class="sc-upd-fill"></div></div>');
      bar.id = 'scUpdBar';
      document.body.appendChild(bar);
    }
    const pct = Math.round((p.value || 0) * 100);
    bar.querySelector('.sc-upd-lbl').textContent = p.phase === 'install'
      ? 'Installation… KTV va redémarrer'
      : 'Téléchargement de la mise à jour… ' + pct + '%';
    bar.querySelector('.sc-upd-fill').style.width = pct + '%';
  }

  // --- wiring ----------------------------------------------------------------
  function boot() {
    const nav = document.querySelector('.rail .nav[data-view="sport"]');
    if (nav) nav.addEventListener('click', () => setTimeout(initTab, 0));
    const btn = $('btnMatch');
    if (btn) btn.addEventListener('click', toggleOverlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ov && !ov.classList.contains('hidden')) ov.classList.add('hidden');
    });
    if (api.onUpdateProgress) api.onUpdateProgress(updateProgress);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

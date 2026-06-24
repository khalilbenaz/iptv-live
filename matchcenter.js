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
    if (!events.length) { box.innerHTML = '<div class="sc-empty">Aucun match <b>en direct</b> pour cette recherche.<br>Colle l’URL Sofascore pour ouvrir un match précis.</div>'; return; }
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

  // --- activation du menu Sport (réglage) ------------------------------------
  // Le menu Foot ne s'affiche que si activé dans les Réglages.
  function sportEnabled() {
    try { return JSON.parse(localStorage.getItem('ktv_settings') || '{}').sportEnabled === true; }
    catch (_) { return false; }
  }
  window.ktvApplySportSetting = function () {
    const on = sportEnabled();
    const nav = document.querySelector('.rail .nav[data-view="sport"]');
    if (nav) nav.classList.toggle('hidden', !on);
    // Si on désactive alors qu'on est sur l'onglet Sport, on repart à l'accueil.
    if (!on && typeof showView === 'function') {
      const cur = document.querySelector('.view.active');
      if (cur && cur.id === 'view-sport') showView('home');
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
    window.ktvApplySportSetting();   // masque/affiche le menu Sport selon le réglage
    if (api.onUpdateProgress) api.onUpdateProgress(updateProgress);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

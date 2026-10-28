/* SME — Système de Monitoring Énergétique — application web (vanilla JS + Chart.js)
   Organisation : utilitaires · navigation · vues (une fonction par écran) · actions.
   Aucune logique métier ici : tous les calculs sont faits côté serveur (API). */
'use strict';

const TZ = 'Africa/Casablanca';
const S = { meta: null, live: null, view: null, charts: {}, timers: [], onLive: null, lang: 'fr', cache: {} };
const ACT = {};      // actions déclenchées par data-act (pas de gestionnaire inline : CSP stricte)
const CHG = {};      // actions déclenchées par data-chg (événement change)

/* ------------------------------------------------------------------ utilitaires */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (v == null || Number.isNaN(+v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 1) => v == null ? '—' : `${fmt(v, d)} %`;
const _dt = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const _hm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const _dhm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const _hms = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fdt = ts => ts ? _dt.format(new Date(ts * 1000)) : '—';
const fhms = ts => ts ? _hms.format(new Date(ts * 1000)) : '—';
const fdhm = ts => ts ? _dhm.format(new Date(ts * 1000)) : '—';
const fage = s => s == null ? '—' : s < 90 ? `${fmt(s, 0)} s` : s < 5400 ? `${fmt(s / 60, 0)} min` : `${fmt(s / 3600, 1)} h`;
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const color = pid => cssVar('--s' + (pid > 6 ? 7 : pid));
const can = p => S.meta && S.meta.user.permissions.includes(p);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } },
                set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } } };
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const fmois = m => m ? `${MOIS[+m.slice(5) - 1]} ${m.slice(0, 4)}` : '—';

async function api(path, opts = {}) {
  // Version statique : l'« API » est servie par le moteur local (backend.js), sans serveur.
  try { return await SME.request(opts.method || 'GET', path, opts.body); }
  catch (e) { throw new Error(e.message || 'Erreur'); }
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = msg; $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg, 'ok'); return r; } catch (e) { toast(e.message, 'err'); return null; }
}
function every(fn, ms) { S.timers.push(setInterval(fn, ms)); }
function chart(id, cfg) {
  const el = document.getElementById(id); if (!el) return null;
  S.charts[id]?.destroy();
  S.charts[id] = new Chart(el, cfg); return S.charts[id];
}
function tk(id) { return S.charts[id]; }

/* ------------------------------------------------------------------ badges (icône + libellé) */
const QUAL = { valide: ['b-good', 'Valide'], suspecte: ['b-warning', 'Suspecte'], invalide: ['b-critical', 'Invalide'],
  perdue: ['b-critical', 'Perdue'], absente: ['b-stale', 'Absente'] };
const FRESH = { 'fraîche': 'b-good', 'ancienne': 'b-warning', 'périmée': 'b-stale', 'absente': 'b-stale' };
const PRIO = { critique: 'b-critical', majeure: 'b-serious', mineure: 'b-warning' };
const ETAT = { nouvelle: ['b-info', 'Nouvelle'], prise_en_charge: ['b-warning', 'Prise en charge'], cloturee: ['b-stale', 'Clôturée'] };
const IPEST = { conforme: 'b-good', 'à surveiller': 'b-warning', 'dérive': 'b-critical' };
const badge = (cls, txt, title = '') => `<span class="badge ${cls}" ${title ? `title="${esc(title)}"` : ''}>${esc(txt)}</span>`;
const qBadge = (q, motifs) => badge((QUAL[q] || QUAL.absente)[0], (QUAL[q] || QUAL.absente)[1], (motifs || []).join(' ; '));
const fBadge = (f, age) => badge(FRESH[f] || 'b-stale', `${f[0].toUpperCase()}${f.slice(1)}${age != null ? ' · ' + fage(age) : ''}`,
  'Fraîcheur = âge de la dernière mesure reçue');
const pBadge = p => badge(PRIO[p] || 'b-stale', p ? p[0].toUpperCase() + p.slice(1) : '—');
const eBadge = e => badge((ETAT[e] || ['b-stale', e])[0], (ETAT[e] || ['', e])[1]);
function vcell(x, d = 1, unit = '') {
  if (!x || x.v == null) return `<b class="muted" title="Donnée absente">absente</b>`;
  if (x.q === 'invalide') return `<span class="inv"><b title="Valeur invalide (hors plage)">${fmt(x.v, d)}</b></span>`;
  return `<b>${fmt(x.v, d)}${unit ? ` <span class="muted small">${unit}</span>` : ''}</b>`;
}
const loadColor = c => c >= 100 ? 'var(--critical)' : c >= 90 ? 'var(--warning)' : 'var(--good)';

/* ------------------------------------------------------------------ navigation & i18n */
const IC = {
  dash: '<path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z"/>',
  post: '<path d="M7 2v6H4l8 14 8-14h-3V2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  tree: '<path d="M4 4h6v4H4zm10 12h6v4h-6zm0-8h6v4h-6zM7 8v10h7M7 12h7" fill="none" stroke="currentColor" stroke-width="2"/>',
  hist: '<path d="M3 3v18h18M7 15l4-5 3 3 5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  ipe: '<path d="M12 3a9 9 0 1 0 9 9h-9z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  ser: '<path d="M3 17l5-5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 21h18" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3"/>',
  alert: '<path d="M12 3 2 20h20zM12 10v4m0 3v.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  modbus: '<path d="M4 6h16v5H4zm0 7h16v5H4zM7 8.5h.01M7 15.5h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sim: '<path d="M4 20V9l5-3v14m0-9 6-4v15M15 7l5 3v10M2 20h20" fill="none" stroke="currentColor" stroke-width="2"/>',
  test: '<path d="M9 11l2 2 4-4M5 3h14v18H5z" fill="none" stroke="currentColor" stroke-width="2"/>',
  rep: '<path d="M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h6" fill="none" stroke="currentColor" stroke-width="2"/>',
  adm: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6" fill="none" stroke="currentColor" stroke-width="2"/>',
  todo: '<path d="M4 6h2m4 0h10M4 12h2m4 0h10M4 18h2m4 0h10" stroke="currentColor" stroke-width="2"/>',
};
const NAV = [
  ['Supervision', 'Monitoring'],
  ['dashboard', 'dash', 'Tableau de bord', 'Dashboard', 'Vue générale du site et synoptique des 6 postes'],
  ['postes', 'post', 'Postes électriques', 'Substations', 'Mesures instantanées, fraîcheur, schéma unifilaire'],
  ['historique', 'hist', 'Historiques & courbes', 'History', 'Filtrage par période, point, grandeur — export CSV'],
  ['alertes', 'alert', 'Alertes', 'Alarms', 'Détection, prise en charge, clôture, historique'],
  ['Performance énergétique', 'Energy performance'],
  ['ipe', 'ipe', 'Indicateurs (IPE)', 'EnPIs', 'ISO 50001 §6.4 — définition, calcul, cibles'],
  ['ser', 'ser', 'Situation de référence', 'Baseline (EnB)', 'ISO 50001 §6.5 — modèle, écarts, CUSUM, versions'],
  ['rapports', 'rep', 'Rapports', 'Reports', 'Revue énergétique mensuelle (A4 imprimable)'],
  ['Exploitation', 'Operations'],
  ['patrimoine', 'tree', 'Patrimoine & compteurs', 'Assets & meters', 'Site, postes, compteurs, points de comptage, registres'],
  ['acquisition', 'modbus', 'Acquisition Modbus', 'Modbus acquisition', 'Supervision du service de collecte Modbus TCP/IP'],
  ['simulation', 'sim', 'Simulation terrain', 'Field simulation', 'Activité portuaire et injection d\'incidents (démonstration)'],
  ['recette', 'test', 'Recette (T01–T15)', 'Acceptance tests', 'Plan de tests de la spécification §8'],
  ['admin', 'adm', 'Administration', 'Administration', 'Utilisateurs, rôles, tarifs, sauvegardes, journal d\'audit'],
  ['valider', 'todo', 'Points à valider', 'Open points', 'Hypothèses de démonstration à confirmer avec la DEPA (§11)'],
];
function buildNav() {
  const en = S.lang === 'en';
  $('#nav').innerHTML = NAV.map(n => n.length === 2
    ? `<div class="nav-sec">${esc(en ? n[1] : n[0])}</div>`
    : `<a href="#/${n[0]}" data-view="${n[0]}"><svg viewBox="0 0 24 24" fill="currentColor">${IC[n[1]]}</svg><span>${esc(en ? n[3] : n[2])}</span>${n[0] === 'alertes' ? '<span class="badge b-critical hidden" id="navAlerts"></span>' : ''}</a>`).join('');
}
function route() {
  const v = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const def = NAV.find(n => n[0] === v && n.length > 2) || NAV[1];
  S.timers.forEach(clearInterval); S.timers = [];
  Object.values(S.charts).forEach(c => c.destroy()); S.charts = {};
  S.onLive = null; S.view = def[0];
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.view === def[0]));
  $('#viewTitle').textContent = S.lang === 'en' ? def[3] : def[2];
  $('#viewSub').textContent = def[4];
  document.title = `SME — ${def[2]}`;
  $('#side').classList.remove('open');
  const el = $('#view'); el.innerHTML = '<div class="empty">Chargement…</div>';
  Promise.resolve(VIEWS[def[0]](el)).catch(e => { el.innerHTML = `<div class="card empty">Erreur : ${esc(e.message)}</div>`; });
  el.focus({ preventScroll: true }); window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------ boucle temps réel */
async function pollLive() {
  try {
    S.live = await api('/api/live');
    $('#liveDot').className = 'dot live';
    $('#liveTxt').textContent = `Temps réel · ${fmt(S.live.acquisition.periode_mesuree_s || S.live.acquisition.periode_cible_s, 1)} s`;
    const n = S.live.alertes.reduce((a, b) => a + b.n, 0);
    const nb = $('#navAlerts');
    if (nb) { nb.textContent = n; nb.classList.toggle('hidden', !n); }
    if (S.onLive) S.onLive(S.live);
  } catch (e) {
    $('#liveDot').className = 'dot off'; $('#liveTxt').textContent = 'Liaison serveur perdue';
  }
}

/* ------------------------------------------------------------------ graphiques : options communes */
function chartBase({ yTitle = '', stacked = false, xTime = true, legend = false, yMin, xMin, xMax } = {}) {
  const grid = cssVar('--grid'), axis = cssVar('--axis'), muted = cssVar('--muted'), ink = cssVar('--ink');
  return {
    responsive: true, maintainAspectRatio: false, animation: false, normalized: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend, labels: { color: ink, boxWidth: 10, boxHeight: 10, usePointStyle: false } },
      tooltip: {
        backgroundColor: cssVar('--surface-3'), titleColor: ink, bodyColor: ink, borderColor: cssVar('--line-strong'), borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true,
        callbacks: xTime ? { title: it => it.length ? fdhm(it[0].parsed.x) : '' } : {},
      },
    },
    scales: {
      x: xTime ? { type: 'linear', min: xMin, max: xMax, grid: { color: grid, drawTicks: false }, border: { color: axis },
        ticks: { color: muted, maxTicksLimit: 8, padding: 6, callback: v => (S._span || 86400) > 2 * 86400 ? fdhm(v).slice(0, 5) + ' ' + _hm.format(new Date(v * 1000)) : _hm.format(new Date(v * 1000)) } }
        : { grid: { display: false }, border: { color: axis }, ticks: { color: muted } },
      y: { stacked, min: yMin, grid: { color: grid, drawTicks: false }, border: { display: false },
        ticks: { color: muted, padding: 6, callback: v => fmt(v, Math.abs(v) < 10 && v % 1 ? 2 : 0) },
        title: { display: !!yTitle, text: yTitle, color: muted } },
    },
    elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 8 }, line: { borderWidth: 2, tension: 0.15 } },
  };
}
function legendHtml(items) {
  return `<div class="legend">${items.map(i => `<span><i class="${i.kind || ''}" style="background:${i.color};color:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>`;
}

/* ================================================================== VUES */
const VIEWS = {};
const banner = () => `<div class="demo-banner no-print"><span class="badge b-warning">Démonstrateur</span>
  Compteurs simulés dans votre navigateur (trames Modbus TCP réelles, transport en mémoire) ; vos actions restent propres à ce navigateur. Noms de postes, registres, IPE, SER, seuils et tarifs sont des hypothèses à valider avec la DEPA (voir « Points à valider »).</div>`;

/* ---------------------------------------------------------------- Tableau de bord */
VIEWS.dashboard = async el => {
  el.innerHTML = `${banner()}
  <div class="grid g-tiles">
    ${['Puissance appelée|t-p', 'Énergie du jour|t-e', 'Coût estimé du jour|t-c', 'Émissions du jour|t-co2', 'Alertes ouvertes|t-a', 'Disponibilité des mesures|t-d']
      .map(s => { const [l, id] = s.split('|'); return `<div class="card tile"><div class="lbl">${l}</div><div class="val num" id="${id}">—</div><div class="foot" id="${id}-f">&nbsp;</div></div>`; }).join('')}
  </div>
  <div class="card mt"><div class="card-h"><h2>Synoptique énergétique du port</h2><span class="sub">Arrivée ONEE 22 kV · 6 postes 22/0,4 kV · cliquer un poste pour le détail</span></div>
    <div id="syn" style="overflow-x:auto"></div></div>
  <div class="grid g-21 mt">
    <div class="card"><div class="card-h"><h2>Courbe de charge — 24 h</h2><span class="sub">Puissance active moyenne 5 min, empilée par poste (kW)</span></div>
      <div id="lg24"></div><div class="chart-box tall"><canvas id="c24" aria-label="Courbe de charge 24 heures"></canvas></div></div>
    <div class="card"><div class="card-h"><h2>Énergie du jour par poste</h2><span class="sub">kWh depuis 00:00</span></div>
      <div class="chart-box"><canvas id="cday" aria-label="Énergie du jour par poste"></canvas></div>
      <div id="tarifSplit" class="mt small ink2"></div></div>
  </div>
  <div class="grid g-2 mt">
    <div class="card"><div class="card-h"><h2>Activité portuaire</h2><span class="sp"></span><a class="small" href="#/simulation">Simulation ›</a></div><div id="act"></div></div>
    <div class="card"><div class="card-h"><h2>Alertes à traiter</h2><span class="sp"></span><a class="small" href="#/alertes">Toutes ›</a></div><div id="dashAlerts"></div></div>
  </div>`;
  const posts = S.meta.posts;
  const sous = posts.reduce((a, p) => a + p.souscrite_kw, 0);
  S.onLive = live => {
    const pts = live.points;
    $('#t-p').innerHTML = `${fmt(live.total_kw)}<small>kW</small>`;
    $('#t-p-f').textContent = `${fmt(live.total_kw / sous * 100, 0)} % de la puissance souscrite (${fmt(sous)} kW)`;
    const na = live.alertes.reduce((a, b) => a + b.n, 0);
    const byP = Object.fromEntries(live.alertes.map(a => [a.priorite, a.n]));
    $('#t-a').innerHTML = `${na}`;
    $('#t-a-f').innerHTML = na ? ['critique', 'majeure', 'mineure'].filter(p => byP[p]).map(p => `${pBadge(p)} ${byP[p]}`).join(' ') : badge('b-good', 'Aucune');
    const d = live.acquisition.disponibilite;
    $('#t-d').innerHTML = `${fmt((d ?? 0) * 100, 1)}<small>%</small>`;
    const coh = live.acquisition.coherence;
    $('#t-d-f').textContent = `Scrutation ${fmt(live.acquisition.periode_mesuree_s, 2)} s${coh ? ` · tête/postes ${coh.ecart_pct >= 0 ? '+' : ''}${fmt(coh.ecart_pct, 1)} %` : ''}`;
    $('#syn').innerHTML = synoptique(live);
    $('#act').innerHTML = activityHtml(live.simulation);
  };
  if (S.live) S.onLive(S.live);
  const slow = async () => {
    const [today, hist, al] = await Promise.all([api('/api/energy/today'),
      api(`/api/history?points=1,2,3,4,5,6&grandeur=p_moy&from=${Math.floor(Date.now() / 1000) - 86400}&pas=300`),
      api('/api/alerts?etat=ouvertes&limit=5')]);
    const tar = S.meta.tarif;
    $('#t-e').innerHTML = `${fmt(today.total_kwh)}<small>kWh</small>`;
    $('#t-e-f').textContent = `Postes P1 à P6 · compteur de tête exclu`;
    $('#t-c').innerHTML = `${fmt(today.cout)}<small>${today.devise}</small>`;
    $('#t-c-f').textContent = 'Barème indicatif (à valider)';
    $('#t-co2').innerHTML = `${fmt(today.co2_t, 1)}<small>t CO₂</small>`;
    $('#t-co2-f').textContent = `Facteur ${fmt(tar.co2_kg_kwh, 2)} kg/kWh (paramétrable)`;
    const pp = today.par_periode;
    $('#tarifSplit').innerHTML = `Répartition horo-saisonnière : <b>pointe</b> ${fmt(pp.pointe)} kWh · <b>pleines</b> ${fmt(pp.pleines)} kWh · <b>creuses</b> ${fmt(pp.creuses)} kWh`;
    S._span = 86400;
    $('#lg24').innerHTML = legendHtml(posts.map(p => ({ label: `${p.code} ${p.libelle}`, color: color(p.id) })));
    const ds = posts.map(p => ({ label: p.code, data: (hist.series[p.id] || []).map(r => ({ x: r[0], y: r[1] })),
      borderColor: color(p.id), backgroundColor: color(p.id) + 'cc', fill: true, borderWidth: 1, pointRadius: 0, stack: 's' }));
    const opt = chartBase({ yTitle: 'kW', stacked: true, xMin: hist.t1, xMax: hist.t2 });
    opt.plugins.tooltip.callbacks.label = c => ` ${c.dataset.label} : ${fmt(c.parsed.y)} kW`;
    opt.plugins.tooltip.callbacks.footer = it => `Total : ${fmt(it.reduce((a, b) => a + (b.parsed.y || 0), 0))} kW`;
    if (tk('c24')) { tk('c24').data.datasets = ds; tk('c24').update(); } else chart('c24', { type: 'line', data: { datasets: ds }, options: opt });
    const bars = posts.map(p => today.par_point[p.id] || 0);
    const ob = chartBase({ xTime: false });
    ob.indexAxis = 'y'; ob.interaction = { mode: 'nearest', intersect: true, axis: 'y' };
    ob.scales = { x: { grid: { color: cssVar('--grid') }, border: { display: false }, ticks: { color: cssVar('--muted'), callback: v => fmt(v) } },
      y: { grid: { display: false }, ticks: { color: cssVar('--ink') } } };
    ob.plugins.tooltip.callbacks = { label: c => ` ${fmt(c.parsed.x)} kWh (${fmt(c.parsed.x / today.total_kwh * 100, 1)} %)` };
    const bd = { labels: posts.map(p => p.code + ' ' + p.libelle.replace('Poste ', '').split(/ [&—]/)[0].slice(0, 20)),
      datasets: [{ data: bars, backgroundColor: posts.map(p => color(p.id)), borderRadius: 4, borderSkipped: 'start', barThickness: 16 }] };
    if (tk('cday')) { tk('cday').data = bd; tk('cday').update(); } else chart('cday', { type: 'bar', data: bd, options: ob });
    $('#dashAlerts').innerHTML = al.alertes.length ? `<div class="grid" style="gap:8px">${al.alertes.map(a => `
      <a href="#/alertes" style="text-decoration:none;color:inherit" class="row">${pBadge(a.priorite)} <span class="small">${esc(a.message)}</span>
      <span class="muted small" style="margin-left:auto">${fhms(a.ts_detection)}</span></a>`).join('')}</div>`
      : `<div class="muted small">${badge('b-good', 'Aucune alerte ouverte')}</div>`;
  };
  await slow(); every(slow, 60000);
};

function activityHtml(sim) {
  const c = sim.ctx;
  return `<div class="row small" style="gap:6px;margin-bottom:8px">
    ${badge(c.navire_conteneurs ? 'b-info' : 'b-stale', c.navire_conteneurs ? 'Porte-conteneurs à quai' : 'Pas de porte-conteneurs')}
    ${badge(c.navire_vrac ? 'b-info' : 'b-stale', c.navire_vrac ? 'Vraquier à quai' : 'Pas de vraquier')}
    ${badge('b-info', `${c.reefers} reefers branchés`)}</div>
    ${sim.grues.map(g => `<div class="crane"><b class="small">${g.grue}</b>
      <div><div class="small ink2">${esc(g.phase)}</div><div class="loadbar"><i style="width:${Math.round((g.progress || 0) * 100)}%;background:var(--s4)"></i></div></div>
      <span class="num small" style="text-align:right">${fmt(g.kw)} kW</span></div>`).join('')}
    ${Object.keys(sim.incidents).length ? `<div class="mt small">${Object.entries(sim.incidents).map(([p, t]) => badge('b-serious', `Incident simulé point ${p} : ${S.meta.incidents[t]}`)).join(' ')}</div>` : ''}`;
}

function synoptique(live) {
  const posts = S.meta.posts, W = 1200, H = 430;
  const head = live.points.find(p => p.role === 'tete');
  const hv = head?.valeurs?.P?.v;
  const coh = live.acquisition.coherence;
  let s = `<svg class="syn" viewBox="0 0 ${W} ${H}" role="img" aria-label="Synoptique des six postes électriques">
    <rect x="470" y="8" width="260" height="70" rx="8" class="box"/>
    <text x="600" y="30" text-anchor="middle" font-weight="700" font-size="14">Arrivée ONEE 22 kV</text>
    <text x="600" y="50" text-anchor="middle" class="lbl2">Compteur de tête (existant, contrôle)</text>
    <text x="600" y="69" text-anchor="middle" font-size="13" class="num">${head?.qualite === 'perdue' ? 'Comm. perdue' : `${fmt(hv)} kW${coh ? ` · écart Σ postes ${coh.ecart_pct >= 0 ? '+' : ''}${fmt(coh.ecart_pct, 1)} %` : ''}`}</text>
    <line x1="600" y1="78" x2="600" y2="118" class="wire"/>
    <line x1="80" y1="120" x2="1120" y2="120" class="bus"/>
    <text x="1120" y="108" text-anchor="end" class="lbl2">Jeu de barres 22 kV</text>`;
  posts.forEach((p, i) => {
    const x = 100 + i * 200;
    const pt = live.points.find(q => q.point_id === p.id) || {};
    const P = pt.valeurs?.P?.v;
    const lost = pt.qualite === 'perdue';
    const ch = P != null ? P / p.souscrite_kw * 100 : null;
    const fl = lost ? 'var(--stale)' : loadColor(ch);
    const al = (S.cache.openByPost || {})[p.id];
    s += `<line x1="${x}" y1="120" x2="${x}" y2="160" class="wire"/>
      <path d="M${x} 120 V160" class="flow" style="stroke:${fl}"/>
      <circle cx="${x}" cy="172" r="12" class="trafo"/><circle cx="${x}" cy="190" r="12" class="trafo"/>
      <text x="${x + 20}" y="185" class="lbl2">${fmt(p.transfo_kva)} kVA</text>
      <line x1="${x}" y1="202" x2="${x}" y2="232" class="wire"/>
      <path d="M${x} 202 V232" class="flow" style="stroke:${fl}"/>
      <g class="post" data-act="openPoste" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(p.code + ' ' + p.libelle)}">
        <rect x="${x - 88}" y="232" width="176" height="186" rx="9" class="box"/>
        <rect x="${x - 76}" y="244" width="30" height="20" rx="5" style="fill:${color(p.id)}"/>
        <text x="${x - 61}" y="258" text-anchor="middle" font-size="11.5" font-weight="700" style="fill:#fff">${p.code}</text>
        <text x="${x - 38}" y="258" font-size="11.5" class="lbl2">${esc(p.libelle.replace('Poste ', '').slice(0, 20))}</text>
        <text x="${x - 76}" y="300" font-size="26" font-weight="650" class="num" ${lost ? 'opacity=".5"' : ''}>${fmt(P)}</text>
        <text x="${x + 76}" y="300" text-anchor="end" class="lbl2">kW</text>
        <rect x="${x - 76}" y="314" width="152" height="8" rx="4" class="barbg"/>
        <rect x="${x - 76}" y="314" width="${Math.max(0, Math.min(152, 152 * (ch || 0) / 110))}" height="8" rx="4" style="fill:${fl}"/>
        <line x1="${x - 76 + 152 * 100 / 110}" y1="310" x2="${x - 76 + 152 * 100 / 110}" y2="326" style="stroke:var(--ink-2);stroke-width:1.5"/>
        <text x="${x - 76}" y="342" class="lbl2">Charge ${fmt(ch, 0)} % · ${fmt(p.souscrite_kw)} kW sousc.</text>
        <text x="${x - 76}" y="362" class="lbl2">cos φ ${fmt(pt.valeurs?.PF?.v, 2)} · ${fmt(pt.valeurs?.U?.v, 0)} V</text>
        <circle cx="${x - 70}" cy="384" r="5" style="fill:${lost ? 'var(--critical)' : pt.qualite === 'valide' ? 'var(--good)' : 'var(--warning)'}"/>
        <text x="${x - 60}" y="388" font-size="11.5">${lost ? 'Communication perdue' : pt.qualite === 'valide' ? 'Modbus TCP · en ligne' : 'Mesure ' + pt.qualite}</text>
        ${al ? `<rect x="${x - 76}" y="396" width="152" height="16" rx="4" style="fill:var(--critical)"/><text x="${x}" y="408" text-anchor="middle" font-size="10.5" font-weight="700" style="fill:#fff">${al} alerte(s) ouverte(s)</text>` : ''}
      </g>`;
  });
  return s + '</svg>';
}

/* ---------------------------------------------------------------- Postes */
VIEWS.postes = async el => {
  el.innerHTML = `${banner()}<div class="grid g-3" id="pgrid"></div>
  <div class="card mt"><div class="card-h"><h2>Lecture des états</h2></div>
  <div class="small ink2">Une mesure n'est jamais présentée comme temps réel sans son âge :
  ${fBadge('fraîche', 1)} reçue depuis moins de ${fmt(S.meta.acquisition.fraicheur_s)} s ·
  ${fBadge('ancienne', 30)} dernière valeur connue ·
  ${fBadge('périmée', 600)} au-delà de ${fmt(S.meta.acquisition.peremption_s)} s.
  Qualité : ${qBadge('valide')} ${qBadge('suspecte')} (dérive d'horloge, valeur figée) ${qBadge('invalide')} (hors plage) ${qBadge('perdue')} (pas de réponse).
  Une valeur <b>0</b> est une mesure ; <b class="muted">absente</b> signifie qu'aucune donnée n'a été reçue.</div></div>`;
  S.onLive = live => {
    const pts = live.points;
    $('#pgrid').innerHTML = pts.map(pt => {
      const p = S.meta.posts.find(x => x.id === pt.post_id);
      const v = pt.valeurs || {};
      const P = v.P?.v;
      const ch = p && P != null ? P / p.souscrite_kw * 100 : null;
      const stale = pt.fraicheur !== 'fraîche';
      const name = p ? `${p.libelle}` : 'Arrivée ONEE 22 kV — compteur de tête';
      return `<div class="card pcard" data-act="openPoste" data-id="${pt.point_id}">
        <div class="hd"><span class="code" style="background:${color(pt.point_id)}">${p ? p.code : 'TÊTE'}</span>
          <div style="min-width:0"><div style="font-weight:600">${esc(name)}</div><div class="small muted">${esc(p ? p.emplacement : 'Point existant intégré — exclu des agrégations')}</div></div></div>
        <div class="${stale ? 'stale-v' : ''}">
          <div class="big num">${fmt(P)} <span class="small muted">kW</span></div>
          ${p ? `<div class="loadbar"><i style="width:${Math.min(100, ch || 0)}%;background:${loadColor(ch)}"></i></div>
          <div class="small muted" style="margin-top:3px">Charge ${fmt(ch, 0)} % de ${fmt(p.souscrite_kw)} kW souscrits</div>` : ''}
          <div class="kv">
            <div>Q<b>${fmt(v.Q?.v)} kvar</b></div><div>S<b>${fmt(v.S?.v)} kVA</b></div>
            <div class="${v.PF?.q === 'invalide' ? 'inv' : ''}">cos φ<b>${v.PF ? fmt(v.PF.v, 3) : '<span class=muted>absente</span>'}</b></div>
            <div>U<b>${fmt(v.U?.v, pt.role === 'tete' ? 2 : 0)} ${v.U?.u || 'V'}</b></div>
            <div>I<b>${fmt(v.I?.v)} A</b></div><div>F<b>${fmt(v.F?.v, 2)} Hz</b></div>
            <div>THD-U<b>${fmt(v.THD?.v, 1)} %</b></div><div>Index<b>${fmt(v.E?.v)} kWh</b></div>
          </div>
        </div>
        <div class="foot-meta">${fBadge(pt.fraicheur, pt.age_s)} ${qBadge(pt.qualite, pt.motifs)}
          ${pt.incident ? badge('b-serious', 'Incident simulé') : ''}
          <span title="Horodatage de la mesure (horloge compteur)">Mesure ${fhms(pt.ts_mesure)}</span>
          <span title="Horodatage de réception (serveur)">· Reçue ${fhms(pt.ts_reception)}</span>
          ${pt.latence_ms != null ? `<span>· ${fmt(pt.latence_ms, 1)} ms</span>` : ''}</div>
      </div>`;
    }).join('');
  };
  if (S.live) S.onLive(S.live);
};

ACT.openPoste = async el => {
  const id = +el.dataset.id;
  const p = S.meta.posts.find(x => x.id === id);
  const pt = S.meta.points.find(x => x.id === id);
  const live = S.live?.points.find(x => x.point_id === id) || {};
  const v = live.valeurs || {};
  openModal(`${p ? p.code + ' — ' + p.libelle : 'Compteur de tête — arrivée ONEE 22 kV'}`, `
    <div class="grid g-12">
      <div><h4 class="small muted" style="margin-bottom:6px">SCHÉMA UNIFILAIRE (simplifié)</h4>${unifilaire(p, pt)}</div>
      <div>
        <div class="row" style="margin-bottom:10px">${fBadge(live.fraicheur || 'absente', live.age_s)} ${qBadge(live.qualite, live.motifs)}
          <span class="small muted">${esc(pt.equipement)} · ${esc(pt.fabricant)} ${esc(pt.modele)} · IP terrain ${esc(pt.ip)} · Unit ${pt.unit_id}</span></div>
        <div class="tbl-wrap"><table class="t"><thead><tr><th>Grandeur</th><th class="n">Valeur</th><th>Unité</th><th>Qualité</th></tr></thead><tbody>
        ${Object.entries(v).map(([g, x]) => `<tr><td>${g}</td><td class="n">${x.v == null ? '<span class=muted>absente</span>' : fmt(x.v, ['PF'].includes(g) ? 3 : g === 'F' ? 2 : 1)}</td><td>${esc(x.u)}</td><td>${qBadge(x.q)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="small muted mt">Mesure (horloge compteur) : ${fdt(live.ts_mesure)} · Réception (serveur) : ${fdt(live.ts_reception)}</div>
        <h4 class="mt small muted">PUISSANCE ACTIVE — 6 DERNIÈRES HEURES</h4>
        <div class="chart-box short"><canvas id="cPoste"></canvas></div>
      </div>
    </div>`);
  const h = await api(`/api/history?points=${id}&grandeur=p_moy&from=${Math.floor(Date.now() / 1000) - 6 * 3600}&pas=60`);
  S._span = 6 * 3600;
  const o = chartBase({ yTitle: 'kW', xMin: h.t1, xMax: h.t2 });
  o.plugins.tooltip.callbacks.label = c => ` ${fmt(c.parsed.y)} kW`;
  const data = { datasets: [{ label: 'P', data: h.series[id].map(r => ({ x: r[0], y: r[1] })), borderColor: color(id), spanGaps: false }] };
  if (p) data.datasets.push({ label: 'Puissance souscrite', data: [{ x: h.t1, y: p.souscrite_kw }, { x: h.t2, y: p.souscrite_kw }],
    borderColor: cssVar('--critical'), borderDash: [5, 4], borderWidth: 1.5 });
  chart('cPoste', { type: 'line', data, options: o });
};

function unifilaire(p, pt) {
  const deps = p ? p.departs : ['Postes P1 à P6 (via jeu de barres 22 kV)'];
  const w = 400, x = 120;
  let s = `<svg class="syn" viewBox="0 0 ${w} ${p ? 500 : 300}" role="img" aria-label="Schéma unifilaire">
    <text x="${x}" y="16" text-anchor="middle" font-size="12" font-weight="600">Réseau ONEE 22 kV</text>
    <line x1="${x}" y1="22" x2="${x}" y2="50" class="wire"/>
    <line x1="${x - 9}" y1="50" x2="${x + 10}" y2="34" class="trafo"/><text x="${x + 16}" y="46" class="lbl2">Interrupteur-sectionneur</text>
    <line x1="${x}" y1="52" x2="${x}" y2="76" class="wire"/>
    <rect x="${x - 9}" y="76" width="18" height="18" class="box"/><text x="${x + 16}" y="90" class="lbl2">Disjoncteur MT</text>
    <line x1="${x}" y1="94" x2="${x}" y2="112" class="wire"/>`;
  if (!p) {
    s += `<rect x="${x - 60}" y="112" width="120" height="44" rx="6" class="box"/>
      <text x="${x}" y="131" text-anchor="middle" font-size="11.5" font-weight="600">Compteur de tête</text>
      <text x="${x}" y="148" text-anchor="middle" class="lbl2">${esc(pt.ip)} · Unit ${pt.unit_id}</text>
      <line x1="${x}" y1="156" x2="${x}" y2="190" class="wire"/>
      <line x1="20" y1="192" x2="${w - 20}" y2="192" class="bus"/><text x="${w - 20}" y="214" text-anchor="end" class="lbl2">Jeu de barres 22 kV → P1…P6</text></svg>`;
    return s;
  }
  s += `<circle cx="${x}" cy="126" r="14" class="trafo"/><circle cx="${x}" cy="146" r="14" class="trafo"/>
    <text x="${x + 22}" y="132" class="lbl2">Transformateur</text><text x="${x + 22}" y="147" class="lbl2">22 / 0,4 kV · ${fmt(p.transfo_kva)} kVA</text>
    <line x1="${x}" y1="160" x2="${x}" y2="184" class="wire"/>
    <rect x="${x - 9}" y="184" width="18" height="18" class="box"/><text x="${x + 16}" y="198" class="lbl2">Disjoncteur général BT</text>
    <line x1="${x}" y1="202" x2="${x}" y2="226" class="wire"/>
    <rect x="${x - 70}" y="226" width="140" height="46" rx="6" class="box" style="stroke:${color(p.id)};stroke-width:1.5"/>
    <text x="${x}" y="245" text-anchor="middle" font-size="11.5" font-weight="600">${esc(pt.equipement)} · Modbus TCP</text>
    <text x="${x}" y="262" text-anchor="middle" class="lbl2">${esc(pt.ip)}:502 · Unit ${pt.unit_id}</text>
    <line x1="${x}" y1="272" x2="${x}" y2="300" class="wire"/>
    <line x1="20" y1="302" x2="${w - 20}" y2="302" class="bus"/><text x="${w - 20}" y="292" text-anchor="end" class="lbl2">TGBT 400 V</text>`;
  deps.forEach((d, i) => {
    const dx = 50 + i * 85;
    s += `<line x1="${dx}" y1="302" x2="${dx}" y2="340" class="wire"/><rect x="${dx - 6}" y="340" width="12" height="12" class="box"/>
      <line x1="${dx}" y1="352" x2="${dx}" y2="372" class="wire"/><polygon points="${dx - 6},372 ${dx + 6},372 ${dx},382" style="fill:var(--ink-2)"/>
      <text transform="translate(${dx + 4} 392) rotate(40)" class="lbl2" font-size="10">${esc(d)}</text>`;
  });
  return s + '</svg>';
}

/* ---------------------------------------------------------------- Historiques */
VIEWS.historique = async el => {
  const st = S.cache.hist || (S.cache.hist = { span: 86400, points: [1, 2, 3, 4, 5, 6], g: 'p_moy', cmp: false, table: false, from: null, to: null });
  const pts = S.meta.points;
  el.innerHTML = `<div class="card no-print">
    <div class="filters">
      <label class="f">Période<div class="seg" id="spanSeg">${[[6 * 3600, '6 h'], [86400, '24 h'], [3 * 86400, '3 j'], [7 * 86400, '7 j'], [0, 'Personnalisée']]
        .map(([v, l]) => `<button data-act="hSpan" data-v="${v}" class="${st.span === v ? 'on' : ''}">${l}</button>`).join('')}</div></label>
      <label class="f ${st.span ? 'hidden' : ''}" id="cust1">Du<input type="datetime-local" id="hFrom"></label>
      <label class="f ${st.span ? 'hidden' : ''}" id="cust2">Au<input type="datetime-local" id="hTo"></label>
      <label class="f">Grandeur<select id="hG" data-chg="hG">${Object.entries({ p_moy: 'Puissance active moyenne (kW)', p_max: 'Puissance active max (kW)', q_moy: 'Puissance réactive (kvar)', pf_moy: 'Facteur de puissance', u_moy: 'Tension (V / kV)', i_moy: 'Courant (A)', thd_moy: 'THD-U (%)', f_moy: 'Fréquence (Hz)', e_kwh: 'Énergie (kWh par pas)', completude: 'Complétude des mesures' })
        .map(([k, l]) => `<option value="${k}" ${st.g === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="f">Comparer<span class="row"><label class="switch"><input type="checkbox" id="hCmp" data-chg="hCmp" ${st.cmp ? 'checked' : ''}><span></span></label><span class="small ink2">période précédente</span></span></label>
      <span class="sp" style="flex:1"></span>
      <button class="btn" data-act="hTable">${st.table ? 'Vue graphique' : 'Vue tableau'}</button>
      <button class="btn primary" data-act="hCsv">Exporter CSV</button>
    </div>
    <div class="row" style="gap:6px">${pts.map(p => `<label class="chip ${st.points.includes(p.id) ? '' : 'off'}" data-act="hPt" data-id="${p.id}"><span class="sw" style="background:${color(p.id)}"></span>${esc(p.code)} ${p.role === 'tete' ? '(tête)' : ''}</label>`).join('')}</div>
  </div>
  <div class="card mt"><div class="card-h"><h2 id="hTitle">Courbe</h2><span class="sub" id="hSub"></span></div>
    <div id="hLegend"></div><div class="chart-box tall ${st.table ? 'hidden' : ''}"><canvas id="cHist"></canvas></div>
    <div id="hTbl" class="tbl-wrap scroll-y ${st.table ? '' : 'hidden'}"></div>
    <div class="small muted mt">Les périodes sans données (perte de communication) apparaissent comme des <b>interruptions</b> de la courbe — elles ne sont jamais interpolées.
    L'énergie d'une lacune est reconstituée à la reprise par différence d'index du compteur (pas marqué « reconstitué » dans l'export).</div></div>`;
  const toLocal = ts => { const d = new Date(ts * 1000 - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  const now = Math.floor(Date.now() / 1000);
  $('#hFrom').value = toLocal(st.from || now - 86400); $('#hTo').value = toLocal(st.to || now);
  $('#hFrom').addEventListener('change', () => { st.from = Date.parse($('#hFrom').value) / 1000; loadHist(); });
  $('#hTo').addEventListener('change', () => { st.to = Date.parse($('#hTo').value) / 1000; loadHist(); });
  await loadHist();
  every(() => { if (st.span) loadHist(); }, 60000);
};
function histRange() {
  const st = S.cache.hist, now = Math.floor(Date.now() / 1000);
  return st.span ? [now - st.span, now] : [st.from || now - 86400, st.to || now];
}
async function loadHist() {
  const st = S.cache.hist;
  const [t1, t2] = histRange();
  const pts = st.points.length ? st.points : [1];
  const q = `points=${pts.join(',')}&grandeur=${st.g}&from=${t1}&to=${t2}`;
  const h = await api('/api/history?' + q);
  const prev = st.cmp ? await api(`/api/history?points=${pts.join(',')}&grandeur=${st.g}&from=${2 * t1 - t2}&to=${t1}&pas=${h.pas}`) : null;
  S._span = t2 - t1;
  $('#hTitle').textContent = h.libelle;
  $('#hSub').textContent = `${fdt(t1)} → ${fdt(t2)} · pas ${h.pas / 60} min`;
  const items = pts.map(id => ({ label: S.meta.points.find(p => p.id === id).code, color: color(id) }));
  if (prev) items.push({ label: 'période précédente (même couleur, pointillés)', color: cssVar('--ink-2'), kind: 'dash' });
  $('#hLegend').innerHTML = legendHtml(items);
  const ds = pts.map(id => ({ label: S.meta.points.find(p => p.id === id).code, data: (h.series[id] || []).map(r => ({ x: r[0], y: r[1] })), borderColor: color(id), spanGaps: false }));
  if (prev) pts.forEach(id => ds.push({ label: S.meta.points.find(p => p.id === id).code + ' (préc.)',
    data: (prev.series[id] || []).map(r => ({ x: r[0] + (t2 - t1), y: r[1] })), borderColor: color(id), borderDash: [4, 4], borderWidth: 1.5, spanGaps: false }));
  const o = chartBase({ xMin: t1, xMax: t2 });
  const dec = ['pf_moy', 'completude'].includes(st.g) ? 3 : st.g === 'f_moy' ? 2 : 1;
  o.plugins.tooltip.callbacks.label = c => ` ${c.dataset.label} : ${c.parsed.y == null ? 'pas de donnée' : fmt(c.parsed.y, dec)}`;
  if (tk('cHist')) { tk('cHist').destroy(); delete S.charts.cHist; }
  chart('cHist', { type: 'line', data: { datasets: ds }, options: o });
  const rows = (h.series[pts[0]] || []).map((r, i) => [r[0], ...pts.map(id => (h.series[id] || [])[i])]);
  $('#hTbl').innerHTML = `<table class="t"><thead><tr><th>Horodatage</th>${pts.map(id => `<th class="n">${S.meta.points.find(p => p.id === id).code}</th>`).join('')}<th class="n">Complétude ${S.meta.points.find(p => p.id === pts[0]).code}</th></tr></thead>
    <tbody>${rows.slice(-500).reverse().map(r => `<tr><td class="mono">${fdhm(r[0])}</td>${r.slice(1).map(x => `<td class="n">${x && x[1] != null ? fmt(x[1], dec) : '<span class="muted">sans donnée</span>'}${x && x[3] ? ' <span class="badge b-info plain" title="Énergie reconstituée par index">R</span>' : ''}</td>`).join('')}<td class="n">${r[1] ? pct(r[1][2] * 100, 0) : '—'}</td></tr>`).join('')}</tbody></table>`;
}
ACT.hSpan = el => { S.cache.hist.span = +el.dataset.v; route(); };
ACT.hPt = el => { const st = S.cache.hist, id = +el.dataset.id; st.points = st.points.includes(id) ? st.points.filter(x => x !== id) : [...st.points, id].sort(); el.classList.toggle('off'); loadHist(); };
ACT.hTable = () => { S.cache.hist.table = !S.cache.hist.table; route(); };
ACT.hCsv = () => { const st = S.cache.hist; const [t1, t2] = histRange(); SME.exportCsv(st.points.length ? st.points : [1], t1, t2); toast('Export CSV téléchargé', 'ok'); };
CHG.hG = el => { S.cache.hist.g = el.value; loadHist(); };
CHG.hCmp = el => { S.cache.hist.cmp = el.checked; loadHist(); };

/* ---------------------------------------------------------------- Alertes */
VIEWS.alertes = async el => {
  const st = S.cache.al || (S.cache.al = { etat: 'ouvertes' });
  el.innerHTML = `<div class="grid g-tiles" id="alTiles"></div>
  <div class="card mt"><div class="card-h"><h2>Journal des alertes</h2><span class="sp"></span>
    <div class="seg">${[['ouvertes', 'Ouvertes'], ['nouvelle', 'Nouvelles'], ['prise_en_charge', 'Prises en charge'], ['cloturee', 'Clôturées'], ['toutes', 'Toutes']]
      .map(([v, l]) => `<button data-act="alEtat" data-v="${v}" class="${st.etat === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="tbl-wrap scroll-y" style="max-height:520px" id="alTbl"></div></div>
  <div class="card mt"><div class="card-h"><h2>Catalogue des règles</h2><span class="sub">Seuils, priorités et délais configurables ${can('config.seuils') ? '' : '— lecture seule pour votre rôle'} · modifications journalisées</span></div>
    <div class="tbl-wrap" id="rulesTbl"></div></div>`;
  const load = async () => {
    const d = await api(`/api/alerts?etat=${st.etat}`);
    const cnt = (e, p) => d.stats.filter(s => (!e || s.etat === e) && (!p || s.priorite === p)).reduce((a, b) => a + b.n, 0);
    $('#alTiles').innerHTML = [['Nouvelles', cnt('nouvelle'), 'b-info'], ['Prises en charge', cnt('prise_en_charge'), 'b-warning'], ['Clôturées', cnt('cloturee'), 'b-stale'],
      ['Critiques ouvertes', d.stats.filter(s => s.etat !== 'cloturee' && s.priorite === 'critique').reduce((a, b) => a + b.n, 0), 'b-critical'],
      ['Majeures ouvertes', d.stats.filter(s => s.etat !== 'cloturee' && s.priorite === 'majeure').reduce((a, b) => a + b.n, 0), 'b-serious'],
      ['Mineures ouvertes', d.stats.filter(s => s.etat !== 'cloturee' && s.priorite === 'mineure').reduce((a, b) => a + b.n, 0), 'b-warning']]
      .map(([l, n, c]) => `<div class="card tile"><div class="lbl">${badge(c, l)}</div><div class="val num">${n}</div></div>`).join('');
    $('#alTbl').innerHTML = d.alertes.length ? `<table class="t"><thead><tr><th>#</th><th>Détection</th><th>Priorité</th><th>Règle</th><th>Équipement</th><th>Message</th><th class="n">Valeur</th><th class="n">Seuil</th><th>Condition</th><th>État</th></tr></thead><tbody>
      ${d.alertes.map(a => `<tr class="click" data-act="openAlert" data-id="${a.id}"><td class="mono">${a.id}</td><td class="mono">${fdt(a.ts_detection)}</td><td>${pBadge(a.priorite)}</td>
        <td><span class="mono">${a.rule_code}</span></td><td>${esc(a.equipement || '')}</td><td>${esc(a.message)}${a.test ? ' ' + badge('b-stale', 'test') : ''}</td>
        <td class="n">${fmt(a.valeur, a.valeur != null && Math.abs(a.valeur) < 5 ? 3 : 1)}</td><td class="n">${fmt(a.seuil, a.seuil != null && a.seuil < 5 ? 2 : 0)}</td>
        <td>${a.condition_active ? badge('b-critical', 'Active') : badge('b-good', 'Terminée')}</td><td>${eBadge(a.etat)}</td></tr>`).join('')}</tbody></table>`
      : `<div class="empty">Aucune alerte dans cette sélection.</div>`;
  };
  const rules = await api('/api/rules');
  const ed = can('config.seuils');
  $('#rulesTbl').innerHTML = `<table class="t"><thead><tr><th>Code</th><th>Règle</th><th>Type</th><th class="n">Seuil</th><th>Priorité</th><th class="n">Délai (s)</th><th>Active</th>${ed ? '<th></th>' : ''}</tr></thead><tbody>
    ${rules.map(r => `<tr data-code="${r.code}"><td class="mono">${r.code}</td><td>${esc(r.libelle)}</td><td class="mono small">${r.type}</td>
      <td class="n">${ed && r.seuil != null ? `<input type="number" step="any" value="${r.seuil}" style="width:90px" data-f="seuil">` : fmt(r.seuil, r.seuil != null && r.seuil < 5 ? 2 : 0)}</td>
      <td>${ed ? `<select data-f="priorite">${['critique', 'majeure', 'mineure'].map(p => `<option ${p === r.priorite ? 'selected' : ''}>${p}</option>`).join('')}</select>` : pBadge(r.priorite)}</td>
      <td class="n">${ed ? `<input type="number" min="0" value="${r.delai_s}" style="width:70px" data-f="delai_s">` : fmt(r.delai_s)}</td>
      <td>${ed ? `<label class="switch"><input type="checkbox" data-f="actif" ${r.actif ? 'checked' : ''}><span></span></label>` : (r.actif ? badge('b-good', 'Oui') : badge('b-stale', 'Non'))}</td>
      ${ed ? `<td><button class="btn sm" data-act="saveRule" data-code="${r.code}">Enregistrer</button></td>` : ''}</tr>`).join('')}</tbody></table>`;
  await load(); every(load, 5000);
};
ACT.alEtat = el => { S.cache.al.etat = el.dataset.v; route(); };
ACT.saveRule = async el => {
  const tr = el.closest('tr'); const b = {};
  $$('[data-f]', tr).forEach(i => { b[i.dataset.f] = i.type === 'checkbox' ? i.checked : i.value; });
  await act(() => api(`/api/rules/${el.dataset.code}`, { method: 'PUT', body: b }), `Règle ${el.dataset.code} enregistrée (journalisée)`);
};
ACT.openAlert = async el => {
  const d = await api(`/api/alerts/${el.dataset.id}`);
  const a = d.alerte, h = can('alert.handle') && a.etat !== 'cloturee';
  openModal(`Alerte #${a.id} — ${a.regle}`, `
    <div class="row" style="margin-bottom:12px">${pBadge(a.priorite)} ${eBadge(a.etat)} ${a.condition_active ? badge('b-critical', 'Condition active') : badge('b-good', 'Condition terminée ' + fhms(a.ts_fin_condition))}</div>
    <div class="grid g-2"><div>
      <table class="t"><tbody>
      <tr><td class="muted">Type</td><td class="mono">${a.type} (${a.rule_code})</td></tr>
      <tr><td class="muted">Équipement</td><td>${esc(a.equipement || '—')}</td></tr>
      <tr><td class="muted">Détection</td><td>${fdt(a.ts_detection)}</td></tr>
      <tr><td class="muted">Valeur mesurée</td><td class="num">${fmt(a.valeur, 3)}</td></tr>
      <tr><td class="muted">Seuil / règle</td><td>${fmt(a.seuil, 2)} — ${esc(a.regle)}</td></tr>
      <tr><td class="muted">Message</td><td>${esc(a.message)}</td></tr>
      <tr><td class="muted">Commentaire de clôture</td><td>${esc(a.commentaire || '—')}</td></tr></tbody></table></div>
    <div><h4 class="small muted" style="margin-bottom:8px">HISTORIQUE DES ACTIONS</h4><ul class="timeline">
      ${d.evenements.map(e => `<li><b>${esc(e.action.replace(/_/g, ' ').toLowerCase())}</b> — ${esc(e.username)}<br><span class="small muted">${fdt(e.ts)}</span>${e.commentaire ? `<div class="small">${esc(e.commentaire)}</div>` : ''}</li>`).join('')}</ul></div></div>
    ${h ? `<div class="mt"><label class="f">Commentaire / action corrective<textarea id="alCom" maxlength="500" placeholder="Ex. : délestage des engins non prioritaires, vérification du compteur…"></textarea></label></div>` : ''}`,
    h ? `${a.etat === 'nouvelle' ? `<button class="btn" data-act="alDo" data-id="${a.id}" data-a="prendre">Prendre en charge</button>` : ''}
        <button class="btn" data-act="alDo" data-id="${a.id}" data-a="commenter">Ajouter le commentaire</button>
        <button class="btn primary" data-act="alDo" data-id="${a.id}" data-a="cloturer" ${a.condition_active ? 'disabled title="Clôture impossible tant que la condition est active"' : ''}>Clôturer</button>` : '');
};
ACT.alDo = async el => {
  const r = await act(() => api(`/api/alerts/${el.dataset.id}/action`, { method: 'POST', body: { action: el.dataset.a, commentaire: $('#alCom')?.value || '' } }), 'Action enregistrée');
  if (r) { closeModal(); route(); }
};

/* ---------------------------------------------------------------- IPE */
VIEWS.ipe = async el => {
  const d = await api('/api/ipe');
  el.innerHTML = `${banner()}<div class="card"><div class="card-h"><h2>Indicateurs de performance énergétique</h2>
    <span class="sub">ISO 50001:2018 §6.4 — chaque IPE documente formule, sources, périmètre, agrégation, traitement des manquants, date d'effet et version.</span></div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>Code</th><th>Indicateur</th><th>Formule</th><th class="n">Réf. 2025</th><th class="n">Dernier mois</th><th class="n">Cible</th><th class="n">Écart</th><th>Statut</th><th>Validation</th></tr></thead><tbody>
    ${d.indicateurs.map(i => `<tr><td class="mono">${i.code}</td><td>${esc(i.libelle)}</td><td class="mono small">${esc(i.formule)}</td>
      <td class="n">${fmt(i.reference_2025, i.reference_2025 < 10 ? 3 : 1)}</td><td class="n">${fmt(i.dernier?.valeur, i.dernier?.valeur < 10 ? 3 : 1)} <span class="muted small">${esc(i.unite)}</span><div class="small muted">${fmois(i.dernier?.mois)}</div></td>
      <td class="n">${fmt(i.cible, i.cible < 10 ? 2 : 1)}</td><td class="n">${i.ecart_pct == null ? '—' : (i.ecart_pct > 0 ? '+' : '') + fmt(i.ecart_pct, 1) + ' %'}</td>
      <td>${i.statut ? badge(IPEST[i.statut], i.statut[0].toUpperCase() + i.statut.slice(1)) : '—'}</td><td>${badge('b-stale', i.statut_validation)}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="grid g-2 mt">${d.indicateurs.map(i => `<div class="card"><div class="card-h"><h2>${i.code} · ${esc(i.libelle)}</h2><span class="sp"></span>
      ${can('config.ipe') ? `<button class="btn sm" data-act="editIpe" data-code="${i.code}">Modifier la cible</button>` : ''}</div>
      ${legendHtml([{ label: `${i.unite} mensuel`, color: cssVar('--s1') }, { label: `Cible ${fmt(i.cible, i.cible < 10 ? 2 : 1)}`, color: cssVar('--critical'), kind: 'dash' }, { label: 'Moyenne 2025', color: cssVar('--muted'), kind: 'dash' }])}
      <div class="chart-box short"><canvas id="ci-${i.code}"></canvas></div>
      <table class="t small mt"><tbody>
        <tr><td class="muted">Sources / périmètre</td><td>${esc(i.perimetre)} · variable : ${esc(i.den)}</td><td class="muted">Agrégation</td><td>${esc(i.periode_agregation)}</td></tr>
        <tr><td class="muted">Données manquantes</td><td colspan="3">${esc(i.regle_manquantes)}</td></tr>
        <tr><td class="muted">Date d'effet</td><td>${esc(i.date_effet)}</td><td class="muted">Version</td><td>v${i.version}</td></tr></tbody></table></div>`).join('')}</div>
  <div class="card mt"><div class="card-h"><h2>Historique des modifications d'IPE</h2></div>
    ${d.historique.length ? `<table class="t"><thead><tr><th>Date</th><th>Utilisateur</th><th>IPE</th><th>Avant</th><th>Après</th></tr></thead><tbody>
    ${d.historique.map(h => `<tr><td class="mono">${fdt(h.ts)}</td><td>${esc(h.username)}</td><td class="mono">${esc(h.objet)}</td><td class="mono small">${esc(h.avant)}</td><td class="mono small">${esc(h.apres)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune modification depuis la création.</div>'}</div>`;
  S.cache.ipe = d.indicateurs;
  d.indicateurs.forEach(i => {
    const lab = i.serie.map(s => s.mois);
    const o = chartBase({ xTime: false });
    o.plugins.tooltip.callbacks = { title: it => fmois(lab[it[0].dataIndex]) + (i.serie[it[0].dataIndex].en_cours ? ' (en cours)' : ''),
      label: c => ` ${c.dataset.label} : ${fmt(c.parsed.y, c.parsed.y < 10 ? 3 : 1)}` };
    o.scales.x.ticks = { color: cssVar('--muted'), callback: (v, k) => lab[k].slice(5) === '01' || k === 0 ? lab[k].slice(0, 4) : lab[k].slice(5), maxRotation: 0, autoSkip: true };
    chart('ci-' + i.code, { type: 'line', data: { labels: lab, datasets: [
      { label: i.unite, data: i.serie.map(s => s.valeur), borderColor: cssVar('--s1'), pointRadius: i.serie.map(s => s.en_cours ? 3 : 0),
        segment: { borderDash: c => i.serie[c.p1DataIndex]?.en_cours ? [3, 3] : undefined } },
      { label: 'Cible', data: lab.map(() => i.cible), borderColor: cssVar('--critical'), borderDash: [5, 4], borderWidth: 1.5 },
      { label: 'Moyenne 2025', data: lab.map(() => i.reference_2025), borderColor: cssVar('--muted'), borderDash: [2, 3], borderWidth: 1.2 }] }, options: o });
  });
};
ACT.editIpe = el => {
  const i = S.cache.ipe.find(x => x.code === el.dataset.code);
  openModal(`Modifier ${i.code}`, `<div class="grid">
    <div class="small ink2">${esc(i.libelle)} — formule <span class="mono">${esc(i.formule)}</span> (${esc(i.unite)})</div>
    <label class="f">Nouvelle cible (${esc(i.unite)})<input type="number" step="any" id="ipeCible" value="${i.cible}"></label>
    <label class="f">Description<textarea id="ipeDesc">${esc(i.description)}</textarea></label>
    <label class="f">Motif de la modification (obligatoire — traçabilité ISO 50001)<textarea id="ipeMotif" placeholder="Ex. : objectif fixé en revue de direction du …"></textarea></label></div>`,
    `<button class="btn primary" data-act="saveIpe" data-code="${i.code}">Enregistrer (version ${i.version + 1})</button>`, true);
};
ACT.saveIpe = async el => {
  const r = await act(() => api(`/api/ipe/${el.dataset.code}`, { method: 'PUT', body: { cible: $('#ipeCible').value, description: $('#ipeDesc').value, motif: $('#ipeMotif').value } }), 'IPE mis à jour et historisé');
  if (r) { closeModal(); route(); }
};

/* ---------------------------------------------------------------- SER */
VIEWS.ser = async el => {
  const d = await api('/api/ser');
  const a = d.active;
  const eq = a ? `E/j = ${fmt(a.coefficients[0], 1)}` + a.variables.map((v, k) => ` ${a.coefficients[k + 1] >= 0 ? '+' : '−'} ${fmt(Math.abs(a.coefficients[k + 1]), 4)} × ${v}/j`).join('') : '';
  const post = d.serie.filter(s => !s.reference);
  el.innerHTML = `${banner()}<div class="grid g-12">
    <div class="card"><div class="card-h"><h2>SER active</h2>${a ? badge('b-info', 'v' + a.version) : ''}</div>
      ${a ? `<table class="t small"><tbody>
        <tr><td class="muted">Période de référence</td><td>${fmois(a.periode_debut)} → ${fmois(a.periode_fin)} (${a.n} mois)</td></tr>
        <tr><td class="muted">Variables pertinentes</td><td>${a.variables.map(v => esc(a.libelles[v])).join(', ')}</td></tr>
        <tr><td class="muted">Qualité du modèle</td><td>R² = <b>${fmt(a.r2, 3)}</b> · CV(RMSE) = <b>${fmt(a.cv_rmse, 2)} %</b> ${a.r2 >= 0.75 ? badge('b-good', 'Valide') : badge('b-critical', 'Insuffisant')}</td></tr>
        <tr><td class="muted">Créée par</td><td>${esc(a.cree_par)} · ${fdt(a.cree_le)}</td></tr>
        <tr><td class="muted">Motif</td><td>${esc(a.motif)}</td></tr>
        <tr><td class="muted">Hypothèses</td><td>${esc(a.hypotheses)}</td></tr></tbody></table>
        <div class="formula mt">${esc(eq)}</div>
        <div class="small muted mt">Modèle normalisé par jour (régression linéaire multiple) : neutralise la durée du mois et permet de comparer un mois en cours.</div>` : '<div class="empty">Aucune SER</div>'}
      <div class="mt row">${can('config.ser') ? '<button class="btn primary" data-act="newSer">Nouvelle version de la SER</button>' : ''}</div></div>
    <div class="card"><div class="card-h"><h2>Consommation observée vs référence ajustée</h2><span class="sub">kWh / mois, postes P1–P6</span></div>
      ${legendHtml([{ label: 'Observée', color: cssVar('--s1') }, { label: 'Référence ajustée (SER)', color: cssVar('--s2'), kind: 'ln' }])}
      <div class="chart-box"><canvas id="cSer"></canvas></div>
      <div class="row small ink2 mt">Économie cumulée depuis la fin de la référence : <b class="num">${fmt(d.economie_cumulee_kwh)} kWh</b>
        ${d.economie_cumulee_kwh > 0 ? badge('b-good', 'Amélioration de la performance') : badge('b-warning', 'Dégradation')}</div></div>
  </div>
  <div class="grid g-2 mt">
    <div class="card"><div class="card-h"><h2>CUSUM des écarts</h2><span class="sub">Σ (observé − référence) — une pente descendante = économies</span></div>
      <div class="chart-box short"><canvas id="cCusum"></canvas></div></div>
    <div class="card"><div class="card-h"><h2>Écarts mensuels</h2></div><div class="tbl-wrap scroll-y" style="max-height:260px">
      <table class="t"><thead><tr><th>Mois</th><th class="n">Observé</th><th class="n">Référence</th><th class="n">Écart</th><th class="n">CUSUM</th></tr></thead><tbody>
      ${d.serie.slice().reverse().map(s => `<tr><td>${fmois(s.mois)} ${s.reference ? badge('b-stale', 'réf.') : ''}${s.en_cours ? badge('b-info', 'en cours') : ''}</td>
        <td class="n">${fmt(s.observe)}</td><td class="n">${fmt(s.predit)}</td><td class="n">${s.ecart_pct > 0 ? '+' : ''}${fmt(s.ecart_pct, 1)} %</td><td class="n">${fmt(s.cusum)}</td></tr>`).join('')}</tbody></table></div></div>
  </div>
  <div class="card mt"><div class="card-h"><h2>Versions de la SER</h2><span class="sub">Conservées avec leurs motifs (§2.5)</span></div>
    <table class="t"><thead><tr><th>Version</th><th>Période</th><th>Variables</th><th class="n">R²</th><th class="n">CV(RMSE)</th><th>Motif</th><th>Auteur</th><th>État</th><th></th></tr></thead><tbody>
    ${d.versions.map(v => `<tr><td>v${v.version}</td><td>${v.periode_debut} → ${v.periode_fin}</td><td class="small">${v.variables.join(', ')}</td><td class="n">${fmt(v.r2, 3)}</td><td class="n">${fmt(v.cv_rmse, 2)} %</td>
      <td class="small">${esc(v.motif)}</td><td class="small">${esc(v.cree_par)}<br>${fdt(v.cree_le)}</td><td>${v.active ? badge('b-good', 'Active') : badge('b-stale', 'Archivée')}</td>
      <td>${!v.active && can('config.ser') ? `<button class="btn sm" data-act="actSer" data-id="${v.id}">Activer</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  S.cache.ser = d;
  const lab = d.serie.map(s => s.mois);
  const o = chartBase({ xTime: false, yTitle: 'kWh' });
  o.plugins.tooltip.callbacks = { title: it => fmois(lab[it[0].dataIndex]), label: c => ` ${c.dataset.label} : ${fmt(c.parsed.y)} kWh` };
  o.scales.x.ticks = { color: cssVar('--muted'), callback: (v, k) => lab[k].slice(2).replace('-', '/'), maxRotation: 0 };
  chart('cSer', { type: 'bar', data: { labels: lab, datasets: [
    { type: 'line', label: 'Référence ajustée', data: d.serie.map(s => s.predit), borderColor: cssVar('--s2'), pointRadius: 0, order: 0 },
    { label: 'Observée', data: d.serie.map(s => s.observe), backgroundColor: d.serie.map(s => s.reference ? cssVar('--s1') + '88' : cssVar('--s1')), borderRadius: 4, borderSkipped: 'start', order: 1 }] }, options: o });
  const pl = post.map(s => s.mois);
  const oc = chartBase({ xTime: false, yTitle: 'kWh' });
  oc.plugins.tooltip.callbacks = { title: it => fmois(pl[it[0].dataIndex]), label: c => ` CUSUM : ${fmt(c.parsed.y)} kWh` };
  oc.scales.x.ticks = { color: cssVar('--muted'), callback: (v, k) => pl[k].slice(2).replace('-', '/') };
  chart('cCusum', { type: 'line', data: { labels: pl, datasets: [{ label: 'CUSUM', data: post.map(s => s.cusum), borderColor: cssVar('--s3'), pointRadius: 3,
    fill: { target: 'origin' }, backgroundColor: cssVar('--s3') + '22' }] }, options: oc });
};
ACT.newSer = () => {
  const vars = S.cache.ser.variables_disponibles;
  openModal('Nouvelle version de la SER', `<div class="grid">
    <div class="row"><label class="f">Début de la période<input type="month" id="serD" value="2025-01"></label><label class="f">Fin<input type="month" id="serF" value="2025-12"></label></div>
    <div class="f small">Variables pertinentes<div class="row mt">${Object.entries(vars).map(([k, l]) => `<label class="row small"><input type="checkbox" value="${k}" class="serV" ${['evp', 'tonnes_vrac', 'reefer_jours'].includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div></div>
    <label class="f">Motif de révision (obligatoire)<textarea id="serM" placeholder="Ex. : modification majeure des installations, changement de périmètre…"></textarea></label>
    <label class="f">Hypothèses et règles de calcul<textarea id="serH"></textarea></label>
    <div class="small muted">La nouvelle version devient active ; les versions précédentes restent consultables et réactivables.</div></div>`,
    `<button class="btn primary" data-act="saveSer">Calculer et activer</button>`, true);
};
ACT.saveSer = async () => {
  const r = await act(() => api('/api/ser', { method: 'POST', body: { debut: $('#serD').value, fin: $('#serF').value, variables: $$('.serV').filter(i => i.checked).map(i => i.value), motif: $('#serM').value, hypotheses: $('#serH').value } }), 'Nouvelle SER calculée et activée');
  if (r) { closeModal(); route(); }
};
ACT.actSer = async el => { if (await act(() => api(`/api/ser/${el.dataset.id}/activer`, { method: 'POST', body: { motif: 'réactivation' } }), 'Version activée')) route(); };

/* ---------------------------------------------------------------- Rapports */
VIEWS.rapports = async el => {
  const d = await api('/api/reports');
  el.innerHTML = `<div class="grid g-12"><div class="card"><div class="card-h"><h2>Revue énergétique mensuelle</h2></div>
    <p class="small ink2">Rapport A4 imprimable (ou « Enregistrer en PDF » depuis le navigateur) : périmètre, période, unités, consommations par poste, comparaison N-1, IPE, SER, alertes, complétude et qualité des données, traçabilité des méthodes et visas.</p>
    <label class="f">Mois<select id="repM">${d.mois.map((m, k) => `<option value="${m}" ${k === 1 ? 'selected' : ''}>${fmois(m)}${k === 0 ? ' (en cours)' : ''}</option>`).join('')}</select></label>
    <div class="row mt"><button class="btn primary" data-act="openRep">Ouvrir le rapport</button>
    <button class="btn" data-act="csvMonth">Exporter les mesures du mois (CSV)</button></div></div>
    <div class="card"><div class="card-h"><h2>Historique des rapports générés</h2><span class="sub">table report_jobs</span></div>
    ${d.jobs.length ? `<table class="t"><thead><tr><th>Date</th><th>Utilisateur</th><th>Type</th><th>Période</th><th>Statut</th></tr></thead><tbody>
    ${d.jobs.map(j => `<tr><td class="mono">${fdt(j.ts)}</td><td>${esc(j.username)}</td><td>${esc(j.type)}</td><td>${fmois(j.periode)}</td><td>${badge('b-good', j.statut)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aucun rapport généré pour l\'instant.</div>'}</div></div>`;
};
ACT.openRep = async () => { const m = $('#repM').value; await act(() => api('/api/reports/job', { method: 'POST', body: { mois: m } })); window.open(`rapport.html?mois=${m}`, '_blank'); };
ACT.csvMonth = () => { const m = $('#repM').value; const [y, mm] = m.split('-').map(Number); const t1 = Date.UTC(y, mm - 1, 1) / 1000, t2 = Date.UTC(mm === 12 ? y + 1 : y, mm % 12, 1) / 1000; SME.exportCsv([1, 2, 3, 4, 5, 6, 7], t1, t2); toast('Export CSV téléchargé', 'ok'); };

/* ---------------------------------------------------------------- Patrimoine */
VIEWS.patrimoine = async el => {
  const d = await api('/api/patrimoine');
  S.cache.pat = d;
  const ed = can('config.compteurs');
  const prof = S.cache.prof || 'PM800-DEMO';
  el.innerHTML = `<div class="grid g-12">
    <div class="card"><div class="card-h"><h2>Arborescence</h2><span class="sub">Relations parent-enfant administrables</span></div>
      <ul class="tree tree-root"><li><b>${esc(d.sites[0].libelle)}</b> <span class="muted small">${esc(d.sites[0].emplacement)}</span>
        <ul class="tree"><li>⚡ <b>Arrivée ONEE 22 kV</b> — ${esc(d.equipment[6].code)} ${badge('b-info', 'existant')} <span class="small muted">point de contrôle, exclu des agrégations</span>
          <ul class="tree">${d.posts.map(p => { const e = d.equipment.find(x => x.post_id === p.id); const pt = d.points.find(x => x.post_id === p.id);
            return `<li><span class="code" style="background:${color(p.id)};color:#fff;padding:1px 6px;border-radius:5px;font-size:11px;font-weight:700">${p.code}</span> <b>${esc(p.libelle)}</b> <span class="small muted">${esc(p.emplacement)} · ${fmt(p.transfo_kva)} kVA</span>
              <ul class="tree"><li>📟 ${esc(e.code)} <span class="small muted">${esc(e.ip)} · Unit ${e.unit_id}</span><ul class="tree"><li>◎ ${esc(pt.code)} — ${esc(pt.libelle)}</li></ul></li>
              ${p.departs.map(x => `<li class="small ink2">↳ ${esc(x)}</li>`).join('')}</ul></li>`; }).join('')}</ul></li></ul></li></ul></div>
    <div class="grid" style="align-content:start">
      <div class="card"><div class="card-h"><h2>Compteurs</h2><span class="sub">Caractéristiques et paramètres de communication</span></div><div class="tbl-wrap">
        <table class="t"><thead><tr><th>Code</th><th>Libellé</th><th>Fabricant / modèle</th><th>Protocole</th><th>IP terrain</th><th class="n">Port</th><th class="n">Unit</th><th>Profil</th><th>État</th><th></th></tr></thead><tbody>
        ${d.equipment.map(e => { const st = d.stats[e.id] || {}; return `<tr><td class="mono">${e.code}</td><td>${esc(e.libelle)} ${e.existant ? badge('b-info', 'existant') : ''}</td>
          <td class="small">${esc(e.fabricant)}<br><span class="muted">${esc(e.modele)}</span></td><td class="small">${esc(e.protocole)}</td><td class="mono">${esc(e.ip)}</td><td class="n">${e.port}</td><td class="n">${e.unit_id}</td>
          <td class="mono small">${esc(e.profil)}</td><td>${st.etat === 'en ligne' ? badge('b-good', 'En ligne') : badge('b-critical', st.etat || '—')}</td>
          <td><div class="row" style="gap:4px;flex-wrap:nowrap">${ed ? `<button class="btn sm" data-act="testEq" data-id="${e.id}">Tester</button><button class="btn sm ghost" data-act="editEq" data-id="${e.id}">Modifier</button>` : ''}</div></td></tr>`; }).join('')}
        </tbody></table></div>${ed ? '' : '<div class="small muted mt">Test de communication et modification réservés au rôle Administrateur technique.</div>'}</div>
      <div class="card"><div class="card-h"><h2>Mise en service d'un compteur</h2><span class="sub">Parcours §6.1</span></div>
        <ol class="steps"><li>Créer ou sélectionner le poste électrique (arborescence)</li><li>Enregistrer le compteur et ses paramètres réseau (« Modifier »)</li>
        <li>Charger ou configurer la cartographie de registres validée (ci-dessous)</li><li>Tester la communication Modbus TCP/IP (« Tester »)</li>
        <li>Vérifier valeurs, unités, échelles et horodatages (résultat du test)</li><li>Associer le compteur à son point de comptage</li>
        <li>Valider la remontée dans le tableau de bord</li><li>Documenter le résultat — journal d'audit + recette T01/T02</li></ol></div>
    </div></div>
  <div class="card mt"><div class="card-h"><h2>Cartographie des registres (measurement_definitions)</h2><span class="sp"></span>
    <div class="seg">${Object.keys(d.definitions).map(p => `<button data-act="prof" data-v="${p}" class="${p === prof ? 'on' : ''}">${p}</button>`).join('')}</div></div>
    <div class="small muted" style="margin-bottom:8px">Adresses indicatives du profil simulé — la matrice définitive provient de la documentation du fabricant (§2.2). Toute modification est journalisée et prise en compte à la volée par le service d'acquisition.</div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>Grandeur</th><th>Description</th><th class="n">Adresse</th><th>Type</th><th class="n">Échelle</th><th>Unité</th><th class="n">Min valide</th><th class="n">Max valide</th>${ed ? '<th></th>' : ''}</tr></thead><tbody>
    ${d.definitions[prof].map(x => `<tr data-id="${x.id}"><td class="mono"><b>${x.grandeur}</b></td><td>${esc(x.description)}</td>
      ${ed ? `<td class="n"><input type="number" data-f="adresse" value="${x.adresse}" style="width:80px"></td><td><select data-f="type"><option ${x.type === 'float32' ? 'selected' : ''}>float32</option><option ${x.type === 'uint32' ? 'selected' : ''}>uint32</option></select></td>
        <td class="n"><input type="number" step="any" data-f="echelle" value="${x.echelle}" style="width:70px"></td><td><input type="text" data-f="unite" value="${esc(x.unite)}" style="width:60px"></td>
        <td class="n"><input type="number" step="any" data-f="min_valide" value="${x.min_valide}" style="width:90px"></td><td class="n"><input type="number" step="any" data-f="max_valide" value="${x.max_valide}" style="width:100px"></td>
        <td><button class="btn sm" data-act="saveDef" data-id="${x.id}">Enregistrer</button></td>`
      : `<td class="n mono">${x.adresse}</td><td class="mono">${x.type}</td><td class="n">${x.echelle}</td><td>${esc(x.unite)}</td><td class="n">${fmt(x.min_valide, 2)}</td><td class="n">${fmt(x.max_valide, 0)}</td>`}</tr>`).join('')}</tbody></table></div></div>`;
};
ACT.prof = el => { S.cache.prof = el.dataset.v; route(); };
ACT.saveDef = async el => {
  const tr = el.closest('tr'); const b = {}; $$('[data-f]', tr).forEach(i => b[i.dataset.f] = i.value);
  await act(() => api(`/api/definitions/${el.dataset.id}`, { method: 'PUT', body: b }), 'Registre enregistré (journalisé)');
};
ACT.testEq = async el => {
  const e = S.cache.pat.equipment.find(x => x.id === +el.dataset.id);
  openModal(`Test de communication — ${e.code}`, '<div class="empty">Interrogation Modbus TCP en cours…</div>');
  const r = await act(() => api(`/api/equipment/${e.id}/test`, { method: 'POST', body: {} }));
  if (!r) return closeModal();
  $('.modal-b').innerHTML = r.ok ? `<div class="row" style="margin-bottom:10px">${badge('b-good', 'Réponse reçue')} <span class="mono small">${esc(r.trame)}</span> <span class="small muted">latence ${fmt(r.latence_ms, 1)} ms</span></div>
    <div class="tbl-wrap"><table class="t"><thead><tr><th>Grandeur</th><th class="n">Adresse</th><th>Type</th><th>Mots bruts</th><th class="n">Échelle</th><th class="n">Valeur</th><th>Unité</th><th>Contrôle</th></tr></thead><tbody>
    ${r.registres.map(x => `<tr><td class="mono"><b>${x.grandeur}</b></td><td class="n mono">${x.adresse}</td><td class="mono">${x.type}</td><td class="mono small">${x.brut.map(w => '0x' + w.toString(16).padStart(4, '0').toUpperCase()).join(' ')}</td>
      <td class="n">${x.echelle}</td><td class="n">${x.valeur == null ? '—' : fmt(x.valeur, x.grandeur === 'PF' ? 3 : 2)}</td><td>${esc(x.unite)}</td><td>${qBadge(x.qualite)}</td></tr>`).join('')}</tbody></table></div>
    <div class="small muted mt">Résultat journalisé (TEST_COMMUNICATION). Vérifier signes, unités et échelles avant validation de la mise en service.</div>`
    : `${badge('b-critical', 'Échec')} <span class="small">${esc(r.erreur)}</span>`;
};
ACT.editEq = el => {
  const e = S.cache.pat.equipment.find(x => x.id === +el.dataset.id);
  openModal(`Modifier ${e.code}`, `<div class="grid g-2">
    ${[['libelle', 'Libellé'], ['fabricant', 'Fabricant'], ['modele', 'Modèle'], ['ip', 'Adresse IP terrain'], ['port', 'Port TCP'], ['unit_id', 'Unit ID (1-247)']]
      .map(([k, l]) => `<label class="f">${l}<input type="${['port', 'unit_id'].includes(k) ? 'number' : 'text'}" id="eq_${k}" value="${esc(e[k])}"></label>`).join('')}
    <label class="f">Actif<span><label class="switch"><input type="checkbox" id="eq_actif" ${e.actif ? 'checked' : ''}><span></span></label></span></label></div>
    <div class="small muted mt">Dans ce démonstrateur, les compteurs simulés répondent dans le navigateur ; l'IP terrain est documentaire (plan d'adressage à valider). Changer l'Unit ID d'un compteur provoque une perte de communication visible — utile pour tester la détection.</div>`,
    `<button class="btn primary" data-act="saveEq" data-id="${e.id}">Enregistrer</button>`, true);
};
ACT.saveEq = async el => {
  const b = {}; ['libelle', 'fabricant', 'modele', 'ip', 'port', 'unit_id'].forEach(k => b[k] = $('#eq_' + k).value); b.actif = $('#eq_actif').checked ? 1 : 0;
  b.port = +b.port; b.unit_id = +b.unit_id;
  if (await act(() => api(`/api/equipment/${el.dataset.id}`, { method: 'PUT', body: b }), 'Compteur mis à jour (journalisé)')) { closeModal(); route(); }
};

/* ---------------------------------------------------------------- Acquisition */
VIEWS.acquisition = async el => {
  const cfg = S.meta.acquisition;
  const ed = can('config.acquisition');
  el.innerHTML = `<div class="grid g-tiles" id="acqTiles"></div>
  <div class="card mt"><div class="card-h"><h2>État des compteurs</h2><span class="sub" id="acqSub"></span></div><div class="tbl-wrap" id="acqTbl"></div></div>
  <div class="grid g-2 mt">
    <div class="card"><div class="card-h"><h2>Paramètres d'acquisition</h2><span class="sub">system_config · ${ed ? 'modifiables' : 'lecture seule'}</span></div>
      <div class="grid g-2">${[['periode_s', 'Période d\'interrogation (s)'], ['timeout_s', 'Délai de réponse max (s)'], ['reconnexion_s', 'Délai de reconnexion (s)'], ['retention_brut_h', 'Rétention mesures brutes (h)'],
        ['fraicheur_s', 'Seuil « fraîche » (s)'], ['peremption_s', 'Seuil « périmée » (s)'], ['derive_horloge_max_s', 'Dérive d\'horloge tolérée (s)']]
        .map(([k, l]) => `<label class="f">${l}<input type="number" step="any" id="ac_${k}" value="${cfg[k]}" ${ed ? '' : 'disabled'}></label>`).join('')}</div>
      ${ed ? '<div class="mt"><button class="btn primary" data-act="saveAcq">Appliquer</button></div>' : ''}
      <div class="small muted mt">Reprise : après 3 échecs consécutifs, le compteur passe en « reconnexion » et n'est réinterrogé qu'après le délai de reconnexion. Les clés uniques (point, horodatage) empêchent les doublons à la reprise.</div></div>
    <div class="card"><div class="card-h"><h2>Événements de qualité récents</h2><span class="sub">Mesures non valides (brutes)</span></div><div class="tbl-wrap scroll-y" style="max-height:300px" id="acqEv"></div></div>
  </div>
  <div class="card mt"><div class="card-h"><h2>Dernières mesures brutes reçues</h2><span class="sub">measurements_raw — valeurs décodées + qualité par grandeur</span></div><div class="tbl-wrap" id="acqRaw"></div></div>
  <div class="card mt"><div class="card-h"><h2>Sécurité de la couche communication</h2></div><div class="small ink2">Modbus TCP/IP n'offre ni authentification ni chiffrement (§3.2). Architecture cible proposée :
    réseau de mesure dédié (VLAN compteurs) isolé du réseau bureautique, pare-feu n'autorisant que le serveur d'acquisition vers le port 502 des compteurs, aucun accès Modbus depuis Internet,
    accès web en HTTPS (le tunnel de démonstration chiffre déjà le trafic web), synchronisation NTP du serveur et des compteurs (la dérive est mesurée en continu ci-dessus).
    Pour les grues mobiles, une liaison sans fil industrielle chiffrée (Wi-Fi industriel WPA2-Enterprise ou 4G privée) est à étudier.</div></div>`;
  const load = async () => {
    const d = await api('/api/modbus');
    const pts = S.meta.points;
    const tot = Object.values(d.stats).reduce((a, s) => ({ polls: a.polls + s.polls, ok: a.ok + s.ok, lost: a.lost + s.perdues }), { polls: 0, ok: 0, lost: 0 });
    $('#acqTiles').innerHTML = [['Passerelle Modbus', `<span class="mono" style="font-size:18px">${esc(d.passerelle)}</span>`, 'Trames MBAP vers 7 esclaves simulés'],
      ['Période mesurée', `${fmt(S.live?.acquisition.periode_mesuree_s, 2)}<small>s</small>`, `Cible ${fmt(d.config.periode_s, 1)} s`],
      ['Durée d\'un cycle', `${fmt(d.cycle_ms, 1)}<small>ms</small>`, '7 compteurs interrogés'],
      ['Requêtes', fmt(tot.polls), `${fmt(tot.ok)} réussies`], ['Disponibilité', `${fmt(tot.polls ? tot.ok / tot.polls * 100 : 0, 2)}<small>%</small>`, `${tot.lost} lectures perdues`],
      ['Cohérence tête/postes', S.live?.acquisition.coherence ? `${fmt(S.live.acquisition.coherence.ecart_pct, 2)}<small>%</small>` : '—', 'Pertes transfo. attendues ≈ 1,2 %']]
      .map(([l, v, f]) => `<div class="card tile"><div class="lbl">${l}</div><div class="val num">${v}</div><div class="foot">${f}</div></div>`).join('');
    $('#acqSub').textContent = `Actualisé ${fhms(Date.now() / 1000)}`;
    $('#acqTbl').innerHTML = `<table class="t"><thead><tr><th>Compteur</th><th class="n">Unit</th><th>IP terrain</th><th>État</th><th>Dernière communication</th><th class="n">Latence</th><th class="n">Requêtes</th><th class="n">Valides</th><th class="n">Suspectes</th><th class="n">Invalides</th><th class="n">Perdues</th><th class="n">Dispo.</th></tr></thead><tbody>
      ${pts.map(p => { const s = d.stats[p.id] || {}; return `<tr><td><span class="code" style="background:${color(p.id)};color:#fff;padding:1px 6px;border-radius:5px;font-size:11px;font-weight:700">${p.code.replace('PC-', '')}</span> ${esc(p.equipement)}</td>
        <td class="n">${p.unit_id}</td><td class="mono">${esc(p.ip)}</td><td>${s.etat === 'en ligne' ? badge('b-good', 'En ligne') : s.etat === 'reconnexion' ? badge('b-serious', 'Reconnexion') : badge('b-critical', s.etat || '—')}</td>
        <td class="mono">${fhms(s.last_ok)} <span class="muted small">(${fage(s.last_ok ? Date.now() / 1000 - s.last_ok : null)})</span></td><td class="n">${fmt(s.lat_ms, 1)} ms</td><td class="n">${fmt(s.polls)}</td><td class="n">${fmt(s.ok - s.suspectes - s.invalides)}</td>
        <td class="n">${fmt(s.suspectes)}</td><td class="n">${fmt(s.invalides)}</td><td class="n">${fmt(s.perdues)}</td><td class="n">${s.polls ? pct(s.ok / s.polls * 100, 1) : '—'}</td></tr>`; }).join('')}</tbody></table>`;
    $('#acqEv').innerHTML = d.evenements.length ? `<table class="t"><thead><tr><th>Réception</th><th>Point</th><th>Qualité</th><th>Motif</th></tr></thead><tbody>
      ${d.evenements.map(e => `<tr><td class="mono">${fhms(e.ts_reception)}</td><td>${esc(pts.find(p => p.id === e.point_id)?.code)}</td><td>${qBadge(e.qualite)}</td><td class="small">${esc(e.motif)}</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">Aucune mesure non valide sur la période de rétention.</div>';
    $('#acqRaw').innerHTML = `<table class="t"><thead><tr><th>Point</th><th>Horodatage mesure</th><th>Horodatage réception</th><th class="n">Écart</th><th>Valeurs (grandeur = valeur)</th><th>Qualité</th></tr></thead><tbody>
      ${d.brut.map(r => { const v = JSON.parse(r.valeurs); return `<tr><td>${esc(pts.find(p => p.id === r.point_id)?.code)}</td><td class="mono">${fhms(r.ts_mesure)}</td><td class="mono">${_hms.format(new Date(r.ts_reception * 1000))}.${String(Math.floor(r.ts_reception % 1 * 1000)).padStart(3, '0')}</td>
        <td class="n">${fmt(r.ts_reception - r.ts_mesure, 2)} s</td><td class="mono small">${Object.entries(v).map(([g, [x, q]]) => `${g}=${x == null ? '∅' : fmt(x, g === 'PF' ? 3 : 1)}${q !== 'valide' ? '⚠' : ''}`).join('  ')}</td><td>${qBadge(r.qualite)}</td></tr>`; }).join('')}</tbody></table>`;
  };
  await load(); every(load, 4000);
};
ACT.saveAcq = async () => {
  const b = {}; $$('[id^=ac_]').forEach(i => b[i.id.slice(3)] = i.value);
  if (await act(() => api('/api/config/acquisition', { method: 'PUT', body: b }), 'Paramètres appliqués (journalisés)')) { S.meta = await api('/api/meta'); route(); }
};

/* ---------------------------------------------------------------- Simulation */
VIEWS.simulation = async el => {
  const ed = can('simulation.incident');
  const opt = S.meta.points.map(p => `<option value="${p.id}">${esc(p.code)} — ${esc(S.meta.posts.find(x => x.id === p.post_id)?.libelle || 'Compteur de tête')}</option>`).join('');
  el.innerHTML = `<div class="demo-banner">${badge('b-warning', 'Démonstration')} Cet écran remplace le terrain : il pilote les compteurs simulés. Il n'existerait pas en exploitation réelle.</div>
  <div class="grid g-2">
    <div class="card"><div class="card-h"><h2>Activité portuaire</h2><span class="sub">Influence directe sur les puissances appelées</span></div>
      <div class="grid" id="simCtl"></div></div>
    <div class="card"><div class="card-h"><h2>Cycles des grues mobiles (temps réel)</h2><span class="sub">Levage 380 kW · rotation 140 kW · descente 45 kW · attente 25 kW</span></div><div id="simCr"></div></div>
  </div>
  <div class="card mt"><div class="card-h"><h2>Injection d'incidents</h2><span class="sub">Pour vérifier la détection, l'affichage et le traitement (recette T04, T10)</span></div>
    ${ed ? `<div class="filters"><label class="f">Point de comptage<select id="incP">${opt}</select></label>
      <label class="f">Incident<select id="incT">${Object.entries(S.meta.incidents).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <button class="btn primary" data-act="incGo">Déclencher</button><button class="btn" data-act="incClear">Mettre fin à tous les incidents</button></div>` : `<div class="small muted">Réservé aux rôles Opérateur et supérieurs.</div>`}
    <div id="incList"></div>
    <div class="small muted mt">Effets attendus — coupure : R01 après ${fmt(6)} s puis reprise automatique · surcharge : R04 · chute de tension : R06 · cos φ dégradé : R05 (après 10 s) · harmoniques : R08 · valeur hors plage : R02 (mesure « invalide ») · dérive d'horloge : mesure « suspecte ».</div></div>`;
  let skip = 0;
  const render = live => {
    const s = live.simulation, c = s.ctx;
    if (Date.now() > skip) $('#simCtl').innerHTML = `
      <div class="row">${ed ? `<label class="switch"><input type="checkbox" data-chg="simB" data-k="navire_conteneurs" ${c.navire_conteneurs ? 'checked' : ''}><span></span></label>` : ''} <span>Porte-conteneurs à quai (Quai Nord, P1 + grues)</span></div>
      <div class="row">${ed ? `<label class="switch"><input type="checkbox" data-chg="simB" data-k="navire_vrac" ${c.navire_vrac ? 'checked' : ''}><span></span></label>` : ''} <span>Vraquier à quai (convoyeurs et silos, P3)</span></div>
      <label class="f">Grues mobiles en service : <b>${c.grues_actives}</b><input type="range" min="0" max="4" value="${c.grues_actives}" data-chg="simN" data-k="grues_actives" ${ed ? '' : 'disabled'}></label>
      <label class="f">Conteneurs frigorifiques branchés : <b>${c.reefers}</b><input type="range" min="0" max="260" step="10" value="${c.reefers}" data-chg="simN" data-k="reefers" ${ed ? '' : 'disabled'}></label>`;
    $('#simCr').innerHTML = s.grues.map(g => `<div class="crane"><b>${g.grue}</b>
      <div><div class="small ink2">${esc(g.phase)}</div><div class="loadbar"><i style="width:${Math.round((g.progress || 0) * 100)}%;background:var(--s4)"></i></div></div>
      <span class="num" style="text-align:right">${fmt(g.kw)} kW</span></div>`).join('') + `<div class="small muted mt">Puissance P4 actuelle : <b class="num">${fmt(live.points.find(p => p.point_id === 4)?.valeurs?.P?.v)} kW</b></div>`;
    const inc = Object.entries(s.incidents);
    $('#incList').innerHTML = inc.length ? `<table class="t"><thead><tr><th>Point</th><th>Incident en cours</th><th></th></tr></thead><tbody>${inc.map(([p, t]) => `<tr><td>${esc(S.meta.points.find(x => x.id === +p).code)}</td><td>${badge('b-serious', S.meta.incidents[t])}</td>
      <td>${ed ? `<button class="btn sm" data-act="incEnd" data-id="${p}">Terminer</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="small muted">Aucun incident simulé en cours.</div>';
  };
  S.onLive = render;
  S._simSkip = ms => { skip = Date.now() + ms; };
  if (S.live) render(S.live);
};
CHG.simB = async el => { S._simSkip?.(3000); await act(() => api('/api/simulation', { method: 'PUT', body: { [el.dataset.k]: el.checked } }), 'Activité mise à jour'); };
CHG.simN = async el => { S._simSkip?.(3000); await act(() => api('/api/simulation', { method: 'PUT', body: { [el.dataset.k]: +el.value } }), 'Activité mise à jour'); };
ACT.incGo = () => act(() => api('/api/simulation/incident', { method: 'POST', body: { point_id: +$('#incP').value, type: $('#incT').value } }), 'Incident déclenché — observez le tableau de bord et les alertes');
ACT.incEnd = el => act(() => api('/api/simulation/incident', { method: 'POST', body: { point_id: +el.dataset.id, type: null } }), 'Incident terminé');
ACT.incClear = () => act(() => api('/api/simulation/clear', { method: 'POST', body: {} }), 'Tous les incidents sont terminés');

/* ---------------------------------------------------------------- Recette */
VIEWS.recette = async el => {
  const render = d => {
    const res = d.etat.en_cours ? d.etat.resultats : (d.dernier?.resultats || []);
    const by = Object.fromEntries(res.map(r => [r.id, r]));
    const conf = res.filter(r => r.statut === 'conforme').length;
    el.innerHTML = `<div class="card"><div class="card-h"><h2>Plan de tests — spécification §8</h2><span class="sp"></span>
      ${can('recette.run') ? `<button class="btn primary no-print" data-act="runRec" ${d.etat.en_cours ? 'disabled' : ''}>${d.etat.en_cours ? 'Recette en cours…' : 'Lancer la recette automatique'}</button>` : ''}
      <button class="btn no-print" data-act="print">Imprimer le PV</button></div>
      ${d.etat.en_cours ? `<div class="progress"><i style="width:${d.etat.progression}%"></i></div><div class="small muted mt">${esc(d.etat.etape)} — durée totale ≈ 40 s (T04/T05 provoquent une vraie coupure Modbus sur P2)</div>`
        : d.dernier ? `<div class="row small">Dernière exécution : <b>${fdt(d.dernier.ts)}</b> par ${esc(d.dernier.username)} — ${badge(conf === 14 ? 'b-good' : 'b-warning', `${conf}/14 essais automatiques conformes`)} ${badge('b-stale', 'T15 manuel')}</div>`
          : '<div class="small muted">Aucune exécution. Lancez la recette pour produire le procès-verbal.</div>'}
      <div class="tbl-wrap mt"><table class="t"><thead><tr><th>ID</th><th>Essai</th><th>Résultat attendu</th><th>Statut</th><th>Mesure obtenue</th><th>Preuve / méthode</th></tr></thead><tbody>
      ${d.plan.map(t => { const r = by[t.id]; return `<tr><td class="mono"><b>${t.id}</b></td><td>${esc(t.test)}</td><td class="small">${esc(t.attendu)}</td>
        <td>${r ? badge(r.statut === 'conforme' ? 'b-good' : r.statut === 'manuel' ? 'b-stale' : 'b-critical', r.statut[0].toUpperCase() + r.statut.slice(1)) : badge('b-stale', d.etat.en_cours ? 'En attente' : 'Non exécuté')}</td>
        <td class="small">${esc(r?.mesure || '')}</td><td class="small muted">${esc(r?.preuve || '')}</td></tr>`; }).join('')}</tbody></table></div></div>
    <div class="card mt no-print"><div class="card-h"><h2>Historique des exécutions</h2><span class="sub">table test_runs</span></div>
      ${d.historique.length ? `<table class="t"><thead><tr><th>Date</th><th>Exécutée par</th><th class="n">Conformes</th></tr></thead><tbody>${d.historique.map(h => `<tr><td class="mono">${fdt(h.ts)}</td><td>${esc(h.username)}</td><td class="n">${h.conformes}/${h.total}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">—</div>'}</div>`;
  };
  const load = async () => { const d = await api('/api/recette'); render(d); return d; };
  await load(); every(load, 1500);
};
ACT.runRec = () => act(() => api('/api/recette/run', { method: 'POST', body: {} }), 'Recette démarrée');
ACT.print = () => window.print();

/* ---------------------------------------------------------------- Administration */
VIEWS.admin = async el => {
  const tab = S.cache.admTab || 'users';
  const tabs = [['users', 'Utilisateurs', 'users.manage'], ['roles', 'Rôles & permissions', null], ['tarif', 'Tarification', null], ['backup', 'Sauvegarde', 'backup.manage'], ['audit', 'Journal d\'audit', 'audit.view']];
  el.innerHTML = `<div class="seg no-print" style="margin-bottom:14px">${tabs.map(([k, l]) => `<button data-act="admTab" data-v="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="admBody"></div>`;
  const b = $('#admBody');
  const need = tabs.find(t => t[0] === tab)[2];
  if (need && !can(need)) { b.innerHTML = `<div class="card empty">${badge('b-stale', 'Accès restreint')} Cette section nécessite la permission <span class="mono">${need}</span> (principe du moindre privilège).</div>`; return; }
  if (tab === 'users') {
    const us = await api('/api/users');
    b.innerHTML = `<div class="grid g-21"><div class="card"><div class="card-h"><h2>Comptes</h2></div><table class="t"><thead><tr><th>Identifiant</th><th>Nom</th><th>Rôle</th><th>Actif</th><th>Dernière connexion</th><th></th></tr></thead><tbody>
      ${us.map(u => `<tr data-u="${esc(u.username)}"><td class="mono">${esc(u.username)}</td><td>${esc(u.fullname)}</td>
        <td><select data-f="role">${S.meta.roles.map(r => `<option value="${r.code}" ${r.code === u.role ? 'selected' : ''}>${esc(r.libelle)}</option>`).join('')}</select></td>
        <td><label class="switch"><input type="checkbox" data-f="actif" ${u.actif ? 'checked' : ''}><span></span></label></td><td class="mono small">${fdt(u.derniere_connexion)}</td>
        <td><button class="btn sm" data-act="saveUser">Enregistrer</button></td></tr>`).join('')}</tbody></table></div>
      <div class="card"><div class="card-h"><h2>Nouvel utilisateur</h2></div><div class="grid">
        <label class="f">Identifiant (alphanumérique)<input type="text" id="nuU"></label><label class="f">Nom complet<input type="text" id="nuN"></label>
        <label class="f">Rôle<select id="nuR">${S.meta.roles.map(r => `<option value="${r.code}">${esc(r.libelle)}</option>`).join('')}</select></label>
        <div class="small muted">Démonstrateur : pas de mot de passe, le profil se choisit en haut à droite.</div>
        <button class="btn primary" data-act="newUser">Créer</button></div></div></div>`;
  } else if (tab === 'roles') {
    const perms = ['view', 'alert.handle', 'report.generate', 'simulation.incident', 'config.seuils', 'config.ipe', 'config.ser', 'recette.run', 'audit.view', 'config.compteurs', 'config.acquisition', 'users.manage', 'backup.manage'];
    const lab = { view: 'Consulter', 'alert.handle': 'Traiter les alertes', 'report.generate': 'Générer les rapports', 'simulation.incident': 'Simuler (démo)', 'config.seuils': 'Seuils, règles, tarifs', 'config.ipe': 'Définir les IPE', 'config.ser': 'Gérer la SER', 'recette.run': 'Lancer la recette', 'audit.view': 'Consulter l\'audit', 'config.compteurs': 'Compteurs & registres', 'config.acquisition': 'Paramètres d\'acquisition', 'users.manage': 'Gérer les utilisateurs', 'backup.manage': 'Sauvegardes' };
    const R = { lecteur: ['view'], operateur: ['view', 'alert.handle', 'report.generate', 'simulation.incident'], energie: ['view', 'alert.handle', 'report.generate', 'simulation.incident', 'config.seuils', 'config.ipe', 'config.ser', 'recette.run', 'audit.view'], admin: perms };
    b.innerHTML = `<div class="card"><div class="card-h"><h2>Matrice des habilitations</h2><span class="sub">Moindre privilège (§2.9) — votre rôle : ${esc(S.meta.user.role)}</span></div><div class="tbl-wrap"><table class="t"><thead><tr><th>Permission</th>${S.meta.roles.map(r => `<th>${esc(r.libelle)}</th>`).join('')}</tr></thead><tbody>
      ${perms.map(p => `<tr><td>${lab[p]} <span class="mono small muted">${p}</span></td>${S.meta.roles.map(r => `<td>${R[r.code].includes(p) ? badge('b-good', 'Oui') : '<span class="muted">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="small muted mt">Toute tentative d'action non autorisée est refusée (HTTP 403) et journalisée (ACCES_REFUSE) — vérifié par l'essai T13.</div></div>`;
  } else if (tab === 'tarif') {
    const t = S.meta.tarif; const ed = can('config.seuils');
    b.innerHTML = `<div class="card" style="max-width:720px"><div class="card-h"><h2>Tarification et facteur d'émission</h2>${badge('b-warning', 'Indicatif')}</div>
      <div class="small ink2" style="margin-bottom:10px">${esc(t.note)} Plages : pointe ${t.pointe[0]} h–${t.pointe[1]} h, creuses ${t.creuses[0]} h–${t.creuses[1]} h, pleines le reste.</div>
      <div class="grid g-2">${[['prix_pointe', 'Heures de pointe (MAD/kWh)'], ['prix_pleines', 'Heures pleines (MAD/kWh)'], ['prix_creuses', 'Heures creuses (MAD/kWh)'], ['co2_kg_kwh', 'Facteur d\'émission (kg CO₂/kWh)']]
        .map(([k, l]) => `<label class="f">${l}<input type="number" step="0.01" id="tf_${k}" value="${t[k]}" ${ed ? '' : 'disabled'}></label>`).join('')}</div>
      ${ed ? '<div class="mt"><button class="btn primary" data-act="saveTarif">Enregistrer</button></div>' : ''}</div>`;
  } else if (tab === 'backup') {
    const d = await api('/api/backups');
    b.innerHTML = `<div class="card" style="max-width:820px"><div class="card-h"><h2>Sauvegarde et restauration</h2></div>
      <ol class="steps"><li>Sauvegarde automatique toutes les 10 minutes (API de sauvegarde SQLite à chaud, 10 dernières copies conservées).</li>
      <li>Dossier : <span class="mono">${esc(d.dossier)}</span> — sur Colab, placé dans Google Drive pour survivre à l'arrêt de la machine.</li>
      <li>Au redémarrage sur une machine vierge, la dernière sauvegarde est restaurée automatiquement.</li>
      <li>Chaque sauvegarde manuelle est vérifiée (PRAGMA integrity_check + comptages) — essai T14.</li></ol>
      <div class="mt row"><button class="btn primary" data-act="backupNow">Sauvegarder, vérifier et télécharger (.json)</button><button class="btn" data-act="resetDemo">Réinitialiser la démonstration</button></div>
      <table class="t mt"><thead><tr><th>Fichier</th><th class="n">Taille</th></tr></thead><tbody>${d.fichiers.map(f => `<tr><td class="mono">${esc(f.nom)}</td><td class="n">${fmt(f.taille_ko)} Ko</td></tr>`).join('') || '<tr><td colspan="2" class="muted">Aucune sauvegarde pour l\'instant</td></tr>'}</tbody></table></div>`;
  } else if (tab === 'audit') {
    const d = await api('/api/audit');
    b.innerHTML = `<div class="card"><div class="card-h"><h2>Journal d'audit</h2><span class="sub">Connexions, modifications de configuration, actions sensibles — 300 dernières entrées</span></div>
      <div class="tbl-wrap scroll-y" style="max-height:640px"><table class="t"><thead><tr><th>Date</th><th>Utilisateur</th><th>Action</th><th>Objet</th><th>Avant</th><th>Après</th><th>IP</th></tr></thead><tbody>
      ${d.map(a => `<tr><td class="mono small">${fdt(a.ts)}</td><td>${esc(a.username)}</td><td>${badge(a.action.includes('REFUSE') || a.action.includes('ECHEC') ? 'b-critical' : 'b-info', a.action)}</td><td class="small">${esc(a.objet)}</td>
        <td class="mono small" style="max-width:220px;overflow-wrap:anywhere">${esc(a.avant || '')}</td><td class="mono small" style="max-width:260px;overflow-wrap:anywhere">${esc(a.apres || '')}</td><td class="mono small">${esc(a.ip || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
};
ACT.admTab = el => { S.cache.admTab = el.dataset.v; route(); };
ACT.saveUser = async el => {
  const tr = el.closest('tr'); const u = tr.dataset.u;
  await act(() => api(`/api/users/${u}`, { method: 'PUT', body: { role: $('[data-f=role]', tr).value, actif: $('[data-f=actif]', tr).checked } }), 'Utilisateur mis à jour (journalisé)');
};
ACT.pwUser = el => {
  const u = el.closest('tr').dataset.u;
  openModal(`Réinitialiser le mot de passe — ${u}`, `<label class="f">Nouveau mot de passe (≥ 10 caractères)<input type="password" id="pwN" autocomplete="new-password"></label>`,
    `<button class="btn primary" data-act="pwSave" data-u="${esc(u)}">Enregistrer</button>`, true);
};
ACT.pwSave = async el => { if (await act(() => api(`/api/users/${el.dataset.u}`, { method: 'PUT', body: { password: $('#pwN').value } }), 'Mot de passe réinitialisé')) closeModal(); };
ACT.newUser = async () => { if (await act(() => api('/api/users', { method: 'POST', body: { username: $('#nuU').value, fullname: $('#nuN').value, role: $('#nuR').value, } }), 'Utilisateur créé')) route(); };
ACT.saveTarif = async () => { const b = {}; $$('[id^=tf_]').forEach(i => b[i.id.slice(3)] = i.value); if (await act(() => api('/api/tarif', { method: 'PUT', body: b }), 'Tarifs enregistrés')) { S.meta = await api('/api/meta'); route(); } };
ACT.resetDemo = async () => { await act(() => api('/api/reset', { method: 'POST', body: {} }), 'Démonstration réinitialisée — rechargement…'); };
ACT.backupNow = async () => { const r = await act(() => api('/api/backup', { method: 'POST', body: {} })); if (r) { toast(`Sauvegarde ${r.fichier} — intégrité ${r.ok ? 'OK' : 'KO'}`, r.ok ? 'ok' : 'err'); route(); } };

/* ---------------------------------------------------------------- Points à valider */
VIEWS.valider = async el => {
  const d = await api('/api/points-a-valider');
  el.innerHTML = `<div class="card"><div class="card-h"><h2>Registre des hypothèses et points à valider</h2><span class="sub">Spécification §11-§12 : ne rien considérer comme contractuel sans validation DEPA</span></div>
    <table class="t"><thead><tr><th>Thème</th><th>Point à confirmer</th><th>Hypothèse retenue dans ce prototype</th><th>Statut</th></tr></thead><tbody>
    ${d.map(x => `<tr><td>${esc(x.theme)}</td><td>${esc(x.point)}</td><td class="small ink2">${esc(x.hypothese)}</td><td>${badge('b-warning', 'À valider')}</td></tr>`).join('')}</tbody></table></div>
    <div class="card mt"><div class="card-h"><h2>Architecture logique implémentée (§4)</h2></div><div class="tbl-wrap"><table class="t"><tbody>
    ${[['1. Terrain', 'Compteurs simulés (6 postes + compteur de tête existant), modèle physique des usages portuaires — backend.js'],
      ['2. Communication', 'Modbus TCP/IP : trames MBAP (FC03/FC04, exceptions) encodées et décodées octet par octet ; transport en mémoire'],
      ['3. Acquisition', 'Scrutation 2 s, décodage par cartographie configurable, double horodatage, qualification, reconnexion, agrégation 1 min'],
      ['4. Données', 'Mémoire + stockage local du navigateur (configuration, alertes, audit, versions SER) — reprend le modèle §5'],
      ['5. Métier énergétique', 'Énergie par index, tarification horo-saisonnière, IPE, SER (régression multiple), CUSUM, règles d\'alerte'],
      ['6. Présentation', 'Application web monopage hébergée en statique (GitHub Pages) — index.html, app.js, Chart.js'],
      ['7. Exploitation', 'Profils et permissions, journal d\'audit, sauvegarde vérifiée, recette automatique T01-T14']]
      .map(([a, b]) => `<tr><td style="white-space:nowrap"><b>${a}</b></td><td>${b}</td></tr>`).join('')}</tbody></table></div></div>`;
};

/* ------------------------------------------------------------------ modale */
function openModal(title, body, foot = '', narrow = false) {
  $('#overlay').innerHTML = `<div class="overlay" data-act="ovl"><div class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-h"><h3>${esc(title)}</h3><span style="flex:1"></span><button class="iconbtn" data-act="closeModal" aria-label="Fermer">✕</button></div>
    <div class="modal-b">${body}</div>${foot ? `<div class="modal-f">${foot}</div>` : ''}</div></div>`;
}
function closeModal() { if (S.charts.cPoste) { S.charts.cPoste.destroy(); delete S.charts.cPoste; } $('#overlay').innerHTML = ''; }
ACT.closeModal = closeModal;
ACT.ovl = (el, e) => { if (e.target === el) closeModal(); };

/* ------------------------------------------------------------------ démarrage */
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (t && ACT[t.dataset.act]) { if (t.tagName === 'A') e.preventDefault(); ACT[t.dataset.act](t, e); } });
document.addEventListener('change', e => { const t = e.target.closest('[data-chg]'); if (t && CHG[t.dataset.chg]) CHG[t.dataset.chg](t, e); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g[data-act]')) { e.preventDefault(); ACT[e.target.dataset.act](e.target, e); }
});
function applyTheme(t) { document.documentElement.dataset.theme = t; store.set('sme-theme', t); }
(async function init() {
  SME.boot({ live: true });
  applyTheme(store.get('sme-theme') || 'dark');
  S.lang = store.get('sme-lang') || 'fr';
  $('#lang').value = S.lang;
  $('#lang').addEventListener('change', e => { S.lang = e.target.value; store.set('sme-lang', S.lang); buildNav(); route(); });
  $('#themeBtn').addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); route(); });
  $('#menuBtn').addEventListener('click', () => $('#side').classList.toggle('open'));
  S.meta = await api('/api/meta');
  const u = S.meta.user;
  const sel = $('#roleSel');
  sel.innerHTML = S.meta.users.map(x => `<option value="${esc(x.username)}" ${x.username === u.username ? 'selected' : ''}>${esc(S.meta.roles.find(r => r.code === x.role)?.libelle || x.role)}</option>`).join('');
  sel.title = `Profil actif : ${u.fullname}`;
  sel.addEventListener('change', async () => {
    if (await act(() => api('/api/session', { method: 'PUT', body: { username: sel.value } }))) { S.meta = await api('/api/meta'); toast(`Profil : ${S.meta.user.fullname}`, 'ok'); sel.title = `Profil actif : ${S.meta.user.fullname}`; route(); }
  });
  buildNav();
  setInterval(() => { $('#clock').textContent = _hms.format(new Date()); }, 1000);
  const refreshOpen = async () => {
    try { const a = await api('/api/alerts?etat=ouvertes&limit=300'); const m = {}; a.alertes.filter(x => !x.test && x.post_id).forEach(x => m[x.post_id] = (m[x.post_id] || 0) + 1); S.cache.openByPost = m; } catch { /* ignoré */ }
  };
  await Promise.all([pollLive(), refreshOpen()]);
  setInterval(pollLive, 2000); setInterval(refreshOpen, 10000);
  window.addEventListener('hashchange', route);
  route();
})();

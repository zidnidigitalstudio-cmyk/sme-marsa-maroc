/* Rapport mensuel de revue énergétique — rendu A4 */
'use strict';
(async function () {
  const b = document.body;
  const mois = b.dataset.mois;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 0) => (v == null || Number.isNaN(+v)) ? '—' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
  const M = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const fm = m => `${M[+m.slice(5) - 1]} ${m.slice(0, 4)}`;
  const sign = v => v == null ? '—' : `${v > 0 ? '+' : ''}${fmt(v, 1)} %`;
  document.getElementById('printBtn').addEventListener('click', () => window.print());
  const r = await fetch(`/api/report?mois=${encodeURIComponent(mois)}`, { credentials: 'same-origin' });
  if (!r.ok) { document.getElementById('sheet').innerHTML = '<div class="empty">Rapport indisponible pour ce mois.</div>'; return; }
  const d = await r.json();
  const c = d.client;
  const tot = d.total_kwh, n1 = d.total_kwh_n1;
  const ipeOk = d.ipe.filter(i => i.valeur != null && i.valeur <= i.cible).length;
  const ser = d.ser, mod = d.ser_modele;
  const derives = d.ipe.filter(i => i.valeur != null && (i.valeur - i.cible) / i.cible * 100 > 5);
  const ref = `SME-RVE-${mois}`;
  const actions = {
    'IPE-01': 'Analyser les consommations à vide des portiques et engins du terminal à conteneurs (talon nocturne, air comprimé, éclairage terre-plein).',
    'IPE-02': 'Vérifier le taux de charge des convoyeurs et les marches à vide entre deux navires vraquiers.',
    'IPE-03': 'Contrôler la récupération d\'énergie et les temps d\'attente moteurs tournants des grues mobiles.',
    'IPE-04': 'Contrôler les consignes de température et l\'état des prises reefers (conteneurs défaillants).',
    'IPE-05': 'Rapprocher la consommation par escale du planning d\'occupation des quais.',
    'IPE-06': 'Vérifier la programmation horaire de l\'éclairage et la gestion technique de la gare maritime.',
  };
  const tag = (v, cible) => v == null ? '<span class="tag n">n.d.</span>' : v <= cible ? '<span class="tag ok">Conforme</span>' : (v - cible) / cible * 100 <= 5 ? '<span class="tag warn">À surveiller</span>' : '<span class="tag bad">Dérive</span>';
  const qualRows = d.qualite.length ? d.qualite.map(q => `<tr><td>${q.point_id === 7 ? 'Compteur de tête (contrôle)' : 'P' + q.point_id}</td><td class="n">${fmt(q.minutes)}</td><td class="n">${fmt(q.completude * 100, 2)} %</td><td class="n">${fmt(q.reconst)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Mois antérieur à l\'historique détaillé (1 min) : données mensuelles consolidées uniquement.</td></tr>';
  document.getElementById('sheet').innerHTML = `
  <header class="rep-head">
    <div><div class="org">${esc(c.societe)} — ${esc(c.direction)}</div>
      <div class="doc">Revue énergétique mensuelle — ${fm(mois)}</div>
      <div class="muted" style="font-size:9pt">Système de Monitoring Énergétique · ${esc(c.site)} · ${esc(c.norme)} §6.3 à §6.6 et §9.1</div></div>
    <table class="rep-meta"><tbody>
      <tr><td>Référence</td><td>${ref}</td></tr><tr><td>Marché</td><td>${esc(c.marche)}</td></tr>
      <tr><td>Période</td><td>${fm(mois)}${d.en_cours ? ' (en cours)' : ''}</td></tr><tr><td>Édité le</td><td>${esc(b.dataset.genere)}</td></tr>
      <tr><td>Édité par</td><td>${esc(b.dataset.user)}</td></tr><tr><td>Version</td><td>1.0 — projet</td></tr></tbody></table>
  </header>

  <h2>1. Synthèse</h2>
  <div class="kpis">
    <div class="kpi"><div class="l">Consommation P1–P6</div><div class="v">${fmt(tot / 1000, 1)} MWh</div><div class="f">${n1 ? `${sign((tot - n1) / n1 * 100)} vs ${fm(d.mois.replace(/^\d{4}/, y => y - 1))}` : '&nbsp;'}</div></div>
    <div class="kpi"><div class="l">Écart à la SER (ajustée)</div><div class="v">${ser ? sign(ser.ecart_pct) : '—'}</div><div class="f">${ser ? `${fmt(ser.ecart_kwh)} kWh` : ''}</div></div>
    <div class="kpi"><div class="l">IPE conformes à la cible</div><div class="v">${ipeOk} / ${d.ipe.length}</div><div class="f">${derives.length} en dérive (&gt; 5 %)</div></div>
    <div class="kpi"><div class="l">Émissions indirectes</div><div class="v">${fmt(d.co2_t, 0)} t CO₂</div><div class="f">facteur paramétrable</div></div>
  </div>

  <h2>2. Périmètre, données et méthodes</h2>
  <p>Périmètre : six postes électriques 22/0,4 kV du port (P1 à P6). Le compteur de tête de l'arrivée ONEE (point existant intégré) sert au contrôle de cohérence et
  <b>n'est pas additionné</b> aux postes, afin d'éviter tout double comptage. Unités : kWh (énergie), kW (puissance). Agrégation : mensuelle.
  Source : ${esc(d.source)}. Les IPE et la SER présentés ont le statut « proposé » et restent à valider par le responsable énergie de la DEPA.</p>

  <h2>3. Consommations par poste</h2>
  <table class="r"><thead><tr><th>Poste</th><th>Désignation</th><th class="n">${fm(mois)} (kWh)</th><th class="n">Part</th><th class="n">N-1 (kWh)</th><th class="n">Variation</th></tr></thead><tbody>
  ${d.consommations.map(p => `<tr><td>${p.code}</td><td>${esc(p.libelle)}</td><td class="n">${fmt(p.kwh)}</td><td class="n">${fmt(p.kwh / tot * 100, 1)} %</td><td class="n">${fmt(p.kwh_n1)}</td><td class="n">${p.kwh_n1 ? sign((p.kwh - p.kwh_n1) / p.kwh_n1 * 100) : '—'}</td></tr>`).join('')}
  <tr class="tot"><td colspan="2">Total P1–P6</td><td class="n">${fmt(tot)}</td><td class="n">100 %</td><td class="n">${fmt(n1)}</td><td class="n">${n1 ? sign((tot - n1) / n1 * 100) : '—'}</td></tr></tbody></table>
  <div class="rep-chart"><canvas id="rc1"></canvas></div>

  <h2>4. Variables pertinentes (activité portuaire)</h2>
  <table class="r"><thead><tr><th>Jours</th><th class="n">EVP</th><th class="n">Tonnes vrac</th><th class="n">Escales</th><th class="n">Heures de grue</th><th class="n">Conteneurs-jour reefer</th></tr></thead><tbody>
  <tr><td>${fmt(d.activite.jours, 1)}</td><td class="n">${fmt(d.activite.evp)}</td><td class="n">${fmt(d.activite.tonnes_vrac)}</td><td class="n">${fmt(d.activite.escales, 0)}</td><td class="n">${fmt(d.activite.heures_grue)}</td><td class="n">${fmt(d.activite.reefer_jours)}</td></tr></tbody></table>

  <h2>5. Indicateurs de performance énergétique</h2>
  <table class="r"><thead><tr><th>Code</th><th>Indicateur</th><th>Formule</th><th class="n">Valeur</th><th class="n">Cible</th><th class="n">Réf. 2025</th><th class="n">Écart cible</th><th>Statut</th></tr></thead><tbody>
  ${d.ipe.map(i => { const dec = i.cible < 10 ? 3 : 1; return `<tr><td>${i.code}</td><td>${esc(i.libelle)}</td><td>${esc(i.formule)}</td><td class="n">${fmt(i.valeur, dec)} ${esc(i.unite)}</td><td class="n">${fmt(i.cible, dec)}</td><td class="n">${fmt(i.reference, dec)}</td><td class="n">${i.valeur != null ? sign((i.valeur - i.cible) / i.cible * 100) : '—'}</td><td>${tag(i.valeur, i.cible)}</td></tr>`; }).join('')}</tbody></table>

  <h2>6. Comparaison à la situation énergétique de référence</h2>
  ${mod ? `<p>SER v${mod.version} — période de référence ${fm(mod.periode_debut)} à ${fm(mod.periode_fin)}, modèle de régression linéaire multiple normalisé par jour sur
  ${mod.variables.map(v => esc(mod.libelles[v])).join(', ')} (R² = ${fmt(mod.r2, 3)}, CV(RMSE) = ${fmt(mod.cv_rmse, 2)} %, n = ${mod.n}).</p>` : ''}
  ${ser ? `<table class="r"><thead><tr><th>Mois</th><th class="n">Observé (kWh)</th><th class="n">Référence ajustée (kWh)</th><th class="n">Écart (kWh)</th><th class="n">Écart</th><th class="n">CUSUM (kWh)</th></tr></thead><tbody>
  <tr><td>${fm(mois)}</td><td class="n">${fmt(ser.observe)}</td><td class="n">${fmt(ser.predit)}</td><td class="n">${fmt(ser.ecart_kwh)}</td><td class="n">${sign(ser.ecart_pct)}</td><td class="n">${fmt(ser.cusum)}</td></tr></tbody></table>
  <p class="muted" style="font-size:9pt">Un écart négatif traduit une amélioration de la performance énergétique à activité égale.</p>` : '<p class="muted">Mois dans la période de référence.</p>'}

  <h2>7. Alertes et indisponibilités de mesure</h2>
  ${d.alertes.length ? `<table class="r"><thead><tr><th>Règle</th><th>Priorité</th><th class="n">Nombre</th></tr></thead><tbody>${d.alertes.map(a => `<tr><td>${a.rule_code}</td><td>${esc(a.priorite)}</td><td class="n">${a.n}</td></tr>`).join('')}</tbody></table>` : '<p>Aucune alerte enregistrée sur la période.</p>'}

  <h2>8. Complétude et qualité des données</h2>
  <table class="r"><thead><tr><th>Point de comptage</th><th class="n">Minutes enregistrées</th><th class="n">Complétude moyenne</th><th class="n">Minutes reconstituées</th></tr></thead><tbody>${qualRows}</tbody></table>

  <h2>9. Pistes d'amélioration proposées</h2>
  ${derives.length ? `<table class="r"><thead><tr><th>IPE en dérive</th><th>Action proposée (à valider)</th><th>Pilote</th><th>Échéance</th></tr></thead><tbody>
  ${derives.map(i => `<tr><td>${i.code} (${sign((i.valeur - i.cible) / i.cible * 100)})</td><td>${esc(actions[i.code] || 'Analyse des causes à mener.')}</td><td>&nbsp;</td><td>&nbsp;</td></tr>`).join('')}</tbody></table>`
    : '<p>Aucun IPE en dérive : poursuivre le suivi.</p>'}

  <h2>10. Visas</h2>
  <div class="sign"><div><b>Responsable énergie</b>Nom, date, signature</div><div><b>Chef de département</b>Nom, date, signature</div><div><b>Directeur DEPA</b>Nom, date, signature</div></div>

  <div class="rep-foot">Document généré automatiquement par le SME — ${ref} — ${esc(c.objet)}, marché ${esc(c.marche)}.
  Prototype académique : données simulées, tarifs et facteurs indicatifs. ${esc(d.tarif_note)}</div>`;
  new Chart(document.getElementById('rc1'), {
    type: 'bar',
    data: { labels: d.consommations.map(p => p.code), datasets: [
      { label: fm(mois), data: d.consommations.map(p => p.kwh), backgroundColor: '#2a78d6', borderRadius: 3 },
      { label: 'N-1', data: d.consommations.map(p => p.kwh_n1), backgroundColor: '#86b6ef', borderRadius: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { position: 'top', labels: { boxWidth: 10, color: '#111' } } },
      scales: { y: { ticks: { callback: v => fmt(v / 1000) + ' MWh', color: '#5c5b57' }, grid: { color: '#e1e0d9' } }, x: { grid: { display: false }, ticks: { color: '#111' } } } },
  });
})();

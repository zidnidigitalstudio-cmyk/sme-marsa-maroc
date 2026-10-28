/* SME — moteur exécuté dans le navigateur (version statique, GitHub Pages)
   Couches : terrain simulé · Modbus TCP (trames MBAP réelles, transport en mémoire) · acquisition ·
   données (mémoire + localStorage) · métier énergétique (IPE, SER, tarification) · alertes · recette.
   Expose window.SME.request(method, path, body) qui imite l'API REST de la version serveur. */
'use strict';
(function () {
  const TZ = 'Africa/Casablanca';
  const STORE_KEY = 'sme-static-v1';
  const CLIENT = { societe: 'Marsa Maroc', direction: "Direction d'Exploitation au Port d'Agadir (DEPA)", site: "Port d'Agadir",
    marche: '12/DEPA/2026', objet: "Fourniture, installation, intégration et mise en service d'un Système de Monitoring Énergétique (SME)", norme: 'ISO 50001:2018' };

  /* ------------------------------------------------------------------ outils */
  const now = () => Date.now() / 1000;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clone = o => JSON.parse(JSON.stringify(o));
  function makeRng(seed) {
    let a = seed >>> 0;
    const r = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    r.gauss = (mu, s) => { let u = 0; while (!u) u = r(); const v = r(); return mu + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    return r;
  }
  const PF = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  function lp(ts) {
    const o = {}; for (const p of PF.formatToParts(new Date(ts * 1000))) o[p.type] = p.value;
    const y = +o.year, m = +o.month, d = +o.day, h = +o.hour % 24, mi = +o.minute, s = +o.second;
    return { y, m, d, h, mi, s, wd: WD.indexOf(o.weekday), ord: Math.floor(Date.UTC(y, m - 1, d) / 86400000) + 719163,
      offset: (Date.UTC(y, m - 1, d, h, mi, s) / 1000) - Math.floor(ts) };
  }
  const monthKey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  function localTs(y, m, d) { const guess = Date.UTC(y, m - 1, d) / 1000; return guess - lp(guess).offset; }

  /* ------------------------------------------------------------------ référentiel (démonstration, à valider DEPA) */
  const POSTES = [
    { id: 1, code: 'P1', libelle: 'Poste Quai Nord', emplacement: 'Terminal à conteneurs', usage: 'conteneurs', transfo_kva: 2000, souscrite_kw: 1400, departs: ['Portiques de quai', 'Engins électrifiés', 'Atelier terminal', 'Éclairage terre-plein Nord'] },
    { id: 2, code: 'P2', libelle: 'Poste Central MT/BT', emplacement: 'Services généraux & ateliers', usage: 'services', transfo_kva: 1250, souscrite_kw: 700, departs: ['Ateliers de maintenance', 'Bâtiment DEPA', 'Station de pompage / incendie', 'Capitainerie'] },
    { id: 3, code: 'P3', libelle: 'Poste Vrac & Silos', emplacement: 'Terminal vrac', usage: 'vrac', transfo_kva: 1600, souscrite_kw: 1100, departs: ['Convoyeurs à bande', 'Silos & élévateurs', 'Dépoussiérage', 'Trémies de chargement'] },
    { id: 4, code: 'P4', libelle: 'Poste Grues Mobiles', emplacement: 'Grues mobiles portuaires', usage: 'grues', transfo_kva: 2000, souscrite_kw: 1500, departs: ['Grue mobile GM-01', 'Grue mobile GM-02', 'Grue mobile GM-03', 'Grue mobile GM-04'] },
    { id: 5, code: 'P5', libelle: 'Poste Frigorifique Reefers', emplacement: 'Parc reefers & entrepôt froid', usage: 'reefers', transfo_kva: 1250, souscrite_kw: 850, departs: ['Prises reefers zone A', 'Prises reefers zone B', 'Entrepôt froid', 'Compresseurs'] },
    { id: 6, code: 'P6', libelle: 'Poste Gare Maritime & Éclairage', emplacement: 'Gare maritime, éclairage portuaire', usage: 'eclairage', transfo_kva: 800, souscrite_kw: 500, departs: ["Mâts d'éclairage portuaire", 'Gare maritime', "Contrôle d'accès / vidéo", 'Parkings'] },
  ].map(p => ({ ...p, site_id: 1, parent_id: null, etat: 'en service' }));
  const POST_BY_ID = Object.fromEntries(POSTES.map(p => [p.id, p]));
  const EQUIP0 = [1, 2, 3, 4, 5, 6].map(i => ({ id: i, post_id: i, code: `CPT-P${i}`, libelle: `Compteur général poste P${i}`, fabricant: 'Schneider Electric',
    modele: 'PM800 (profil simulé — à confirmer)', protocole: 'Modbus TCP/IP', ip: `10.20.1.${10 + i}`, port: 502, unit_id: i, profil: 'PM800-DEMO', existant: 0, actif: 1, etat: 'en service' }))
    .concat([{ id: 7, post_id: null, code: 'CPT-TETE', libelle: 'Compteur de tête arrivée ONEE 22 kV (existant)', fabricant: 'Existant — à inventorier',
      modele: 'Via passerelle Modbus RTU/TCP (à confirmer)', protocole: 'Modbus TCP/IP', ip: '10.20.1.10', port: 502, unit_id: 7, profil: 'PM800-MT-DEMO', existant: 1, actif: 1, etat: 'en service' }]);
  const POINTS = EQUIP0.map(e => ({ id: e.id, equipment_id: e.id, post_id: e.post_id, parent_point_id: e.existant ? null : 7,
    code: e.existant ? 'PC-TETE' : `PC-P${e.id}`, libelle: e.existant ? 'Arrivée générale ONEE (contrôle)' : `Départ général P${e.id}`,
    role: e.existant ? 'tete' : 'poste', inclus_agregation: e.existant ? 0 : 1 }));
  const DEV_DEFS = [ // documentation « constructeur » du compteur simulé
    ['P', 3000, 'float32', 1, 'kW', 'Puissance active totale', -50, 4000], ['Q', 3002, 'float32', 1, 'kvar', 'Puissance réactive totale', -3000, 3000],
    ['S', 3004, 'float32', 1, 'kVA', 'Puissance apparente totale', 0, 5000], ['PF', 3006, 'float32', 1, '', 'Facteur de puissance total', 0, 1],
    ['U', 3008, 'float32', 1, 'V', 'Tension composée moyenne', 300, 480], ['I', 3010, 'float32', 1, 'A', 'Courant moyen', 0, 8000],
    ['F', 3012, 'float32', 1, 'Hz', 'Fréquence', 47, 53], ['THD', 3014, 'float32', 1, '%', 'Taux de distorsion harmonique tension', 0, 40],
    ['E', 3016, 'uint32', 0.1, 'kWh', 'Énergie active importée (index)', 0, 4.3e8], ['TS', 3018, 'uint32', 1, 's', 'Horodatage compteur (epoch UTC)', 0, 4.3e9],
  ].map(d => ({ grandeur: d[0], adresse: d[1], type: d[2], echelle: d[3], unite: d[4], description: d[5], min_valide: d[6], max_valide: d[7] }));
  function defaultDefs() {
    let id = 1; const out = [];
    for (const profil of ['PM800-DEMO', 'PM800-MT-DEMO']) for (const d of DEV_DEFS) {
      let x = { ...d };
      if (profil === 'PM800-MT-DEMO' && d.grandeur === 'U') x = { ...x, unite: 'kV', description: 'Tension composée MT', min_valide: 18, max_valide: 26 };
      if (profil === 'PM800-MT-DEMO' && d.grandeur === 'I') x = { ...x, description: 'Courant moyen MT', max_valide: 400 };
      out.push({ id: id++, profil, ...x });
    }
    return out;
  }
  const RULES0 = [['R01', 'Absence de communication compteur', 'COMM', null, 'critique', 6], ['R02', 'Donnée manquante ou invalide', 'QUALITE', null, 'mineure', 0],
    ['R03', "Charge ≥ seuil d'alerte (% souscrite)", 'CHARGE', 90, 'majeure', 0], ['R04', 'Dépassement de la puissance souscrite', 'CHARGE', 100, 'critique', 0],
    ['R05', 'Facteur de puissance bas', 'PF_MIN', 0.85, 'mineure', 10], ['R06', 'Tension basse', 'U_MIN', 360, 'majeure', 0], ['R07', 'Tension haute', 'U_MAX', 440, 'majeure', 0],
    ['R08', 'Distorsion harmonique élevée (THD-U)', 'THD', 8, 'mineure', 10], ['R09', "Écart d'un IPE à sa cible", 'ECART_IPE', 5, 'majeure', 0],
    ['R10', 'Écart mensuel significatif à la SER', 'ECART_SER', 5, 'mineure', 0], ['R11', 'Incohérence compteur de tête / postes', 'COHERENCE', 5, 'mineure', 30]]
    .map(r => ({ code: r[0], libelle: r[1], type: r[2], seuil: r[3], priorite: r[4], delai_s: r[5], actif: 1 }));
  const IPE0 = [['IPE-01', 'Consommation spécifique du terminal à conteneurs', 'E(P1) / EVP', 'conteneurs', 'evp', 'kWh/EVP', 'Poste P1', 30.5],
    ['IPE-02', 'Consommation spécifique du terminal vrac', 'E(P3) / tonnes vrac', 'vrac', 'tonnes_vrac', 'kWh/t', 'Poste P3', 1.10],
    ['IPE-03', 'Intensité énergétique des grues mobiles', 'E(P4) / heures de grue', 'grues', 'heures_grue', 'kWh/h', 'Poste P4', 140],
    ['IPE-04', 'Consommation par conteneur frigorifique', 'E(P5) / conteneurs-jour reefer', 'reefers', 'reefer_jours', 'kWh/c.j', 'Poste P5', 75],
    ['IPE-05', 'Consommation par escale', 'Σ E(P1..P6) / escales', 'total', 'escales', 'kWh/escale', 'Postes P1 à P6', 18500],
    ['IPE-06', 'Consommation journalière éclairage & gare maritime', 'E(P6) / jours', 'eclairage', 'jours', 'kWh/j', 'Poste P6', 4800]]
    .map(i => ({ code: i[0], libelle: i[1], description: `Indicateur proposé : ${i[1].toLowerCase()}.`, formule: i[2], num: i[3], den: i[4], unite: i[5], perimetre: i[6],
      periode_agregation: 'mensuelle', regle_manquantes: 'Mois retenu si complétude ≥ 90 % ; sinon valeur signalée « incomplète » et exclue des tendances.',
      cible: i[7], sens: 'baisse', date_effet: '2025-01-01', version: 1, statut_validation: 'proposé — à valider DEPA' }));
  const ROLES = [{ code: 'lecteur', libelle: 'Lecteur / auditeur', niveau: 1 }, { code: 'operateur', libelle: 'Exploitant / opérateur', niveau: 2 },
    { code: 'energie', libelle: 'Responsable énergie', niveau: 3 }, { code: 'admin', libelle: 'Administrateur technique', niveau: 4 }];
  const P_OP = ['view', 'alert.handle', 'report.generate', 'simulation.incident'];
  const P_EN = P_OP.concat(['config.seuils', 'config.ipe', 'config.ser', 'recette.run', 'audit.view']);
  const PERMS = { lecteur: ['view'], operateur: P_OP, energie: P_EN, admin: P_EN.concat(['config.compteurs', 'config.acquisition', 'users.manage', 'backup.manage']) };
  const USERS0 = [['admin', 'Administrateur technique SME', 'admin'], ['energie', 'Responsable énergie DEPA', 'energie'],
    ['operateur', 'Exploitant salle de conduite', 'operateur'], ['auditeur', 'Auditeur ISO 50001', 'lecteur']]
    .map(u => ({ username: u[0], fullname: u[1], role: u[2], actif: 1, cree_le: now(), derniere_connexion: null }));
  const ACQ0 = { periode_s: 2, timeout_s: 0.6, reconnexion_s: 10, retention_brut_h: 6, fraicheur_s: 6, peremption_s: 60, derive_horloge_max_s: 5 };
  const TARIF0 = { devise: 'MAD', prix_pointe: 1.40, prix_pleines: 0.98, prix_creuses: 0.68, pointe: [17, 22], creuses: [22, 7], co2_kg_kwh: 0.70,
    note: 'Barème INDICATIF de démonstration — à remplacer par les conditions du contrat ONEE.' };
  const SIM0 = { navire_conteneurs: true, navire_vrac: false, grues_actives: 2, reefers: 180, eclairage_facteur: 1 };
  const INCIDENTS = { coupure: 'Coupure de communication Modbus', surcharge: 'Surcharge (dépassement de puissance souscrite)', tension_basse: 'Chute de tension',
    pf_bas: 'Facteur de puissance dégradé', harmoniques: 'Pollution harmonique', valeur_invalide: 'Valeur hors plage (registre corrompu)', horloge: "Dérive de l'horloge du compteur" };
  const POINTS_A_VALIDER = [['Patrimoine', 'Liste et désignation exactes des six postes électriques', 'Démo : 6 postes nommés par usage'],
    ['Comptage', 'Marques, modèles et classes de précision des compteurs', 'Démo : profil type PM800 simulé'],
    ['Comptage', 'Cartographies Modbus officielles (adresses, types, échelles, codes d\'erreur)', 'Démo : registres 3000-3019 float32/uint32'],
    ['Comptage', 'Inventaire des points existants et passerelles', 'Démo : compteur de tête ONEE intégré, exclu des agrégations'],
    ['Réseau', "Topologie, plan d'adressage IP, segmentation et cybersécurité", 'Démo : 10.20.1.0/24 documentaire, transport Modbus simulé dans le navigateur'],
    ['Acquisition', "Période d'échantillonnage, rétention et disponibilité attendues", 'Démo : 2 s, brut 6 h, agrégé 1 min'],
    ['IPE', 'Formules et référentiels officiels des IPE', 'Démo : 6 IPE proposés, statut « proposé »'],
    ['SER', 'Méthode, variables pertinentes et période de référence de la SER', 'Démo : régression multivariée sur 2025'],
    ['Alertes', 'Seuils, priorités et canaux de notification', 'Démo : 11 règles, notification dans l\'interface'],
    ['Reporting', 'Formats, modèles, périodicités et destinataires des rapports', 'Démo : revue mensuelle A4 + export CSV'],
    ['Accès', "Profils et nombre d'utilisateurs", 'Démo : 4 rôles, moindre privilège, sélection de profil sans mot de passe'],
    ['Exploitation', 'Sauvegarde, restauration, garantie et maintenance', 'Démo : instantané JSON vérifié + téléchargement'],
    ['Hébergement', "Architecture d'hébergement, serveur et stockage", 'Démo : site statique GitHub Pages, données propres à chaque navigateur'],
    ['Tarification', 'Conditions tarifaires du contrat ONEE', 'Démo : barème indicatif 3 postes horaires'],
    ['Formation', 'Programme, durée et nombre de participants', 'Hors application (T15 manuel)']]
    .map(x => ({ theme: x[0], point: x[1], hypothese: x[2] }));

  /* ------------------------------------------------------------------ état persistant (propre à ce navigateur) */
  let ST = null;
  let readOnly = false;
  function freshState() {
    return { v: 1, equipment: clone(EQUIP0), defs: defaultDefs(), rules: clone(RULES0), ipe: clone(IPE0), baselines: [], alerts: [], events: [],
      audit: [], acq: { ...ACQ0 }, tarif: { ...TARIF0 }, sim: { ...SIM0 }, users: clone(USERS0), jobs: [], runs: [], backups: [],
      session: { username: 'admin', fullname: 'Administrateur technique SME', role: 'admin' }, seq: { alert: 0, event: 0, audit: 0, base: 0, job: 0, run: 0 } };
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (s && s.v === 1) return s; } catch { /* stockage indisponible */ }
    return null;
  }
  let saveTimer = null;
  function save() {
    if (readOnly) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      ST.alerts = ST.alerts.slice(-600); ST.events = ST.events.slice(-3000); ST.audit = ST.audit.slice(-800);
      try { localStorage.setItem(STORE_KEY, JSON.stringify(ST)); } catch { /* quota ou mode privé */ }
    }, 300);
  }
  function audit(action, objet = '', avant = null, apres = null, username) {
    ST.audit.push({ id: ++ST.seq.audit, ts: now(), username: username || ST.session.username, action, objet,
      avant: avant == null ? null : JSON.stringify(avant), apres: apres == null ? null : JSON.stringify(apres), ip: 'navigateur' });
    save();
  }

  /* ------------------------------------------------------------------ modèle physique (usages portuaires) */
  const SQRT3 = Math.sqrt(3);
  const CRANE_PERIOD = 110;
  const CRANE_PHASES = [['Levage', 0, 35, 380], ['Rotation', 35, 55, 140], ['Descente', 55, 85, 45], ['Attente', 85, 110, 25]];
  const CRANE_MEAN = CRANE_PHASES.reduce((a, [, s, e, kw]) => a + (e - s) * kw, 0) / CRANE_PERIOD;
  const CRANE_IDLE = 18;
  function cranePhase(i, t) {
    const pos = (t + i * 37) % CRANE_PERIOD;
    for (const [n, a, b, kw] of CRANE_PHASES) if (pos >= a && pos < b) return [n, kw, (pos - a) / (b - a)];
    return ['Attente', 25, 0];
  }
  function usagePower(post, hour, wd, ctx, t, averaged, rnd) {
    let p, pf; const h = hour;
    switch (post.usage) {
      case 'conteneurs': p = 250 + (ctx.navire_conteneurs ? 540 * (0.85 + 0.15 * Math.sin(h / 3)) : 0); pf = 0.91; break;
      case 'services': p = 150 + 150 * ((wd < 5 && h >= 8 && h < 18) ? 1 : 0) + 25 * Math.sin(h / 24 * 2 * Math.PI); pf = 0.88; break;
      case 'vrac': p = 110 + (ctx.navire_vrac ? 640 : 0); pf = 0.88; break;
      case 'grues': {
        const working = ctx.navire_conteneurs || ctx.navire_vrac; p = 30; const pfs = [];
        for (let i = 0; i < ctx.grues_actives; i++) {
          if (!working) { p += CRANE_IDLE; pfs.push(0.86); } else if (averaged || t == null) { p += CRANE_MEAN; pfs.push(0.88); }
          else { const [, kw] = cranePhase(i, t); p += kw; pfs.push(kw > 100 ? 0.90 : 0.87); }
        }
        pf = pfs.length ? pfs.reduce((a, b) => a + b) / pfs.length : 0.86; break;
      }
      case 'reefers': p = 60 + ctx.reefers * 3.1 * (1 + 0.12 * Math.sin((h - 9) / 24 * 2 * Math.PI)); pf = 0.86; break;
      case 'eclairage': p = ((h < 7 || h >= 19) ? 320 : 100) * (ctx.eclairage_facteur ?? 1) + 60; pf = 0.95; break;
      default: p = 100; pf = 0.9;
    }
    p *= 1 + rnd.gauss(0, averaged ? 0.02 : 0.035);
    pf = Math.min(0.99, Math.max(0.5, pf + rnd.gauss(0, 0.006)));
    return [Math.max(p, 0), pf];
  }
  function electrical(post, p, pf, rnd) {
    const ch = p / post.souscrite_kw;
    const u = 400 - 13 * ch + rnd.gauss(0, 1.2);
    const s = pf > 0 ? p / pf : p;
    const q = Math.sqrt(Math.max(s * s - p * p, 0));
    const harm = ['grues', 'vrac', 'reefers'].includes(post.usage) ? 1 : 0.4;
    return { P: p, Q: q, S: s, PF: pf, U: u, I: s * 1000 / (SQRT3 * u), F: 50 + rnd.gauss(0, 0.015), THD: Math.max(1.6 + 3.2 * harm * Math.min(ch, 1.3) + rnd.gauss(0, 0.15), 0.3) };
  }
  function headValues(vals, rnd) {
    const p = vals.reduce((a, v) => a + v.P, 0) * 1.012, q = vals.reduce((a, v) => a + v.Q, 0) * 1.03;
    const s = Math.hypot(p, q), u = 22 + rnd.gauss(0, 0.05);
    return { P: p, Q: q, S: s, PF: s ? p / s : 1, U: u, I: s / (SQRT3 * u), F: 50 + rnd.gauss(0, 0.015), THD: 1.4 + rnd.gauss(0, 0.1) };
  }
  function historyCtx(L) {
    const d = L.ord, h = L.h + L.mi / 60;
    const nc = (d % 3 !== 2 && h >= 5 && h < 21) || (d % 3 === 0 && h >= 21), nv = [0, 1].includes(d % 4);
    return { navire_conteneurs: nc, navire_vrac: nv, grues_actives: (nc ? 2 : 0) + (nv ? 1 : 0), reefers: 175 + 20 * Math.sin(d / 3), eclairage_facteur: 1 };
  }

  /* ------------------------------------------------------------------ Modbus TCP : trames MBAP réelles, transport en mémoire */
  const banks = new Map(); const offline = new Set(); let tid = 0;
  const f32words = v => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v); return [dv.getUint16(0), dv.getUint16(2)]; };
  const wordsF32 = (hi, lo) => { const dv = new DataView(new ArrayBuffer(4)); dv.setUint16(0, hi); dv.setUint16(2, lo); return dv.getFloat32(0); };
  const u32words = v => { v = Math.floor(v + 1e-9) >>> 0; return [(v >>> 16) & 0xFFFF, v & 0xFFFF]; };
  const wordsU32 = (hi, lo) => ((hi << 16) >>> 0) + lo;
  function setRegisters(unit, map) { if (!banks.has(unit)) banks.set(unit, new Map()); const b = banks.get(unit); for (const [a, w] of map) b.set(a, w); }
  function serverHandle(adu) { // esclave : reçoit une ADU, renvoie la réponse ou null (pas de réponse)
    const dv = new DataView(adu.buffer);
    const t = dv.getUint16(0), unit = dv.getUint8(6), fc = dv.getUint8(7);
    if (!banks.has(unit) || offline.has(unit)) return null;
    let pdu;
    if (fc !== 3 && fc !== 4) pdu = [fc | 0x80, 1];
    else {
      const addr = dv.getUint16(8), qty = dv.getUint16(10), b = banks.get(unit); const words = [];
      for (let a = addr; a < addr + qty; a++) { if (!b.has(a)) { words.length = 0; break; } words.push(b.get(a)); }
      if (qty < 1 || qty > 125 || words.length !== qty) pdu = [fc | 0x80, 2];
      else { pdu = [fc, 2 * qty]; for (const w of words) pdu.push(w >> 8, w & 0xFF); }
    }
    const out = new Uint8Array(7 + pdu.length); const o = new DataView(out.buffer);
    o.setUint16(0, t); o.setUint16(2, 0); o.setUint16(4, pdu.length + 1); o.setUint8(6, unit); out.set(pdu, 7);
    return out;
  }
  function readRegisters(unit, address, count, fc = 3) { // client Modbus TCP
    tid = (tid + 1) & 0xFFFF;
    const adu = new Uint8Array(12); const dv = new DataView(adu.buffer);
    dv.setUint16(0, tid); dv.setUint16(2, 0); dv.setUint16(4, 6); dv.setUint8(6, unit); dv.setUint8(7, fc); dv.setUint16(8, address); dv.setUint16(10, count);
    const resp = serverHandle(adu);
    if (!resp) { const e = new Error('délai de réponse dépassé'); e.name = 'Timeout'; throw e; }
    const r = new DataView(resp.buffer);
    if (r.getUint16(0) !== tid || r.getUint8(6) !== unit) throw new Error('réponse incohérente (TID/Unit)');
    if (r.getUint8(7) & 0x80) { const e = new Error('exception Modbus code ' + r.getUint8(8)); e.name = 'ModbusError'; throw e; }
    const n = r.getUint8(8) / 2, words = [];
    for (let i = 0; i < n; i++) words.push(r.getUint16(9 + 2 * i));
    return words;
  }
  function encodeRegisters(defs, values) {
    const out = [];
    for (const d of defs) {
      const v = values[d.grandeur]; if (v == null) continue;
      const raw = v / d.echelle; const w = d.type === 'float32' ? f32words(raw) : u32words(raw);
      out.push([d.adresse, w[0]], [d.adresse + 1, w[1]]);
    }
    return out;
  }
  function decodeRegisters(defs, start, regs) {
    const out = {};
    for (const d of defs) {
      const i = d.adresse - start;
      if (i < 0 || i + 1 >= regs.length) { out[d.grandeur] = [null, 'absente']; continue; }
      const raw = d.type === 'float32' ? wordsF32(regs[i], regs[i + 1]) : wordsU32(regs[i], regs[i + 1]);
      const v = raw * d.echelle;
      out[d.grandeur] = (Number.isNaN(v) || v < d.min_valide || v > d.max_valide) ? [Number.isNaN(v) ? null : v, 'invalide'] : [v, 'valide'];
    }
    return out;
  }
  function classify(dec, tRec, deriveMax, h) {
    const motifs = [];
    if (['P', 'U', 'PF', 'E'].some(k => (dec[k] || [null, 'absente'])[1] === 'absente')) motifs.push('grandeur absente');
    const inv = Object.entries(dec).filter(([, x]) => x[1] === 'invalide').map(([k]) => k);
    if (inv.length) motifs.push('hors plage : ' + inv.join(', '));
    const [tsv, tsq] = dec.TS || [null, 'absente'];
    const tsM = tsq === 'valide' ? tsv : tRec;
    if (tsq === 'valide' && Math.abs(tRec - tsv) > deriveMax) motifs.push(`dérive horloge ${tRec - tsv >= 0 ? '+' : ''}${(tRec - tsv).toFixed(1)} s`);
    const p = (dec.P || [])[0];
    if (p != null && h.p.length >= 5 && h.p.slice(-5).every(x => x === p)) motifs.push('valeur figée');
    const e = (dec.E || [])[0];
    if (e != null && h.lastE != null && e < h.lastE - 0.05) motifs.push('index énergie décroissant');
    const q = motifs.some(m => m.startsWith('hors plage') || m === 'grandeur absente') ? 'invalide' : motifs.length ? 'suspecte' : 'valide';
    return [q, motifs, tsM];
  }

  /* ------------------------------------------------------------------ données en mémoire */
  const AGG = {};            // point -> [{ts,p,pmax,q,pf,u,i,f,thd,e_index,e_kwh,nv,na,compl,rec}]
  let RAW = [];              // mesures brutes récentes
  let MONTHLY = [];          // table mensuelle consolidée (activité + énergie par usage)
  const USAGES = ['conteneurs', 'services', 'vrac', 'grues', 'reefers', 'eclairage'];

  function seedMonthly() {
    const rnd = makeRng(50001); const L = lp(now()); const out = [];
    let y = 2025, m = 1;
    while (y < L.y || (y === L.y && m <= L.m)) {
      const nd = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const cur = y === L.y && m === L.m;
      const jours = Math.max(cur ? (L.d - 1 + L.h / 24) : nd, 0.5); const f = jours / nd;
      const season = Math.sin((m - 1) / 12 * 2 * Math.PI), growth = y === 2026 ? 1.04 : 1;
      const evp = (11000 + 1300 * Math.sin((m + 2) / 12 * 2 * Math.PI) + rnd.gauss(0, 450)) * growth * f;
      const tonnes = (220000 + 38000 * Math.cos(m / 12 * 2 * Math.PI) + rnd.gauss(0, 9000)) * f;
      const escales = (86 + 9 * season + rnd.gauss(0, 3)) * f;
      const heures = (1450 + 0.05 * evp / f + 0.0012 * tonnes / f + rnd.gauss(0, 40)) * f;
      const reefer = (5400 + 1100 * Math.cos((m - 2) / 12 * 2 * Math.PI) + rnd.gauss(0, 150)) * f;
      const drift = (y > 2026 || (y === 2026 && m >= 8)) ? 1.09 : 1, led = (y > 2026 || (y === 2026 && m >= 3)) ? 0.78 : 1;
      const e = {
        conteneurs: (112000 * f + 21.4 * evp) * drift * (1 + rnd.gauss(0, 0.03)), vrac: (40000 * f + 0.95 * tonnes) * (1 + rnd.gauss(0, 0.03)),
        grues: 142 * heures * (1 + rnd.gauss(0, 0.035)), reefers: 77.5 * reefer * (1 + rnd.gauss(0, 0.025)),
        eclairage: 5600 * jours * led * (1 + 0.05 * Math.cos(m / 12 * 2 * Math.PI)) * (1 + rnd.gauss(0, 0.02)),
        services: (150000 + 14000 * season) * f * (1 + rnd.gauss(0, 0.04)),
      };
      const row = { mois: monthKey(y, m), jours: Math.round(jours * 100) / 100, evp: Math.round(evp), tonnes_vrac: Math.round(tonnes), escales: Math.round(escales * 10) / 10,
        heures_grue: Math.round(heures), reefer_jours: Math.round(reefer), source: cur ? 'mois en cours (démo)' : 'consolidé (démo)', en_cours: cur };
      for (const u of USAGES) row[u] = Math.round(e[u]);
      row.total = USAGES.reduce((a, u) => a + row[u], 0);
      out.push(row);
      if (m === 12) { y++; m = 1; } else m++;
    }
    MONTHLY = out;
  }
  function seedHistory() {
    const rnd = makeRng(2026); const end = Math.floor(now() / 60) * 60; const start = end - 7 * 86400;
    const gapA = end - 3 * 86400 + 7200, gapB = gapA + 5400;
    const idx = {}, lastValid = {};
    for (let i = 1; i <= 7; i++) { idx[i] = 1200000 + 150000 * i; lastValid[i] = idx[i]; AGG[i] = []; }
    let L = null;
    for (let ts = start; ts < end; ts += 60) {
      if (!L || (ts - start) % 900 === 0) L = lp(ts); else { L = { ...L }; L.mi += 1; if (L.mi >= 60) { L.mi -= 60; L.h += 1; } if (L.h >= 24) L = lp(ts); }
      const ctx = historyCtx(L); const vals = [];
      for (const p of POSTES) { const [pk, pf] = usagePower(p, L.h + L.mi / 60, L.wd, ctx, null, true, rnd); vals.push(electrical(p, pk, pf, rnd)); }
      vals.push(headValues(vals, rnd));
      vals.forEach((v, k) => {
        const pid = k + 1; idx[pid] += v.P / 60;
        if (pid === 3 && ts >= gapA && ts < gapB) { AGG[pid].push({ ts, p: null, pmax: null, q: null, pf: null, u: null, i: null, f: null, thd: null, e_index: null, e_kwh: null, nv: 0, na: 30, compl: 0, rec: 0 }); return; }
        const ek = idx[pid] - lastValid[pid]; lastValid[pid] = idx[pid];
        AGG[pid].push({ ts, p: v.P, pmax: v.P * (1.06 + rnd() * 0.06), q: v.Q, pf: v.PF, u: v.U, i: v.I, f: v.F, thd: v.THD, e_index: idx[pid], e_kwh: ek, nv: 30, na: 30, compl: 1, rec: (pid === 3 && ts === gapB) ? 1 : 0 });
      });
    }
    return idx;
  }

  /* ------------------------------------------------------------------ simulateur terrain */
  const SIM = { index: {}, incidents: {}, values: {}, cranes: [], clockOffset: { 6: 1.3 }, lastT: now(), rnd: makeRng(Math.floor(Math.random() * 1e9)) };
  function simSetIncident(pid, kind) { if (kind) SIM.incidents[pid] = kind; else delete SIM.incidents[pid]; if (SIM.incidents[pid] === 'coupure') offline.add(pid); else offline.delete(pid); }
  function simStep() {
    const t = now(); const dts = Math.max(0, Math.min(t - SIM.lastT, 5)); SIM.lastT = t;
    const L = lp(t); const hour = L.h + L.mi / 60 + L.s / 3600; const ctx = ST.sim; const inc = SIM.incidents; const rnd = SIM.rnd;
    const vals = POSTES.map(p => {
      let [pk, pf] = usagePower(p, hour, L.wd, ctx, t, false, rnd);
      if (inc[p.id] === 'surcharge') pk = p.souscrite_kw * (1.06 + 0.02 * rnd());
      if (inc[p.id] === 'pf_bas') pf = 0.72 + 0.02 * rnd();
      const v = electrical(p, pk, pf, rnd);
      if (inc[p.id] === 'tension_basse') v.U = 342 + rnd.gauss(0, 2);
      if (inc[p.id] === 'harmoniques') v.THD = 9.6 + rnd.gauss(0, 0.3);
      return v;
    });
    vals.push(headValues(vals, rnd));
    vals.forEach((v0, k) => {
      const pid = k + 1; SIM.index[pid] += v0.P * dts / 3600;
      const v = { ...v0, E: SIM.index[pid], TS: t + (SIM.clockOffset[pid] || 0) + (inc[pid] === 'horloge' ? 40 : 0) };
      if (inc[pid] === 'valeur_invalide') v.PF = 1.73;
      setRegisters(pid, encodeRegisters(DEV_DEFS, v)); SIM.values[pid] = v;
    });
    const working = ctx.navire_conteneurs || ctx.navire_vrac;
    SIM.cranes = [0, 1, 2, 3].map(i => {
      if (i >= ctx.grues_actives) return { grue: `GM-0${i + 1}`, phase: 'Hors service', kw: 0, progress: 0 };
      if (!working) return { grue: `GM-0${i + 1}`, phase: 'En attente navire', kw: CRANE_IDLE, progress: 0 };
      const [n, kw, pr] = cranePhase(i, t); return { grue: `GM-0${i + 1}`, phase: n, kw, progress: Math.round(pr * 100) / 100 };
    });
  }

  /* ------------------------------------------------------------------ moteur d'alertes */
  const ALR = { pending: new Map(), active: new Map() };
  const rule = c => ST.rules.find(r => r.code === c);
  function raiseAlert(r, pointId, postId, equipement, valeur, message, test = 0) {
    const a = { id: ++ST.seq.alert, rule_code: r.code, type: r.type, point_id: pointId, post_id: postId, equipement, ts_detection: now(), valeur, seuil: r.seuil,
      regle: r.libelle, priorite: r.priorite, message, etat: 'nouvelle', condition_active: test ? 0 : 1, ts_fin_condition: null, commentaire: null, test };
    ST.alerts.push(a); addEvent(a.id, "moteur d'alertes", 'DETECTION', message); return a.id;
  }
  function addEvent(alertId, username, action, commentaire) { ST.events.push({ id: ++ST.seq.event, alert_id: alertId, ts: now(), username, action, commentaire }); save(); }
  function endAlert(key) {
    const id = ALR.active.get(key); if (!id) return; ALR.active.delete(key);
    const a = ST.alerts.find(x => x.id === id); if (a) { a.condition_active = 0; a.ts_fin_condition = now(); }
    addEvent(id, "moteur d'alertes", 'FIN_CONDITION', 'Retour à la normale');
  }
  function check(code, pid, cond, clear, value, ctx) {
    const r = rule(code); if (!r) return; const key = code + ':' + pid;
    if (!r.actif) { endAlert(key); return; }
    if (cond) {
      if (!ALR.pending.has(key)) ALR.pending.set(key, now());
      if (!ALR.active.has(key) && now() - ALR.pending.get(key) >= (r.delai_s || 0)) ALR.active.set(key, raiseAlert(r, pid, ctx.post_id, ctx.equipement, value, ctx.message));
    } else { ALR.pending.delete(key); if (ALR.active.has(key) && clear) endAlert(key); }
  }
  function raiseOnce(code, equipement, valeur, message) {
    if (readOnly) return null;
    const r = rule(code); if (!r || !r.actif) return null;
    if (ST.alerts.some(a => a.rule_code === code && a.equipement === equipement && a.message === message && a.etat !== 'cloturee')) return null;
    return raiseAlert(r, null, null, equipement, valeur, message);
  }
  function evaluate(pt, post, rd, st) {
    const pid = pt.id, eqp = pt.equipement, base = { post_id: pt.post_id, equipement: eqp };
    const age = now() - (st.last_ok || now()); const lost = rd.qualite === 'perdue';
    check('R01', pid, lost && st.consec_fail >= 1, !lost, Math.round(age * 10) / 10, { ...base, message: `${eqp} : pas de réponse Modbus depuis ${age.toFixed(0)} s` });
    if (lost) return;
    const bad = rd.qualite === 'invalide';
    check('R02', pid, bad, !bad, null, { ...base, message: `${eqp} : mesure invalide (${rd.motifs.join(' ; ')})` });
    const v = {}; for (const [g, x] of Object.entries(rd.valeurs)) if (x.q === 'valide') v[g] = x.v;
    const hy = 0.03, s = c => (rule(c) || {}).seuil;
    if (post) {
      if (v.P != null) {
        const ch = v.P / post.souscrite_kw * 100, s4 = s('R04') ?? 100, s3 = s('R03') ?? 90;
        check('R04', pid, ch >= s4, ch < s4 * (1 - hy), Math.round(ch * 10) / 10, { ...base, message: `${post.code} : charge ${ch.toFixed(0)} % de la puissance souscrite (${v.P.toFixed(0)} kW / ${post.souscrite_kw} kW)` });
        check('R03', pid, ch >= s3 && ch < s4, ch < s3 * (1 - hy) || ch >= s4, Math.round(ch * 10) / 10, { ...base, message: `${post.code} : charge élevée ${ch.toFixed(0)} % (${v.P.toFixed(0)} kW)` });
      }
      if (v.U != null) {
        const s6 = s('R06') ?? 360, s7 = s('R07') ?? 440;
        check('R06', pid, v.U < s6, v.U > s6 * (1 + hy / 3), Math.round(v.U * 10) / 10, { ...base, message: `${post.code} : tension basse ${v.U.toFixed(0)} V` });
        check('R07', pid, v.U > s7, v.U < s7 * (1 - hy / 3), Math.round(v.U * 10) / 10, { ...base, message: `${post.code} : tension haute ${v.U.toFixed(0)} V` });
      }
    }
    if (v.PF != null) { const s5 = s('R05') ?? 0.85; check('R05', pid, v.PF < s5, v.PF >= s5 + 0.01, Math.round(v.PF * 1000) / 1000, { ...base, message: `${eqp} : facteur de puissance ${v.PF.toFixed(2)}` }); }
    if (v.THD != null) { const s8 = s('R08') ?? 8; check('R08', pid, v.THD > s8, v.THD < s8 * (1 - hy), Math.round(v.THD * 100) / 100, { ...base, message: `${eqp} : THD-U ${v.THD.toFixed(1)} %` }); }
  }

  /* ------------------------------------------------------------------ service d'acquisition */
  const ACQ = { latest: {}, stats: {}, hist: {}, buffers: {}, cycleMs: [], cycleStarts: [], minute: Math.floor(now() / 60) * 60, coherence: null, timer: null };
  function points() {
    return POINTS.map(mp => { const e = ST.equipment.find(x => x.id === mp.equipment_id); return { ...mp, equipement: e.code, unit_id: e.unit_id, profil: e.profil, ip: e.ip, port: e.port, actif: e.actif }; });
  }
  function defsOf(profil) { return ST.defs.filter(d => d.profil === profil).sort((a, b) => a.adresse - b.adresse); }
  function poll(pt) {
    const defs = defsOf(pt.profil); if (!defs.length) return null;
    const start = Math.min(...defs.map(d => d.adresse)), count = Math.max(...defs.map(d => d.adresse)) + 2 - start;
    const t0 = performance.now(); let regs = null, err = null;
    try { regs = readRegisters(pt.unit_id, start, count); } catch (e) { err = `${e.name} : ${e.message}`; }
    const tRec = now();
    if (!regs) return { point_id: pt.id, ts_mesure: null, ts_reception: tRec, valeurs: {}, qualite: 'perdue', motifs: [`pas de réponse (${err})`], latence_ms: null };
    const dec = decodeRegisters(defs, start, regs);
    const h = ACQ.hist[pt.id] || (ACQ.hist[pt.id] = { p: [], lastE: null });
    const [q, motifs, tsM] = classify(dec, tRec, +ST.acq.derive_horloge_max_s, h);
    h.p.push((dec.P || [])[0]); h.p = h.p.slice(-6);
    if ((dec.E || [])[1] === 'valide') h.lastE = dec.E[0];
    const units = Object.fromEntries(defs.map(d => [d.grandeur, d.unite])); const valeurs = {};
    for (const [g, [v, qq]] of Object.entries(dec)) if (g !== 'TS') valeurs[g] = { v, q: qq, u: units[g] || '' };
    const lat = performance.now() - t0 + 0.25 + Math.random() * 0.6;           // + temps réseau simulé
    return { point_id: pt.id, ts_mesure: tsM, ts_reception: tRec, valeurs, qualite: q, motifs, latence_ms: Math.round(lat * 10) / 10 };
  }
  function cycle() {
    const t0 = performance.now(); const ts0 = now(); ACQ.cycleStarts.push(ts0); ACQ.cycleStarts = ACQ.cycleStarts.slice(-60);
    for (const pt of points().filter(p => p.actif)) {
      const st = ACQ.stats[pt.id] || (ACQ.stats[pt.id] = { polls: 0, ok: 0, suspectes: 0, invalides: 0, perdues: 0, consec_fail: 0, next_try: 0, last_ok: null, lat_ms: null, etat: 'initialisation' });
      const post = POST_BY_ID[pt.post_id];
      if (st.consec_fail >= 3 && ts0 < st.next_try) {
        st.etat = 'reconnexion';
        const prev = ACQ.latest[pt.id] || { valeurs: {}, point_id: pt.id };
        evaluate(pt, post, { ...prev, qualite: 'perdue', motifs: [`reconnexion dans ${(st.next_try - ts0).toFixed(0)} s`] }, st); continue;
      }
      let rd = poll(pt); if (!rd) continue;
      st.polls++;
      if (rd.qualite === 'perdue') {
        st.perdues++; st.consec_fail++; st.etat = 'perte de communication';
        if (st.consec_fail >= 3) st.next_try = ts0 + +ST.acq.reconnexion_s;
        const prev = ACQ.latest[pt.id];
        if (prev && prev.ts_mesure) rd = { ...prev, qualite: 'perdue', motifs: rd.motifs, latence_ms: null, ts_tentative: rd.ts_reception };
      } else {
        st.consec_fail = 0; st.ok++; st.last_ok = rd.ts_reception;
        st.lat_ms = st.lat_ms == null ? rd.latence_ms : Math.round((0.8 * st.lat_ms + 0.2 * rd.latence_ms) * 10) / 10;
        if (rd.qualite === 'suspecte') st.suspectes++; if (rd.qualite === 'invalide') st.invalides++;
        st.etat = 'en ligne';
        (ACQ.buffers[pt.id] || (ACQ.buffers[pt.id] = [])).push(rd);
        const key = pt.id + ':' + Math.round(rd.ts_mesure * 1000);
        if (!RAW.some(r => r.key === key)) RAW.push({ key, id: RAW.length ? RAW[RAW.length - 1].id + 1 : 1, point_id: pt.id, ts_mesure: Math.round(rd.ts_mesure * 1000) / 1000, ts_reception: rd.ts_reception,
          valeurs: JSON.stringify(Object.fromEntries(Object.entries(rd.valeurs).map(([g, x]) => [g, [x.v, x.q]]))), qualite: rd.qualite, motif: rd.motifs.join('; ') });
      }
      ACQ.latest[pt.id] = rd; evaluate(pt, post, rd, st);
    }
    const keep = +ST.acq.retention_brut_h * 3600; RAW = RAW.filter(r => r.ts_reception >= ts0 - keep).slice(-4000);
    const m = Math.floor(now() / 60) * 60;
    if (m > ACQ.minute) { aggregate(ACQ.minute); ACQ.minute = m; }
    ACQ.cycleMs.push(performance.now() - t0); ACQ.cycleMs = ACQ.cycleMs.slice(-60);
  }
  function aggregate(minuteTs) {
    const expected = Math.max(1, Math.round(60 / +ST.acq.periode_s)); const sums = {}; const pts = points();
    for (const pt of pts) {
      const arr = AGG[pt.id]; if (arr.length && arr[arr.length - 1].ts >= minuteTs) continue;     // pas de doublon
      const buf = (ACQ.buffers[pt.id] || []).filter(r => r.qualite === 'valide' || r.qualite === 'suspecte'); ACQ.buffers[pt.id] = [];
      let prev = null; for (let k = arr.length - 1; k >= 0; k--) if (arr[k].e_index != null) { prev = arr[k]; break; }
      if (!buf.length) { arr.push({ ts: minuteTs, p: null, pmax: null, q: null, pf: null, u: null, i: null, f: null, thd: null, e_index: null, e_kwh: null, nv: 0, na: expected, compl: 0, rec: 0 }); continue; }
      const avg = g => { const xs = buf.filter(r => r.valeurs[g] && r.valeurs[g].q === 'valide').map(r => r.valeurs[g].v); return xs.length ? xs.reduce((a, b) => a + b) / xs.length : null; };
      const ps = buf.filter(r => r.valeurs.P && r.valeurs.P.q === 'valide').map(r => r.valeurs.P.v);
      const idx = buf.filter(r => r.valeurs.E && r.valeurs.E.q === 'valide').map(r => r.valeurs.E.v);
      const eIndex = idx.length ? idx[idx.length - 1] : null; let ek = null, rec = 0;
      if (eIndex != null && prev) { ek = Math.max(0, eIndex - prev.e_index); rec = minuteTs - prev.ts > 60 ? 1 : 0; }
      const p = avg('P');
      arr.push({ ts: minuteTs, p, pmax: ps.length ? Math.max(...ps) : null, q: avg('Q'), pf: avg('PF'), u: avg('U'), i: avg('I'), f: avg('F'), thd: avg('THD'),
        e_index: eIndex, e_kwh: ek, nv: buf.length, na: expected, compl: Math.min(1, buf.length / expected), rec });
      while (arr.length && arr[0].ts < minuteTs - 7 * 86400) arr.shift();
      sums[pt.id] = p;
    }
    const head = pts.find(p => p.role === 'tete'), incl = pts.filter(p => p.inclus_agregation);
    if (head && sums[head.id] && incl.every(p => sums[p.id])) {
      const s = incl.reduce((a, p) => a + sums[p.id], 0), ec = (sums[head.id] - s) / sums[head.id] * 100, sl = (rule('R11') || {}).seuil ?? 5;
      check('R11', head.id, Math.abs(ec) > sl, Math.abs(ec) <= sl, Math.round(ec * 100) / 100, { post_id: null, equipement: head.equipement, message: `Écart tête/postes ${ec >= 0 ? '+' : ''}${ec.toFixed(1)} % (pertes attendues ≈ 1,2 %)` });
      ACQ.coherence = { ts: minuteTs, tete_kw: sums[head.id], somme_postes_kw: s, ecart_pct: ec };
    }
  }
  function startAcq() {
    clearTimeout(ACQ.timer);
    const loop = () => { try { cycle(); } catch (e) { console.error('acquisition', e); } ACQ.timer = setTimeout(loop, +ST.acq.periode_s * 1000); };
    loop();
  }

  /* ------------------------------------------------------------------ métier énergétique */
  function solve(a, b) {
    const n = b.length; const m = a.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      if (Math.abs(m[piv][c]) < 1e-12) throw new Error('système singulier (variables colinéaires ?)');
      [m[c], m[piv]] = [m[piv], m[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = m[r][c] / m[c][c]; m[r] = m[r].map((x, k) => x - f * m[c][k]); }
    }
    return m.map((r, i) => r[n] / r[i]);
  }
  function ols(xs, ys) {
    const rows = xs.map(x => [1, ...x]); const k = rows[0].length;
    const xtx = [...Array(k)].map((_, i) => [...Array(k)].map((__, j) => rows.reduce((a, r) => a + r[i] * r[j], 0)));
    const xty = [...Array(k)].map((_, i) => rows.reduce((a, r, n) => a + r[i] * ys[n], 0));
    const beta = solve(xtx, xty); const pred = rows.map(r => r.reduce((a, v, i) => a + v * beta[i], 0));
    const mean = ys.reduce((a, b) => a + b) / ys.length; const ssr = ys.reduce((a, y, i) => a + (y - pred[i]) ** 2, 0);
    const sst = ys.reduce((a, y) => a + (y - mean) ** 2, 0) || 1e-9;
    return [beta, 1 - ssr / sst, Math.sqrt(ssr / Math.max(1, ys.length - k)) / mean * 100];
  }
  function tarifPeriod(h, t) {
    if (h >= t.pointe[0] && h < t.pointe[1]) return 'pointe';
    const [c1, c2] = t.creuses; const cr = c1 > c2 ? (h >= c1 || h < c2) : (h >= c1 && h < c2);
    return cr ? 'creuses' : 'pleines';
  }
  function energySince(t1, t2 = now()) {
    const t = ST.tarif; const byPoint = {}, byPer = { pointe: 0, pleines: 0, creuses: 0 }, byHour = Array(24).fill(0);
    const L0 = lp(t1);
    for (const pt of POINTS.filter(p => p.inclus_agregation)) for (const r of AGG[pt.id]) {
      if (r.ts < t1 || r.ts >= t2 || r.e_kwh == null) continue;
      const h = Math.floor(((r.ts + L0.offset) % 86400 + 86400) % 86400 / 3600);
      byPoint[pt.id] = (byPoint[pt.id] || 0) + r.e_kwh; byPer[tarifPeriod(h, t)] += r.e_kwh; byHour[h] += r.e_kwh;
    }
    const total = Object.values(byPoint).reduce((a, b) => a + b, 0);
    return { total_kwh: total, par_point: byPoint, par_periode: byPer, par_heure: byHour, devise: t.devise,
      cout: Object.entries(byPer).reduce((a, [k, v]) => a + v * t['prix_' + k], 0), co2_t: total * t.co2_kg_kwh / 1000 };
  }
  function midnight() { const t = now(); const L = lp(t); return Math.floor(t) - (L.h * 3600 + L.mi * 60 + L.s); }
  const lastCompleteMonth = () => { const r = MONTHLY.filter(m => !m.en_cours); return r.length ? r[r.length - 1].mois : null; };
  function computeIPE(raise = true) {
    const seuil = (rule('R09') || {}).seuil ?? 5;
    return ST.ipe.map(d => {
      const serie = MONTHLY.map(m => {
        const num = d.num === 'total' ? m.total : m[d.num], den = m[d.den];
        return { mois: m.mois, valeur: (num != null && den) ? num / den : null, numerateur: num, denominateur: den, en_cours: m.en_cours, completude: m.en_cours ? Math.round(m.jours / 30.4 * 100) / 100 : 1 };
      });
      const ref = serie.filter(s => s.mois.startsWith('2025') && s.valeur != null).map(s => s.valeur);
      const comp = serie.filter(s => !s.en_cours && s.valeur != null); const last = comp[comp.length - 1] || null;
      const ecart = last && d.cible ? (last.valeur - d.cible) / d.cible * 100 : null;
      let statut = null;
      if (ecart != null) {
        statut = ecart <= 0 ? 'conforme' : ecart <= seuil ? 'à surveiller' : 'dérive';
        if (statut === 'dérive' && raise) raiseOnce('R09', d.code, Math.round(ecart * 10) / 10, `${d.code} ${last.mois} : ${last.valeur.toFixed(2)} ${d.unite} — écart ${ecart >= 0 ? '+' : ''}${ecart.toFixed(1)} % à la cible ${d.cible}`);
      }
      return { ...d, serie, reference_2025: ref.length ? ref.reduce((a, b) => a + b) / ref.length : null, dernier: last, ecart_pct: ecart, statut };
    });
  }
  const VARIABLES = { evp: 'EVP manutentionnés', tonnes_vrac: 'Tonnes vrac', reefer_jours: 'Conteneurs-jour reefer', escales: 'Escales', heures_grue: 'Heures de grue' };
  function monthsBetween(a, b) { return MONTHLY.map(m => m.mois).filter(m => m >= a && m <= b); }
  function createBaseline(username, debut, fin, variables, motif, hypotheses) {
    const tab = Object.fromEntries(MONTHLY.map(m => [m.mois, m]));
    const months = monthsBetween(debut, fin).filter(m => !tab[m].en_cours);
    if (months.length < variables.length + 3) throw new Error('période de référence trop courte pour le nombre de variables');
    const [beta, r2, cv] = ols(months.map(mk => variables.map(v => tab[mk][v] / tab[mk].jours)), months.map(mk => tab[mk].total / tab[mk].jours));
    const version = Math.max(0, ...ST.baselines.map(b => b.version)) + 1;
    ST.baselines.forEach(b => { b.active = 0; });
    const b = { id: ++ST.seq.base, version, libelle: `SER v${version} — ${debut} → ${fin}`, periode_debut: debut, periode_fin: fin, variables, coefficients: beta, r2, cv_rmse: cv,
      n: months.length, hypotheses, motif, cree_par: username, cree_le: now(), active: 1 };
    ST.baselines.push(b);
    audit('SER_CREATION', `SER v${version}`, null, { periode: [debut, fin], variables, r2: Math.round(r2 * 10000) / 10000, motif }, username);
    return b.id;
  }
  function ser(raise = true) {
    const base = ST.baselines.filter(b => b.active).sort((a, b) => b.version - a.version)[0];
    const versions = ST.baselines.slice().sort((a, b) => b.version - a.version).map(v => ({ ...v }));
    if (!base) return { active: null, versions, serie: [] };
    const sl = (rule('R10') || {}).seuil ?? 5; let cusum = 0; const serie = [];
    for (const m of MONTHLY) {
      const pred = m.jours * (base.coefficients[0] + base.variables.reduce((a, v, i) => a + base.coefficients[i + 1] * m[v] / m.jours, 0));
      const ec = m.total - pred; const inRef = m.mois >= base.periode_debut && m.mois <= base.periode_fin;
      if (m.mois > base.periode_fin) cusum += ec;
      serie.push({ mois: m.mois, observe: m.total, predit: pred, ecart_kwh: ec, ecart_pct: ec / pred * 100, reference: inRef, en_cours: m.en_cours, cusum: m.mois > base.periode_fin ? cusum : null });
    }
    const post = serie.filter(s => s.mois > base.periode_fin && !s.en_cours);
    if (raise && post.length && Math.abs(post[post.length - 1].ecart_pct) > sl) {
      const l = post[post.length - 1]; raiseOnce('R10', 'SER', Math.round(l.ecart_pct * 10) / 10, `SER ${l.mois} : écart ${l.ecart_pct >= 0 ? '+' : ''}${l.ecart_pct.toFixed(1)} % à la référence`);
    }
    return { active: { ...base, libelles: Object.fromEntries(base.variables.map(v => [v, VARIABLES[v] || v])) }, versions, serie, economie_cumulee_kwh: -cusum, variables_disponibles: VARIABLES };
  }
  function reportData(mois, raise = true) {
    const tab = Object.fromEntries(MONTHLY.map(m => [m.mois, m])); const m = tab[mois];
    if (!m) throw Object.assign(new Error('mois indisponible'), { status: 404 });
    const prevY = `${+mois.slice(0, 4) - 1}${mois.slice(4)}`;
    const ipes = computeIPE(raise); const s = ser(raise);
    const [y, mm] = mois.split('-').map(Number); const t1 = localTs(y, mm, 1), t2 = localTs(mm === 12 ? y + 1 : y, mm === 12 ? 1 : mm + 1, 1);
    const grp = {};
    for (const a of ST.alerts) if (!a.test && a.ts_detection >= t1 && a.ts_detection < t2) { const k = a.rule_code + '|' + a.priorite; grp[k] = (grp[k] || 0) + 1; }
    const qual = [];
    for (const pt of POINTS) { const rows = AGG[pt.id].filter(r => r.ts >= t1 && r.ts < t2); if (rows.length) qual.push({ point_id: pt.id, minutes: rows.length, completude: rows.reduce((a, r) => a + r.compl, 0) / rows.length, reconst: rows.reduce((a, r) => a + r.rec, 0) }); }
    return { mois, client: CLIENT, activite: { jours: m.jours, evp: m.evp, tonnes_vrac: m.tonnes_vrac, escales: m.escales, heures_grue: m.heures_grue, reefer_jours: m.reefer_jours },
      en_cours: m.en_cours, total_kwh: m.total, total_kwh_n1: (tab[prevY] || {}).total, co2_t: m.total * ST.tarif.co2_kg_kwh / 1000,
      consommations: POSTES.map(p => ({ code: p.code, libelle: p.libelle, kwh: m[p.usage], kwh_n1: (tab[prevY] || {})[p.usage], souscrite_kw: p.souscrite_kw })),
      ipe: ipes.map(i => { const x = i.serie.find(z => z.mois === mois); return x && { code: i.code, libelle: i.libelle, unite: i.unite, formule: i.formule, valeur: x.valeur, cible: i.cible, reference: i.reference_2025, statut_validation: i.statut_validation }; }).filter(Boolean),
      ser: s.serie.find(z => z.mois === mois) || null, ser_modele: s.active,
      alertes: Object.entries(grp).sort().map(([k, n]) => { const [rule_code, priorite] = k.split('|'); return { rule_code, priorite, n }; }),
      qualite: qual, source: m.source, tarif_note: ST.tarif.note, session: ST.session };
  }

  /* ------------------------------------------------------------------ recette T01 → T15 */
  const TESTS = [['T01', 'Connectivité Modbus TCP/IP', 'Le compteur configuré répond selon ses spécifications.'], ['T02', 'Vérification des registres', 'Valeurs, unités, signes et facteurs d\'échelle vérifiés sur un échantillon.'],
    ['T03', 'Horodatage', 'La mesure et sa date de réception sont enregistrées correctement.'], ['T04', 'Perte de communication', "L'incident est visible et signalé conformément à la règle configurée."],
    ['T05', 'Reprise après coupure', 'La collecte reprend sans duplication non maîtrisée.'], ['T06', 'Tableau de bord', 'Les données du poste et du compteur sont consultables.'],
    ['T07', 'Historique', 'La recherche par période renvoie les mesures disponibles.'], ['T08', 'Calcul énergétique', 'Les résultats sont conformes aux formules et jeux d\'essai validés.'],
    ['T09', 'IPE et SER', 'Les calculs et comparaisons sont traçables et vérifiables.'], ['T10', 'Alertes', 'Une règle de test génère une alerte et son historique.'],
    ['T11', 'Reporting', 'Le rapport présente le périmètre, la période, les unités et les indicateurs validés.'], ['T12', 'Intégration existante', 'Les points existants sont intégrés sans double comptage.'],
    ['T13', 'Habilitations', 'Un utilisateur ne peut pas exécuter une action non autorisée.'], ['T14', 'Sauvegarde/restauration', 'La procédure est documentée et le test de restauration est concluant.'],
    ['T15', 'Formation', 'Les exploitants réalisent les opérations principales après formation.']];
  const REC = { en_cours: false, progression: 0, etape: '', resultats: [], ts: null };
  function res(code, ok, mesure, preuve, statut) {
    const t = TESTS.find(x => x[0] === code);
    REC.resultats.push({ id: code, test: t[1], attendu: t[2], statut: statut || (ok ? 'conforme' : 'non conforme'), mesure, preuve });
    REC.progression = Math.round(REC.resultats.length / TESTS.length * 100);
  }
  const fx = (v, d = 1) => Number(v).toFixed(d);
  async function runRecette(username) {
    Object.assign(REC, { en_cours: true, progression: 0, etape: 'Démarrage', resultats: [], ts: now(), par: username });
    try {
      REC.etape = 'T01 — interrogation des compteurs';
      const eqs = ST.equipment.filter(e => e.actif); let ok = 0; const lat = [], fails = [];
      for (const e of eqs) { const t0 = performance.now(); try { readRegisters(e.unit_id, 3000, 20); ok++; lat.push(performance.now() - t0 + 0.3); } catch (x) { fails.push(`${e.code} (${x.name})`); } }
      res('T01', ok === eqs.length, `${ok}/${eqs.length} compteurs répondent — latence moy. ${fx(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length))} ms`,
        'Lecture FC03 de 20 registres à partir de 3000 sur chaque Unit ID (trames MBAP encodées/décodées)' + (fails.length ? ` ; échecs : ${fails.join(', ')}` : ''));
      await sleep(300);
      REC.etape = 'T02 — cohérence registres / unités / échelles';
      const errs = []; let n2 = 0;
      for (const e of eqs) {
        const defs = defsOf(e.profil); const start = Math.min(...defs.map(d => d.adresse));
        let regs; try { regs = readRegisters(e.unit_id, start, Math.max(...defs.map(d => d.adresse)) + 2 - start); } catch { errs.push(`${e.code} : illisible`); continue; }
        const v = decodeRegisters(defs, start, regs); n2++;
        if (Object.values(v).some(x => x[1] !== 'valide')) errs.push(`${e.code} : grandeur hors plage`);
        if (v.P[0] != null && v.S[0] && v.PF[0] && Math.abs(v.P[0] - v.S[0] * v.PF[0]) / Math.max(v.S[0], 1) > 0.02) errs.push(`${e.code} : P ≠ S·PF`);
        if (v.P[0] < 0) errs.push(`${e.code} : signe P négatif`);
        if (Math.abs(v.E[0] - SIM.index[e.unit_id]) > 5) errs.push(`${e.code} : échelle index énergie`);
      }
      const rt = Math.abs(wordsF32(...f32words(1234.5)) - 1234.5) < 1e-9 && wordsU32(...u32words(4000000001)) === 4000000001;
      res('T02', !errs.length && rt, `${n2} compteurs contrôlés, ${errs.length} anomalie(s)`, 'Contrôles : plages min/max, P = S·PF (±2 %), signe de P, index × 0,1 kWh vs compteur, aller-retour float32/uint32' + (errs.length ? ' ; ' + errs.join(' ; ') : ''));
      REC.etape = 'T03 — double horodatage';
      const rows = RAW.slice(-70); const skew = rows.map(r => Math.abs(r.ts_reception - r.ts_mesure)); const mx = skew.length ? Math.max(...skew) : null;
      res('T03', rows.length && mx <= ST.acq.derive_horloge_max_s, rows.length ? `${rows.length} mesures brutes avec horodatage mesure + réception ; écart max ${fx(mx, 2)} s` : 'aucune mesure',
        `ts_mesure = registre TS du compteur, ts_reception = horloge du serveur d'acquisition ; tolérance ${ST.acq.derive_horloge_max_s} s`);
      REC.etape = 'T04 — coupure de communication simulée sur P2';
      const r1 = rule('R01'); const tCut = now(); simSetIncident(2, 'coupure'); let al = null;
      while (now() - tCut < (r1.delai_s || 6) + 12) { await sleep(500); al = ST.alerts.find(a => a.rule_code === 'R01' && a.point_id === 2 && a.ts_detection >= tCut); if (al) break; }
      const vis = (ACQ.latest[2] || {}).qualite === 'perdue';
      res('T04', !!al && vis, al ? `Alerte R01 #${al.id} levée ${fx(al.ts_detection - tCut)} s après la coupure (délai règle ${r1.delai_s} s)` : 'Aucune alerte',
        'Incident « coupure » injecté sur CPT-P2 ; état « perdue » visible dans le tableau de bord');
      REC.etape = 'T05 — reprise après coupure';
      simSetIncident(2, null); const tBack = now(); let back = null;
      while (now() - tBack < +ST.acq.reconnexion_s + 10) { await sleep(500); const st = ACQ.stats[2] || {}; if (st.consec_fail === 0 && (st.last_ok || 0) > tBack) { back = st.last_ok - tBack; break; } }
      const dupR = RAW.length - new Set(RAW.map(r => r.key)).size; let dupA = 0; for (const p of POINTS) dupA += AGG[p.id].length - new Set(AGG[p.id].map(r => r.ts)).size;
      res('T05', back != null && !dupR && !dupA, back != null ? `Reprise en ${fx(back)} s ; doublons brut = ${dupR}, agrégé = ${dupA}` : 'Pas de reprise',
        "Clés uniques (point, horodatage) ; l'énergie de la lacune est reconstituée par différence d'index (agrégats marqués « reconstitué »)");
      REC.etape = 'T06 — tableau de bord';
      const fresh = Object.values(ACQ.latest).filter(r => r.ts_reception && now() - r.ts_reception < 10 && r.qualite !== 'perdue').length;
      res('T06', fresh >= eqs.length, `${fresh}/${eqs.length} points avec mesure fraîche (< 10 s)`, 'Valeurs, unités, qualité et âge de la mesure par point de comptage');
      REC.etape = 'T07 — historique';
      const since = now() - 86400; const h1 = AGG[1].filter(r => r.ts >= since);
      res('T07', h1.length >= 1380, `${h1.length} minutes trouvées sur 24 h pour P1 (${h1.filter(r => r.nv > 0).length} avec données)`, 'Recherche par période et par point sur les agrégats 1 min');
      REC.etape = 'T08 — calculs énergétiques';
      const h6 = AGG[1].filter(r => r.ts >= now() - 6 * 3600 && r.p != null && r.e_kwh != null);
      const eI = h6.reduce((a, r) => a + r.e_kwh, 0), eP = h6.reduce((a, r) => a + r.p / 60, 0), ec = Math.abs(eI - eP) / Math.max(eP, 1) * 100;
      const jeu = [3, 9, 18, 23].map(x => tarifPeriod(x, { pointe: [17, 22], creuses: [22, 7] })).join() === 'creuses,pleines,pointe,creuses';
      const [bt] = ols([[1], [2], [3], [4]], [3, 5, 7, 9]); const jeu2 = Math.abs(bt[0] - 1) < 1e-9 && Math.abs(bt[1] - 2) < 1e-9;
      res('T08', ec < 3 && jeu && jeu2, `Énergie 6 h P1 : index ${fx(eI, 0)} kWh vs ∫P·dt ${fx(eP, 0)} kWh (écart ${fx(ec, 2)} %)`, 'Jeux d\'essai : périodes tarifaires (3 h, 9 h, 18 h, 23 h) et régression y = 1 + 2x vérifiés');
      REC.etape = 'T09 — IPE et SER';
      const ipes = computeIPE(); const mois = lastCompleteMonth(); const row = MONTHLY.find(m => m.mois === mois);
      const man = row.conteneurs / row.evp, sto = ipes[0].serie.find(s => s.mois === mois).valeur; const S2 = ser(); const a = S2.active;
      res('T09', Math.abs(man - sto) < 1e-9 && a && a.r2 >= 0.75, `IPE-01 ${mois} recalculé = ${fx(man, 3)} (calculé ${fx(sto, 3)}) ; SER v${a.version} R² = ${fx(a.r2, 3)}, CV(RMSE) = ${fx(a.cv_rmse, 2)} %`,
        `Formule « ${ipes[0].formule} » ; SER : période ${a.periode_debut}→${a.periode_fin}, variables ${a.variables.join(', ')}, coefficients et version historisés`);
      REC.etape = 'T10 — alerte de test';
      const aid = raiseAlert({ code: 'TEST', type: 'TEST', seuil: null, libelle: 'Règle de test (recette T10)', priorite: 'mineure' }, null, null, 'Recette', null, 'Alerte de test générée par la recette', 1);
      const at = ST.alerts.find(x => x.id === aid); at.etat = 'cloturee'; addEvent(aid, username, 'CLOTURE', "Clôture automatique en fin d'essai T10");
      res('T10', true, `Alerte #${aid} créée ; historique : ${ST.events.filter(e => e.alert_id === aid).map(e => e.action).join(' → ')}`, 'Alerte + journal des actions (alert_events)');
      REC.etape = 'T11 — rapport';
      const rep = reportData(mois);
      res('T11', rep.consommations.length && rep.ipe.length && rep.ser, `Rapport ${mois} : ${rep.consommations.length} postes, ${rep.ipe.length} IPE, SER, unités kWh`, 'Rapport mensuel A4 : périmètre, période, unités, IPE, SER, alertes, qualité des données');
      REC.etape = 'T12 — intégration du point existant';
      let coh = ACQ.coherence; const head = POINTS.find(p => p.role === 'tete');
      if (!coh) { const pv = Object.fromEntries(Object.entries(ACQ.latest).map(([k, r]) => [k, ((r.valeurs || {}).P || {}).v])); const s = [1, 2, 3, 4, 5, 6].reduce((x, i) => x + (pv[i] || 0), 0); if (pv[7]) coh = { tete_kw: pv[7], somme_postes_kw: s, ecart_pct: (pv[7] - s) / pv[7] * 100 }; }
      res('T12', head.inclus_agregation === 0 && coh && Math.abs(coh.ecart_pct) < 5, coh ? `Compteur de tête exclu des agrégations ; tête ${fx(coh.tete_kw, 0)} kW vs Σ postes ${fx(coh.somme_postes_kw, 0)} kW (écart ${coh.ecart_pct >= 0 ? '+' : ''}${fx(coh.ecart_pct, 2)} %)` : 'Cohérence non calculée',
        'Point PC-TETE (existant) : rôle « tête », exclu des sommes ; contrôle R11');
      REC.etape = 'T13 — habilitations';
      const before = rule('R03').seuil; let code13 = 200, msg13 = '';
      try { await request('PUT', '/api/rules/R03', { seuil: 1 }, 'lecteur'); } catch (x) { code13 = x.status; msg13 = x.message; }
      res('T13', code13 === 403 && rule('R03').seuil === before, `Requête « modifier les seuils » avec le rôle Lecteur → HTTP ${code13}`, `Réponse : ${msg13} ; seuil inchangé : ${rule('R03').seuil === before ? 'oui' : 'NON'} ; tentative journalisée (ACCES_REFUSE)`);
      REC.etape = 'T14 — sauvegarde et restauration';
      const snap = makeBackup(username); const restored = JSON.parse(snap.data);
      const okb = restored.v === 1 && restored.equipment.length === ST.equipment.length && restored.rules.length === ST.rules.length;
      res('T14', okb, `Instantané ${snap.nom} — relu et vérifié ; ${restored.alerts.length} alertes, ${restored.audit.length} lignes d'audit`, 'Sérialisation JSON de la configuration et des journaux, relecture et contrôle des comptages');
      res('T15', false, 'Essai manuel', 'Hors application : à réaliser avec les exploitants (feuille de présence, mise en situation).', 'manuel');
    } catch (e) {
      console.error(e); const done = REC.resultats.map(r => r.id); const nx = TESTS.find(t => !done.includes(t[0]));
      if (nx) res(nx[0], false, "Erreur d'exécution", String(e));
    } finally {
      simSetIncident(2, null);
      const conf = REC.resultats.filter(r => r.statut === 'conforme').length;
      ST.runs.push({ id: ++ST.seq.run, ts: now(), username, resultats: clone(REC.resultats), conformes: conf, total: REC.resultats.length }); ST.runs = ST.runs.slice(-10);
      audit('RECETTE', 'plan de tests T01-T15', null, { conformes: conf, total: REC.resultats.length }, username);
      Object.assign(REC, { en_cours: false, etape: 'Terminé', progression: 100 });
    }
  }
  function makeBackup(username) {
    const data = JSON.stringify({ ...ST, backups: [] });
    const nom = 'sme_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.json';
    ST.backups.push({ nom, ts: now(), taille_ko: Math.round(data.length / 1024) }); ST.backups = ST.backups.slice(-10);
    audit('SAUVEGARDE', nom, null, { taille_ko: Math.round(data.length / 1024) }, username);
    return { nom, data };
  }

  /* ------------------------------------------------------------------ API locale */
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const routes = [];
  const route = (method, pattern, perm, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), perm, fn });
  let roleOverride = null;
  function currentRole() { return roleOverride || ST.session.role; }
  async function request(method, path, body, asRole) {
    const [p, qs] = path.split('?'); const q = Object.fromEntries(new URLSearchParams(qs || ''));
    for (const r of routes) {
      if (r.method !== method) continue; const m = p.match(r.re); if (!m) continue;
      const role = asRole || ST.session.role;
      if (r.perm && !PERMS[role].includes(r.perm)) {
        audit('ACCES_REFUSE', p, null, { permission: r.perm, role }, asRole ? 'recette_lecteur' : undefined);
        throw new HttpError(403, `action non autorisée pour le rôle « ${role} »`);
      }
      const out = await r.fn({ params: m.groups || {}, q, body: body || {} });
      return clone(out === undefined ? { ok: true } : out);
    }
    throw new HttpError(404, 'ressource introuvable : ' + p);
  }
  const who = () => ST.session.username;
  const num = (v, name) => { const x = Number(v); if (v === '' || v == null || Number.isNaN(x)) throw new HttpError(400, `${name} invalide`); return x; };

  route('GET', '/api/meta', null, () => ({ client: CLIENT, user: { ...ST.session, permissions: PERMS[ST.session.role].slice().sort() }, roles: ROLES, posts: POSTES,
    points: points().map(p => { const e = ST.equipment.find(x => x.id === p.equipment_id); return { ...p, fabricant: e.fabricant, modele: e.modele, existant: e.existant }; }),
    incidents: INCIDENTS, acquisition: ST.acq, tarif: ST.tarif, tz: TZ, users: ST.users.filter(u => u.actif) }));
  route('PUT', '/api/session', null, ({ body }) => {
    const u = ST.users.find(x => x.username === body.username && x.actif) || ST.users.find(x => x.role === body.role && x.actif);
    if (!u) throw new HttpError(400, 'profil inconnu');
    ST.session = { username: u.username, fullname: u.fullname, role: u.role }; u.derniere_connexion = now();
    audit('CONNEXION', 'changement de profil', null, { role: u.role }, u.username);
  });
  function freshness(rd) {
    if (!rd || !rd.ts_mesure) return ['absente', null];
    const c = ST.acq; const age = rd.qualite === 'perdue' ? now() - rd.ts_mesure : now() - rd.ts_reception;
    if (rd.qualite === 'perdue') return [age < c.peremption_s ? 'ancienne' : 'périmée', age];
    return [age <= c.fraicheur_s ? 'fraîche' : age < c.peremption_s ? 'ancienne' : 'périmée', age];
  }
  route('GET', '/api/live', null, () => {
    const pts = points().map(p => {
      const rd = ACQ.latest[p.id] || {}; const [fr, age] = freshness(rd); const st = ACQ.stats[p.id] || {};
      return { point_id: p.id, post_id: p.post_id, role: p.role, equipement: p.equipement, valeurs: rd.valeurs || {}, qualite: rd.qualite || 'absente', motifs: rd.motifs || [],
        ts_mesure: rd.ts_mesure, ts_reception: rd.ts_reception, fraicheur: fr, age_s: age == null ? null : Math.round(age * 10) / 10, latence_ms: rd.latence_ms,
        etat_comm: st.etat, incident: SIM.incidents[p.id] || null };
    });
    const grp = {}; for (const a of ST.alerts) if (a.etat !== 'cloturee' && !a.test) grp[a.priorite] = (grp[a.priorite] || 0) + 1;
    const cs = ACQ.cycleStarts; const per = cs.length > 1 ? (cs[cs.length - 1] - cs[0]) / (cs.length - 1) : null;
    const dispo = Object.values(ACQ.stats).filter(s => s.polls).map(s => s.ok / s.polls);
    return { ts: now(), points: pts, total_kw: pts.filter(x => x.role === 'poste').reduce((a, x) => a + ((x.valeurs.P || {}).v || 0), 0),
      alertes: Object.entries(grp).map(([priorite, n]) => ({ priorite, n })),
      acquisition: { periode_cible_s: ST.acq.periode_s, periode_mesuree_s: per, disponibilite: dispo.length ? dispo.reduce((a, b) => a + b) / dispo.length : null, coherence: ACQ.coherence },
      simulation: { ctx: ST.sim, grues: SIM.cranes, incidents: SIM.incidents } };
  });
  const GR = { p_moy: ['p', 'P moy (kW)'], p_max: ['pmax', 'P max (kW)'], q_moy: ['q', 'Q (kvar)'], pf_moy: ['pf', 'Facteur de puissance'], u_moy: ['u', 'Tension (V)'],
    i_moy: ['i', 'Courant (A)'], f_moy: ['f', 'Fréquence (Hz)'], thd_moy: ['thd', 'THD-U (%)'], e_kwh: ['e_kwh', 'Énergie (kWh)'], completude: ['compl', 'Complétude'] };
  function histParams(q) {
    const t2 = Math.floor(+(q.to || now())), t1 = Math.floor(+(q.from || t2 - 86400));
    const pts = (q.points || '1,2,3,4,5,6').split(',').map(Number).filter(x => x >= 1 && x <= 7);
    const g = q.grandeur || 'p_moy'; if (!GR[g]) throw new HttpError(400, 'grandeur inconnue');
    return [t1, t2, pts, g];
  }
  route('GET', '/api/history', null, ({ q }) => {
    const [t1, t2, pts, g] = histParams(q); const span = t2 - t1;
    const pas = +(q.pas || (span <= 6 * 3600 ? 60 : span <= 2 * 86400 ? 300 : 900)); const [f] = GR[g]; const series = {};
    for (const pid of pts) {
      const b = new Map();
      for (const r of AGG[pid]) {
        if (r.ts < t1 || r.ts >= t2) continue; const k = Math.floor(r.ts / pas) * pas;
        let o = b.get(k); if (!o) { o = { s: 0, n: 0, mx: null, nv: 0, na: 0, rec: 0 }; b.set(k, o); }
        const v = r[f]; if (v != null) { o.s += v; o.n++; o.mx = o.mx == null ? v : Math.max(o.mx, v); }
        o.nv += r.nv; o.na += r.na; o.rec = Math.max(o.rec, r.rec);
      }
      series[pid] = [...b.entries()].sort((a, c) => a[0] - c[0]).map(([k, o]) => [k, o.n ? (g === 'e_kwh' ? o.s : g === 'p_max' ? o.mx : o.s / o.n) : null, Math.round(o.nv / (o.na || 1) * 1000) / 1000, o.rec]);
    }
    return { grandeur: g, libelle: GR[g][1], pas, series, t1, t2 };
  });
  route('GET', '/api/energy/today', null, () => energySince(midnight()));
  route('GET', '/api/patrimoine', null, () => {
    const defs = {}; for (const d of ST.defs.slice().sort((a, b) => a.profil.localeCompare(b.profil) || a.adresse - b.adresse)) (defs[d.profil] = defs[d.profil] || []).push(d);
    return { sites: [{ id: 1, code: 'AGA', libelle: "Port d'Agadir — DEPA", emplacement: 'Agadir, Maroc', etat: 'en service' }], posts: POSTES, equipment: ST.equipment, points: POINTS, definitions: defs, stats: ACQ.stats };
  });
  route('GET', '/api/ipe', null, () => ({ indicateurs: computeIPE(!readOnly), historique: ST.audit.filter(a => a.action === 'IPE_MODIFICATION').slice().reverse().slice(0, 30) }));
  route('GET', '/api/ser', null, () => ser(!readOnly));
  route('GET', '/api/alerts', null, ({ q }) => {
    const etat = q.etat || 'ouvertes', lim = Math.min(+(q.limit || 200), 1000);
    const ord = { nouvelle: 0, prise_en_charge: 1, cloturee: 2 };
    const rows = ST.alerts.filter(a => etat === 'ouvertes' ? a.etat !== 'cloturee' : etat === 'toutes' ? true : a.etat === etat)
      .sort((a, b) => ord[a.etat] - ord[b.etat] || b.ts_detection - a.ts_detection).slice(0, lim)
      .map(a => ({ ...a, post_code: a.post_id ? POST_BY_ID[a.post_id].code : null }));
    const st = {}; for (const a of ST.alerts) if (!a.test) { const k = a.etat + '|' + a.priorite; st[k] = (st[k] || 0) + 1; }
    return { alertes: rows, stats: Object.entries(st).map(([k, n]) => { const [e, p] = k.split('|'); return { etat: e, priorite: p, n }; }) };
  });
  route('GET', '/api/alerts/:id', null, ({ params }) => {
    const a = ST.alerts.find(x => x.id === +params.id); if (!a) throw new HttpError(404, 'alerte introuvable');
    return { alerte: a, evenements: ST.events.filter(e => e.alert_id === a.id) };
  });
  route('POST', '/api/alerts/:id/action', 'alert.handle', ({ params, body }) => {
    const a = ST.alerts.find(x => x.id === +params.id); if (!a) throw new HttpError(404, 'alerte introuvable');
    const com = String(body.commentaire || '').trim().slice(0, 500); let label;
    if (a.etat === 'cloturee') throw new HttpError(409, 'alerte déjà clôturée');
    if (body.action === 'prendre') { a.etat = 'prise_en_charge'; label = 'PRISE_EN_CHARGE'; }
    else if (body.action === 'commenter') { if (!com) throw new HttpError(400, 'commentaire vide'); label = 'COMMENTAIRE'; }
    else if (body.action === 'cloturer') {
      if (!com) throw new HttpError(400, 'un commentaire (action corrective) est obligatoire pour clôturer');
      if (a.condition_active) throw new HttpError(409, 'la condition est toujours active : clôture impossible tant que le défaut persiste');
      a.etat = 'cloturee'; a.commentaire = com; label = 'CLOTURE';
    } else throw new HttpError(400, 'action inconnue');
    addEvent(a.id, who(), label, com); audit('ALERTE_' + label, `alerte #${a.id}`, null, { commentaire: com });
  });
  route('GET', '/api/rules', null, () => ST.rules);
  route('PUT', '/api/rules/:code', 'config.seuils', ({ params, body }) => {
    const r = rule(params.code); if (!r) throw new HttpError(404, 'règle introuvable');
    const nw = { seuil: body.seuil ?? r.seuil, priorite: body.priorite ?? r.priorite, delai_s: body.delai_s ?? r.delai_s, actif: (body.actif ?? r.actif) ? 1 : 0 };
    if (!['critique', 'majeure', 'mineure'].includes(nw.priorite)) throw new HttpError(400, 'priorité invalide');
    nw.seuil = nw.seuil === '' || nw.seuil == null ? null : num(nw.seuil, 'seuil'); nw.delai_s = num(nw.delai_s || 0, 'délai');
    const av = { seuil: r.seuil, priorite: r.priorite, delai_s: r.delai_s, actif: r.actif }; Object.assign(r, nw);
    audit('REGLE_MODIFICATION', r.code, av, nw);
  });
  route('PUT', '/api/ipe/:code', 'config.ipe', ({ params, body }) => {
    const d = ST.ipe.find(x => x.code === params.code); if (!d) throw new HttpError(404, 'IPE introuvable');
    const cible = num(body.cible ?? d.cible, 'cible'); const motif = String(body.motif || '').trim();
    if (!motif) throw new HttpError(400, 'le motif de modification est obligatoire (traçabilité)');
    const av = { cible: d.cible, version: d.version };
    Object.assign(d, { cible, description: String(body.description || d.description).slice(0, 500), version: d.version + 1, date_effet: new Date().toISOString().slice(0, 10) });
    audit('IPE_MODIFICATION', d.code, av, { cible, version: d.version, motif });
  });
  route('POST', '/api/ser', 'config.ser', ({ body }) => {
    const vars = (body.variables || []).filter(v => VARIABLES[v]); const motif = String(body.motif || '').trim();
    if (!vars.length || !motif) throw new HttpError(400, 'variables et motif obligatoires');
    try { return { ok: true, id: createBaseline(who(), body.debut || '2025-01', body.fin || '2025-12', vars, motif, String(body.hypotheses || '').slice(0, 1000)) }; }
    catch (e) { throw new HttpError(400, e.message); }
  });
  route('POST', '/api/ser/:id/activer', 'config.ser', ({ params, body }) => {
    if (!ST.baselines.some(b => b.id === +params.id)) throw new HttpError(404, 'SER introuvable');
    ST.baselines.forEach(b => { b.active = b.id === +params.id ? 1 : 0; }); audit('SER_ACTIVATION', `SER id ${params.id}`, null, { motif: body.motif || '' });
  });
  route('GET', '/api/modbus', null, () => ({ stats: ACQ.stats, evenements: RAW.filter(r => r.qualite !== 'valide').slice(-40).reverse(), brut: RAW.slice(-14).reverse(),
    config: ST.acq, cycle_ms: Math.round(ACQ.cycleMs.reduce((a, b) => a + b, 0) / Math.max(1, ACQ.cycleMs.length) * 10) / 10, passerelle: 'MBAP / mémoire' }));
  route('POST', '/api/equipment/:id/test', 'config.compteurs', ({ params }) => {
    const e = ST.equipment.find(x => x.id === +params.id); if (!e) throw new HttpError(404, 'compteur introuvable');
    const defs = defsOf(e.profil); const start = Math.min(...defs.map(d => d.adresse)); const t0 = performance.now(); let regs;
    try { regs = readRegisters(e.unit_id, start, Math.max(...defs.map(d => d.adresse)) + 2 - start); }
    catch (x) { audit('TEST_COMMUNICATION', e.code, null, { resultat: 'échec', erreur: x.message }); return { ok: false, erreur: `Pas de réponse : ${x.name} ${x.message}` }; }
    const lat = performance.now() - t0 + 0.3; const dec = decodeRegisters(defs, start, regs);
    audit('TEST_COMMUNICATION', e.code, null, { resultat: 'succès', latence_ms: Math.round(lat * 10) / 10 });
    return { ok: true, latence_ms: lat, trame: `FC03 Unit ${e.unit_id} @${start} ×${regs.length}`,
      registres: defs.map(d => ({ grandeur: d.grandeur, adresse: d.adresse, type: d.type, echelle: d.echelle, brut: regs.slice(d.adresse - start, d.adresse - start + 2), valeur: dec[d.grandeur][0], unite: d.unite, qualite: dec[d.grandeur][1] })) };
  });
  route('PUT', '/api/equipment/:id', 'config.compteurs', ({ params, body }) => {
    const e = ST.equipment.find(x => x.id === +params.id); if (!e) throw new HttpError(404, 'compteur introuvable');
    const f = {}; for (const k of ['libelle', 'fabricant', 'modele', 'ip', 'port', 'unit_id', 'actif']) if (k in body) f[k] = body[k];
    if ('unit_id' in f && !(f.unit_id >= 1 && f.unit_id <= 247)) throw new HttpError(400, 'Unit ID hors plage (1-247)');
    const av = Object.fromEntries(Object.keys(f).map(k => [k, e[k]])); Object.assign(e, f); audit('COMPTEUR_MODIFICATION', e.code, av, f);
  });
  route('PUT', '/api/definitions/:id', 'config.compteurs', ({ params, body }) => {
    const d = ST.defs.find(x => x.id === +params.id); if (!d) throw new HttpError(404, 'registre introuvable');
    const nw = { adresse: num(body.adresse ?? d.adresse, 'adresse'), type: body.type ?? d.type, echelle: num(body.echelle ?? d.echelle, 'échelle'), unite: String(body.unite ?? d.unite).slice(0, 12),
      min_valide: num(body.min_valide ?? d.min_valide, 'min'), max_valide: num(body.max_valide ?? d.max_valide, 'max') };
    if (!['float32', 'uint32'].includes(nw.type) || nw.adresse < 0 || nw.adresse > 65534) throw new HttpError(400, 'type ou adresse invalide');
    const av = Object.fromEntries(Object.keys(nw).map(k => [k, d[k]])); Object.assign(d, nw); audit('REGISTRE_MODIFICATION', `${d.profil}/${d.grandeur}`, av, nw);
  });
  route('PUT', '/api/config/acquisition', 'config.acquisition', ({ body }) => {
    const lim = { periode_s: [1, 60], timeout_s: [0.1, 5], reconnexion_s: [2, 600], retention_brut_h: [1, 168], fraicheur_s: [2, 600], peremption_s: [10, 86400], derive_horloge_max_s: [0.5, 300] };
    const av = { ...ST.acq }; const nw = { ...ST.acq };
    for (const [k, [lo, hi]] of Object.entries(lim)) if (k in body) { const v = num(body[k], k); if (v < lo || v > hi) throw new HttpError(400, `${k} hors plage [${lo} ; ${hi}]`); nw[k] = v; }
    ST.acq = nw; audit('ACQUISITION_MODIFICATION', 'system_config', av, nw); startAcq();
  });
  route('PUT', '/api/tarif', 'config.seuils', ({ body }) => {
    const av = { ...ST.tarif }; for (const k of ['prix_pointe', 'prix_pleines', 'prix_creuses', 'co2_kg_kwh']) if (k in body) ST.tarif[k] = num(body[k], k);
    audit('TARIF_MODIFICATION', 'system_config', av, ST.tarif);
  });
  route('GET', '/api/simulation', null, () => ({ ctx: ST.sim, grues: SIM.cranes, incidents: SIM.incidents, types: INCIDENTS }));
  route('PUT', '/api/simulation', 'simulation.incident', ({ body }) => {
    const c = { ...ST.sim }; for (const k of ['navire_conteneurs', 'navire_vrac']) if (k in body) c[k] = !!body[k];
    if ('grues_actives' in body) c.grues_actives = Math.max(0, Math.min(4, Math.round(+body.grues_actives)));
    if ('reefers' in body) c.reefers = Math.max(0, Math.min(260, Math.round(+body.reefers)));
    ST.sim = c; audit('SIMULATION_ACTIVITE', 'activité portuaire', null, c); return { ok: true, ctx: c };
  });
  route('POST', '/api/simulation/incident', 'simulation.incident', ({ body }) => {
    const pid = +body.point_id; if (!(pid >= 1 && pid <= 7) || (body.type && !INCIDENTS[body.type])) throw new HttpError(400, 'paramètres invalides');
    simSetIncident(pid, body.type || null); audit('SIMULATION_INCIDENT', `point ${pid}`, null, { type: body.type || 'fin' });
  });
  route('POST', '/api/simulation/clear', 'simulation.incident', () => { Object.keys(SIM.incidents).forEach(k => simSetIncident(+k, null)); audit('SIMULATION_INCIDENT', 'tous', null, { type: 'fin de tous les incidents' }); });
  route('GET', '/api/recette', null, () => {
    const last = ST.runs[ST.runs.length - 1];
    return { etat: REC, plan: TESTS.map(t => ({ id: t[0], test: t[1], attendu: t[2] })), historique: ST.runs.slice().reverse().map(r => ({ id: r.id, ts: r.ts, username: r.username, conformes: r.conformes, total: r.total })), dernier: last || null };
  });
  route('POST', '/api/recette/run', 'recette.run', () => { if (REC.en_cours) throw new HttpError(409, 'une recette est déjà en cours'); runRecette(who()); });
  route('GET', '/api/report', null, ({ q }) => reportData(q.mois || lastCompleteMonth(), !readOnly));
  route('GET', '/api/reports', null, () => ({ mois: MONTHLY.map(m => m.mois).reverse(), jobs: ST.jobs.slice().reverse().slice(0, 20) }));
  route('POST', '/api/reports/job', 'view', ({ body }) => { ST.jobs.push({ id: ++ST.seq.job, ts: now(), username: who(), type: 'Revue énergétique mensuelle', periode: body.mois, statut: 'généré' }); save(); });
  route('GET', '/api/audit', 'audit.view', () => ST.audit.slice().reverse().slice(0, 300));
  route('GET', '/api/users', 'users.manage', () => ST.users);
  route('POST', '/api/users', 'users.manage', ({ body }) => {
    const u = String(body.username || '').trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(u) || !ROLES.some(r => r.code === body.role)) throw new HttpError(400, 'identifiant alphanumérique et rôle valide requis');
    if (ST.users.some(x => x.username === u)) throw new HttpError(409, 'identifiant déjà utilisé');
    ST.users.push({ username: u, fullname: String(body.fullname || u).slice(0, 80), role: body.role, actif: 1, cree_le: now(), derniere_connexion: null });
    audit('UTILISATEUR_CREATION', u, null, { role: body.role });
  });
  route('PUT', '/api/users/:u', 'users.manage', ({ params, body }) => {
    const u = ST.users.find(x => x.username === params.u); if (!u) throw new HttpError(404, 'utilisateur introuvable');
    if (u.username === who() && (('role' in body && body.role !== u.role) || body.actif === false)) throw new HttpError(400, 'vous ne pouvez pas modifier votre propre rôle ni vous désactiver');
    const av = { role: u.role, actif: u.actif };
    if (body.role && ROLES.some(r => r.code === body.role)) u.role = body.role; if ('actif' in body) u.actif = body.actif ? 1 : 0;
    audit('UTILISATEUR_MODIFICATION', u.username, av, { role: u.role, actif: u.actif });
  });
  route('GET', '/api/points-a-valider', null, () => POINTS_A_VALIDER);
  route('GET', '/api/backups', 'backup.manage', () => ({ dossier: 'Stockage local de ce navigateur (localStorage)', fichiers: ST.backups.slice().reverse() }));
  route('POST', '/api/backup', 'backup.manage', () => {
    const s = makeBackup(who()); const r = JSON.parse(s.data); downloadText(s.nom, s.data, 'application/json');
    return { ok: r.v === 1, fichier: s.nom, comptages: { equipment: r.equipment.length, alerts: r.alerts.length, audit_log: r.audit.length } };
  });
  route('POST', '/api/reset', 'backup.manage', () => { try { localStorage.removeItem(STORE_KEY); } catch { /* */ } readOnly = true; setTimeout(() => location.reload(), 100); });

  function downloadText(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportCsv(pointsList, t1, t2) {
    const f2 = v => v == null ? '' : (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4).replace('.', ',') : v);
    const dtf = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const lines = ['horodatage_local;point;P_moy_kW;P_max_kW;Q_kvar;PF;U;I_A;F_Hz;THD_pct;index_kWh;energie_kWh;mesures_valides;mesures_attendues;completude;reconstitue'];
    const rows = [];
    for (const pid of pointsList) for (const r of AGG[pid]) if (r.ts >= t1 && r.ts < t2) rows.push([r.ts, pid, r]);
    rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [ts, pid, r] of rows) lines.push([dtf.format(new Date(ts * 1000)), POINTS[pid - 1].code, ...['p', 'pmax', 'q', 'pf', 'u', 'i', 'f', 'thd', 'e_index', 'e_kwh', 'nv', 'na', 'compl', 'rec'].map(k => f2(r[k]))].join(';'));
    audit('EXPORT_CSV', `points ${pointsList}`, null, { de: t1, a: t2, lignes: rows.length });
    downloadText(`SME_export_${t1}_${t2}.csv`, '﻿' + lines.join('\n'), 'text/csv');
  }

  /* ------------------------------------------------------------------ démarrage */
  function boot({ live = true } = {}) {
    readOnly = !live;
    ST = load() || freshState();
    seedMonthly();
    const idx = seedHistory();
    if (!ST.baselines.length) createBaseline('systeme', '2025-01', '2025-12', ['evp', 'tonnes_vrac', 'reefer_jours'], 'Version initiale (démonstration)',
      'Année 2025 = période de référence ; consommation totale des 6 postes normalisée par jour ; variables pertinentes : EVP, tonnes vrac, conteneurs-jour reefer ; compteur de tête exclu (contrôle). À valider avec le responsable énergie DEPA.');
    if (!ST.audit.length) audit('INITIALISATION', 'données de démonstration', null, { version: 1 }, 'systeme');
    SIM.index = { ...idx };
    for (const a of ST.alerts) if (a.condition_active && !a.test && a.point_id) ALR.active.set(a.rule_code + ':' + a.point_id, a.id);
    simStep();
    if (live) { computeIPE(true); ser(true); }
    if (live) {
      audit('DEMARRAGE', 'ouverture de l\'application', null, { profil: ST.session.role });
      setInterval(() => { try { simStep(); } catch (e) { console.error('simulateur', e); } }, 1000);
      startAcq();
      window.addEventListener('beforeunload', () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(ST)); } catch { /* */ } });
    }
  }

  window.SME = { boot, request, exportCsv, downloadText, session: () => ST && ST.session, _internal: { readRegisters, decodeRegisters, encodeRegisters, classify, ols, tarifPeriod, AGG, ACQ, SIM } };
})();

"""
db.py — Couche données (SQLite) : schéma, accès, journal d'audit et données initiales.

Le schéma reprend le modèle de données indicatif de la spécification (§5) :
sites, electrical_posts, equipment, measurement_points, measurement_definitions,
measurements_raw, measurements_aggregated, energy_indicators, indicator_values,
energy_baselines, alerts, alert_events, users, roles, permissions, audit_log,
system_config, report_jobs (+ alert_rules, activity_data, energy_monthly,
test_runs propres à ce prototype).
"""
import json
import math
import os
import random
import sqlite3
import threading
import time
import datetime as dt
from zoneinfo import ZoneInfo

from werkzeug.security import generate_password_hash

import config as C
import model

TZ = ZoneInfo(C.TZ_NAME)
_write_lock = threading.RLock()

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sites(
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, libelle TEXT, emplacement TEXT, etat TEXT);
CREATE TABLE IF NOT EXISTS electrical_posts(
  id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES sites(id), parent_id INTEGER REFERENCES electrical_posts(id),
  code TEXT UNIQUE, libelle TEXT, emplacement TEXT, usage TEXT, transfo_kva REAL, souscrite_kw REAL,
  departs TEXT, etat TEXT);
CREATE TABLE IF NOT EXISTS equipment(
  id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES electrical_posts(id), code TEXT UNIQUE, libelle TEXT,
  fabricant TEXT, modele TEXT, protocole TEXT, ip TEXT, port INTEGER, unit_id INTEGER, profil TEXT,
  existant INTEGER DEFAULT 0, actif INTEGER DEFAULT 1, etat TEXT);
CREATE TABLE IF NOT EXISTS measurement_points(
  id INTEGER PRIMARY KEY, equipment_id INTEGER REFERENCES equipment(id), post_id INTEGER REFERENCES electrical_posts(id),
  parent_point_id INTEGER REFERENCES measurement_points(id), code TEXT UNIQUE, libelle TEXT,
  role TEXT, inclus_agregation INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS measurement_definitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, profil TEXT, grandeur TEXT, adresse INTEGER, type TEXT, echelle REAL,
  unite TEXT, description TEXT, min_valide REAL, max_valide REAL, UNIQUE(profil, grandeur));
CREATE TABLE IF NOT EXISTS measurements_raw(
  id INTEGER PRIMARY KEY AUTOINCREMENT, point_id INTEGER, ts_mesure REAL, ts_reception REAL,
  valeurs TEXT, qualite TEXT, motif TEXT, UNIQUE(point_id, ts_mesure));
CREATE INDEX IF NOT EXISTS ix_raw_ts ON measurements_raw(ts_reception);
CREATE TABLE IF NOT EXISTS measurements_aggregated(
  point_id INTEGER, ts INTEGER, p_moy REAL, p_max REAL, q_moy REAL, pf_moy REAL, u_moy REAL, i_moy REAL,
  f_moy REAL, thd_moy REAL, e_index REAL, e_kwh REAL, n_valides INTEGER, n_attendus INTEGER,
  completude REAL, reconstitue INTEGER DEFAULT 0, PRIMARY KEY(point_id, ts));
CREATE INDEX IF NOT EXISTS ix_agg_ts ON measurements_aggregated(ts);
CREATE TABLE IF NOT EXISTS activity_data(
  mois TEXT PRIMARY KEY, jours REAL, evp REAL, tonnes_vrac REAL, escales REAL, heures_grue REAL,
  reefer_jours REAL, source TEXT);
CREATE TABLE IF NOT EXISTS energy_monthly(
  mois TEXT, usage TEXT, kwh REAL, source TEXT, PRIMARY KEY(mois, usage));
CREATE TABLE IF NOT EXISTS energy_indicators(
  code TEXT PRIMARY KEY, libelle TEXT, description TEXT, formule TEXT, num TEXT, den TEXT, unite TEXT,
  perimetre TEXT, periode_agregation TEXT, regle_manquantes TEXT, cible REAL, sens TEXT,
  date_effet TEXT, version INTEGER, statut_validation TEXT);
CREATE TABLE IF NOT EXISTS indicator_values(
  code TEXT, periode TEXT, valeur REAL, numerateur REAL, denominateur REAL, completude REAL,
  calcule_le REAL, PRIMARY KEY(code, periode));
CREATE TABLE IF NOT EXISTS energy_baselines(
  id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, libelle TEXT, periode_debut TEXT, periode_fin TEXT,
  variables TEXT, coefficients TEXT, r2 REAL, cv_rmse REAL, n INTEGER, hypotheses TEXT, motif TEXT,
  cree_par TEXT, cree_le REAL, active INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS alert_rules(
  code TEXT PRIMARY KEY, libelle TEXT, type TEXT, seuil REAL, priorite TEXT, delai_s REAL, actif INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, rule_code TEXT, type TEXT, point_id INTEGER, post_id INTEGER,
  equipement TEXT, ts_detection REAL, valeur REAL, seuil REAL, regle TEXT, priorite TEXT, message TEXT,
  etat TEXT, condition_active INTEGER DEFAULT 1, ts_fin_condition REAL, commentaire TEXT, test INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_alerts_etat ON alerts(etat);
CREATE TABLE IF NOT EXISTS alert_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, alert_id INTEGER REFERENCES alerts(id), ts REAL, username TEXT,
  action TEXT, commentaire TEXT);
CREATE TABLE IF NOT EXISTS roles(code TEXT PRIMARY KEY, libelle TEXT, niveau INTEGER);
CREATE TABLE IF NOT EXISTS permissions(role TEXT REFERENCES roles(code), permission TEXT, PRIMARY KEY(role, permission));
CREATE TABLE IF NOT EXISTS users(
  username TEXT PRIMARY KEY, fullname TEXT, role TEXT REFERENCES roles(code), pwhash TEXT, actif INTEGER DEFAULT 1,
  cree_le REAL, derniere_connexion REAL);
CREATE TABLE IF NOT EXISTS audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, username TEXT, action TEXT, objet TEXT, avant TEXT, apres TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS system_config(key TEXT PRIMARY KEY, value TEXT, maj_par TEXT, maj_le REAL);
CREATE TABLE IF NOT EXISTS report_jobs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, username TEXT, type TEXT, periode TEXT, statut TEXT, params TEXT);
CREATE TABLE IF NOT EXISTS test_runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, username TEXT, resultats TEXT, conformes INTEGER, total INTEGER);
"""


def connect():
    con = sqlite3.connect(C.DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def query(sql, args=()):
    con = connect()
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def query_one(sql, args=()):
    r = query(sql, args)
    return r[0] if r else None


def execute(sql, args=(), many=False):
    with _write_lock:
        con = connect()
        try:
            cur = con.executemany(sql, args) if many else con.execute(sql, args)
            con.commit()
            return cur.lastrowid
        finally:
            con.close()


def get_config(key, default=None):
    r = query_one("SELECT value FROM system_config WHERE key=?", (key,))
    return json.loads(r["value"]) if r else default


def set_config(key, value, user="systeme"):
    execute("INSERT INTO system_config(key,value,maj_par,maj_le) VALUES(?,?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, maj_par=excluded.maj_par, maj_le=excluded.maj_le",
            (key, json.dumps(value, ensure_ascii=False), user, time.time()))


def audit(username, action, objet="", avant=None, apres=None, ip=""):
    execute("INSERT INTO audit_log(ts,username,action,objet,avant,apres,ip) VALUES(?,?,?,?,?,?,?)",
            (time.time(), username, action, objet,
             json.dumps(avant, ensure_ascii=False) if avant is not None else None,
             json.dumps(apres, ensure_ascii=False) if apres is not None else None, ip))


def month_key(d):
    return f"{d.year:04d}-{d.month:02d}"


# --------------------------------------------------------------------------- #
#  Initialisation
# --------------------------------------------------------------------------- #
def init():
    os.makedirs(C.DATA_DIR, exist_ok=True)
    con = connect()
    con.executescript(SCHEMA)
    con.commit()
    seeded = con.execute("SELECT COUNT(*) FROM sites").fetchone()[0] > 0
    con.close()
    if not seeded:
        _seed_reference()
        _seed_monthly()
        _seed_history()
        audit("systeme", "INITIALISATION", "base de données", apres={"version": 1})


def _seed_reference():
    rows = []
    execute("INSERT INTO sites(id,code,libelle,emplacement,etat) VALUES(1,'AGA','Port d''Agadir — DEPA','Agadir, Maroc','en service')")
    for p in C.POSTES:
        execute("INSERT INTO electrical_posts(id,site_id,parent_id,code,libelle,emplacement,usage,transfo_kva,souscrite_kw,departs,etat) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (p["id"], 1, None, p["code"], p["libelle"], p["zone"], p["usage"], p["transfo_kva"],
                 p["souscrite_kw"], json.dumps(p["departs"], ensure_ascii=False), "en service"))
    for e in C.EQUIPEMENTS:
        profil = "PM800-MT-DEMO" if e["existant"] else e["profil"]
        execute("INSERT INTO equipment(id,post_id,code,libelle,fabricant,modele,protocole,ip,port,unit_id,profil,existant,actif,etat) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,'en service')",
                (e["id"], e["post_id"], e["code"], e["libelle"], e["fabricant"], e["modele"], "Modbus TCP/IP",
                 e["ip"], e["port"], e["unit"], profil, e["existant"]))
        role = "tete" if e["existant"] else "poste"
        execute("INSERT INTO measurement_points(id,equipment_id,post_id,parent_point_id,code,libelle,role,inclus_agregation) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (e["id"], e["id"], e["post_id"], None if e["existant"] else 7,
                 "PC-TETE" if e["existant"] else f"PC-P{e['id']}",
                 "Arrivée générale ONEE (contrôle)" if e["existant"] else f"Départ général {C.POSTES[e['id'] - 1]['code']}",
                 role, 0 if e["existant"] else 1))
    for d in C.MEASUREMENT_DEFINITIONS:
        rows.append(("PM800-DEMO",) + d)
        if d[0] == "U":
            rows.append(("PM800-MT-DEMO", "U", d[1], d[2], d[3], "kV", "Tension composée MT", 18.0, 26.0))
        elif d[0] == "I":
            rows.append(("PM800-MT-DEMO", "I", d[1], d[2], d[3], "A", "Courant moyen MT", 0.0, 400.0))
        else:
            rows.append(("PM800-MT-DEMO",) + d)
    execute("INSERT INTO measurement_definitions(profil,grandeur,adresse,type,echelle,unite,description,min_valide,max_valide) "
            "VALUES(?,?,?,?,?,?,?,?,?)", rows, many=True)
    execute("INSERT INTO alert_rules(code,libelle,type,seuil,priorite,delai_s,actif) VALUES(?,?,?,?,?,?,1)",
            C.ALERT_RULES, many=True)
    today = dt.date.today().isoformat()
    for i in C.IPE_DEFAULT:
        execute("INSERT INTO energy_indicators VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (i["code"], i["libelle"], f"Indicateur proposé : {i['libelle'].lower()}.", i["formule"], i["num"], i["den"],
                 i["unite"], i["perimetre"], "mensuelle",
                 "Mois retenu si complétude ≥ 90 % ; sinon valeur signalée « incomplète » et exclue des tendances.",
                 i["cible"], "baisse", "2025-01-01", 1, "proposé — à valider DEPA"))
    for code, lib, niv in C.ROLES:
        execute("INSERT INTO roles VALUES(?,?,?)", (code, lib, niv))
        for perm in C.PERMISSIONS[code]:
            execute("INSERT INTO permissions VALUES(?,?)", (code, perm))
    for u, name, role, pw in C.DEFAULT_USERS:
        execute("INSERT INTO users(username,fullname,role,pwhash,actif,cree_le) VALUES(?,?,?,?,1,?)",
                (u, name, role, generate_password_hash(pw), time.time()))
    set_config("acquisition", C.ACQUISITION_DEFAULT)
    set_config("tarif", C.TARIF_DEFAULT)
    set_config("simulation", {"navire_conteneurs": True, "navire_vrac": False, "grues_actives": 2,
                              "reefers": 180, "eclairage_facteur": 1.0})


def _seed_monthly():
    """Variables pertinentes et consommations mensuelles consolidées (démonstration).
    Scénario : 2025 = période de référence ; mars 2026 = relamping LED (éclairage -22 %) ;
    août 2026 = dérive sur le terminal à conteneurs (+9 %, ex. fuites d'air comprimé)."""
    rnd = random.Random(50001)
    now = dt.datetime.now(TZ)
    y, m = 2025, 1
    rows_a, rows_e = [], []
    while (y, m) <= (now.year, now.month):
        nd = (dt.date(y + (m == 12), m % 12 + 1, 1) - dt.date(y, m, 1)).days
        cur = (y, m) == (now.year, now.month)
        jours = (now.day - 1 + now.hour / 24) if cur else nd
        jours = max(jours, 0.5)
        f = jours / nd
        season = math.sin((m - 1) / 12 * 2 * math.pi)
        growth = 1.0 + (0.04 if y == 2026 else 0.0)
        evp = (11000 + 1300 * math.sin((m + 2) / 12 * 2 * math.pi) + rnd.gauss(0, 450)) * growth * f
        tonnes = (220000 + 38000 * math.cos(m / 12 * 2 * math.pi) + rnd.gauss(0, 9000)) * f
        escales = (86 + 9 * season + rnd.gauss(0, 3)) * f
        heures = (1450 + 0.05 * evp / f + 0.0012 * tonnes / f + rnd.gauss(0, 40)) * f
        reefer_j = (5400 + 1100 * math.cos((m - 2) / 12 * 2 * math.pi) + rnd.gauss(0, 150)) * f
        drift = 1.09 if (y, m) >= (2026, 8) else 1.0
        led = 0.78 if (y, m) >= (2026, 3) else 1.0
        e = {
            "conteneurs": (112000 * f + 21.4 * evp) * drift * (1 + rnd.gauss(0, 0.03)),
            "vrac": (40000 * f + 0.95 * tonnes) * (1 + rnd.gauss(0, 0.03)),
            "grues": 142 * heures * (1 + rnd.gauss(0, 0.035)),
            "reefers": 77.5 * reefer_j * (1 + rnd.gauss(0, 0.025)),
            "eclairage": 5600 * jours * led * (1 + 0.05 * math.cos(m / 12 * 2 * math.pi)) * (1 + rnd.gauss(0, 0.02)),
            "services": (150000 + 14000 * season) * f * (1 + rnd.gauss(0, 0.04)),
        }
        mk = f"{y:04d}-{m:02d}"
        src = "consolidé (démo)" if not cur else "mois en cours (démo)"
        rows_a.append((mk, round(jours, 2), round(evp), round(tonnes), round(escales, 1), round(heures), round(reefer_j), src))
        rows_e += [(mk, k, round(v), src) for k, v in e.items()]
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    execute("INSERT OR REPLACE INTO activity_data VALUES(?,?,?,?,?,?,?,?)", rows_a, many=True)
    execute("INSERT OR REPLACE INTO energy_monthly VALUES(?,?,?,?)", rows_e, many=True)


def _seed_history():
    """Historique 1 minute sur HISTORY_DAYS jours pour les 7 points de comptage, avec
    une coupure de communication simulée (P3, 90 min) pour illustrer lacunes et reprise."""
    rnd = random.Random(2026)
    now = int(time.time() // 60 * 60)
    start = now - C.HISTORY_DAYS * 86400
    gap_a, gap_b = now - 3 * 86400 + 7200, now - 3 * 86400 + 7200 + 5400
    index = {i: 1_200_000.0 + 150_000 * i for i in range(1, 8)}
    last_valid_index = dict(index)
    rows = []
    for ts in range(start, now, 60):
        loc = dt.datetime.fromtimestamp(ts, TZ)
        ctx = model.history_context(loc)
        vals = []
        for p in C.POSTES:
            pk, pf = model.usage_power(p, loc.hour + loc.minute / 60, loc.weekday(), ctx, averaged=True, rnd=rnd)
            vals.append(model.electrical_values(p, pk, pf, rnd))
        head = model.head_values(vals, rnd)
        for pid, v in list(enumerate(vals, start=1)) + [(7, head)]:
            e_min = v["P"] / 60.0
            index[pid] += e_min
            if pid == 3 and gap_a <= ts < gap_b:
                rows.append((pid, ts, None, None, None, None, None, None, None, None, None, None, 0, 30, 0.0, 0))
                continue
            reconst = 1 if (pid == 3 and ts == gap_b) else 0
            e_kwh = index[pid] - last_valid_index[pid]
            last_valid_index[pid] = index[pid]
            rows.append((pid, ts, v["P"], v["P"] * (1.06 + rnd.random() * 0.06), v["Q"], v["PF"], v["U"], v["I"],
                         v["F"], v["THD"], round(index[pid], 3), e_kwh, 30, 30, 1.0, reconst))
    execute("INSERT OR IGNORE INTO measurements_aggregated VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows, many=True)
    set_config("dernier_index", {str(k): v for k, v in index.items()})


# --------------------------------------------------------------------------- #
#  Sauvegarde / restauration
# --------------------------------------------------------------------------- #
def backup(dest_dir=None):
    dest_dir = dest_dir or C.BACKUP_DIR
    os.makedirs(dest_dir, exist_ok=True)
    name = "sme_" + dt.datetime.now(TZ).strftime("%Y%m%d_%H%M%S") + ".db"
    path = os.path.join(dest_dir, name)
    src = connect()
    dst = sqlite3.connect(path)
    with _write_lock:
        src.backup(dst)
    dst.close()
    src.close()
    files = sorted(f for f in os.listdir(dest_dir) if f.startswith("sme_") and f.endswith(".db"))
    for old in files[:-10]:                # on garde les 10 dernières sauvegardes
        try:
            os.remove(os.path.join(dest_dir, old))
        except OSError:
            pass
    return path


def verify_backup(path):
    """Test de restauration : ouvre la copie, contrôle d'intégrité et comptages."""
    con = sqlite3.connect(path)
    try:
        ok = con.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                  for t in ("electrical_posts", "equipment", "measurements_aggregated", "alerts", "audit_log")}
    finally:
        con.close()
    return ok, counts


def restore_latest_if_empty():
    """Au démarrage sur une machine neuve (Colab), restaure la dernière sauvegarde si elle existe."""
    if os.path.exists(C.DB_PATH) or not os.path.isdir(C.BACKUP_DIR):
        return None
    files = sorted(f for f in os.listdir(C.BACKUP_DIR) if f.startswith("sme_") and f.endswith(".db"))
    if not files:
        return None
    os.makedirs(C.DATA_DIR, exist_ok=True)
    src = sqlite3.connect(os.path.join(C.BACKUP_DIR, files[-1]))
    dst = sqlite3.connect(C.DB_PATH)
    src.backup(dst)
    src.close()
    dst.close()
    return files[-1]

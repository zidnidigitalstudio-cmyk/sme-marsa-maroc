"""
app.py — Couche présentation et API du SME (Flask).

Lancement :  python app.py          (écoute sur 0.0.0.0:8000 par défaut)
Variables :  SME_PORT, SME_DATA_DIR, SME_BACKUP_DIR
"""
import csv
import datetime as dt
import functools
import io
import json
import logging
import os
import secrets
import time

from flask import (Flask, Response, abort, jsonify, redirect, render_template, request, session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import config as C
import db
import energy
from engine import INCIDENTS, Runtime, decode_registers
from modbus_tcp import ModbusError, read_registers
from recette import TESTS, Recette

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")
log = logging.getLogger("sme")

app = Flask(__name__)
app.json.sort_keys = False          # conserver l'ordre des registres (P, Q, S, PF, U, I, F, THD, E)
app.config.update(SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Lax",
                  PERMANENT_SESSION_LIFETIME=dt.timedelta(hours=8), JSON_SORT_KEYS=False)
RT = None
RECETTE = None
_failed = {}


def _secret_key():
    os.makedirs(C.DATA_DIR, exist_ok=True)
    path = os.path.join(C.DATA_DIR, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
    return open(path).read().strip()


# --------------------------------------------------------------------------- #
#  Sécurité : authentification, rôles, permissions, en-têtes
# --------------------------------------------------------------------------- #
def perms_of(role):
    return {r["permission"] for r in db.query("SELECT permission FROM permissions WHERE role=?", (role,))}


def current_user():
    return session.get("user")


def login_required(f):
    @functools.wraps(f)
    def w(*a, **k):
        if not current_user():
            if request.path.startswith("/api/"):
                return jsonify(error="authentification requise"), 401
            return redirect(url_for("login", next=request.path))
        return f(*a, **k)
    return w


def require(permission):
    def deco(f):
        @functools.wraps(f)
        def w(*a, **k):
            u = current_user()
            if not u:
                return jsonify(error="authentification requise"), 401
            if request.method in ("POST", "PUT", "DELETE") and request.headers.get("X-Requested-With") != "SME":
                return jsonify(error="requête refusée (en-tête anti-CSRF manquant)"), 400
            if permission not in perms_of(u["role"]):
                db.audit(u["username"], "ACCES_REFUSE", request.path, apres={"permission": permission}, ip=_ip())
                return jsonify(error=f"action non autorisée pour le rôle « {u['role']} »"), 403
            return f(*a, **k)
        return w
    return deco


def _ip():
    return request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For", request.remote_addr or "")


@app.after_request
def headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Content-Security-Policy"] = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                                               "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def body():
    return request.get_json(silent=True) or {}


# --------------------------------------------------------------------------- #
#  Pages
# --------------------------------------------------------------------------- #
@app.route("/login", methods=["GET", "POST"])
def login():
    err = None
    if request.method == "POST":
        ip = _ip()
        fails = [t for t in _failed.get(ip, []) if time.time() - t < 300]
        if len(fails) >= 5:
            err = "Trop de tentatives. Réessayez dans quelques minutes."
        else:
            u = request.form.get("username", "").strip().lower()
            pw = request.form.get("password", "")
            row = db.query_one("SELECT * FROM users WHERE username=? AND actif=1", (u,))
            if row and check_password_hash(row["pwhash"], pw):
                session.clear()
                session.permanent = True
                session["user"] = {"username": row["username"], "fullname": row["fullname"], "role": row["role"]}
                db.execute("UPDATE users SET derniere_connexion=? WHERE username=?", (time.time(), u))
                db.audit(u, "CONNEXION", "session", ip=ip)
                _failed.pop(ip, None)
                nxt = request.args.get("next", "/")
                return redirect(nxt if nxt.startswith("/") and not nxt.startswith("//") else "/")
            fails.append(time.time())
            _failed[ip] = fails
            db.audit(u or "?", "CONNEXION_ECHEC", "session", ip=ip)
            err = "Identifiant ou mot de passe incorrect."
    return render_template("login.html", err=err, client=C.CLIENT)


@app.route("/login/invite", methods=["POST"])
def login_guest():
    session.clear()
    session["user"] = {"username": "invite", "fullname": "Visiteur (lecture seule)", "role": "lecteur"}
    db.audit("invite", "CONNEXION", "accès démonstration lecture seule", ip=_ip())
    return redirect("/")


@app.route("/logout")
def logout():
    u = current_user()
    if u:
        db.audit(u["username"], "DECONNEXION", "session", ip=_ip())
    session.clear()
    return redirect("/login")


@app.route("/")
@login_required
def index():
    return render_template("index.html", client=C.CLIENT)


@app.route("/rapport")
@login_required
def rapport():
    mois = request.args.get("mois") or energy.last_complete_month()
    u = current_user()
    db.execute("INSERT INTO report_jobs(ts,username,type,periode,statut,params) VALUES(?,?,?,?,?,?)",
               (time.time(), u["username"], "Revue énergétique mensuelle", mois, "généré", json.dumps({"format": "A4"})))
    return render_template("rapport.html", mois=mois, client=C.CLIENT, user=u,
                           genere=dt.datetime.now(db.TZ).strftime("%d/%m/%Y %H:%M"))


# --------------------------------------------------------------------------- #
#  API — lecture
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    acq = RT.acq
    return jsonify(status="ok", uptime_s=round(time.time() - RT.started),
                   points_en_ligne=sum(1 for s in acq.stats.values() if s["etat"] == "en ligne"),
                   points_total=len(acq.stats))


@app.get("/api/meta")
@login_required
def meta():
    u = current_user()
    return jsonify(client=C.CLIENT, user=dict(u, permissions=sorted(perms_of(u["role"]))),
                   roles=db.query("SELECT * FROM roles ORDER BY niveau"),
                   posts=[dict(p, departs=json.loads(p["departs"] or "[]")) for p in db.query("SELECT * FROM electrical_posts ORDER BY id")],
                   points=db.query("SELECT mp.*, e.code AS equipement, e.ip, e.unit_id, e.modele, e.fabricant, e.existant "
                                   "FROM measurement_points mp JOIN equipment e ON e.id=mp.equipment_id ORDER BY mp.id"),
                   incidents=INCIDENTS, acquisition=db.get_config("acquisition"), tarif=db.get_config("tarif"),
                   tz=C.TZ_NAME)


def _freshness(rd, cfg):
    if not rd or not rd.get("ts_mesure"):
        return "absente", None
    age = time.time() - rd["ts_reception"] if rd["qualite"] != "perdue" else time.time() - rd["ts_mesure"]
    if rd["qualite"] == "perdue":
        return ("ancienne" if age < cfg["peremption_s"] else "périmée"), age
    if age <= cfg["fraicheur_s"]:
        return "fraîche", age
    return ("ancienne" if age < cfg["peremption_s"] else "périmée"), age


@app.get("/api/live")
@login_required
def live():
    acq, sim = RT.acq, RT.sim
    cfg = acq.cfg
    pts = []
    for p in acq.points:
        rd = acq.latest.get(p["id"]) or {}
        fr, age = _freshness(rd, cfg)
        st = acq.stats.get(p["id"], {})
        pts.append({"point_id": p["id"], "post_id": p["post_id"], "role": p["role"], "equipement": p["equipement"],
                    "valeurs": rd.get("valeurs", {}), "qualite": rd.get("qualite", "absente"), "motifs": rd.get("motifs", []),
                    "ts_mesure": rd.get("ts_mesure"), "ts_reception": rd.get("ts_reception"), "fraicheur": fr,
                    "age_s": round(age, 1) if age is not None else None, "latence_ms": rd.get("latence_ms"),
                    "etat_comm": st.get("etat"), "incident": sim.incidents.get(p["id"])})
    total = sum((x["valeurs"].get("P", {}).get("v") or 0) for x in pts if x["role"] == "poste")
    actives = db.query("SELECT priorite, COUNT(*) AS n FROM alerts WHERE etat!='cloturee' AND test=0 GROUP BY priorite")
    cyc = list(acq.cycle_starts)
    periode_mesuree = (cyc[-1] - cyc[0]) / (len(cyc) - 1) if len(cyc) > 1 else None
    dispo = [s["ok"] / s["polls"] for s in acq.stats.values() if s["polls"]]
    return jsonify(ts=time.time(), points=pts, total_kw=total, alertes=actives,
                   acquisition={"periode_cible_s": cfg["periode_s"], "periode_mesuree_s": periode_mesuree,
                                "disponibilite": sum(dispo) / len(dispo) if dispo else None,
                                "coherence": getattr(acq, "coherence", None)},
                   simulation={"ctx": sim.ctx, "grues": sim.crane_states, "incidents": sim.incidents})


GRANDEURS = {"p_moy": "P moy (kW)", "p_max": "P max (kW)", "q_moy": "Q (kvar)", "pf_moy": "Facteur de puissance",
             "u_moy": "Tension (V)", "i_moy": "Courant (A)", "f_moy": "Fréquence (Hz)", "thd_moy": "THD-U (%)",
             "e_kwh": "Énergie (kWh)", "completude": "Complétude"}


def _hist_params():
    now = int(time.time())
    t2 = int(float(request.args.get("to", now)))
    t1 = int(float(request.args.get("from", t2 - 86400)))
    pts = [int(x) for x in request.args.get("points", "1,2,3,4,5,6").split(",") if x.strip().isdigit()]
    g = request.args.get("grandeur", "p_moy")
    if g not in GRANDEURS:
        abort(400)
    return t1, t2, pts, g


@app.get("/api/history")
@login_required
def history():
    t1, t2, pts, g = _hist_params()
    span = t2 - t1
    pas = int(request.args.get("pas") or (60 if span <= 6 * 3600 else 300 if span <= 2 * 86400 else 900))
    agg = "SUM" if g == "e_kwh" else ("MAX" if g == "p_max" else "AVG")
    out = {}
    for pid in pts:
        rows = db.query(f"SELECT (ts/{pas})*{pas} AS b, {agg}({g}) AS v, SUM(n_valides) AS nv, SUM(n_attendus) AS na, "
                        f"MAX(reconstitue) AS rec FROM measurements_aggregated WHERE point_id=? AND ts>=? AND ts<? GROUP BY b ORDER BY b",
                        (pid, t1, t2))
        out[pid] = [[r["b"], r["v"], round((r["nv"] or 0) / (r["na"] or 1), 3), r["rec"]] for r in rows]
    return jsonify(grandeur=g, libelle=GRANDEURS[g], pas=pas, series=out, t1=t1, t2=t2)


@app.get("/api/export.csv")
@login_required
def export_csv():
    t1, t2, pts, _ = _hist_params()
    rows = db.query("SELECT a.*, mp.code AS point FROM measurements_aggregated a JOIN measurement_points mp ON mp.id=a.point_id "
                    f"WHERE a.point_id IN ({','.join('?' * len(pts))}) AND a.ts>=? AND a.ts<? ORDER BY a.ts, a.point_id",
                    (*pts, t1, t2))
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["horodatage_local", "point", "P_moy_kW", "P_max_kW", "Q_kvar", "PF", "U", "I_A", "F_Hz", "THD_pct",
                "index_kWh", "energie_kWh", "mesures_valides", "mesures_attendues", "completude", "reconstitue"])
    for r in rows:
        w.writerow([dt.datetime.fromtimestamp(r["ts"], db.TZ).strftime("%Y-%m-%d %H:%M"), r["point"]] +
                   ["" if r[k] is None else (f"{r[k]:.4f}".replace(".", ",") if isinstance(r[k], float) else r[k])
                    for k in ("p_moy", "p_max", "q_moy", "pf_moy", "u_moy", "i_moy", "f_moy", "thd_moy", "e_index",
                              "e_kwh", "n_valides", "n_attendus", "completude", "reconstitue")])
    u = current_user()
    db.audit(u["username"], "EXPORT_CSV", f"points {pts}", apres={"de": t1, "a": t2, "lignes": len(rows)}, ip=_ip())
    name = f"SME_export_{dt.datetime.fromtimestamp(t1, db.TZ):%Y%m%d%H%M}_{dt.datetime.fromtimestamp(t2, db.TZ):%Y%m%d%H%M}.csv"
    return Response("﻿" + buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={name}"})


@app.get("/api/energy/today")
@login_required
def energy_today():
    return jsonify(energy.today_summary())


@app.get("/api/patrimoine")
@login_required
def patrimoine():
    defs = {}
    for d in db.query("SELECT * FROM measurement_definitions ORDER BY profil, adresse"):
        defs.setdefault(d["profil"], []).append(d)
    return jsonify(sites=db.query("SELECT * FROM sites"),
                   posts=[dict(p, departs=json.loads(p["departs"] or "[]")) for p in db.query("SELECT * FROM electrical_posts ORDER BY id")],
                   equipment=db.query("SELECT * FROM equipment ORDER BY id"),
                   points=db.query("SELECT * FROM measurement_points ORDER BY id"),
                   definitions=defs, stats=RT.acq.stats)


@app.get("/api/ipe")
@login_required
def ipe():
    return jsonify(indicateurs=energy.compute_ipe(RT.alerts),
                   historique=db.query("SELECT * FROM audit_log WHERE action='IPE_MODIFICATION' ORDER BY ts DESC LIMIT 30"))


@app.get("/api/ser")
@login_required
def ser():
    return jsonify(energy.ser(RT.alerts))


@app.get("/api/activite")
@login_required
def activite():
    return jsonify(energy.monthly_table())


@app.get("/api/alerts")
@login_required
def alerts():
    etat = request.args.get("etat", "ouvertes")
    lim = min(int(request.args.get("limit", 200)), 1000)
    where = "WHERE a.etat!='cloturee'" if etat == "ouvertes" else ("" if etat == "toutes" else "WHERE a.etat=?")
    args = () if etat in ("ouvertes", "toutes") else (etat,)
    rows = db.query(f"SELECT a.*, p.code AS post_code FROM alerts a LEFT JOIN electrical_posts p ON p.id=a.post_id {where} "
                    f"ORDER BY CASE a.etat WHEN 'nouvelle' THEN 0 WHEN 'prise_en_charge' THEN 1 ELSE 2 END, a.ts_detection DESC LIMIT {lim}", args)
    stats = db.query("SELECT etat, priorite, COUNT(*) AS n FROM alerts WHERE test=0 GROUP BY etat, priorite")
    return jsonify(alertes=rows, stats=stats)


@app.get("/api/alerts/<int:aid>")
@login_required
def alert_detail(aid):
    a = db.query_one("SELECT * FROM alerts WHERE id=?", (aid,))
    if not a:
        abort(404)
    return jsonify(alerte=a, evenements=db.query("SELECT * FROM alert_events WHERE alert_id=? ORDER BY ts", (aid,)))


@app.get("/api/rules")
@login_required
def rules():
    return jsonify(db.query("SELECT * FROM alert_rules ORDER BY code"))


@app.get("/api/modbus")
@login_required
def modbus_view():
    acq = RT.acq
    ev = db.query("SELECT r.point_id, r.ts_mesure, r.ts_reception, r.qualite, r.motif FROM measurements_raw r "
                  "WHERE r.qualite!='valide' ORDER BY r.id DESC LIMIT 40")
    raw = db.query("SELECT point_id, ts_mesure, ts_reception, valeurs, qualite FROM measurements_raw ORDER BY id DESC LIMIT 14")
    return jsonify(stats=acq.stats, evenements=ev, brut=raw, config=acq.cfg,
                   cycle_ms=round(sum(acq.cycle_durations) / max(1, len(acq.cycle_durations)) * 1000, 1),
                   passerelle=f"{C.MODBUS_HOST}:{C.MODBUS_PORT}")


@app.get("/api/simulation")
@login_required
def sim_state():
    return jsonify(ctx=RT.sim.ctx, grues=RT.sim.crane_states, incidents=RT.sim.incidents, types=INCIDENTS)


@app.get("/api/recette")
@login_required
def recette_state():
    runs = db.query("SELECT id, ts, username, conformes, total FROM test_runs ORDER BY id DESC LIMIT 10")
    last = db.query_one("SELECT * FROM test_runs ORDER BY id DESC LIMIT 1")
    return jsonify(etat=RECETTE.state, plan=[{"id": t[0], "test": t[1], "attendu": t[2]} for t in TESTS],
                   historique=runs, dernier=dict(last, resultats=json.loads(last["resultats"])) if last else None)


@app.get("/api/report")
@login_required
def report_api():
    mois = request.args.get("mois") or energy.last_complete_month()
    try:
        return jsonify(energy.report_data(mois, RT.alerts))
    except ValueError as e:
        return jsonify(error=str(e)), 404


@app.get("/api/reports")
@login_required
def reports_list():
    return jsonify(mois=[m["mois"] for m in energy.monthly_table()][::-1],
                   jobs=db.query("SELECT * FROM report_jobs ORDER BY id DESC LIMIT 20"))


@app.get("/api/audit")
@require("audit.view")
def audit_log():
    return jsonify(db.query("SELECT * FROM audit_log ORDER BY id DESC LIMIT 300"))


@app.get("/api/users")
@require("users.manage")
def users():
    return jsonify(db.query("SELECT username, fullname, role, actif, cree_le, derniere_connexion FROM users ORDER BY username"))


@app.get("/api/points-a-valider")
@login_required
def pav():
    return jsonify([{"theme": a, "point": b, "hypothese": c} for a, b, c in C.POINTS_A_VALIDER])


@app.get("/api/backups")
@require("backup.manage")
def backups():
    d = C.BACKUP_DIR
    files = sorted((f for f in os.listdir(d) if f.endswith(".db")), reverse=True) if os.path.isdir(d) else []
    return jsonify(dossier=d, fichiers=[{"nom": f, "taille_ko": round(os.path.getsize(os.path.join(d, f)) / 1024)} for f in files])


# --------------------------------------------------------------------------- #
#  API — écriture (journalisées)
# --------------------------------------------------------------------------- #
def who():
    return current_user()["username"]


@app.post("/api/alerts/<int:aid>/action")
@require("alert.handle")
def alert_action(aid):
    b = body()
    a = db.query_one("SELECT * FROM alerts WHERE id=?", (aid,))
    if not a:
        abort(404)
    action = b.get("action")
    com = (b.get("commentaire") or "").strip()[:500]
    if a["etat"] == "cloturee":
        return jsonify(error="alerte déjà clôturée"), 409
    if action == "prendre":
        db.execute("UPDATE alerts SET etat='prise_en_charge' WHERE id=?", (aid,))
        label = "PRISE_EN_CHARGE"
    elif action == "commenter":
        if not com:
            return jsonify(error="commentaire vide"), 400
        label = "COMMENTAIRE"
    elif action == "cloturer":
        if not com:
            return jsonify(error="un commentaire (action corrective) est obligatoire pour clôturer"), 400
        if a["condition_active"]:
            return jsonify(error="la condition est toujours active : clôture impossible tant que le défaut persiste"), 409
        db.execute("UPDATE alerts SET etat='cloturee', commentaire=? WHERE id=?", (com, aid))
        label = "CLOTURE"
    else:
        abort(400)
    db.execute("INSERT INTO alert_events(alert_id,ts,username,action,commentaire) VALUES(?,?,?,?,?)",
               (aid, time.time(), who(), label, com))
    db.audit(who(), "ALERTE_" + label, f"alerte #{aid}", apres={"commentaire": com}, ip=_ip())
    return jsonify(ok=True)


@app.put("/api/rules/<code>")
@require("config.seuils")
def rule_update(code):
    b = body()
    r = db.query_one("SELECT * FROM alert_rules WHERE code=?", (code,))
    if not r:
        abort(404)
    new = {"seuil": b.get("seuil", r["seuil"]), "priorite": b.get("priorite", r["priorite"]),
           "delai_s": b.get("delai_s", r["delai_s"]), "actif": int(bool(b.get("actif", r["actif"])))}
    if new["priorite"] not in ("critique", "majeure", "mineure"):
        return jsonify(error="priorité invalide"), 400
    try:
        new["seuil"] = None if new["seuil"] in (None, "") else float(new["seuil"])
        new["delai_s"] = float(new["delai_s"] or 0)
    except (TypeError, ValueError):
        return jsonify(error="valeur numérique invalide"), 400
    db.execute("UPDATE alert_rules SET seuil=?, priorite=?, delai_s=?, actif=? WHERE code=?",
               (new["seuil"], new["priorite"], new["delai_s"], new["actif"], code))
    db.audit(who(), "REGLE_MODIFICATION", code, avant={k: r[k] for k in new}, apres=new, ip=_ip())
    RT.alerts.reload()
    return jsonify(ok=True)


@app.put("/api/ipe/<code>")
@require("config.ipe")
def ipe_update(code):
    b = body()
    d = db.query_one("SELECT * FROM energy_indicators WHERE code=?", (code,))
    if not d:
        abort(404)
    try:
        cible = float(b.get("cible", d["cible"]))
    except (TypeError, ValueError):
        return jsonify(error="cible invalide"), 400
    motif = (b.get("motif") or "").strip()
    if not motif:
        return jsonify(error="le motif de modification est obligatoire (traçabilité)"), 400
    desc = (b.get("description") or d["description"])[:500]
    db.execute("UPDATE energy_indicators SET cible=?, description=?, version=version+1, date_effet=? WHERE code=?",
               (cible, desc, dt.date.today().isoformat(), code))
    db.audit(who(), "IPE_MODIFICATION", code, avant={"cible": d["cible"], "version": d["version"]},
             apres={"cible": cible, "version": d["version"] + 1, "motif": motif}, ip=_ip())
    return jsonify(ok=True)


@app.post("/api/ser")
@require("config.ser")
def ser_create():
    b = body()
    variables = [v for v in b.get("variables", []) if v in energy.VARIABLES]
    motif = (b.get("motif") or "").strip()
    if not variables or not motif:
        return jsonify(error="variables et motif obligatoires"), 400
    try:
        bid = energy.create_baseline(who(), b.get("debut", "2025-01"), b.get("fin", "2025-12"), variables, motif,
                                     (b.get("hypotheses") or "")[:1000])
    except ValueError as e:
        return jsonify(error=str(e)), 400
    return jsonify(ok=True, id=bid)


@app.post("/api/ser/<int:bid>/activer")
@require("config.ser")
def ser_activate(bid):
    if not db.query_one("SELECT id FROM energy_baselines WHERE id=?", (bid,)):
        abort(404)
    db.execute("UPDATE energy_baselines SET active=CASE WHEN id=? THEN 1 ELSE 0 END", (bid,))
    db.audit(who(), "SER_ACTIVATION", f"SER id {bid}", apres={"motif": body().get("motif", "")}, ip=_ip())
    return jsonify(ok=True)


@app.post("/api/equipment/<int:eid>/test")
@require("config.compteurs")
def equipment_test(eid):
    e = db.query_one("SELECT * FROM equipment WHERE id=?", (eid,))
    if not e:
        abort(404)
    defs = db.query("SELECT * FROM measurement_definitions WHERE profil=? ORDER BY adresse", (e["profil"],))
    start = min(d["adresse"] for d in defs)
    t0 = time.time()
    try:
        regs = read_registers(C.MODBUS_HOST, C.MODBUS_PORT, e["unit_id"], start,
                              max(d["adresse"] for d in defs) + 2 - start, timeout=1.0)
    except (OSError, ModbusError) as ex:
        db.audit(who(), "TEST_COMMUNICATION", e["code"], apres={"resultat": "échec", "erreur": str(ex)}, ip=_ip())
        return jsonify(ok=False, erreur=f"Pas de réponse : {ex.__class__.__name__} {ex}")
    lat = (time.time() - t0) * 1000
    dec = decode_registers(defs, start, regs)
    res = [{"grandeur": d["grandeur"], "adresse": d["adresse"], "type": d["type"], "echelle": d["echelle"],
            "brut": regs[d["adresse"] - start:d["adresse"] - start + 2], "valeur": dec[d["grandeur"]][0],
            "unite": d["unite"], "qualite": dec[d["grandeur"]][1]} for d in defs]
    db.audit(who(), "TEST_COMMUNICATION", e["code"], apres={"resultat": "succès", "latence_ms": round(lat, 1)}, ip=_ip())
    return jsonify(ok=True, latence_ms=round(lat, 1), trame=f"FC03 Unit {e['unit_id']} @{start} ×{len(regs)}", registres=res)


@app.put("/api/equipment/<int:eid>")
@require("config.compteurs")
def equipment_update(eid):
    e = db.query_one("SELECT * FROM equipment WHERE id=?", (eid,))
    if not e:
        abort(404)
    b = body()
    fields = {k: b[k] for k in ("libelle", "fabricant", "modele", "ip", "port", "unit_id", "actif") if k in b}
    if "unit_id" in fields and not (1 <= int(fields["unit_id"]) <= 247):
        return jsonify(error="Unit ID hors plage (1-247)"), 400
    if not fields:
        return jsonify(error="aucune modification"), 400
    db.execute(f"UPDATE equipment SET {', '.join(k + '=?' for k in fields)} WHERE id=?", (*fields.values(), eid))
    db.audit(who(), "COMPTEUR_MODIFICATION", e["code"], avant={k: e[k] for k in fields}, apres=fields, ip=_ip())
    RT.acq.reload()
    return jsonify(ok=True)


@app.put("/api/definitions/<int:did>")
@require("config.compteurs")
def definition_update(did):
    d = db.query_one("SELECT * FROM measurement_definitions WHERE id=?", (did,))
    if not d:
        abort(404)
    b = body()
    try:
        new = {"adresse": int(b.get("adresse", d["adresse"])), "type": b.get("type", d["type"]),
               "echelle": float(b.get("echelle", d["echelle"])), "unite": str(b.get("unite", d["unite"]))[:12],
               "min_valide": float(b.get("min_valide", d["min_valide"])), "max_valide": float(b.get("max_valide", d["max_valide"]))}
    except (TypeError, ValueError):
        return jsonify(error="valeur invalide"), 400
    if new["type"] not in ("float32", "uint32") or not (0 <= new["adresse"] <= 65534):
        return jsonify(error="type ou adresse invalide"), 400
    db.execute("UPDATE measurement_definitions SET adresse=?, type=?, echelle=?, unite=?, min_valide=?, max_valide=? WHERE id=?",
               (*new.values(), did))
    db.audit(who(), "REGISTRE_MODIFICATION", f"{d['profil']}/{d['grandeur']}", avant={k: d[k] for k in new}, apres=new, ip=_ip())
    RT.acq.reload()
    return jsonify(ok=True)


@app.put("/api/config/acquisition")
@require("config.acquisition")
def acq_update():
    b = body()
    cur = db.get_config("acquisition", C.ACQUISITION_DEFAULT)
    new = dict(cur)
    limits = {"periode_s": (1, 60), "timeout_s": (0.1, 5), "reconnexion_s": (2, 600), "retention_brut_h": (1, 168),
              "fraicheur_s": (2, 600), "peremption_s": (10, 86400), "derive_horloge_max_s": (0.5, 300)}
    for k, (lo, hi) in limits.items():
        if k in b:
            try:
                v = float(b[k])
            except (TypeError, ValueError):
                return jsonify(error=f"{k} invalide"), 400
            if not lo <= v <= hi:
                return jsonify(error=f"{k} hors plage [{lo} ; {hi}]"), 400
            new[k] = v
    db.set_config("acquisition", new, who())
    db.audit(who(), "ACQUISITION_MODIFICATION", "system_config", avant=cur, apres=new, ip=_ip())
    RT.acq.reload()
    return jsonify(ok=True)


@app.put("/api/tarif")
@require("config.seuils")
def tarif_update():
    b = body()
    cur = db.get_config("tarif", C.TARIF_DEFAULT)
    new = dict(cur)
    for k in ("prix_pointe", "prix_pleines", "prix_creuses", "co2_kg_kwh"):
        if k in b:
            try:
                new[k] = float(b[k])
            except (TypeError, ValueError):
                return jsonify(error=f"{k} invalide"), 400
    db.set_config("tarif", new, who())
    db.audit(who(), "TARIF_MODIFICATION", "system_config", avant=cur, apres=new, ip=_ip())
    return jsonify(ok=True)


@app.put("/api/simulation")
@require("simulation.incident")
def sim_update():
    b = body()
    ctx = dict(RT.sim.ctx)
    for k in ("navire_conteneurs", "navire_vrac"):
        if k in b:
            ctx[k] = bool(b[k])
    if "grues_actives" in b:
        ctx["grues_actives"] = max(0, min(4, int(b["grues_actives"])))
    if "reefers" in b:
        ctx["reefers"] = max(0, min(260, int(b["reefers"])))
    RT.sim.set_ctx(ctx)
    db.set_config("simulation", ctx, who())
    db.audit(who(), "SIMULATION_ACTIVITE", "activité portuaire", apres=ctx, ip=_ip())
    return jsonify(ok=True, ctx=ctx)


@app.post("/api/simulation/incident")
@require("simulation.incident")
def sim_incident():
    b = body()
    pid = int(b.get("point_id", 0))
    kind = b.get("type")
    if pid not in range(1, 8) or (kind and kind not in INCIDENTS):
        return jsonify(error="paramètres invalides"), 400
    RT.sim.set_incident(pid, kind)
    db.audit(who(), "SIMULATION_INCIDENT", f"point {pid}", apres={"type": kind or "fin"}, ip=_ip())
    return jsonify(ok=True)


@app.post("/api/simulation/clear")
@require("simulation.incident")
def sim_clear():
    RT.sim.clear_incidents()
    db.audit(who(), "SIMULATION_INCIDENT", "tous", apres={"type": "fin de tous les incidents"}, ip=_ip())
    return jsonify(ok=True)


@app.post("/api/recette/run")
@require("recette.run")
def recette_run():
    if not RECETTE.start(who()):
        return jsonify(error="une recette est déjà en cours"), 409
    return jsonify(ok=True)


@app.post("/api/backup")
@require("backup.manage")
def backup_now():
    path = db.backup()
    ok, counts = db.verify_backup(path)
    db.audit(who(), "SAUVEGARDE", os.path.basename(path), apres={"integrite": ok, **counts}, ip=_ip())
    return jsonify(ok=ok, fichier=os.path.basename(path), comptages=counts)


@app.post("/api/users")
@require("users.manage")
def user_create():
    b = body()
    u = (b.get("username") or "").strip().lower()
    pw = b.get("password") or ""
    role = b.get("role")
    if not u.isalnum() or len(pw) < 10 or role not in [r[0] for r in C.ROLES]:
        return jsonify(error="identifiant alphanumérique, mot de passe ≥ 10 caractères et rôle valide requis"), 400
    if db.query_one("SELECT 1 FROM users WHERE username=?", (u,)):
        return jsonify(error="identifiant déjà utilisé"), 409
    db.execute("INSERT INTO users(username,fullname,role,pwhash,actif,cree_le) VALUES(?,?,?,?,1,?)",
               (u, (b.get("fullname") or u)[:80], role, generate_password_hash(pw), time.time()))
    db.audit(who(), "UTILISATEUR_CREATION", u, apres={"role": role}, ip=_ip())
    return jsonify(ok=True)


@app.put("/api/users/<username>")
@require("users.manage")
def user_update(username):
    r = db.query_one("SELECT * FROM users WHERE username=?", (username,))
    if not r:
        abort(404)
    b = body()
    if username == who() and ("role" in b or b.get("actif") is False):
        return jsonify(error="vous ne pouvez pas modifier votre propre rôle ni vous désactiver"), 400
    if "role" in b and b["role"] in [x[0] for x in C.ROLES]:
        db.execute("UPDATE users SET role=? WHERE username=?", (b["role"], username))
    if "actif" in b:
        db.execute("UPDATE users SET actif=? WHERE username=?", (int(bool(b["actif"])), username))
    if b.get("password"):
        if len(b["password"]) < 10:
            return jsonify(error="mot de passe ≥ 10 caractères"), 400
        db.execute("UPDATE users SET pwhash=? WHERE username=?", (generate_password_hash(b["password"]), username))
    db.audit(who(), "UTILISATEUR_MODIFICATION", username,
             avant={"role": r["role"], "actif": r["actif"]},
             apres={k: v for k, v in b.items() if k != "password"} | ({"mot_de_passe": "réinitialisé"} if b.get("password") else {}),
             ip=_ip())
    return jsonify(ok=True)


# --------------------------------------------------------------------------- #
def _permission_probe():
    """T13 : un lecteur tente de modifier un seuil -> doit recevoir 403."""
    c = app.test_client()
    with c.session_transaction() as s:
        s["user"] = {"username": "recette_lecteur", "fullname": "Sonde recette", "role": "lecteur"}
    r = c.put("/api/rules/R03", json={"seuil": 1}, headers={"X-Requested-With": "SME"})
    unchanged = db.query_one("SELECT seuil FROM alert_rules WHERE code='R03'")["seuil"] != 1
    return r.status_code, f"Réponse : {r.get_json().get('error')} ; seuil inchangé : {'oui' if unchanged else 'NON'} ; tentative journalisée (ACCES_REFUSE)"


def create_app():
    global RT, RECETTE
    restored = db.restore_latest_if_empty()
    db.init()
    energy.ensure_baseline()
    app.secret_key = _secret_key()
    RT = Runtime()
    RECETTE = Recette(RT, _permission_probe)
    energy.compute_ipe(RT.alerts)          # lève les éventuelles dérives d'IPE / écarts SER dès le démarrage
    energy.ser(RT.alerts)
    if restored:
        db.audit("systeme", "RESTAURATION", restored)
    db.audit("systeme", "DEMARRAGE", "service SME", apres={"port": C.PORT})
    log.info("SME prêt sur http://%s:%s", C.HOST, C.PORT)
    return app


if __name__ == "__main__":
    create_app()
    app.run(host=C.HOST, port=C.PORT, threaded=True, use_reloader=False)

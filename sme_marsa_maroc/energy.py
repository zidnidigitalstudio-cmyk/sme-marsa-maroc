"""
energy.py — Couche métier énergétique : consommations, tarification, IPE, SER,
données des rapports. Les calculs sont volontairement explicites et traçables.
"""
import datetime as dt
import json
import math
import time

import config as C
import db

USAGES = ["conteneurs", "services", "vrac", "grues", "reefers", "eclairage"]


# --------------------------------------------------------------------------- #
#  Outils numériques
# --------------------------------------------------------------------------- #
def solve(a, b):
    """Résolution d'un système linéaire (élimination de Gauss avec pivot partiel)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[piv][c]) < 1e-12:
            raise ValueError("système singulier (variables colinéaires ?)")
        m[c], m[piv] = m[piv], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c])]
    return [m[i][n] / m[i][i] for i in range(n)]


def ols(xs, ys):
    """Moindres carrés ordinaires y = b0 + Σ bi·xi. Renvoie (coefs, R², CV(RMSE))."""
    rows = [[1.0] + list(x) for x in xs]
    k = len(rows[0])
    xtx = [[sum(r[i] * r[j] for r in rows) for j in range(k)] for i in range(k)]
    xty = [sum(r[i] * y for r, y in zip(rows, ys)) for i in range(k)]
    beta = solve(xtx, xty)
    pred = [sum(b * v for b, v in zip(beta, r)) for r in rows]
    mean = sum(ys) / len(ys)
    ss_res = sum((y - p) ** 2 for y, p in zip(ys, pred))
    ss_tot = sum((y - mean) ** 2 for y in ys) or 1e-9
    dof = max(1, len(ys) - k)
    cv = math.sqrt(ss_res / dof) / mean * 100
    return beta, 1 - ss_res / ss_tot, cv


def months_between(a, b):
    y, m = map(int, a.split("-"))
    out = []
    while f"{y:04d}-{m:02d}" <= b:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


# --------------------------------------------------------------------------- #
#  Données mensuelles
# --------------------------------------------------------------------------- #
def monthly_table():
    act = {r["mois"]: r for r in db.query("SELECT * FROM activity_data ORDER BY mois")}
    en = {}
    for r in db.query("SELECT * FROM energy_monthly"):
        en.setdefault(r["mois"], {})[r["usage"]] = r["kwh"]
    out = []
    now = dt.datetime.now(db.TZ)
    cur = db.month_key(now)
    for mk in sorted(act):
        a = dict(act[mk])
        e = en.get(mk, {})
        a.update({u: e.get(u) for u in USAGES})
        a["total"] = sum(e.get(u, 0) for u in USAGES)
        a["en_cours"] = mk == cur
        out.append(a)
    return out


def last_complete_month():
    rows = [r for r in monthly_table() if not r["en_cours"]]
    return rows[-1]["mois"] if rows else None


# --------------------------------------------------------------------------- #
#  Tarification et énergie du jour (à partir des agrégats 1 min)
# --------------------------------------------------------------------------- #
def tarif_period(hour, tarif):
    a, b = tarif["pointe"]
    if a <= hour < b:
        return "pointe"
    c1, c2 = tarif["creuses"]
    if (c1 <= hour) or (hour < c2) if c1 > c2 else (c1 <= hour < c2):
        return "creuses"
    return "pleines"


def energy_since(ts_start, ts_end=None):
    ts_end = ts_end or time.time()
    rows = db.query(
        "SELECT a.point_id, a.ts, a.e_kwh FROM measurements_aggregated a JOIN measurement_points mp ON mp.id=a.point_id "
        "WHERE mp.inclus_agregation=1 AND a.ts>=? AND a.ts<? AND a.e_kwh IS NOT NULL", (ts_start, ts_end))
    tarif = db.get_config("tarif", C.TARIF_DEFAULT)
    by_point, by_period, by_hour = {}, {"pointe": 0.0, "pleines": 0.0, "creuses": 0.0}, [0.0] * 24
    for r in rows:
        h = dt.datetime.fromtimestamp(r["ts"], db.TZ).hour
        by_point[r["point_id"]] = by_point.get(r["point_id"], 0.0) + r["e_kwh"]
        by_period[tarif_period(h, tarif)] += r["e_kwh"]
        by_hour[h] += r["e_kwh"]
    cost = sum(by_period[k] * tarif["prix_" + k] for k in by_period)
    total = sum(by_point.values())
    return {"total_kwh": total, "par_point": by_point, "par_periode": by_period, "par_heure": by_hour,
            "cout": cost, "co2_t": total * tarif["co2_kg_kwh"] / 1000, "devise": tarif["devise"]}


def today_summary():
    now = dt.datetime.now(db.TZ)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    return energy_since(start)


# --------------------------------------------------------------------------- #
#  IPE
# --------------------------------------------------------------------------- #
def compute_ipe(alert_engine=None):
    defs = db.query("SELECT * FROM energy_indicators ORDER BY code")
    table = monthly_table()
    seuil = 5.0
    r9 = db.query_one("SELECT seuil FROM alert_rules WHERE code='R09'")
    if r9 and r9["seuil"] is not None:
        seuil = r9["seuil"]
    now = time.time()
    rows, out = [], []
    for d in defs:
        series = []
        for m in table:
            num = m["total"] if d["num"] == "total" else m.get(d["num"])
            den = m.get(d["den"])
            val = num / den if (num is not None and den) else None
            compl = 1.0 if not m["en_cours"] else round(m["jours"] / 30.4, 2)
            series.append({"mois": m["mois"], "valeur": val, "numerateur": num, "denominateur": den,
                           "en_cours": m["en_cours"], "completude": compl})
            rows.append((d["code"], m["mois"], val, num, den, compl, now))
        ref = [s["valeur"] for s in series if s["mois"].startswith("2025") and s["valeur"] is not None]
        complete = [s for s in series if not s["en_cours"] and s["valeur"] is not None]
        last = complete[-1] if complete else None
        ecart = (last["valeur"] - d["cible"]) / d["cible"] * 100 if last and d["cible"] else None
        statut = None
        if ecart is not None:
            statut = "conforme" if ecart <= 0 else ("à surveiller" if ecart <= seuil else "dérive")
            if statut == "dérive" and alert_engine:
                alert_engine.raise_once("R09", d["code"], round(ecart, 1),
                                        f"{d['code']} {last['mois']} : {last['valeur']:.2f} {d['unite']} — "
                                        f"écart {ecart:+.1f} % à la cible {d['cible']:g}")
        out.append(dict(d, serie=series, reference_2025=sum(ref) / len(ref) if ref else None,
                        dernier=last, ecart_pct=ecart, statut=statut))
    db.execute("INSERT OR REPLACE INTO indicator_values VALUES(?,?,?,?,?,?,?)", rows, many=True)
    return out


# --------------------------------------------------------------------------- #
#  SER — Situation Énergétique de Référence
#  Modèle normalisé par jour : E/j = b0 + Σ bi · (Xi/j), avec Xi variables pertinentes
# --------------------------------------------------------------------------- #
VARIABLES = {"evp": "EVP manutentionnés", "tonnes_vrac": "Tonnes vrac", "reefer_jours": "Conteneurs-jour reefer",
             "escales": "Escales", "heures_grue": "Heures de grue"}


def fit_baseline(debut, fin, variables):
    table = {m["mois"]: m for m in monthly_table()}
    months = [mk for mk in months_between(debut, fin) if mk in table and not table[mk]["en_cours"]]
    if len(months) < len(variables) + 3:
        raise ValueError("période de référence trop courte pour le nombre de variables")
    xs = [[table[mk][v] / table[mk]["jours"] for v in variables] for mk in months]
    ys = [table[mk]["total"] / table[mk]["jours"] for mk in months]
    beta, r2, cv = ols(xs, ys)
    return beta, r2, cv, len(months)


def create_baseline(username, debut, fin, variables, motif, hypotheses):
    beta, r2, cv, n = fit_baseline(debut, fin, variables)
    last = db.query_one("SELECT MAX(version) AS v FROM energy_baselines")
    version = (last["v"] or 0) + 1
    db.execute("UPDATE energy_baselines SET active=0")
    bid = db.execute(
        "INSERT INTO energy_baselines(version,libelle,periode_debut,periode_fin,variables,coefficients,r2,cv_rmse,n,"
        "hypotheses,motif,cree_par,cree_le,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
        (version, f"SER v{version} — {debut} → {fin}", debut, fin, json.dumps(variables),
         json.dumps(beta), r2, cv, n, hypotheses, motif, username, time.time()))
    db.audit(username, "SER_CREATION", f"SER v{version}", apres={"periode": [debut, fin], "variables": variables,
                                                                   "r2": round(r2, 4), "motif": motif})
    return bid


def ensure_baseline():
    if not db.query_one("SELECT id FROM energy_baselines"):
        create_baseline("systeme", "2025-01", "2025-12", ["evp", "tonnes_vrac", "reefer_jours"],
                        "Version initiale (démonstration)",
                        "Année 2025 = période de référence ; consommation totale des 6 postes normalisée par jour ; "
                        "variables pertinentes : EVP, tonnes vrac, conteneurs-jour reefer ; "
                        "compteur de tête exclu (contrôle). À valider avec le responsable énergie DEPA.")


def ser(alert_engine=None):
    base = db.query_one("SELECT * FROM energy_baselines WHERE active=1 ORDER BY version DESC LIMIT 1")
    versions = db.query("SELECT id,version,libelle,periode_debut,periode_fin,variables,r2,cv_rmse,n,motif,hypotheses,"
                        "cree_par,cree_le,active FROM energy_baselines ORDER BY version DESC")
    for v in versions:
        v["variables"] = json.loads(v["variables"])
    if not base:
        return {"active": None, "versions": versions, "serie": []}
    variables = json.loads(base["variables"])
    beta = json.loads(base["coefficients"])
    seuil = (db.query_one("SELECT seuil FROM alert_rules WHERE code='R10'") or {}).get("seuil") or 5.0
    serie, cusum = [], 0.0
    for m in monthly_table():
        pred = m["jours"] * (beta[0] + sum(b * m[v] / m["jours"] for b, v in zip(beta[1:], variables)))
        ecart = m["total"] - pred
        in_ref = base["periode_debut"] <= m["mois"] <= base["periode_fin"]
        if not in_ref and m["mois"] > base["periode_fin"]:
            cusum += ecart
        serie.append({"mois": m["mois"], "observe": m["total"], "predit": pred, "ecart_kwh": ecart,
                      "ecart_pct": ecart / pred * 100, "reference": in_ref, "en_cours": m["en_cours"],
                      "cusum": cusum if m["mois"] > base["periode_fin"] else None})
    post = [s for s in serie if s["mois"] > base["periode_fin"] and not s["en_cours"]]
    if post and alert_engine and abs(post[-1]["ecart_pct"]) > seuil:
        alert_engine.raise_once("R10", "SER", round(post[-1]["ecart_pct"], 1),
                                f"SER {post[-1]['mois']} : écart {post[-1]['ecart_pct']:+.1f} % à la référence")
    act = dict(base, variables=variables, coefficients=beta,
               libelles={v: VARIABLES.get(v, v) for v in variables})
    return {"active": act, "versions": versions, "serie": serie,
            "economie_cumulee_kwh": -cusum, "variables_disponibles": VARIABLES}


# --------------------------------------------------------------------------- #
#  Rapport mensuel de revue énergétique
# --------------------------------------------------------------------------- #
def report_data(mois, alert_engine=None):
    table = {m["mois"]: m for m in monthly_table()}
    if mois not in table:
        raise ValueError("mois indisponible")
    m = table[mois]
    posts = db.query("SELECT * FROM electrical_posts ORDER BY id")
    prev_y = f"{int(mois[:4]) - 1}{mois[4:]}"
    conso = []
    for p in posts:
        conso.append({"code": p["code"], "libelle": p["libelle"], "kwh": m.get(p["usage"]),
                      "kwh_n1": table.get(prev_y, {}).get(p["usage"]), "souscrite_kw": p["souscrite_kw"]})
    ipes = compute_ipe(alert_engine)
    ipe_rows = []
    for i in ipes:
        s = next((x for x in i["serie"] if x["mois"] == mois), None)
        if s:
            ipe_rows.append({"code": i["code"], "libelle": i["libelle"], "unite": i["unite"], "formule": i["formule"],
                             "valeur": s["valeur"], "cible": i["cible"], "reference": i["reference_2025"],
                             "statut_validation": i["statut_validation"]})
    s = ser(alert_engine)
    ser_row = next((x for x in s["serie"] if x["mois"] == mois), None)
    start = dt.datetime(int(mois[:4]), int(mois[5:]), 1, tzinfo=db.TZ).timestamp()
    y, mm = int(mois[:4]), int(mois[5:])
    end = dt.datetime(y + (mm == 12), mm % 12 + 1, 1, tzinfo=db.TZ).timestamp()
    alerts = db.query("SELECT rule_code, priorite, COUNT(*) AS n FROM alerts WHERE ts_detection>=? AND ts_detection<? "
                      "AND test=0 GROUP BY rule_code, priorite ORDER BY rule_code", (start, end))
    qual = db.query("SELECT point_id, COUNT(*) AS minutes, AVG(completude) AS completude, SUM(reconstitue) AS reconst "
                    "FROM measurements_aggregated WHERE ts>=? AND ts<? GROUP BY point_id", (start, end))
    tarif = db.get_config("tarif", C.TARIF_DEFAULT)
    total = m["total"]
    return {"mois": mois, "client": C.CLIENT, "activite": {k: m[k] for k in ("jours", "evp", "tonnes_vrac", "escales",
                                                                          "heures_grue", "reefer_jours")},
            "en_cours": m["en_cours"], "total_kwh": total, "total_kwh_n1": table.get(prev_y, {}).get("total"),
            "co2_t": total * tarif["co2_kg_kwh"] / 1000, "consommations": conso, "ipe": ipe_rows,
            "ser": ser_row, "ser_modele": s["active"], "alertes": alerts, "qualite": qual,
            "source": m.get("source"), "tarif_note": tarif["note"]}

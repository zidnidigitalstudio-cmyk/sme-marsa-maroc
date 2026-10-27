"""
engine.py — Couches terrain (simulée), acquisition et règles d'alerte.

  Simulator    : fait vivre les 7 compteurs simulés (6 postes + compteur de tête)
                 et publie leurs registres sur le serveur Modbus TCP local.
  Acquisition  : interroge chaque compteur en Modbus TCP selon la cartographie de
                 registres en base, horodate (mesure + réception), qualifie,
                 stocke le brut, agrège à la minute, gère pertes et reprises.
  AlertEngine  : évalue les règles configurées et gère le cycle de vie des alertes
                 (nouvelle -> prise en charge -> clôturée) avec historique.
"""
import collections
import datetime as dt
import json
import logging
import random
import threading
import time

import config as C
import db
import model
from modbus_tcp import (ModbusError, ModbusTCPServer, float32_to_regs, read_registers,
                        regs_to_float32, regs_to_uint32, uint32_to_regs)

log = logging.getLogger("sme")
INCIDENTS = {
    "coupure": "Coupure de communication Modbus",
    "surcharge": "Surcharge (dépassement de puissance souscrite)",
    "tension_basse": "Chute de tension",
    "pf_bas": "Facteur de puissance dégradé",
    "harmoniques": "Pollution harmonique",
    "valeur_invalide": "Valeur hors plage (registre corrompu)",
    "horloge": "Dérive de l'horloge du compteur",
}


def encode_registers(defs, values):
    regs = {}
    for d in defs:
        v = values.get(d["grandeur"])
        if v is None:
            continue
        raw = v / d["echelle"]
        words = float32_to_regs(raw) if d["type"] == "float32" else uint32_to_regs(round(raw))
        regs[d["adresse"]] = words[0]
        regs[d["adresse"] + 1] = words[1]
    return regs


def decode_registers(defs, start, regs):
    """Décode un bloc de registres selon les définitions. Renvoie {grandeur: (valeur|None, qualité)}."""
    out = {}
    for d in defs:
        i = d["adresse"] - start
        if i < 0 or i + 1 >= len(regs):
            out[d["grandeur"]] = (None, "absente")
            continue
        if d["type"] == "float32":
            raw = regs_to_float32(regs[i], regs[i + 1])
        elif d["type"] == "uint32":
            raw = regs_to_uint32(regs[i], regs[i + 1])
        else:
            out[d["grandeur"]] = (None, "absente")
            continue
        v = raw * d["echelle"]
        if v != v or not (d["min_valide"] <= v <= d["max_valide"]):   # NaN ou hors plage
            out[d["grandeur"]] = (v if v == v else None, "invalide")
        else:
            out[d["grandeur"]] = (v, "valide")
    return out


def classify(decoded, ts_reception, derive_max, history):
    """Qualification d'une lecture : valide / suspecte / invalide (+ motifs)."""
    motifs = []
    key = ("P", "U", "PF", "E")
    if any(decoded.get(k, (None, "absente"))[1] == "absente" for k in key):
        motifs.append("grandeur absente")
    inval = [k for k, (_, q) in decoded.items() if q == "invalide"]
    if inval:
        motifs.append("hors plage : " + ", ".join(inval))
    ts_v, ts_q = decoded.get("TS", (None, "absente"))
    ts_mesure = ts_v if ts_q == "valide" else ts_reception
    if ts_q == "valide" and abs(ts_reception - ts_v) > derive_max:
        motifs.append(f"dérive horloge {ts_reception - ts_v:+.1f} s")
    p = decoded.get("P", (None, ""))[0]
    if p is not None and len(history) >= 5 and all(h == p for h in history[-5:]):
        motifs.append("valeur figée")
    e = decoded.get("E", (None, ""))[0]
    if e is not None and history and getattr(history, "last_e", None) and e < history.last_e - 0.05:
        motifs.append("index énergie décroissant")
    if any(m.startswith("hors plage") or m == "grandeur absente" for m in motifs):
        q = "invalide"
    elif motifs:
        q = "suspecte"
    else:
        q = "valide"
    return q, motifs, ts_mesure


class _Hist(list):
    last_e = None


# --------------------------------------------------------------------------- #
class Simulator:
    def __init__(self, server):
        self.server = server
        self.rnd = random.Random()
        self.lock = threading.Lock()
        self.incidents = {}              # point_id -> type
        self.ctx = db.get_config("simulation")
        self.posts = db.query("SELECT * FROM electrical_posts ORDER BY id")
        defs = db.query("SELECT * FROM measurement_definitions ORDER BY adresse")
        # Les compteurs simulés suivent leur « documentation constructeur » (config.py),
        # indépendante de la cartographie administrée en base.
        self.device_defs = {}
        for d in C.MEASUREMENT_DEFINITIONS:
            row = dict(zip(("grandeur", "adresse", "type", "echelle", "unite", "description", "min_valide", "max_valide"), d))
            self.device_defs.setdefault("PM800-DEMO", []).append(row)
        self.device_defs["PM800-MT-DEMO"] = [dict(r) for r in self.device_defs["PM800-DEMO"]]
        saved = db.get_config("dernier_index", {}) or {}
        self.index = {i: float(saved.get(str(i), 1_000_000.0)) for i in range(1, 8)}
        gap_h = max(0.0, (time.time() - saved.get("_ts", time.time())) / 3600)
        if gap_h > 0.02:                       # machine arrêtée : les compteurs réels ont continué à compter
            for p in self.posts:
                self.index[p["id"]] += 0.42 * p["souscrite_kw"] * gap_h
            self.index[7] += sum(0.42 * p["souscrite_kw"] for p in self.posts) * gap_h * 1.012
        self.clock_offset = {6: 1.3}           # légère dérive d'horloge du compteur P6
        self.last_t = time.time()
        self.values = {}
        self.crane_states = []
        self._saved = time.time()

    def set_ctx(self, ctx):
        with self.lock:
            self.ctx = ctx

    def set_incident(self, point_id, kind):
        with self.lock:
            if kind:
                self.incidents[point_id] = kind
            else:
                self.incidents.pop(point_id, None)
            self.server.set_online(point_id, self.incidents.get(point_id) != "coupure")

    def clear_incidents(self):
        with self.lock:
            for pid in list(self.incidents):
                self.server.set_online(pid, True)
            self.incidents.clear()

    def step(self):
        now = time.time()
        dts = max(0.0, min(now - self.last_t, 5.0))
        self.last_t = now
        loc = dt.datetime.now(db.TZ)
        hour = loc.hour + loc.minute / 60 + loc.second / 3600
        with self.lock:
            ctx = dict(self.ctx)
            inc = dict(self.incidents)
        vals = []
        for p in self.posts:
            pk, pf = model.usage_power(p, hour, loc.weekday(), ctx, t=now, rnd=self.rnd)
            kind = inc.get(p["id"])
            if kind == "surcharge":
                pk = p["souscrite_kw"] * (1.06 + 0.02 * self.rnd.random())
            if kind == "pf_bas":
                pf = 0.72 + 0.02 * self.rnd.random()
            v = model.electrical_values(p, pk, pf, self.rnd)
            if kind == "tension_basse":
                v["U"] = 342 + self.rnd.gauss(0, 2)
            if kind == "harmoniques":
                v["THD"] = 9.6 + self.rnd.gauss(0, 0.3)
            vals.append(v)
        head = model.head_values(vals, self.rnd)
        out = {}
        for pid, v in list(enumerate(vals, start=1)) + [(7, head)]:
            self.index[pid] += v["P"] * dts / 3600.0
            v = dict(v)
            v["E"] = self.index[pid]
            v["TS"] = now + self.clock_offset.get(pid, 0.0) + (40.0 if inc.get(pid) == "horloge" else 0.0)
            if inc.get(pid) == "valeur_invalide":
                v["PF"] = 1.73
            profil = "PM800-MT-DEMO" if pid == 7 else "PM800-DEMO"
            self.server.set_registers(pid, encode_registers(self.device_defs[profil], v))
            out[pid] = v
        self.values = out
        working = ctx["navire_conteneurs"] or ctx["navire_vrac"]
        self.crane_states = []
        for i in range(4):
            if i >= ctx["grues_actives"]:
                self.crane_states.append({"grue": f"GM-0{i + 1}", "phase": "Hors service", "kw": 0, "progress": 0})
            elif not working:
                self.crane_states.append({"grue": f"GM-0{i + 1}", "phase": "En attente navire", "kw": model.CRANE_IDLE_KW, "progress": 0})
            else:
                name, kw, prog = model.crane_phase(i, now)
                self.crane_states.append({"grue": f"GM-0{i + 1}", "phase": name, "kw": kw, "progress": round(prog, 2)})
        if now - self._saved > 60:
            self._saved = now
            snap = {str(k): v for k, v in self.index.items()}
            snap["_ts"] = now
            db.set_config("dernier_index", snap)

    def run(self):
        while True:
            try:
                self.step()
            except Exception:                  # le simulateur ne doit jamais s'arrêter
                log.exception("simulateur")
            time.sleep(1.0)


# --------------------------------------------------------------------------- #
class AlertEngine:
    def __init__(self):
        self.lock = threading.RLock()
        self.rules = {}
        self.pending = {}                       # (rule, point) -> premier constat
        self.active = {}                        # (rule, point) -> alert id
        for a in db.query("SELECT id, rule_code, point_id FROM alerts WHERE condition_active=1 AND test=0"):
            self.active[(a["rule_code"], a["point_id"])] = a["id"]
        self.reload()

    def reload(self):
        with self.lock:
            self.rules = {r["code"]: r for r in db.query("SELECT * FROM alert_rules")}

    def _raise(self, rule, point_id, post_id, equipement, valeur, message, test=0):
        now = time.time()
        aid = db.execute(
            "INSERT INTO alerts(rule_code,type,point_id,post_id,equipement,ts_detection,valeur,seuil,regle,priorite,message,etat,condition_active,test) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,'nouvelle',?,?)",
            (rule["code"], rule["type"], point_id, post_id, equipement, now, valeur, rule["seuil"],
             rule["libelle"], rule["priorite"], message, 0 if test else 1, test))
        db.execute("INSERT INTO alert_events(alert_id,ts,username,action,commentaire) VALUES(?,?,?,?,?)",
                   (aid, now, "moteur d'alertes", "DETECTION", message))
        return aid

    def _end(self, key):
        aid = self.active.pop(key, None)
        if aid:
            now = time.time()
            db.execute("UPDATE alerts SET condition_active=0, ts_fin_condition=? WHERE id=?", (now, aid))
            db.execute("INSERT INTO alert_events(alert_id,ts,username,action,commentaire) VALUES(?,?,?,?,?)",
                       (aid, now, "moteur d'alertes", "FIN_CONDITION", "Retour à la normale"))

    def check(self, code, point_id, cond, clear, value, ctx):
        """cond : condition de déclenchement ; clear : condition de retour (hystérésis)."""
        with self.lock:
            rule = self.rules.get(code)
            if not rule:
                return
            key = (code, point_id)
            if not rule["actif"]:
                self._end(key)
                return
            if cond:
                first = self.pending.setdefault(key, time.time())
                if key not in self.active and time.time() - first >= (rule["delai_s"] or 0):
                    self.active[key] = self._raise(rule, point_id, ctx.get("post_id"), ctx.get("equipement"),
                                                   value, ctx["message"])
            else:
                self.pending.pop(key, None)
                if key in self.active and clear:
                    self._end(key)

    def raise_once(self, code, equipement, valeur, message):
        """Alertes calculées (IPE/SER) : une seule alerte ouverte par objet et par message."""
        with self.lock:
            rule = self.rules.get(code)
            if not rule or not rule["actif"]:
                return None
            if db.query_one("SELECT id FROM alerts WHERE rule_code=? AND equipement=? AND message=? AND etat!='cloturee'",
                            (code, equipement, message)):
                return None
            return self._raise(rule, None, None, equipement, valeur, message)

    def raise_test(self, username):
        rule = {"code": "TEST", "type": "TEST", "seuil": None, "libelle": "Règle de test (recette T10)", "priorite": "mineure"}
        aid = self._raise(rule, None, None, "Recette", None, "Alerte de test générée par la recette", test=1)
        db.audit(username, "ALERTE_TEST", f"alerte #{aid}")
        return aid

    def evaluate(self, point, post, reading, stats):
        """Évalue les règles temps réel pour un point de comptage."""
        pid = point["id"]
        eqp = point["equipement"]
        r = self.rules
        ctxb = {"post_id": point["post_id"], "equipement": eqp}
        # R01 — absence de communication
        age = time.time() - (stats.get("last_ok") or time.time())
        lost = reading["qualite"] == "perdue"
        self.check("R01", pid, lost and stats["consec_fail"] >= 1, not lost, round(age, 1),
                   dict(ctxb, message=f"{eqp} : pas de réponse Modbus depuis {age:.0f} s"))
        if lost:
            return
        # R02 — donnée manquante ou invalide
        bad = reading["qualite"] == "invalide"
        self.check("R02", pid, bad, not bad, None,
                   dict(ctxb, message=f"{eqp} : mesure invalide ({'; '.join(reading['motifs'])})"))
        v = {k: x["v"] for k, x in reading["valeurs"].items() if x["q"] == "valide"}
        hyst = 0.03
        if post:
            sous = post["souscrite_kw"]
            if "P" in v:
                ch = v["P"] / sous * 100
                s4 = r.get("R04", {}).get("seuil") or 100
                s3 = r.get("R03", {}).get("seuil") or 90
                self.check("R04", pid, ch >= s4, ch < s4 * (1 - hyst), round(ch, 1),
                           dict(ctxb, message=f"{post['code']} : charge {ch:.0f} % de la puissance souscrite ({v['P']:.0f} kW / {sous:.0f} kW)"))
                self.check("R03", pid, s3 <= ch < s4, ch < s3 * (1 - hyst) or ch >= s4, round(ch, 1),
                           dict(ctxb, message=f"{post['code']} : charge élevée {ch:.0f} % ({v['P']:.0f} kW)"))
            if "U" in v:
                s6 = r.get("R06", {}).get("seuil") or 360
                s7 = r.get("R07", {}).get("seuil") or 440
                self.check("R06", pid, v["U"] < s6, v["U"] > s6 * (1 + hyst / 3), round(v["U"], 1),
                           dict(ctxb, message=f"{post['code']} : tension basse {v['U']:.0f} V"))
                self.check("R07", pid, v["U"] > s7, v["U"] < s7 * (1 - hyst / 3), round(v["U"], 1),
                           dict(ctxb, message=f"{post['code']} : tension haute {v['U']:.0f} V"))
        if "PF" in v:
            s5 = r.get("R05", {}).get("seuil") or 0.85
            self.check("R05", pid, v["PF"] < s5, v["PF"] >= s5 + 0.01, round(v["PF"], 3),
                       dict(ctxb, message=f"{eqp} : facteur de puissance {v['PF']:.2f}"))
        if "THD" in v:
            s8 = r.get("R08", {}).get("seuil") or 8
            self.check("R08", pid, v["THD"] > s8, v["THD"] < s8 * (1 - hyst), round(v["THD"], 2),
                       dict(ctxb, message=f"{eqp} : THD-U {v['THD']:.1f} %"))


# --------------------------------------------------------------------------- #
class Acquisition:
    def __init__(self, alerts):
        self.alerts = alerts
        self.lock = threading.RLock()
        self.latest = {}
        self.stats = {}
        self.hist = collections.defaultdict(_Hist)
        self.buffers = collections.defaultdict(list)
        self.cycle_durations = collections.deque(maxlen=60)
        self.cycle_starts = collections.deque(maxlen=60)
        self.minute = int(time.time() // 60 * 60)
        self.last_prune = 0
        self.started = time.time()
        self.reload()

    def reload(self):
        with self.lock:
            self.cfg = db.get_config("acquisition", C.ACQUISITION_DEFAULT)
            self.points = db.query(
                "SELECT mp.id, mp.post_id, mp.role, mp.inclus_agregation, mp.code AS point_code, e.code AS equipement, "
                "e.unit_id, e.profil, e.ip, e.port, e.actif FROM measurement_points mp JOIN equipment e ON e.id=mp.equipment_id "
                "ORDER BY mp.id")
            self.posts = {p["id"]: p for p in db.query("SELECT * FROM electrical_posts")}
            self.defs = {}
            for d in db.query("SELECT * FROM measurement_definitions ORDER BY adresse"):
                self.defs.setdefault(d["profil"], []).append(d)
            for p in self.points:
                self.stats.setdefault(p["id"], {"polls": 0, "ok": 0, "suspectes": 0, "invalides": 0, "perdues": 0,
                                                "consec_fail": 0, "next_try": 0, "last_ok": None, "lat_ms": None,
                                                "etat": "initialisation"})

    def poll(self, point):
        defs = self.defs.get(point["profil"], [])
        if not defs:
            return None
        start = min(d["adresse"] for d in defs)
        count = max(d["adresse"] for d in defs) + 2 - start
        t0 = time.time()
        try:
            regs = read_registers(C.MODBUS_HOST, C.MODBUS_PORT, point["unit_id"], start, count,
                                  timeout=float(self.cfg.get("timeout_s", 0.6)))
            err = None
        except (OSError, ModbusError) as e:
            regs, err = None, (str(e) or e.__class__.__name__)
        t_rec = time.time()
        if regs is None:
            return {"point_id": point["id"], "ts_mesure": None, "ts_reception": t_rec, "valeurs": {},
                    "qualite": "perdue", "motifs": [f"pas de réponse ({err})"], "latence_ms": None}
        dec = decode_registers(defs, start, regs)
        h = self.hist[point["id"]]
        q, motifs, ts_m = classify(dec, t_rec, float(self.cfg.get("derive_horloge_max_s", 5)), h)
        p = dec.get("P", (None, ""))[0]
        h.append(p)
        del h[:-6]
        if dec.get("E", (None, ""))[1] == "valide":
            h.last_e = dec["E"][0]
        units = {d["grandeur"]: d["unite"] for d in defs}
        return {"point_id": point["id"], "ts_mesure": ts_m, "ts_reception": t_rec,
                "valeurs": {g: {"v": v, "q": qq, "u": units.get(g, "")} for g, (v, qq) in dec.items() if g != "TS"},
                "qualite": q, "motifs": motifs, "latence_ms": round((t_rec - t0) * 1000, 1)}

    def cycle(self):
        t0 = time.time()
        self.cycle_starts.append(t0)
        raw_rows = []
        with self.lock:
            points = [p for p in self.points if p["actif"]]
        for pt in points:
            st = self.stats[pt["id"]]
            if st["consec_fail"] >= 3 and t0 < st["next_try"]:
                st["etat"] = "reconnexion"
                rd = dict(self.latest.get(pt["id"], {}), qualite="perdue",
                          motifs=[f"reconnexion dans {st['next_try'] - t0:.0f} s"])
                rd.setdefault("valeurs", {})
                rd.setdefault("point_id", pt["id"])
                self.alerts.evaluate(pt, self.posts.get(pt["post_id"]), rd, st)
                continue
            rd = self.poll(pt)
            if rd is None:
                continue
            st["polls"] += 1
            if rd["qualite"] == "perdue":
                st["perdues"] += 1
                st["consec_fail"] += 1
                st["etat"] = "perte de communication"
                if st["consec_fail"] >= 3:
                    st["next_try"] = t0 + float(self.cfg.get("reconnexion_s", 10))
                prev = self.latest.get(pt["id"])
                if prev and prev.get("ts_mesure"):        # on garde la dernière valeur connue (horodatée)
                    rd = dict(prev, qualite="perdue", motifs=rd["motifs"], latence_ms=None,
                              ts_tentative=rd["ts_reception"])
            else:
                st["consec_fail"] = 0
                st["ok"] += 1
                st["last_ok"] = rd["ts_reception"]
                st["lat_ms"] = rd["latence_ms"] if st["lat_ms"] is None else round(0.8 * st["lat_ms"] + 0.2 * rd["latence_ms"], 1)
                st["suspectes"] += rd["qualite"] == "suspecte"
                st["invalides"] += rd["qualite"] == "invalide"
                st["etat"] = "en ligne"
                self.buffers[pt["id"]].append(rd)
                raw_rows.append((pt["id"], round(rd["ts_mesure"], 3), rd["ts_reception"],
                                 json.dumps({g: [x["v"], x["q"]] for g, x in rd["valeurs"].items()}),
                                 rd["qualite"], "; ".join(rd["motifs"])))
            self.latest[pt["id"]] = rd
            self.alerts.evaluate(pt, self.posts.get(pt["post_id"]), rd, st)
        if raw_rows:
            db.execute("INSERT OR IGNORE INTO measurements_raw(point_id,ts_mesure,ts_reception,valeurs,qualite,motif) "
                       "VALUES(?,?,?,?,?,?)", raw_rows, many=True)
        m = int(time.time() // 60 * 60)
        if m > self.minute:
            self.aggregate(self.minute)
            self.minute = m
        if t0 - self.last_prune > 600:
            self.last_prune = t0
            keep = float(self.cfg.get("retention_brut_h", 6)) * 3600
            db.execute("DELETE FROM measurements_raw WHERE ts_reception < ?", (t0 - keep,))
        self.cycle_durations.append(time.time() - t0)

    def aggregate(self, minute_ts):
        rows = []
        per = float(self.cfg.get("periode_s", 2))
        expected = max(1, round(60 / per))
        sums = {}
        for pt in self.points:
            buf = [r for r in self.buffers.pop(pt["id"], []) if r["qualite"] in ("valide", "suspecte")]
            prev = db.query_one("SELECT ts, e_index FROM measurements_aggregated WHERE point_id=? AND e_index IS NOT NULL "
                                "ORDER BY ts DESC LIMIT 1", (pt["id"],))
            if not buf:
                rows.append((pt["id"], minute_ts, None, None, None, None, None, None, None, None, None, None,
                             0, expected, 0.0, 0))
                continue

            def avg(g):
                xs = [r["valeurs"][g]["v"] for r in buf if g in r["valeurs"] and r["valeurs"][g]["q"] == "valide"]
                return sum(xs) / len(xs) if xs else None

            ps = [r["valeurs"]["P"]["v"] for r in buf if r["valeurs"].get("P", {}).get("q") == "valide"]
            idx = [r["valeurs"]["E"]["v"] for r in buf if r["valeurs"].get("E", {}).get("q") == "valide"]
            e_index = idx[-1] if idx else None
            e_kwh, reconst = None, 0
            if e_index is not None and prev:
                e_kwh = max(0.0, e_index - prev["e_index"])
                reconst = 1 if minute_ts - prev["ts"] > 60 else 0       # énergie reconstituée sur la lacune
            p_moy = avg("P")
            rows.append((pt["id"], minute_ts, p_moy, max(ps) if ps else None, avg("Q"), avg("PF"), avg("U"),
                         avg("I"), avg("F"), avg("THD"), e_index, e_kwh, len(buf), expected,
                         round(min(1.0, len(buf) / expected), 3), reconst))
            sums[pt["id"]] = p_moy
        db.execute("INSERT OR IGNORE INTO measurements_aggregated VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows, many=True)
        # R11 — cohérence compteur de tête / somme des postes (contrôle du double comptage)
        head = [p for p in self.points if p["role"] == "tete"]
        incl = [p for p in self.points if p["inclus_agregation"]]
        if head and sums.get(head[0]["id"]) and all(sums.get(p["id"]) for p in incl):
            s = sum(sums[p["id"]] for p in incl)
            ecart = (sums[head[0]["id"]] - s) / sums[head[0]["id"]] * 100
            seuil = (self.alerts.rules.get("R11") or {}).get("seuil") or 5
            self.alerts.check("R11", head[0]["id"], abs(ecart) > seuil, abs(ecart) <= seuil, round(ecart, 2),
                              {"post_id": None, "equipement": head[0]["equipement"],
                               "message": f"Écart tête/postes {ecart:+.1f} % (pertes attendues ≈ 1,2 %)"})
            with self.lock:
                self.coherence = {"ts": minute_ts, "tete_kw": sums[head[0]["id"]], "somme_postes_kw": s, "ecart_pct": ecart}

    def run(self):
        while True:
            t0 = time.time()
            try:
                self.cycle()
            except Exception:
                log.exception("acquisition")
            per = float(self.cfg.get("periode_s", 2))
            time.sleep(max(0.05, per - (time.time() - t0)))


# --------------------------------------------------------------------------- #
class Runtime:
    """Démarre et regroupe les services de fond."""

    def __init__(self):
        self.server = ModbusTCPServer(C.MODBUS_HOST, C.MODBUS_PORT)
        self.sim = Simulator(self.server)
        self.sim.step()
        self.server.start()
        self.alerts = AlertEngine()
        self.acq = Acquisition(self.alerts)
        self.acq.coherence = None
        self.started = time.time()
        threading.Thread(target=self.sim.run, name="simulateur", daemon=True).start()
        threading.Thread(target=self.acq.run, name="acquisition", daemon=True).start()
        threading.Thread(target=self._housekeeping, name="sauvegarde", daemon=True).start()

    def _housekeeping(self):
        while True:
            time.sleep(600)
            try:
                db.backup()
            except Exception:
                log.exception("sauvegarde")

"""
recette.py — Exécution automatique du plan de tests de la spécification (§8, T01 à T15).
Chaque essai renvoie : statut (conforme / non conforme / manuel), mesure et preuve.
"""
import json
import os
import struct
import tempfile
import threading
import time

import config as C
import db
import energy
from modbus_tcp import ModbusError, float32_to_regs, read_registers, regs_to_float32, uint32_to_regs, regs_to_uint32
from engine import decode_registers

TESTS = [
    ("T01", "Connectivité Modbus TCP/IP", "Le compteur configuré répond selon ses spécifications."),
    ("T02", "Vérification des registres", "Valeurs, unités, signes et facteurs d'échelle vérifiés sur un échantillon."),
    ("T03", "Horodatage", "La mesure et sa date de réception sont enregistrées correctement."),
    ("T04", "Perte de communication", "L'incident est visible et signalé conformément à la règle configurée."),
    ("T05", "Reprise après coupure", "La collecte reprend sans duplication non maîtrisée."),
    ("T06", "Tableau de bord", "Les données du poste et du compteur sont consultables."),
    ("T07", "Historique", "La recherche par période renvoie les mesures disponibles."),
    ("T08", "Calcul énergétique", "Les résultats sont conformes aux formules et jeux d'essai validés."),
    ("T09", "IPE et SER", "Les calculs et comparaisons sont traçables et vérifiables."),
    ("T10", "Alertes", "Une règle de test génère une alerte et son historique."),
    ("T11", "Reporting", "Le rapport présente le périmètre, la période, les unités et les indicateurs validés."),
    ("T12", "Intégration existante", "Les points existants sont intégrés sans double comptage."),
    ("T13", "Habilitations", "Un utilisateur ne peut pas exécuter une action non autorisée."),
    ("T14", "Sauvegarde/restauration", "La procédure est documentée et le test de restauration est concluant."),
    ("T15", "Formation", "Les exploitants réalisent les opérations principales après formation."),
]


class Recette:
    def __init__(self, rt, permission_probe):
        self.rt = rt
        self.probe = permission_probe          # callable() -> (code_http, détail)
        self.lock = threading.Lock()
        self.state = {"en_cours": False, "progression": 0, "etape": "", "resultats": [], "ts": None}

    def start(self, username):
        with self.lock:
            if self.state["en_cours"]:
                return False
            self.state = {"en_cours": True, "progression": 0, "etape": "Démarrage", "resultats": [], "ts": time.time(),
                          "par": username}
        threading.Thread(target=self._run, args=(username,), daemon=True).start()
        return True

    def _res(self, code, ok, mesure, preuve, statut=None):
        t = next(t for t in TESTS if t[0] == code)
        r = {"id": code, "test": t[1], "attendu": t[2], "statut": statut or ("conforme" if ok else "non conforme"),
             "mesure": mesure, "preuve": preuve}
        with self.lock:
            self.state["resultats"].append(r)
            self.state["progression"] = round(len(self.state["resultats"]) / len(TESTS) * 100)
        return r

    def _step(self, label):
        with self.lock:
            self.state["etape"] = label

    def _run(self, username):
        acq, sim, alerts = self.rt.acq, self.rt.sim, self.rt.alerts
        try:
            self._step("T01 — interrogation des compteurs")
            eqs = db.query("SELECT e.*, mp.id AS point_id FROM equipment e JOIN measurement_points mp ON mp.equipment_id=e.id "
                           "WHERE e.actif=1 ORDER BY e.id")
            ok_n, lat, fails = 0, [], []
            for e in eqs:
                t0 = time.time()
                try:
                    read_registers(C.MODBUS_HOST, C.MODBUS_PORT, e["unit_id"], 3000, 20, timeout=1.0)
                    ok_n += 1
                    lat.append((time.time() - t0) * 1000)
                except (OSError, ModbusError) as ex:
                    fails.append(f"{e['code']} ({ex.__class__.__name__})")
            self._res("T01", ok_n == len(eqs), f"{ok_n}/{len(eqs)} compteurs répondent — latence moy. {sum(lat) / max(1, len(lat)):.1f} ms",
                      "Lecture FC03 de 20 registres à partir de 3000 sur chaque Unit ID" + (f" ; échecs : {', '.join(fails)}" if fails else ""))

            self._step("T02 — cohérence registres / unités / échelles")
            checks, errs = 0, []
            for e in eqs:
                defs = db.query("SELECT * FROM measurement_definitions WHERE profil=? ORDER BY adresse", (e["profil"],))
                start = min(d["adresse"] for d in defs)
                try:
                    regs = read_registers(C.MODBUS_HOST, C.MODBUS_PORT, e["unit_id"], start,
                                          max(d["adresse"] for d in defs) + 2 - start, timeout=1.0)
                except (OSError, ModbusError):
                    errs.append(f"{e['code']} : illisible")
                    continue
                v = {g: x for g, x in decode_registers(defs, start, regs).items()}
                P, S, PF = v["P"][0], v["S"][0], v["PF"][0]
                checks += 1
                if any(q != "valide" for _, q in v.values()):
                    errs.append(f"{e['code']} : grandeur hors plage")
                if P is not None and S and PF and abs(P - S * PF) / max(S, 1) > 0.02:
                    errs.append(f"{e['code']} : P ≠ S·PF")
                if P is not None and P < 0:
                    errs.append(f"{e['code']} : signe P négatif")
                sim_e = sim.index.get(e["unit_id"])
                if sim_e and abs(v["E"][0] - sim_e) > 5:
                    errs.append(f"{e['code']} : échelle index énergie")
            rt_test = regs_to_float32(*float32_to_regs(1234.5)) == 1234.5 and regs_to_uint32(*uint32_to_regs(4_000_000_001)) == 4_000_000_001
            self._res("T02", not errs and rt_test, f"{checks} compteurs contrôlés, {len(errs)} anomalie(s)",
                      "Contrôles : plages min/max, P = S·PF (±2 %), signe de P, index × 0,1 kWh vs compteur, "
                      "aller-retour float32/uint32" + (" ; " + " ; ".join(errs) if errs else ""))

            self._step("T03 — double horodatage")
            rows = db.query("SELECT point_id, ts_mesure, ts_reception FROM measurements_raw ORDER BY id DESC LIMIT 70")
            skew = [r["ts_reception"] - r["ts_mesure"] for r in rows]
            maxs = max((abs(s) for s in skew), default=None)
            okh = bool(rows) and all(r["ts_mesure"] and r["ts_reception"] for r in rows)
            lim = db.get_config("acquisition", C.ACQUISITION_DEFAULT)["derive_horloge_max_s"]
            self._res("T03", okh and maxs is not None and maxs <= lim,
                      f"{len(rows)} mesures brutes avec horodatage mesure + réception ; écart max {maxs:.2f} s" if maxs is not None else "aucune mesure",
                      f"Table measurements_raw (ts_mesure = registre TS du compteur, ts_reception = horloge serveur) ; tolérance {lim} s")

            self._step("T04 — coupure de communication simulée sur P2 (≈ 10 s)")
            rule = db.query_one("SELECT * FROM alert_rules WHERE code='R01'")
            t_cut = time.time()
            sim.set_incident(2, "coupure")
            aid = None
            while time.time() - t_cut < (rule["delai_s"] or 6) + 10:
                time.sleep(0.5)
                a = db.query_one("SELECT id, ts_detection FROM alerts WHERE rule_code='R01' AND point_id=2 AND ts_detection>=?", (t_cut,))
                if a:
                    aid = a
                    break
            visible = acq.latest.get(2, {}).get("qualite") == "perdue"
            self._res("T04", bool(aid) and visible,
                      f"Alerte R01 #{aid['id']} levée {aid['ts_detection'] - t_cut:.1f} s après la coupure (délai règle {rule['delai_s']:g} s)" if aid else "Aucune alerte",
                      "Incident « coupure » injecté sur le compteur CPT-P2 ; état « perdue » visible dans le tableau de bord")

            self._step("T05 — reprise après coupure")
            before = db.query_one("SELECT COUNT(*) AS n, COUNT(DISTINCT ts_mesure) AS d FROM measurements_raw WHERE point_id=2")
            sim.set_incident(2, None)
            t_back = time.time()
            back = None
            while time.time() - t_back < float(acq.cfg.get("reconnexion_s", 10)) + 8:
                time.sleep(0.5)
                st = acq.stats.get(2, {})
                if st.get("consec_fail") == 0 and (st.get("last_ok") or 0) > t_back:
                    back = st["last_ok"] - t_back
                    break
            dup = db.query_one("SELECT COUNT(*) AS n FROM (SELECT point_id, ts_mesure FROM measurements_raw GROUP BY point_id, ts_mesure HAVING COUNT(*)>1)")["n"]
            dup_agg = db.query_one("SELECT COUNT(*) AS n FROM (SELECT point_id, ts FROM measurements_aggregated GROUP BY point_id, ts HAVING COUNT(*)>1)")["n"]
            self._res("T05", back is not None and dup == 0 and dup_agg == 0,
                      f"Reprise en {back:.1f} s ; doublons brut = {dup}, agrégé = {dup_agg}" if back is not None else "Pas de reprise",
                      "Clés uniques (point, horodatage) ; l'énergie de la lacune est reconstituée par différence d'index (agrégats marqués « reconstitué »)")

            self._step("T06 — tableau de bord")
            fresh = [pid for pid, r in acq.latest.items() if r.get("ts_reception") and time.time() - r["ts_reception"] < 10]
            self._res("T06", len(fresh) >= len(eqs), f"{len(fresh)}/{len(eqs)} points avec mesure fraîche (< 10 s)",
                      "API /api/live : valeurs, unités, qualité, âge de la mesure par point de comptage")

            self._step("T07 — historique")
            since = int(time.time()) - 86400
            n = db.query_one("SELECT COUNT(*) AS n, SUM(n_valides>0) AS v FROM measurements_aggregated WHERE point_id=1 AND ts>=?", (since,))
            self._res("T07", (n["n"] or 0) >= 1380, f"{n['n']} minutes trouvées sur 24 h pour P1 ({n['v']} avec données)",
                      "Requête par période/point sur measurements_aggregated (index sur ts)")

            self._step("T08 — calculs énergétiques")
            h = db.query("SELECT ts, p_moy, e_kwh FROM measurements_aggregated WHERE point_id=1 AND ts>=? AND p_moy IS NOT NULL "
                         "AND e_kwh IS NOT NULL ORDER BY ts", (int(time.time()) - 3600 * 6,))
            e_idx = sum(r["e_kwh"] for r in h)
            e_int = sum(r["p_moy"] / 60 for r in h)
            ecart = abs(e_idx - e_int) / max(e_int, 1) * 100
            tarif = {"pointe": [17, 22], "creuses": [22, 7]}
            jeu = [energy.tarif_period(h_, tarif) for h_ in (3, 9, 18, 23)] == ["creuses", "pleines", "pointe", "creuses"]
            beta, r2, _ = energy.ols([[1], [2], [3], [4]], [3, 5, 7, 9])
            jeu2 = abs(beta[0] - 1) < 1e-9 and abs(beta[1] - 2) < 1e-9
            self._res("T08", ecart < 3 and jeu and jeu2,
                      f"Énergie 6 h P1 : index {e_idx:.0f} kWh vs ∫P·dt {e_int:.0f} kWh (écart {ecart:.2f} %)",
                      "Jeux d'essai : périodes tarifaires (3 h, 9 h, 18 h, 23 h) et régression y = 1 + 2x vérifiés")

            self._step("T09 — IPE et SER")
            ipes = energy.compute_ipe(alerts)
            mois = energy.last_complete_month()
            tab = {m["mois"]: m for m in energy.monthly_table()}
            i1 = next(i for i in ipes if i["code"] == "IPE-01")
            manual = tab[mois]["conteneurs"] / tab[mois]["evp"]
            stored = db.query_one("SELECT valeur FROM indicator_values WHERE code='IPE-01' AND periode=?", (mois,))["valeur"]
            s = energy.ser(alerts)
            a = s["active"]
            self._res("T09", abs(manual - stored) < 1e-9 and a and a["r2"] >= 0.75,
                      f"IPE-01 {mois} recalculé = {manual:.3f} (stocké {stored:.3f}) ; SER v{a['version']} R² = {a['r2']:.3f}, CV(RMSE) = {a['cv_rmse']:.2f} %",
                      f"Formule « {i1['formule']} » ; SER : période {a['periode_debut']}→{a['periode_fin']}, "
                      f"variables {', '.join(a['variables'])}, coefficients et version historisés")

            self._step("T10 — alerte de test")
            aid = alerts.raise_test(username)
            ev = db.query("SELECT action FROM alert_events WHERE alert_id=?", (aid,))
            db.execute("UPDATE alerts SET etat='cloturee', condition_active=0 WHERE id=?", (aid,))
            db.execute("INSERT INTO alert_events(alert_id,ts,username,action,commentaire) VALUES(?,?,?,?,?)",
                       (aid, time.time(), username, "CLOTURE", "Clôture automatique en fin d'essai T10"))
            ev2 = db.query("SELECT action FROM alert_events WHERE alert_id=?", (aid,))
            self._res("T10", len(ev) >= 1 and len(ev2) >= 2, f"Alerte #{aid} créée ; historique : {' → '.join(e['action'] for e in ev2)}",
                      "Tables alerts et alert_events")

            self._step("T11 — rapport")
            rep = energy.report_data(mois, alerts)
            okr = rep["consommations"] and rep["ipe"] and rep["ser"] and rep["mois"] == mois
            self._res("T11", bool(okr), f"Rapport {mois} : {len(rep['consommations'])} postes, {len(rep['ipe'])} IPE, SER, unités kWh",
                      "Rapport mensuel A4 (/rapport) : périmètre, période, unités, IPE, SER, alertes, qualité des données")

            self._step("T12 — intégration du point existant")
            head = db.query_one("SELECT * FROM measurement_points WHERE role='tete'")
            coh = getattr(acq, "coherence", None)
            if not coh:                                # pas encore d'agrégat minute : contrôle sur les mesures instantanées
                pv = {pid: (r.get("valeurs", {}).get("P") or {}).get("v") for pid, r in acq.latest.items()}
                incl = [p["id"] for p in acq.points if p["inclus_agregation"]]
                if head and pv.get(head["id"]) and all(pv.get(i) for i in incl):
                    s_ = sum(pv[i] for i in incl)
                    coh = {"tete_kw": pv[head["id"]], "somme_postes_kw": s_, "ecart_pct": (pv[head["id"]] - s_) / pv[head["id"]] * 100}
            okc = head and head["inclus_agregation"] == 0 and coh and abs(coh["ecart_pct"]) < 5
            self._res("T12", bool(okc),
                      f"Compteur de tête exclu des agrégations ; tête {coh['tete_kw']:.0f} kW vs Σ postes {coh['somme_postes_kw']:.0f} kW "
                      f"(écart {coh['ecart_pct']:+.2f} %)" if coh else "Cohérence non encore calculée (attendre 1 min)",
                      "Point PC-TETE (existant) : rôle « tête », inclus_agregation = 0 ; contrôle R11")

            self._step("T13 — habilitations")
            code, det = self.probe()
            self._res("T13", code == 403, f"Requête « modifier les seuils » avec le rôle Lecteur → HTTP {code}", det)

            self._step("T14 — sauvegarde et restauration")
            tmp = tempfile.mkdtemp(prefix="sme_restore_")
            path = db.backup(tmp)
            ok_i, counts = db.verify_backup(path)
            src = {t: db.query_one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("electrical_posts", "equipment")}
            okb = ok_i and all(counts[k] == src[k] for k in src)
            self._res("T14", okb, f"Sauvegarde {os.path.basename(path)} — intégrité {'OK' if ok_i else 'KO'} ; "
                                  f"{counts['measurements_aggregated']} agrégats, {counts['audit_log']} lignes d'audit",
                      "API SQLite backup + PRAGMA integrity_check sur la copie restaurée")

            self._res("T15", False, "Essai manuel", "Hors application : à réaliser avec les exploitants (feuille de présence, mise en situation).",
                      statut="manuel")
        except Exception as ex:                   # on consigne l'erreur sans arrêter le serveur
            self._res(next((t[0] for t in TESTS if t[0] not in [r["id"] for r in self.state["resultats"]]), "T15"),
                      False, "Erreur d'exécution", repr(ex))
        finally:
            sim.set_incident(2, None)
            res = self.state["resultats"]
            conf = sum(r["statut"] == "conforme" for r in res)
            db.execute("INSERT INTO test_runs(ts,username,resultats,conformes,total) VALUES(?,?,?,?,?)",
                       (time.time(), username, json.dumps(res, ensure_ascii=False), conf, len(res)))
            db.audit(username, "RECETTE", "plan de tests T01-T15", apres={"conformes": conf, "total": len(res)})
            with self.lock:
                self.state.update(en_cours=False, etape="Terminé", progression=100)

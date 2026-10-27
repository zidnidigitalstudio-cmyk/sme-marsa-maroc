"""
model.py — Modèle physique simplifié des usages électriques du port (simulation).

Sert à deux choses :
  1) alimenter en temps réel les compteurs simulés (serveur Modbus TCP) ;
  2) générer l'historique de démonstration (7 jours à pas de 1 minute).

Ce modèle remplace le terrain tant que les compteurs réels ne sont pas raccordés.
Il ne prétend pas reproduire les consommations réelles du port d'Agadir.
"""
import math
import random

SQRT3 = math.sqrt(3)

# Cycle type d'une grue mobile (s) : levage, rotation/translation, descente, attente
CRANE_PERIOD = 110
CRANE_PHASES = [("Levage", 0, 35, 380.0), ("Rotation", 35, 55, 140.0),
                ("Descente", 55, 85, 45.0), ("Attente", 85, 110, 25.0)]
CRANE_MEAN_KW = sum((b - a) * kw for _, a, b, kw in CRANE_PHASES) / CRANE_PERIOD
CRANE_IDLE_KW = 18.0


def crane_phase(i, t):
    pos = (t + i * 37) % CRANE_PERIOD
    for name, a, b, kw in CRANE_PHASES:
        if a <= pos < b:
            return name, kw, (pos - a) / (b - a)
    return "Attente", 25.0, 0.0


def _office(hour, weekday):
    return 1.0 if (weekday < 5 and 8 <= hour < 18) else 0.0


def usage_power(post, hour, weekday, ctx, t=None, averaged=False, rnd=random):
    """Puissance active (kW) et facteur de puissance d'un poste à l'instant donné."""
    u = post["usage"]
    h = hour
    if u == "conteneurs":
        p = 250 + (540 * (0.85 + 0.15 * math.sin(h / 3.0)) if ctx["navire_conteneurs"] else 0)
        pf = 0.91
    elif u == "services":
        p = 150 + 150 * _office(int(h), weekday) + 25 * math.sin(h / 24 * 2 * math.pi)
        pf = 0.88
    elif u == "vrac":
        p = 110 + (640 if ctx["navire_vrac"] else 0)
        pf = 0.88
    elif u == "grues":
        n = ctx["grues_actives"]
        working = ctx["navire_conteneurs"] or ctx["navire_vrac"]
        p, pfs = 30.0, []
        for i in range(n):
            if not working:
                p += CRANE_IDLE_KW
                pfs.append(0.86)
            elif averaged or t is None:
                p += CRANE_MEAN_KW
                pfs.append(0.88)
            else:
                _, kw, _ = crane_phase(i, t)
                p += kw
                pfs.append(0.90 if kw > 100 else 0.87)
        pf = sum(pfs) / len(pfs) if pfs else 0.86
    elif u == "reefers":
        p = 60 + ctx["reefers"] * 3.1 * (1 + 0.12 * math.sin((h - 9) / 24 * 2 * math.pi))
        pf = 0.86
    elif u == "eclairage":
        night = h < 7 or h >= 19
        p = (320 if night else 100) * ctx.get("eclairage_facteur", 1.0) + 60
        pf = 0.95
    else:
        p, pf = 100, 0.9
    p *= 1 + rnd.gauss(0, 0.02 if averaged else 0.035)
    pf = min(0.99, max(0.5, pf + rnd.gauss(0, 0.006)))
    return max(p, 0.0), pf


def electrical_values(post, p, pf, rnd=random):
    """Complète P/PF par U, I, Q, S, F, THD (côté BT 400 V)."""
    charge = p / post["souscrite_kw"]
    u = 400.0 - 13.0 * charge + rnd.gauss(0, 1.2)
    s = p / pf if pf > 0 else p
    q = math.sqrt(max(s * s - p * p, 0.0))
    i = s * 1000.0 / (SQRT3 * u)
    harmonic = 1.0 if post["usage"] in ("grues", "vrac", "reefers") else 0.4
    thd = 1.6 + 3.2 * harmonic * min(charge, 1.3) + rnd.gauss(0, 0.15)
    f = 50.0 + rnd.gauss(0, 0.015)
    return {"P": p, "Q": q, "S": s, "PF": pf, "U": u, "I": i, "F": f, "THD": max(thd, 0.3)}


def head_values(post_values, rnd=random):
    """Compteur de tête (MT 22 kV) : somme des postes + pertes transformateurs (~1,2 %)."""
    p = sum(v["P"] for v in post_values) * 1.012
    q = sum(v["Q"] for v in post_values) * 1.03
    s = math.sqrt(p * p + q * q)
    pf = p / s if s else 1.0
    u = 22.0 + rnd.gauss(0, 0.05)              # kV
    i = s / (SQRT3 * u)                        # A
    return {"P": p, "Q": q, "S": s, "PF": pf, "U": u, "I": i,
            "F": 50.0 + rnd.gauss(0, 0.015), "THD": 1.4 + rnd.gauss(0, 0.1)}


def history_context(ts_local):
    """Activité portuaire reconstituée pour l'historique (déterministe par jour)."""
    d = ts_local.toordinal()
    h = ts_local.hour + ts_local.minute / 60
    navire_c = (d % 3 != 2 and 5 <= h < 21) or (d % 3 == 0 and h >= 21)
    navire_v = d % 4 in (0, 1)
    return {"navire_conteneurs": navire_c, "navire_vrac": navire_v,
            "grues_actives": (2 if navire_c else 0) + (1 if navire_v else 0),
            "reefers": 175 + 20 * math.sin(d / 3.0), "eclairage_facteur": 1.0}

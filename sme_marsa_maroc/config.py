"""
config.py — Paramètres de démarrage du SME (Système de Monitoring Énergétique)
Marsa Maroc — Direction d'Exploitation au Port d'Agadir (DEPA) — Marché 12/DEPA/2026

Ces valeurs ne servent qu'à INITIALISER la base au premier démarrage. Ensuite,
postes, compteurs, registres, seuils, règles d'alerte, IPE, SER et tarifs sont
administrés depuis l'interface (et journalisés), conformément au §2.2 et §3.3
de la spécification : « ne pas coder en dur sans validation ».

IMPORTANT (spécification §11-§12) : les noms de postes, modèles de compteurs,
registres Modbus, formules d'IPE, paramètres de SER, seuils et tarifs ci-dessous
sont des VALEURS DE DÉMONSTRATION. Ils doivent être validés avec la DEPA.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("SME_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "sme.db")
BACKUP_DIR = os.environ.get("SME_BACKUP_DIR", os.path.join(DATA_DIR, "backups"))
HOST = os.environ.get("SME_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT") or os.environ.get("SME_PORT", "8000"))   # PORT : fourni par Render
MODBUS_HOST = "127.0.0.1"          # passerelle de simulation (en réel : IP de chaque compteur)
MODBUS_PORT = int(os.environ.get("SME_MODBUS_PORT", "5020"))
TZ_NAME = "Africa/Casablanca"
HISTORY_DAYS = 7                   # profondeur de l'historique de démonstration (1 min)

CLIENT = {
    "societe": "Marsa Maroc",
    "direction": "Direction d'Exploitation au Port d'Agadir (DEPA)",
    "site": "Port d'Agadir",
    "marche": "12/DEPA/2026",
    "objet": "Fourniture, installation, intégration et mise en service d'un Système de Monitoring Énergétique (SME)",
    "norme": "ISO 50001:2018",
}

ACQUISITION_DEFAULT = {
    "periode_s": 2.0,          # période d'interrogation Modbus
    "timeout_s": 0.6,          # délai de réponse max
    "reconnexion_s": 10.0,     # délai entre tentatives après 3 échecs consécutifs
    "retention_brut_h": 6,     # rétention des mesures brutes (démo)
    "fraicheur_s": 6.0,        # au-delà : mesure "ancienne"
    "peremption_s": 60.0,      # au-delà : mesure "périmée"
    "derive_horloge_max_s": 5.0,
}

# --------------------------------------------------------------------------- #
#  Patrimoine : site -> postes -> compteurs -> points de comptage
#  Arrivée ONEE 22 kV -> jeu de barres -> 6 postes 22 kV / 0,4 kV
# --------------------------------------------------------------------------- #
POSTES = [
    {"id": 1, "code": "P1", "libelle": "Poste Quai Nord", "zone": "Terminal à conteneurs",
     "usage": "conteneurs", "transfo_kva": 2000, "souscrite_kw": 1400,
     "departs": ["Portiques de quai", "Engins électrifiés", "Atelier terminal", "Éclairage terre-plein Nord"]},
    {"id": 2, "code": "P2", "libelle": "Poste Central MT/BT", "zone": "Services généraux & ateliers",
     "usage": "services", "transfo_kva": 1250, "souscrite_kw": 700,
     "departs": ["Ateliers de maintenance", "Bâtiment DEPA", "Station de pompage / incendie", "Capitainerie"]},
    {"id": 3, "code": "P3", "libelle": "Poste Vrac & Silos", "zone": "Terminal vrac",
     "usage": "vrac", "transfo_kva": 1600, "souscrite_kw": 1100,
     "departs": ["Convoyeurs à bande", "Silos & élévateurs", "Dépoussiérage", "Trémies de chargement"]},
    {"id": 4, "code": "P4", "libelle": "Poste Grues Mobiles", "zone": "Grues mobiles portuaires",
     "usage": "grues", "transfo_kva": 2000, "souscrite_kw": 1500,
     "departs": ["Grue mobile GM-01", "Grue mobile GM-02", "Grue mobile GM-03", "Grue mobile GM-04"]},
    {"id": 5, "code": "P5", "libelle": "Poste Frigorifique Reefers", "zone": "Parc reefers & entrepôt froid",
     "usage": "reefers", "transfo_kva": 1250, "souscrite_kw": 850,
     "departs": ["Prises reefers zone A", "Prises reefers zone B", "Entrepôt froid", "Compresseurs"]},
    {"id": 6, "code": "P6", "libelle": "Poste Gare Maritime & Éclairage", "zone": "Gare maritime, éclairage portuaire",
     "usage": "eclairage", "transfo_kva": 800, "souscrite_kw": 500,
     "departs": ["Mâts d'éclairage portuaire", "Gare maritime", "Contrôle d'accès / vidéo", "Parkings"]},
]

# Compteurs. unit = Unit ID Modbus ; ip = adresse terrain cible (plan d'adressage à valider).
# Le compteur 7 est un point DÉJÀ INSTRUMENTÉ (compteur de tête de l'arrivée ONEE)
# intégré sans duplication : il sert au contrôle de cohérence, pas aux agrégations.
EQUIPEMENTS = [
    {"id": i, "post_id": i, "code": f"CPT-P{i}", "libelle": f"Compteur général poste P{i}",
     "fabricant": "Schneider Electric", "modele": "PM800 (profil simulé — à confirmer)",
     "ip": f"10.20.1.{10 + i}", "port": 502, "unit": i, "existant": 0, "profil": "PM800-DEMO"}
    for i in range(1, 7)
] + [
    {"id": 7, "post_id": None, "code": "CPT-TETE", "libelle": "Compteur de tête arrivée ONEE 22 kV (existant)",
     "fabricant": "Existant — à inventorier", "modele": "Via passerelle Modbus RTU/TCP (à confirmer)",
     "ip": "10.20.1.10", "port": 502, "unit": 7, "existant": 1, "profil": "PM800-DEMO"},
]

# --------------------------------------------------------------------------- #
#  Définitions de mesure (cartographie de registres du profil simulé)
#  NB : adresses indicatives — la matrice définitive provient du fabricant.
# --------------------------------------------------------------------------- #
#  grandeur, adresse, type, échelle, unité, description, min valide, max valide
MEASUREMENT_DEFINITIONS = [
    ("P",   3000, "float32", 1.0, "kW",   "Puissance active totale",               -50.0, 4000.0),
    ("Q",   3002, "float32", 1.0, "kvar", "Puissance réactive totale",           -3000.0, 3000.0),
    ("S",   3004, "float32", 1.0, "kVA",  "Puissance apparente totale",              0.0, 5000.0),
    ("PF",  3006, "float32", 1.0, "",     "Facteur de puissance total",              0.0, 1.0),
    ("U",   3008, "float32", 1.0, "V",    "Tension composée moyenne",              300.0, 480.0),
    ("I",   3010, "float32", 1.0, "A",    "Courant moyen",                           0.0, 8000.0),
    ("F",   3012, "float32", 1.0, "Hz",   "Fréquence",                              47.0, 53.0),
    ("THD", 3014, "float32", 1.0, "%",    "Taux de distorsion harmonique tension",   0.0, 40.0),
    ("E",   3016, "uint32",  0.1, "kWh",  "Énergie active importée (index)",         0.0, 4.3e8),
    ("TS",  3018, "uint32",  1.0, "s",    "Horodatage compteur (epoch UTC)",         0.0, 4.3e9),
]

# --------------------------------------------------------------------------- #
#  Règles d'alerte (catalogue configurable — à valider avec la DEPA)
# --------------------------------------------------------------------------- #
ALERT_RULES = [
    # code,  libellé,                                   type,          seuil,  priorité,  délai_s
    ("R01", "Absence de communication compteur",       "COMM",          None, "critique", 6),
    ("R02", "Donnée manquante ou invalide",            "QUALITE",       None, "mineure",  0),
    ("R03", "Charge ≥ seuil d'alerte (% souscrite)",   "CHARGE",        90.0, "majeure",  0),
    ("R04", "Dépassement de la puissance souscrite",   "CHARGE",       100.0, "critique", 0),
    ("R05", "Facteur de puissance bas",                "PF_MIN",        0.85, "mineure", 10),
    ("R06", "Tension basse",                           "U_MIN",        360.0, "majeure",  0),
    ("R07", "Tension haute",                           "U_MAX",        440.0, "majeure",  0),
    ("R08", "Distorsion harmonique élevée (THD-U)",    "THD",            8.0, "mineure", 10),
    ("R09", "Écart d'un IPE à sa cible",               "ECART_IPE",      5.0, "majeure",  0),
    ("R10", "Écart mensuel significatif à la SER",     "ECART_SER",      5.0, "mineure",  0),
    ("R11", "Incohérence compteur de tête / postes",   "COHERENCE",      5.0, "mineure", 30),
]

TARIF_DEFAULT = {
    "devise": "MAD",
    "prix_pointe": 1.40, "prix_pleines": 0.98, "prix_creuses": 0.68,   # MAD/kWh
    "pointe": [17, 22], "creuses": [22, 7],
    "co2_kg_kwh": 0.70,
    "note": "Barème INDICATIF de démonstration — à remplacer par les conditions du contrat ONEE.",
}

# --------------------------------------------------------------------------- #
#  IPE proposés (spécification §2.4 : « ne pas inventer » -> statut « proposé »)
# --------------------------------------------------------------------------- #
IPE_DEFAULT = [
    {"code": "IPE-01", "libelle": "Consommation spécifique du terminal à conteneurs",
     "formule": "E(P1) / EVP", "num": "conteneurs", "den": "evp", "unite": "kWh/EVP", "perimetre": "Poste P1",
     "cible": 30.5},
    {"code": "IPE-02", "libelle": "Consommation spécifique du terminal vrac",
     "formule": "E(P3) / tonnes vrac", "num": "vrac", "den": "tonnes_vrac", "unite": "kWh/t", "perimetre": "Poste P3",
     "cible": 1.10},
    {"code": "IPE-03", "libelle": "Intensité énergétique des grues mobiles",
     "formule": "E(P4) / heures de grue", "num": "grues", "den": "heures_grue", "unite": "kWh/h", "perimetre": "Poste P4",
     "cible": 140.0},
    {"code": "IPE-04", "libelle": "Consommation par conteneur frigorifique",
     "formule": "E(P5) / conteneurs-jour reefer", "num": "reefers", "den": "reefer_jours", "unite": "kWh/c.j", "perimetre": "Poste P5",
     "cible": 75.0},
    {"code": "IPE-05", "libelle": "Consommation par escale",
     "formule": "Σ E(P1..P6) / escales", "num": "total", "den": "escales", "unite": "kWh/escale", "perimetre": "Postes P1 à P6",
     "cible": 18500.0},
    {"code": "IPE-06", "libelle": "Consommation journalière éclairage & gare maritime",
     "formule": "E(P6) / jours", "num": "eclairage", "den": "jours", "unite": "kWh/j", "perimetre": "Poste P6",
     "cible": 4800.0},
]
USAGE_BY_POST = {p["id"]: p["usage"] for p in POSTES}

ROLES = [
    ("lecteur", "Lecteur / auditeur", 1),
    ("operateur", "Exploitant / opérateur", 2),
    ("energie", "Responsable énergie", 3),
    ("admin", "Administrateur technique", 4),
]
PERMISSIONS = {
    "lecteur":   ["view"],
    "operateur": ["view", "alert.handle", "report.generate", "simulation.incident"],
    "energie":   ["view", "alert.handle", "report.generate", "simulation.incident",
                  "config.seuils", "config.ipe", "config.ser", "recette.run", "audit.view"],
    "admin":     ["view", "alert.handle", "report.generate", "simulation.incident",
                  "config.seuils", "config.ipe", "config.ser", "recette.run", "audit.view",
                  "config.compteurs", "config.acquisition", "users.manage", "backup.manage"],
}
DEFAULT_USERS = [
    ("admin", "Administrateur technique SME", "admin", "Admin@2026"),
    ("energie", "Responsable énergie DEPA", "energie", "Energie@2026"),
    ("operateur", "Exploitant salle de conduite", "operateur", "Operateur@2026"),
    ("auditeur", "Auditeur ISO 50001", "lecteur", "Auditeur@2026"),
]

# Registre des points à valider (spécification §11) — affiché dans l'application
POINTS_A_VALIDER = [
    ("Patrimoine", "Liste et désignation exactes des six postes électriques", "Démo : 6 postes nommés par usage"),
    ("Comptage", "Marques, modèles et classes de précision des compteurs", "Démo : profil type PM800 simulé"),
    ("Comptage", "Cartographies Modbus officielles (adresses, types, échelles, codes d'erreur)", "Démo : registres 3000-3019 float32/uint32"),
    ("Comptage", "Inventaire des points existants et passerelles", "Démo : compteur de tête ONEE intégré, exclu des agrégations"),
    ("Réseau", "Topologie, plan d'adressage IP, segmentation et cybersécurité", "Démo : 10.20.1.0/24, simulation locale 127.0.0.1:5020"),
    ("Acquisition", "Période d'échantillonnage, rétention et disponibilité attendues", "Démo : 2 s, brut 6 h, agrégé 1 min"),
    ("IPE", "Formules et référentiels officiels des IPE", "Démo : 6 IPE proposés, statut « proposé »"),
    ("SER", "Méthode, variables pertinentes et période de référence de la SER", "Démo : régression multivariée sur 2025"),
    ("Alertes", "Seuils, priorités et canaux de notification", "Démo : 11 règles, notification dans l'interface"),
    ("Reporting", "Formats, modèles, périodicités et destinataires des rapports", "Démo : revue mensuelle A4 + export CSV"),
    ("Accès", "Profils et nombre d'utilisateurs", "Démo : 4 rôles, moindre privilège"),
    ("Exploitation", "Sauvegarde, restauration, garantie et maintenance", "Démo : sauvegarde SQLite + test de restauration"),
    ("Tarification", "Conditions tarifaires du contrat ONEE", "Démo : barème indicatif 3 postes horaires"),
    ("Formation", "Programme, durée et nombre de participants", "Hors application (T15 manuel)"),
]

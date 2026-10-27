# SME — Système de Monitoring Énergétique
**Marsa Maroc — Direction d'Exploitation au Port d'Agadir (DEPA) — Marché 12/DEPA/2026 — ISO 50001:2018**

Prototype fonctionnel d'une plateforme de management de l'énergie pour les six postes électriques du port :
acquisition **Modbus TCP/IP**, supervision temps réel, **IPE**, **SER**, alertes, rapports de revue énergétique,
habilitations, traçabilité et recette automatique.

> Les compteurs sont **simulés** et publiés sur un vrai serveur Modbus TCP local.
> Noms de postes, registres, IPE, SER, seuils et tarifs sont des **hypothèses de démonstration à valider avec la DEPA**
> (écran « Points à valider », spécification §11-§12).

---

## 1. Lancer l'application

### Sur Google Colab (méthode du cours)
1. Déposer `sme_marsa_maroc.zip` dans `MyDrive/colab_server_apps/`.
2. Ouvrir `SME_deploiement_Colab.ipynb` dans Colab et exécuter les cellules 1 à 4.
3. La cellule 4 affiche le lien public `https://….trycloudflare.com` à envoyer au professeur.

### Lien permanent : GitHub + Render (gratuit)
1. Déposer le contenu de ce dossier dans un dépôt GitHub public.
2. Sur https://render.com : **New → Web Service** → connecter le dépôt.
3. Paramètres : Runtime **Python 3**, Build `pip install -r requirements.txt`, Start `python app.py`, Instance **Free**
   (ou **New → Blueprint** : le fichier `render.yaml` remplit tout automatiquement).
4. Lien fixe : `https://sme-marsa-maroc.onrender.com` (ou proche). L'offre gratuite se met en veille après
   15 min sans visite ; la visite suivante la réveille (≈ 1 min). Les données de démonstration sont régénérées au réveil.

### Par SSH sur le serveur Colab (variante vue en séance)
```bash
cd /content && unzip -o /content/drive/MyDrive/colab_server_apps/sme_marsa_maroc.zip -d sme
pip install "flask>=3.0"
cd sme && SME_BACKUP_DIR=/content/drive/MyDrive/colab_server_apps/sme_backup nohup python3 app.py > /content/sme.log 2>&1 &
cloudflared tunnel --url http://localhost:8000      # recopier le lien trycloudflare affiché
```

### En local (Windows, Linux, Debian)
```bash
python -m venv .venv && . .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                       # puis ouvrir http://localhost:8000
```

### Comptes
| Identifiant | Mot de passe | Rôle |
|---|---|---|
| `admin` | `Admin@2026` | Administrateur technique |
| `energie` | `Energie@2026` | Responsable énergie |
| `operateur` | `Operateur@2026` | Exploitant / opérateur |
| `auditeur` | `Auditeur@2026` | Lecteur / auditeur |

Un bouton **« Accès démonstration (lecture seule) »** permet aussi une consultation sans mot de passe.
Changez les mots de passe (Administration → Utilisateurs) avant toute diffusion large.

---

## 2. Architecture (spécification §4)

| Couche | Réalisation | Fichier |
|---|---|---|
| 1. Terrain | 6 compteurs de poste + 1 compteur de tête existant, modèle physique des usages portuaires (grues, reefers, vrac, éclairage) | `model.py` |
| 2. Communication | Modbus TCP/IP (trames MBAP, FC03/FC04, exceptions), serveur multi-esclaves + client, sans dépendance | `modbus_tcp.py` |
| 3. Acquisition | Scrutation 2 s, décodage selon la cartographie en base, double horodatage, qualification, reconnexion, agrégation 1 min, reprise sans doublon | `engine.py` |
| 4. Données | SQLite (WAL), tables du modèle §5, index temporels, sauvegarde à chaud | `db.py` |
| 5. Métier énergétique | Énergie par index, tarification horo-saisonnière, IPE, SER par régression multiple, CUSUM, règles d'alerte | `energy.py`, `engine.py` |
| 6. Présentation | Application web Flask + API REST + interface (Chart.js embarqué) | `app.py`, `templates/`, `static/` |
| 7. Exploitation | Rôles et permissions, journal d'audit, sauvegarde/restauration vérifiée, recette T01-T14 automatique | `app.py`, `recette.py` |

---

## 3. Correspondance avec la spécification

| § | Exigence | Où la voir dans l'application |
|---|---|---|
| 2.1 | Structure site → postes → compteurs → points de comptage, identifiants, états | Patrimoine & compteurs (arborescence) |
| 2.2 | Caractéristiques compteurs, Modbus TCP, cartographie configurable, horodatage, qualité, dernière communication, période paramétrable | Patrimoine (Tester / Modifier, registres), Acquisition Modbus |
| 2.3 | Tableau de bord, vue des 6 postes, fraîcheur des mesures, courbes, comparaison, filtres, export, lacunes visibles | Tableau de bord, Postes, Historiques |
| 2.4 | IPE : formule, sources, périmètre, agrégation, données manquantes, date d'effet, historique | Indicateurs (IPE) |
| 2.5 | SER : période, variables, hypothèses, écarts, versions et motifs, traçabilité | Situation de référence |
| 2.6 | Alertes configurables, état nouvelle / prise en charge / clôturée, commentaire, historique | Alertes |
| 2.7 | Reporting : consommations, comparaisons, IPE, SER, alertes, complétude, méthodes | Rapports (revue mensuelle A4) |
| 2.8 | Intégration d'un point existant sans double comptage | Compteur de tête exclu des agrégations, contrôle R11, essai T12 |
| 2.9 | Rôles, moindre privilège, journalisation des actions sensibles | Administration (rôles, audit) |
| 3.1 | Valeur 0 / absente / invalide distinguées, double horodatage, reprise sans doublon | Postes, Acquisition, essais T03/T05 |
| 3.2 | Authentification, mots de passe hachés, en-têtes de sécurité, anti-CSRF, limitation des tentatives, sauvegardes testées | Connexion, Administration, essais T13/T14 |
| 6.1 | Parcours de mise en service d'un compteur | Patrimoine (8 étapes) |
| 6.3 | Parcours de traitement d'une alerte | Alertes (clôture impossible tant que le défaut persiste, commentaire obligatoire) |
| 8 | Plan de tests T01-T15 | Recette : exécution automatique, PV imprimable |

---

## 4. Démonstration conseillée (5 minutes)
1. **Tableau de bord** : synoptique des 6 postes, puissance, énergie, coût, CO₂.
2. **Simulation terrain** : déclencher « Surcharge » sur P1 → l'alerte R04 apparaît, le poste passe en rouge.
3. **Alertes** : prendre en charge, tenter de clôturer (refusé tant que le défaut persiste), terminer l'incident, clôturer avec commentaire.
4. **IPE** : IPE-01 en dérive (+12 %) depuis août — piste d'action dans le rapport.
5. **SER** : modèle R² ≈ 0,99, CUSUM descendant (effet du relamping LED de mars 2026).
6. **Rapports** : ouvrir la revue énergétique et l'enregistrer en PDF.
7. **Recette** : lancer T01-T15 (≈ 40 s) → 14/14 essais automatiques conformes, T15 manuel.

---

## 5. Tests
```bash
python -m unittest discover -s tests -v      # 22 tests : conversions, registres, qualité, Modbus, IPE, SER, alertes, sauvegarde
```

## 6. Limites du prototype
- Serveur web de développement Flask : en production, utiliser un serveur WSGI (gunicorn/waitress) derrière un reverse proxy HTTPS.
- Historique détaillé de démonstration : 7 jours à 1 minute ; consommations mensuelles 2025-2026 consolidées et simulées.
- Le lien trycloudflare change à chaque redémarrage du tunnel et la session Colab gratuite est limitée dans le temps.

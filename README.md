# KTV

Lecteur **Xtream Codes** pour **macOS (Apple Silicon)** et **Windows (x64)** — interface moderne par sections : **Live TV, Films (VOD), Séries, Guide TV (EPG)**, enregistrement, restream et téléchargements.

**▶︎ [Télécharger la dernière version (macOS / Windows)](https://github.com/khalilbenaz/ktv/releases/latest)**

> Les binaires macOS (`KTV-macos-arm64.zip`) et Windows (`KTV-windows-x64.zip`) sont construits automatiquement à chaque version par GitHub Actions.

> Anciennement « IPTV Live ». Le dépôt et l'application ont été renommés **KTV** (bundle id `com.kba.ktv`).

## Fonctionnalités

### ✨ Nouveautés v1.9.1
- **Bouton « ⏪ Revoir » redessiné** dans le lecteur : style cohérent avec le langage premium (teinte indigo dédiée au catch-up), survol en dégradé plein avec ombre colorée et micro-animation de rembobinage de l'icône.

### ✨ Nouveautés v1.9 — refonte interface « premium »
- **Accueil cinématographique** : grand **hero** avec **backdrop TMDB** plein cadre, synopsis, **Saison · Épisode**, **barre de progression + temps restant**, bouton **Reprendre**. Rangée **« Reprendre la lecture »** enrichie (sous-titre *Continuer · S01, E02*, badge **S/E**, barre + temps restant).
- **Reprise réellement fonctionnelle** pour **films ET séries** (le hero/les cartes relancent à la bonne position) avec **barre de progression sur les vignettes** et **temps restant** (« ⏳ 1 h 05 »).
- **Pages Films & Séries façon streaming** : **hero** en tête + **rails** *Tendances · Dernières sorties · Récemment ajoutés · 4K • UHD*. Les rails restent **globaux et constants** quand on change de catégorie (seule la grille filtre).
- **Classement TMDB** : rail **« Tendances »** numéroté (rang 1..N) trié par note.
- **Pagination** des grilles (60/page) + **liste de catégories cliquable** (chips) en remplacement du menu déroulant.
- **EPG enrichi** : blocs programme avec **plage horaire (début–fin)**, **description**, marqueur **🔴 en direct** + barre de progression.
- **Catch-up toujours accessible** : bouton **⏪** sur chaque chaîne du **Guide TV** + **« ⏪ Revoir »** dans le lecteur (la fenêtre indique « aucune rediffusion » si le fournisseur n'en a pas).
- **Réglages en onglets** pleine largeur : navigation à gauche (fixe), contenu à droite — **fini le scroll interminable**.
- **Rafraîchissement du catalogue** (films / séries) à la demande dans *Réglages → Catalogue*.
- **Page de connexion redessinée** : fond animé (orbes + grille), carte en **verre dépoli** (glassmorphism), logo lumineux.

### ✨ Nouveautés v1.8
- **Catch-up / Archive (timeshift)** : sur les chaînes avec archive, bouton **⏪ Revoir** dans le lecteur (catalogue des rediffusions) et programmes passés rejouables directement depuis le **Guide TV**.
- **Sources multiples / fusion** : ajout de playlists **M3U/M3U8** et de **comptes Xtream secondaires** dans *Réglages* — leurs chaînes apparaissent dans Live TV (lecture, enregistrement et restream gérés par source).
- **Enrichissement TMDB** : affiches, notes, synopsis, genres et **casting avec photos des acteurs** (rangée de portraits) pour Films & Séries, avec **fiche film** détaillée.
- **Synchronisation Trakt** : liaison par **code device** ou **PIN**, marquage *vu* automatique **à ~90 % de la lecture** (avant le générique, y compris depuis « Reprendre »), ajout à la **watchlist**.
- **Tampon / cache configurable** (faible latence / équilibré / stable) + **overlay statistiques réseau** (📊 résolution, débit, tampon, images perdues, latence).
- **Test de débit & diagnostic fournisseur** : latence API, débit du flux, connexions actives/max, expiration.
- **Mise à jour automatique programmée** du contenu (chaînes, films, séries, EPG).
- **Recherche globale** : chaînes + films + séries + **programmes EPG** en une seule vue.

#### Configurer Trakt
1. Crée une application sur **[trakt.tv/oauth/applications](https://trakt.tv/oauth/applications)** avec **Redirect URI** = `urn:ietf:wg:oauth:2.0:oob`.
2. Dans KTV → *Réglages → Synchronisation Trakt*, colle le **Client ID** et le **Client Secret**.
3. Connecte-toi via **« Connecter (code device) »** (code à saisir sur `trakt.tv/activate`) ou via **PIN** (« Obtenir un PIN » puis « Coller le PIN et lier »).

#### Configurer des sources multiples
*Réglages → Sources multiples* : ajoute une **playlist M3U** (URL) ou un **compte Xtream secondaire**, puis « Actualiser maintenant ». Les chaînes sont fusionnées dans **Live TV** (catégories préfixées 📁/🔗).

### Navigation & accueil
- Interface à **sections** (barre latérale) : Accueil · Live TV · Films · Séries · Guide TV · Enregistrements · Réglages.
- **Accueil** type streaming : hero « reprendre », rangées horizontales (Vu récemment, favoris, catégories).
- **Accueil configurable** : choix dans *Réglages* des catégories (Live / Films / Séries) affichées en rangées, avec bouton **« tout voir »** ouvrant la catégorie complète.
- Recherche globale, **vu récemment**, favoris. La rangée **« Reprendre la lecture »** se met à jour en temps réel à chaque retour sur l'accueil.
- **Multi-comptes (multi-fournisseurs)** : plusieurs comptes Xtream mémorisés, sélecteur sur l'écran de connexion (clic = connexion, suppression à la demande). « Changer de compte » conserve la liste ; reconnexion automatique au dernier profil.
- **Thème clair / sombre** : bascule ☀️/🌙 dans la barre du haut, préférence mémorisée.

### Lecture
- Connexion Xtream (URL / utilisateur / mot de passe mémorisés, **reconnexion automatique** au lancement, bouton afficher/masquer le mot de passe).
- **Live TV** en grille de cartes (logo + qualité 8K/4K/FHD/HD/SD + EPG *now/next*), lecture 1 clic (`mpegts.js` natif Xtream, fallback `hls.js`).
- **Vraie 4K automatique** : le lecteur intégré ne décode pas le HEVC 10 bits 2160p. KTV **sonde la résolution réelle** au lancement et, uniquement pour les flux **réellement ≥ 2160p**, transcode en **H.264 matériel** (VideoToolbox, Apple Silicon) via le relais. Les fausses « 4K » (chaînes 1080p/720p mal étiquetées) restent en lecture directe. Décision mémorisée par chaîne (instantané ensuite).
- **Sidebar chaînes dans le lecteur** : à droite du player, liste repliable des chaînes de la **même catégorie** (logo + programme en cours) pour **zapper sans revenir à la liste complète**.
- **Films (VOD)** et **Séries** (saisons/épisodes) — catégories françaises.
- **Enchaînement automatique** de l'épisode suivant.
- **Reprise de lecture** (VOD / séries) : la position est mémorisée et proposée à la relecture (« ▶ Reprise à … » avec option *Recommencer*).
- **Pistes audio & sous-titres multiples** : sélecteurs 🔊 / 💬 dans le lecteur (pistes du flux HLS, et pistes natives quand le format le permet).
- **Picture-in-Picture** 🗗 et **plein écran** ⛶.
- **Raccourcis clavier** dans le lecteur : `espace`/`k` lecture-pause · `←`/`→` ±10 s · `↑`/`↓` volume · `m` muet · `f` plein écran · `p` PiP · `a` audio · `c` sous-titres · `n` épisode suivant.
- **Guide TV** : grille EPG (programmes en cours + à venir) par catégorie, noms de chaînes longs affichés sur **2 lignes**.

### Enregistrement, partage, téléchargement
- **Enregistrement** `.mp4` (sans ré-encodage), dossier **configurable**, liste groupée **par date**, export **WhatsApp** à la demande (son + 30 fps) depuis *Mes enregistrements*.
- **Indicateur d'enregistrement** dans la barre du haut (à droite de la recherche) : puce compacte `● REC mm:ss · taille`, **dépliable** en badge détaillé (chaîne, heure de début, **durée restante**, **barre de progression**, taille en direct). Un clic ouvre la **chaîne en cours d'enregistrement** (lecture via le relais, sans 2ᵉ connexion).
- **Enregistrement programmé & arrêt automatique** (bouton **📅 Programmer**) : choisis le **début** (immédiat ou à une heure précise) et la **fin** (après une **durée**, à une **heure précise**, ou illimité = arrêt manuel). Raccourcis 15 min / 30 min / 1 h / 2 h et **⚽ Match foot (2 h 30)**. Les programmations en attente sont listées et annulables ; une **pastille** sur le bouton indique leur nombre. Le minuteur REC affiche *écoulé / durée totale*. La programmation démarre **en arrière-plan** (sans ouvrir le lecteur).
- **Suivi des enregistrements** : l'écran *Mes enregistrements* affiche les sections **⏺ En cours** (arrêt direct), **📅 Programmés** (annulation) et **💾 Enregistrés** (fichiers).
- **Gestion « 1 connexion »** : pendant un enregistrement, cliquer sur la **chaîne enregistrée** la lit gratuitement via le relais local ; cliquer sur une **autre** chaîne affiche un avertissement avant d'arrêter l'enregistrement (impossible de tirer 2 flux à la fois sur un abonnement à 1 connexion).
  > 📦 Taille : enregistrement en copie de flux → ≈ `débit(Mbps) × durée(min) / 133` Go. Ex. un match beIN HD (~6 Mbps) de 2 h 30 ≈ **6–7 Go**.
- **Restream** : une seule connexion fournisseur partagée vers plusieurs appareils du réseau local. Le flux LAN et le lien public sont protégés par un **token de session aléatoire** (chemin `/<token>/index.m3u8`) ; la lecture locale (`127.0.0.1`) reste libre.
- **Lien public** (Cloudflare, gratuit) pour diffuser hors du LAN.
- **Téléchargements** : films et séries (épisode, **saison entière** ou **série complète**), **mis en file et traités un par un** (respect de la limite d'une seule connexion fournisseur), avec tiroir de progression.
- EPG externe **XMLTV** en secours : correspondance **par tvg-id** (`epg_channel_id`) puis par **nom normalisé** (gère préfixes pays `FR:`/`TR:`, ballon stylisé `⚽`, exposants `ᴴᴰ`, choix de la langue) → récupère le programme des chaînes non taguées comme *beIN Sports*. Détails de l'abonnement.
- **EPG sport via l'API KTV** (Cloudflare Worker `ktv-epg`) : pour les chaînes sport sans EPG fournisseur (beIN Sports, Canal+, Eurosport, L'Équipe…), un service maison agrège la grille du jour depuis des sources publiques et la sert normalisée — corrigeable côté serveur sans mise à jour de l'app. Heures converties en local automatiquement.

> ⚠️ Abonnements à **1 connexion** : lecture, enregistrement et restream passent tous par un **relais local** unique → 1 seule connexion fournisseur. Conséquence : tous les spectateurs d'un restream regardent **la même chaîne**. KTV **nettoie automatiquement** au démarrage et à la fermeture les processus `ffmpeg` orphelins d'une session précédente, pour ne jamais laisser la connexion bloquée.

> 💡 Certains films/épisodes en `.mkv`/`.avi` ne sont pas lus par le lecteur intégré (limite de Chromium) — on peut les **télécharger** puis les ouvrir dans VLC.

## Développement
```bash
npm install
npm start
```

## Build (version portable)

### macOS Apple Silicon (sur un Mac M1/M2/M3)
```bash
npm install
npm run build:mac
```
→ `portable/KTV-darwin-arm64/KTV.app`

### Windows (sur Windows)
```bash
npm install
npm run build:win
```
→ `portable/KTV-win32-x64/KTV.exe`

> Le build doit être lancé **sur la plateforme cible** : `ffmpeg-static` télécharge le binaire ffmpeg correspondant à l'OS au moment du `npm install`.

> macOS : l'app n'est pas signée. Au 1er lancement, **clic droit → Ouvrir**, ou :
> `xattr -dr com.apple.quarantine "/Applications/KTV.app"`

## Installation (release)
Télécharge la dernière version depuis les [**Releases**](https://github.com/khalilbenaz/ktv/releases), décompresse, glisse **KTV.app** dans `/Applications`.

## Notes
- Enregistrements : dossier choisi dans **Réglages → Changer le dossier**, sinon `~/IPTV Live Recordings`. Si le dossier choisi devient inaccessible (disque externe débranché, dossier supprimé), KTV **retombe automatiquement** sur le dossier par défaut sans perdre la préférence.
- Téléchargements : `~/IPTV Live Downloads`.
- Le lien public télécharge `cloudflared` au 1er usage (stocké dans le dossier de données de l'app).

## Stack
Electron · ffmpeg-static · hls.js · mpegts.js · @electron/packager · TMDB · Trakt

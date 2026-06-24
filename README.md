# KTV

Lecteur **Xtream Codes** pour **macOS (Apple Silicon)** et **Windows (x64)** — interface moderne par sections : **Live TV, Films (VOD), Séries, Guide TV (EPG)**, enregistrement, restream et téléchargements.

**▶︎ [Télécharger la dernière version (macOS / Windows)](https://github.com/khalilbenaz/ktv/releases/latest)**

> Les binaires macOS (`KTV-macos-arm64.zip`) et Windows (`KTV-windows-x64.zip`) sont construits automatiquement à chaque version par GitHub Actions.

> Anciennement « IPTV Live ». Le dépôt et l'application ont été renommés **KTV** (bundle id `com.kba.ktv`).

## Captures d'écran

| Accueil | Films |
|---|---|
| ![Accueil — hero et reprise de lecture](docs/screenshots/01-accueil.png) | ![Films — hero TMDB et tendances](docs/screenshots/02-films.png) |
| **Séries** | **Guide TV** |
| ![Séries — hero et tendances](docs/screenshots/03-series.png) | ![Guide TV — EPG et catch-up](docs/screenshots/04-guide.png) |
| **Connexion** | |
| ![Page de connexion](docs/screenshots/05-connexion.png) | |

## Fonctionnalités

### ✨ Nouveautés v1.16.0 — Match Center (Sport) & mise à jour automatique
- **Onglet « ⚽ Sport » (optionnel)** : suivi des matchs **en direct** (données Sofascore via le navigateur intégré, sans clé API). Recherche par nom (alias FR→EN, ex. « maroc » → Morocco) ou URL Sofascore collée ; **score live, infos** (tournoi, stade, arbitre) et **faits du match** (buts + passeurs, cartons, remplacements, décisions VAR).
- **Activation dans les Réglages** : le menu Sport n'apparaît que si l'option **« Activer le menu Sport »** est cochée (Réglages → ⚽ Sport). Désactivé par défaut.
- **Mise à jour automatique** : « Installer maintenant » télécharge la nouvelle version (barre de progression), l'**installe en place** et **redémarre** KTV — plus besoin de réinstaller manuellement (macOS & Windows ; repli sur la page de release si besoin).

### ✨ Nouveautés v1.15.4 — chargement catalogue résilient
- **Catalogue films/séries auto-réparant** : un hoquet de connexion au fournisseur ne laisse plus la page sur « Aucun film » jusqu'au redémarrage — le catalogue est automatiquement retenté au passage suivant (le cache vide n'est plus mémorisé).
- **Timeout réseau (30 s)** sur les appels API : une requête qui pend (fournisseur lent/HS) échoue proprement au lieu de figer le chargement.
- **Rangée « Films » de l'accueil** : retry automatique avant d'abandonner la rangée.

### ✨ Nouveautés v1.15.3
- **« Vu » synchronisé** sur toutes les affiches d'un même contenu (plus de désynchronisation entre rangées/écrans).

### ✨ Nouveautés v1.15.2
- **Films & Séries en défilement infini** : chargement continu au scroll (par lots de 60) au lieu de la pagination.

### ✨ Nouveautés v1.15.1
- **Trakt** : marquage série/épisode apparié par **ID TMDB** (plus de mauvaise série homonyme ajoutée).

### ✨ Nouveautés v1.15.0
- **« Marquer comme vu » partout** : bouton **✓ Vu** dans les fiches **film** et **série** (série entière), **✓ par épisode** dans la liste, et sur les affiches de **séries** (écran Séries, recherche). Tout est **synchronisé avec Trakt** (film, série entière, épisode — ajout/retrait de l'historique).

### ✨ Nouveautés v1.14.2
- **Détail film** : l'affiche reste celle du fournisseur (cohérente avec la liste) au lieu d'une affiche TMDB parfois issue d'un mauvais match.

### ✨ Nouveautés v1.14.1
- **Correctif** : un film/série n'affiche plus l'EPG d'une chaîne live précédente.

### ✨ Nouveautés v1.14.0
- **Lecture des formats non supportés (MKV, AVI, WMV…)** : conversion **à la volée** via un relais ffmpeg dédié (remux/transcode → HLS local) — déclenchée automatiquement pour les conteneurs que le lecteur intégré ne sait pas ouvrir, et en secours si la lecture échoue. Aucune dépendance externe ; identique macOS/Windows.

### ✨ Nouveautés v1.13.3
- **Synchro « vu » bidirectionnelle avec Trakt** : les films/épisodes déjà vus sur **Trakt** sont marqués vus dans KTV (films par titre+année, épisodes par série+saison+épisode) ; et le marquage manuel/auto dans KTV se synchronise vers Trakt.

### ✨ Nouveautés v1.13.2
- **Historique** : date affichée sur **toutes** les cartes (repli « Vu récemment » pour les anciennes entrées).
- **Marquer comme vu** : la bascule manuelle ✓ (films) synchronise avec Trakt (ajout/retrait).

### ✨ Nouveautés v1.13.1
- **Badge ✓ Vu sur tous les écrans** (films). **Séries** : enchaînement auto épisode **et saison suivante** ; **saison ✓** quand tous ses épisodes sont vus.
- **Historique** trié par **date de visionnage** + date affichée.

### ✨ Nouveautés v1.13.0
- **Marquer comme vu** (films & séries) : contenus terminés (≥ 90 % ou fin) **marqués vus automatiquement** ; badge **✓ Vu** sur les affiches (bascule manuelle au survol) et ✓ sur les épisodes vus.

### ✨ Nouveautés v1.12.3
- **Guide TV** : au survol d'un programme, **popover affichant le synopsis complet** (les blocs le tronquent à 2 lignes).

### ✨ Nouveautés v1.12.2
- **Programme en cours fiabilisé** : affiché même quand la grille du fournisseur a un trou (ex. TF1 affichait « En direct » sans programme) — repli automatique sur le XMLTV pour combler le programme du moment.

### ✨ Nouveautés v1.12.1
- **Historique** en **pleine largeur** + **chargement progressif** (infinite loading) + **aperçu de chaîne au survol** (avec son).

### ✨ Nouveautés v1.12.0
- **Rappels de programme** : bouton **🔔 Me rappeler** sur les programmes à venir du Guide TV → notification système à l'heure de début (clic = ouvre la chaîne). Réactivés automatiquement au lancement.
- **Historique de visionnage** : nouvel onglet **🕘 Historique** (jusqu'à 100 entrées) avec reprise rapide et bouton *Vider*. La rangée « Reprendre la lecture » propose *tout voir ›*.

### ✨ Nouveautés v1.11.8
- **Descriptions des programmes (Guide TV)** : quand le fournisseur ne fournit pas le synopsis, KTV le complète depuis le **XMLTV** (apparié par horaire/titre).

### ✨ Nouveautés v1.11.7
- **Titres de programmes sur 2 lignes** (grille Live TV + Guide TV) au lieu d'être tronqués.
- **EPG de secours enrichi** : capture des descriptions `<desc>` du XMLTV.

### ✨ Nouveautés v1.11.6
- **Indicateur de chargement** du programme sur les cartes Live TV (plus de carte vide pendant la récupération de l'EPG).
- **Hero accueil (chaîne live)** : titre + **description** du programme + programme suivant.

### ✨ Nouveautés v1.11.5
- **Hero accueil d'une chaîne live** : dégradé + logo + programme EPG (fini la zone noire).
- **Backdrops & synopsis TMDB rétablis** (films & séries).

### ✨ Nouveautés v1.11.4
- **Aperçu au survol fluide** : même mise en mémoire tampon que le lecteur (fini les saccades).

### ✨ Nouveautés v1.11.3
- **Correctif : rail Favoris vide en Live TV** (les favoris n'apparaissaient que sur l'accueil) — dû à un accès `window.state` invalide.
- **Aperçu au survol avec le son**.
- **Bouton favori ☆/★ dans le lecteur** : ajouter/retirer la chaîne en cours des favoris directement depuis la page de lecture.
- **« Reprendre la lecture »** : les cartes de chaînes affichent désormais le **programme EPG en cours**.

### ✨ Nouveautés v1.11.2
- **Correctif lecture Live TV** : sous Electron 42, le worker `blob:` de mpegts.js était bloqué par la politique de sécurité (CSP) → les chaînes live (et l'aperçu) ne démarraient plus. Ajout de `worker-src 'self' blob:`. (Films & séries, en hls.js, n'étaient pas affectés.)
- **Aperçu au survol sur l'accueil** : disponible aussi dans la rangée « Reprendre la lecture » (chaînes live).

### ✨ Nouveautés v1.11.1
- **Token TMDB retiré de l'app** : les métadonnées passent désormais par un **proxy** (Cloudflare Worker `ktv-tmdb`) qui garde le token côté serveur. Possibilité d'utiliser sa propre clé TMDB v4 dans les réglages (appel direct).
- **Pointeur de restream durci** (Worker `restream-pointer`) : écriture authentifiée et **limitée aux tunnels `*.trycloudflare.com`** (un secret extrait ne peut plus rediriger vers un hôte arbitraire).

### ✨ Nouveautés v1.11 — audit & durcissement
- **Sécurité renforcée** : `sandbox` activé, navigation/ouverture de fenêtres verrouillées, permissions web refusées par défaut, validation des URL (http/https) sur les liens externes/playlists/téléchargements, identifiants Xtream masqués dans les messages d'erreur. Le **relais n'écoute en LAN que pour le restream** (loopback sinon).
- **Electron 42** (depuis 33, EOL) : correctifs de sécurité Chromium à jour.
- **Corrections** : plus d'enregistrement de la mauvaise chaîne quand un relais est actif ; l'aperçu au survol n'ouvre plus de 2ᵉ connexion pendant une lecture ; option « Favoris » qui ne réapparaît plus dans le sélecteur ; détection « en direct » de l'EPG sans heure de fin ; scrobble Trakt fiabilisé ; comparaison de chaîne par identifiant.

### ✨ Nouveautés v1.10
- **Aperçu de chaîne au survol (Live TV)** : un mini-lecteur muet se lance automatiquement au survol d'une chaîne (anti-rebond, faible latence), pour zapper à l'œil sans ouvrir le lecteur. Désactivable dans *Réglages → Lecture & tampon*.
- **Favoris hors de la liste** : les chaînes favorites ne sont plus en tête de la liste / du sélecteur de catégories — elles disposent désormais d'un **rail dédié** en haut de l'écran Live TV, séparé de la liste.
- **Mise à jour ciblée par plateforme** : macOS n'affiche plus une mise à jour qui ne concerne que Windows (et inversement). La plateforme concernée est déduite des notes de version (`Plateformes: …`, tags `[win-only]` / `[mac-only]` / `[all]`) ou, à défaut, du titre de la release.

### ✨ Nouveautés v1.9.2 — corrections Windows
- **Icône d'application Windows** : `.ico` dédiée (16→256 px) au lieu de l'icône Electron par défaut, dans la barre des tâches et sur l'exécutable.
- **Barres de défilement masquées** : plus de scrollbars horizontales visibles sur les rangées (Films, Séries, EPG…) — rendu *overlay* façon macOS, le défilement reste actif.
- **Reprise de lecture des films enfin fiable** : la position est désormais sauvegardée même quand le flux VOD ne renseigne pas sa durée (fallback sur la plage *seekable*), donc la **barre de progression** et le **temps restant** s'affichent dans *Reprendre la lecture*.

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

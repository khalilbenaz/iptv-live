# KTV

Lecteur **Xtream Codes** pour **macOS (Apple Silicon)** — interface moderne par sections : **Live TV, Films (VOD), Séries, Guide TV (EPG)**, enregistrement, restream et téléchargements.

**▶︎ [Télécharger la dernière version (macOS Apple Silicon)](https://github.com/khalilbenaz/ktv/releases/latest)**

> Anciennement « IPTV Live ». Le dépôt et l'application ont été renommés **KTV** (bundle id `com.kba.ktv`).

## Fonctionnalités

### Navigation & accueil
- Interface à **sections** (barre latérale) : Accueil · Live TV · Films · Séries · Guide TV · Enregistrements · Réglages.
- **Accueil** type streaming : hero « reprendre », rangées horizontales (Vu récemment, favoris, catégories).
- **Accueil configurable** : choix dans *Réglages* des catégories (Live / Films / Séries) affichées en rangées, avec bouton **« tout voir »** ouvrant la catégorie complète.
- Recherche globale, **vu récemment**, favoris.

### Lecture
- Connexion Xtream (URL / utilisateur / mot de passe mémorisés, **reconnexion automatique** au lancement, bouton afficher/masquer le mot de passe).
- **Live TV** en grille de cartes (logo + qualité 8K/4K/FHD/HD/SD + EPG *now/next*), lecture 1 clic (`mpegts.js` natif Xtream, fallback `hls.js`).
- **Films (VOD)** et **Séries** (saisons/épisodes) — catégories françaises.
- **Enchaînement automatique** de l'épisode suivant.
- **Guide TV** : grille EPG (programmes en cours + à venir) par catégorie, noms de chaînes longs affichés sur **2 lignes**.

### Enregistrement, partage, téléchargement
- **Enregistrement** `.mp4` (sans ré-encodage), dossier **configurable**, liste groupée **par date**, export **WhatsApp** optionnel (son + 30 fps).
- **Restream** : une seule connexion fournisseur partagée vers plusieurs appareils du réseau local.
- **Lien public** (Cloudflare, gratuit) pour diffuser hors du LAN.
- **Téléchargements** : films et séries (épisode, **saison entière** ou **série complète**), **mis en file et traités un par un** (respect de la limite d'une seule connexion fournisseur), avec tiroir de progression.
- EPG externe **XMLTV** en secours : correspondance **par tvg-id** (`epg_channel_id`) puis par **nom normalisé** (gère préfixes pays `FR:`/`TR:`, ballon stylisé `⚽`, exposants `ᴴᴰ`, choix de la langue) → récupère le programme des chaînes non taguées comme *beIN Sports*. Détails de l'abonnement.
- **EPG sport via l'API KTV** (Cloudflare Worker `ktv-epg`) : pour les chaînes sport sans EPG fournisseur (beIN Sports, Canal+, Eurosport, L'Équipe…), un service maison agrège la grille du jour depuis des sources publiques et la sert normalisée — corrigeable côté serveur sans mise à jour de l'app. Heures converties en local automatiquement.

> ⚠️ Abonnements à **1 connexion** : lecture, enregistrement et restream passent tous par un **relais local** unique → 1 seule connexion fournisseur. Conséquence : tous les spectateurs d'un restream regardent **la même chaîne**.

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
- Enregistrements : dossier choisi dans **Réglages → Changer le dossier**, sinon `~/IPTV Live Recordings`.
- Téléchargements : `~/IPTV Live Downloads`.
- Le lien public télécharge `cloudflared` au 1er usage (stocké dans le dossier de données de l'app).

## Stack
Electron · ffmpeg-static · hls.js · mpegts.js · @electron/packager

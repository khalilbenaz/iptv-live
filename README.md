# IPTV Live

Lecteur IPTV **Xtream Codes** — *live TV uniquement* (pas de VOD), UX simple, multiplateforme **Windows + macOS (Apple Silicon)**.

## Fonctionnalités
- Connexion Xtream (URL / utilisateur / mot de passe, mémorisée).
- Catégories + recherche + filtre par **qualité** (8K / 4K / FHD / HD / SD) avec badges.
- Lecture live 1 clic (`mpegts.js` natif Xtream, fallback `hls.js`), clic vidéo ne met **pas** en pause.
- **Enregistrement** `.mp4` (sans ré-encodage), dossier d'enregistrement **configurable** (disque externe…).
- **Restream** : une seule connexion fournisseur partagée vers plusieurs appareils du réseau local.
- **Tunnel public** (Cloudflare, gratuit) pour diffuser hors du LAN.
- Sidebar réductible, détails de l'abonnement.

> ⚠️ Abonnements à **1 connexion** : lecture, enregistrement et restream passent tous par un **relais local** unique → 1 seule connexion fournisseur. Conséquence : tous les spectateurs d'un restream regardent **la même chaîne**.

## Développement
```bash
npm install
npm start
```

## Build d'une version portable

### Windows (sur Windows)
```bash
npm install
npm run build:win
```
→ `portable/IPTV Live-win32-x64/IPTV Live.exe` (double-clic, aucune installation).

### macOS Apple Silicon (sur un Mac M1/M2/M3)
```bash
npm install
npm run build:mac
```
→ `portable/IPTV Live-darwin-arm64/IPTV Live.app`

> Le build doit être lancé **sur la plateforme cible** : `ffmpeg-static` télécharge le binaire ffmpeg correspondant à l'OS au moment du `npm install`.

> macOS : l'app n'est pas signée. Au 1er lancement, **clic droit → Ouvrir**, ou :
> `xattr -dr com.apple.quarantine "IPTV Live.app"`

## Notes
- Enregistrements : dossier choisi dans **ℹ️ Infos → Changer le dossier**, sinon `~/IPTV Live Recordings`.
- Le tunnel télécharge `cloudflared` au 1er usage (stocké dans le dossier de données de l'app).

## Stack
Electron · ffmpeg-static · hls.js · mpegts.js · @electron/packager

// restream-pointer — auto-découverte de l'URL publique du restream KTV.
// L'app KTV publie (POST) l'URL trycloudflare active ; le site la lit (GET) pour
// basculer automatiquement. Durcissements vs version d'origine :
//   - écriture authentifiée par secret Cloudflare (env.AUTH_SECRET, pas de secret
//     en clair dans le code du Worker) ;
//   - l'URL publiée DOIT être vide ou un tunnel https://*.trycloudflare.com — ainsi
//     un secret extrait de l'app ne permet PAS de rediriger vers un hôte arbitraire.
// Contrat conservé : GET /current -> {"url","updatedAt"} ; POST /current {"url"} + X-Auth.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth',
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

function isAllowedUrl(u) {
  if (u === '') return true;                       // chaîne vide = effacer le pointeur
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && /(^|\.)trycloudflare\.com$/i.test(x.hostname);
  } catch { return false; }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const KEY = 'pointer';

    if (req.method === 'GET') {
      const raw = await env.POINTER_KV.get(KEY);
      const v = raw ? JSON.parse(raw) : { url: '', updatedAt: 0 };
      return json(v);
    }

    if (req.method === 'POST') {
      if (!env.AUTH_SECRET || req.headers.get('X-Auth') !== env.AUTH_SECRET) {
        return json({ error: 'unauthorized' }, 401);
      }
      let body;
      try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      const url = typeof body.url === 'string' ? body.url.trim() : '';
      if (!isAllowedUrl(url)) return json({ error: 'url non autorisée (trycloudflare uniquement)' }, 400);
      const v = { url, updatedAt: Date.now() };
      try {
        await env.POINTER_KV.put(KEY, JSON.stringify(v));
      } catch (e) {
        return json({ error: 'kv: ' + (e && e.message || String(e)) }, 500);
      }
      return json({ ok: true, ...v });
    }

    return json({ error: 'method not allowed' }, 405);
  },
};

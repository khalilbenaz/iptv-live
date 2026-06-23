// ktv-tmdb — proxy TMDB pour KTV.
// Garde le token TMDB côté serveur (secret Cloudflare TMDB_TOKEN) au lieu de
// l'embarquer dans l'app distribuée. Ne proxifie que les chemins API /3/...
// (les images image.tmdb.org sont publiques et restent appelées en direct).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS });

    const url = new URL(req.url);
    if (!url.pathname.startsWith('/3/')) {
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (!env.TMDB_TOKEN) {
      return new Response(JSON.stringify({ error: 'TMDB_TOKEN non configuré' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    const upstream = 'https://api.themoviedb.org' + url.pathname + url.search;
    let r;
    try {
      r = await fetch(upstream, { headers: { Authorization: 'Bearer ' + env.TMDB_TOKEN, accept: 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream' }), { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    const body = await r.text();
    return new Response(body, {
      status: r.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        // Les métadonnées TMDB bougent peu : cache CDN 24 h.
        'Cache-Control': r.ok ? 'public, max-age=86400' : 'no-store',
      },
    });
  },
};

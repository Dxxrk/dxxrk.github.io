const _memCache = new Map();

async function _fetch(url) {
  if (_memCache.has(url)) return _memCache.get(url);

  const key = `owstats:${url}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) {
      const parsed = JSON.parse(hit);
      _memCache.set(url, parsed);
      return parsed;
    }
  } catch (_) {}

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) throw new Error('Player not found — profile may be private or battletag incorrect');
    if (res.status === 422) throw new Error('Invalid player ID format');
    if (res.status === 429) throw new Error('Rate limited — please wait a moment');
    if (res.status === 500) throw new Error('OverFast API error — try again shortly');
    throw new Error(`HTTP ${res.status}`);
  }

  const data = await res.json();
  _memCache.set(url, data);
  try { sessionStorage.setItem(key, JSON.stringify(data)); } catch (_) {}
  return data;
}

const API = {
  summary(playerId) {
    const url = `${CONFIG.apiBase}/players/${encodeURIComponent(playerId)}/summary`;
    return _fetch(url);
  },

  stats(playerId, platform = CONFIG.platform, gamemode = CONFIG.gamemode) {
    const url = `${CONFIG.apiBase}/players/${encodeURIComponent(playerId)}/stats/career?platform=${platform}&gamemode=${gamemode}`;
    return _fetch(url);
  },

  search(name) {
    const url = `${CONFIG.apiBase}/players?name=${encodeURIComponent(name)}`;
    return _fetch(url);
  },

  clearCache() {
    _memCache.clear();
    try {
      Object.keys(sessionStorage)
        .filter(k => k.startsWith('owstats:'))
        .forEach(k => sessionStorage.removeItem(k));
    } catch (_) {}
  },
};

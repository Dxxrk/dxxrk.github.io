// ── Rating curve ─────────────────────────────────────────────────────────────
// Logistic S-curve: average player (value = midpoint) returns exactly 0.5.
// Multiply by a weight to get a component's point contribution.
// There's no hard cap — performance above midpoint always scores higher,
// but gains diminish asymptotically (like a real Elo system).
function elo_curve(value, midpoint, scale) {
  return 1 / (1 + Math.exp(-(value - midpoint) / scale));
}

// ── Ranked Score ─────────────────────────────────────────────────────────────
// Elo-style logistic rating using every meaningful per-10m stat the API exposes.
// Each stat runs through a sigmoid curve: average performance → 0.5 of that
// component's weight. No hard caps — better always scores higher, but gains
// diminish asymptotically. All weights sum to 1000, so an average player in
// every category scores exactly 500.
//
// Midpoints calibrated to OW2 competitive averages across all roles.
// Deaths are inverted: fewer deaths = more points.
// Combined output (dmg + heal) is role-neutral: 10k healing ≡ 10k damage.
// Time stats are in seconds; 10m window so 90s on-obj ≈ 1.5 min/game segment.
const SCORE_COMPONENTS = [
  // [key, midpoint, scale, weight, invert]
  ['__output',                              9000, 3500, 200, false], // dmg + heal
  ['eliminations_avg_per_10_min',             13,    4, 100, false],
  ['final_blows_avg_per_10_min',               8,    3,  80, false],
  ['deaths_avg_per_10_min',                    7,  2.5,  90, true ], // inverted
  ['solo_kills_avg_per_10_min',                3,  1.5,  50, false],
  ['assists_avg_per_10_min',                  10,    4,  70, false],
  ['objective_time_avg_per_10_min',           90,   45,  60, false], // seconds
  ['objective_kills_avg_per_10_min',           4,    2,  50, false],
  ['objective_contest_time_avg_per_10_min',   45,   25,  40, false], // seconds
];
// Weights sum to 740; Win Rate adds 260 → 1000 total.

function ranked_score(flat) {
  const wr         = win_rate(flat);
  const dmg_per10  = stat_val(flat, 'average', 'hero_damage_done_avg_per_10_min') ?? 0;
  const heal_per10 = stat_val(flat, 'average', 'healing_done_avg_per_10_min')     ?? 0;

  if (wr == null) return null;

  let total = elo_curve(wr, 50, 7) * 260; // Win Rate — highest single weight

  for (const [key, mid, scale, weight, invert] of SCORE_COMPONENTS) {
    const v = key === '__output'
      ? dmg_per10 + heal_per10
      : (stat_val(flat, 'average', key) ?? mid); // default to midpoint if missing
    const curve = elo_curve(v, mid, scale);
    total += (invert ? 1 - curve : curve) * weight;
  }

  return Math.round(total);
}

// Score → color: red → orange → gold → cyan → green (500 = community average)
function score_color(score) {
  if (score == null) return 'var(--txt-2)';
  if (score >= 750) return 'var(--ok)';     // elite
  if (score >= 620) return 'var(--cyan)';   // above average
  if (score >= 500) return 'var(--warn)';   // around average
  if (score >= 400) return 'var(--accent)'; // below average
  return 'var(--red)';                       // struggling
}

function score_tier_label(score) {
  if (score == null) return 'Unrated';
  if (score >= 750) return 'Elite';
  if (score >= 620) return 'Above Average';
  if (score >= 500) return 'Average';
  if (score >= 400) return 'Below Average';
  return 'Struggling';
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt_time(seconds) {
  if (seconds == null || isNaN(seconds)) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${rem}s`;
}

function fmt_num(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return (n / 1_000).toFixed(0) + 'K';
  return (+n).toLocaleString();
}

function fmt_full(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString();
}

function fmt_float(n, dec = 2) {
  if (n == null || isNaN(n)) return '—';
  return (+n).toFixed(dec);
}

function fmt_pct(n, dec = 1) {
  if (n == null || isNaN(n)) return '—';
  return `${(+n).toFixed(dec)}%`;
}

function fmt_stat(key, value) {
  if (value == null) return '—';
  if (is_time_key(key)) return fmt_time(value);
  if (is_pct_key(key))  return fmt_pct(value);
  if (Number.isInteger(value)) return fmt_num(value);
  return fmt_float(value, 2);
}

function is_time_key(key) {
  return /time|duration/.test(key);
}

function is_pct_key(key) {
  return /accuracy|percentage|win_pct/.test(key);
}

// ── Stat parsing ──────────────────────────────────────────────────────────────

function parse_career(data, platform, gamemode) {
  // New OverFast format: when platform+gamemode are passed as query params,
  // the response IS the hero-keyed object directly (no nesting).
  if (data && typeof data === 'object' && 'all-heroes' in data) return data;
  // Legacy nested fallback
  return data?.[platform]?.[gamemode]?.career_stats ?? null;
}

// Returns flat { category: { key: { value, label } } } for a single hero block.
// Handles both the new format { category: { key: rawValue } }
// and the legacy format [ { category, stats: [{key,label,value}] } ].
function flatten_hero(heroData) {
  const out = {};
  if (!heroData) return out;

  // New format: plain object keyed by category name
  if (typeof heroData === 'object' && !Array.isArray(heroData)) {
    for (const [cat, stats] of Object.entries(heroData)) {
      if (typeof stats !== 'object' || stats === null) continue;
      out[cat] = {};
      for (const [key, value] of Object.entries(stats)) {
        out[cat][key] = { value, label: stat_label(key) };
      }
    }
    return out;
  }

  // Legacy format: array of { category, stats: [{key, label, value}] }
  for (const cat of heroData) {
    out[cat.category] = {};
    for (const s of cat.stats) {
      out[cat.category][s.key] = { value: s.value, label: s.label };
    }
  }
  return out;
}

function stat_val(flat, category, key) {
  return flat?.[category]?.[key]?.value ?? null;
}

// ── Computed stats ────────────────────────────────────────────────────────────

function win_rate(flat) {
  const played = stat_val(flat, 'game', 'games_played');
  if (!played) return null;
  // API returns either games_won or games_lost depending on version
  const won  = stat_val(flat, 'game', 'games_won');
  if (won  != null) return (won  / played) * 100;
  const lost = stat_val(flat, 'game', 'games_lost');
  if (lost != null) return ((played - lost) / played) * 100;
  return null;
}

function kda(flat) {
  const elims  = stat_val(flat, 'combat', 'eliminations');
  const deaths = stat_val(flat, 'combat', 'deaths');
  if (!deaths) return elims ? elims : null;
  return elims / deaths;
}

function kd(flat) {
  const kills  = stat_val(flat, 'combat', 'final_blows');
  const deaths = stat_val(flat, 'combat', 'deaths');
  if (!deaths) return kills ?? null;
  return kills / deaths;
}

// ── Rank helpers ──────────────────────────────────────────────────────────────

const RANK_ORDER = ['champion','grandmaster','master','diamond','platinum','gold','silver','bronze'];

function best_rank(competitive) {
  if (!competitive) return null;
  // OW2: roles are keyed as 'tank', 'damage', 'support' or 'open'
  const roles = ['damage', 'tank', 'support', 'open'];
  let best = null;
  for (const role of roles) {
    const r = competitive[role];
    if (!r?.division) continue;
    if (!best) { best = { ...r, role }; continue; }
    const bi = RANK_ORDER.indexOf(best.division.toLowerCase());
    const ri = RANK_ORDER.indexOf(r.division.toLowerCase());
    if (ri < bi) best = { ...r, role };
  }
  if (!best && competitive.division) return competitive;
  return best;
}

// Hero (API kebab key) → role. Used to figure out a player's most-played role.
const HERO_ROLE = {
  // Tank
  'dva':'tank','doomfist':'tank','junker-queen':'tank','mauga':'tank','orisa':'tank',
  'ramattra':'tank','reinhardt':'tank','roadhog':'tank','sigma':'tank','winston':'tank',
  'wrecking-ball':'tank','zarya':'tank','hazard':'tank',
  // Damage
  'ashe':'damage','bastion':'damage','cassidy':'damage','echo':'damage','genji':'damage',
  'hanzo':'damage','junkrat':'damage','mei':'damage','pharah':'damage','reaper':'damage',
  'sojourn':'damage','soldier-76':'damage','sombra':'damage','symmetra':'damage',
  'torbjorn':'damage','tracer':'damage','venture':'damage','widowmaker':'damage','freja':'damage',
  // Support
  'ana':'support','baptiste':'support','brigitte':'support','illari':'support','juno':'support',
  'kiriko':'support','lifeweaver':'support','lucio':'support','mercy':'support','moira':'support',
  'zenyatta':'support',
};

// Given a {heroKey: seconds} map, return the role with the most total playtime.
function main_role(timemap) {
  const totals = { tank: 0, damage: 0, support: 0 };
  for (const [hero, secs] of Object.entries(timemap || {})) {
    const role = HERO_ROLE[hero];
    if (role) totals[role] += secs;
  }
  let top = null, max = 0;
  for (const [role, t] of Object.entries(totals)) {
    if (t > max) { max = t; top = role; }
  }
  return top; // null if no recognised hero playtime
}

// Rank to show on the leaderboard: the player's MOST-PLAYED role's rank.
// Falls back to their best rank if that role isn't placed / no playtime data.
function most_played_role_rank(timemap, competitive) {
  if (!competitive) return null;
  const role = main_role(timemap);
  if (role && competitive[role]?.division) {
    return { ...competitive[role], role };
  }
  return best_rank(competitive);
}

function rank_class(division) {
  if (!division) return 'rank-unranked';
  return `rank-${division.toLowerCase()}`;
}

function rank_label(rankData) {
  if (!rankData?.division) return 'Unranked';
  const d = cap(rankData.division);
  const t = rankData.tier;
  return t ? `${d} ${t}` : d;
}

function rank_color(division) {
  const map = {
    champion:     '#f090e0',
    grandmaster:  '#c0b0ff',
    master:       '#50d880',
    diamond:      '#50aaff',
    platinum:     '#40ddd8',
    gold:         '#ffe040',
    silver:       '#c0d0e0',
    bronze:       '#e08840',
  };
  return map[division?.toLowerCase()] ?? '#6b7280';
}

function rank_badge_html(rankData, iconSize) {
  const cls   = rank_class(rankData?.division);
  const label = rank_label(rankData);
  const icon  = rankData?.rank_icon;
  const sz    = iconSize ?? 24;
  const img   = icon
    ? `<img src="${icon}" alt="" class="rank-icon-img" style="width:${sz}px;height:${sz}px">`
    : '';
  return `<span class="rank-badge ${cls}">${img}${label}</span>`;
}

function wr_class(wr) {
  if (wr == null) return '';
  if (wr >= 55) return 'wr-high';
  if (wr >= 45) return 'wr-mid';
  return 'wr-low';
}

// ── Hero / stat name helpers ──────────────────────────────────────────────────

const HERO_NAMES = {
  'all-heroes':    'All Heroes',
  'dva':           'D.Va',
  'lucio':         'Lúcio',
  'torbjorn':      'Torbjörn',
  'soldier-76':    'Soldier: 76',
  'wrecking-ball': 'Wrecking Ball',
  'junker-queen':  'Junker Queen',
  'lifeweaver':    'Lifeweaver',
  'illari':        'Illari',
  'venture':       'Venture',
  'juno':          'Juno',
  'hazard':        'Hazard',
};

function hero_name(key) {
  return HERO_NAMES[key] ?? key.split('-').map(cap).join(' ');
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function stat_label(key) {
  return key.split('_').map(cap).join(' ');
}

// Category display names + accent colors
const CAT_META = {
  combat:         { label: 'Combat',        color: '#ff4455' },
  game:           { label: 'Game',          color: '#ff9f0a' },
  average:        { label: 'Averages',      color: '#00ccff' },
  best:           { label: 'Best',          color: '#c060ff' },
  hero_specific:  { label: 'Hero Specific', color: '#00ffe0' },
  match_awards:   { label: 'Awards',        color: '#ffe040' },
  assists:        { label: 'Assists',        color: '#2edc6a' },
};

function cat_label(key) { return CAT_META[key]?.label ?? cap(key); }
function cat_color(key) { return CAT_META[key]?.color ?? '#6b7280'; }

// Returns { heroKey: seconds } for the time-played chart.
function hero_time_map(data, platform, gamemode) {
  // New format: data is hero-keyed; time_played lives at heroData.game.time_played
  if (data && 'all-heroes' in data) {
    const out = {};
    for (const [hero, heroData] of Object.entries(data)) {
      if (hero === 'all-heroes') continue;
      const tp = heroData?.game?.time_played;
      if (tp != null && tp > 0) out[hero] = tp;
    }
    return out;
  }
  // Legacy format with heroes_comparisons
  const cmp = data?.[platform]?.[gamemode]?.heroes_comparisons;
  if (!cmp) return {};
  const tp = cmp.time_played;
  if (!tp?.values) return {};
  const out = {};
  for (const { hero, value } of tp.values) out[hero] = value;
  return out;
}

// Convert "Name-1234" → "Name#1234" for display
function fmt_battletag(id) {
  return id ? id.replace(/-(\d+)$/, '#$1') : id;
}

// Relative time like "just now", "4m ago", "2h ago"
function fmt_ago(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10)  return 'just now';
  if (s < 60)  return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function show_error(container, msg) {
  container.innerHTML = `
    <div class="error-state">
      <span class="error-icon">⚠</span>
      <span>${msg}</span>
    </div>`;
}

function skeleton_rows(n, cols) {
  return Array.from({ length: n }, () => `
    <tr class="skeleton-row">
      ${Array.from({ length: cols }, () =>
        `<td><span class="skeleton skeleton-cell" style="width:${40 + Math.random()*40}%"></span></td>`
      ).join('')}
    </tr>`).join('');
}

function avatar_el(src, label, size = 36) {
  if (src) {
    const img = el('img', 'player-avatar');
    img.src = src;
    img.alt = label;
    img.width = size;
    img.height = size;
    img.onerror = function() {
      const ph = avatar_placeholder(label, size);
      this.replaceWith(ph);
    };
    if (size !== 36) { img.style.width = size + 'px'; img.style.height = size + 'px'; }
    return img;
  }
  return avatar_placeholder(label, size);
}

function avatar_placeholder(label, size = 36) {
  const ph = el('div', 'player-avatar-placeholder');
  ph.textContent = (label || '?').charAt(0).toUpperCase();
  ph.style.width = size + 'px';
  ph.style.height = size + 'px';
  ph.style.fontSize = Math.floor(size * 0.38) + 'px';
  return ph;
}

// Ranked Score logic (ranked_score / score_color / score_tier_label) lives in
// utils.js so the player profile page can reuse it.

// ── State ─────────────────────────────────────────────────────────────────────
// Cancellation token so a re-render (e.g. sort change) aborts an in-flight
// row-by-row cascade from a previous render.
let cascadeToken = 0;

let state = {
  viewMode:    'overview',   // 'overview' | 'allstats'
  overviewSort: 'score',     // 'score' | 'rank' | 'win_rate' | 'kd'
  allSortKey:  '__rank',
  allSortDir:  1,            // 1 = ascending (rank: lower idx = better)
  players:     [],
  allCols:     [],
  cascade:     false,        // when true, next render reveals rows one-by-one
  fetchedAt:   null,         // ms timestamp of last successful fetch
};

// ── Snapshot cache ──────────────────────────────────────────────────────────
// Stores the fully-computed leaderboard so returning to this page (e.g. after
// viewing a player's profile) renders instantly: no spinner, no stagger, no
// cascade. Lives in sessionStorage so it clears when the tab closes; the
// Refresh button also wipes it via API.clearCache().
const LB_CACHE_KEY = 'owstats:lb-snapshot-v4';
const LB_CACHE_TTL = 15 * 60 * 1000; // 15 min, then a return visit refetches

function loadSnapshot() {
  try {
    const raw = sessionStorage.getItem(LB_CACHE_KEY);
    if (!raw) return null;
    const { ts, ids, players } = JSON.parse(raw);
    if (Date.now() - ts > LB_CACHE_TTL) return null;
    // Invalidate if the configured player list changed
    if (ids !== CONFIG.players.map(p => p.id).join(',')) return null;
    return { players, ts };
  } catch (_) { return null; }
}

function saveSnapshot() {
  try {
    // Strip careerBlocks (the full per-hero dump); the leaderboard only needs
    // the flattened all-heroes stats, and dropping it keeps us well under quota.
    const slim = state.players.map(p => ({
      cfg: p.cfg, summary: p.summary, flat: p.flat,
      _roleRank: p._roleRank,
      _wr: p._wr, _kd: p._kd, _score: p._score, err: p.err,
    }));
    sessionStorage.setItem(LB_CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      ids: CONFIG.players.map(p => p.id).join(','),
      players: slim,
    }));
  } catch (_) {}
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function initLeaderboard() {
  if (!CONFIG.players.length) {
    renderEmpty();
    return;
  }

  // Returning visit with a fresh snapshot → render instantly, fully populated.
  const snap = loadSnapshot();
  if (snap) {
    state.players = snap.players;
    state.fetchedAt = snap.ts;
    buildColumns();
    state.cascade = false;
    render();
    return;
  }

  // Cold load: table starts blank, no rows painted until ALL data is in and we
  // know the final ranked-score order. Then rows cascade in, best-first.
  state.players = [];
  renderLoading();
  await fetchAll();
}

function renderEmpty() {
  qs('#lb-container').innerHTML = `
    <div class="empty-state">
      <h3>No Players Configured</h3>
      <p>Open <code>js/config.js</code> and add battletags to the <code>players</code> array.</p>
      <a href="lookup.html" class="btn btn-ghost">Look Up a Player</a>
    </div>`;
}

// Blank-but-busy state while data loads (no leaderboard rows yet)
function renderLoading() {
  qs('#lb-container').innerHTML = `
    <div class="lb-loading">
      <div class="lb-spinner"></div>
      <div class="lb-loading-text" id="lb-loading-text">Loading players…</div>
    </div>`;
}

function setLoadingProgress(loaded, total) {
  const t = qs('#lb-loading-text');
  if (t) t.textContent = `Loading players… ${loaded} / ${total}`;
  const pc = qs('#player-count');
  if (pc) pc.textContent = `Loading… ${loaded} of ${total} players`;
}

// ── Fetching ──────────────────────────────────────────────────────────────────
const STAGGER_MS = 250; // delay between starting each player's fetch (rate limit)

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchAll() {
  const total = CONFIG.players.length;
  let loaded = 0;
  setLoadingProgress(0, total);

  // Fetch every player (summary + career) staggered to respect OverFast's
  // per-second rate limit. We deliberately do NOT render rows here, so the table
  // stays blank until everything resolves so we can paint in true sorted order.
  const results = await Promise.all(
    CONFIG.players.map((cfg, i) =>
      delay(i * STAGGER_MS)
        .then(() => fetchPlayer(cfg))
        .catch(err => ({ cfg, err: err?.message ?? 'Unknown error' }))
        .then(result => {
          loaded++;
          setLoadingProgress(loaded, total);
          return result;
        })
    )
  );

  state.players = results;
  state.fetchedAt = Date.now();
  buildColumns();
  saveSnapshot();         // cache so a return visit is instant
  state.cascade = true;   // next render reveals rows one-by-one
  render();
}

async function fetchPlayer(cfg) {
  const compKey = CONFIG.platform === 'pc' ? 'pc' : 'console';
  const [summary, rawStats] = await Promise.all([
    API.summary(cfg.id),
    API.stats(cfg.id, CONFIG.platform, CONFIG.gamemode),
  ]);
  const careerBlocks = parse_career(rawStats, CONFIG.platform, CONFIG.gamemode);
  const flat = careerBlocks ? flatten_hero(careerBlocks['all-heroes']) : {};

  // Rank to display = the player's most-played role's rank (PC competitive)
  const timemap  = hero_time_map(careerBlocks, CONFIG.platform, CONFIG.gamemode);
  const roleRank = most_played_role_rank(timemap, summary?.competitive?.[compKey]);

  return {
    cfg, summary, careerBlocks, flat,
    _roleRank: roleRank,
    _wr: win_rate(flat), _kd: kd(flat), _score: ranked_score(flat),
  };
}

// Sort value for rank comparison (lower = better)
function _rankVal(rankData) {
  if (!rankData?.division) return 999;
  const idx = RANK_ORDER.indexOf(rankData.division.toLowerCase());
  return idx === -1 ? 999 : idx * 10 + (rankData.tier ?? 5);
}

// ── Column discovery (for All Stats view) ─────────────────────────────────────
function buildColumns() {
  const discovered = {};
  for (const p of state.players) {
    if (p.err || !p.flat) continue;
    for (const [cat, stats] of Object.entries(p.flat)) {
      if (!discovered[cat]) discovered[cat] = new Map();
      for (const [key, { label }] of Object.entries(stats)) {
        discovered[cat].set(key, label);
      }
    }
  }
  state.allCols = [];
  for (const [cat, keys] of Object.entries(discovered)) {
    for (const [key, label] of keys) {
      state.allCols.push({ key, label, group: cat });
    }
  }
}

// ── Rank sort value ───────────────────────────────────────────────────────────
// Sorts by the same rank shown in the table (most-played role).
function rankSortVal(p) {
  if (p.err) return 999;
  if (p._roleRank) return _rankVal(p._roleRank);
  if (!p.summary) return 999;
  const compKey = CONFIG.platform === 'pc' ? 'pc' : 'console';
  return _rankVal(best_rank(p.summary?.competitive?.[compKey]));
}

// ── Render dispatcher ─────────────────────────────────────────────────────────
function render() {
  updatePlayerCount();
  if (state.viewMode === 'overview') {
    qs('#sort-controls')?.classList.remove('hidden');
    renderOverview();
  } else {
    qs('#sort-controls')?.classList.add('hidden');
    renderAllStats();
  }
}

function updatePlayerCount() {
  const el = qs('#player-count');
  if (!el) return;
  const total = state.players.length;
  const ok    = state.players.filter(p => !p.err).length;
  const ago   = state.fetchedAt ? ` · updated ${fmt_ago(state.fetchedAt)}` : '';
  el.textContent = `${ok} of ${total} player${total !== 1 ? 's' : ''} loaded${ago}`;
}

// Keep the "updated Xm ago" label fresh without a full re-render
setInterval(() => {
  if (state.fetchedAt && state.players.length) updatePlayerCount();
}, 30000);

// Satisfying count-up for a number element (used on score cells)
function animateCount(el) {
  const target = +el.dataset.val;
  if (!Number.isFinite(target)) return;
  const dur = 700, start = performance.now();
  el.textContent = '0';
  function step(now) {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
    el.textContent = Math.round(target * eased);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// Paint rows into the table body. On the first render after loading
// (state.cascade), rows are appended one at a time so the leaderboard
// visibly expands top-to-bottom. Otherwise they're set all at once.
function paintRows(container, rowHtmls) {
  const tbody = container.querySelector('tbody');
  if (!tbody) return;

  const bindRow = tr => {
    if (!tr.dataset.playerId) return;
    tr.addEventListener('click', () => {
      window.location.href = `player.html?id=${encodeURIComponent(tr.dataset.playerId)}`;
    });
  };

  if (state.cascade) {
    state.cascade = false;
    const token = ++cascadeToken;
    rowHtmls.forEach((html, i) => {
      setTimeout(() => {
        if (token !== cascadeToken) return; // a newer render superseded us
        tbody.insertAdjacentHTML('beforeend', html);
        const tr = tbody.lastElementChild;
        tr.classList.add('reveal-row');
        tr.querySelectorAll('.js-countup').forEach(animateCount);
        bindRow(tr);
      }, i * 110);
    });
  } else {
    cascadeToken++; // cancel any in-flight cascade
    tbody.innerHTML = rowHtmls.join('');
    tbody.querySelectorAll('tr[data-player-id]').forEach(bindRow);
  }
}

// ── Overview render ───────────────────────────────────────────────────────────
const OVERVIEW_SORT_FNS = {
  score:    { asc: false, val: p => p._score },
  rank:     { asc: true,  val: p => rankSortVal(p) },
  win_rate: { asc: false, val: p => p._wr },
  kd:       { asc: false, val: p => p._kd },
};

// Position cell: medals for the top 3, a plain number after that.
const MEDALS = ['🥇', '🥈', '🥉'];
function posCell(i) {
  return i < 3
    ? `<td class="pos-cell pos-medal">${MEDALS[i]}</td>`
    : `<td class="pos-cell">${i + 1}</td>`;
}
// Extra <tr> class for podium rows (the #1 player is literally "on top").
function rowClass(i) {
  return i === 0 ? ' class="lb-top1"' : i < 3 ? ' class="lb-podium"' : '';
}

function renderOverview() {
  const container = qs('#lb-container');
  const compKey   = CONFIG.platform === 'pc' ? 'pc' : 'console';
  const sortDef   = OVERVIEW_SORT_FNS[state.overviewSort];

  const sorted = [...state.players].sort((a, b) => {
    const av = sortDef.val(a), bv = sortDef.val(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return sortDef.asc ? av - bv : bv - av;
  });

  const rowHtmls = sorted.map((p, i) => {
    if (p.err) return errRow(i + 1, p, 10);

    const best       = p._roleRank ?? best_rank(p.summary?.competitive?.[compKey]);
    const label      = p.cfg.label || p.cfg.id;
    const scoreClr   = score_color(p._score);
    const dmg_per10  = stat_val(p.flat, 'average', 'hero_damage_done_avg_per_10_min');
    const heal_per10 = stat_val(p.flat, 'average', 'healing_done_avg_per_10_min');
    const elim_per10 = stat_val(p.flat, 'average', 'eliminations_avg_per_10_min');
    const games      = stat_val(p.flat, 'game', 'games_played');

    return `<tr data-player-id="${p.cfg.id}"${rowClass(i)}>
      ${posCell(i)}
      <td class="left">${playerCell(p.summary?.avatar, label, p.cfg.id, i === 0)}</td>
      <td class="left">${rank_badge_html(best)}</td>
      <td class="num" style="color:${scoreClr};font-weight:700;font-size:15px">${p._score != null ? `<span class="js-countup" data-val="${p._score}">${p._score}</span>` : '–'}</td>
      <td class="num ${wr_class(p._wr)}">${p._wr != null ? fmt_pct(p._wr) : '–'}</td>
      <td class="num">${p._kd != null ? fmt_float(p._kd, 2) : '–'}</td>
      <td class="num">${dmg_per10  != null ? fmt_full(dmg_per10)  : '–'}</td>
      <td class="num">${heal_per10 != null ? fmt_full(heal_per10) : '–'}</td>
      <td class="num">${elim_per10 != null ? fmt_float(elim_per10, 1) : '–'}</td>
      <td class="num">${games != null ? fmt_num(games) : '–'}</td>
    </tr>`;
  });

  container.innerHTML = `
    <div class="lb-wrap">
      <table class="lb-table lb-overview">
        <thead>
          <tr>
            <th class="th-stat" style="width:44px;text-align:center">#</th>
            <th class="th-stat left">Player</th>
            <th class="th-stat left">Rank</th>
            <th class="th-stat">Ranked Score</th>
            <th class="th-stat">Win Rate</th>
            <th class="th-stat">K/D</th>
            <th class="th-stat">Dmg / 10m</th>
            <th class="th-stat">Heal / 10m</th>
            <th class="th-stat">Elims / 10m</th>
            <th class="th-stat">Games</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>`;

  paintRows(container, rowHtmls);
}

// ── All Stats render ──────────────────────────────────────────────────────────
function renderAllStats() {
  const container = qs('#lb-container');
  const compKey   = CONFIG.platform === 'pc' ? 'pc' : 'console';

  // Group columns by category
  const groupMap = {};
  for (const col of state.allCols) {
    if (!groupMap[col.group]) groupMap[col.group] = [];
    groupMap[col.group].push(col);
  }

  const arrow = key => {
    if (key !== state.allSortKey) return `<span class="sort-arrow">⇅</span>`;
    return `<span class="sort-arrow">${state.allSortDir === -1 ? '↓' : '↑'}</span>`;
  };
  const thCls = key => `th-stat${state.allSortKey === key ? ' sorted' : ''}`;

  const sorted = [...state.players].sort((a, b) => {
    const av = allStatsVal(a, state.allSortKey);
    const bv = allStatsVal(b, state.allSortKey);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * state.allSortDir;
    return (av - bv) * state.allSortDir;
  });

  // Group header row
  let groupRow = `<tr>
    <th class="th-group" colspan="3" style="color:var(--txt-3)">Player</th>`;
  for (const [grp, cols] of Object.entries(groupMap)) {
    groupRow += `<th class="th-group" colspan="${cols.length}" style="color:${cat_color(grp)}">${cat_label(grp)}</th>`;
  }
  groupRow += '</tr>';

  // Stat header row
  let statRow = `<tr>
    <th class="th-stat" style="width:44px;text-align:center">#</th>
    <th class="${thCls('__player')} left" data-sort="__player">Player ${arrow('__player')}</th>
    <th class="${thCls('__rank')} left" data-sort="__rank">Rank ${arrow('__rank')}</th>`;
  for (const [, cols] of Object.entries(groupMap)) {
    for (const col of cols) {
      statRow += `<th class="${thCls(col.key)}" data-sort="${col.key}">${col.label}${arrow(col.key)}</th>`;
    }
  }
  statRow += '</tr>';

  // Data rows
  const totalCols = 3 + state.allCols.length;
  const rowHtmls = sorted.map((p, i) => {
    if (p.err) return errRow(i + 1, p, totalCols);

    const best  = p._roleRank ?? best_rank(p.summary?.competitive?.[compKey]);
    const label = p.cfg.label || p.cfg.id;

    let tds = `
      ${posCell(i)}
      <td class="left">${playerCell(p.summary?.avatar, label, p.cfg.id, i === 0)}</td>
      <td class="left">${rank_badge_html(best)}</td>`;

    for (const [, cols] of Object.entries(groupMap)) {
      for (const col of cols) {
        const v = stat_val(p.flat, col.group, col.key);
        tds += `<td class="num">${fmt_stat(col.key, v)}</td>`;
      }
    }

    return `<tr data-player-id="${p.cfg.id}"${rowClass(i)}>${tds}</tr>`;
  });

  container.innerHTML = `
    <div class="lb-wrap">
      <table class="lb-table lb-allstats">
        <thead>${groupRow}${statRow}</thead>
        <tbody></tbody>
      </table>
    </div>`;

  container.querySelectorAll('[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.allSortKey === key) state.allSortDir *= -1;
      else { state.allSortKey = key; state.allSortDir = -1; }
      renderAllStats();
    });
  });

  paintRows(container, rowHtmls);
}

function allStatsVal(p, key) {
  if (p.err || !p.flat) return null;
  if (key === '__rank')   return rankSortVal(p);
  if (key === '__player') return (p.cfg.label || p.cfg.id).toLowerCase();
  for (const [, stats] of Object.entries(p.flat)) {
    if (stats[key] != null) return stats[key].value;
  }
  return null;
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function playerCell(avatar, label, id, crown = false) {
  const imgHtml = avatar
    ? `<img class="plyr-avatar" src="${avatar}" alt="${label}"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="plyr-avatar-ph" style="display:none">${label.charAt(0)}</div>`
    : `<div class="plyr-avatar-ph">${label.charAt(0)}</div>`;
  return `<div class="plyr-cell">
    <div class="plyr-av-wrap">${imgHtml}${crown ? '<span class="plyr-crown">👑</span>' : ''}</div>
    <div>
      <div class="plyr-name">${label}</div>
      <div class="plyr-id">${fmt_battletag(id)}</div>
    </div>
  </div>`;
}

function errRow(pos, p, colspan) {
  const label = p.cfg.label || p.cfg.id;
  return `<tr>
    <td class="pos-cell">${pos}</td>
    <td colspan="${colspan - 1}" class="left">
      <div class="plyr-cell">
        <div class="plyr-avatar-ph">${label.charAt(0)}</div>
        <div>
          <div class="plyr-name">${label}</div>
          <div class="plyr-id text-bad">⚠ ${p.err}</div>
        </div>
      </div>
    </td>
  </tr>`;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const TAGLINES = [
  'Who carried and who got carried.',
  'Bragging rights, quantified.',
  'The receipts are in.',
  'Numbers don\'t lie. Your friends might.',
  'Settling the group chat, one stat at a time.',
  'May the best teammate win.',
  'Proof for the next "I\'m better than you" argument.',
  'Glory, shame, and everything in between.',
];

document.addEventListener('DOMContentLoaded', () => {
  const tag = qs('#page-tagline');
  if (tag) tag.textContent = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];

  qs('#view-seg')?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      qs('#view-seg').querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.viewMode = btn.dataset.val;
      render();
    });
  });

  qs('#sort-seg')?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      qs('#sort-seg').querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      state.overviewSort = btn.dataset.val;
      renderOverview();
    });
  });

  qs('#refresh-btn')?.addEventListener('click', () => {
    API.clearCache();
    state.players = [];
    renderLoading();
    fetchAll();
  });

  initLeaderboard();
});

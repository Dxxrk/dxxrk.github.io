// ── State ─────────────────────────────────────────────────────────────────────
let pState = {
  playerId: null,
  platform: CONFIG.platform,
  gamemode: CONFIG.gamemode,
  summary: null,
  rawStats: null,
  careerBlocks: null,
  selectedHero: 'all-heroes',
};

// ── Entry point ───────────────────────────────────────────────────────────────
async function initPlayer() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');

  if (!id) {
    showPageError('No player ID specified. <a href="index.html">Go home</a>');
    return;
  }

  pState.playerId = id;
  document.title = `${fmt_battletag(id)} · Who's on Top?`;

  showLoading();

  try {
    const [summary, rawStats] = await Promise.all([
      API.summary(id),
      API.stats(id, pState.platform, pState.gamemode),
    ]);

    pState.summary   = summary;
    pState.rawStats  = rawStats;
    pState.careerBlocks = parse_career(rawStats, pState.platform, pState.gamemode);

    document.title = `${summary.username ?? fmt_battletag(id)} · Who's on Top?`;
    renderProfile();
  } catch (err) {
    showPageError(`Failed to load player: ${err.message}`);
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────
function showLoading() {
  qs('#profile-content').innerHTML = `
    <div class="profile-hero">
      <div class="container">
        <div class="profile-banner">
          <div class="profile-av-ph" style="background:var(--bg-elev)"></div>
          <div style="flex:1">
            <div class="skeleton" style="height:28px;width:220px;border-radius:4px;margin-bottom:10px"></div>
            <div class="skeleton" style="height:14px;width:160px;border-radius:3px;margin-bottom:12px"></div>
            <div style="display:flex;gap:8px">
              <div class="skeleton" style="height:28px;width:90px;border-radius:4px"></div>
              <div class="skeleton" style="height:28px;width:90px;border-radius:4px"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="container">
      <div class="stats-grid" style="margin-top:24px">
        ${Array.from({length:6},()=>`<div class="stat-tile"><div class="skeleton" style="height:50px;border-radius:4px"></div></div>`).join('')}
      </div>
    </div>`;
}

function showPageError(msg) {
  qs('#profile-content').innerHTML = `
    <div class="container" style="padding-top:40px">
      <div class="error-state">
        <span class="error-icon">⚠</span>
        <span>${msg}</span>
      </div>
    </div>`;
}

// ── Main render ───────────────────────────────────────────────────────────────
function renderProfile() {
  const s = pState.summary;
  const heroes = pState.careerBlocks ? Object.keys(pState.careerBlocks) : [];

  // Move all-heroes to front
  const orderedHeroes = [
    'all-heroes',
    ...heroes.filter(h => h !== 'all-heroes').sort(),
  ];

  pState.selectedHero = 'all-heroes';

  const flatAll = pState.careerBlocks
    ? flatten_hero(pState.careerBlocks['all-heroes'])
    : {};

  // Signature Ranked Score (same metric as the leaderboard)
  const playerScore = pState.careerBlocks ? ranked_score(flatAll) : null;

  // Hero time map for chart
  const timemap = hero_time_map(pState.rawStats, pState.platform, pState.gamemode);

  // Build platform comp key
  const compKey = pState.platform === 'pc' ? 'pc' : 'console';
  const comp = s?.competitive?.[compKey];
  const roles = ['tank','damage','support','open'].filter(r => comp?.[r]?.division);

  const av = s?.avatar;
  const name = s?.username ?? pState.playerId;
  const title = s?.title ?? '';

  const avatarHtml = av
    ? `<img class="profile-av" src="${av}" alt="${name}" onerror="this.outerHTML='<div class=profile-av-ph>${name.charAt(0)}</div>'">`
    : `<div class="profile-av-ph">${name.charAt(0)}</div>`;

  const rankPills = roles.map(role => {
    const r = comp[role];
    const clr = rank_color(r.division);
    return `
      <div class="rank-pill rank-${r.division.toLowerCase()}">
        ${r.rank_icon ? `<img src="${r.rank_icon}" class="rank-icon-img" alt="${r.division}" style="width:32px;height:32px">` : ''}
        <div>
          <div class="role">${cap(role)}</div>
          <div class="val" style="color:${clr};font-weight:700;font-size:14px">${rank_label(r)}</div>
        </div>
      </div>`;
  }).join('');

  // Top-level computed stats
  const wr  = win_rate(flatAll);
  const kdV = kd(flatAll);

  const gamesPlayed  = stat_val(flatAll, 'game', 'games_played') ?? 0;
  const gamesWon     = stat_val(flatAll, 'game', 'games_won')
                    ?? (gamesPlayed - (stat_val(flatAll, 'game', 'games_lost') ?? 0));
  const timePlayed   = stat_val(flatAll, 'game', 'time_played');
  const elims        = stat_val(flatAll, 'combat', 'eliminations');
  const deaths       = stat_val(flatAll, 'combat', 'deaths');
  const dmg          = stat_val(flatAll, 'combat', 'damage_done');
  const healing      = stat_val(flatAll, 'combat', 'healing_done');

  qs('#profile-content').innerHTML = `
    <div class="profile-hero">
      <div class="container">
        <div class="profile-banner">
          <div class="profile-av-wrap">${avatarHtml}</div>
          <div class="profile-info">
            <div class="profile-name">${name}</div>
            ${title ? `<div class="profile-title">${title}</div>` : ''}
            <div class="profile-ranks">
              ${rankPills || '<span class="text-muted" style="font-size:12px">Unranked</span>'}
            </div>
          </div>
          <div class="profile-meta-col">
            ${playerScore != null ? `
              <div class="score-medallion" title="Ranked Score: ${score_tier_label(playerScore)}">
                <div class="score-ring" style="--pct:${(playerScore/1000).toFixed(3)};--clr:${score_color(playerScore)}">
                  <div class="score-ring-inner">
                    <div class="score-num" style="color:${score_color(playerScore)}">${playerScore}</div>
                    <div class="score-max">/ 1000</div>
                  </div>
                </div>
                <div class="score-tier" style="color:${score_color(playerScore)}">${score_tier_label(playerScore)}</div>
                <div class="score-cap">Ranked Score</div>
              </div>` : ''}
            <div class="seg" id="plyr-platform-seg">
              <button data-val="pc" class="${pState.platform==='pc'?'on':''}">PC</button>
              <button data-val="console" class="${pState.platform==='console'?'on':''}">Console</button>
            </div>
            <div class="seg" id="plyr-mode-seg">
              <button data-val="competitive" class="${pState.gamemode==='competitive'?'on':''}">Ranked</button>
              <button data-val="quickplay"   class="${pState.gamemode==='quickplay'?'on':''}">Quick</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="container">
      ${!pState.careerBlocks ? `
        <div class="info-box" style="margin-top:20px">
          <span class="icon">ℹ</span>
          <span>No career stats found for <strong>${pState.gamemode}</strong> on <strong>${pState.platform}</strong>.
          The profile may be private, or this player hasn't played this mode yet. Try switching platforms or game mode.</span>
        </div>` : ''}

      <div class="stats-grid mt-24" id="overview-tiles">
        ${tile('Win Rate',   wr != null  ? fmt_pct(wr)              : '–', `${gamesWon}W / ${gamesPlayed - gamesWon}L`, wr != null ? (wr >= 55 ? 'ok' : wr < 45 ? 'bad' : 'accent') : '')}
        ${tile('K/D',        kdV != null  ? fmt_float(kdV, 2)        : '–', 'Final Blows / Deaths')}
        ${tile('Eliminations', elims != null ? fmt_num(elims)        : '–', 'Career total')}
        ${tile('Damage Done',  dmg != null   ? fmt_num(dmg)          : '–', 'Career total')}
        ${tile('Healing Done', healing != null ? fmt_num(healing)    : '–', 'Career total')}
        ${tile('Time Played',  timePlayed != null ? fmt_time(timePlayed) : '–', 'Career total')}
        ${tile('Deaths',       deaths != null ? fmt_num(deaths)      : '–', 'Career total')}
        ${tile('Games Played', gamesPlayed ? fmt_num(gamesPlayed)    : '–', 'This season')}
      </div>

      ${pState.careerBlocks ? `
        <div class="mt-24">
          <div class="flex items-center gap-12 mb-16" style="flex-wrap:wrap">
            <div class="card-title">Stats by Hero</div>
            <div style="flex:1"></div>
          </div>
          <div class="hero-chips" id="hero-chips">
            ${orderedHeroes.map(h => `
              <button class="hero-chip${h==='all-heroes'?' on':''}" data-hero="${h}">
                ${hero_name(h)}
              </button>`).join('')}
          </div>
          <div id="hero-stats"></div>
        </div>

        ${Object.keys(timemap).length ? `
          <div class="card mt-24">
            <div class="card-title mb-16">Time Played by Hero</div>
            <div class="time-bars" id="time-chart"></div>
          </div>` : ''}
      ` : ''}
    </div>`;

  // Wire mode switches
  qs('#plyr-platform-seg')?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      qs('#plyr-platform-seg').querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      pState.platform = btn.dataset.val;
      refetchStats();
    });
  });

  qs('#plyr-mode-seg')?.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      qs('#plyr-mode-seg').querySelectorAll('button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      pState.gamemode = btn.dataset.val;
      refetchStats();
    });
  });

  // Hero chips
  qs('#hero-chips')?.querySelectorAll('.hero-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      qs('#hero-chips').querySelectorAll('.hero-chip').forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      pState.selectedHero = chip.dataset.hero;
      renderHeroStats(pState.selectedHero);
    });
  });

  if (pState.careerBlocks) {
    renderHeroStats('all-heroes');
  }

  if (Object.keys(timemap).length) {
    renderTimeChart(timemap);
  }
}

function tile(label, val, sub = '', valCls = '') {
  return `
    <div class="stat-tile">
      <div class="stat-tile-label">${label}</div>
      <div class="stat-tile-val ${valCls}">${val}</div>
      ${sub ? `<div class="stat-tile-sub">${sub}</div>` : ''}
    </div>`;
}

// ── Hero stats panel ──────────────────────────────────────────────────────────
function renderHeroStats(heroKey) {
  const panel = qs('#hero-stats');
  if (!panel || !pState.careerBlocks) return;

  const blocks = pState.careerBlocks[heroKey];
  if (!blocks) {
    panel.innerHTML = `<p class="text-muted text-sm mt-8">No stats recorded for this hero yet.</p>`;
    return;
  }

  const flat = flatten_hero(blocks);
  const html = Object.entries(flat).map(([cat, stats]) => {
    const entries = Object.entries(stats);
    if (!entries.length) return '';
    return `
      <div class="cat-section">
        <div class="cat-title" style="color:${cat_color(cat)}">${cat_label(cat)}</div>
        <div class="stat-list">
          ${entries.map(([key, { label, value }]) => `
            <div class="stat-row">
              <span class="stat-row-key">${label}</span>
              <span class="stat-row-val">${fmt_stat(key, value)}</span>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');

  panel.innerHTML = html || `<p class="text-muted text-sm mt-8">No stats available.</p>`;
}

// ── Time-played chart ─────────────────────────────────────────────────────────
function renderTimeChart(timemap) {
  const chart = qs('#time-chart');
  if (!chart) return;

  const entries = Object.entries(timemap)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20);

  if (!entries.length) { chart.innerHTML = '<p class="text-muted text-sm">No time data.</p>'; return; }

  const max = entries[0][1];

  chart.innerHTML = entries.map(([hero, secs]) => `
    <div class="time-bar-row">
      <span class="time-bar-label">${hero_name(hero)}</span>
      <div class="time-bar-track">
        <div class="time-bar-fill" style="width:${(secs/max*100).toFixed(1)}%"></div>
      </div>
      <span class="time-bar-val">${fmt_time(secs)}</span>
    </div>`).join('');
}

// ── Mode re-fetch ─────────────────────────────────────────────────────────────
async function refetchStats() {
  const statsSection = qs('#overview-tiles');
  if (statsSection) statsSection.innerHTML = `
    <div class="skeleton" style="height:70px;border-radius:8px;grid-column:1/-1"></div>`;

  try {
    pState.rawStats = await API.stats(pState.playerId, pState.platform, pState.gamemode);
    pState.careerBlocks = parse_career(pState.rawStats, pState.platform, pState.gamemode);
    renderProfile();
  } catch (err) {
    show_error(qs('#profile-content'), `Failed to reload stats: ${err.message}`);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initPlayer);

'use strict';

/* ==========================================================================
   NBA Last Night
   - Ergebnisse: ESPN Scoreboard (öffentlich, kein Key, CORS erlaubt)
   - Videos: NBA-YouTube-Kanal
       1) optional: YouTube Data API v3 (kostenloser Key, siehe YT_API_KEY)
       2) sonst: YouTube-RSS-Feed über kostenlose CORS-Proxys
   ========================================================================== */

const CONFIG = {
  // Kanal "NBA"
  CHANNEL_ID: 'UCWJ2lWNubArHWmf3FIHbfcQ',

  // OPTIONAL: kostenloser YouTube-Data-API-Key (Google Cloud Console).
  // Mit Key werden die letzten 50 Uploads geladen (zuverlässiger als der RSS-Feed
  // mit nur 15 Einträgen). Leer lassen = RSS-Feed über CORS-Proxy.
  // Tipp: Key in der Google Cloud Console auf deine GitHub-Pages-Domain beschränken.
  YT_API_KEY: '',

  SCOREBOARD_URL: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',

  // Kostenlose CORS-Proxys, werden der Reihe nach probiert
  PROXIES: [
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u),
  ],

  FETCH_TIMEOUT_MS: 9000,
  FEED_CACHE_MS: 10 * 60 * 1000,   // Videoliste 10 Min. zwischenspeichern
  VIDEO_MAX_AGE_DAYS: 4,           // Video darf max. so viele Tage nach Spielbeginn erscheinen
};

const $ = (sel) => document.querySelector(sel);

/* ---------- Datum / Zeitzone ------------------------------------------------ */

// NBA-Spieltage laufen nach US-Ostküstenzeit. Spiele, die in Deutschland nachts
// enden, gehören damit zum "Vortag" in ET.
const etFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function etDateString(date) {
  return etFormatter.format(date); // YYYY-MM-DD
}

function shiftDay(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function formatDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/* ---------- Netzwerk -------------------------------------------------------- */

async function fetchWithTimeout(url, options = {}, ms = CONFIG.FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Spiele (ESPN) --------------------------------------------------- */

function normalizeTeam(c) {
  return {
    name: c.team.name,                 // z. B. "Lakers", "Trail Blazers", "76ers"
    display: c.team.displayName,
    abbr: c.team.abbreviation,
    logo: c.team.logo,
    score: Number(c.score),
    record: c.records && c.records[0] ? c.records[0].summary : '',
  };
}

function normalizeEvent(ev) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((c) => c.homeAway === 'home');
  const away = comp.competitors.find((c) => c.homeAway === 'away');
  const type = ev.status.type;
  return {
    id: ev.id,
    start: new Date(ev.date),
    state: type.state,                 // pre | in | post
    statusName: type.name,             // STATUS_FINAL, STATUS_POSTPONED, ...
    shortDetail: type.shortDetail || '',
    home: normalizeTeam(home),
    away: normalizeTeam(away),
  };
}

async function fetchGames(dateStr) {
  const url = `${CONFIG.SCOREBOARD_URL}?dates=${dateStr.replace(/-/g, '')}&limit=100`;
  const res = await fetchWithTimeout(url);
  const json = await res.json();
  return (json.events || [])
    .map(normalizeEvent)
    .filter((g) => !/POSTPONED|CANCELED|CANCELLED/.test(g.statusName))
    .sort((a, b) => a.start - b.start);
}

// "Letzte Nacht" = jüngster NBA-Tag (ET), sofern er abgeschlossen ist.
// Sind die Spiele von "heute" (ET) noch nicht durch, zählt gestern.
async function findLastGameDay() {
  const today = etDateString(new Date());
  const yesterday = shiftDay(today, -1);

  const [todays, yesterdays] = await Promise.all([fetchGames(today), fetchGames(yesterday)]);

  if (todays.length && todays.every((g) => g.state === 'post')) {
    return { date: today, games: todays };
  }
  if (yesterdays.length) {
    return { date: yesterday, games: yesterdays };
  }
  return null;
}

/* ---------- Videos (YouTube) ------------------------------------------------ */

function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Feed nicht lesbar');
  return [...doc.getElementsByTagName('entry')]
    .map((e) => ({
      id: (e.getElementsByTagNameNS('*', 'videoId')[0] || {}).textContent,
      title: (e.getElementsByTagName('title')[0] || {}).textContent,
      published: new Date((e.getElementsByTagName('published')[0] || {}).textContent),
    }))
    .filter((v) => v.id && v.title);
}

async function videosViaApi() {
  const uploads = 'UU' + CONFIG.CHANNEL_ID.slice(2);
  const url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50' +
    `&playlistId=${uploads}&key=${encodeURIComponent(CONFIG.YT_API_KEY)}`;
  const json = await (await fetchWithTimeout(url)).json();
  return (json.items || []).map((i) => ({
    id: i.snippet.resourceId.videoId,
    title: i.snippet.title,
    published: new Date(i.snippet.publishedAt),
  }));
}

async function videosViaRss() {
  const feedUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + CONFIG.CHANNEL_ID;
  let lastError;
  for (const proxy of CONFIG.PROXIES) {
    try {
      const text = await (await fetchWithTimeout(proxy(feedUrl))).text();
      const vids = parseFeed(text);
      if (vids.length) return vids;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No proxy available');
}

async function loadVideos() {
  const cacheKey = 'nba-videos-v1';
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached && Date.now() - cached.t < CONFIG.FEED_CACHE_MS) {
      return cached.v.map((v) => ({ ...v, published: new Date(v.published) }));
    }
  } catch (_) { /* Storage evtl. blockiert – egal */ }

  const vids = CONFIG.YT_API_KEY ? await videosViaApi() : await videosViaRss();

  try {
    localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v: vids }));
  } catch (_) { /* egal */ }
  return vids;
}

// NBA-Titel: "LAKERS vs WARRIORS | FULL GAME HIGHLIGHTS | October 21, 2026 | ..."
const TEAM_ALIAS = { 'Trail Blazers': 'BLAZERS' };

function teamKey(team) {
  return (TEAM_ALIAS[team.name] || team.name).toUpperCase();
}

function titleHasTeam(titleUpper, key) {
  // Wortgrenzen, damit "NETS" nicht in "HORNETS" matcht
  return new RegExp('(^|[^A-Z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Z0-9]|$)').test(titleUpper);
}

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY',
  'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// Liest ein Datum wie "OCTOBER 21, 2026" aus dem Titel (als UTC-Mitternacht), sonst null.
function titleDate(titleUpper) {
  const m = titleUpper.match(/(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{1,2}),?\s+(\d{4})/);
  return m ? Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2])) : null;
}

function findVideoForGame(game, videos) {
  const a = teamKey(game.away);
  const h = teamKey(game.home);
  const from = game.start.getTime();
  const to = from + CONFIG.VIDEO_MAX_AGE_DAYS * 864e5;
  const [gy, gm, gd] = etDateString(game.start).split('-').map(Number);
  const gameDay = Date.UTC(gy, gm - 1, gd);

  const matches = videos.filter((v) => {
    const t = v.title.toUpperCase();
    const ts = v.published.getTime();
    if (!(t.includes('HIGHLIGHT') && titleHasTeam(t, a) && titleHasTeam(t, h) && ts >= from && ts <= to)) {
      return false;
    }
    // Steht ein Datum im Titel, muss es (±1 Tag) zum Spieltag passen
    const td = titleDate(t);
    return td === null || Math.abs(td - gameDay) <= 864e5;
  });

  const rank = (v) => (v.title.toUpperCase().includes('FULL GAME') ? 1 : 0);
  matches.sort((x, y) => rank(y) - rank(x) || y.published - x.published);
  return matches[0] || null;
}

/* ---------- Rendering ------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusText(game) {
  if (game.state === 'post') {
    const m = game.shortDetail.match(/(\d?)OT/i);
    if (m) return 'Score' + (m[1] ? ` (${m[1]}. Verl.)` : ' (n. Verl.)');
    return 'Score';
  }
  if (game.state === 'in') return 'LIVE · ' + game.shortDetail;
  return game.shortDetail;
}

function teamRow(team, game, isWinner) {
  const row = el('div', 'team' + (isWinner ? ' winner' : ''));
  const img = el('img');
  img.src = team.logo;
  img.alt = '';
  img.loading = 'lazy';
  row.append(img);

  const label = el('span');
  label.append(el('span', 'name', team.display));
  if (team.record) label.append(el('span', 'record', team.record));
  row.append(label);

  row.append(el('span', 'score', String(team.score)));
  return row;
}

function buildGameCard(game) {
  const card = el('article', 'game');
  const board = el('div', 'scoreboard');

  const finished = game.state === 'post';
  const awayWins = finished && game.away.score > game.home.score;
  const homeWins = finished && game.home.score > game.away.score;

  board.append(teamRow(game.away, game, awayWins));
  board.append(teamRow(game.home, game, homeWins));
  board.append(el('div', 'status' + (game.state === 'in' ? ' live' : ''), statusText(game)));

  const video = el('div', 'video');
  const ph = el('div', 'video-placeholder', 'Searching for game summary …');
  video.append(ph);

  card.append(board, video);
  return { card, video };
}

function youtubeSearchUrl(game) {
  const q = `${game.away.display} ${game.home.display} full game highlights`;
  return 'https://www.youtube.com/@NBA/search?query=' + encodeURIComponent(q);
}

function buildVideoEmbed(video) {
  const wrap = el('div');
  const frame = el('div', 'video-frame');

  const btn = el('button', 'thumb');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Video abspielen: ' + video.title);
  const img = el('img');
  img.src = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  img.alt = '';
  img.loading = 'lazy';
  btn.append(img, el('span', 'play'));

  btn.addEventListener('click', () => {
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`;
    iframe.title = video.title;
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    frame.replaceChildren(iframe);
  });

  frame.append(btn);

  const caption = el('div', 'video-caption');
  const link = el('a', '', video.title);
  link.href = 'https://www.youtube.com/watch?v=' + video.id;
  link.target = '_blank';
  link.rel = 'noopener';
  caption.append(link);

  wrap.append(frame, caption);
  return wrap;
}

function setVideoSlot(slot, game, video, videosFailed) {
  slot.replaceChildren();
  if (video) {
    slot.append(buildVideoEmbed(video));
    return;
  }
  const box = el('div', 'video-missing');
  if (game.state !== 'post') {
    box.append(el('span', '', 'Summary after game has ended.'));
  } else {
    box.append(el('span', '', videosFailed
      ? 'Videolist not available right now.'
      : 'No summary yet.'));
  }
  const a = el('a', '', 'Auf YouTube suchen');
  a.href = youtubeSearchUrl(game);
  a.target = '_blank';
  a.rel = 'noopener';
  box.append(a);
  slot.append(box);
}

function showNotice(text, isError) {
  const n = $('#notice');
  n.textContent = text;
  n.classList.toggle('error', !!isError);
  n.hidden = false;
}

/* ---------- Fallback: neuestes Video --------------------------------------- */

function renderLatestVideo(videos) {
  const section = $('#latest');
  section.replaceChildren();
  section.hidden = false;

  const card = el('article', 'game');
  const candidates = (videos || []).filter((v) => !/#shorts?\b/i.test(v.title));
  const latest = candidates.slice().sort((a, b) => b.published - a.published)[0];

  section.append(el('h2', '', 'Latest Video from the NBA YT Channel'));

  if (latest) {
    card.append(buildVideoEmbed(latest));
  } else {
    // Feed nicht erreichbar: Upload-Playlist (nur Langvideos, neuestes zuerst) einbetten
    const frame = el('div', 'video-frame');
    const iframe = document.createElement('iframe');
    iframe.src = 'https://www.youtube-nocookie.com/embed/videoseries?list=UULF' + CONFIG.CHANNEL_ID.slice(2);
    iframe.title = 'Neueste Videos vom NBA-Kanal';
    iframe.loading = 'lazy';
    iframe.allow = 'encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    frame.append(iframe);
    card.append(frame);
  }
  section.append(card);
}

/* ---------- Main ------------------------------------------------------------ */

async function main() {
  const subtitle = $('#subtitle');
  const gamesEl = $('#games');

  // Videos parallel zu den Ergebnissen laden
  const videosPromise = loadVideos().then((v) => ({ ok: true, v }), () => ({ ok: false, v: [] }));

  let result;
  try {
    result = await findLastGameDay();
  } catch (err) {
    subtitle.textContent = 'No results.';
    showNotice('Results are not available right now (ESPN). Try again later.', true);
    return;
  }

  if (!result) {
    subtitle.textContent = 'No games last night.';
    const { v } = await videosPromise;
    renderLatestVideo(v);
    return;
  }

  const { date, games } = result;
  const live = games.some((g) => g.state === 'in');
  subtitle.textContent =
    `${games.length} ${games.length === 1 ? 'Spiel' : 'Spiele'} · Game Day ${formatDay(date)} (US-Eastern Time)` +
    (live ? ' · games still running' : '');

  const slots = games.map((game) => {
    const { card, video } = buildGameCard(game);
    gamesEl.append(card);
    return { game, slot: video };
  });

  const { ok, v: videos } = await videosPromise;
  for (const { game, slot } of slots) {
    setVideoSlot(slot, game, ok ? findVideoForGame(game, videos) : null, !ok);
  }
}

main();

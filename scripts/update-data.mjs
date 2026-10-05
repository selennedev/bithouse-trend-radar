#!/usr/bin/env node
// Bithouse Trend Radar — coletor de dados
// Roda no GitHub Actions (Node 20+). Busca cada fonte, normaliza, calcula o
// Trend Score (0–100), classifica (HOT / RISING / EARLY) e gera data/radar.json.
//
//   node scripts/update-data.mjs          -> coleta real
//   node scripts/update-data.mjs --demo   -> gera dados fictícios p/ pré-visualizar

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const OUT = 'data/radar.json';
const HIST = 'data/history.json';
const DEMO = process.argv.includes('--demo');
const UA = 'Mozilla/5.0 (compatible; BithouseTrendRadar/1.0; +https://github.com/carolvilarinhodev)';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const GEOS = (process.env.TRENDS_GEOS || 'BR,US').split(',');

const clip = (n, a = 0, b = 100) => Math.max(a, Math.min(b, n));
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const norm = (s = '') => s.replace(/\[.*?\]|\(.*?\)/g, ' ').toLowerCase().replace(/[^a-z0-9à-ú ]/gi, ' ').replace(/\s+/g, ' ').trim();

async function get(url, { json = true, headers = {} } = {}) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: '*/*', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).host}`);
  return json ? r.json() : r.text();
}

// Executa uma fonte sem derrubar o resto se ela falhar.
async function source(id, fn) {
  const t = Date.now();
  try {
    const res = await fn();
    return { id, status: 'ok', ms: Date.now() - t, ...res };
  } catch (e) {
    return { id, status: 'error', ms: Date.now() - t, note: String(e.message || e), items: [] };
  }
}

// ───────────────────────── ROBLOX · Explore (Trending / Charts / Discovery)
async function fetchExplore() {
  const sessionId = randomUUID();
  const base = 'https://apis.roblox.com/explore-api/v1';
  const q = `sessionId=${sessionId}&device=computer&country=all`;
  const s = await get(`${base}/get-sorts?${q}`);
  const sorts = (s.sorts || []).filter((x) => x.sortId && (x.contentType === 'Games' || x.games)).slice(0, 10);
  const items = [];
  const counts = { trending: 0, charts: 0, discovery: 0 };
  for (const so of sorts) {
    const name = so.sortDisplayName || so.sortId;
    const bucket = /trend/i.test(name) ? 'trending' : /top|popular|playing|chart/i.test(name) ? 'charts' : 'discovery';
    let list = so.games || [];
    try {
      const c = await get(`${base}/get-sort-content?${q}&sortId=${encodeURIComponent(so.sortId)}`);
      if (c.games?.length) list = c.games;
    } catch { /* usa os jogos embutidos no get-sorts */ }
    counts[bucket] += list.length;
    list.forEach((g, i) => items.push({ ...g, _bucket: bucket, _sort: name, _rank: i + 1 }));
  }
  if (!items.length) throw new Error('Explore API não retornou jogos (formato pode ter mudado)');
  return { items, counts, note: sorts.map((x) => x.sortDisplayName).join(' · ') };
}

async function fetchGameDetails(ids) {
  const out = {};
  for (const part of chunk(ids, 50)) {
    const list = part.join(',');
    const [g, v, t] = await Promise.allSettled([
      get(`https://games.roblox.com/v1/games?universeIds=${list}`),
      get(`https://games.roblox.com/v1/games/votes?universeIds=${list}`),
      get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${list}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`),
    ]);
    if (g.status === 'fulfilled') for (const d of g.value.data || []) out[d.id] = { ...(out[d.id] || {}), ...d };
    if (v.status === 'fulfilled') for (const d of v.value.data || []) out[d.id] = { ...(out[d.id] || {}), up: d.upVotes, down: d.downVotes };
    if (t.status === 'fulfilled') for (const d of t.value.data || []) out[d.targetId] = { ...(out[d.targetId] || {}), icon: d.imageUrl };
    if (g.status === 'rejected') throw g.reason;
  }
  return out;
}

// ───────────────────────── ROBLOX · DevForum (Discourse)
async function fetchDevForum() {
  const [top, latest] = await Promise.allSettled([
    get('https://devforum.roblox.com/top.json?period=weekly'),
    get('https://devforum.roblox.com/latest.json'),
  ]);
  const topics = [
    ...(top.value?.topic_list?.topics || []),
    ...(latest.value?.topic_list?.topics || []),
  ];
  if (!topics.length) throw new Error((top.reason || latest.reason || new Error('sem tópicos')).message);
  const seen = new Set();
  const items = topics
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .map((t) => ({
      title: t.title, views: t.views, likes: t.like_count, replies: (t.posts_count || 1) - 1,
      url: `https://devforum.roblox.com/t/${t.slug}/${t.id}`, created: t.created_at,
    }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 15);
  return { items };
}

// ───────────────────────── MERCADO · Rolimon's
async function fetchRolimons() {
  const r = await get('https://api.rolimons.com/games/v1/gamelist');
  const games = r.games || {};
  const items = Object.entries(games)
    .map(([id, a]) => ({ id, name: a[0], players: a[1] || 0, icon: a[2] }))
    .sort((a, b) => b.players - a.players)
    .slice(0, 25);
  if (!items.length) throw new Error('lista vazia');
  return { items };
}

// ───────────────────────── INTERNET · Google Trends (RSS "em alta")
async function fetchGoogleTrends() {
  const items = [];
  for (const geo of GEOS) {
    try {
      const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`, { json: false });
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const b = m[1];
        const title = (b.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1];
        const traffic = (b.match(/<ht:approx_traffic>(.*?)<\/ht:approx_traffic>/) || [])[1];
        if (title) items.push({ title: title.trim(), traffic: traffic || '', geo });
      }
    } catch { /* tenta o próximo país */ }
  }
  if (!items.length) throw new Error('RSS do Google Trends vazio ou bloqueado');
  return { items };
}

// ───────────────────────── INTERNET · YouTube (precisa de chave da API, opcional)
async function fetchYouTube() {
  if (!YT_KEY) return { status: 'needs_key', note: 'Defina o secret YOUTUBE_API_KEY para ativar', items: [] };
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const s = await get(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=roblox&order=viewCount&publishedAfter=${since}&maxResults=25&key=${YT_KEY}`);
  const ids = (s.items || []).map((x) => x.id.videoId).join(',');
  const v = ids ? await get(`https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${ids}&key=${YT_KEY}`) : { items: [] };
  const items = (v.items || []).map((x) => ({
    title: x.snippet.title, channel: x.snippet.channelTitle, views: +x.statistics.viewCount || 0,
    url: `https://www.youtube.com/watch?v=${x.id}`,
  })).sort((a, b) => b.views - a.views);
  return { items };
}

// ───────────────────────── Trend Score
function buildGames({ explore, details, history, now, google, devforum, rolimons, youtube }) {
  const rolNames = new Set((rolimons.items || []).map((r) => norm(r.name)));
  const gt = (google.items || []).map((t) => norm(t.title));
  const df = (devforum.items || []).map((t) => norm(t.title));
  const yt = (youtube.items || []).map((t) => ({ t: norm(t.title), v: t.views }));
  const maxYt = Math.max(1, ...yt.map((x) => x.v));

  const byId = new Map();
  for (const g of explore.items || []) {
    const id = String(g.universeId);
    const e = byId.get(id) || { universeId: id, tags: new Set(), ranks: {} };
    e.name = g.name; e.rootPlaceId = g.rootPlaceId; e.playerCount = g.playerCount;
    e.up = g.totalUpVotes; e.down = g.totalDownVotes;
    e.tags.add(g._bucket); e.ranks[g._bucket] = Math.min(e.ranks[g._bucket] || 99, g._rank);
    byId.set(id, e);
  }

  const games = [];
  for (const e of byId.values()) {
    const d = details[e.universeId] || {};
    const ccu = d.playing ?? e.playerCount ?? 0;
    const up = d.up ?? e.up ?? 0, down = d.down ?? e.down ?? 0;
    const votes = up + down;
    const ageDays = d.created ? (now - new Date(d.created)) / 864e5 : null;
    const name = d.name || e.name;
    const n = norm(name);

    // histórico de CCU (≈1h atrás ou o ponto mais antigo com pelo menos 30 min)
    const h = history[e.universeId] || [];
    const ref = [...h].reverse().find((p) => now - p[0] >= 55 * 60e3) || h.find((p) => now - p[0] >= 30 * 60e3);
    const growth = ref ? (ccu - ref[1]) / Math.max(ref[1], 100) : null;

    // componentes 0–100
    const pop = clip((Math.log10(ccu + 1) / Math.log10(500000)) * 100);
    const qual = votes >= 50 ? clip(((up / votes) - 0.5) * 200) : 50;
    let mom;
    if (growth !== null) mom = clip(50 + growth * 100);
    else mom = e.tags.has('discovery') ? 68 : e.tags.has('trending') ? 60 : 40;
    const gtHit = n.length >= 4 && gt.some((t) => t.includes(n) || n.includes(t)) ? 1 : 0;
    const dfHit = n.length >= 4 ? df.filter((t) => t.includes(n)).length : 0;
    const ytHit = n.length >= 4 ? yt.filter((x) => x.t.includes(n)).reduce((s, x) => s + x.v, 0) : 0;
    const buzz = clip(gtHit * 45 + Math.min(dfHit, 2) * 12 + (ytHit / maxYt) * 40 + (rolNames.has(n) ? 15 : 0));

    const score = Math.round(0.30 * mom + 0.25 * pop + 0.20 * qual + 0.25 * buzz);

    let cls = 'neutral';
    const isNew = (ageDays !== null && ageDays <= 90) || e.tags.has('discovery');
    if (score >= 62 && ccu >= 20000) cls = 'hot';
    else if (isNew && ccu < 20000 && mom >= 55 && qual >= 55) cls = 'early';
    else if (mom >= 62 && ccu >= 1000) cls = 'rising';

    games.push({
      universeId: e.universeId, name, creator: d.creator?.name || '', genre: d.genre_l1 || d.genre || '',
      url: `https://www.roblox.com/games/${d.rootPlaceId || e.rootPlaceId}`,
      icon: d.icon || '', ccu, visits: d.visits || 0, favorites: d.favoritedCount || 0,
      likeRatio: votes ? Math.round((up / votes) * 100) : null, votes,
      ageDays: ageDays === null ? null : Math.round(ageDays),
      growthPct: growth === null ? null : Math.round(growth * 1000) / 10,
      tags: [...e.tags], components: { momentum: Math.round(mom), popularity: Math.round(pop), quality: Math.round(qual), buzz: Math.round(buzz) },
      mentions: { googleTrends: !!gtHit, devforum: dfHit, youtubeViews: ytHit },
      score, class: cls,
      spark: h.slice(-24).map((p) => p[1]).concat(ccu),
    });
  }
  return games.sort((a, b) => b.score - a.score);
}

// ───────────────────────── Bit House Lab (heurísticas simples e transparentes)
function buildLab(games, google) {
  const by = {};
  for (const g of games.filter((x) => x.class === 'early' || x.class === 'rising')) {
    const k = g.genre || 'Sem gênero';
    (by[k] ||= []).push(g);
  }
  const genres = Object.entries(by)
    .map(([genre, arr]) => ({ genre, count: arr.length, avgScore: Math.round(arr.reduce((s, x) => s + x.score, 0) / arr.length) }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore).slice(0, 6);

  const ideas = [];
  for (const g of games.filter((x) => x.class === 'early').slice(0, 3)) {
    ideas.push({
      title: `${g.name}: nicho abrindo`,
      text: `${g.genre || 'Gênero indefinido'} com só ${g.ccu.toLocaleString('pt-BR')} jogadores e ${g.likeRatio ?? '?'}% de aprovação` +
        (g.growthPct !== null ? `, crescendo ${g.growthPct}% na última hora` : '') + '. Vale estudar o loop de jogo e avaliar uma versão com assets 3D mais caprichados.',
      url: g.url,
    });
  }
  if (genres[0]) ideas.push({
    title: `Gênero em alta: ${genres[0].genre}`,
    text: `${genres[0].count} jogos em ascensão/early nesse gênero agora (score médio ${genres[0].avgScore}). Bom momento para oferecer pacotes de assets e mapas para esse nicho.`,
  });
  const rbx = (google.items || []).filter((t) => /roblox/i.test(t.title)).slice(0, 3);
  for (const t of rbx) ideas.push({ title: `Busca em alta: ${t.title}`, text: `Aparece no Google Trends (${t.geo}${t.traffic ? ', ' + t.traffic + ' buscas' : ''}). Possível tema para conteúdo ou jogo.` });
  return { genres, ideas };
}

// ───────────────────────── Modo demonstração (dados fictícios p/ ver o layout)
function demoData() {
  const now = Date.now();
  const mk = (i, name, genre, ccu, g, like, age, cls) => ({
    universeId: String(9000 + i), name, creator: 'Demo Studio', genre, url: 'https://www.roblox.com/', icon: '',
    ccu, visits: ccu * 380, favorites: ccu * 6, likeRatio: like, votes: 5000, ageDays: age, growthPct: g,
    tags: [], components: { momentum: 70, popularity: 60, quality: 80, buzz: 30 },
    mentions: { googleTrends: i % 4 === 0, devforum: 0, youtubeViews: 0 },
    score: Math.round(40 + (ccu > 20000 ? 30 : 15) + (g || 0) / 4 + like / 10), class: cls,
    spark: Array.from({ length: 24 }, (_, k) => Math.round(ccu * (0.7 + 0.3 * (k / 23) + Math.sin(k + i) * 0.04))),
  });
  const games = [
    mk(1, 'Demo Obby Tycoon', 'Tycoon', 84000, 12.4, 91, 400, 'hot'),
    mk(2, 'Demo Taco Idle', 'Simulator', 41000, 6.1, 88, 220, 'hot'),
    mk(3, 'Demo Swim Race', 'Sports', 26500, 9.8, 86, 120, 'hot'),
    mk(4, 'Demo Cozy Farm', 'Simulator', 12800, 31.2, 93, 45, 'rising'),
    mk(5, 'Demo Dungeon Run', 'RPG', 9400, 24.7, 90, 80, 'rising'),
    mk(6, 'Demo Pet Kingdom', 'Simulator', 7300, 18.3, 89, 150, 'rising'),
    mk(7, 'Demo Map Explorer', 'Adventure', 2100, 58.9, 94, 12, 'early'),
    mk(8, 'Demo Block Builder', 'Building', 1600, 44.0, 92, 20, 'early'),
    mk(9, 'Demo Zombie Café', 'Horror', 980, 71.5, 90, 8, 'early'),
  ].sort((a, b) => b.score - a.score);
  const src = (s, o = {}) => ({ status: s, ms: 0, count: 0, ...o });
  return {
    generatedAt: new Date(now).toISOString(), demo: true,
    sources: {
      explore: src('ok', { count: games.length, counts: { trending: 4, charts: 3, discovery: 2 } }),
      devforum: src('ok', { count: 3 }), rolimons: src('ok', { count: 3 }), gamestats: src('ok', { count: games.length }),
      gtrends: src('ok', { count: 3 }), youtube: src('needs_key', { note: 'Defina YOUTUBE_API_KEY' }),
      rovitals: src('link_only'), bloxscout: src('link_only'), x: src('unavailable'), tiktok: src('unavailable'),
    },
    games,
    google: [{ title: 'roblox novo evento (demo)', traffic: '20+', geo: 'BR' }, { title: 'exemplo de busca (demo)', traffic: '5 mil+', geo: 'US' }],
    devforum: [{ title: 'Exemplo de tópico do DevForum (demo)', views: 4200, likes: 80, replies: 31, url: 'https://devforum.roblox.com/' }],
    youtube: [], rolimons: [{ id: '1', name: 'Demo Obby Tycoon', players: 84000, icon: '' }],
    lab: buildLab(games, { items: [{ title: 'roblox novo evento (demo)', traffic: '20+', geo: 'BR' }] }),
  };
}

// ───────────────────────── main
async function main() {
  await fs.mkdir('data', { recursive: true });
  if (DEMO) {
    await fs.writeFile(OUT, JSON.stringify(demoData(), null, 1));
    console.log('Dados de demonstração gerados em', OUT);
    return;
  }

  const now = Date.now();
  let history = {};
  try { history = JSON.parse(await fs.readFile(HIST, 'utf8')); } catch { /* primeira execução */ }

  const [explore, devforum, rolimons, gtrends, youtube] = await Promise.all([
    source('explore', fetchExplore), source('devforum', fetchDevForum), source('rolimons', fetchRolimons),
    source('gtrends', fetchGoogleTrends), source('youtube', fetchYouTube),
  ]);

  let details = {}, gamestats = { id: 'gamestats', status: 'error', ms: 0, note: 'sem jogos para consultar', items: [] };
  if (explore.status === 'ok') {
    const ids = [...new Set(explore.items.map((g) => String(g.universeId)))].slice(0, 150);
    gamestats = await source('gamestats', async () => {
      details = await fetchGameDetails(ids);
      return { items: Object.keys(details) };
    });
  }

  const games = explore.status === 'ok'
    ? buildGames({ explore, details, history, now, google: gtrends, devforum, rolimons, youtube })
    : [];

  // atualiza histórico (96 pontos ≈ 24h a cada 15 min)
  for (const g of games) {
    const h = history[g.universeId] || [];
    h.push([now, g.ccu]);
    history[g.universeId] = h.slice(-96);
  }
  for (const id of Object.keys(history)) if (!history[id].some((p) => now - p[0] < 36 * 3600e3)) delete history[id];

  // se tudo falhou, mantém o último radar.json em vez de apagar a página
  if (!games.length) {
    console.error('Nenhum jogo coletado. Mantendo último radar.json.', explore.note);
    try { await fs.access(OUT); process.exitCode = 0; return; } catch { /* segue e grava mesmo assim */ }
  }

  const strip = (s) => ({ status: s.status, ms: s.ms, count: s.items?.length ?? 0, note: s.note, counts: s.counts });
  const out = {
    generatedAt: new Date(now).toISOString(), demo: false,
    sources: {
      explore: strip(explore), devforum: strip(devforum), rolimons: strip(rolimons), gamestats: strip(gamestats),
      gtrends: strip(gtrends), youtube: strip(youtube),
      rovitals: { status: 'link_only' }, bloxscout: { status: 'link_only' },
      x: { status: 'unavailable' }, tiktok: { status: 'unavailable' },
    },
    games: games.slice(0, 80),
    google: gtrends.items.slice(0, 20), devforum: devforum.items, youtube: youtube.items.slice(0, 10),
    rolimons: rolimons.items, lab: buildLab(games, gtrends),
  };
  await fs.writeFile(OUT, JSON.stringify(out, null, 1));
  await fs.writeFile(HIST, JSON.stringify(history));
  console.log(`OK — ${games.length} jogos | fontes:`, Object.entries(out.sources).map(([k, v]) => `${k}=${v.status}`).join(' '));
}

main().catch((e) => { console.error(e); process.exit(1); });

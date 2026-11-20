// Cloudflare Worker «arena-save»: хранит сохранения игры в базе D1, по одному на аккаунт Telegram.
// Нужно: привязка D1 с именем переменной DB и секрет BOT_TOKEN (токен от BotFather).

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}

// Проверка подписи initData по правилам Telegram. Возвращает { id } или { reason } с причиной отказа.
async function verify(initData, token) {
  if (!token) return { reason: 'no_token' };               // в Worker не задан секрет BOT_TOKEN
  if (!initData) return { reason: 'no_init' };
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return { reason: 'no_hash' };
  p.delete('hash');
  const str = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = await hmac('WebAppData', token.trim());
  if (hex(await hmac(secret, str)) !== hash) return { reason: 'bad_signature' };   // токен не от того бота
  const age = Date.now() / 1000 - Number(p.get('auth_date') || 0);
  if (!(age < 86400 * 3)) return { reason: 'expired' };    // подпись старше 3 суток не принимаем
  try { const id = JSON.parse(p.get('user')).id; return Number.isFinite(id) ? { id, params: p } : { reason: 'bad_user' }; } catch (e) { return { reason: 'bad_user' }; }
}

// ---------- настройки ----------
const GAME_LINK = 'https://t.me/genomebreadbot/arena';   // ссылка на игру для кнопки «Играть» в сообщениях бота
const REF_BASE = 50;        // награда за друга: REF_BASE + REF_STEP × номер друга (1-й = 60, 2-й = 70, ...)
const REF_STEP = 10;
const LAB_CAP_H = 8;        // сколько часов копится лаборатория (как LAB_CAP_H в игре)
const refReward = k => REF_BASE + REF_STEP * k;

// ---------- сообщения бота ----------
async function tgSend(env, chatId, text) {
  try {
    await fetch('https://api.telegram.org/bot' + String(env.BOT_TOKEN).trim() + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: 'Играть', url: GAME_LINK }]] } })
    });
  } catch (e) { /* игрок не разрешал боту писать или заблокировал его: это нормально */ }
}

// ---------- рефералки ----------
async function refStats(env, uid) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM referrals WHERE inviter = ?').bind(uid).first()).n;
  const c = await env.DB.prepare('SELECT claimed FROM ref_claims WHERE uid = ?').bind(uid).first();
  const claimed = c ? c.claimed : 0;
  let pending = 0;
  for (let k = claimed + 1; k <= total; k++) pending += refReward(k);
  return { total, claimed, pending, next: refReward(total + 1) };
}

async function handleRef(env, ctx, uid, params, action) {
  if (action === 'register') {
    const m = /^ref_(\d{1,15})$/.exec(params.get('start_param') || '');
    if (!m) return { ok: false, reason: 'no_ref' };
    const inviter = Number(m[1]);
    if (inviter === uid) return { ok: false, reason: 'self' };
    const r = await env.DB.prepare('INSERT OR IGNORE INTO referrals (invitee, inviter, ts) VALUES (?, ?, ?)').bind(uid, inviter, Date.now()).run();
    if (r.meta.changes === 1) {                                 // новый друг: сообщаем пригласившему
      const st = await refStats(env, inviter);
      ctx.waitUntil(tgSend(env, inviter, 'К тебе присоединился друг! Тебе начислено ' + refReward(st.total) + ' монет. Они появятся в игре, когда ты её откроешь.'));
    }
    return { ok: true };
  }
  if (action === 'status') return { ok: true, ...(await refStats(env, uid)) };
  if (action === 'claim') {
    const st = await refStats(env, uid);
    if (st.pending <= 0) return { ok: true, coins: 0, ...st };
    const r = st.claimed === 0
    ? await env.DB.prepare('INSERT OR IGNORE INTO ref_claims (uid, claimed) VALUES (?, ?)').bind(uid, st.total).run()
    : await env.DB.prepare('UPDATE ref_claims SET claimed = ? WHERE uid = ? AND claimed = ?').bind(st.total, uid, st.claimed).run();
    if (r.meta.changes !== 1) return { ok: false, retry: true };   // награду только что забрали с другого устройства
    return { ok: true, coins: st.pending, ...(await refStats(env, uid)) };
  }
  return { ok: false, reason: 'bad_action' };
}

// ---------- защита от накрутки ----------
// Сервер не верит числам из игры: он проверяет, что новое сохранение могло получиться честной игрой
// за время, прошедшее с прошлого сохранения. Все пределы подобраны с запасом; меняй их здесь.
// Сохранения, записанные на сервере раньше этого момента (UTC), считаются «старыми»: при первом новом сохранении они не сравниваются.
const GRACE_BEFORE = Date.UTC(2026, 9, 23, 13, 0, 0);
const GENE_SET = new Set(['fang', 'steel', 'spore', 'ether', 'bone']);
const TIER_COST = { 1: 150, 2: 500, 3: 1000, 4: 3000 };      // цены токенов (как в игре)
const LIM = {
  maxMutants: 150, hardLvl: 3000, hardCoins: 2e8, hardCount: 1e6, hardTokens: 2000, maxLines: 20,   // линий бинго в игре 13 (5 строк + 5 столбцов + 2 диагонали + всё поле); 20 с запасом,
  // первое сохранение игрока (истории нет): что больше, сохраняется, но игрок скрыт из рейтинга до проверки
  firstLvl: 60, firstWins: 100, firstCoins: 50000, firstMutants: 40, firstTiered: 6, firstTokens: 5,
  window: 20,                                  // секунд: столько копятся «разовые» бюджеты (ежедневки, бинго и т.п.)
  winBase: 3, winRate: 1 / 8,                  // побед за раз и в секунду (самый быстрый честный бой на арене длится около 8–10 секунд)
  stageLvlBase: 20, stageLvlMul: 4,            // стадия не может быть выше 20 + 4 × «эффективный уровень» сильнейшего мутанта
  xpBase: 3000, xpRate: b => 40 + 1.5 * b,     // опыт одного мутанта (b = рекорд стадии)
  coinBase: b => 600 + 30 * b, coinRate: b => 25 + 1.5 * b,
  bingoCoins: 200, maxNew: 30, newLvl: 3
};
const xpTotal = L => 18 * (L - 1) + 4 * L * (L - 1);      // опыт, нужный до уровня L (xpNeed = 18 + 8 × уровень)
const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const keyCount = o => (o && typeof o === 'object') ? Object.keys(o).length : 0;
const tokOf = (d, t) => (d.tokens && d.tokens[t]) || 0;
const bestOf = d => Math.max(d.best || 1, d.stage || 1);

// форма сохранения и жёсткие пределы (нарушение = отказ навсегда)
function checkShape(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'shape';
  if (!Array.isArray(d.mutants) || d.mutants.length < 1 || d.mutants.length > LIM.maxMutants) return 'mutants_count';
  const ids = new Set();
  for (const m of d.mutants) {
    if (!m || typeof m !== 'object') return 'mutant';
    if (!isInt(m.id, 0, 1e9) || ids.has(m.id)) return 'mutant_id';
    ids.add(m.id);
    if (!isInt(m.lvl, 1, LIM.hardLvl)) return 'lvl';
    if (m.tier !== undefined && !isInt(m.tier, 0, 4)) return 'tier';
    if (m.gen !== undefined && !isInt(m.gen, 0, 20)) return 'gen';
    if (!Array.isArray(m.g) || m.g.length !== 2 || !GENE_SET.has(m.g[0]) || !GENE_SET.has(m.g[1])) return 'genes';
    if (m.xp !== undefined && !(Number.isFinite(m.xp) && m.xp >= 0 && m.xp < 1e9)) return 'xp';
  }
  if (!(Number.isFinite(d.coins) && d.coins >= 0 && d.coins <= LIM.hardCoins)) return 'coins';
  for (const k of ['wins', 'losses', 'stage', 'best']) if (d[k] !== undefined && !isInt(d[k], 0, LIM.hardCount)) return k;
  if (d.tokens !== undefined) {
    if (!d.tokens || typeof d.tokens !== 'object') return 'tokens';
    for (const t of [1, 2, 3, 4]) if (d.tokens[t] !== undefined && !isInt(d.tokens[t], 0, LIM.hardTokens)) return 'tokens';
  }
  if (keyCount(d.claimed) > LIM.maxLines) return 'bingo';
  if (d.claimedT) for (const t of [1, 2, 3, 4]) if (keyCount(d.claimedT[t]) > LIM.maxLines) return 'bingo';
  return null;
}

// первое сохранение «слишком большое для новичка»?
function firstIsBig(N) {
  if ((N.wins || 0) > LIM.firstWins || bestOf(N) > (N.wins || 0) + 10) return true;
  if (N.coins > LIM.firstCoins || N.mutants.length > LIM.firstMutants) return true;
  let tiered = 0;
  for (const m of N.mutants) { if (m.lvl > LIM.firstLvl) return true; if (m.tier) tiered++; }
  if (tiered > LIM.firstTiered || stageTooHigh(N)) return true;
  for (const t of [1, 2, 3, 4]) if (tokOf(N, t) > LIM.firstTokens) return true;
  return false;
}

// стадия должна соответствовать силе команды: враги растут примерно как 0,7 уровня за стадию
const stageTooHigh = d => {
  const eff = Math.max(...d.mutants.map(m => m.lvl * (1 + 0.25 * (m.tier || 0))));
  return bestOf(d) > LIM.stageLvlBase + LIM.stageLvlMul * eff;
};

// доход лаборатории в монетах в час (как в игре)
const labRateH = d => d.mutants.reduce((a, m) => a + 0.2 + 0.04 * m.lvl, 0);

// P = прошлое сохранение, N = новое. Возвращает причину отказа или null.
function checkDelta(P, N, elapsedSec, now, refExtra, ev) {
  ev = ev || { c: 0, t: {} };   // ev: награды события, выданные сервером и ещё не учтённые в сохранениях
  const e = Math.max(0, elapsedSec), share = Math.min(1, e / LIM.window), bP = bestOf(P);
  // победы и стадия: стадия растёт только от побед, победа занимает время
  const dW = (N.wins || 0) - (P.wins || 0);
  if (dW > Math.ceil(LIM.winBase * share + e * LIM.winRate)) return 'wins';
  if (bestOf(N) - bP > Math.max(0, dW) + 2 || (N.stage || 1) - (P.stage || 1) > Math.max(0, dW) + 2) return 'stage';
  if (bestOf(N) > bP && stageTooHigh(N)) return 'stage_vs_lvl';
  // монеты: время, лаборатория (не раньше, чем «накопилась»), реферальные награды, бинго
  const pl = P.lab && Number.isFinite(P.lab.t) ? P.lab.t : null, nl = N.lab && Number.isFinite(N.lab.t) ? N.lab.t : null;
  if (pl !== null && nl !== null && nl < pl - 5000) return 'lab_time';
  const labHours = pl === null ? 8 : Math.min(8, Math.max(0, (now - pl) / 3.6e6));
  const bingoNew = Math.max(0, keyCount(N.claimed) - keyCount(P.claimed));
  const coinAllow = LIM.coinBase(bP) * share + e * LIM.coinRate(bP) + labRateH(N) * labHours + 2 + refExtra + ev.c + bingoNew * LIM.bingoCoins;
  if ((N.coins || 0) - (P.coins || 0) > coinAllow) return 'coins';
  const budget = (P.coins || 0) + coinAllow;            // сколько монет могло быть потрачено
  // мутанты: уровни растут от опыта (бесплатно, но не быстрее боёв) или за монеты
  const prevById = new Map(P.mutants.map(m => [m.id, m]));
  const xpAllow = LIM.xpBase * share + e * LIM.xpRate(bP);
  let deficit = 0, created = 0;
  const createdT = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const m of N.mutants) {
    const o = prevById.get(m.id);
    if (o) {
      if ((m.tier || 0) > (o.tier || 0)) return 'tier_up';
      deficit += Math.max(0, xpTotal(m.lvl) - xpTotal(o.lvl) - xpAllow);
    } else {
      created++;
      if (m.lvl > LIM.newLvl) return 'new_lvl';
      if (m.tier) createdT[m.tier]++;
    }
  }
  if (created > LIM.maxNew) return 'new_count';
  // всё, что сверх опыта, куплено за монеты (1 уровень ≈ 1,5 опыта в монетах); токены: покупка или бинго
  let need = 1.6 * deficit;
  for (const t of [1, 2, 3, 4]) {
    const bingo = Math.max(0, keyCount(N.claimedT && N.claimedT[t]) - keyCount(P.claimedT && P.claimedT[t]));
    need += Math.max(0, tokOf(N, t) - tokOf(P, t) + createdT[t] - bingo - (ev.t[t] || 0)) * TIER_COST[t];
  }
  if (need > budget) return 'spend';
  return null;
}

async function logReject(env, uid, reason, N, now) {
  try {
    const last = await env.DB.prepare('SELECT ts FROM reject_log WHERE uid = ? ORDER BY id DESC LIMIT 1').bind(uid).first();
    if (last && now - last.ts < 600000) return;           // не чаще раза в 10 минут на игрока
    let detail = '';
    try { detail = JSON.stringify({ wins: N.wins, best: bestOf(N), coins: N.coins, maxLvl: Math.max(...N.mutants.map(m => m.lvl)) }); } catch (e) {}
    await env.DB.prepare('INSERT INTO reject_log (uid, reason, detail, ts) VALUES (?, ?, ?, ?)').bind(uid, reason, detail, now).run();
  } catch (e) { /* журнал не должен ломать сохранение */ }
}

function nameOf(params) {
  try {
    const u = JSON.parse(params.get('user') || '{}');
    return ([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Игрок').slice(0, 40);
  } catch (e) { return 'Игрок'; }
}

// аватарка из подписанных данных Telegram; принимаем только адреса t.me, остальное отбрасываем
function photoOf(params) {
  try {
    const u = JSON.parse(params.get('user') || '{}');
    const p = String(u.photo_url || '');
    return /^https:\/\/t\.me\/i\/userpic\/[\w\/.\-]{1,200}$/.test(p) ? p : null;
  } catch (e) { return null; }
}

// ---------- рейтинг: считается только из проверенных сохранений ----------
async function rankOf(env, best) {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM players WHERE flagged = 0 AND best > ? AND uid NOT IN (SELECT uid FROM banned)').bind(best).first();
  return 1 + r.n;
}
async function topList(env) {
  const r = await env.DB.prepare('SELECT name, best, photo FROM players WHERE flagged = 0 AND uid NOT IN (SELECT uid FROM banned) ORDER BY best DESC, ts ASC LIMIT 20').all();
  return { top: (r.results || []).map(x => ({ name: x.name, best: x.best, photo: x.photo || null })) };
}

// ---------- напоминание «лаборатория заполнена» (запускается по расписанию Cron) ----------
const HOUR = 3600000;
async function notifyLabs(env) {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT s.uid AS uid, json_extract(s.data, '$.lab.t') AS lt
    FROM saves s LEFT JOIN lab_notify n ON n.uid = s.uid
    WHERE json_extract(s.data, '$.lab.t') IS NOT NULL
    AND json_extract(s.data, '$.lab.t') + ? <= ?
    AND json_extract(s.data, '$.lab.t') > ?
    AND json_extract(s.data, '$.lab.t') > COALESCE(n.last_t, 0)
    AND ? - COALESCE(n.sent_at, 0) >= ?
    LIMIT 200`
  ).bind(LAB_CAP_H * HOUR, now, now - 7 * 24 * HOUR, now, 10 * HOUR).all();
  for (const r of rows.results || []) {
    // сначала отмечаем, потом пишем: два параллельных запуска не пришлют дубль
    await env.DB.prepare('INSERT INTO lab_notify (uid, last_t, sent_at) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET last_t = excluded.last_t, sent_at = excluded.sent_at')
    .bind(r.uid, r.lt, now).run();
    await tgSend(env, r.uid, 'Лаборатория заполнена: мутанты накопили максимум монет. Заходи и забери!');
  }
}

// ---------- админ-панель в Telegram ----------
// Бот отвечает только на сообщения от ADMIN_ID, остальных молча игнорирует.
// Нужен секрет WEBHOOK_SECRET (любая длинная случайная строка) и вебхук на адрес Worker + /tg.
const ADMIN_ID = 1695921199;

async function tgCall(env, method, payload) {
  try {
    await fetch('https://api.telegram.org/bot' + String(env.BOT_TOKEN).trim() + '/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
  } catch (e) { /* нет связи с Telegram: ничего не поделаешь */ }
}
const say = (env, text, markup) => tgCall(env, 'sendMessage', { chat_id: ADMIN_ID, text: text.slice(0, 4000), reply_markup: markup });
const btn = (text, data) => ({ text, callback_data: data });

const MENU = { inline_keyboard: [
    [btn('Подозрительные', 'suspects'), btn('Топ рейтинга', 'top')],
    [btn('Отклонённые сохранения', 'rejects'), btn('Забаненные', 'banned')]
  ] };
const HELP = 'Админ-панель Геномной арены\n\n/suspects: подозрительные игроки\n/top: топ-20 с uid\n/rejects: последние отклонённые сохранения\n/banned: список забаненных\n/info UID: данные игрока\n/ban UID: заблокировать\n/unban UID: разблокировать\n/unflag UID: вернуть в рейтинг\n/wipe UID: стереть сохранение игрока и его запись в рейтинге';

const SUSPECT_SQL = `SELECT * FROM (
SELECT p.uid AS uid, p.name AS name, p.best AS best, p.flagged AS flagged,
(SELECT MAX(json_extract(j.value, '$.lvl')) FROM saves s, json_each(json_extract(s.data, '$.mutants')) j WHERE s.uid = p.uid) AS lvl
FROM players p WHERE p.uid NOT IN (SELECT uid FROM banned))
WHERE flagged = 1 OR lvl > 100 ORDER BY lvl DESC LIMIT 10`;

async function adminSuspects(env) {
  const r = await env.DB.prepare(SUSPECT_SQL).all();
  const rows = r.results || [];
  if (!rows.length) return say(env, 'Подозрительных нет: никто не скрыт из рейтинга и ни у кого нет мутанта выше 100 уровня.');
  for (const p of rows) {
    await say(env, `${p.name}\nuid ${p.uid}\nстадия ${p.best} · макс. уровень ${p.lvl}${p.flagged ? ' · скрыт из рейтинга' : ''}`,
      { inline_keyboard: [[btn('Забанить', 'ban:' + p.uid), btn('Он честный', 'unflag:' + p.uid)], [btn('Подробнее', 'info:' + p.uid)]] });
  }
}

async function adminInfo(env, uid) {
  const p = await env.DB.prepare('SELECT name, best, flagged FROM players WHERE uid = ?').bind(uid).first();
  const s = await env.DB.prepare('SELECT rev, data, ts FROM saves WHERE uid = ?').bind(uid).first();
  const banned = !!(await env.DB.prepare('SELECT 1 AS x FROM banned WHERE uid = ?').bind(uid).first());
  if (!p && !s) return say(env, 'Игрок ' + uid + ' не найден.');
  let sv = 'сохранения нет';
  if (s) {
    try {
      const d = JSON.parse(s.data);
      const lv = (d.mutants || []).map(m => m.lvl || 0).sort((a, b) => b - a).slice(0, 5).join(', ');
      sv = `побед ${d.wins || 0} · стадия ${d.stage || 1} · монет ${Math.round(d.coins || 0)}\nмутантов ${(d.mutants || []).length} · лучшие уровни: ${lv}\nпоследнее сохранение: ${new Date(s.ts).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
    } catch (e) { sv = 'сохранение повреждено'; }
  }
  const rj = await env.DB.prepare('SELECT reason, ts FROM reject_log WHERE uid = ? ORDER BY id DESC LIMIT 3').bind(uid).all();
  const rejects = (rj.results || []).map(x => x.reason + ' (' + new Date(x.ts).toISOString().slice(0, 16).replace('T', ' ') + ')').join(', ') || 'нет';
  return say(env, `${p ? p.name : 'без имени'}\nuid ${uid}\nрекорд ${p ? p.best : '-'}${p && p.flagged ? ' · скрыт из рейтинга' : ''}${banned ? ' · ЗАБАНЕН' : ''}\n${sv}\nотклонения: ${rejects}`,
    { inline_keyboard: [banned ? [btn('Разбанить', 'unban:' + uid)] : [btn('Забанить', 'ban:' + uid)], [btn('Вернуть в рейтинг', 'unflag:' + uid), btn('Стереть сохранение', 'wipe:' + uid)]] });
}

async function adminAct(env, cmd, uid) {
  if (cmd === 'ban') { await env.DB.prepare('INSERT OR IGNORE INTO banned (uid) VALUES (?)').bind(uid).run(); return say(env, 'Забанен: ' + uid + '. Его сохранения больше не принимаются, из рейтинга убран.'); }
  if (cmd === 'unban') { await env.DB.prepare('DELETE FROM banned WHERE uid = ?').bind(uid).run(); return say(env, 'Разбанен: ' + uid); }
  if (cmd === 'unflag') { await env.DB.prepare('UPDATE players SET flagged = 0 WHERE uid = ?').bind(uid).run(); return say(env, 'Возвращён в рейтинг: ' + uid); }
  if (cmd === 'wipe') {
    await env.DB.prepare('DELETE FROM saves WHERE uid = ?').bind(uid).run();
    await env.DB.prepare('DELETE FROM players WHERE uid = ?').bind(uid).run();
    return say(env, 'Сохранение и запись в рейтинге стёрты: ' + uid + '. Если он не забанен, начнёт игру заново.');
  }
}

async function handleAdmin(env, u) {
  const cq = u.callback_query, msg = u.message;
  const from = cq ? cq.from : msg && msg.from;
  if (!from || from.id !== ADMIN_ID) return;                 // чужим не отвечаем вообще
  let text = '';
  if (cq) { await tgCall(env, 'answerCallbackQuery', { callback_query_id: cq.id }); text = '/' + String(cq.data || '').replace(':', ' '); }
  else text = String((msg && msg.text) || '');
  const m = /^\/(\w+)(?:@\w+)?\s*(\d{1,15})?/.exec(text.trim());
  if (!m) return;
  const cmd = m[1].toLowerCase(), uid = m[2] ? Number(m[2]) : null;
  if (cmd === 'start' || cmd === 'admin' || cmd === 'help') return say(env, HELP, MENU);
  if (cmd === 'suspects') return adminSuspects(env);
  if (cmd === 'top') {
    const r = await env.DB.prepare('SELECT uid, name, best, flagged FROM players WHERE uid NOT IN (SELECT uid FROM banned) ORDER BY best DESC, ts ASC LIMIT 20').all();
    return say(env, (r.results || []).map((p, i) => `${i + 1}. ${p.name} · стадия ${p.best} · ${p.uid}${p.flagged ? ' (скрыт)' : ''}`).join('\n') || 'Пока пусто.');
  }
  if (cmd === 'rejects') {
    const r = await env.DB.prepare('SELECT uid, reason, ts FROM reject_log ORDER BY id DESC LIMIT 15').all();
    return say(env, (r.results || []).map(x => `${new Date(x.ts).toISOString().slice(5, 16).replace('T', ' ')} · ${x.uid} · ${x.reason}`).join('\n') || 'Отклонённых нет.');
  }
  if (cmd === 'banned') {
    const r = await env.DB.prepare('SELECT b.uid AS uid, p.name AS name FROM banned b LEFT JOIN players p ON p.uid = b.uid LIMIT 50').all();
    return say(env, (r.results || []).map(x => `${x.uid} · ${x.name || 'без имени'}`).join('\n') || 'Забаненных нет.');
  }
  if (['info', 'ban', 'unban', 'unflag', 'wipe'].includes(cmd)) {
    if (!uid) return say(env, 'Укажи номер игрока, например: /' + cmd + ' 123456789');
    return cmd === 'info' ? adminInfo(env, uid) : adminAct(env, cmd, uid);
  }
  return say(env, HELP, MENU);
}

// ---------- СОБЫТИЕ «СТАЯ ПРОТИВ ГИГАНТА» ----------
// Таблица pack_members (схема в schema-event.sql): одна строка = один игрок в одной Стае в одном событии.
// Бой идёт в игре, но серверу присланный урон на слово не верят: он ограничивается потолком, который
// считается из ПРОВЕРЕННОГО сохранения (3 самых сильных мутанта), времени боя и остатка здоровья Гиганта.
// Награды (монеты, токены) попадают в сохранение игрока, поэтому сервер заранее разрешает их проверке сохранений (evAllowance).
// Новое событие: поменяй EV_ID и даты. Все числа ниже можно менять, база не требует правок.
const EV_ID = 1;
const EV_START = Date.UTC(2026, 10, 1, 21, 0, 0);   // понедельник 2 ноября 2026, 00:00 по Москве
const EV_END = EV_START + 7 * 86400000;             // воскресенье 8 ноября, 24:00 по Москве
const EV_HP = 120000;                               // здоровье Гиганта (своё у каждой Стаи); честный бой слабой команды даёт ~250 урона, сильной в разы больше
const MEMBER_SHARE = 0.35;                          // один игрок может нанести не больше этой доли здоровья: без друзей Гиганта не победить
const PACK_MAX = 5;                                 // мест в Стае
const PACK_BONUS = 0.1;                             // +10% урона всем за каждого друга в Стае, нанёсшего урон (до +40%)
const PACK_DAILY = 3;                               // боёв с Гигантом в сутки (сутки по Москве)
const FIGHT_TTL = 10 * 60000;                       // начатый бой, не завершённый за это время, пропадает (попытка сгорает)
const FIGHT_GRACE = 15 * 60000;                     // результат боя, начатого до конца события, принимается ещё столько
const FIGHT_FULL_MS = 20000;                        // за меньшее время потолок урона уменьшается пропорционально (самый быстрый честный бой дольше)
const MIN_FIGHT_MS = 4000;                          // быстрее этого бой с уроном не принимается
const EV_STEPS = [                                  // награды по общему урону Стаи; получает каждый, кто провёл хотя бы один бой
  { at: 0.25, coins: 200 },
  { at: 0.5, tok: 1 },                              // токен бронзового тира
  { at: 0.75, tok: 2 },                             // серебряного
  { at: 1, tok: 3, trophy: true }                   // золотого + трофейный мутант (создаётся в игре)
];
// Наибольший урон одного бойца за 12 раундов в долях его атаки: 8 обычных ударов (×1,25 за превосходство × 1,1 разброс)
// и 4 особых умения гена. Для яда добавлены тики. Это верхняя граница, честный бой даёт заметно меньше.
const DMG_K = { fang: 22, steel: 15.4, spore: 26, bone: 17.6, ether: 16.5 };
const GENE_ATK = { fang: 12, steel: 8, spore: 9, ether: 10, bone: 10 };   // базовая атака генов (как GENES в игре)
const BINGO_ATK_UB = 1.2;                           // верхняя оценка бонусов бинго к атаке (реально до 1,06 × 1,1 = 1,166)
const GENE_LIST = ['fang', 'steel', 'spore', 'ether', 'bone'];
const mskDay = t => Math.floor((t + 3 * 3600000) / 86400000);

const unitAtk = m => (GENE_ATK[m.g[0]] * 0.65 + GENE_ATK[m.g[1]] * 0.35) * (1 + 0.18 * (m.lvl - 1)) * (1 + 0.08 * (m.gen || 0)) * (1 + 0.25 * (m.tier || 0));
function fightCap(d) {
  const ub = (d.mutants || []).filter(m => !m.arc).map(m => unitAtk(m) * DMG_K[m.g[0]] * BINGO_ATK_UB).sort((a, b) => b - a).slice(0, 3);
  return ub.length ? Math.round(ub.reduce((a, b) => a + b, 0)) + 30 : 0;
}

const memberCap = () => Math.floor(EV_HP * MEMBER_SHARE);
const evInfo = now => ({ start: EV_START, end: EV_END, hp: EV_HP, share: MEMBER_SHARE, gene: GENE_LIST[mskDay(Math.max(now, EV_START)) % 5], now });

function randId() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  return [...a].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

// что получит игрок, если нажмёт «Забрать»
function pendingOf(row, total) {
  const out = { coins: 0, tokens: {}, trophy: false, mask: 0 };
  if (row.hits > 0) {
    EV_STEPS.forEach((s, i) => {
      if (total >= EV_HP * s.at && !(row.claimed & (1 << i))) {
        out.mask |= 1 << i;
        if (s.coins) out.coins += s.coins;
        if (s.tok) out.tokens[s.tok] = (out.tokens[s.tok] || 0) + 1;
        if (s.trophy) out.trophy = true;
      }
    });
  }
  if (row.bonus_tok > 0) out.tokens[1] = (out.tokens[1] || 0) + row.bonus_tok;
  return out;
}
const pendEmpty = p => !p.coins && !Object.keys(p.tokens).length && !p.trophy;

async function packTotal(env, pack) {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(dmg), 0) AS d FROM pack_members WHERE ev = ? AND pack = ? AND uid NOT IN (SELECT uid FROM banned)').bind(EV_ID, pack).first();
  return r ? r.d : 0;
}

async function packTop(env) {
  const r = await env.DB.prepare(
    `SELECT m.pack AS pack, SUM(m.dmg) AS d, COUNT(*) AS n,
       (SELECT p.name FROM pack_members o LEFT JOIN players p ON p.uid = o.uid WHERE o.ev = m.ev AND o.pack = m.pack AND o.owner = 1) AS owner
     FROM pack_members m
     WHERE m.ev = ? AND m.uid NOT IN (SELECT uid FROM banned) AND m.uid NOT IN (SELECT uid FROM players WHERE flagged = 1)
     GROUP BY m.pack HAVING d > 0 ORDER BY d DESC LIMIT 10`
  ).bind(EV_ID).all();
  return (r.results || []).map(x => ({ owner: x.owner || 'без имени', n: x.n, d: x.d }));
}

// полное состояние для экрана события
async function packView(env, uid, now) {
  const ev = evInfo(now), top = await packTop(env);
  const row = await env.DB.prepare('SELECT * FROM pack_members WHERE ev = ? AND uid = ?').bind(EV_ID, uid).first();
  if (!row) return { ok: true, ev, pack: null, top };
  const mem = (await env.DB.prepare(
    `SELECT m.uid AS uid, m.dmg AS dmg, p.name AS name FROM pack_members m LEFT JOIN players p ON p.uid = m.uid
     WHERE m.ev = ? AND m.pack = ? AND m.uid NOT IN (SELECT uid FROM banned) ORDER BY m.dmg DESC, m.joined ASC`
  ).bind(EV_ID, row.pack).all()).results || [];
  const total = mem.reduce((a, x) => a + x.dmg, 0), active = mem.filter(x => x.dmg > 0).length;
  const pd = pendingOf(row, total);
  const today = mskDay(now), daily = row.day === today ? Math.max(0, PACK_DAILY - row.used) : PACK_DAILY;
  return {
    ok: true, ev, top,
    pack: {
      id: row.pack, dmg: total, n: mem.length, mult: 1 + PACK_BONUS * Math.max(0, active - 1),
      members: mem.map(x => ({ name: x.name || 'Игрок', dmg: x.dmg, me: x.uid === uid })),
      left: daily + row.extra, claimed: row.claimed, cap: memberCap(), mine: row.dmg,
      pending: pendEmpty(pd) ? null : { coins: pd.coins, tokens: pd.tokens, trophy: pd.trophy }
    }
  };
}

// можно ли игроку участвовать: есть проверенное сохранение и он не скрыт/не забанен
async function packGate(env, uid) {
  if (await env.DB.prepare('SELECT 1 AS x FROM banned WHERE uid = ?').bind(uid).first()) return 'banned';
  const p = await env.DB.prepare('SELECT flagged FROM players WHERE uid = ?').bind(uid).first();
  if (!p) return 'no_save';
  if (p.flagged) return 'banned';
  return null;
}

async function handlePack(env, ctx, uid, params, body) {
  const now = Date.now(), act = body.action, DB = env.DB;
  if (act === 'state') return packView(env, uid, now);
  if (!['join', 'create', 'begin', 'hit', 'claim'].includes(act)) return { ok: false, reason: 'bad_action' };
  const gate = await packGate(env, uid);
  if (gate) return { ok: false, reason: gate };
  const mine = () => DB.prepare('SELECT * FROM pack_members WHERE ev = ? AND uid = ?').bind(EV_ID, uid).first();

  if (act === 'claim') {                                       // награды можно забирать и после конца события
    const row = await mine();
    if (!row) return { ok: false, reason: 'no_pack' };
    const pd = pendingOf(row, await packTotal(env, row.pack));
    if (pendEmpty(pd)) return { ...(await packView(env, uid, now)), ok: true, coins: 0, tokens: {}, trophy: null };
    // сначала занимаем награду (атомарно, двойной запрос не пройдёт), потом отдаём; бонусные токены считаются отдельно
    const r = await DB.prepare('UPDATE pack_members SET claimed = claimed | ?, bonus_tok = 0, bonus_got = bonus_got + ? WHERE ev = ? AND uid = ? AND claimed = ? AND bonus_tok = ?')
      .bind(pd.mask, row.bonus_tok, EV_ID, uid, row.claimed, row.bonus_tok).run();
    if (r.meta.changes !== 1) return { ok: false, reason: 'busy' };
    const trophy = pd.trophy ? GENE_LIST[crypto.getRandomValues(new Uint8Array(1))[0] % 5] : null;
    return { ...(await packView(env, uid, now)), ok: true, coins: pd.coins, tokens: pd.tokens, trophy };
  }

  if (now < EV_START) return { ok: false, reason: 'not_started' };
  if (act !== 'hit' && now >= EV_END) return { ok: false, reason: 'closed' };

  if (act === 'create') {
    const r = await DB.prepare('INSERT OR IGNORE INTO pack_members (ev, uid, pack, owner, joined) VALUES (?, ?, ?, 1, ?)').bind(EV_ID, uid, randId(), now).run();
    return r.meta.changes === 1 ? { ok: true } : { ok: false, reason: 'already' };
  }

  if (act === 'join') {
    const id = String(body.id || '');
    if (!/^[a-z0-9]{8}$/.test(id) || !(await DB.prepare('SELECT 1 AS x FROM pack_members WHERE ev = ? AND pack = ?').bind(EV_ID, id).first())) return { ok: false, reason: 'no_pack' };
    const r = await DB.prepare(
      `INSERT OR IGNORE INTO pack_members (ev, uid, pack, owner, joined)
       SELECT ?, ?, ?, 0, ? WHERE (SELECT COUNT(*) FROM pack_members WHERE ev = ? AND pack = ? AND uid NOT IN (SELECT uid FROM banned)) < ?`
    ).bind(EV_ID, uid, id, now, EV_ID, id, PACK_MAX).run();
    if (r.meta.changes === 1) return { ok: true };
    return { ok: false, reason: (await mine()) ? 'already' : 'full' };
  }

  const row = await mine();
  if (!row) return { ok: false, reason: 'no_pack' };

  if (act === 'begin') {
    if (row.fight_ts > 0 && now - row.fight_ts < FIGHT_TTL) return { ok: false, reason: 'busy' };
    if ((await packTotal(env, row.pack)) >= EV_HP) return { ok: false, reason: 'defeated' };
    if (row.dmg >= memberCap()) return { ok: false, reason: 'limit' };
    const sv = await DB.prepare('SELECT data FROM saves WHERE uid = ?').bind(uid).first();
    let cap = 0;
    try { cap = fightCap(JSON.parse(sv.data)); } catch (e) { cap = 0; }
    if (!(cap > 0)) return { ok: false, reason: 'no_save' };
    const today = mskDay(now), stale = now - FIGHT_TTL;
    let r = await DB.prepare(
      `UPDATE pack_members SET used = CASE WHEN day = ?1 THEN used + 1 ELSE 1 END, day = ?1, fights = fights + 1, fight_ts = ?2, fight_cap = ?3
       WHERE ev = ?4 AND uid = ?5 AND (day != ?1 OR used < ?6) AND (fight_ts = 0 OR fight_ts < ?7)`
    ).bind(today, now, cap, EV_ID, uid, PACK_DAILY, stale).run();
    if (r.meta.changes !== 1) {                                // суточные попытки кончились: тратим бесплатную
      r = await DB.prepare('UPDATE pack_members SET extra = extra - 1, fights = fights + 1, fight_ts = ?, fight_cap = ? WHERE ev = ? AND uid = ? AND extra > 0 AND (fight_ts = 0 OR fight_ts < ?)')
        .bind(now, cap, EV_ID, uid, stale).run();
    }
    if (r.meta.changes !== 1) return { ok: false, reason: 'no_tries' };
    return packView(env, uid, now);
  }

  // act === 'hit': игра присылает чистый урон боя, сервер ограничивает его потолком
  if (now >= EV_END + FIGHT_GRACE) return { ok: false, reason: 'closed' };
  const dmgIn = Number(body.dmg);
  if (!Number.isFinite(dmgIn) || dmgIn < 0 || dmgIn > 1e9) return { ok: false, reason: 'bad_dmg' };
  if (!(row.fight_ts > 0) || now - row.fight_ts > FIGHT_TTL) return { ok: false, reason: 'no_fight' };
  const el = now - row.fight_ts;
  if (el < MIN_FIGHT_MS && dmgIn > row.fight_cap * 0.02) {
    await DB.prepare('UPDATE pack_members SET fight_ts = 0 WHERE ev = ? AND uid = ? AND fight_ts = ?').bind(EV_ID, uid, row.fight_ts).run();
    return { ok: false, reason: 'too_fast' };
  }
  const capNow = row.fight_cap * Math.min(1, el / FIGHT_FULL_MS), base = Math.min(dmgIn, capNow);
  const others = (await DB.prepare('SELECT COUNT(*) AS n FROM pack_members WHERE ev = ? AND pack = ? AND uid != ? AND dmg > 0 AND uid NOT IN (SELECT uid FROM banned)').bind(EV_ID, row.pack, uid).first()).n;
  const left = Math.max(0, EV_HP - (await packTotal(env, row.pack)));
  const credited = Math.min(left, Math.max(0, memberCap() - row.dmg), Math.floor(base * (1 + PACK_BONUS * others)));
  const r = await DB.prepare('UPDATE pack_members SET fight_ts = 0, dmg = dmg + ?, hits = hits + 1 WHERE ev = ? AND uid = ? AND fight_ts = ?').bind(credited, EV_ID, uid, row.fight_ts).run();
  if (r.meta.changes !== 1) return { ok: false, reason: 'no_fight' };
  if (row.hits === 0 && !row.owner) {                          // друг провёл первый бой: бронзовый токен и бесплатная попытка ему, токен пригласившему
    await DB.prepare('UPDATE pack_members SET bonus_tok = bonus_tok + 1, extra = extra + 1 WHERE ev = ? AND uid = ?').bind(EV_ID, uid).run();
    const o = await DB.prepare('SELECT uid FROM pack_members WHERE ev = ? AND pack = ? AND owner = 1').bind(EV_ID, row.pack).first();
    if (o) {
      await DB.prepare('UPDATE pack_members SET bonus_tok = bonus_tok + 1 WHERE ev = ? AND uid = ?').bind(EV_ID, o.uid).run();
      ctx.waitUntil(tgSend(env, o.uid, nameOf(params) + ' вступил в твою Стаю и провёл первый бой. Тебе бронзовый токен: забери его на вкладке «Стая».'));
    }
  }
  return { ...(await packView(env, uid, now)), ok: true, credited, capped: dmgIn > capNow + 1 };
}

// Награды события попадают в сохранение игрока. Сервер знает, сколько он выдал, и разрешает проверке сохранений
// ровно столько сверх обычного прироста: монеты и токены трёх тиров. Учтённое помечается после принятого сохранения (evMark).
function evGranted(row) {
  let c = 0;
  const t = { 1: 0, 2: 0, 3: 0, 4: 0 };
  EV_STEPS.forEach((s, i) => { if (row.claimed & (1 << i)) { c += s.coins || 0; if (s.tok) t[s.tok]++; } });
  t[1] += row.bonus_got || 0;
  return { c, t };
}
async function evAllowance(env, uid) {
  const out = { c: 0, t: { 1: 0, 2: 0, 3: 0, 4: 0 }, rows: [] };
  try {
    const rs = (await env.DB.prepare('SELECT ev, claimed, bonus_got, mc, m1, m2, m3 FROM pack_members WHERE uid = ? AND (claimed > 0 OR bonus_got > 0)').bind(uid).all()).results || [];
    for (const r of rs) {
      const g = evGranted(r), d = { c: Math.max(0, g.c - r.mc), 1: Math.max(0, g.t[1] - r.m1), 2: Math.max(0, g.t[2] - r.m2), 3: Math.max(0, g.t[3] - r.m3) };
      if (d.c || d[1] || d[2] || d[3]) { out.c += d.c; out.t[1] += d[1]; out.t[2] += d[2]; out.t[3] += d[3]; out.rows.push({ ev: r.ev, g }); }
    }
  } catch (e) { /* таблицы события нет: события просто нет */ }
  return out;
}
async function evMark(env, uid, acc) {
  for (const r of acc.rows) {
    try { await env.DB.prepare('UPDATE pack_members SET mc = ?, m1 = ?, m2 = ?, m3 = ? WHERE ev = ? AND uid = ?').bind(r.g.c, r.g.t[1], r.g.t[2], r.g.t[3], r.ev, uid).run(); } catch (e) { /* отметим при следующем сохранении */ }
  }
}

// ---------- СЕЗОННЫЙ РЕЙТИНГ (неделя с понедельника 00:00 по Москве) ----------
// Очки начисляются только за победы, которые прошли проверку сохранения (checkDelta), и весят больше на высоких стадиях.
// Таблицы season_scores и season_claims (схема в schema-season.sql). Награды в сохранение игрока попадают через
// seasonAllowance/seasonMark, как и награды события.
const SEASON_MS = 7 * 86400000;
const seasonOf = t => Math.floor((Math.floor((t + 3 * 3600000) / 86400000) + 3) / 7);
const seasonStart = s => (s * 7 - 3) * 86400000 - 3 * 3600000;
const SEASON_CLAIM_BACK = 4;                         // забрать награду можно не позже чем через 4 сезона
const SEASON_MIN_PTS = 50;                           // меньше очков — места в наградах нет
const seasonWin = stage => 10 + Math.min(500, Math.max(1, stage || 1));   // очки за одну победу
const SEASON_REWARDS = [                             // [до места включительно, монеты, токены 1/2/3 тира]
  [1, 3000, 1, 1, 0],
  [2, 2000, 2, 0, 0],
  [3, 1500, 1, 0, 0],
  [10, 1000, 0, 0, 0],
  [50, 400, 0, 0, 0]
];
function seasonReward(place) {
  for (const r of SEASON_REWARDS) if (place <= r[0]) return { coins: r[1], t1: r[2], t2: r[3], t3: r[4] };
  return null;
}
async function seasonAdd(env, uid, P, N, elapsed, now) {
  if (!P) return;
  const cap = Math.ceil(LIM.winBase + Math.max(0, elapsed) * LIM.winRate);
  const dW = Math.min((N.wins || 0) - (P.wins || 0), cap);
  if (dW <= 0) return;
  const pts = dW * seasonWin(Math.max(P.stage || 1, N.stage || 1));
  await env.DB.prepare('INSERT INTO season_scores (season, uid, pts, wins, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT(season, uid) DO UPDATE SET pts = pts + excluded.pts, wins = wins + excluded.wins, ts = excluded.ts')
    .bind(seasonOf(now), uid, pts, dW, now).run();
}
const SEASON_BASE = 'FROM season_scores s JOIN players p ON p.uid = s.uid WHERE s.season = ? AND p.flagged = 0 AND p.uid NOT IN (SELECT uid FROM banned)';
async function seasonPlace(env, season, uid) {
  const me = await env.DB.prepare('SELECT s.pts AS pts, s.wins AS wins, s.ts AS ts ' + SEASON_BASE + ' AND s.uid = ?').bind(season, uid).first();
  if (!me || me.pts < SEASON_MIN_PTS) return { pts: me ? me.pts : 0, wins: me ? me.wins : 0, place: 0 };
  const r = await env.DB.prepare('SELECT COUNT(*) AS n ' + SEASON_BASE + ' AND (s.pts > ? OR (s.pts = ? AND (s.ts < ? OR (s.ts = ? AND s.uid < ?))))').bind(season, me.pts, me.pts, me.ts, me.ts, uid).first();
  return { pts: me.pts, wins: me.wins, place: 1 + r.n };
}
async function seasonPending(env, uid, now) {
  const cur = seasonOf(now), out = [];
  const done = new Set(((await env.DB.prepare('SELECT season FROM season_claims WHERE uid = ?').bind(uid).all()).results || []).map(x => x.season));
  const mine = (await env.DB.prepare('SELECT season FROM season_scores WHERE uid = ? AND season < ? AND season >= ?').bind(uid, cur, cur - SEASON_CLAIM_BACK).all()).results || [];
  for (const m of mine) {
    if (done.has(m.season)) continue;
    const pl = await seasonPlace(env, m.season, uid), rw = pl.place ? seasonReward(pl.place) : null;
    if (rw) out.push({ season: m.season, place: pl.place, pts: pl.pts, ...rw });
  }
  return out.sort((a, b) => a.season - b.season);
}
async function handleSeason(env, uid, body) {
  const now = Date.now(), cur = seasonOf(now);
  if (body.action === 'claim') {
    const list = await seasonPending(env, uid, now);
    const sum = { coins: 0, t1: 0, t2: 0, t3: 0 }, got = [];
    for (const p of list) {
      const r = await env.DB.prepare('INSERT OR IGNORE INTO season_claims (uid, season, place, coins, t1, t2, t3) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(uid, p.season, p.place, p.coins, p.t1, p.t2, p.t3).run();
      if (r.meta.changes === 1) { sum.coins += p.coins; sum.t1 += p.t1; sum.t2 += p.t2; sum.t3 += p.t3; got.push(p.season); }
    }
    return { ok: true, claimed: got, reward: sum };
  }
  const top = ((await env.DB.prepare('SELECT p.name AS name, p.photo AS photo, s.pts AS pts, s.wins AS wins ' + SEASON_BASE + ' ORDER BY s.pts DESC, s.ts ASC, s.uid ASC LIMIT 20').bind(cur).all()).results || []);
  const me = await seasonPlace(env, cur, uid);
  return {
    season: cur, start: seasonStart(cur), end: seasonStart(cur + 1), now,
    top: top.map(x => ({ name: x.name, photo: x.photo || null, pts: x.pts, wins: x.wins })),
    me, pending: await seasonPending(env, uid, now),
    rewards: SEASON_REWARDS.map((r, i) => ({ from: i ? SEASON_REWARDS[i - 1][0] + 1 : 1, to: r[0], coins: r[1], t1: r[2], t2: r[3], t3: r[4] })),
    minPts: SEASON_MIN_PTS
  };
}
// Выданное, но ещё не учтённое проверкой сохранений: монеты и токены трёх тиров
async function seasonAllowance(env, uid) {
  const out = { c: 0, t: { 1: 0, 2: 0, 3: 0, 4: 0 }, rows: [] };
  try {
    const rs = (await env.DB.prepare('SELECT season, coins, t1, t2, t3, mc, m1, m2, m3 FROM season_claims WHERE uid = ? AND (mc < coins OR m1 < t1 OR m2 < t2 OR m3 < t3)').bind(uid).all()).results || [];
    for (const r of rs) { out.c += r.coins - r.mc; out.t[1] += r.t1 - r.m1; out.t[2] += r.t2 - r.m2; out.t[3] += r.t3 - r.m3; out.rows.push(r); }
  } catch (e) { /* таблицы нет: сезонов нет */ }
  return out;
}
async function seasonMark(env, uid, acc) {
  for (const r of acc.rows) {
    try { await env.DB.prepare('UPDATE season_claims SET mc = coins, m1 = t1, m2 = t2, m3 = t3 WHERE uid = ? AND season = ?').bind(uid, r.season).run(); } catch (e) { /* отметим при следующем сохранении */ }
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

const inner = {
  async scheduled(event, env, ctx) { ctx.waitUntil(notifyLabs(env)); },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/top') return json(await topList(env));
    if (path === '/tg') {                                       // вебхук бота: принимаем только запросы с секретом, который знает Telegram
      if (request.method !== 'POST' || !env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return json({ error: 'forbidden' }, 403);
      let u; try { u = await request.json(); } catch (e) { return json({ ok: true }); }
      ctx.waitUntil(handleAdmin(env, u).catch(e => say(env, 'Ошибка: ' + String((e && e.message) || e))));   // ошибку показываем админу
      return json({ ok: true });
    }
    if (request.method !== 'POST' || !['/load', '/save', '/ref', '/score', '/pack', '/season'].includes(path)) return json({ error: 'not found' }, 404);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
    const v = await verify(body.initData, env.BOT_TOKEN);
    if (!v.id) return json({ error: 'unauthorized', reason: v.reason }, 401);
    const uid = v.id;

    if (path === '/ref') return json(await handleRef(env, ctx, uid, v.params, body.action));
    if (path === '/pack') return json(await handlePack(env, ctx, uid, v.params, body));
    if (path === '/season') return json(await handleSeason(env, uid, body));

    if (path === '/load') {
      const row = await env.DB.prepare('SELECT rev, data FROM saves WHERE uid = ?').bind(uid).first();
      return json(row ? { rev: row.rev, data: row.data } : { rev: 0, data: null });
    }

    if (path === '/score') {                          // рекорд берётся только из проверенных сохранений, а не из запроса
      const p = await env.DB.prepare('SELECT best, flagged FROM players WHERE uid = ?').bind(uid).first();
      const best = p ? p.best : 1;
      return json({ ok: true, best, rank: await rankOf(env, best), pending: !!(p && p.flagged) });
    }

    // /save: принимаем, только если устройство опиралось на актуальную версию (rev), иначе конфликт
    const rev = Number(body.rev) || 0;
    const data = body.data;
    if (typeof data !== 'string' || data.length > 300000) return json({ error: 'bad data' }, 400);
    let N;
    try { N = JSON.parse(data); } catch (e) { return json({ error: 'bad data' }, 400); }
    const now = Date.now();
    if (await env.DB.prepare('SELECT 1 AS x FROM banned WHERE uid = ?').bind(uid).first()) return json({ rejected: true, reason: 'banned', retry: 3600000 });
    const row = await env.DB.prepare('SELECT rev, data, ts, refc FROM saves WHERE uid = ?').bind(uid).first();
    const cur = row ? row.rev : 0;
    if (rev !== cur) return json({ conflict: true, rev: cur, data: row ? row.data : null });

    // проверка: форма и пределы, затем сравнение с прошлым сохранением
    const trusted = !!(await env.DB.prepare('SELECT 1 AS x FROM trusted WHERE uid = ?').bind(uid).first());
    const refRow = await env.DB.prepare('SELECT claimed FROM ref_claims WHERE uid = ?').bind(uid).first();
    const refNow = refRow ? refRow.claimed : 0;
    const evAcc = await evAllowance(env, uid);
    const seAcc = await seasonAllowance(env, uid);
    const allow = { c: evAcc.c + seAcc.c, t: { 1: evAcc.t[1] + seAcc.t[1], 2: evAcc.t[2] + seAcc.t[2], 3: evAcc.t[3] + seAcc.t[3], 4: evAcc.t[4] + seAcc.t[4] } };
    let Pj = null;
    if (row) { try { Pj = JSON.parse(row.data); } catch (e) { Pj = null; } }
    if (Pj && checkShape(Pj)) Pj = null;
    let reason = checkShape(N), shape = !!reason, flagged = 0;
    if (!reason && !trusted) {
      let P = null;
      if (row) { try { P = JSON.parse(row.data); } catch (e) { P = null; } }
      if (P && !checkShape(P) && row.ts < GRACE_BEFORE) {
        // однократная амнистия: прошлое сохранение старше переработки игры, а облако было сломано, и игроки ушли вперёд
        // без синхронизации; сравнивать с ним нельзя. Форму и пределы проверили выше, стадию против уровней проверяем здесь.
        if (stageTooHigh(N)) flagged = 1;
      } else if (P && !checkShape(P)) {
        let refExtra = 0;
        for (let k = (row.refc || 0) + 1; k <= refNow; k++) refExtra += refReward(k);
        reason = checkDelta(P, N, (now - row.ts) / 1000, now, refExtra, allow);
      } else if (firstIsBig(N)) flagged = 1;           // истории нет, а прогресс не для новичка: сохраняем, но скрываем из рейтинга
    }
    if (reason) {
      await logReject(env, uid, reason, N, now);
      const el = row ? (now - row.ts) / 1000 : 1e9;
      const wait = !shape && row && el < LIM.window;   // слишком быстро: пусть повторит чуть позже
      // невозможные значения (уровень 9999, чужой тир и т.п.) честная игра дать не может: прячем игрока из рейтинга
      if (shape || reason === 'tier_up' || reason === 'new_lvl') {
        await env.DB.prepare('UPDATE players SET flagged = 1 WHERE uid = ?').bind(uid).run();
      }
      return json({ rejected: true, reason: wait ? 'wait' : reason, retry: wait ? Math.ceil((LIM.window - el) * 1000) + 500 : 300000 });
    }

    let changed = 0;
    if (rev === 0) {
      const r = await env.DB.prepare('INSERT OR IGNORE INTO saves (uid, rev, data, ts, refc) VALUES (?, 1, ?, ?, ?)').bind(uid, data, now, refNow).run();
      changed = r.meta.changes;
    } else {
      const r = await env.DB.prepare('UPDATE saves SET rev = rev + 1, data = ?, ts = ?, refc = ? WHERE uid = ? AND rev = ?').bind(data, now, refNow, uid, rev).run();
      changed = r.meta.changes;
    }
    if (changed === 1) {
      if (evAcc.rows.length) await evMark(env, uid, evAcc);
      if (seAcc.rows.length) await seasonMark(env, uid, seAcc);
      if (!flagged && !shape) { try { await seasonAdd(env, uid, Pj, N, row ? (now - row.ts) / 1000 : 0, now); } catch (e) { /* таблиц сезона нет */ } }
      await env.DB.prepare('INSERT INTO players (uid, name, best, flagged, ts, photo) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name, photo = COALESCE(excluded.photo, players.photo), best = MAX(players.best, excluded.best), flagged = MAX(players.flagged, excluded.flagged), ts = excluded.ts')
      .bind(uid, nameOf(v.params), bestOf(N), flagged, now, photoOf(v.params)).run();
      return json({ ok: true, rev: rev + 1 });
    }
    const cr = await env.DB.prepare('SELECT rev, data FROM saves WHERE uid = ?').bind(uid).first();
    return json({ conflict: true, rev: cr ? cr.rev : 0, data: cr ? cr.data : null });
  }
};

export default {
  fetch: async (request, env, ctx) => {
    try { return await inner.fetch(request, env, ctx); }
    catch (e) { return json({ error: 'server', message: String((e && e.message) || e) }, 500); }   // текст ошибки виден в игре
  },
  scheduled: (event, env, ctx) => inner.scheduled(event, env, ctx)
};

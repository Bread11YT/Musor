import { parseRankCommand } from './parser.js';
import { tg, reply, mention, rememberUsers, resolveTarget } from './telegram.js';
import { getRank, nextRank, checkChange, setRank, rankLabel } from './ranks.js';

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('ok');
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const update = await request.json();
    // Сразу отвечаем Telegram 200, а работу делаем в фоне — иначе он будет слать апдейт повторно
    if (update.message) ctx.waitUntil(handleMessage(env, update.message).catch((e) => console.error(e)));
    return new Response('ok');
  },
};

async function handleMessage(env, msg) {
  if (!['group', 'supergroup'].includes(msg.chat.type)) return;
  if (!msg.from || msg.from.is_bot) return;
  await rememberUsers(env, msg);
  if (!msg.text) return;

  const cmd = parseRankCommand(msg.text);
  if (cmd) await handleRankCommand(env, msg, cmd);
}

async function handleRankCommand(env, msg, cmd) {
  const chatId = msg.chat.id;
  const issuer = msg.from;

  const found = await resolveTarget(env, msg, cmd.targetText);
  if (!found) return;

  // Обычным участникам (0 ранг) молчим, чтобы бот не засорял чат
  const issuerRank = await getRank(env, chatId, issuer.id);
  if (issuerRank === 0) return;

  if (found.error === 'missing') {
    return reply(env, msg, 'Укажите пользователя: ответом на его сообщение, @username или ссылкой t.me/…');
  }
  if (found.error === 'unknown') {
    return reply(env, msg, 'Не знаю такого пользователя. Пусть напишет что-нибудь в чат или ответьте на его сообщение.');
  }

  const target = found.user;
  if (target.is_bot) return reply(env, msg, 'Ботам ранги не выдаются.');
  if (target.id === issuer.id) return reply(env, msg, 'Нельзя менять собственный ранг.');

  const member = await tg(env, 'getChatMember', { chat_id: chatId, user_id: target.id });
  if (!member || ['left', 'kicked'].includes(member.status)) {
    return reply(env, msg, 'Этого пользователя нет в чате.');
  }
  if (member.user) Object.assign(target, member.user);

  const current = await getRank(env, chatId, target.id);
  const next = nextRank(cmd, current);
  if (next.error) return reply(env, msg, next.error);

  const denied = checkChange(issuerRank, current, next.rank);
  if (denied) return reply(env, msg, denied);

  await setRank(env, chatId, target.id, current, next.rank, issuer.id);
  const who = mention(target);
  return reply(
    env,
    msg,
    next.rank === 0 ? `✅ ${who} больше не модератор.` : `✅ Ранг изменён: ${who} — ${rankLabel(next.rank)}.`,
  );
}

// Выдача подарков игрокам из админ-панели в Telegram.
// Работает поверх worker-stars.js (нужна таблица purchases и функции ownedPerks, buyAllowance).
// Вставь этот код в worker.js рядом с остальными admin-функциями (например, перед "async function handleAdmin"),
// потом внеси 3 правки из конца файла.
//
// Команды (только для ADMIN_ID):
//   /give UID               показать кнопки выдачи
//   /give UID coins 500     выдать монеты (от 1 до 1 000 000)
//   /give UID auto          выдать «Авто-автобой» навсегда
//   /give UID x2            выдать «Скорость ×2» навсегда
//   /revoke UID auto|x2     забрать подаренный навык (купленное за Stars не отбирается)
//
// Подарок идёт тем же путём, что покупка: монеты приходят в игру при следующем входе (или через несколько секунд,
// если игра открыта), а защита от накрутки их пропускает. Игрок получает сообщение от бота, если когда-то нажимал Start.

const GIFT_NAMES = { auto: 'Авто-автобой', x2: 'Скорость ×2' };

async function adminGiveMenu(env, uid) {
  return say(env, 'Что выдать игроку ' + uid + '?', { inline_keyboard: [
    [btn('+500 монет', 'give ' + uid + ' coins 500'), btn('+2500 монет', 'give ' + uid + ' coins 2500')],
    [btn('+10000 монет', 'give ' + uid + ' coins 10000')],
    [btn('Авто-автобой', 'give ' + uid + ' auto'), btn('Скорость ×2', 'give ' + uid + ' x2')]
  ] });
}

async function adminGive(env, uid, what, amount) {
  what = String(what || '').toLowerCase();
  const known = await env.DB.prepare('SELECT 1 AS x FROM players WHERE uid = ?').bind(uid).first();
  if (!known) return say(env, 'Игрок ' + uid + ' не найден: он ни разу не сохранялся в игре. Проверь номер (/top показывает uid).');
  const now = Date.now(), cid = 'gift:' + now.toString(36) + Math.random().toString(36).slice(2, 7);

  if (what === 'coins') {
    const n = Number(amount);
    if (!isInt(n, 1, 1000000)) return say(env, 'Сколько монет? Например: /give ' + uid + ' coins 500 (от 1 до 1 000 000).');
    await env.DB.prepare('INSERT INTO purchases (charge_id, user_id, product, stars, coins, acked, ts) VALUES (?,?,?,?,?,0,?)')
      .bind(cid, uid, 'gift_coins', 0, n, now).run();
    await tgSend(env, uid, 'Тебе выдали ' + n + ' монет! Открой игру, и они появятся.');
    return say(env, 'Выдано ' + n + ' монет игроку ' + uid + '. Появятся в игре, когда он её откроет.');
  }

  if (what === 'auto' || what === 'x2') {
    if ((await ownedPerks(env, uid))[what]) return say(env, 'У игрока ' + uid + ' «' + GIFT_NAMES[what] + '» уже есть.');
    await env.DB.prepare('INSERT INTO purchases (charge_id, user_id, product, stars, coins, acked, ts) VALUES (?,?,?,?,?,1,?)')
      .bind(cid, uid, what, 0, 0, now).run();
    await tgSend(env, uid, 'Тебе подарили «' + GIFT_NAMES[what] + '»! Открой игру: он уже доступен.');
    return say(env, 'Выдано «' + GIFT_NAMES[what] + '» игроку ' + uid + '.');
  }

  return say(env, 'Не понял, что выдать. Варианты: coins N, auto, x2. Пример: /give ' + uid + ' coins 500');
}

async function adminRevoke(env, uid, what) {
  what = String(what || '').toLowerCase();
  if (what !== 'auto' && what !== 'x2') return say(env, 'Забрать можно auto или x2. Пример: /revoke ' + uid + ' auto');
  const r = await env.DB.prepare("DELETE FROM purchases WHERE user_id = ? AND product = ? AND charge_id LIKE 'gift:%'").bind(uid, what).run();
  return say(env, r.meta.changes
    ? 'Подаренный навык «' + GIFT_NAMES[what] + '» забран у ' + uid + '. В игре пропадёт при следующей синхронизации.'
    : 'У ' + uid + ' нет подаренного «' + GIFT_NAMES[what] + '». Купленное за Stars не отбирается.');
}

/* ============ 3 ПРАВКИ В worker.js ============

1) В handleAdmin найди строку
     const cmd = m[1].toLowerCase(), uid = m[2] ? Number(m[2]) : null;
   и сразу ПОСЛЕ неё добавь:
     if (cmd === 'give' || cmd === 'revoke') {
       if (!uid) return say(env, 'Укажи номер игрока: /give 123456789 coins 500 (или auto, или x2)');
       const a = text.trim().split(/\s+/);          // ['/give', uid, что, сколько]
       if (cmd === 'revoke') return adminRevoke(env, uid, a[2]);
       return a[2] ? adminGive(env, uid, a[2], a[3]) : adminGiveMenu(env, uid);
     }

2) В тексте HELP (строка начинается с 'Админ-панель Геномной арены') найди кусок
     /wipe UID: стереть сохранение игрока и его запись в рейтинге
   и допиши после него:
     \n/give UID: выдать монеты, auto или x2 (например /give UID coins 500)\n/revoke UID auto|x2: забрать подаренный навык

3) (по желанию) Кнопка «Выдать» в карточке игрока. В adminInfo найди
     [btn('Вернуть в рейтинг', 'unflag:' + uid), btn('Стереть сохранение', 'wipe:' + uid)]]
   и замени конец на
     [btn('Вернуть в рейтинг', 'unflag:' + uid), btn('Стереть сохранение', 'wipe:' + uid)], [btn('Выдать', 'give ' + uid)]]

Потом задеплой Worker. Вебхук перевыставлять не нужно.
*/

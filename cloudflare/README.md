# Cloudflare Workers + D1 — бесплатная облачная версия ателье

**Рабочий адрес инфраструктуры:** https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev/health

Статус: Worker опубликован, D1 создана и заполнена демонстрационным каталогом.
**На момент первой публикации Telegram webhook не переключён:** действующий Windows-бот
сохраняет long polling. Для передачи рабочего бота на Cloudflare нужны Worker Secrets
(`BOT_TOKEN`, `ADMIN_IDS`, `WEBHOOK_SECRET`) и однократная установка webhook.

## Архитектура

- HTTP POST `/webhook` принимает Telegram update с проверкой
  `X-Telegram-Bot-Api-Secret-Token`. Без правильного секрета — 403.
- Cloudflare D1 хранит каталог, корзины, FSM состояния, заявки, статусы, платежные
  записи и уже обработанные `update_id` (защита от повторных Telegram доставок).
- `/health` отвечает без раскрытия секретов.
- Токен должен храниться **только в Wrangler Worker Secrets**, не в `wrangler.jsonc` и не в Git.
- По умолчанию `DEMO_MODE=1`, с заказами работает исключительно заданный администратор.
  Никто из сторонних пользователей не может оформить заказ с вымышленными ценами.
- Excel формируется в формате XLSX сервером (без внешних npm-пакетов); CSV не подменяет Excel.

Облачная схема совместима по основной логике, но это самостоятельная реализация
на JavaScript и D1, а не запущенный в Workers Python/aiogram. Исторические SQLite
заказы и персональные данные с Windows **не переносились**: облачная база отдельная.

## Проверенная конфигурация

- Worker: `atelier-customwear-demo-2026`
- D1: `atelier-customwear-demo-2026`
- В каталоге: 3 тестовых категории, 3 изделия, 4 варианта. Они не продаются.
- В GitHub Actions: `node --test cloudflare/test/integration.test.mjs`.
- Локальный тест проверяет чужого пользователя в демо, webhook secret, каталог,
  корзину, заказ, отмену, склад, версионирование смет и XLSX.
- Worker/D1 входят в бесплатный тариф Cloudflare, но действуют ограничения на число
  запросов и на объём данных.

## Развёртывание и миграции

В каталоге `cloudflare`:

```powershell
npx wrangler whoami
npx wrangler d1 execute atelier-customwear-demo-2026 --remote --file=./schema.sql
npx wrangler d1 execute atelier-customwear-demo-2026 --remote --file=./seed.sql
npx wrangler deploy
```

**Важное:** не выполняйте seed.sql на боевой базе с реальными товарами:
id коллизии могут скрыть ошибку конфигурации. Файл создаёт только
синтетический каталог в новой демо-базе.

Для первого подключения бота секреты задаются только в приватном интерактивном
диалоге Wrangler (не копируйте секреты в командную строку, историю PowerShell,
публичный CI или чат):

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put ADMIN_IDS
npx wrangler secret put WEBHOOK_SECRET
```

Сгенерируйте для webhook непредсказуемое значение (32+ символов из
A–Z, a–z, 0–9, `_`, `-`) и укажите то же значение в Telegram
`setWebhook` параметром `secret_token`.

Чтобы избежать конфликтов, **остановите** локальный долгий polling до установки
Telegram webhook:

```powershell
Stop-ScheduledTask -TaskName AtelierTelegramDemo
```

Затем отправьте официальный запрос Telegram Bot API `setWebhook` (POST с
`url=https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev/webhook`,
`secret_token` равным Cloudflare secret). Не вставляйте токен в командную строку
и не публикуйте URL Telegram Bot API с токеном.

Проверяйте `getWebhookInfo`, чтобы `url` совпадал и
`last_error_message` был пустым. После перехода: проверить `/start`, корзину,
статусы, заявку на пошив и `/report` через настоящего Telegram-клиента.

**Откат:** вызвать Telegram `deleteWebhook`, затем
`Start-ScheduledTask -TaskName AtelierTelegramDemo`.
Данные D1 и локальной SQLite не объединяются автоматически.

## Ограничения и безопасность

- Базовый Worker-проект предназначен **только для демо**, не для работы с настоящими
  клиентами без дополнительной приёмки, политики персональных данных и миграций.
- Изменения товаров из локального `python -m atelier.manage` не появятся автоматически в D1.
- Полноценная миграция заказов, проверка конкуренции при одновременной покупке,
  атомарность списания нескольких позиций и финансирование реальных возвратов требуют
  отдельной доработки перед отключением DEMO_MODE.
- Обработанные Telegram update сохраняются в D1; необходимо предусмотреть срок
  хранения служебного журнала после выхода в боевой режим.
- D1 имеет штатные механизмы восстановления, но не заменяет согласованное
  резервное копирование и политику удаления клиентских сведений.

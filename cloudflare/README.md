# Cloudflare Workers + D1: действующий бесплатный демо-хостинг

**Worker:** https://atelier-customwear-demo-2026.igorekglukhovskii43.workers.dev/health
**Telegram:** https://t.me/atelier_customwear_2611_bot

## Состояние — 1 ноября 2026

Telegram webhook установлен через официальный Bot API и указывает на этот Worker.
Три секретные переменные `BOT_TOKEN`, `ADMIN_IDS`, `WEBHOOK_SECRET`
переданы из локального `.env` напрямую в Cloudflare с помощью штатного
`wrangler secret bulk`, через **stdin**: ни значения, ни аргументы с ними
не выводились в чат, журналы Bridge или GitHub.

После переключения:
- Telegram `getWebhookInfo` подтвердил адрес Cloudflare;
- отправленный из настоящего Telegram Desktop `/start` получил новый ответ;
- `/report` отправил настоящий XLSX в Telegram (проверено в клиенте);
- проверка Worker `/health` и `getWebhookInfo` прошла, ошибок Telegram нет,
  ожидающих обновлений — 0;
- задача Windows `AtelierTelegramDemo` **остановлена и отключена**,
  при входе в Windows локальный polling не возобновится.

Бот работает **без включённого компьютера**, в пределах лимитов бесплатного
тарифа Cloudflare Workers + D1. В Cloudflare хранится отдельная база, не
синхронизированная с локальной SQLite.

## Реализация

- Worker `src/index.js` принимает POST `/webhook` с проверкой
  `X-Telegram-Bot-Api-Secret-Token` и ведёт историю `update_id` в D1.
- Cloudflare D1: `atelier-customwear-demo-2026`, схема `schema.sql`.
- `seed.sql` добавляет 3 категории, 3 вымышленных изделия, 4 варианта.
- Демонстрационный режим `DEMO_MODE=1`: только администратор может создать
  тестовый заказ. Посторонним клиентам реальные продажи недоступны.
- Поддерживаются каталог, корзина, заявка на пошив, версии смет,
  статусы, ручной учёт поступлений и Excel.
- `src/xlsx.js` формирует корректный XLSX без внешних runtime-зависимостей.

## Автоматическое подключение без раскрытия токенов

В каталоге проекта есть:
- `scripts/sync-cloudflare-secrets.py` — читает локальный `.env`, генерирует
  webhook-секрет при отсутствии, проверяет формат значений, посылает JSON
  только в stdin официального Wrangler, проверяет только названия переменных.
- `scripts/cutover-cloudflare.py` — проверяет Worker и Telegram, останавливает
  Windows-задачу, устанавливает webhook, проверяет URL. При ошибке пытается
  вернуть Windows-бота.
- `scripts/verify-cloudflare.py` — проверяет `/health`, адрес webhook,
  отсутствие ошибки доставки и число ожидающих обновлений.
- `scripts/rollback-cloudflare.py` — **ручной аварийный откат**:
  `deleteWebhook` без удаления ожидающих сообщений, включение и запуск
  Windows-задачи. Применять только при реальной проблеме с облаком.

Все операции используют **локальный Python из `.venv`**. Никогда не
запускайте повторный `cutover` для другого бота без проверки имени.
Токен и клиентские базы в публичный репозиторий не попадают.

## Установка с нуля или повторное развёртывание

В папке `cloudflare`:

```powershell
npx wrangler@4.156.0 whoami
npx wrangler@4.156.0 d1 execute atelier-customwear-demo-2026 --remote --file=./schema.sql
npx wrangler@4.156.0 deploy
```

**Не выполняйте `seed.sql` на базе настоящих клиентов**, если не хотите
добавить демонстрационный ассортимент.

Чтобы повторно проверить уже работающий облачный бот:

```powershell
.\.venv\Scripts\python.exe scripts\verify-cloudflare.py
```

Чтобы намеренно вернуть бота на Windows:

```powershell
.\.venv\Scripts\python.exe scripts\rollback-cloudflare.py
```

## Проверки и ограничения

- Облачный интеграционный тест: `node --test cloudflare/test/integration.test.mjs`
  на Node 24. Проверяет каталог, заказ, отмену, возврат остатков, защиту
  от повторной доставки, устаревшую смету и XLSX.
- Настоящий файл XLSX открыт через `openpyxl`, текст формулы не выполняется.
- `/webhook` без секрета возвращает HTTP 403.
- GitHub Actions для Worker и Python прошли.

**Для боевых продаж ещё не готово:** требуется настоящий каталог,
правила обработки персональных данных, испытания с отдельным покупателем,
проверка конкурентного оформления, политика резервного копирования D1
и отключение `DEMO_MODE` только после этих шагов. Банковские платежи
не подключены; записи о поступлениях — ручной учёт.

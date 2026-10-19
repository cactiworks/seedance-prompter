# Общая студия на Linux

Netlify проксирует HTTPS к Caddy. Caddy передаёт Host `127.0.0.1:4317`; browser auth
настраивается отдельно по решению владельца (19.10.2026 вход открыт без логина). Node слушает только loopback. В Netlify
попадает пустой gateway с redirect rule; код, данные и ключи живут на сервере.
Локальный режим Mac остаётся для разработки и отката.

## Установка

1. Linux, Node >=24 (проверено 26.12.0), npm, ffmpeg/ffprobe, zip, Caddy, rsync.
   Codex CLI 0.162.1. Каждый пользователь подключает ChatGPT в интерфейсе студии.
2. Отдельный пользователь `seedance`, home `/var/lib/seedance`; данные в
   `/var/lib/seedance/data`, приватные browser sessions и Codex homes в `SP_ACCOUNTS_DIR`
   (по умолчанию соседний `accounts/`, права каталогов 0700, файлов 0600). Каталог должен быть вне
   data и dist. В server mode подключения обязательны: глобальный CODEX_HOME не используется.
   Каждый браузер нажимает «Подключить ChatGPT» → открывает официальную страницу OpenAI →
   входит в свой аккаунт и вводит одноразовый код. При необходимости разрешить device code login
   в настройках безопасности ChatGPT. Не копировать общий auth.json между пользователями.
3. Код/release в `/opt/seedance/releases/<revision>`, symlink `/opt/seedance/current`.
   Собрать `npm run check` на машине разработки, передать src/server, src/core, packs, dist,
   package.json и package-lock.json. На сервере `npm ci --omit=dev`.
4. Ключи провайдеров: root-owned `/etc/seedance/credentials/kie-api-key` и
   `higgsfield-api-key`, доступ на чтение только группе seedance (каталог 0750, файлы 0440), CREDENTIALS_DIRECTORY в unit. Секреты не являются environment values
   и не передаются Codex. На Mac прежний Keychain остаётся источником.
5. `/etc/seedance/studio.env`: `SP_PUBLIC_ORIGINS=https://studio.example.com,https://project.netlify.app`.
   Только точные HTTPS origins, без wildcard. Установить `seedance.service`, включить systemd.
6. Настроить Caddy по примеру: публичное DNS-имя и HTTPS. Шаблон содержит optional password hash;
   при открытом входе убрать весь `basic_auth`, при защищённом проверить 401 на всех путях origin.
   Netlify production доступен без Netlify SSO. SSH по ключу, наружу только 22/80/443. Не включать access logs с Authorization.

## Перенос и проверка

- Перед cutover проверить отсутствие активных jobs/Production. Остановить исходный процесс,
  сделать локальный архив, затем rsync всей data без `.server.lock`. Проверить SHA-256 каждого
  файла **до первого запуска** на сервере. Два scheduler с одной копией задач не запускать.
- Проверить anonymous 200 при открытом входе либо anonymous 401 / authenticated 200 при защищённом на обоих адресах; CSP/Origin и mutation header;
  список/файлы библиотеки, Canvas, проекты, Production, ZIP; restart сохраняет данные.
- Длинные JSON POST используют `Prefer: respond-async`: запрос выполняется один раз, клиент
  опрашивает `/api/requests/:id`, отмена передаётся исходному signal. После рестарта polling
  получает 410, автоматического повторного POST нет. Стоимость и согласия проверяет исходный route.
  Результаты транспорта временные (30 минут); генерации и Production сохраняют собственное состояние.
- Бесплатный `npm run doctor`/прямой `node src/server/doctor.ts` проверяет CLI и login, но не inference.
  Это локальный CLI, а не подключения пользователей студии. Свой статус — `/api/chatgpt`; чужие аккаунты через API не перечисляются. Платные проверки выполняет владелец. Наличие подключения не доказывает доступность модели или остаток квоты.
- Большие binary uploads и downloads проходят обычным HTTP; лимит времени proxy Netlify 26 секунд
  остаётся для них. Для медленного/крупного переноса использовать прямой HTTPS-адрес origin.
- История Prompter и незавершённые формы в localStorage — браузерные черновики, они не являются
  общим хранилищем. Перед cutover сохранить их отдельно; consent между origins не копировать.

## Обслуживание

`systemctl status seedance`, `journalctl -u seedance --since '1 hour ago'`,
`journalctl -u caddy --since '1 hour ago'`, `df -h`, `du -sh /var/lib/seedance/data`.
Журнал содержит request ID/path/status, не body. Логи systemd ограничить по размеру.
Перед обновлением: check → остановка после завершения задач → backup → новый release →
symlink → restart → smoke с действующим режимом входа. Откат: старый symlink и при необходимости согласованная
копия data. Не перезаписывать актуальные данные сервера старой локальной копией.
Снимок на том же диске не защищает от потери VPS; нужен отдельный скачанный архив.

В корне локального checkout можно создать игнорируемый `.seedance-remote.json`:
`{"url":"https://project.netlify.app"}`. Обычный launcher открывает общую студию;
`npm run start:offline`/`npm run dev` и отдельный SP_DATA_DIR сохраняют локальную разработку.
Адреса конкретного VPS и инструкции доступа хранятся в приватном operational runbook вне Git.

## Подключения ChatGPT

Sessions сохраняются между рестартами. Cookie __Host-, HttpOnly, Secure, SameSite=Strict, 180 дней,
host-only; прямой origin и Netlify — разные sessions. Закрытие диалога не отменяет вход,
«Отменить вход» отменяет. Код живёт до 15 минут. Выход удаляет собственные credentials;
текущий вызов сначала нужно завершить/отменить. Reconnect создаёт новый profile: старый этап
не переключится на другой аккаунт без явного retry. Дубликат requestId не меняет binding.
Старые серии читаются как прежде. Вызовы одного profile последовательны, без гонки refresh.

Бэкап accounts хранить отдельно с доступом 0600, как пароль; не в library, экспорте или Git.
Потеря accounts требует повторного входа, общая data остаётся. Откат на release без этой функции
требует остановки новых LLM: старый код использовал глобальный home, без отдельных подключений.

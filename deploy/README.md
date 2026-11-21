# Общая студия на Linux

## Общий каталог референсов

`SP_SHARED_REFERENCE_LIBRARY=1` включает каталог в сервисе общей студии за Caddy. Требуются
loopback, точные `SP_PUBLIC_ORIGINS` и текущая служба подключений ChatGPT/API. Кадры и метаданные
хранятся в `references` того же `SP_DATA_DIR`. В standalone-чате подборки и оценки привязаны
к AI-подключению. Подборки Canvas доступны вместе с холстом. Проверяй `enabled` и `shared` в
`GET /api/references/status` и доступность списка кадров через обычный HTTPS-вход. Закрытый
пилот использует собственные данные и unit. Флаги shared и private взаимоисключающие.

## Закрытый пилот библиотеки референсов

`seedance-references.service` запускает отдельную студию с собственными данными и отдельным
подключением ChatGPT/API. На VPS разложи проверенную production сборку в отдельную папку релиза,
направь `/opt/seedance/reference-current` на неё и установи unit. `DynamicUser` и `StateDirectory`
изолируют файлы от общей студии. Unit слушает `127.0.0.1:4321`; к Caddy его не подключать.

Открыть доступ с Mac: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4321:127.0.0.1:4321 <vps-host>`.
В браузере открыть `http://127.0.0.1:4321/` и подключить свой аккаунт в студии. Smoke проверяет,
что `/api/references/status` возвращает `enabled: true` через туннель, на общем входе раздел закрыт,
а unit слушает только loopback. `systemctl disable --now seedance-references` остановит пилот,
сохранив его state directory. Резервную копию данных пилота хранить отдельно от общей студии.
После проверки пилота включи граф переключателем `SP_REFERENCE_GRAPH=1` в drop-in этого unit.

Основная topology по решению владельца 06.11.2026: браузер → прямой HTTPS → Caddy на
существующем VPS → Node/systemd. Caddy передаёт Host `127.0.0.1:4317`; Node слушает только
loopback. Код, shared data, private accounts, Codex CLI и обработка медиа остаются на том же VPS.
Локальный режим Mac сохраняется для разработки и отката.

Netlify — прежний optional gateway, не участвующий в прямом входе; шаблон
`netlify.toml.example` сохранён только для legacy/отката. Прямой cutover проверен 06.11.2026.
Vercel не внедрён и для этой topology не требуется. Режим browser auth не меняется: по решению владельца 19.10.2026 вход открыт без логина.

## Релиз серверного сохранения Canvas — 21.11.2026

Release `9a62161`: автосохранение Canvas, перенос прежних черновиков и история версий на VPS.
Предыдущий `602ba59` доступен для отката. Резервная копия shared data из 889 файлов передана на Mac,
сверена по SHA-256 и повторно сопоставлена с VPS до запуска. Direct HTTPS отдаёт новый runtime
и точные assets сборки. На VPS в отдельной временной папке прошли merge, повтор после потери ACK,
чтение после переоткрытия, перенос и восстановление прежнего черновика. Живой Chromium подтвердил
статус «Сохранено на сервере» и доступность истории с изолированной тестовой выдачей холстов.

## Обновление runtime — 20.11.2026

Release `602ba59`: отдельные ноды AI · идея и AI · промпт, возврат одобренной версии из истории.
Предыдущий `872affe` оставлен для отката. Backup858files проверен на Mac; после cutover все
858 файлов совпали. Direct smoke21checks PASS; затем явно возвращена прежняя approved идея в
существующий Flow без inference или переписывания истории. Подробнее — `docs/BACKLOG.md`.

## Обновление runtime — 17.11.2026

Обновление runtime 17.11.2026: Canvas AI release `872affe` развёрнут на том же VPS; старый `9faf229`
сохранён для отката. Backup 812 файлов скачан на Mac и проверен по SHA-256. Все исходные файлы
совпали до/после запуска; после canary добавился только trash временного тестового Flow.
Базовый direct smoke (21 checks), новый Canvas AI smoke (12 checks), сохранение/reload графа
пяти B-roll и Chromium UI прошли без AI/media calls. Реальное качество генераций проверяет владелец.
Подробный результат — `docs/BACKLOG.md`; конкретные operational paths остаются в приватном runbook.

## Статус cutover — 06.11.2026

Прямой вход проверен: HTTPS UI и JS/CSS отвечают 200, `/api/health` показывает release
`2d1cecc`, pack читается. Списки проектов, Canvas, Production, library и jobs доступны из
существующего shared хранилища. Скачивание media совпало по SHA-256; video Range вернул
206 и 65 536 bytes. POST с direct Origin прошёл до `INVALID`/422 без записи; foreign Origin
и отсутствие `x-sp-client` отклонены с 403. В браузере открыты library, Production и AI dialog
без запуска генераций.

Игнорируемая `.seedance-remote.json` переключена на прямой вход; обычный launcher проверен
через `SP_NO_OPEN=1 npm start`. Runtime/config/data VPS не менялись, restart не выполнялся.
AI status — enabled/disconnected: реальный login и inference остаются проверкой владельца.

Страница availability Netlify сообщает, что legacy project disabled из-за исчерпанных team credits.
Gateway не включали и не удаляли; постоянное ручное отключение не заявлено. Общий team tariff
не отменён: это отдельная операция вне переключения одной студии и не блокер прямого входа.
После следующего billing cycle доступность legacy gateway может восстановиться. Прежний origin
остаётся в allowlist только для отката; direct студия от него не зависит.

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
5. `SP_PUBLIC_ORIGINS` содержит точный прямой HTTPS origin студии, без wildcard и завершающего `/`.
   В действующем deployment значение задано через `Environment=` в systemd unit. Шаблон
   `seedance.service` использует `/etc/seedance/studio.env`: при новой установке создать этот
   EnvironmentFile либо задать переменную в unit и убрать ссылку на отсутствующий EnvironmentFile.
   Legacy origin допустим для отката и не требуется
   прямому входу. Установить `seedance.service`, включить systemd.
6. Настроить Caddy по примеру: публичное DNS-имя и HTTPS. Шаблон содержит optional password hash;
   при открытом входе убрать весь `basic_auth`, при защищённом проверить 401 на всех путях origin.
   SSH по ключу, наружу только 22/80/443. Не включать access logs с Authorization.

## Переключение с legacy gateway на прямой VPS

При смене только входного адреса shared data и accounts остаются на месте. Не переносить старую
локальную `data/` поверх серверной и не запускать второй scheduler. Конкретные hostname,
IP, доступы и backup paths хранятся в приватном operational runbook вне Git.

1. Записать текущую release revision и безопасные счётчики проектов, library, Canvas и Production;
   перед изменением Caddy/service settings сохранить их копию; перед runtime update — свежий data backup.
   Простая смена URL не меняет data и не требует нового архива. Проверить активные jobs и этапы Production.
   Перед необходимым restart дождаться их завершения; остановленные
   или unknown задачи автоматически не повторять.
2. Проверить DNS прямого hostname на существующий VPS и действительный HTTPS certificate Caddy.
   Сохранить upstream Host `127.0.0.1:4317`, текущий режим browser auth, private/no-store API headers
   и запрет на раздачу source/data/accounts. Проверить Caddy config перед reload.
3. Проверить наличие точного прямого HTTPS origin в `SP_PUBLIC_ORIGINS`; добавить, если его нет.
   Legacy origin можно оставить для отката: это не зависимость прямого входа. Для применения
   service env нужен согласованный по активным задачам restart; повторно проверить revision/health после запуска. Само изменение URL launcher restart не требует.
4. До смены origin сохранить нужные browser drafts через доступные экспорт/копирование формы.
   `localStorage` (история Prompter, незавершённые формы, язык и другие browser settings) привязан к
   origin и автоматически не переезжает. Не переносить consent или cookies вручную между origins.
5. На прямом входе проверить `/api/health`, счётчики и чтение существующих проектов, Canvas, Production,
   library, скачивание файла и видео Range/206. Проверить Origin и `x-sp-client` запросом, который
   заведомо отклоняется валидацией без записи. В браузере открыть существующие материалы и AI dialog;
   LLM/media generation для smoke не запускать. Если меняется runtime/storage, дополнительно проверить
   ZIP и отдельный временный Flow: сохранение → reload → удаление только тестового Flow.
6. Каждый пользователь открывает прямой origin и при необходимости заново подключает свой AI через
   «Подключить AI». Host-only session прежнего gateway на новом hostname недоступна. Shared материалы
   сохраняются; personal account profiles не копировать и не привязывать к чужому браузеру. Проверка
   `/api/chatgpt` подтверждает только состояние подключения; inference выполняет владелец отдельно.
7. Обновить игнорируемую `.seedance-remote.json` на прямой HTTPS origin и проверить обычный launcher.
   Прямой вход работает независимо от доступности legacy gateway. Если legacy project отключён
   платформой, не включать его ради cutover; такое состояние не гарантирует постоянного отключения.
   Legacy origin можно оставить в allowlist для отката. Ручное отключение/удаление gateway и отмена
   общего тарифа — отдельные операции: смена входа одной студии их не выполняет.
8. Если direct smoke не проходит, исправить причину. Прежний launcher URL можно использовать для
   отката, только если legacy вход доступен; отключённый платформой gateway ради этого не включать.
   При откате адреса не восстанавливать data из старого backup: хранилище то же.

## Перенос данных на другой сервер и проверка

- Перед cutover проверить отсутствие активных jobs/Production. Остановить исходный процесс,
  сделать локальный архив, затем rsync всей data без `.server.lock`. Проверить SHA-256 каждого
  файла **до первого запуска** на сервере. Два scheduler с одной копией задач не запускать.
- Проверить anonymous 200 при открытом входе либо anonymous 401 / authenticated 200 при защищённом на прямом входе; CSP/Origin и mutation header;
  список/файлы библиотеки, Canvas, проекты, Production, ZIP; restart сохраняет данные.
- Длинные JSON POST используют `Prefer: respond-async`: запрос выполняется один раз, клиент
  опрашивает `/api/requests/:id`, отмена передаётся исходному signal. После рестарта polling
  получает 410, автоматического повторного POST нет. Стоимость и согласия проверяет исходный route.
  Результаты транспорта временные (30 минут); генерации и Production сохраняют собственное состояние.
- Бесплатный `npm run doctor`/прямой `node src/server/doctor.ts` проверяет CLI и login, но не inference.
  Это локальный CLI, а не подключения пользователей студии. Свой статус — `/api/chatgpt`; чужие аккаунты через API не перечисляются. Платные проверки выполняет владелец. Наличие подключения не доказывает доступность модели или остаток квоты.
- Большие binary uploads и downloads проходят прямым HTTP через Caddy; лимит Netlify proxy
  к этому пути больше не относится. Действующие лимиты приложения и timeouts сервера/клиента остаются;
  крупный файл проверять отдельно, успешный `/api/health` его передачу не подтверждает.
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
`{"url":"https://studio.example.com"}` (заменить на прямой HTTPS origin приватно). Обычный launcher открывает общую студию;
`npm run start:offline`/`npm run dev` и отдельный SP_DATA_DIR сохраняют локальную разработку.
Адреса конкретного VPS и инструкции доступа хранятся в приватном operational runbook вне Git.

## Подключения ChatGPT

Sessions сохраняются между рестартами. Cookie __Host-, HttpOnly, Secure, SameSite=Strict, 180 дней,
host-only; на другом hostname прежняя cookie недоступна, в том числе при переходе с Netlify
на прямой VPS. Закрытие диалога не отменяет вход,
«Отменить вход» отменяет. Код живёт до 15 минут. Выход удаляет собственные credentials;
текущий вызов сначала нужно завершить/отменить. Reconnect создаёт новый profile: старый этап
не переключится на другой аккаунт без явного retry. Дубликат requestId не меняет binding.
Старые серии читаются как прежде. Вызовы одного profile последовательны, без гонки refresh.

Бэкап accounts хранить отдельно с доступом 0600, как пароль; не в library, экспорте или Git.
Потеря accounts требует повторного входа, общая data остаётся. Откат на release без этой функции
требует остановки новых LLM: старый код использовал глобальный home, без отдельных подключений.

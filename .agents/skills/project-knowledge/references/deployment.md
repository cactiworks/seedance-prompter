# Запуск

Последнее обновление runtime: 20.11.2026, release `602ba59` с отдельными нодами идеи и AI-промптинга.
Direct VPS smoke проверен без inference/media submit; 858 исходных data files сохранены после
cutover, backup проверен на Mac, предыдущий release `872affe` оставлен для отката. После запуска
в существующий Flow возвращена прежняя одобренная идея без нового approval/AI-вызова; остальные
данные и история сохранены. Проверки и границы — `docs/BACKLOG.md`.

Рабочая студия с 19.10.2026 находится на Linux VPS. По решению 06.11.2026 основной вход —
прямой HTTPS через Caddy на существующем VPS; cutover проверен 06.11.2026. Netlify остаётся
legacy gateway для отката, Vercel не внедрён. Direct UI/assets/API, чтение shared data, download,
Range и Origin/CSRF checks проверены; launcher переключён. VPS runtime/config/data не менялись,
restart не выполнялся. Legacy project отключён платформой из-за team credits; его не включали,
не удаляли и общий тариф не отменяли. Это не блокер прямого входа. Результаты — `deploy/README.md`
и `docs/BACKLOG.md`. Реальный AI login/inference проверяет владелец. По решению владельца
19.10.2026 browser auth отключён, Node слушает
`127.0.0.1`. Локальный режим Mac сохранён для разработки/отката. Код обновляется через публичный GitHub remote
по решению владельца (рамки — [project.md](project.md)); `data/` и кэш Figma в git не входят.

## Запуск

- `npm start` или `Запустить.command` — wrapper проверяет обновление до старта, ставит зависимости
  через `npm ci` при смене lock-файла, запускает сервер на 4317. При живом `/api/health` открывает
  вкладку и явно требует остановить прежний сервер для обновления; файлы на лету не меняет.
- Первый раз после `git clone`: `npm run sync:replica` на втором Mac, `npm run sync:source` только
  на основном. Команды включают `.githooks` и записывают роль в локальный Git config.
  В source Codex завершает задачу commit; post-commit публикует чистую main после pre-commit/check.
  Никаких фоновых commit, force-push/reset/stash. В replica обновление требует чистую main и ff-only.
  ZIP не обновляется. Полная инструкция и перенос данных — README.
- `npm run sync:status` сверяет HEAD с GitHub; `npm run publish` повторяет неудачный push на основном
  Mac. `npm run update` обновляет остановленную копию. `npm run start:offline` запускает локальную
  версию без обновления. `npm run dev` — разработка с watch, без auto-update.
- **Второй экземпляр** для проверки, пока основной занят:
  `SP_SKIP_UPDATE=1 SP_PORT=4318 SP_DATA_DIR=<временная папка> SP_NO_OPEN=1 npm start`. Своя папка данных обязательна —
  иначе два фоновых опроса делят одни задачи генерации.

## Что нужно на машине

- Node 26 (стоит на Mac владельца; `engines` в `package.json` пускает ≥24), npm.
- Для локального single-user режима — актуальный `codex` с входом в ChatGPT (`codex login status`; разлогинило — `codex login`). При
  исчерпанном лимите работает всё, кроме агентов.
- ffmpeg и ffprobe из Homebrew (`brew install ffmpeg`) — кадр из видео, обрезка, размер, замер секунд.
- Ключи KIE и Higgsfield в Keychain — см. [patterns.md](patterns.md).

## Проверки моста

12.10.2026 CLI обновлён с 0.147.0 до 0.162.1: старую версию сервер модели `gpt-6-astra`
отклонял с требованием upgrade. На 0.162.1 проверены strict-config/JSONL через локальный fixture,
живые роли Production, перевод правки и vision. Обновление: `npm install -g @openai/codex@latest`;
версия: `codex --version`. Ошибка `CLI_OUTDATED` теперь прямо подсказывает это действие.

`npm run doctor` по умолчанию бесплатный: проверяет версию Codex CLI, `codex login status`,
allowlist окружения и количество отключённых local skills. LLM не вызывается. Содержимое профиля,
правил и skills не читается; при обнаружении skills учитываются только пути/metadata.

`npm run doctor -- --live` запускается владельцем и расходует квоту: проверяет схему ответа,
latency и самоотчёт модели о доступном контексте/инструментах. Самоотчёт не доказывает изоляцию.
В stdout выводятся только счётчики, исходный ответ модели в docs/logs не записывается. Старый
`data/logs/doctor/` относится к прежним проверкам и не используется новым doctor. Проверку стоит
повторять после обновлений CLI; бесплатная диагностика не подменяет оценку реальных outputs.

Модель по умолчанию — `gpt-6-astra`. Приоритет настроек: переменная конкретной роли
(`SP_FIELDS_MODEL`, `SP_WRITER_MODEL`, `SP_CRITIC_MODEL`, `SP_VISION_MODEL`, `SP_PROMPTER_MODEL`,
`SP_EDIT_MODEL`) → общая `SP_LLM_MODEL` → умолчание. Используй доступный в твоём аккаунте model ID;
названия `sonnet` и `opus` больше не имеют специального значения. Качество и латентность после
смены модели проверяются отдельным запуском владельца.

## Данные

Всё в `data/` (раскладка — [architecture.md](architecture.md)). Бэкап — копия папки. Локальные логи — stdout; на VPS — persistent journald с лимитом размера.


С 14.10.2026 dataDir защищён `.server.lock` с PID и token: живой второй сервер получает отказ,
мёртвая блокировка восстанавливается при следующем старте. Для QA обязателен отдельный SP_DATA_DIR.
Повреждённая/незавершённая блокировка не удаляется вслепую: сначала проверить запущенные процессы.


## Linux / прямой HTTPS

Полная инструкция, topology, env, direct cutover, проверки и ограничения — `deploy/README.md`.
Caddy остаётся единственным reverse proxy к Node; exact direct origin включается в
`SP_PUBLIC_ORIGINS`, upstream Host остаётся loopback. Прежний origin остаётся в allowlist для отката,
но не требуется прямому входу. Legacy Netlify template сохранён для отката,
добавление Vercel и перенос backend в serverless не выполняются.
Только код и шаблоны deploy публичны. Конкретные IP, доступы, backup и operational runbook —
в приватной папке владельца вне Git. На сервере Node 26.12.0, Codex CLI 0.162.1, ffmpeg и zip;
`SP_SERVE_STATIC=1` отдаёт готовый dist, systemd запускает приложение без Vite/auto-update.
На Mac игнорируемый `.seedance-remote.json` направляет обычный launcher на прямой HTTPS origin общей студии;
start:offline, dev и явные SP_PORT/SP_DATA_DIR остаются локальными. Старую data нельзя
синхронизировать поверх серверной после cutover. Смена только входного URL не переносит data
и не требует второго scheduler. Cookies и localStorage привязаны к hostname/origin: browser drafts
сохраняются до смены адреса, на новом origin каждый пользователь при необходимости подключает свой
AI заново. Consent и private account profiles между браузерами/origins не копируются.


С 20.10.2026 в server mode каждый браузер подключает собственный ChatGPT кнопкой в header
и официальным device login. `SP_ACCOUNTS_DIR` хранит sessions/profiles вне общей data;
по умолчанию это соседний с data каталог `accounts`. Глобальный CODEX_HOME не используется.
На localhost без SP_ACCOUNTS_DIR прежний CLI-вход сохранён. Вход, backup и откат описаны в
`deploy/README.md`. `doctor` проверяет локальный CLI; `/api/chatgpt` — собственный browser profile.


25.10.2026: в header «Подключить AI» есть API key + Base URL рядом с ChatGPT. Разрешённые внешние
Responses endpoints — `SP_LLM_API_BASE_URLS`, comma-separated точные HTTPS URLs без query/credentials.
Указывать полный API path (обычно `/v1`), endpoint сохраняется для своего browser profile. OpenAI
`https://api.openai.com/v1` доступен по умолчанию. Конкретные адреса/private credentials вне Git.
Ключ импортируется официальным CLI через stdin, поэтому поддержка `--with-api-key` обязательна.
Accounts backup содержит секреты и хранится отдельно от shared data с ограниченными правами.
На локальном single-user без SP_ACCOUNTS_DIR кнопка по-прежнему скрыта; server mode использует личные profiles.

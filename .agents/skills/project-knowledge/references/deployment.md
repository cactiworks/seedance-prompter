# Запуск

Рабочая студия с 19.10.2026 находится на Linux VPS за HTTPS; по решению владельца 19.10.2026 browser auth отключён, Node слушает
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
- Актуальный `codex` с входом в ChatGPT (`codex login status`; разлогинило — `codex login`). При
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


## Linux / Netlify

Полная инструкция, topology, env, cutover, проверки и ограничения — `deploy/README.md`.
Только код и шаблоны deploy публичны. Конкретные IP, доступы, backup и operational runbook —
в приватной папке владельца вне Git. На сервере Node 26.12.0, Codex CLI 0.162.1, ffmpeg и zip;
`SP_SERVE_STATIC=1` отдаёт готовый dist, systemd запускает приложение без Vite/auto-update.
На Mac игнорируемый `.seedance-remote.json` направляет обычный launcher в общую студию;
start:offline, dev и явные SP_PORT/SP_DATA_DIR остаются локальными. Старую data нельзя
синхронизировать поверх серверной после cutover.

# Архитектура

## Процесс и стек

Один процесс Node 26, без сборки для запуска: `src/server/index.ts` поднимает http-сервер, где
`/api/*` — Hono, остальное — Vite в middleware mode. Нет `dist` и расхождения dev/prod. Порт 4317
(`SP_PORT`), только `127.0.0.1`. TypeScript исполняется нативно; правила синтаксиса — в
[patterns.md](patterns.md).

- **web** — React 19, Zustand, Radix (`radix-ui`), Zod; свой UI-kit на токенах Lab UI в CSS Modules,
  шрифты Geist и Geist Mono самохостом. Tailwind и shadcn не используются.
- **server** — Hono; хранилище файлами; LLM-мост; клиенты KIE и Higgsfield; ffmpeg/ffprobe.
- **core** — чистый TS без Node API, React и DOM: работает в браузере (живой предпросмотр и линтер) и
  в Vitest.
- Внешние бинари — ffmpeg и ffprobe из Homebrew, не npm-зависимости.

## Слои и где что живёт

`src/core` ← `src/server` и `src/web`.

| часть | где |
|---|---|
| модель данных проекта (Zod) | `src/core/model/` |
| компилятор кадра → блоки промпта | `src/core/compile/`; детерминированная сборка кадра (компиляция, плейсхолдеры, блокеры, линтер) — `src/core/pipeline.ts`; что устарело и как применить ответ агента — `src/core/compose.ts` |
| линтер, правила | `src/core/lint/` (пороги и словари — [patterns.md](patterns.md)) |
| сборка промптов агентов и проверка ответов | `src/core/llm/build*.ts`, `src/core/llm/validate.ts` |
| попытки, diff, симптомы | `src/core/attempts/` |
| разбор готового промпта | `src/core/import/` |
| canvas: план запуска, Seedance-нода, шаблоны | `src/core/canvas/` |
| каталог моделей, рецепты, калибровка, правка по области | `src/core/gen/` |
| Production: модель/план и переходы / Codex roles, runtime и API / интерфейс | `src/core/production/`, `src/server/production/`, `src/web/production/` |
| HTTP API и проверки запросов | `src/server/app.ts` |
| файловые хранилища | `src/server/storage/` |
| `codex exec` и задачи агентов | `src/server/llm/` |
| провайдеры генерации, фоновый опрос, ffmpeg, замер картинок | `src/server/gen/` |
| ключи из Keychain | `src/server/secrets.ts` |
| проверки LLM-моста | `src/server/doctor.ts` |
| экраны | `src/web/{shell,features,studio,gen,prompter,canvas,library,calibration}`, галерея UI-kit — `/ui` |
| клиентское состояние и вызовы агентов | `src/web/store.ts` (ролики, «Собрать промпт»: агент полей → писатель через `/api/llm/*`), `src/web/gen/genStore.ts`, `src/web/canvas/canvasStore.ts` |

## Знания как данные

Код не знает правил гайда и моделей — он исполняет packs.

- `packs/cinema-doc/` — дословные формулировки гайда (`verbatim.json` + `verbatim.lock.json` с sha256),
  шесть комплектов камеры (`kits/`), режимы съёмки и монтаж (`shooting.json`), диалекты ссылок и
  формата (`dialects.json`), словари, параметры линтера, симптомы, системные промпты агентов «Кадров» и
  few-shot (`prompts/`).
- `packs/prompter/` — системный промпт промптера (`system.md`), маршрутизация «задача → модель»
  (`routing.md`), карточка на каждую модель (`models/<провайдер>--<модель>.md`, у каждого правила метка
  уверенности [official] [vendor] [arena] [single] [owner] [provisional]), рецепты правки
  (`fixes.json`), шаблоны (`templates.json`), наборы калибровки (`calibration.json`).

## Данные на диске

Всё — файлы в `data/` (вне git; путь меняется `SP_DATA_DIR`). Запись атомарная: временный файл +
rename. Конкурентные изменения проекта, Canvas, sessions, favorites и folders проходят очередь
на файл вокруг всей операции read/validate/write. Второй сервер с тем же dataDir не запускается.

| что | где |
|---|---|
| ролики «Кадров» | `data/projects/<slug>/` (`project.json` с `rev`, файлы рефов, `backups/` — до 20 копий, не чаще раза в 10 минут) |
| черновик Seedance-ноды canvas | `data/projects/cv-<id>/` (в списках роликов не показывается) |
| задачи генерации | `data/jobs/<id>.json` |
| готовые файлы | `data/library/<yyyy-mm>/<id>.<ext>` + `<id>.json` (промпт, модель, параметры, рефы, taskId, кредиты, sha256, исходная ссылка) |
| flows canvas | `data/canvas/` |
| серии Production (Codex, photos / mock) | `data/production-mock/<id>.json`: rev, preparation/calls, scenePlan, promptPlan, shots, artifacts, approvals и events; fixtures в `src/web/public/production-mock/` |
| сессии студии | `data/studio/` |
| свои мудборды, оценки, правила владельца | `data/moodboards.json`, `data/verdicts.json`, `data/learnings.json` |
| выгрузка для монтажа | `data/exports/<дата время>/` |
| Soul ID персонажи | `data/characters/<id>.json`: фото по upload IDs, referenceId, версия, статус, ошибка и ключ дедупликации отправки |
| картинки студии, загруженные с диска | `data/uploads/<id>.<ext>` (сами не удаляются) |
| исторические сырые выводы прежнего doctor | `data/logs/doctor/` (новый doctor сюда не пишет) |

## Модель кадра (главное)

- `Project` — общий мир ролика, формат `aspectRatio`, диалект ссылок, референсы, герои, предметы,
  кадры, непрерывность.
- `Shot` — длительность `durationSec` (4–30), панель референсов (порядок = нумерация), режим съёмки и
  монтаж, отрезки, попытки. Финал — часть текста отрезков, его проверяет линтер.
- Последствия между кадрами — `Project.states` (`originShotId`, `resolvedInShotId`), действующие на кадр —
  `activeStates`.
- `Segment` — отрезок времени = абзац промпта, 1:1; в склейках — «Шот», может открываться на кадре
  раскадровки (`frameRef`).
- `TextUnit` — русский ввод + английский текст с плейсхолдерами и происхождением; английское помнит, из
  какого русского сделано (`enFor`). Хранится `TextUnit`; блоки промпта производные, не хранятся.

Полная схема — `src/core/model/`.

## Агенты

Все вызываются через `codex exec` по клику и проходят проверку ответа (см. [patterns.md](patterns.md)).
Маршруты — `/api/llm/*` в `src/server/app.ts`. Роли и их схемы ответа независимы от LLM-провайдера;
Codex получает только подготовленный input задачи. KIE и Higgsfield не исполняют этих агентов.

Модель по умолчанию у всех — `gpt-6-astra`. Переменная конкретной роли имеет приоритет над общей
`SP_LLM_MODEL`; автоматического fallback на Claude или другую модель нет.

| агент | что делает | промпт | настройка модели |
|---|---|---|---|
| поля | русские тезисы → фрагменты под слоты компилятора | `prompts/fields.system.md` | `SP_FIELDS_MODEL` |
| планировщик | синопсис → отрезки, реплики вынимаются детерминированно | `prompts/planner.system.md` | `SP_WRITER_MODEL` |
| писатель | абзацы отрезков с плейсхолдерами, петля с линтером | `prompts/writer.system.md` | `SP_WRITER_MODEL` |
| фиксер | минимальная правка по симптомам попытки | `prompts/writer.system.md` + бриф фиксера | `SP_WRITER_MODEL` |
| критик | пересказ «что увидит зритель» + находки с цитатами + мнение | `prompts/critic.system.md` | `SP_CRITIC_MODEL` |
| vision | разбор референса: люди, текст, задник, одежда, риски | — | `SP_VISION_MODEL` |
| промптер | идея → промпт под модель | `packs/prompter/system.md` + routing + карточки | `SP_PROMPTER_MODEL` |
| инструкция правки | русское описание правки → английский для Seedream | — | `SP_EDIT_MODEL` |

Пути промптов «Кадров» — от `packs/cinema-doc/`. Effort остаётся настройкой задачи: low для
небольших преобразований, medium для планирования, письма и критики; настройки этого чата
в продуктовые вызовы автоматически не переносятся.

## LLM-мост

Локальный subprocess `codex exec` за интерфейсом `LlmRequest` / `LlmResult`, вход через ChatGPT.
Адаптер в `src/server/llm/codexCli/` задаёт изоляцию, формирует запрос с JSON Schema, передаёт
подготовленные изображения, разбирает события и переводит ошибки CLI в ошибки приложения.

Нужные границы: отдельная временная рабочая папка, разрешённое окружение без API-ключей,
игнорирование пользовательской конфигурации и правил, ephemeral-вызов без продолжения личного
чата. Одного `--ignore-user-config` недостаточно: найденные local `SKILL.md` явно отключаются через
`skills.config`; обнаружение использует пути/metadata без чтения содержимого skills. Агент получает инструкции своей роли и подготовленные данные задачи; личный профиль,
Obsidian, консилиум и пользовательские правила не загружаются как инструкции. Запуск ограничен
read-only sandbox и запретом запросов approval. Live-проверка — CLI 0.162.1 (12.10.2026). Нет полного аналога
`--tools ""`: некоторые встроенные инструменты могут оставаться доступны. Адаптер отклоняет
инструментальные события и их результат; это проверка фактического вывода, а не гарантия отсутствия
инструментов в CLI. `item.error` — диагностическая запись, а не инструмент: сама по себе не
останавливает процесс и не отменяет успешный `turn.completed`. Терминальные `error`/`turn.failed`,
ненулевой exit и отсутствие завершения отклоняются с причиной. Диагностика ограничена по длине,
Bearer/API-key/JWT и URL убираются перед показом. Точный набор флагов — в `codexCli/args.ts`,
проверки — в тестах моста. Требование upgrade от модели классифицируется как `CLI_OUTDATED`;
несколько terminal events сохраняют исходную причину, даже если последний сообщает общий сбой.
Бесплатный `doctor` проверяет локальную конфигурацию без inference; live-зонд вызывается
отдельно владельцем (см. [deployment.md](deployment.md)).
Старые события `system/init`, `StructuredOutput` и
`apiKeySource` относятся к Claude-мосту из `docs/day0/`, к Codex они не применяются.

## API

Группы маршрутов в `src/server/app.ts`: `projects`, `llm/*` (fields, plan, write, critique, fix,
vision, prompter, region-edit), `gen/*` (jobs, measure, status, styles), `library/*` (файлы, папки,
избранное, кадр, обрезка, импорт, выгрузка), `canvas/flows`, `studio/sessions`, `media/resize`,
`moodboards`, `verdicts`, `learnings`, `calibration`, `prompter/*`, `uploads`, `packs/:id`, `health`,
`production` (список/создание), `production/:id`, `production/:id/actions`, `production/:id/manifest`.

Каждый `/api/*` проверяет `Host` и `Origin`, мутирующие запросы — ещё и заголовок `x-sp-client`: иначе
любая страница в браузере владельца могла бы тратить квоту и читать референсы.

## Production: Codex и фото

`ProductionRuntime` исполняет чистые переходы `core/production/engine.ts`, записывая состояние
атомарно. Общая очередь сериализует ticks и actions, `rev` защищает от конкурентного изменения.
В demo приёмка проверяет точные ID текущих версий с пройденным mock QC. Каждая ветвь стоит на своём
milestone до действия владельца; выбранная часть может идти дальше независимо от остальных.
Правка создаёт новую photo-версию и сбрасывает актуальные approvals/потомков этой ветви;
прежние артефакты и записи приёмки остаются в истории. Manifest содержит только актуальные
принятые фото и прошедшие финальный QC клипы.

`mode: mock` сохраняет demo; `mode: photos` блокирует mock-переходы и требует Codex-план; `planningMode: codex` отдельно включает две роли через
`server/production/agents.ts` и существующий `runCodex` (injected `Runner` в тестах). Модель:
`SP_PRODUCTION_MODEL` → `SP_LLM_MODEL` → default. Схемы `core/production/plan.ts` ограничивают
1–8 кадров; код назначает shot IDs, проверяет цитаты сценария, покрытие ID и длину/refs prompts.
Роли получают только JSON творческого задания. Обычно два вызова, до четырёх при schema/semantic
repair; ошибки провайдера не повторяются автоматически. ScenePlan сохраняется до prompts;
невалидный результат не подменяется mock-планом. Calls/usage сохраняются; расход при сбое без отчёта
помечен неизвестным. Медиа-tick не запускает LLM.

`retryPreparation` проверяет rev и отсутствие активной попытки, сохраняет scenePlan и повторяет
незавершённую роль. Пауза abort-ит вызов и защищает состояние от позднего ответа; resume не запускает
Codex. Async `start()` помечает незавершённые вызовы interrupted, без автоповтора после рестарта.
Runtime принимает общий `GenRuntime`; секреты не читает. `server/production/photos.ts` хранит
intent перед submit, связывает GenJob по id/tag, импортирует только saved/readable image в artifacts.
Порядок: master T2I → каждый кадр I2I с master image_url; Soul ID отдельным custom_reference_id.
Quote включает master+n; POST `/:id/photos/start` принимает rev, UUID requestId, confirmUsd,
refsConsent=true. Числовой гейт проверяется до job creation; повтор UUID идемпотентен. Выбор Soul ID
проверяется HTTP-слоем и фиксируется после начала фото. Ошибка останавливает будущие отправки.
Pause/restart требуют новой цены на pending; известные задачи продолжают poll/download.
Retry `/:id/photos/retry` только для download_failed/POLL_TIMEOUT. Unknown не пересоздаётся.
Artifact qc=review — ручной milestone; принятие переводит ветвь в ready, видео/upscale запрещены.
`/:id/fork-photos` копирует готовый Codex-план без LLM/artifacts/approvals, с дедупликацией requestId.
Старые планы без masterPrompt используют establishing-вариант первого prompt. Новые требуют поле.
Старые mock-серии без planningMode остаются mock. Zustand хранит выбор в sessionStorage, draft в
localStorage. Fixtures `scripts/production/build-mock-media.mjs` используются только в demo.


## Soul ID (14.10.2026)

`server/production/{soulId,characters,characterRoutes}.ts` — отдельный adapter и хранилище.
`GET /api/characters` читает локальные записи; `POST /api/characters` создаёт v2 только после
валидации фото, consent и подтверждения неизвестной стоимости. Одна requestId сохраняется до
внешней отправки и не создаёт повторную задачу при двойном запросе. Upload и create идут в фоне;
рестарт не возобновляет POST. Потерянный ответ создания сохраняется как unknown, без автоповтора.
`POST /api/characters/refresh` только читает статусы; `/sync` постранично читает список аккаунта.
Проверка статуса выполняется раз в 5 секунд открытым Production при наличии незавершённых задач;
обучение уже созданного Soul ID продолжается у Higgsfield и без открытой страницы.

`POST /api/production/:id/character` проверяет rev и completed/v2 перед записью выбора; то же
проверяется при создании серии с characterId. Смена персонажа не меняет mock-артефакты и approvals.
В manifest попадает snapshot, фотографии и provider-ссылки туда не добавляются. Импорт без
подтверждённой версии отображается, но не выбирается как Soul 2 v2.

## Устойчивость Canvas и Production (14.10.2026)

Canvas хранит `rev`, последовательные snapshots автосейва и локальный черновик
`sp-canvas-draft:<id>`. Переход ждёт сохранения, включая правки во время загрузки следующего холста;
409 сохраняет черновик и предлагает отдельную копию. Удаление переносит JSON в `canvas/trash/`,
восстановление — POST `/api/canvas/flows/:id/restore`.
Граф проверяется на уникальные IDs, endpoints, совместимые порты, циклы и положительный zoom.
`freshness.ts` помечает зависимые результаты устаревшими после изменения входа/настроек;
async result привязан к flow/node/input fingerprint. Старые файлы остаются в библиотеке.
Нужные Canvas job IDs загружаются отдельно от последних 300 jobs ленты. Общий endpoint также
возвращает все более старые active/attention jobs, чтобы незаконченная задача не исчезала из UI.

`App` держит observer `genStore.watchJobs` независимо от маршрута. Чтения jobs/library объединяются,
сетевые ошибки сохраняются отдельно и вызывают повтор GET; POST никогда не повторяется автоматически.
Merge по `updatedAt` не откатывает новое состояние устаревшим ответом; локальное удаление инвалидирует
идущий GET. Удаление pending задачи в другой вкладке учитывается при следующем snapshot. Общая
`GenerationStatus` ведёт к «Материалам» с очищенными фильтрами; Library показывает jobs и файлы.
`core/gen/versions.ts` обходит цепочку первого media-reference, связывая исходник, правки и правки
правок; незаконченные/ошибочные jobs видны в MediaPreview, saved остаётся до получения metadata.

Production принимает `requestId` создания: повтор одного input возвращает прежнюю серию без нового
Codex-запуска, другой input с тем же ID получает conflict. `StoredRunSchema` проверяет сохранённую
запись до scheduler; повреждённые записи пропускаются, остаются на диске и отображаются в диагностике
`/api/production/issues`. UI объединяет snapshots по ID/rev, отдельно хранит сетевые ошибки,
периодически обновляет все серии и сохраняет незавершённый brief в localStorage.

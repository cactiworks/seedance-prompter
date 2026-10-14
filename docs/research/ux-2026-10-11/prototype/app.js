/* Standalone interaction prototype. No network requests, no provider or LLM calls. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { view: 'canvas', selected: 'edit', variant: 'B', editSource: 'B', editDraft: false, version: 2, helper: 'simple', start: 0.5, end: 4.5, playing: false, tour: -1, edits: 0, exported: false, brief: 'Реклама нового аромата FORM. Вертикальный ролик 9:16, 5 секунд. Спокойствие, тактильность, мягкий свет. Флакон и маркировку сохранить.' };
let toastTimer;
let returnFocus;
const inspector = $('#inspector-content');

function art(scene, extra = '') {
  const warm = ['B', 'edit', 'video'].includes(scene);
  const scale = scene === 'edit' || scene === 'video' ? .74 : scene === 'C' ? .87 : 1;
  const bg = scene === 'A' ? '#ececef' : scene === 'C' ? '#dddcd6' : warm ? '#dedbd2' : '#eeede9';
  return `<div class="art ${extra}" data-scene="${scene}" style="background:${bg}" role="img" aria-label="Условная иллюстрация флакона FORM, ${scene}"><svg viewBox="0 0 180 220" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect width="180" height="220" fill="${bg}"/>${warm ? '<ellipse cx="150" cy="195" rx="94" ry="43" fill="#c5c1b5"/><path d="M0 173L61 156L106 186L83 220H0Z" fill="#d2cdc0"/>' : ''}${scene === 'C' ? '<path d="M0 0H40L180 160V220H154Z" fill="#f1f0ea"/>' : ''}<ellipse cx="92" cy="191" rx="42" ry="8" fill="#666357" opacity=".12"/><g transform="translate(${90 * (1 - scale)} ${188 * (1 - scale)}) scale(${scale})"><rect x="64" y="59" width="52" height="27" rx="3" fill="#292a27"/><rect x="59" y="83" width="62" height="108" rx="9" fill="#b3ac94"/><rect x="62" y="86" width="56" height="102" rx="7" fill="#d9d1b8"/><rect x="65" y="91" width="6" height="91" rx="3" fill="#eeeadb" opacity=".7"/><rect x="66" y="118" width="48" height="49" rx="1" fill="#f6f4ed"/><text x="90" y="136" text-anchor="middle" fill="#393930" font-family="Arial,sans-serif" font-size="10" letter-spacing="2">FORM</text><path d="M76 143H104" stroke="#bebbad" stroke-width=".5"/><text x="90" y="155" text-anchor="middle" fill="#747063" font-family="Arial,sans-serif" font-size="5" letter-spacing="1.2">STILLNESS</text><rect x="68" y="61" width="3" height="22" fill="#5a5a50" opacity=".6"/></g></svg>${scene === 'video' ? '<span class="play-symbol">▷</span>' : ''}</div>`;
}

$$('[data-art]').forEach(el => { const scene = el.dataset.art; const classes = [...el.classList].filter(x => x !== 'art').join(' '); el.outerHTML = art(scene, classes); });
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function saved() { $('#save-state').textContent = 'Изменения в этой вкладке'; }
function meta(source, kind = 'Иллюстрация') { return `<div class="meta"><div class="meta-row"><span>Происхождение</span><span>${source}</span></div><div class="meta-row"><span>Тип demo</span><span>${kind}</span></div><button class="text-button" data-command="history">Посмотреть историю версий →</button></div>`; }
function head(type, title, description) { return `<div class="inspector-eyebrow">${type}</div><div class="inspector-heading"><h2>${title}</h2><span class="tag">Демо</span></div><p class="subtitle">${description}</p>`; }
function select(id, scroll = false) {
  state.selected = id;
  $$('.node').forEach(node => node.classList.toggle('selected', node.id === `node-${id}`));
  renderInspector();
  if (scroll && innerWidth <= 650) $('#inspector').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderInspector() {
  const view = state.selected;
  if (view === 'brief') {
    inspector.innerHTML = head('КОНТЕКСТ ПРОЕКТА', 'Бриф клиента', 'Общий контекст для всех веток Canvas.') + `<label class="field-label" for="brief-input">Что нужно получить</label><textarea class="field" id="brief-input" rows="8"></textarea><div class="choice-row"><div>Результат<small>Рекламный ролик для соцсетей</small></div><span class="tag">9:16</span></div><button class="button primary full" data-command="save-brief">Сохранить бриф в демо</button><div class="notice">Бриф доступен рядом с работой. Референсы и ограничения не нужно переносить между отдельными студиями.</div>`;
    $('#brief-input').value = state.brief;
  } else if (view === 'reference') {
    inspector.innerHTML = head('ИСХОДНЫЙ МАТЕРИАЛ', 'Флакон FORM', 'Роль reference объясняет, что сохранить, а что можно менять.') + `<div class="inspector-preview">${art('reference')}</div><label class="field-label" for="ref-role">Использовать как</label><select class="field" id="ref-role"><option>Продукт — сохранить форму и этикетку</option><option>Стиль — взять только настроение</option><option>Композиция — повторить расположение</option></select><div class="notice" id="role-note">Намерение: сохранить флакон, пропорции и маркировку. Роль не гарантирует точность — проверь результат. Фон и свет можно исследовать.</div><button class="button primary full" data-command="variants">Посмотреть варианты →</button>` + meta('Исходный reference');
  } else if (view === 'variants') {
    inspector.innerHTML = head('ВЫБОР НАПРАВЛЕНИЯ', `Вариант ${state.variant}`, 'Выбери один вариант для правки. Остальные остаются на Canvas.') + `<div class="inspector-preview">${art(state.variant)}</div><div class="segmented" aria-label="Выбрать вариант">${['A', 'B', 'C'].map(v => `<button class="${v === state.variant ? 'active' : ''}" data-variant="${v}" aria-pressed="${v === state.variant}">${v} · ${ { A: 'Студия', B: 'Камень', C: 'Свет' }[v]}</button>`).join('')}</div><div class="notice">Сравни детали продукта, читаемость этикетки и свободное место под текст клиента.</div><button class="button primary full" data-command="edit">Править выбранный вариант →</button>` + meta('Reference → три варианта');
  } else if (view === 'edit') {
    inspector.innerHTML = head('ВЫБРАННОЕ ИЗОБРАЖЕНИЕ', state.editDraft ? `Правка варианта ${state.variant}` : `Правка · v${state.version}`, `Вариант ${state.editDraft ? state.variant : state.editSource} → новая версия. Исходник остаётся доступен.`) + `<div class="inspector-preview">${art(state.editDraft ? state.variant : 'edit')}</div><label class="field-label" for="edit-request">Что меняем</label><textarea id="edit-request" class="field">Добавить воздуха вокруг флакона. Убрать лишний камень справа.</textarea><label class="checkbox-row"><input id="preserve-product" type="checkbox" checked>Сохранить продукт, этикетку и общий свет</label><button class="button primary full" data-command="apply-edit">Показать правку в демо</button><div class="notice">Локальная правка создаёт новую версию. В демо используется готовая иллюстрация; текст не отправляется в модель.</div>` + meta(`Вариант ${state.editDraft ? state.variant : state.editSource} · v1`) + `<button class="next-action text-button" data-command="video"><span>Следующий шаг: оживить кадр</span><span>→</span></button>`;
  } else if (view === 'video') {
    inspector.innerHTML = head('ИЗОБРАЖЕНИЕ → ВИДЕО', 'Оживить кадр', `Входной кадр: правка v${state.version}. Reference уже на месте.`) + `<div class="inspector-preview"><button class="node" data-command="play" aria-label="Запустить условную анимацию">${art('video')}</button></div><div id="prompt-helper"><div class="section-title">Seedance · помощник движения</div><div class="segmented" aria-label="Режим помощника"><button data-helper="simple" class="${state.helper === 'simple' ? 'active' : ''}">Просто</button><button data-helper="advanced" class="${state.helper === 'advanced' ? 'active' : ''}">По сцене</button></div>${state.helper === 'simple' ? '<label class="field-label" for="motion">Что должно двигаться</label><textarea class="field" id="motion">Камера медленно приближается к флакону. Свет мягко скользит по стеклу. Флакон неподвижен.</textarea>' : '<label class="field-label" for="camera">Камера · 0–5 сек</label><select class="field" id="camera"><option>Плавный наезд</option><option>Статичная камера</option><option>Медленная орбита</option></select><label class="field-label" for="subject-motion">Действие объекта</label><input class="field" id="subject-motion" value="Флакон неподвижен"><label class="field-label" for="scene-lock">Сохранить в сцене</label><input class="field" id="scene-lock" value="Продукт, этикетку, композицию">'}</div><div class="choice-row"><div>Длительность<small>Вертикальный кадр · 9:16</small></div><strong>5 сек</strong></div><div class="notice blue">Пример оценки: <strong>$0.40 / 5 сек</strong><br>Условные числа, не тариф KIE или Higgsfield. В продукте: актуальная цена до подтверждения.</div><div class="notice">Перед выдачей проверь продукт, логотип и текст по всем кадрам. Новая генерация — новый дубль: движение и камера могут измениться.</div><button class="button primary full" data-command="simulate-video">Показать движение в демо · бесплатно</button><button class="next-action text-button" data-command="export"><span>Обрезать и подготовить выдачу</span><span>→</span></button>`;
  } else if (view === 'export') {
    inspector.innerHTML = head('ПЕРЕДАЧА КЛИЕНТУ', 'Финальная версия', 'Выбери отрезок и проверь параметры перед выдачей.') + `<div class="inspector-preview">${art('video')}</div><div id="trim-controls"><div class="section-title">Обрезка · демо</div><div class="timeline"><div class="timeline-selection" id="trim-selection"></div></div><label class="range-row" for="trim-start"><span>Начало</span><output id="start-value"></output></label><input class="trim-range" type="range" id="trim-start" min="0" max="4.5" step="0.1" value="${state.start}"><label class="range-row" for="trim-end"><span>Конец</span><output id="end-value"></output></label><input class="trim-range" type="range" id="trim-end" min="0.5" max="5" step="0.1" value="${state.end}"><div class="meta-row"><span>Длительность</span><strong id="duration-value"></strong></div></div><div class="choice-row"><div>Ролик для клиента<small>Предлагаемый результат: MP4 · 1080 × 1920</small></div></div><button class="button full" disabled>Экспорт MP4 недоступен в демо</button><button class="button primary full" data-command="download">Скачать план демо · JSON</button><div class="notice">В этом прототипе нет реального видео. JSON содержит только выбранный вариант, версии и параметры обрезки. Это не media export.</div>`;
    updateTrim();
  } else if (view === 'history') {
    inspector.innerHTML = head('ПРОИСХОЖДЕНИЕ', 'История версии', 'Вернуться к предыдущему результату можно без потери дальнейших веток.') + `<div class="asset-list"><button data-select="reference">${art('reference')}<div>Исходный продукт<small>Reference · сохранён</small></div></button><button data-select="variants">${art(state.editSource)}<div>Вариант ${state.editSource} · v1<small>До правки клиента</small></div></button><button data-select="edit">${art('edit')}<div>Правка · v${state.version}<small>Больше воздуха</small></div></button><button data-select="video">${art('video')}<div>Движение · demo<small>Из правки v${state.version}</small></div></button></div><div class="notice">Каждый результат хранит связь с исходником, действие, настройки и версию. В рабочем продукте здесь также будут provider, стоимость и задача.</div>`;
  } else if (view === 'jobs') {
    inspector.innerHTML = head('ФОНОВЫЕ ЗАДАЧИ', 'Очередь пуста', 'В демо нет отправок в API.') + `<div class="notice">Предлагаемое поведение: после запуска можно продолжать работать на Canvas. Готовый результат вернётся в свою ветку.</div><div class="section-title">Если генерация прервалась</div><p class="subtitle">Сначала проверить статус у provider. Повторный платный запуск — отдельное действие с новой оценкой.</p><button class="button full" data-command="return">Вернуться к материалу</button>`;
  }
}

function chooseVariant(value) {
  state.variant = value;
  $$('[data-variant]').forEach(button => { const chosen = button.dataset.variant === value; button.classList.toggle('chosen', chosen); button.classList.toggle('active', chosen && button.closest('.segmented') !== null); button.setAttribute('aria-pressed', String(chosen)); const i = $('i', button); if (i) i.remove(); if (chosen && $('span', button)) $('span', button).insertAdjacentHTML('beforeend', '<i>✓</i>'); });
  $('#chosen-label').textContent = `Выбран вариант ${value}`;
  select('variants'); saved();
}
function applyEdit() {
  state.edits += 1; state.version += 1; state.editSource = state.editDraft ? state.variant : state.editSource; state.editDraft = false;
  $('#edit-lineage').textContent = `Из варианта ${state.editSource} · оригинал сохранён`;
  $('#node-edit .node-top>span:first-child').textContent = `Изображение · v${state.version}`;
  $('#node-video .node-bottom .quiet').textContent = `Из правки v${state.version} · демонстрация`;
  select('edit'); saved(); toast(`Demo-версия v${state.version} добавлена. Вариант ${state.editSource} сохранён.`);
}
function updateTrim() {
  if (!$('#start-value')) return;
  $('#start-value').textContent = `${state.start.toFixed(1)} сек`;
  $('#end-value').textContent = `${state.end.toFixed(1)} сек`;
  $('#duration-value').textContent = `${(state.end - state.start).toFixed(1)} сек`;
  $('#trim-selection').style.left = `${state.start / 5 * 100}%`;
  $('#trim-selection').style.width = `${(state.end - state.start) / 5 * 100}%`;
}
function playDemo() { state.playing = !state.playing; $$('.art[data-scene="video"]').forEach(el => el.classList.toggle('playing', state.playing)); toast(state.playing ? 'Условная CSS-анимация: демонстрация движения камеры.' : 'Демонстрация остановлена.'); }
function downloadPlan() {
  const data = { type: 'ux-prototype-demo-plan', disclaimer: 'Не видео. Генерация не выполнялась. Иллюстрации условные.', project: 'FORM — Stillness', selectedVariant: state.variant, editedFromVariant: state.editSource, imageVersion: state.version, proposedVideo: { aspectRatio: '9:16', originalSeconds: 5, trimStart: state.start, trimEnd: state.end, trimmedSeconds: Number((state.end - state.start).toFixed(1)), actualMedia: null } };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'form-demo-plan.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); state.exported = true; toast('Скачан план демо в JSON. Реального видео в нём нет.');
}

const secondary = {
  projects: () => `<div class="eyebrow">МОЯ СТУДИЯ</div><h1>Проекты</h1><p>Один проект объединяет бриф, Canvas, материалы и финальную выдачу по одной задаче клиента.</p><div class="secondary-card"><h2>FORM · Запуск аромата</h2><p>Демо рекламного проекта. Продуктовый reference → варианты → правка клиента → движение → выдача.</p><button class="button primary" data-view="canvas">Открыть Canvas →</button></div>`,
  assets: () => `<div class="eyebrow">FORM · МАТЕРИАЛЫ</div><h1>Всё, что есть в проекте</h1><p>Это представление материалов того же проекта. Открытие результата возвращает к его контексту на Canvas.</p><div class="secondary-card"><div class="asset-list"><button data-open="reference">${art('reference')}<div>Флакон FORM<small>Исходный reference · продукт</small></div></button>${['A','B','C'].map(v => `<button data-open="variants" data-open-variant="${v}">${art(v)}<div>Вариант ${v}<small>Изображение · поиск направления</small></div></button>`).join('')}<button data-open="edit">${art('edit')}<div>Правка v${state.version}<small>Из варианта ${state.editSource}</small></div></button><button data-open="video">${art('video')}<div>Движение<small>Demo preview · не реальное видео</small></div></button></div></div>`,
  exports: () => `<div class="eyebrow">FORM · ВЫДАЧА</div><h1>Экспорты</h1><p>Здесь находятся финальные файлы, подготовленные для передачи клиенту.</p><div class="secondary-card"><div class="empty-symbol">↗</div><h2>Media export ещё нет</h2><p>Прототип показывает путь до выдачи, но не создаёт MP4. ${state.exported ? 'Ты уже скачал JSON-план демо — это настройки, а не видео.' : 'Можно проверить обрезку и скачать только JSON-план демо.'}</p><button class="button primary" data-open="export">Подготовить выдачу →</button></div>`,
  connections: () => `<div class="eyebrow">НАСТРОЙКИ СТУДИИ</div><h1>Подключения</h1><p>Provider и ключи настраиваются один раз. На Canvas креатор выбирает результат и действие.</p><div class="secondary-card"><h2>Provider API</h2><table class="data-table"><tbody><tr><td>KIE</td><td>Демо · не подключён</td></tr><tr><td>Higgsfield</td><td>Демо · не подключён</td></tr></tbody></table><p>Этот черновик не читает ключи и не принимает секреты. В рабочем продукте перед платным запуском показываются provider, модель, параметры и актуальная стоимость. Отправка материала в LLM-помощник и отправка provider для генерации требуют отдельных понятных действий.</p><button class="button" data-view="canvas">Вернуться на Canvas</button></div>`,
  help: () => `<div class="eyebrow">ПОМОЩЬ</div><h1>Первый результат на Canvas</h1><p>Не нужно запоминать все инструменты. Пройди один короткий рекламный проект: от контекста до выдачи.</p><div class="secondary-card"><h2>Onboarding · 7 шагов</h2><p>Демо можно пропустить, закрыть в любой момент и запустить снова. Существующие материалы не удаляются.</p><button class="button primary" data-command="tour">Пройти onboarding →</button><div class="notice">Управление: нажимай карточки на Canvas, выбирай варианты, меняй настройки справа. Escape закрывает тур. Изменения живут только в текущей вкладке.</div></div>`
};
function setView(view) {
  state.view = view;
  $$('.nav-item[data-view]').forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#canvas-view').hidden = view !== 'canvas'; $('#secondary-view').hidden = view === 'canvas';
  if (view !== 'canvas') $('#secondary-view').innerHTML = secondary[view]();
  if (view === 'canvas') { requestAnimationFrame(drawConnections); renderInspector(); }
}
function drawConnections() {
  if (state.view !== 'canvas') return;
  const root = $('#flow').getBoundingClientRect();
  const pairs = [['reference','variants'],['variants','edit'],['edit','video'],['video','export']];
  $('#connections g').innerHTML = pairs.map(([from,to]) => {
    const a = $(`#node-${from}`).getBoundingClientRect(), b = $(`#node-${to}`).getBoundingClientRect();
    if (from === 'video') { const x = a.left + a.width / 2 - root.left; return `<path class="connector" d="M${x} ${a.bottom-root.top}V${b.top-root.top-4}"/>`; }
    const x1 = a.right-root.left, y1 = a.top+a.height/2-root.top, x2 = b.left-root.left-4, y2 = b.top+b.height/2-root.top;
    return `<path class="connector" d="M${x1} ${y1}C${x1+18} ${y1} ${x2-18} ${y2} ${x2} ${y2}"/>`;
  }).join('');
}

const steps = [
  { target: '#project-header', title: 'Один проект. Весь цикл.', body: 'Начни с задачи клиента. Бриф, исходники, варианты и финальная выдача остаются в одном проекте. Canvas — его основное рабочее пространство.', select: 'brief' },
  { target: '#node-reference', title: 'Объясни роль reference', body: 'Этот флакон — продукт, который нужно сохранить. Стиль и композиция задаются отдельно. Роль описывает намерение: точность продукта и этикетки всё равно нужно проверить после генерации.', select: 'reference' },
  { target: '#node-variants', title: 'Выбери направление', body: 'Сначала сравни несколько идей. Выбранный вариант станет основой следующего шага; остальные останутся рядом для возврата или обсуждения с клиентом.', select: 'variants', action: 'Выбрать вариант B в демо', run: () => { chooseVariant('B'); toast('Вариант B выбран для следующего шага.'); } },
  { target: '#node-edit', title: 'Правка — новая версия', body: 'Клиент попросил больше воздуха. Меняем выбранный кадр, сохраняя продукт и оригинал. История справа показывает, из чего получилась каждая версия.', select: 'edit', action: 'Показать новую demo-версию', run: applyEdit },
  { target: '#prompt-helper', title: 'Оживи выбранный кадр', body: 'Seedance появляется в момент, когда нужен: прямо рядом с изображением. Опиши движение простыми словами или раскрой сцену. Цена показывается до запуска. Новый дубль может изменить камеру и движение; детали продукта нужно проверить. Здесь только demo.', select: 'video', action: 'Показать условное движение', run: playDemo },
  { target: '#trim-controls', title: 'Подготовь выдачу', body: 'Оставь нужный отрезок, проверь формат и финальную версию. Ползунки обрезки работают как симуляция. Демо скачивает JSON-план; реального MP4 здесь нет.', select: 'export', action: 'Пример: оставить 1.0–4.0 сек', run: () => { state.start = 1; state.end = 4; renderInspector(); toast('Демо-отрезок: 3 секунды.'); } },
  { target: '#nav-assets', title: 'Теперь можно работать самому', body: 'Материалы — библиотека того же проекта. История версий доступна у карточки, а фоновые задачи — сверху. Начни с клика по любому материалу. Тур всегда можно повторить из «Помощи».', select: 'edit' }
];
function startTour() { returnFocus = document.activeElement; setView('canvas'); state.tour = 0; $('#tour-layer').hidden = false; showStep(); }
function stopTour() { $$('.tour-target').forEach(el => el.classList.remove('tour-target')); state.tour = -1; $('#tour-layer').hidden = true; $('.app-shell').removeAttribute('inert'); const focusTarget = returnFocus?.isConnected && returnFocus.getClientRects().length && !returnFocus.closest('[hidden]') ? returnFocus : $('#tour-start'); focusTarget.focus({ preventScroll: true }); }
function showStep() {
  const step = steps[state.tour]; select(step.select);
  $('#tour-progress').textContent = `ПЕРВЫЙ РЕЗУЛЬТАТ · ${state.tour+1} ИЗ ${steps.length}`;
  $('#tour-title').textContent = step.title; $('#tour-body').textContent = step.body;
  $('#tour-dots').innerHTML = steps.map((_, i) => `<i class="${i <= state.tour ? 'done' : ''}"></i>`).join('');
  $('#tour-back').disabled = state.tour === 0; $('#tour-next').textContent = state.tour === steps.length-1 ? 'Работать самому →' : 'Дальше →';
  $('#tour-action').hidden = !step.action; $('#tour-action').textContent = step.action || '';
  $('.app-shell').setAttribute('inert', '');
  $$('.tour-target').forEach(el => el.classList.remove('tour-target'));
  const target = $(step.target); target.classList.add('tour-target'); target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
  if (innerWidth <= 650 && !target.closest('.sidebar')) {
    const availableBottom = $('.sidebar').getBoundingClientRect().top - 20;
    const bounds = target.getBoundingClientRect();
    if (bounds.bottom > availableBottom) scrollBy({ top: bounds.bottom - availableBottom, behavior: 'instant' });
    else if (bounds.top < 14) scrollBy({ top: bounds.top - 14, behavior: 'instant' });
  }
  requestAnimationFrame(() => { positionTour(); $('#tour-card').focus({ preventScroll: true }); });
}
function positionTour() {
  if (state.tour < 0) return;
  const step = steps[state.tour], target = $(step.target); if (!target) return;
  const rect = target.getBoundingClientRect(), spot = $('#spotlight'), card = $('#tour-card');
  const top = Math.max(7, rect.top-6), left = Math.max(7, rect.left-6);
  Object.assign(spot.style, { top:`${top}px`,left:`${left}px`,width:`${Math.min(rect.width+12,innerWidth-left-7)}px`,height:`${Math.min(rect.height+12,innerHeight-top-7)}px` });
  const width = card.offsetWidth, height = card.offsetHeight; let x, y;
  if (innerWidth <= 650) { x = (innerWidth-width)/2; y = rect.top > height+30 ? rect.top-height-17 : Math.min(rect.bottom+18, innerHeight-height-70); }
  else if (rect.right+width+28 < innerWidth) { x = rect.right+20; y = Math.max(116,rect.top); }
  else if (rect.left-width-28 > 0) { x = rect.left-width-20; y = Math.max(116,rect.top); }
  else { x = Math.min(rect.left+24,innerWidth-width-20); y = rect.bottom+18; }
  x = Math.max(14,Math.min(x,innerWidth-width-14)); y = Math.max(14,Math.min(y,innerHeight-height-14));
  Object.assign(card.style,{left:`${x}px`,top:`${y}px`});
}

document.addEventListener('click', event => {
  const variant = event.target.closest('[data-variant]'); if (variant) { chooseVariant(variant.dataset.variant); return; }
  const helper = event.target.closest('[data-helper]'); if (helper) { state.helper = helper.dataset.helper; renderInspector(); return; }
  const selection = event.target.closest('[data-select]'); if (selection) { if (selection.dataset.select === 'edit') state.editDraft = false; select(selection.dataset.select,true); return; }
  const navigation = event.target.closest('[data-view]'); if (navigation) { setView(navigation.dataset.view); return; }
  const open = event.target.closest('[data-open]'); if (open) { setView('canvas'); if (open.dataset.openVariant) chooseVariant(open.dataset.openVariant); select(open.dataset.open,true); return; }
  const command = event.target.closest('[data-command]')?.dataset.command;
  if (command === 'save-brief') { state.brief = $('#brief-input').value; saved(); toast('Бриф обновлён в этой demo-вкладке.'); }
  else if (command === 'edit') { state.editDraft = true; select('edit',true); }
  else if (['variants','video','export','history'].includes(command)) select(command,true);
  else if (command === 'apply-edit') applyEdit();
  else if (command === 'play' || command === 'simulate-video') playDemo();
  else if (command === 'download') downloadPlan();
  else if (command === 'return') select('edit');
  else if (command === 'tour') startTour();
});
document.addEventListener('input', event => {
  if (event.target.id === 'trim-start') { state.start = Math.min(Number(event.target.value),state.end-.5); event.target.value = state.start; updateTrim(); saved(); }
  if (event.target.id === 'trim-end') { state.end = Math.max(Number(event.target.value),state.start+.5); event.target.value = state.end; updateTrim(); saved(); }
});
document.addEventListener('change', event => { if (event.target.id === 'ref-role') $('#role-note').textContent = ['Намерение: сохранить флакон, пропорции и маркировку. Роль не гарантирует точность — проверь результат. Фон и свет можно исследовать.','Используем цвет, свет и настроение. Форма продукта не берётся из этого reference.','Используем расположение и масштаб объектов. Стиль и продукт задаются отдельно.'][event.target.selectedIndex]; });
$('#tour-start').addEventListener('click',startTour);
$('#tour-close').addEventListener('click',stopTour);
$('#tour-back').addEventListener('click',() => { if (state.tour>0) { state.tour--;showStep(); } });
$('#tour-next').addEventListener('click',() => { if (state.tour === steps.length-1) { stopTour(); toast('Выбери карточку и попробуй действия справа.'); } else { state.tour++;showStep(); } });
$('#tour-action').addEventListener('click',() => { steps[state.tour].run?.(); requestAnimationFrame(positionTour); });
$('#try-alone').addEventListener('click',() => { $('#start-hint').hidden = true; toast('Нажми на любой материал. Onboarding доступен сверху и в «Помощи».'); });
$('#fit-canvas').addEventListener('click',() => { $('#canvas-scroll').scrollTo({left:0,behavior:'smooth'}); toast('Начало Canvas: бриф и исходный reference.'); });
$('#jobs-button').addEventListener('click',() => select('jobs',true));
$('.brand').addEventListener('click',event => { event.preventDefault();setView('canvas'); });
document.addEventListener('keydown',event => {
  if (state.tour<0) return;
  if (event.key==='Escape') { event.preventDefault();stopTour(); }
  if (event.key==='Tab') { const focusables = $$('button:not([disabled]):not([hidden])', $('#tour-card')); const first = focusables[0], last = focusables.at(-1); if (event.shiftKey && (document.activeElement===first || document.activeElement===$('#tour-card'))) { event.preventDefault();last.focus(); } else if (!event.shiftKey && document.activeElement===last) { event.preventDefault();first.focus(); } }
});
addEventListener('resize',() => { drawConnections();positionTour(); });
addEventListener('scroll',positionTour,{passive:true});
new ResizeObserver(drawConnections).observe($('#flow'));
renderInspector();
document.fonts.ready.then(drawConnections);

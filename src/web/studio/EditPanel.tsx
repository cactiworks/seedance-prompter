import { formatCost } from '../formatCost.ts';
import { ui } from '../language.ts';
import { studioFetch as fetch } from '../remoteFetch.ts';
import { useEffect, useRef, useState } from 'react';
import { choiceParams, fillFix, fixParams, type FixPack, type FixRecipe } from '../../core/gen/fixes.ts';
import { estimate, findModel, modelsOf, paramsFor, type GenModel } from '../../core/gen/models.ts';
import type { MediaItem, RefSource } from '../../core/model/media.ts';
import { submissionIssue } from '../../core/gen/jobStatus.ts';
import { hasRefsConsent, mediaUrl, thumbOf, uploadImage, useGen } from '../gen/genStore.ts';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './MediaPreview.module.css';

/** Модели, которыми можно править картинку: принимают референсы. */
const editModels = (): GenModel[] => modelsOf('image').filter((m) => m.refs.roles.includes('ref'));

let fixesCache: Promise<FixPack> | null = null;
/** Рецепты — данные pack, грузятся один раз за сессию страницы. */
function loadFixes(): Promise<FixPack> {
  fixesCache ??= fetch('/api/prompter/fixes').then(async (res) => {
    if (!res.ok) throw new Error('Рецепты починки не загрузились.');
    return (await res.json()) as FixPack;
  });
  return fixesCache;
}

const CUSTOM = 'custom';

/**
 * «Правка» в просмотре работы (этап 2): выбери, что не так, — рецепт сам подставит модель и формулировку правки;
 * «Своими словами» — прежняя правка по описанию. Запуск — только кнопкой с ценой, исходник уходит референсом.
 */
export type StageMode = 'view' | 'brush' | 'crop';

export function EditPanel({ item, mode, onMode }: { item: MediaItem; mode: StageMode; onMode: (mode: StageMode) => void }) {
  const { run, loadLibrary, library } = useGen();
  const brush = mode === 'brush';
  const [source, setSource] = useState<{ width: number; height: number } | null>(null);
  const [pack, setPack] = useState<FixPack | null>(null);
  const [recipeId, setRecipeId] = useState(CUSTOM);
  const [modelIndex, setModelIndex] = useState(0);
  const [customModel, setCustomModel] = useState(editModels()[0]?.id ?? '');
  const [resolution, setResolution] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [customText, setCustomText] = useState('');
  const [extra, setExtra] = useState<RefSource | null>(null);
  const [picking, setPicking] = useState(false);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<{ busy: boolean; messageRu: string | null }>({ busy: false, messageRu: null });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadFixes()
      .then(setPack)
      .catch((error: unknown) => setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Рецепты не загрузились.' }));
  }, []);
  // Размер исходника — цене апскейла (сервер перемеряет сам) и подписи «результат W × H».
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSource({ width: img.naturalWidth, height: img.naturalHeight });
    img.src = mediaUrl(item.id);
  }, [item.id]);

  const recipe: FixRecipe | undefined = pack?.recipes.find((r) => r.id === recipeId);
  const choice = recipe?.models[modelIndex] ?? recipe?.models[0];
  const model = findModel(recipe === undefined ? customModel : (choice?.modelId ?? ''));
  const fixed = { ...(choice?.params ?? {}), ...(recipe === undefined ? {} : choiceParams(recipe, values)) };
  const base = { ...item.params, ...(resolution !== '' ? { resolution } : {}), ...(source !== null ? { sourceSize: Math.max(source.width, source.height) } : {}) };
  const params = model === undefined ? {} : recipe === undefined ? paramsFor(model, base) : fixParams(model, base, fixed);
  const resolutionFree = model?.params.some((p) => p.key === 'resolution') === true && fixed.resolution === undefined;
  const factor = model?.id === 'kie/topaz-upscale' && source !== null ? Number(params.upscaleFactor) : null;
  const filled = recipe === undefined ? { prompt: customText.trim(), problems: customText.trim() === '' ? ['Опиши, что изменить.'] : [] } : fillFix(recipe, values);
  const needExtra = recipe?.extraRef != null && extra === null;
  const refCount = recipe?.extraRef != null ? 2 : 1;
  const cost = model === undefined ? null : estimate(model, params, 1, refCount);
  const needConsent = !hasRefsConsent() && !consent;
  const blocked = filled.problems.length > 0 || needExtra || needConsent || cost === null || state.busy;

  const pick = (id: string): void => {
    onMode('view');
    setRecipeId(id);
    setModelIndex(0);
    setValues({});
    setExtra(null);
    setPicking(false);
    setState({ busy: false, messageRu: null });
  };

  const start = async (): Promise<void> => {
    if (model === undefined || cost === null || blocked) return;
    setState({ busy: true, messageRu: null });
    try {
      const created = await run({
        modelId: model.id,
        prompt: filled.prompt,
        params,
        refs: [{ label: 'Правка работы', source: { type: 'media', mediaId: item.id }, role: 'ref' }, ...(extra !== null && recipe?.extraRef != null ? [{ label: recipe.extraRef.labelRu, source: extra, role: 'ref' as const }] : [])],
        count: 1,
        confirmCredits: cost.credits,
        refsConsent: true,
        sessionId: item.sessionId ?? undefined,
      });
      const issue = submissionIssue(created);
      setState({ busy: false, messageRu: issue ?? 'Задача добавлена в «Материалы». Её статус виден здесь, в задачах правки.' });
      if (issue === null) {
        setCustomText('');
        setValues({});
      }
      void loadLibrary();
    } catch (error) {
      setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Правка не запустилась.' });
    }
  };

  return (
    <div className={styles.panelBody}>
      <section className={styles.block}>
        <Text variant="caption" tone="tertiary" medium>
          {ui("ЧТО НЕ ТАК")}</Text>
        <div className={styles.fixChips}>
          <button type="button" className={`${styles.fixChip} ${brush ? styles.fixChipOn : ''}`} onClick={() => onMode('brush')} title={ui("Закрась кистью, что изменить, и напиши, что сделать")}>
            <Icon name="brush" size={0.875} /> {ui(" Кистью")}</button>
          {(pack?.recipes ?? [])
            .filter((r) => r.group === 'fix')
            .map((r) => (
              <button key={r.id} type="button" className={`${styles.fixChip} ${mode === 'view' && r.id === recipeId ? styles.fixChipOn : ''}`} onClick={() => pick(r.id)} title={r.whenRu}>
                {r.titleRu}
              </button>
            ))}
          <button type="button" className={`${styles.fixChip} ${mode === 'view' && recipeId === CUSTOM ? styles.fixChipOn : ''}`} onClick={() => pick(CUSTOM)}>
            {ui("Своими словами")}</button>
        </div>
        <Text variant="caption" tone="tertiary" medium>
          {ui("ИНСТРУМЕНТЫ")}</Text>
        <div className={styles.fixChips}>
          {(pack?.recipes ?? [])
            .filter((r) => r.group === 'tool')
            .map((r) => (
              <button key={r.id} type="button" className={`${styles.fixChip} ${mode === 'view' && r.id === recipeId ? styles.fixChipOn : ''}`} onClick={() => pick(r.id)} title={r.whenRu}>
                {r.titleRu}
              </button>
            ))}
          <button type="button" className={`${styles.fixChip} ${mode === 'crop' ? styles.fixChipOn : ''}`} onClick={() => onMode('crop')} title={ui("Обрезать рамкой — бесплатно, локально")}>
            {ui("Обрезать")}</button>
        </div>
      </section>

      {mode === 'crop' ? (
        <section className={styles.block}>
          <Text variant="label" medium>
            {ui("Обрезать · бесплатно")}</Text>
          <Text variant="caption" tone="secondary">
            {ui("Потяни рамку за углы или перетащи её целиком; формат — кнопками над картинкой. Обрезка делается на этом компьютере (ffmpeg), в провайдер ничего не уходит. Результат — новой версией, исходник не меняется.")}</Text>
        </section>
      ) : brush ? (
        <section className={styles.block}>
          <Text variant="label" medium>
            {ui("Кистью · Seedream 5 Pro")}</Text>
          <Text variant="caption" tone="secondary">
            {ui("Закрась на картинке, что изменить, и ниже напиши, что сделать, — по-русски, агент переведёт. Меняется только выделенное, остальное модель держит как есть.")}</Text>
          <Text variant="caption" tone="secondary">
            {ui("Модель получает не саму закраску, а рамки вокруг каждого пятна (формат интерактивной правки Seedream) — их видно пунктиром. Если в рамку попало два предмета, назови нужный: «кружку слева».")}</Text>
          <dl className={styles.facts}>
            {[
              ['B / E', ui("кисть / ластик")],
              [ui("[ и ]"), ui("размер кисти")],
              ['⌘Z / ⇧⌘Z', ui("отменить / вернуть")],
              ['Enter', ui("изменить")],
              ['Esc', ui("выйти из кисти")],
            ].map(([k, v]) => (
              <div key={k} className={styles.fact}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
      <section className={styles.block}>
        {recipe === undefined ? (
          <>
            <Text variant="caption" tone="secondary">
              {ui("Эта картинка уйдёт референсом, модель сделает новую версию по твоему описанию. Исходник не меняется.")}</Text>
            <select className={styles.select} value={customModel} onChange={(event) => setCustomModel(event.target.value)} aria-label={ui("Модель правки")}>
              {editModels().map((m) => (
                <option key={m.id} value={m.id}>
                  {ui(m.titleRu)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <Text variant="label" medium>
              {recipe.titleRu}
            </Text>
            <Text variant="caption" tone="secondary">
              {recipe.whenRu} {recipe.whyRu}
            </Text>
            {recipe.models.length > 1 && (
              <SegmentedControl<string>
                aria-label={ui("Модель правки")}
                size="s"
                value={String(modelIndex)}
                onChange={(v) => setModelIndex(Number(v))}
                options={recipe.models.map((m, i) => ({ value: String(i), label: findModel(m.modelId)?.titleRu ?? m.modelId, title: m.params.variant === 'sunburst' ? ui("Вариант Sunburst — тщательнее") : undefined }))}
              />
            )}
          </>
        )}

        {model !== undefined && resolutionFree && (
          <SegmentedControl<string>
            aria-label={ui("Разрешение")}
            size="s"
            value={String(params.resolution)}
            onChange={setResolution}
            options={(model.params.find((p) => p.key === 'resolution')?.options ?? []).map((o) => ({ value: o, label: o }))}
          />
        )}

        {recipe === undefined ? (
          <textarea className={styles.editText} rows={4} value={customText} onChange={(event) => setCustomText(event.target.value)} placeholder={ui("Опиши, как изменить: «сделай фон ночным, добавь неоновые отражения на асфальте»")} />
        ) : (
          recipe.fields.map((field) => {
            const options = field.options;
            if (options === undefined) {
              return (
                <label key={field.key} className={styles.fixField}>
                  <Text as="span" variant="caption" tone="secondary">
                    {field.labelRu}
                  </Text>
                  <input className={styles.fixInput} value={values[field.key] ?? ''} placeholder={field.placeholder} lang="ru" spellCheck onChange={(event) => setValues((v) => ({ ...v, [field.key]: event.target.value }))} />
                </label>
              );
            }
            const value = values[field.key] ?? options[0]?.value ?? '';
            return (
              <div key={field.key} className={styles.fixField}>
                <Text as="span" variant="caption" tone="secondary">
                  {field.labelRu}
                </Text>
                {options.length <= 3 ? (
                  <SegmentedControl<string> aria-label={field.labelRu} size="s" value={value} onChange={(next) => setValues((v) => ({ ...v, [field.key]: next }))} options={options.map((o) => ({ value: o.value, label: o.labelRu }))} />
                ) : (
                  <div className={styles.fixChips}>
                    {options.map((o) => (
                      <button key={o.value} type="button" className={`${styles.fixChip} ${o.value === value ? styles.fixChipOn : ''}`} onClick={() => setValues((v) => ({ ...v, [field.key]: o.value }))}>
                        {o.labelRu}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}

        {factor !== null && source !== null && (
          <Text variant="caption" tone="secondary">
            {source.width} × {source.height} → {source.width * factor} × {source.height * factor} px
          </Text>
        )}

        {recipe?.extraRef != null && (
          <div className={styles.fixField}>
            <Text as="span" variant="caption" tone="secondary">
              {recipe.extraRef.labelRu} — {recipe.extraRef.hintRu}
            </Text>
            <div className={styles.fixExtra}>
              {extra !== null ? <img className={styles.fixThumb} src={thumbOf(extra)} alt="" /> : <span className={`${styles.fixThumb} lab-hatch`} />}
              <Button variant="border" size="xs" icon={<Icon name="upload" size={0.875} />} onClick={() => fileInput.current?.click()}>
                {ui("С диска")}</Button>
              <Button
                variant="border"
                size="xs"
                icon={<Icon name="images" size={0.875} />}
                onClick={() => {
                  void loadLibrary();
                  setPicking((v) => !v);
                }}
              >
                {ui("Из библиотеки")}</Button>
            </div>
            {picking && library.every((m) => m.kind !== 'image' || m.id === item.id) && (
              <Text variant="caption" tone="tertiary">
                {ui("В библиотеке нет других картинок — загрузи фото с диска.")}</Text>
            )}
            {picking && (
              <div className={styles.fixPick}>
                {library
                  .filter((m) => m.kind === 'image' && m.id !== item.id)
                  .slice(0, 24)
                  .map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setExtra({ type: 'media', mediaId: m.id });
                        setPicking(false);
                      }}
                    >
                      <img src={mediaUrl(m.id)} alt="" loading="lazy" />
                    </button>
                  ))}
              </div>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file !== undefined)
                  void uploadImage(file)
                    .then(setExtra)
                    .catch((error: unknown) => setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Картинка не загрузилась.' }));
              }}
            />
          </div>
        )}

        {recipe !== undefined && filled.prompt !== '' && (
          <details className={styles.fixDetails}>
            <summary>{ui("Промпт правки")}</summary>
            <Text variant="caption" className={styles.prompt}>
              {filled.prompt}
            </Text>
          </details>
        )}

        {needConsent && (
          <label className={styles.consent}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <Text variant="caption">{ui("Картинк")}{refCount > 1 ? ui("и уйдут") : ui("а уйдёт")} {ui(" в KIE, а оттуда исполнителю модели. Если на них лицо — оно тоже уйдёт.")}</Text>
          </label>
        )}
        <Button variant="dark" size="m" icon={<Icon name="sparkle" size={1} />} loading={state.busy} disabled={blocked} onClick={() => void start()}>
          {recipe === undefined ? ui("Изменить") : recipe.group === 'tool' ? ui("Применить") : ui("Починить")}
          {cost === null ? '' : ` · ${formatCost(cost)}`}
        </Button>
        {state.messageRu !== null && (
          <Text variant="caption" tone="secondary">
            {state.messageRu}
          </Text>
        )}
      </section>
      )}
      <Text variant="caption" tone="tertiary">
        {ui("Каждая правка — отдельная задача в «Материалах» и новая версия после завершения; исходник не меняется. Обрезка бесплатная и локальная, остальное — по цене на кнопке.")}</Text>
    </div>
  );
}

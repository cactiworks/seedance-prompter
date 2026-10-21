import { useEffect, useState } from 'react';
import { submissionIssue } from '../../core/gen/jobStatus.ts';
import { estimate, formatCost, paramsFor, upscaleModelOf } from '../../core/gen/models.ts';
import type { MediaItem } from '../../core/model/media.ts';
import { hasRefsConsent, measureInput, useGen, type MeasuredInput } from '../gen/genStore.ts';
import { Button, Icon, SegmentedControl, Text } from '../ui/components/index.ts';
import styles from './MediaPreview.module.css';

/**
 * «Правка» видео (решение 39): апскейл Topaz того же дубля — так утверждённый черновик Seedance (480p, решение 38)
 * доходит до финала. Перегенерация в 720p дала бы другой дубль: Seedance здесь не предоставляет seed. Длительность мерит сервер
 * тем же кодом, что при запуске, — цена на кнопке совпадает с гейтом.
 */
export function VideoEditPanel({ item }: { item: MediaItem }) {
  const { run, loadLibrary } = useGen();
  const model = upscaleModelOf('video');
  const [factor, setFactor] = useState('2');
  const [measured, setMeasured] = useState<MeasuredInput | null>(null);
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<{ busy: boolean; messageRu: string | null }>({ busy: false, messageRu: null });

  useEffect(() => {
    let live = true;
    measureInput(model.id, { type: 'media', mediaId: item.id })
      .then((m) => live && setMeasured(m))
      .catch((error: unknown) => live && setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Видео не измерилось.' }));
    return () => {
      live = false;
    };
  }, [item.id, model.id]);

  const params = paramsFor(model, { upscaleFactor: factor, ...(measured?.params ?? {}) });
  const cost = measured === null ? null : estimate(model, params, 1, 1);
  const info = measured?.info ?? null;
  const scale = Number(params.upscaleFactor);
  const needConsent = !hasRefsConsent() && !consent;
  const blocked = cost === null || needConsent || state.busy;

  const start = async (): Promise<void> => {
    if (cost === null || blocked) return;
    setState({ busy: true, messageRu: null });
    try {
      const created = await run({
        modelId: model.id,
        prompt: '',
        params,
        refs: [{ label: 'Апскейл видео', source: { type: 'media', mediaId: item.id }, role: 'ref' }],
        count: 1,
        confirmCredits: cost.credits,
        refsConsent: true,
        sessionId: item.sessionId ?? undefined,
      });
      setState({ busy: false, messageRu: submissionIssue(created) ?? 'Задача добавлена в «Материалы». Её статус виден здесь, в задачах правки.' });
      void loadLibrary();
    } catch (error) {
      setState({ busy: false, messageRu: error instanceof Error ? error.message : 'Апскейл не запустился.' });
    }
  };

  return (
    <div className={styles.panelBody}>
      <section className={styles.block}>
        <Text variant="label" medium>
          Апскейл · Topaz
        </Text>
        <Text variant="caption" tone="secondary">
          Тот же дубль, больше пикселей: Topaz не перерисовывает. Так утверждённый черновик доходит до финала — перегенерация
          дала бы другой дубль.
        </Text>
        <SegmentedControl<string>
          aria-label="Увеличение"
          size="s"
          value={factor}
          onChange={setFactor}
          options={[
            { value: '1', label: '1×', title: 'Только чистка: размер тот же' },
            { value: '2', label: '2×' },
            { value: '4', label: '4×' },
          ]}
        />
        {info !== null && info.width !== null && info.height !== null && (
          <Text variant="caption" tone="secondary">
            {`Исходник ${info.width}×${info.height}${info.durationSec === null ? '' : ` · ${info.durationSec.toFixed(1)} с`} → ${info.width * scale}×${info.height * scale}`}
          </Text>
        )}
        {needConsent && (
          <label className={styles.consent}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <Text variant="caption">Видео уйдёт в KIE, а оттуда исполнителю модели. Если в нём лицо — оно тоже уйдёт.</Text>
          </label>
        )}
        <Button variant="dark" size="m" icon={<Icon name="push" size={1} />} loading={state.busy} disabled={blocked} onClick={() => void start()}>
          Апскейл{cost === null ? '' : ` · ${formatCost(cost)}`}
        </Button>
        {state.messageRu !== null && (
          <Text variant="caption" tone="secondary">
            {state.messageRu}
          </Text>
        )}
      </section>
      <Text variant="caption" tone="tertiary">
        Результат — новая версия в ленте слева; исходник не меняется. Цена — по секундам видео: 2× — 8 кр/с, 4× — 14 кр/с.
      </Text>
    </div>
  );
}

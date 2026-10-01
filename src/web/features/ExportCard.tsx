import { useEffect, useState } from 'react';
import { estimate, findModel, formatCost, paramsFor, validateGen } from '../../core/gen/models.ts';
import type { Project, Shot } from '../../core/model/project.ts';
import type { ShotBuild } from '../../core/pipeline.ts';
import { hasRefsConsent, useGen } from '../gen/genStore.ts';
import { Button, Dialog, Icon, SegmentedControl, Switch, Tag, Text, type TagTone } from '../ui/components/index.ts';
import { useStore } from '../store.ts';
import { PromptText } from './PromptText.tsx';
import styles from './ExportCard.module.css';

const KIND_RU: Record<string, string> = { location: 'локация', character: 'герой', object: 'предмет', gear: 'техника', frame: 'кадр раскадровки', other: 'другое' };
const VERDICT: Record<string, { label: string; tone: TagTone }> = { ready: { label: 'критик: готов', tone: 'success' }, risky: { label: 'критик: с рисками', tone: 'warning' }, 'not-ready': { label: 'критик: не готов', tone: 'danger' } };

interface ExportCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project;
  shot: Shot;
  shotIndex: number;
  build: ShotBuild;
  durationSec: number;
  warnings: number;
}

interface GateItem {
  id: string;
  label: string;
  /** Пункт закрыт машиной — галочку ставить не нужно. */
  auto?: boolean;
}

/**
 * Одно окно с тем, что нужно перенести в Higgsfield, в порядке действий там: настройки → картинки по
 * номерам → промпт. Чек-лист закрывает то, чего линтер не видит; любая правка текста сбрасывает отметки.
 */
export function ExportCard({ open, onOpenChange, project, shot, shotIndex, build, durationSec, warnings }: ExportCardProps) {
  const store = useStore();
  const [gate, setGate] = useState<{ prompt: string; ticks: string[] }>({ prompt: '', ticks: [] });
  const [copied, setCopied] = useState<string | null>(null);
  const [savedN, setSavedN] = useState<{ prompt: string; n: number } | null>(null);

  const ticks = gate.prompt === build.prompt ? gate.ticks : [];
  const critique = shot.critique !== null && shot.critique.prompt === build.prompt ? shot.critique : null;
  const stale = shot.critique !== null && critique === null;
  const refByKey = new Map(project.refs.map((r) => [r.key, r]));
  const boundTo = (key: string): string[] => project.entities.filter((e) => e.refKey === key).map((e) => e.name);
  const refSyntax = (n: number): string => (project.dialect.refSyntax === 'higgsfield-chip' ? `<<<image_${n}>>>` : `@Image ${n}`);
  const exported = store.exportResult;
  const nextAttempt = Math.max(0, ...shot.attempts.map((a) => a.n)) + 1;

  const items: GateItem[] = [
    { id: 'settings', label: `В Higgsfield выставлено: Seedance 2.5, ${project.aspectRatio}, ${durationSec} с, Enhance Prompt выключен` },
    { id: 'panel', label: `Картинки загружены в этом порядке: ${shot.panel.map((_, i) => i + 1).join(' → ')}` },
    ...(warnings > 0 ? [{ id: 'warnings', label: `Предупреждения линтера (${warnings}) просмотрены` }] : []),
    critique === null
      ? { id: 'no-critic', label: stale ? 'Промпт менялся после проверки критиком — иду без перепроверки, осознанно' : 'Иду без итоговой проверки критиком — осознанно' }
      : critique.findings.length === 0
        ? { id: 'critic-clean', label: 'Критик прочитал этот текст и замечаний не нашёл', auto: true }
        : { id: 'critic', label: `Замечания критика (${critique.findings.length}) просмотрены` },
  ];
  const passed = items.every((item) => item.auto === true || ticks.includes(item.id));
  const tick = (id: string, on: boolean): void => setGate({ prompt: build.prompt, ticks: on ? [...ticks, id] : ticks.filter((x) => x !== id) });

  // Генерация отсюда (решения 21–23): Seedance 2.5 через KIE. Формат и длительность — из кадра, картинки — панель по
  // порядку (@ImageN). Настройки Higgsfield и порядок загрузки сервер выставляет сам — эти пункты чек-листа не нужны.
  const gen = useGen();
  const { loadStatus } = gen;
  const [genRes, setGenRes] = useState('720p');
  const [genAudio, setGenAudio] = useState(true);
  const [consent, setConsent] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [genState, setGenState] = useState<{ prompt: string; n: number; errorRu?: string } | null>(null);
  useEffect(() => {
    if (open) void loadStatus();
  }, [open, loadStatus]);
  const seedance = findModel('kie/seedance-2-5');
  const genParams = seedance === undefined ? {} : paramsFor(seedance, { resolution: genRes, aspectRatio: project.aspectRatio, durationSec, audio: genAudio });
  const panelFiles = shot.panel.map((key, i) => ({ n: i + 1, label: refByKey.get(key)?.label ?? key, file: refByKey.get(key)?.file ?? null }));
  const genCost = seedance === undefined ? null : estimate(seedance, genParams, 1, panelFiles.length);
  const apiPassed = items.filter((item) => item.id !== 'settings' && item.id !== 'panel').every((item) => item.auto === true || ticks.includes(item.id));
  const needConsent = panelFiles.length > 0 && !hasRefsConsent() && !consent;
  const genProblems = [
    ...(gen.status.kie !== undefined && !gen.status.kie.hasKey ? [`KIE: ${gen.status.kie.keyProblem ?? 'нет ключа'}.`] : []),
    ...panelFiles.filter((f) => f.file === null).map((f) => `У картинки ${f.n} панели нет файла.`),
    ...(seedance === undefined ? [] : validateGen(seedance, build.prompt, genParams, panelFiles.map(() => 'ref' as const))),
  ];
  const generate = async (): Promise<void> => {
    if (seedance === undefined || genCost === null) return;
    setGenBusy(true);
    const n = savedN?.prompt === build.prompt ? savedN.n : nextAttempt;
    if (savedN?.prompt !== build.prompt) {
      store.saveAttempt(build.prompt);
      setSavedN({ prompt: build.prompt, n });
    }
    try {
      const jobs = await gen.run({
        modelId: seedance.id,
        prompt: build.prompt,
        params: genParams,
        refs: panelFiles.map((f) => ({ label: f.label, source: { type: 'projectRef', slug: project.slug, file: f.file ?? '' }, role: 'ref' })),
        count: 1,
        confirmCredits: genCost.credits,
        refsConsent: panelFiles.length > 0 ? true : undefined,
        origin: { projectSlug: project.slug, shotId: shot.id, attemptN: n },
      });
      setGenState({ prompt: build.prompt, n, errorRu: jobs.find((j) => j.status === 'failed')?.error?.messageRu });
    } catch (error) {
      setGenState({ prompt: build.prompt, n, errorRu: error instanceof Error ? error.message : 'Генерация не запустилась.' });
    } finally {
      setGenBusy(false);
    }
  };
  const launched = genState?.prompt === build.prompt ? genState : null;

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(build.prompt);
    setCopied(build.prompt);
    setTimeout(() => setCopied((c) => (c === build.prompt ? null : c)), 2000);
  };
  const save = (): void => {
    store.saveAttempt(build.prompt);
    setSavedN({ prompt: build.prompt, n: nextAttempt });
  };

  const footer = (
    <>
      <Text variant="caption" tone="secondary" className={styles.footNote}>
        {!passed ? 'Отметь пункты чек-листа — кнопка откроется.' : savedN?.prompt === build.prompt ? `Попытка №${savedN.n} сохранена. После генерации разбери её в блоке «Попытки».` : 'После копирования сохрани попытку: будет с чем сравнить результат.'}
      </Text>
      <Button variant="secondary" size="m" icon={<Icon name="bookmark" />} disabled={!passed || savedN?.prompt === build.prompt} onClick={save}>
        Сохранить как попытку {nextAttempt}
      </Button>
      <Button variant="dark" size="m" icon={<Icon name={copied === build.prompt ? 'checkmark' : 'copy'} />} disabled={!passed} onClick={() => void copy()}>
        {copied === build.prompt ? 'Скопировано' : 'Скопировать промпт'}
      </Button>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="l" title={`Кадр ${shotIndex + 1} → генерация`} description="Сгенерировать здесь через KIE — или перенести в Higgsfield вручную по шагам ниже. Здесь ничего не редактируется." footer={footer}>
      <div className={styles.steps}>
        <section className={styles.step}>
          <StepHead n="▶" title="Сгенерировать здесь — Seedance 2.5 через KIE" />
          <div className={styles.row}>
            <SegmentedControl<string> aria-label="Разрешение" size="s" value={genRes} onChange={setGenRes} options={['480p', '720p', '1080p'].map((r) => ({ value: r, label: r }))} />
            <Switch checked={genAudio} onChange={setGenAudio} label="Звук" />
            <div className={styles.chips}>
              <Tag tone="neutral">{project.aspectRatio}</Tag>
              <Tag tone="neutral">{durationSec} с</Tag>
              <Tag tone="outline">картинок: {panelFiles.length} → @Image1…</Tag>
            </div>
          </div>
          {panelFiles.length > 0 && !hasRefsConsent() && (
            <label className={styles.gateItem}>
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <Text variant="label">Картинки панели ({panelFiles.length}) уйдут в KIE, а оттуда — исполнителю модели (fal). Если на них лицо, оно тоже уйдёт.</Text>
            </label>
          )}
          {genProblems.length > 0 && (
            <Text variant="caption" tone="secondary">
              {genProblems.join(' ')}
            </Text>
          )}
          {!apiPassed && (
            <Text variant="caption" tone="secondary">
              Отметь пункты чек-листа в шаге 5 (кроме настроек Higgsfield и порядка картинок — их сервер выставит сам).
            </Text>
          )}
          <div className={styles.row}>
            <Button variant="dark" size="m" icon={<Icon name="sparkle" />} loading={genBusy} disabled={!apiPassed || needConsent || genProblems.length > 0 || genCost === null} onClick={() => void generate()}>
              Сгенерировать{genCost === null ? '' : ` · ${formatCost(genCost)}`}
            </Button>
            {launched !== null && (
              <Text variant="label" tone={launched.errorRu === undefined ? 'secondary' : 'accent'}>
                {launched.errorRu ?? `Попытка №${launched.n} запущена — результат появится в блоке «Попытки» и в библиотеке, файл сразу на диске.`}
              </Text>
            )}
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="1" title="Настройки генерации" />
          <div className={styles.chips}>
            <Tag tone="neutral">Seedance 2.5</Tag>
            <Tag tone="neutral">{project.aspectRatio}</Tag>
            <Tag tone="neutral">{durationSec} с</Tag>
            <Tag tone="danger">Enhance Prompt: выкл</Tag>
            <Tag tone="outline">ссылки: {project.dialect.refSyntax === 'higgsfield-chip' ? '<<<image_N>>>' : '@Image N'}</Tag>
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="2" title={`Референсы — ${shot.panel.length} шт., загружать строго по номерам`} />
          <div className={styles.refs}>
            {shot.panel.map((key, i) => {
              const ref = refByKey.get(key);
              const file = ref?.file ?? null;
              const names = boundTo(key);
              return (
                <div key={key} className={styles.ref}>
                  <div className={`${styles.thumb} ${file === null ? 'lab-hatch' : ''}`}>
                    {file !== null && <img src={`/api/projects/${project.slug}/refs/${file}`} alt={ref?.label ?? key} />}
                    <span className={styles.number}>{i + 1}</span>
                  </div>
                  <Text variant="label" medium>{ref?.label ?? key}</Text>
                  <Text variant="caption" tone="secondary">{KIND_RU[ref?.kind ?? 'other']}{names.length > 0 ? ` · ${names.join(', ')}` : ''}</Text>
                  <Text variant="caption" tone="tertiary" mono>{refSyntax(i + 1)}</Text>
                  {file === null && <Tag tone="warning">нет файла</Tag>}
                </div>
              );
            })}
          </div>
          <div className={styles.row}>
            <Button variant="secondary" size="s" icon={<Icon name="folder" />} loading={store.exporting} disabled={shot.panel.length === 0} onClick={() => void store.exportPanel()}>
              Сложить в папку по номерам и открыть в Finder
            </Button>
            <Text variant="caption" tone="tertiary">Файлы получат имена 01-…, 02-… — в Finder они лежат в порядке панели, перетаскивай по одному сверху вниз.</Text>
          </div>
          {exported !== null && (
            <div className={`${styles.note} ${exported.errorRu !== undefined ? styles.noteBad : ''}`}>
              {exported.errorRu !== undefined ? (
                <Text variant="label">{exported.errorRu}</Text>
              ) : (
                <>
                  <Text variant="label" medium>Папка открыта: {exported.dir}</Text>
                  <Text variant="caption" tone="secondary" mono>{exported.files.map((f) => f.file ?? `${String(f.n).padStart(2, '0')} — нет файла (${f.key})`).join(' · ')}</Text>
                </>
              )}
            </div>
          )}
        </section>

        <section className={styles.step}>
          <StepHead n="3" title={`Промпт — ${build.metrics.chars} знаков`} />
          <div className={styles.prompt}>
            <PromptText text={build.prompt} />
          </div>
        </section>

        <section className={styles.step}>
          <StepHead n="4" title="Что должно получиться" />
          {critique === null ? (
            <div className={styles.row}>
              <Text variant="label" tone="secondary">{stale ? 'Критик читал прошлую версию текста — пересказ устарел.' : 'Критик этот текст не читал: пересказа «что увидит зритель» нет.'}</Text>
              <Button variant="soft" size="s" icon={<Icon name="eye" />} loading={store.critiquing} onClick={() => void store.critiqueShot()}>{store.critiquing ? 'Критик читает…' : stale ? 'Перепроверить' : 'Проверить критиком'}</Button>
            </div>
          ) : (
            <div className={styles.readback}>
              <div className={styles.chips}>
                <Tag tone={VERDICT[critique.verdict]?.tone ?? 'neutral'} dot>{VERDICT[critique.verdict]?.label ?? critique.verdict}</Tag>
                <Text variant="label" tone="secondary">{critique.summaryRu}</Text>
              </div>
              {critique.readback.map((r) => (
                <div key={r.paragraph} className={styles.readbackRow}>
                  <Text variant="caption" tone="tertiary" mono>{String(r.paragraph).padStart(2, '0')}</Text>
                  <div>
                    <Text variant="label">{r.seesRu}</Text>
                    {r.unsureRu !== undefined && r.unsureRu !== '' && <Text variant="caption" tone="secondary">Не уверен: {r.unsureRu}</Text>}
                  </div>
                </div>
              ))}
              {critique.findings.length > 0 && <Text variant="caption" tone="secondary">Замечания критика ({critique.findings.length}) — в окне «Проверка перед генерацией».</Text>}
            </div>
          )}
        </section>

        <section className={styles.step}>
          <StepHead n="5" title="Перед тем как нажать «Генерировать»" />
          <div className={styles.gate}>
            {items.map((item) => (
              <label key={item.id} className={styles.gateItem}>
                <input type="checkbox" checked={item.auto === true || ticks.includes(item.id)} disabled={item.auto === true} onChange={(event) => tick(item.id, event.target.checked)} />
                <Text variant="label" tone={item.auto === true ? 'secondary' : 'primary'}>{item.label}</Text>
              </label>
            ))}
            <Text variant="caption" tone="tertiary">Любая правка промпта сбрасывает отметки: галочки относятся к этому тексту.</Text>
          </div>
        </section>
      </div>
    </Dialog>
  );
}

function StepHead({ n, title }: { n: string; title: string }) {
  return (
    <header className={styles.stepHead}>
      <span className={styles.stepN}>{n}</span>
      <Text as="h3" variant="label" medium>{title}</Text>
    </header>
  );
}

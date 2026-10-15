import { useEffect, useState, type ReactNode } from 'react';
import { currentArtifact, runLabel, type ProductionRun } from '../../core/production/model.ts';
import { photoPrice, type PhotoQuote } from '../../core/production/photos.ts';
import { masterApproved, reviewedPhoto } from '../../core/production/review.ts';
import { boundPrompts } from '../../core/production/appearance.ts';
import { Button, Dialog, Tag, Text } from '../ui/components/index.ts';
import { CharacterField } from './CharacterField.tsx';
import { Preparation } from './Preparation.tsx';
import { useProduction } from './store.ts';
import { PhotoReview, PhotoVerdict } from './PhotoReview.tsx';
import styles from './Production.module.css';

const STATUS: Record<string, string> = { pending: 'Ожидает', submitting: 'Отправляется', queued: 'В очереди', running: 'Генерируется', downloading: 'Скачивается', saved: 'Сохранено', failed: 'Ошибка', unknown: 'Исход неизвестен', download_failed: 'Не скачано' };
function Section({ number, title, subtitle, status, children, milestone = false }: { number: string; title: string; subtitle: string; status: string; children: ReactNode; milestone?: boolean }) {
  return <section className={`${styles.stage} ${milestone ? `${styles.milestone} ${styles.stageActive}` : ''}`}>
    <div className={`${styles.stageHead} ${styles.staticStageHead}`}><span className={styles.stepNumber}>{number}</span><div className={styles.stageName}><Text as="h2" variant="title-s">{title}</Text><Text variant="caption" tone="secondary">{subtitle}</Text></div><Tag tone={milestone ? 'warning' : 'neutral'}>{status}</Tag></div>
    <div className={`${styles.stageBody} ${styles.liveStageBody}`}>{children}</div>
  </section>;
}
export function ReusePlan({ run }: { run: ProductionRun }) {
  const { photoCommand, busy } = useProduction();
  const [requestId] = useState(() => crypto.randomUUID());
  return <div className={styles.notice}><Text variant="label">Сохранённые сцена и prompts доступны для новой серии. Codex повторно не вызывается; стоимость фото подтвердишь отдельно.</Text><div><Button variant="border" disabled={busy} onClick={() => void photoCommand('fork-photos', { rev: run.rev, requestId })}>Реальные фото по этому плану</Button></div></div>;
}
function PhotoStart({ run }: { run: ProductionRun }) {
  const { photoCommand, busy } = useProduction();
  const [quote, setQuote] = useState<PhotoQuote | null>(null);
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => { setQuote(null); setConsent(false); }, [run.characterId, run.paused]);
  const blocked = run.photos?.items.some((i) => ['failed', 'unknown', 'download_failed'].includes(i.status));
  const active = run.photos?.status === 'running';
  const remaining = run.photos ? run.photos.items.filter((i) => i.status === 'pending').length : run.shots.length + 1;
  async function price(): Promise<void> {
    setLoading(true); setError(null); setConsent(false);
    try {
      const response = await fetch(`/api/production/${run.id}/photos/quote`);
      const data = await response.json() as PhotoQuote & { messageRu?: string };
      if (!response.ok) throw new Error(data.messageRu ?? 'Не удалось получить стоимость.');
      setQuote(data);
    } catch (failure) { setError(String(failure)); }
    finally { setLoading(false); }
  }
  if (!run.planned) return <Text variant="label" tone="secondary">Ожидает сцены и prompts от Codex.</Text>;
  if (run.masterReview?.status === 'complete' && !masterApproved(run)) return <Text role="alert">Master не принят критиком. Продолжение этой серии заблокировано; причина и повтор проверки доступны ниже.</Text>;
  if (active) return <Text variant="label" tone="secondary">Сначала фиксируется внешность по референсам, затем создаётся master. Кадры ждут положительного вердикта критика по master. Новые задачи отправляются последовательно. Пауза остановит будущие отправки; уже отправленная задача завершится.</Text>;
  if (blocked) return <div className={styles.notice}><Text variant="label">Генерация остановлена. Сохранённые фото доступны ниже. Платные задачи автоматически не повторяются; причина показана у конкретного кадра.</Text><Text variant="caption">Если исход отправки неизвестен, сначала сверь историю Higgsfield. Новая серия по этому плану оплачивается отдельно.</Text><ReusePlan run={run} /></div>;
  if (!remaining) return null;
  return <div className={styles.notice} data-photo-cost>
    <Text variant="label" medium>{run.photos ? 'Продолжить оставшиеся фото' : 'Готово к генерации реальных фото'}</Text>
    <Text variant="caption" tone="secondary">Soul 2 · 1080p · 9:16. Один опорный кадр задаёт сцену; каждый кадр плана получает его как reference. Phone и Cinematic меняют манеру съёмки. {run.character ? `Персонаж: ${run.character.name}.` : 'Soul ID не выбран — фото будут без привязки к твоему лицу.'}</Text>
    {error && <Text role="alert">{error}</Text>}
    {quote && <>
      <Text variant="title-s">Оценка {photoPrice(quote.usd)} · фото: {quote.count}</Text>
      <Text variant="label">Опорная сцена: {quote.sceneCount} · кадры: {quote.shotCount} · {photoPrice(quote.perImageUsd)} за изображение.</Text>
      <Text variant="caption" tone="secondary">Оценка из каталога приложения. Фактическое списание определяет Higgsfield. Видео, upscale и повторные генерации сюда не входят.</Text>
      <label className={styles.check}><input type="checkbox" checked={consent} disabled={busy || run.paused} onChange={(e) => setConsent(e.target.checked)} />Подтверждаю стоимость и передачу prompts, reference сцены и Soul ID в Higgsfield. Разрешаю передать до шести локальных фото Soul ID в Codex / OpenAI для фиксации внешности и привязки prompts; затем проверить master до остальных кадров и выполнить финальный отбор. До трёх вызовов из квоты ChatGPT; ошибки не повторяются автоматически.</label>
    </>}
    <div className={styles.gateActions}><Button variant="border" disabled={busy || run.paused} loading={loading} onClick={() => void price()}>{quote ? 'Обновить стоимость' : 'Рассчитать стоимость фото'}</Button>
      {quote && <Button variant="primary" disabled={!consent || busy || run.paused} loading={busy} onClick={() => void photoCommand('photos/start', { rev: quote.rev, requestId, confirmUsd: quote.usd, refsConsent: true, reviewConsent: true, masterGateConsent: true }).then((ok) => { if (ok) { setQuote(null); setConsent(false); setRequestId(crypto.randomUUID()); } })}>Создать фото · {photoPrice(quote.usd)}</Button>}
    </div>
  </div>;
}
export function PhotoRunView({ run }: { run: ProductionRun }) {
  const { act, photoCommand, busy, setCharacter, setDraft, newForm } = useProduction();
  const [inspect, setInspect] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[] | null>(null);
  const artifact = currentArtifact(run, inspect);
  const master = currentArtifact(run, run.photos?.masterArtifactId ?? null);
  const eligible = run.shots.filter((s) => s.step === 'photoReview' && s.photoId && reviewedPhoto(run, s.photoId)).map((s) => s.photoId!);
  const recommended = eligible.filter((id) => reviewedPhoto(run, id)?.verdict === 'keep');
  const selection = (selected ?? recommended).filter((id) => eligible.includes(id));
  const withIssues = selection.filter((id) => reviewedPhoto(run, id)?.verdict !== 'keep').length;
  const accepted = run.shots.filter((s) => s.acceptedPhotoId).length;
  const appearance = run.appearance;
  const saved = run.photos?.items.filter((i) => i.mediaId).length ?? 0;
  return <>
    <header className={styles.header}><div><div className={styles.eyebrow}><Tag tone="outline">Codex → Soul 2</Tag><Text variant="caption" tone="secondary">Реальные фотографии</Text></div><Text as="h1" variant="title-m">{run.title}</Text></div><div className={styles.headerActions}><Tag dot>{runLabel(run)}</Tag>{run.photos?.status !== 'complete' && <Button variant="border" disabled={busy} onClick={() => void act({ type: run.paused ? 'resume' : 'pause' })}>{run.paused ? 'Снять паузу' : 'Пауза'}</Button>}</div></header>
    <div className={styles.mockNote}>Сценарий → режиссура → внешность по референсам → master → обязательный критик → фотографии → отбор → твоя приёмка. Видео и upscale в этой серии отключены.</div>
    <CharacterField value={run.characterId ?? null} name={run.character?.name} disabled={busy || !!run.photos} onChange={setCharacter} />
    {run.photos && <Text variant="caption" tone="secondary">Персонаж зафиксирован для этой серии.</Text>}
    {run.paused && <div className={styles.notice} role="status">Новые отправки на паузе. Уже отправленные задачи продолжают проверяться и скачиваться. После снятия паузы оставшиеся фото потребуют подтверждения стоимости.</div>}
    <div className={styles.timeline}>
      <Section number="01" title="Сцена и план кадров" subtitle="Режиссёр → агент prompts · Codex" status={run.planned ? 'Сохранено' : run.preparation?.status === 'running' ? 'В работе' : 'Остановлено'}>
        {run.planned ? <details className={styles.detail}><summary>{run.scenePlan?.scene.title} · кадров: {run.shots.length} · открыть план и prompts</summary>{run.planSourceId && <Text variant="caption">Использован сохранённый план другой серии. Новых вызовов Codex не было.</Text>}<Preparation run={run} /></details> : <Preparation run={run} />}
        <details className={styles.detail}><summary>Сценарий и визуальный вектор</summary><pre>{run.script}</pre><pre>{run.direction}</pre></details>
        <div><Button variant="border" disabled={busy} onClick={() => { setDraft({ title: run.title, script: run.script, direction: run.direction, characterId: run.characterId, style: run.style, planningMode: 'codex', mode: 'photos', scenario: 'normal' }); newForm(); }}>Новая режиссура по этому сценарию</Button><Text variant="caption" tone="secondary">Откроется заполненный brief. Новая подготовка расходует квоту ChatGPT и запускается отдельно; текущая серия сохраняется.</Text></div>
      </Section>
      <Section number="02" title="Внешность и запуск" subtitle="Референсы персонажа → закреплённые prompts · Codex" status={appearance?.status === 'complete' ? 'Закреплена' : appearance?.status === 'running' ? 'Изучает фото' : appearance?.error ? 'Остановлено' : 'Ожидает'}>
        <PhotoStart run={run} />
        {appearance?.error && <Text role="alert">{appearance.error}</Text>}
        {appearance?.output && <><Text variant="label">{appearance.output.profile.summaryRu}</Text><dl className={styles.planFields}>{Object.entries(appearance.output.profile.traits).map(([key, value]) => <div key={key}><dt>{{ presentation: 'Общий образ', face: 'Лицо', hair: 'Причёска', build: 'Телосложение' }[key]}</dt><dd>{value}</dd></div>)}</dl><Text variant="caption" tone="secondary">Референсов: {appearance.uploadIds.length}. {appearance.model} · input {appearance.inputTokens ?? 'неизвестно'} / output {appearance.outputTokens ?? 'неизвестно'}. Профиль не заменяет проверку результата.</Text>{appearance.output.profile.unknowns.length > 0 && <Text variant="caption">Не определено по фото: {appearance.output.profile.unknowns.join(' ')}</Text>}<details className={styles.detail}><summary>Якорь внешности и prompts для отправки</summary><pre>{appearance.output.profile.anchorEn}</pre><pre>{boundPrompts(run)?.masterPrompt}</pre>{boundPrompts(run)?.shots.map(shot => <pre key={shot.shotId}>{shot.shotId}: {shot.imagePrompt}</pre>)}</details></>}
      </Section>
      <Section number="03" title="Master и обязательная проверка" subtitle="Soul 2 → критик Codex → разрешение остальных кадров" status={masterApproved(run) ? 'Принят критиком' : run.masterReview?.status === 'running' ? 'Проверяется' : master ? 'Кадры заблокированы' : 'Ожидает'}>
        {master && <div className={styles.masterScene}><button type="button" className={styles.thumbnail} onClick={() => setInspect(master.id)} aria-label="Открыть опорную сцену"><img src={master.url} alt="Опорная сцена серии" /></button><div><Text variant="label" medium>Общая сцена</Text><Text variant="caption" tone="secondary">Только после положительной проверки это изображение может стать reference следующих кадров. Проверяются персонаж целиком, лицо, руки и сцена.</Text><Button variant="ghost" onClick={() => setInspect(master.id)}>Открыть сцену и prompt</Button></div></div>}
        {master && <PhotoVerdict result={reviewedPhoto(run, master.id)} />}
        <PhotoReview run={run} scope="master" />
      </Section>
      <Section number="04" title="Создание фотографий" subtitle="Кадры по проверенному master · Soul 2" status={`${saved} / ${run.planned ? run.shots.length + 1 : '—'} с master`}>
        {!masterApproved(run) && <Text variant="label" tone="secondary">Новые кадры не отправляются, пока master не прошёл обязательную проверку.</Text>}
        {run.photos && <div className={styles.qcList} aria-label="Задачи фотографий">{run.photos.items.map((item) => <div className={styles.photoJob} key={item.key}>
          <div><Text variant="label" medium>{item.key === 'scene' ? 'Опорная сцена' : run.shots.find((s) => s.id === item.key)?.title}</Text>{item.error && <Text variant="caption" role="alert">{item.error}</Text>}{item.taskId && <Text variant="caption" tone="tertiary">Задача: {item.taskId}</Text>}</div><Tag tone={item.error ? 'warning' : item.mediaId ? 'success' : 'neutral'}>{STATUS[item.status]}</Tag>
          {item.jobId && (item.status === 'download_failed' || item.errorCode === 'POLL_TIMEOUT') && <Button variant="border" disabled={busy} onClick={() => void photoCommand('photos/retry', { jobId: item.jobId })}>Повторить {item.status === 'download_failed' ? 'скачивание' : 'проверку статуса'} · без генерации</Button>}
        </div>)}</div>}
      </Section>
      <Section number="05" title="Проверка и отбор" subtitle="Критик · Codex vision" status={run.review?.status === 'complete' ? 'Отчёт готов' : run.review?.status === 'running' ? 'Проверяет' : run.review?.error ? 'Остановлено' : 'Ожидает'}><PhotoReview run={run} /></Section>
      <Section number="06" title="Принять фотографии" subtitle="Milestone · решение после критика" status={eligible.length ? 'Твоё решение' : accepted ? `${accepted} принято` : 'Ожидает проверки'} milestone={eligible.length > 0}>
        <Text variant="label" tone="secondary">Критик рекомендует кадры, ты принимаешь итоговое решение. Рекомендованные выбраны заранее. Можно принять и кадр с замечаниями; все исходники сохраняются.</Text>
        {run.shots.some((s) => s.photoId) ? <div className={styles.grid}>{run.shots.map((shot) => {
          const photo = currentArtifact(run, shot.photoId);
          if (!photo) return null;
          return <article className={styles.asset} key={photo.id}>
            <button type="button" className={styles.thumbnail} onClick={() => setInspect(photo.id)} aria-label={`Открыть ${shot.title}`}><img src={photo.url} alt={shot.title} /></button>
            <div className={styles.assetBody}><div className={styles.assetTitle}><Text variant="label" medium>{shot.title}</Text>{eligible.includes(photo.id) && <input type="checkbox" aria-label={`Принять ${shot.title}`} checked={selection.includes(photo.id)} disabled={busy || run.paused} onChange={() => setSelected(selection.includes(photo.id) ? selection.filter((id) => id !== photo.id) : [...selection, photo.id])} />}</div><Text variant="caption" tone="secondary">{shot.framing}</Text>{shot.acceptedPhotoId && <Tag tone="success">Принято тобой</Tag>}<PhotoVerdict result={reviewedPhoto(run, photo.id)} /><div className={styles.assetActions}><Button variant="ghost" onClick={() => setInspect(photo.id)}>Детали</Button>{shot.acceptedPhotoId && <a href={photo.url} download>Скачать фото</a>}</div></div>
          </article>;
        })}</div> : <Text variant="label" tone="tertiary">Здесь появятся реальные скачанные кадры.</Text>}
        {eligible.length > 0 && <div className={styles.gateActions}><Button variant="ghost" disabled={busy || run.paused} onClick={() => setSelected(recommended)}>Выбрать рекомендованные</Button><Button variant="ghost" disabled={busy || run.paused} onClick={() => setSelected(eligible)}>Выбрать все, включая замечания</Button><span className={styles.spacer} /><Text variant="caption">{selection.length} выбрано{withIssues > 0 && ` · с замечаниями: ${withIssues}`}</Text><Button variant="primary" disabled={!selection.length || busy || run.paused} onClick={() => void act({ type: 'approvePhotos', ids: selection }).then((ok) => { if (ok) setSelected(null); })}>Принять фото</Button></div>}
      </Section>
      <Section number="07" title="Материалы для монтажа" subtitle="Только принятые фотографии" status={`${accepted} / ${run.shots.length || '—'}`}>
        <Text variant="label" tone="secondary">{accepted ? 'Принятые фото можно скачать с карточек выше или открыть в «Материалах». Список сохраняет prompts и связь с опорной сценой.' : 'После приёмки здесь будет список готовых файлов.'}</Text>
        {accepted > 0 && <a className={styles.download} href={`/api/production/${run.id}/manifest`} download>Скачать список принятых фото</a>}
        <Text variant="caption" tone="tertiary">Создание видео → milestone перед Topaz → upscale: пока недоступны.</Text>
      </Section>
    </div>
    <details className={styles.detail}><summary>История этапов · {run.events.length}</summary><ol className={styles.events}>{run.events.map((event, i) => <li key={i}><time>{new Date(event.at).toLocaleTimeString('ru-RU')}</time>{event.message}</li>)}</ol></details>
    <Dialog open={!!artifact} onOpenChange={(open) => { if (!open) setInspect(null); }} size="l" title={artifact?.shotId === 'scene' ? 'Опорная сцена' : run.shots.find((s) => s.id === artifact?.shotId)?.title ?? 'Фотография'} description="Полученный файл Higgsfield, prompt и данные задачи.">
      {artifact && <div className={styles.inspect}><img className={styles.preview} src={artifact.url} alt={artifact.shotId === 'scene' ? 'Опорная сцена' : 'Фотография серии'} /><div className={styles.inspectData}><Tag tone="outline">{artifact.model}</Tag><Text variant="label">{artifact.qcNote}</Text><PhotoVerdict result={reviewedPhoto(run, artifact.id)} /><dl><dt>Задача</dt><dd>{artifact.taskId}</dd><dt>Reference сцены</dt><dd>{artifact.sourceId ? 'Общий опорный кадр' : 'Исходная сцена'}</dd><dt>Оценка стоимости</dt><dd>{photoPrice(artifact.cost)} · фактическое списание не получено</dd><dt>Запрошено</dt><dd>1080p · 9:16</dd></dl><Text variant="caption" tone="tertiary">Prompt, отправленный в Higgsfield</Text><pre>{artifact.prompt}</pre><a className={styles.download} href={artifact.url} download>Скачать исходный файл</a></div></div>}
    </Dialog>
  </>;
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_REFERENCE_SELECTIONS, type ReferenceCard, type ReferenceMatch, type ReferenceSelection, type ReferenceThread, type ReferenceTurn } from '../../core/references.ts';
import { ui, useLanguage } from '../language.ts';
import { Button, Icon, Text, TextField } from '../ui/components/index.ts';
import { getReferenceCards, getReferenceThread, saveReferenceSelection, sendReferenceFeedback, sendReferenceQuery } from './api.ts';
import { referenceCaption, ReferenceCardContent, ReferenceImage } from './ReferenceCardView.tsx';
import styles from './References.module.css';

interface ReferenceChatProps {
  threadKey: string;
  initialBrief?: string;
  selection?: readonly ReferenceSelection[];
  onApply?: (selection: ReferenceSelection[]) => void | Promise<void>;
}

function ReferenceChatTurn({ turn, cards, selected, limitReached, dismissed, onToggle, onDismiss, onOpen }: {
  turn: ReferenceTurn;
  cards: ReadonlyMap<string, ReferenceCard>;
  selected: readonly ReferenceSelection[];
  limitReached: boolean;
  dismissed: ReadonlySet<string>;
  onToggle: (card: ReferenceCard, match: ReferenceMatch) => void;
  onDismiss: (turn: ReferenceTurn, match: ReferenceMatch) => void;
  onOpen: (card: ReferenceCard) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const matches = turn.matches.flatMap((match) => {
    const card = cards.get(match.refId);
    return card ? [{ match, card }] : [];
  });
  const orderedMatches = expanded ? matches : matches.slice(0, 5);
  return (
    <article className={styles.turn} data-reference-turn={turn.id}>
      <div className={styles.queryBubble}><Text>{turn.query}</Text></div>
      <div className={styles.answer}>
        {turn.summary && <Text className={styles.utterance}>{turn.summary}</Text>}
        {orderedMatches.length > 0 && <ul className={styles.matches}>
          {orderedMatches.map(({ match, card }) => {
            const attached = selected.some((item) => item.id === card.id);
            const dismissedHere = dismissed.has(`${turn.id}/${match.refId}`);
            return (
              <li key={match.refId} className={styles.match}>
                <button type="button" className={styles.matchFrame} aria-label={ui('Открыть кадр {0}', referenceCaption(card))} onClick={() => onOpen(card)}>
                  <ReferenceImage card={card} />
                </button>
                <div className={styles.matchBody}>
                  <button type="button" onClick={() => onOpen(card)} className={styles.referenceLink}>
                    <Icon name="link" size={0.875} /><span>{referenceCaption(card)}</span>
                  </button>
                  <Text as="h4" variant="label" medium>{match.role}</Text>
                  <Text variant="caption" tone="secondary">{match.reason}</Text>
                  <div className={styles.matchActions}>
                    <Button size="xs" variant={attached ? 'soft' : 'border'} aria-pressed={attached} onClick={() => onToggle(card, match)} disabled={!attached && limitReached}
                      icon={<Icon name={attached ? 'checkmark' : 'plus'} size={0.875} />}>
                      {attached ? ui('В подборке') : ui('В подборку')}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => onDismiss(turn, match)} disabled={dismissedHere || attached}>
                      {dismissedHere ? ui('Отмечено') : ui('Не подходит')}
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>}
        {matches.length > 5 && <Button variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? ui('Свернуть') : ui('Ещё {0}', matches.length - 5)}
        </Button>}
        {matches.length === 0 && !turn.summary && <Text tone="secondary">{ui('Подходящих кадров пока нет.')}</Text>}
      </div>
    </article>
  );
}

export function ReferenceChat({ threadKey, initialBrief = '', selection, onApply }: ReferenceChatProps) {
  useLanguage();
  const [cards, setCards] = useState<ReferenceCard[]>([]);
  const [turns, setTurns] = useState<ReferenceTurn[]>([]);
  const [selected, setSelected] = useState<ReferenceSelection[]>([...(selection ?? [])]);
  const [applied, setApplied] = useState<readonly ReferenceSelection[]>(selection ?? []);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [brief, setBrief] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [pendingQuery, setPendingQuery] = useState('');
  const [busy, setBusy] = useState<'load' | 'send' | 'apply' | 'idle'>('load');
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<ReferenceCard | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const initialSelection = useRef(selection);
  const cardMap = new Map(cards.map((card) => [card.id, card]));

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([getReferenceCards(controller.signal), getReferenceThread(threadKey, controller.signal)]).then(([catalog, result]) => {
      if (controller.signal.aborted) return;
      setCards(catalog.cards);
      setTurns(result.thread.turns);
      const saved = initialSelection.current ?? result.thread.selection;
      setSelected([...saved]);
      setApplied(saved);
      setLoaded(true);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : ui('Не удалось открыть чат.'));
    }).finally(() => {
      if (!controller.signal.aborted) setBusy('idle');
    });
    return () => { controller.abort(); request.current?.abort(); };
  }, [threadKey, loadVersion]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = (): void => {
      void getReferenceCards(controller.signal).then(({ cards: catalog }) => setCards(catalog), () => undefined);
    };
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, []);

  const lastTurn = turns.at(-1)?.id;
  useEffect(() => {
    const container = history.current;
    const latest = container?.querySelector<HTMLElement>('[data-reference-turn]:last-of-type');
    if (container && latest) container.scrollTop = latest.offsetTop;
  }, [lastTurn]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = query.trim();
    if (!text || busy !== 'idle' || !loaded || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setOpened(null);
    setPendingQuery(text);
    setBusy('send');
    try {
      const current = await sendReferenceQuery(threadKey, (brief ?? initialBrief).trim(), text, controller.signal);
      setTurns(current.thread.turns);
      setQuery('');
      const catalog = await getReferenceCards(controller.signal);
      setCards(catalog.cards);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : ui('Не удалось подобрать кадры.'));
      // Read shared server state in case the answer arrived after the connection dropped.
      const current = await getReferenceThread(threadKey, controller.signal).catch(() => null);
      if (current) setTurns(current.thread.turns);
    } finally {
      if (!controller.signal.aborted) {
        setBusy('idle');
        setPendingQuery('');
      }
      request.current = null;
    }
  };

  function toggle(card: ReferenceCard, match: ReferenceMatch): void {
    setSelected((previous) => previous.some((item) => item.id === card.id)
      ? previous.filter((item) => item.id !== card.id)
      : previous.length < MAX_REFERENCE_SELECTIONS
        ? [...previous, { id: card.id, version: card.version, role: match.role }]
        : previous);
  }

  async function dismiss(turn: ReferenceTurn, match: ReferenceMatch): Promise<void> {
    setError('');
    const key = `${turn.id}/${match.refId}`;
    setDismissed((previous) => new Set(previous).add(key));
    try {
      await sendReferenceFeedback(threadKey, { turnId: turn.id, refId: match.refId, value: 'dismissed', role: match.role });
    } catch (failure) {
      setDismissed((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      setError(failure instanceof Error ? failure.message : ui('Не удалось сохранить оценку.'));
    }
  }

  async function apply(): Promise<void> {
    setBusy('apply');
    setError('');
    let saved: ReferenceSelection[] = selected.map((item) => ({ ...item, role: item.role.trim() }));
    try {
      if (onApply) await onApply(saved);
      else {
        const { thread }: { thread: ReferenceThread } = await saveReferenceSelection(threadKey, saved);
        saved = thread.selection;
        setTurns(thread.turns);
      }
      setSelected(saved);
      setApplied(saved);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : ui('Не удалось сохранить подборку.'));
      setBusy('idle');
      return;
    }
    const feedback = await Promise.allSettled(saved.map((item) => {
      const turn = turns.findLast((entry) => entry.matches.some((match) => match.refId === item.id));
      return turn && sendReferenceFeedback(threadKey, { turnId: turn.id, refId: item.id, value: 'used', role: item.role });
    }));
    if (feedback.some((result) => result.status === 'rejected')) setError(ui('Подборка сохранена. Оценку сохранить не удалось.'));
    setBusy('idle');
  }

  const dirty = JSON.stringify(selected) !== JSON.stringify(applied);
  const readyCount = cards.filter((card) => card.analysis !== null).length;

  return (
    <div className={styles.chat}>
      <div className={styles.chatHistory} ref={history} aria-label={ui('История подбора')} aria-busy={busy === 'send' || busy === 'load'}>
        {opened ? (
          <section className={styles.inlineDetail}>
            <div className={styles.row}>
              <Text as="h3" variant="title-s" medium>{referenceCaption(opened)}</Text>
              <Button variant="border" onClick={() => setOpened(null)}>{ui('К подборке')}</Button>
            </div>
            <ReferenceCardContent card={opened} />
          </section>
        ) : <>
          {turns.map((turn) => <ReferenceChatTurn key={turn.id} turn={turn} cards={cardMap} selected={selected}
            limitReached={selected.length >= MAX_REFERENCE_SELECTIONS} dismissed={dismissed} onToggle={toggle}
            onDismiss={(entry, match) => void dismiss(entry, match)} onOpen={setOpened} />)}
          {pendingQuery && <div className={styles.turn}><div className={styles.queryBubble}><Text>{pendingQuery}</Text></div>
            <Text variant="label" tone="secondary" role="status">{ui('Подбираю кадры…')}</Text></div>}
          {turns.length === 0 && !pendingQuery && <div className={styles.chatEmpty}>
            <Icon name="sparkles" size={1.5} />
            <Text as="h3" variant="title-s" medium>{ui('Подбор референсов')}</Text>
            <Text tone="secondary">{busy === 'load' ? ui('Открываю чат…') : readyCount ? ui('Опиши шот и приёмы, которые хочешь найти.') : ui('Сначала запусти проверку и разбор кадров в библиотеке.')}</Text>
            {!loaded && busy !== 'load' && <Button variant="border" onClick={() => { setBusy('load'); setError(''); setLoadVersion((value) => value + 1); }}>{ui('Повторить')}</Button>}
          </div>}
        </>}
      </div>
      {error && <Text className={styles.error} variant="label" role="alert">{error}</Text>}
      <div className={styles.composer}>
        {(selected.length > 0 || dirty) && <div className={styles.selection}>
          <div className={styles.row}>
            <Text as="h3" variant="label" medium>{ui('В подборке {0} из {1}', selected.length, MAX_REFERENCE_SELECTIONS)}</Text>
            <Button variant="primary" size="s" disabled={!dirty || !loaded || busy === 'send' || selected.some((item) => !item.role.trim() || cardMap.get(item.id)?.version !== item.version)} loading={busy === 'apply'} onClick={() => void apply()}>
              {onApply ? ui('Применить подборку') : ui('Сохранить подборку')}
            </Button>
          </div>
          <div className={styles.selectedList}>
            {selected.map((item) => {
              const current = cardMap.get(item.id);
              const card = current?.version === item.version ? current : undefined;
              return <div key={item.id}>
                <div className={styles.selectedFrame} title={card ? referenceCaption(card) : item.id}>
                {card && <button type="button" className={styles.selectedImage} onClick={() => setOpened(card)} aria-label={ui('Открыть кадр {0}', referenceCaption(card))}><ReferenceImage card={card} /></button>}
                <input aria-label={ui('Назначение кадра {0}', card ? referenceCaption(card) : item.id)} value={item.role} maxLength={240} disabled={busy === 'apply'}
                  onChange={(event) => setSelected((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, role: event.target.value } : entry))} />
                <Button variant="ghost" size="xs" iconOnly aria-label={ui('Убрать кадр из подборки')} disabled={busy === 'apply'} icon={<Icon name="close" size={0.875} />}
                  onClick={() => setSelected((previous) => previous.filter((entry) => entry.id !== item.id))} />
                </div>
                {!card && <Text variant="caption" tone="secondary">{ui('Закреплённый кадр сохранён в подборке, но сейчас не допущен в библиотеку. Проверь его статус в очереди проверки.')}</Text>}
                {!card && current && <Button variant="border" size="xs" disabled={busy === 'apply'} onClick={() => setSelected((previous) => previous.map((entry) => entry.id === item.id ? { ...entry, version: current.version } : entry))}>{ui('Закрепить проверенную версию')}</Button>}
              </div>;
            })}
          </div>
        </div>}
        <form className={styles.queryForm} onSubmit={(event) => void submit(event)}>
          {(!!onApply || brief !== null) && <details className={styles.brief} open={turns.length === 0 && busy !== 'send' ? true : undefined}>
            <summary>{ui('Brief ветки')}</summary>
            <TextField label={ui('Контекст для подбора')} multiline rows={2} value={brief ?? initialBrief} maxLength={6000}
              onChange={(event) => setBrief(event.target.value)} />
            {brief !== null && brief !== initialBrief && <Button variant="ghost" size="xs" onClick={() => setBrief(null)}>{ui('Взять из comments')}</Button>}
          </details>}
          <div className={styles.promptRow}>
            <TextField label={ui('Запрос')} multiline rows={1} maxLength={2000}
              placeholder={ui('Бургер крупно, уличный свет и fisheye')}
              value={query} onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} />
            <Button type="submit" variant={dirty ? 'dark' : 'primary'} size="m" disabled={busy !== 'idle' || !query.trim() || !readyCount} loading={busy === 'send'}>{ui('Подобрать')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

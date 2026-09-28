import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { estimate, findModel, formatCost, paramsFor, REF_ROLE_RU, type MediaKind, type RefRole } from '../../core/gen/models.ts';
import { useGen, type ComposerRef } from '../gen/genStore.ts';
import { Button, Dialog, Icon, Text } from '../ui/components/index.ts';
import styles from './Studio.module.css';

/** Номера @ImageN — по порядку референсов (роль «Реф»); кадры старта и финала номеров не имеют. */
export function refNumbers(refs: readonly ComposerRef[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const r of refs) if (r.role === 'ref') out.set(r.key, (n += 1));
  return out;
}

function summary(kind: MediaKind, params: Record<string, unknown>): string {
  const parts = [params.aspectRatio, params.resolution, kind === 'video' && params.durationSec !== undefined ? `${String(params.durationSec)} с` : undefined, params.audio === true ? 'звук' : undefined];
  return parts.filter((p) => p !== undefined).map(String).join(' / ');
}

/** Поле ввода внизу студии: промпт, картинки с ролями, @-упоминания, цена на кнопке. Enter — генерация. */
export function Composer({ kind }: { kind: MediaKind }) {
  const c = useGen((s) => s.composer[kind]);
  const { setPrompt, addFiles, removeRef, setRole, moveRef, submit, setCount } = useGen();
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ at: number; index: number } | null>(null);
  const [askConsent, setAskConsent] = useState(false);

  const model = findModel(c.modelId);
  const params = model === undefined ? {} : paramsFor(model, c.params);
  const cost = model === undefined ? null : estimate(model, params, c.count, c.refs.length);
  const numbers = useMemo(() => refNumbers(c.refs), [c.refs]);
  const mentionable = c.refs.filter((r) => numbers.has(r.key));
  const roles: readonly RefRole[] = model?.refs.roles ?? ['ref'];

  const insertAt = (text: string, from: number, to: number): void => {
    const next = c.prompt.slice(0, from) + text + c.prompt.slice(to);
    setPrompt(kind, next);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(from + text.length, from + text.length);
    });
  };
  const insertToken = (n: number): void => {
    const pos = area.current?.selectionStart ?? c.prompt.length;
    const before = c.prompt.slice(0, pos);
    insertAt(`${before === '' || /\s$/.test(before) ? '' : ' '}@Image${n} `, pos, pos);
  };

  const send = async (consent = false): Promise<void> => {
    const result = await submit(kind, consent);
    if (result === 'needs-consent') setAskConsent(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention !== null && mentionable.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setMention({ ...mention, index: (mention.index + delta + mentionable.length) % mentionable.length });
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const ref = mentionable[mention.index];
        const n = ref === undefined ? undefined : numbers.get(ref.key);
        if (n !== undefined) insertAt(`@Image${n} `, mention.at, area.current?.selectionStart ?? mention.at + 1);
        setMention(null);
        return;
      }
      if (event.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const onChange = (value: string, caret: number): void => {
    setPrompt(kind, value);
    // «@» в начале слова открывает список картинок.
    const typed = value[caret - 1];
    const prev = value[caret - 2];
    if (typed === '@' && (prev === undefined || /\s/.test(prev)) && mentionable.length > 0) setMention({ at: caret - 1, index: 0 });
    else if (mention !== null && (caret <= mention.at || /\s/.test(typed ?? ''))) setMention(null);
  };

  return (
    <div className={styles.composerWrap}>
      <div className={styles.composer}>
        {c.refs.length > 0 && (
          <div className={styles.tray}>
            {c.refs.map((ref, i) => {
              const n = numbers.get(ref.key);
              return (
                <figure key={ref.key} className={styles.chip}>
                  <button type="button" className={styles.chipThumb} title={n === undefined ? REF_ROLE_RU[ref.role] : `Вставить @Image${n}`} onClick={() => n !== undefined && insertToken(n)}>
                    <img src={ref.thumb} alt={ref.label} />
                    <span className={styles.chipBadge}>{n ?? REF_ROLE_RU[ref.role]}</span>
                  </button>
                  <span className={styles.chipTools}>
                    <button type="button" title="Левее" disabled={i === 0} onClick={() => moveRef(kind, ref.key, -1)}>
                      <Icon name="chevron-back" size={0.75} />
                    </button>
                    <button type="button" title="Убрать" onClick={() => removeRef(kind, ref.key)}>
                      <Icon name="close" size={0.75} />
                    </button>
                    <button type="button" title="Правее" disabled={i === c.refs.length - 1} onClick={() => moveRef(kind, ref.key, 1)}>
                      <Icon name="chevron-forward" size={0.75} />
                    </button>
                  </span>
                  {roles.length > 1 && (
                    <select className={styles.chipRole} value={ref.role} onChange={(event) => setRole(kind, ref.key, event.target.value as RefRole)} aria-label="Роль картинки">
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {REF_ROLE_RU[r]}
                        </option>
                      ))}
                    </select>
                  )}
                </figure>
              );
            })}
          </div>
        )}

        <div className={styles.areaWrap}>
          <textarea
            ref={area}
            className={styles.area}
            rows={2}
            value={c.prompt}
            placeholder={kind === 'image' ? 'Опиши картинку. @ — сослаться на референс' : 'Опиши видео. @ — сослаться на референс'}
            onChange={(event) => onChange(event.target.value, event.target.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/'));
              if (files.length > 0) {
                event.preventDefault();
                void addFiles(kind, files);
              }
            }}
          />
          {mention !== null && mentionable.length > 0 && (
            <div className={styles.mentionMenu} role="listbox">
              {mentionable.map((ref, i) => (
                <button
                  key={ref.key}
                  type="button"
                  role="option"
                  aria-selected={i === mention.index}
                  className={`${styles.mentionItem} ${i === mention.index ? styles.mentionActive : ''}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertAt(`@Image${numbers.get(ref.key) ?? 1} `, mention.at, area.current?.selectionStart ?? mention.at + 1);
                    setMention(null);
                  }}
                >
                  <img src={ref.thumb} alt="" />
                  <Text variant="label">Image {numbers.get(ref.key)}</Text>
                  <Text variant="caption" tone="tertiary">
                    {ref.label}
                  </Text>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.composerBar}>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(event) => void addFiles(kind, [...(event.target.files ?? [])]).finally(() => (event.target.value = ''))} />
          <Button variant="soft" size="xs" iconOnly icon={<Icon name="plus" size={1} />} aria-label="Добавить картинку" title={model?.refs.max === 0 ? `${model.titleRu} не принимает картинки` : 'Добавить картинку (или вставь из буфера / перетащи)'} disabled={model?.refs.max === 0} onClick={() => file.current?.click()} />
          <Text variant="caption" tone="secondary">
            {model?.titleRu}
          </Text>
          {/* Степпер как у Higgsfield: − 1/4 +. Больше 4 за запуск сервер не примет. */}
          <span className={styles.stepper} title="Сколько вариантов за запуск">
            <button type="button" onClick={() => setCount(kind, c.count - 1)} disabled={c.count <= 1} aria-label="Меньше вариантов">
              <Icon name="minus" size={0.75} />
            </button>
            <Text as="span" variant="caption" mono>
              {c.count}/4
            </Text>
            <button type="button" onClick={() => setCount(kind, c.count + 1)} disabled={c.count >= 4} aria-label="Больше вариантов">
              <Icon name="plus" size={0.75} />
            </button>
          </span>
          <span className={styles.grow} />
          {cost !== null && (
            <Text variant="caption" tone="secondary">
              {formatCost(cost)}
            </Text>
          )}
          <Button variant="dark" size="s" iconOnly icon={<Icon name="arrow-forward" size={1} />} aria-label="Сгенерировать" title="Сгенерировать (Enter)" loading={c.sending} disabled={c.prompt.trim() === '' || model === undefined} onClick={() => void send()} />
        </div>
      </div>
      <Text variant="caption" tone={c.error === null ? 'tertiary' : 'accent'} className={styles.composerNote}>
        {c.error ?? summary(kind, params)}
      </Text>

      <Dialog
        open={askConsent}
        onOpenChange={setAskConsent}
        title="Отправить картинки в KIE?"
        description="Картинки уйдут в KIE, а оттуда — исполнителю модели (fal / replicate). Если на них есть лицо, оно тоже уйдёт. Согласие действует до закрытия вкладки."
        footer={
          <>
            <Button variant="ghost" size="s" onClick={() => setAskConsent(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              size="s"
              onClick={() => {
                setAskConsent(false);
                void send(true);
              }}
            >
              Отправить и сгенерировать{cost === null ? '' : ` · ${formatCost(cost)}`}
            </Button>
          </>
        }
      >
        <Text variant="label" tone="secondary">
          Картинок: {c.refs.length}.
        </Text>
      </Dialog>
    </div>
  );
}

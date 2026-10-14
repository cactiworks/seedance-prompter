import { useEffect, useId, useRef, useState } from 'react';
import { CHARACTER_STATUS, characterPending, characterReady, type Character } from '../../core/production/character.ts';
import { Button, Dialog, Icon, Tag, Text, TextField } from '../ui/components/index.ts';
import { useCharacters } from './characterStore.ts';
import styles from './CharacterField.module.css';

interface Photo { id: string; name: string }
/** Series store a local character ID; generation parameters store the provider's reference ID. */
export function CharacterField({ value, name, disabled = false, target = 'series', compact = false, onChange }: { value: string | null; name?: string; disabled?: boolean; target?: 'series' | 'generation'; compact?: boolean; onChange: (id: string | null) => void | Promise<boolean> }) {
  const { items, loading, busy, error, load, refresh, create } = useCharacters();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [chosen, setChosen] = useState<string | null>(value);
  const [characterName, setCharacterName] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [consent, setConsent] = useState(false);
  const [cost, setCost] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const radioName = useId();
  const generation = target === 'generation';
  const characterKey = (character: Character): string | null => generation ? character.referenceId : character.id;
  useEffect(() => { void load(); }, [load]);
  const hasPending = items.some(characterPending);
  useEffect(() => {
    if (!open || !hasPending) return;
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [open, hasPending, refresh]);
  const current = value === null ? undefined : items.find((c) => characterKey(c) === value);
  const selected = chosen === null ? undefined : items.find((c) => characterKey(c) === chosen);
  const locked = uploading || busy || saving;
  const title = generation ? 'Персонаж для Soul 2' : 'Персонаж серии';
  const missing = value !== null && current === undefined;
  const hint = missing
    ? 'Сохранённый Soul ID отсутствует в списке. Обнови список из Higgsfield или выбери другого.'
    : value && current && !characterReady(current)
      ? 'Soul ID ещё не готов или недоступен. Обнови статус перед генерацией.'
      : generation
        ? value ? 'Лицо персонажа будет использовано в Soul 2.' : 'Выбери готовый Soul ID v2 или генерируй без персонажа.'
        : value ? 'Персонаж выбран для серии. Mock-кадры не используют лицо.' : 'Создай персонажа из своих фото или выбери готового.';
  async function upload(files: FileList | null): Promise<void> {
    if (!files || locked) return;
    const batch = Array.from(files);
    if (photos.length + batch.length > 100) { setLocalError('Можно добавить до 100 фото.'); return; }
    if (batch.some((f) => !['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 30 * 1024 * 1024 || f.size === 0)) { setLocalError('Нужны JPG, PNG или WebP, до 30 МБ каждое.'); return; }
    setUploading(true); setLocalError(null);
    try {
      for (const file of batch) {
        const response = await fetch('/api/uploads', { method: 'POST', headers: { 'x-sp-client': '1', 'content-type': file.type }, body: file });
        const result = await response.json() as { id?: string; messageRu?: string };
        if (!response.ok || !result.id) throw new Error(result.messageRu ?? 'Не удалось сохранить фото.');
        setPhotos((previous) => [...previous, { id: result.id!, name: file.name }]);
      }
    } catch (failure) { setLocalError(String(failure)); }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function submit(): Promise<void> {
    if (locked || !photos.length || !characterName.trim() || !consent || !cost) return;
    const ok = await create({ requestId, name: characterName, uploadIds: photos.map((p) => p.id), consent: true, costConfirmed: 'unknown' });
    if (ok) { setCreating(false); setPhotos([]); setCharacterName(''); setConsent(false); setCost(false); setRequestId(crypto.randomUUID()); }
  }
  async function choose(): Promise<void> {
    if (locked || disabled || (chosen !== null && (!selected || !characterReady(selected)))) return;
    setSaving(true); setLocalError(null);
    try {
      const result = await onChange(chosen);
      if (result !== false) setOpen(false);
      else { setLocalError('Не удалось сохранить выбор. Обнови список и проверь, что Soul ID готов.'); void load(); }
    } catch { setLocalError('Не удалось сохранить выбор персонажа. Попробуй ещё раз.'); }
    finally { setSaving(false); }
  }
  return <>
    <section className={`${styles.field} ${compact ? styles.compact : ''}`} aria-label={title} data-character-field>
      <div><Text variant="caption" tone="secondary">Персонаж · Soul ID</Text><Text variant="label" medium>{current?.name ?? name ?? (value ? 'Soul ID вне списка' : 'Без персонажа')}</Text>
        <Text variant="caption" tone="secondary">{hint}</Text>
      </div>
      <Button variant="border" disabled={disabled} onClick={() => { setChosen(value); setCreating(false); setOpen(true); setLocalError(null); void load(); }}>{value ? 'Сменить персонажа' : 'Выбрать персонажа'}</Button>
    </section>
    <Dialog open={open} onOpenChange={(next) => { if (!locked) setOpen(next); }} title={creating ? 'Новый персонаж · Soul ID' : title} size="l"
      description={creating ? 'Фотографии одного человека. Они отправятся в Higgsfield только после подтверждения.' : generation ? 'Выбери готовый Soul ID v2 из своего API-аккаунта Higgsfield. Он будет применён к генерации Soul 2.' : 'Для серии доступен готовый Soul ID версии v2. Генерация кадров остаётся mock.'}
      footer={<div className={styles.footer}>
        {creating ? <><Button variant="ghost" disabled={locked} onClick={() => setCreating(false)}>К списку</Button><Button variant="primary" loading={busy} disabled={locked || !characterName.trim() || !photos.length || !consent || !cost} onClick={() => void submit()}>Создать Soul ID · цена неизвестна</Button></>
          : <><Button variant="ghost" disabled={locked} onClick={() => setOpen(false)}>Закрыть</Button><Button variant="primary" loading={saving} disabled={locked || disabled || (chosen !== null && (!selected || !characterReady(selected)))} onClick={() => void choose()}>{generation ? 'Использовать персонажа' : 'Выбрать для серии'}</Button></>}
      </div>}>
      <div className={styles.content}>
        {(localError || error) && <div className={styles.error} role="alert">{localError ?? error}</div>}
        {creating ? <>
          <TextField label="Имя персонажа" value={characterName} maxLength={100} disabled={locked} onChange={(e) => setCharacterName(e.target.value)} />
          <Text variant="label" tone="secondary">Добавь чёткие фотографии с разными ракурсами. В кадре должен быть один и тот же человек, без других лиц.</Text>
          <div className={styles.toolbar}><Button variant="border" loading={uploading} disabled={locked || photos.length >= 100} icon={<Icon name="plus" size={1} />} onClick={() => fileInput.current?.click()}>Добавить фото</Button><Text variant="caption" tone="secondary">{photos.length} / 100 · JPG, PNG, WebP · до 30 МБ</Text></div>
          <input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="Фотографии персонажа" className={styles.fileInput} onChange={(e) => void upload(e.target.files)} />
          {photos.length > 0 && <div className={styles.photos}>{photos.map((photo, index) => <figure key={photo.id}>
            <img src={`/api/uploads/${photo.id}`} alt={`Фото ${index + 1}: ${photo.name}`} />
            <figcaption title={photo.name}>{photo.name}</figcaption>
            <Button variant="ghost" size="xs" disabled={locked} aria-label={`Убрать фото ${index + 1}`} onClick={() => setPhotos(photos.filter((p) => p.id !== photo.id))}>Убрать</Button>
          </figure>)}</div>}
          <Text variant="caption" tone="secondary">Добавленные фото хранятся локально в данных приложения. Удаление из этого списка исключает фото из отправки.</Text>
          <label className={styles.check}><input type="checkbox" checked={consent} disabled={locked} onChange={(e) => setConsent(e.target.checked)} />Разрешаю отправить выбранные фото в Higgsfield для создания Soul ID.</label>
          <label className={styles.check}><input type="checkbox" checked={cost} disabled={locked} onChange={(e) => setCost(e.target.checked)} />Цена создания не опубликована. Подтверждаю запуск с возможным списанием с API-баланса.</label>
        </> : <>
          <div className={styles.toolbar}><Button variant="border" disabled={locked} onClick={() => { setCreating(true); setLocalError(null); }}>Новый персонаж</Button><Button variant="ghost" loading={loading} disabled={locked} onClick={() => void refresh(true)}>Обновить из Higgsfield</Button></div>
          <div className={styles.list} role="radiogroup" aria-label="Доступные персонажи">
            <label className={styles.item}><input type="radio" name={radioName} checked={chosen === null} disabled={locked} onChange={() => setChosen(null)} /><div><Text variant="label" medium>Без персонажа</Text><Text variant="caption" tone="secondary">{generation ? 'Генерация без привязки к лицу.' : 'Пройти mock-серию без привязки лица.'}</Text></div></label>
            {items.map((character) => <label key={character.id} className={styles.item}>
              <input type="radio" name={radioName} checked={chosen !== null && chosen === characterKey(character)} disabled={locked || !characterReady(character)} onChange={() => setChosen(characterKey(character))} />
              {character.uploadIds[0] && <img className={styles.avatar} src={`/api/uploads/${character.uploadIds[0]}`} alt="" />}
              <div className={styles.itemText}><div className={styles.toolbar}><Text variant="label" medium>{character.name}</Text><Tag tone={characterReady(character) ? 'success' : ['completed', 'failed', 'unknown'].includes(character.status) ? 'warning' : 'neutral'}>{character.status === 'completed' && character.modelVersion === 'unknown' ? 'Версия не подтверждена' : CHARACTER_STATUS[character.status]}</Tag></div>
                <Text variant="caption" tone="secondary">{character.status === 'uploading' ? `${character.uploadedCount} / ${character.uploadIds.length} фото отправлено` : character.modelVersion === 'unknown' ? 'Версия Soul ID не указана API. Для Soul 2 нужна v2; выбор недоступен.' : 'Soul 2 · v2'}</Text>
                {character.error && <Text variant="caption" tone="secondary">{character.error}</Text>}
              </div>
            </label>)}
          </div>
          {!items.length && <Text variant="label" tone="secondary">Персонажей пока нет. Создай Soul ID или загрузи список из своего API-аккаунта Higgsfield.</Text>}
          {hasPending && <div role="status"><Text variant="caption" tone="secondary">Статус обновляется каждые 5 секунд. Подготовка продолжится после закрытия окна.</Text></div>}
        </>}
      </div>
    </Dialog>
  </>;
}

import { useEffect, useState } from 'react';
import { Button, Card, Icon, Meter, SegmentedControl, Switch, Tag, Text, TextField, type IconName } from '../ui/components/index.ts';

const ICON_SAMPLE: IconName[] = ['sparkles', 'copy', 'pencil', 'eye', 'eye-off', 'layers', 'images', 'video', 'mic', 'translate', 'lock', 'unlock', 'pin', 'link', 'bin', 'cog', 'search', 'checkmark-circle', 'alert-circle', 'info-circle', 'arrow-undo', 'arrow-redo', 'upload', 'download'];
import styles from './UiGallery.module.css';

type Theme = 'light' | 'dark';
type Scale = '75' | '100' | '133';

const SWATCHES: { token: string; name: string }[] = [
  { token: '--lab-accent', name: 'accent' },
  { token: '--lab-accent-soft', name: 'accent-soft' },
  { token: '--lab-danger', name: 'danger' },
  { token: '--lab-warning', name: 'warning' },
  { token: '--lab-success', name: 'success' },
  { token: '--lab-info', name: 'info' },
  { token: '--lab-bg-page', name: 'bg-page' },
  { token: '--lab-bg-surface', name: 'bg-surface' },
  { token: '--lab-fill-2', name: 'fill-2' },
  { token: '--lab-fill-4', name: 'fill-4' },
  { token: '--lab-text-secondary', name: 'text-secondary' },
  { token: '--lab-bg-inverse', name: 'bg-inverse' },
];

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <Text as="h2" variant="title-s">
          {title}
        </Text>
        <Text variant="label" tone="secondary">
          {note}
        </Text>
      </div>
      <div className={styles.stack}>{children}</div>
    </section>
  );
}

/** Галерея UI-kit: каждый компонент в состояниях, обе темы, масштаб. Сверяется с эталоном lab.pics. */
export function UiGallery() {
  const [theme, setTheme] = useState<Theme>('light');
  const [scale, setScale] = useState<Scale>('100');
  const [view, setView] = useState<'placeholders' | 'resolved'>('resolved');
  const [operatorRule, setOperatorRule] = useState(true);
  const [enhance, setEnhance] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (scale === '100') delete document.documentElement.dataset.scale;
    else document.documentElement.dataset.scale = scale;
  }, [theme, scale]);

  return (
    <div className={styles.page}>
      <header className={`${styles.topbar} lab-glass-thin`}>
        <Text variant="label" medium>
          Seedance Prompter · UI-kit
        </Text>
        <div className={styles.controls}>
          <SegmentedControl aria-label="Масштаб" size="s" value={scale} onChange={setScale} options={[{ value: '75', label: '75 %' }, { value: '100', label: '100 %' }, { value: '133', label: '133 %' }]} />
          <SegmentedControl aria-label="Тема" size="s" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
      </header>

      <div className={styles.hero}>
        <Text as="h1" variant="display">
          Промпт, в который <Text as="span" variant="display" tone="accent">верит модель</Text>
        </Text>
        <Text tone="secondary">
          Foundations перенесены с живого сайта lab.pics: палитра и лестница непрозрачности, Geist в двух весах, радиусы, прогрессивная тень, стекло только на парящем. Значения уточняются по Figma-файлу Lab UI.
        </Text>
      </div>

      <Section title="Типографика" note="Два веса. Иерархия — весом и непрозрачностью. Трекинг растёт с кеглем.">
        <Text variant="title-l">Кадр 2 · Sony VENICE 2</Text>
        <Text variant="title-m">Сценарий по таймлайну</Text>
        <Text variant="title-s">Одно главное действие в абзаце</Text>
        <Text>Всё, что ты не написал, модель выберет за тебя — и выберет усреднённо.</Text>
        <Text tone="secondary">Вторичный текст — тот же цвет на 72 %.</Text>
        <Text variant="label" tone="tertiary">Третичный — на 52 %: неактивные пункты, подписи полей.</Text>
        <Text variant="label" mono>{'{{intro:alexander}} stands near {{intro:pickup}}'}</Text>
      </Section>

      <Section title="Цвет" note="Один акцент. Статусные цвета — только там, где есть статус. Производные: цвет × непрозрачность.">
        <div className={styles.swatches}>
          {SWATCHES.map((swatch) => (
            <div key={swatch.token} className={styles.swatch}>
              <div className={styles.chip} style={{ background: `var(${swatch.token})` }} />
              <Text variant="caption" tone="secondary" mono>
                {swatch.name}
              </Text>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Кнопки" note="Действие — пилюля. Primary один на экран; dark — второе весомое действие без второго цвета.">
        <div className={styles.row}>
          <Button variant="primary" icon={<Icon name="sparkles" variant="filled" />}>Написать кадр</Button>
          <Button variant="dark" icon={<Icon name="copy" />}>Копировать для генерации</Button>
          <Button variant="secondary" icon={<Icon name="bookmark" />}>Сохранить попытку</Button>
          <Button variant="soft" icon={<Icon name="bulb" />}>Предложить правки</Button>
          <Button variant="ghost">Отмена</Button>
          <Button variant="border">Экспорт панели</Button>
          <Button variant="danger">Удалить кадр</Button>
        </div>
        <div className={styles.row}>
          <Button variant="primary" size="m">Написать кадр</Button>
          <Button variant="primary" size="xs">Перегенерировать</Button>
          <Button variant="secondary" size="xs">Принять</Button>
          <Button variant="primary" loading>Пишу абзацы…</Button>
          <Button variant="secondary" disabled>Недоступно</Button>
        </div>
      </Section>

      <Section title="Иконки" note="Родные иконки Lab UI из Figma-файла: outline в интерфейсе, filled — для выбранного. Цвет наследуется от текста.">
        <div className={styles.row}>
          {ICON_SAMPLE.map((name) => (
            <Icon key={name} name={name} size={1.5} label={name} />
          ))}
        </div>
        <div className={styles.row} style={{ color: 'var(--lab-accent)' }}>
          {ICON_SAMPLE.slice(0, 12).map((name) => (
            <Icon key={name} name={name} variant="filled" size={1.5} label={`${name} filled`} />
          ))}
        </div>
      </Section>

      <Section title="Выбор" note="Segmented control — пилюля с белым бегунком. Switch — для правил, которые включены или нет.">
        <div className={styles.row}>
          <SegmentedControl aria-label="Вид промпта" value={view} onChange={setView} options={[{ value: 'placeholders', label: 'Плейсхолдеры' }, { value: 'resolved', label: 'Итог' }]} />
          <Tag tone="outline">{'<<<image_N>>>'}</Tag>
        </div>
        <div className={styles.row}>
          <Switch checked={operatorRule} onChange={setOperatorRule} label="Правило «оператор не виден»" />
          <Switch checked={enhance} onChange={setEnhance} label="Enhance Prompt выключен в Higgsfield" />
        </div>
      </Section>

      <Section title="Поля" note="Подпись на рамке — фирменный приём Lab UI. Ошибка заменяет подсказку и красит рамку.">
        <div className={styles.grid2}>
          <TextField label="Локация" placeholder="Набережная Москвы-реки у парковки" helper="По-русски. Английский абзац напишет писатель." />
          <TextField label="Реплика L2" defaultValue="Обратичество другое. Чистые тени." error="Слово «Обратичество» уйдёт в озвучку буквально — вычитай реплику." />
        </div>
        <TextField multiline label="Главное действие" placeholder="John без предупреждения встаёт в стойку Брюса Ли. Начинается спарринг на мокром асфальте…" helper="Одно главное действие. 4–6 крупных событий на 30 секунд." />
      </Section>

      <Section title="Статусы" note="Мягкий фон цвета статуса на 12 % и тот же цвет текстом.">
        <div className={styles.row}>
          <Tag tone="danger" dot>error</Tag>
          <Tag tone="warning" dot>warning</Tag>
          <Tag tone="info" dot>info</Tag>
          <Tag tone="success">в монтаже</Tag>
          <Tag tone="accent">LLM</Tag>
          <Tag tone="neutral">вручную</Tag>
          <Tag tone="outline">устарел</Tag>
        </div>
      </Section>

      <Section title="Шапка кадра" note="Производный паттерн с эталона: подпись над значением. Метры бюджетов из правил гайда.">
        <Card padding="l">
          <div className={styles.shotHead}>
            <div className={styles.stack} style={{ gap: 'var(--lab-space-2)' }}>
              <Text variant="caption" tone="secondary">Кадр 2 · попытка 1</Text>
              <Text variant="title-m">Чистая цифра: драка держит ритм</Text>
            </div>
            <div className={styles.meters}>
              <Meter label="События ★" value={5} max={6} unit="/ 4–6" />
              <Meter label="Фон" value={3} max={4} unit="/ ≤4" tone="success" />
              <Meter label="Речь" value={79} max={67} unit="/ 67 слов" tone="warning" />
            </div>
          </div>
        </Card>
      </Section>

      <Section title="Стекло" note="Только на парящем: полоса панели референсов над контентом. Формы и текст — на solid.">
        <div className={styles.stage}>
          <div className={styles.stageText}>
            <Text variant="title-s">Панель референсов</Text>
            <Text tone="secondary">Порядок картинок — это нумерация в тексте. Перетащил — номера сменились везде.</Text>
          </div>
          <div className={`${styles.strip} lab-glass`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n} className={`${styles.ref} ${styles.refFill}`}>
                <span className={styles.refNumber}>{n}</span>
              </div>
            ))}
            <div className={`${styles.ref} lab-hatch`} />
            <div className={styles.stripSpacer} />
            <Button variant="secondary" size="xs">+ из библиотеки</Button>
          </div>
        </div>
      </Section>

      <Section title="Линтер" note="Находка привязана к абзацу: severity-тег, правило гайда, что сделать.">
        <Card padding="m" elevation="raised">
          {[
            { tone: 'danger' as const, rule: 'REF_DANGLING_PREP', text: 'После «from with» пусто — здесь должна стоять ссылка на референс.', where: 'абзац 1' },
            { tone: 'warning' as const, rule: 'OP_ACTOR_VERB', text: 'Оператор описан как действующее лицо. Модель покажет человека с камерой.', where: 'абзац 4' },
            { tone: 'info' as const, rule: 'MECH_RISK', text: 'Механика борта — слабое место видеомоделей. Спрячем в монтаже.', where: 'абзац 5' },
          ].map((finding) => (
            <div key={finding.rule} className={styles.finding}>
              <Tag tone={finding.tone} dot>
                {finding.tone === 'danger' ? 'error' : finding.tone}
              </Tag>
              <div className={styles.findingBody}>
                <Text variant="label">{finding.text}</Text>
                <Text variant="caption" tone="tertiary" mono>{finding.rule}</Text>
              </div>
              <Text variant="caption" tone="secondary">{finding.where}</Text>
            </div>
          ))}
        </Card>
      </Section>

      <Section title="Блок промпта" note="Подсветка семи категорий гайда — те же статусные цвета на 12 %.">
        <Card padding="l">
          <div className={styles.blockHead}>
            <div className={styles.row}>
              <Text variant="label" medium>Блок 03 · Герои и первая реплика</Text>
              <Tag tone="accent">LLM</Tag>
            </div>
            <Button variant="ghost" size="xs">Копировать блок</Button>
          </div>
          <p className={styles.prompt}>
            Alexander, matching <span className={`${styles.hl} ${styles.hlRef}`}>{'<<<image_5>>>'}</span>, stands near the main pickup from{' '}
            <span className={`${styles.hl} ${styles.hlRef}`}>{'<<<image_7>>>'}</span>. He holds the <span className={`${styles.hl} ${styles.hlCam}`}>Sony VENICE 2</span>. The dent from a previous impact is visible on the truck's side panel.{' '}
            <span className={`${styles.hl} ${styles.hlImp}`}>The camera dips slightly</span>. He says in clear, native Russian:{' '}
            <span className={`${styles.hl} ${styles.hlSay}`}>«Сейчас мы снимаем на Sony VENICE 2.»</span> <span className={`${styles.hl} ${styles.hlNeg}`}>No one in the foreground reacts.</span>
          </p>
        </Card>
      </Section>
    </div>
  );
}

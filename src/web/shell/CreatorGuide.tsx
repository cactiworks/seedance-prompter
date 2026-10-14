import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Icon, Text } from '../ui/components/index.ts';
import type { IconName } from '../ui/icons/Icon.tsx';
import type { Route } from './route.ts';
import styles from './CreatorGuide.module.css';

interface Topic {
  id: string;
  title: string;
  label: string;
  route: Route;
  icon: IconName;
  targets: string[];
  text: string;
}

const TOPICS: Topic[] = [
  { id: 'production', title: 'Серия контента по сценарию', label: 'Единая сцена, план и контроль этапов', route: 'production', icon: 'layers', targets: ['production-start', 'nav-production'], text: 'В Производстве задай сценарий и визуальный вектор. Codex по кнопке подготовит сцену и prompts, расходуя квоту. Затем отдельно подтверди стоимость реальных фото Soul 2 и прими полученные кадры. Видео и upscale отключены. «Демо без генераций» показывает оба milestone бесплатно.' },
  { id: 'canvas', title: 'Собрать работу на Canvas', label: 'Референсы, генерация и обработка на одном холсте', route: 'canvas', icon: 'sparkles', targets: ['canvas-create', 'canvas-board'], text: 'Создай холст под задачу клиента или открой готовый шаблон. Добавляй референсы, изображения и видео рядом — так варианты и цепочка работы остаются перед глазами.' },
  { id: 'add', title: 'Добавить инструмент на холст', label: 'Генерация, Seedance, кадр из видео и обрезка', route: 'canvas', icon: 'plus', targets: ['canvas-add', 'canvas-create'], text: 'На открытом холсте нажми «Добавить»: выбери материал, генератор или обработку. Соединяй выход одного блока со входом другого, чтобы передать изображение, видео или текст. Каждый блок запускается отдельно.' },
  { id: 'images', title: 'Создать изображение', label: 'Быстрый результат по тексту или референсу', route: 'images', icon: 'image', targets: ['studio-composer', 'nav-images'], text: 'Опиши результат внизу и при необходимости добавь референс. Справа выбери модель и формат. Цена видна перед запуском. Готовое изображение можно открыть, править, скачать или отправить в Canvas.' },
  { id: 'video', title: 'Создать видео', label: 'Оживить изображение или описать сцену', route: 'video', icon: 'video', targets: ['studio-composer', 'nav-video'], text: 'Опиши движение и добавь исходное изображение, если оно нужно модели. Справа настрой длительность и формат. Для обрезки готового видео отправь его в Canvas и добавь блок обрезки.' },
  { id: 'result', title: 'Править и скачать результат', label: 'Сохранённые файлы, версии и возврат в Canvas', route: 'library', icon: 'download', targets: ['library-items', 'nav-library'], text: 'В «Материалах» находятся результаты и загруженные файлы. Открой файл: там доступны скачивание, правки и отправка в Canvas. На самом холсте у готового результата есть «Открыть и править» и «Скачать». Схема холста сохраняется отдельно от медиафайлов.' },
  { id: 'seedance', title: 'Подготовить Seedance-сценарий', label: 'Кадры, персонажи, референсы и точные реплики', route: 'shots', icon: 'list', targets: ['seedance-create', 'nav-tools'], text: 'Дай ролику название, затем опиши кадры по-русски и добавь референсы. Инструмент соберёт промпт для Seedance. Он также доступен блоком внутри Canvas. Для короткой идеи без разбивки на кадры есть «Помощник промптов» в меню инструментов.' },
];

interface Highlight { left: number; top: number; width: number; height: number }

/** Справка по задачам на реальных экранах. Выбор темы ничего не создаёт и не запускает. */
export function CreatorGuide({ route, onRoute }: { route: Route; onRoute: (route: Route) => void }) {
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const helpRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLElement>(null);
  const close = (): void => { setTopic(null); helpRef.current?.querySelector('button')?.focus(); };

  useEffect(() => {
    if (topic === null) return;
    let frame = 0;
    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = topic.targets.map((id) => document.querySelector(`[data-guide="${id}"]`)).find((el) => el !== null && el.getBoundingClientRect().width > 0);
        const rect = target?.getBoundingClientRect();
        const next = rect ? { left: Math.max(4, rect.left - 3), top: Math.max(4, rect.top - 3), width: Math.min(rect.width + 6, window.innerWidth - Math.max(4, rect.left - 3) - 4), height: Math.min(rect.height + 6, window.innerHeight - Math.max(4, rect.top - 3) - 4) } : null;
        setHighlight((prev) => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
      });
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { childList: true, subtree: true });
    const resize = new ResizeObserver(measure);
    resize.observe(document.body);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { setTopic(null); helpRef.current?.querySelector('button')?.focus(); } };
    const navigate = (): void => { if (window.location.hash !== `#/${topic.route}`) setTopic(null); };
    window.addEventListener('keydown', escape);
    window.addEventListener('hashchange', navigate);
    measure();
    const focus = window.setTimeout(() => tipRef.current?.focus(), 0);
    return () => {
      observer.disconnect(); resize.disconnect(); cancelAnimationFrame(frame); window.clearTimeout(focus);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('hashchange', navigate);
    };
  }, [topic, route]);

  return <>
    <span ref={helpRef}><Button variant="border" size="s" onClick={() => { setTopic(null); setOpen(true); }}>Как пользоваться</Button></span>
    <Dialog open={open} onOpenChange={setOpen} title="Что хочешь сделать?" description="Canvas — основное рабочее место. Выбери задачу — покажем, где она решается.">
      <div className={styles.topics}>
        {TOPICS.map((item) => <button type="button" className={styles.topic} key={item.id} onClick={() => { setOpen(false); onRoute(item.route); setHighlight(null); setTopic(item); }}>
          <Icon name={item.icon} size={1.25} />
          <span className={styles.topicCopy}><Text as="span" variant="label" medium>{item.title}</Text><Text as="span" variant="caption" tone="secondary">{item.label}</Text></span>
          <Icon name="chevron-forward" size={1} />
        </button>)}
      </div>
      <Text variant="caption" tone="secondary" className={styles.note}>Начать можно с любой задачи. Подсказки доступны здесь в любой момент.</Text>
    </Dialog>
    {topic !== null && route === topic.route && <>
      {highlight !== null && <div aria-hidden className={styles.highlight} style={highlight} />}
      <aside ref={tipRef} tabIndex={-1} className={styles.tip} style={highlight !== null && highlight.top > window.innerHeight * 0.6 ? { bottom: window.innerHeight - highlight.top + 12 } : undefined} aria-label={`Подсказка: ${topic.title}`}>
        <div className={styles.tipHead}><Text variant="label" medium>{topic.title}</Text><Button variant="ghost" size="xs" iconOnly aria-label="Закрыть подсказку" icon={<Icon name="close" size={1} />} onClick={close} /></div>
        <Text variant="label" tone="secondary">{topic.text}</Text>
        <div className={styles.actions}><Button variant="ghost" size="s" onClick={() => { setTopic(null); setOpen(true); }}>Другие подсказки</Button><Button variant="primary" size="s" onClick={close}>Понятно</Button></div>
      </aside>
    </>}
  </>;
}

import { useEffect, useState } from 'react';
import { isCanvasDraft } from '../../core/model/canvas.ts';
import { Button, Card, Icon, Text, TextField } from '../ui/components/index.ts';
import { useStore } from '../store.ts';
import styles from './Home.module.css';

const formatDate = (ms: number): string => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

export function Home() {
  const { projects: all, loadProjects, createProject, openProject, error } = useStore();
  // Черновики Seedance-промптеров из canvas открываются из своих нод, здесь их нет.
  const projects = all.filter((p) => !isCanvasDraft(p.slug));
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const create = async (): Promise<void> => {
    if (title.trim() === '') return;
    setBusy(true);
    await createProject(title.trim()).finally(() => setBusy(false));
  };

  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <Text as="h1" variant="display">
          Промпт, в который <Text as="span" variant="display" tone="accent">верит модель</Text>
        </Text>
        <Text tone="secondary">Заполняешь поля кадра тезисно по-русски — агент пишет из них промпт для Seedance 2.5 по правилам гайда: номера референсов, реплики и дословные блоки ставятся сами, линтер ловит ошибки до генерации.</Text>
      </header>

      <Card padding="l" className={styles.create}>
        <TextField label="Новый ролик" placeholder="Например: Три камеры" value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void create()} />
        <Button variant="primary" size="m" icon={<Icon name="plus" />} loading={busy} disabled={title.trim() === ''} onClick={() => void create()}>
          Создать
        </Button>
      </Card>
      {error !== null && <Text variant="label" tone="secondary">{error}</Text>}

      <section className={styles.list}>
        <Text variant="caption" tone="secondary">Ролики</Text>
        {projects.length === 0 ? (
          <div className={`${styles.empty} lab-hatch`}>
            <Text variant="label" tone="tertiary">Пока пусто. Создай первый ролик — кадр появится сразу.</Text>
          </div>
        ) : (
          projects.map((project) => (
            <button key={project.slug} type="button" className={styles.item} onClick={() => void openProject(project.slug)}>
              <span className={styles.itemMain}>
                <Text variant="title-s">{project.title}</Text>
                <Text variant="caption" tone="secondary">
                  {project.shots} {project.shots === 1 ? 'кадр' : 'кадра'} · изменён {formatDate(project.updatedAt)}
                </Text>
              </span>
              <Icon name="chevron-forward" size={1.25} />
            </button>
          ))
        )}
      </section>
    </main>
  );
}

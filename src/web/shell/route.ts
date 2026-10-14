import { useEffect, useState } from 'react';

/** Стабильные hash-ссылки; Canvas — основной вход, помощники доступны из меню инструментов. */
export const ROUTES = ['shots', 'prompter', 'images', 'video', 'canvas', 'library', 'calibration', 'production'] as const;
export type Route = (typeof ROUTES)[number];

export const PRIMARY_ROUTES: Route[] = ['canvas', 'production', 'images', 'video', 'library'];
export const TOOL_ROUTES: Route[] = ['shots', 'prompter', 'calibration'];
export const ROUTE_RU: Record<Route, string> = { production: 'Производство', shots: 'Seedance-сценарий', prompter: 'Помощник промптов', images: 'Изображения', video: 'Видео', canvas: 'Canvas', library: 'Материалы', calibration: 'Калибровка' };
export const ROUTE_HINT: Record<Route, string> = {
  production: 'Серии фото и клипов: этапы и две точки приёмки · mock',
  canvas: 'Холст: референсы, генерация и обработка вместе',
  images: 'Быстрая генерация и правка изображений',
  video: 'Генерация видео по тексту или изображению',
  library: 'Сохранённые результаты и загруженные файлы',
  shots: 'Подробный промпт по кадрам, референсам и репликам',
  prompter: 'Помощь с промптом и выбором модели по твоей идее',
  calibration: 'Сравнение моделей на одинаковых задачах',
};

const parse = (hash: string): Route => {
  const value = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(value) ? (value as Route) : 'canvas';
};

/** Маршрут в hash: #/images. Роутер ради пяти вкладок не нужен. */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return [route, (next) => (window.location.hash = `/${next}`)];
}

import { useEffect, useState } from 'react';

/** Разделы оболочки — вкладки сверху, как в connxn. Кадры — прежний конструктор промптов. */
export const ROUTES = ['shots', 'prompter', 'images', 'video', 'canvas', 'library', 'calibration'] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_RU: Record<Route, string> = { shots: 'Кадры', prompter: 'Промптер', images: 'Картинки', video: 'Видео', canvas: 'Canvas', library: 'Библиотека', calibration: 'Калибровка' };

const parse = (hash: string): Route => {
  const value = hash.replace(/^#\/?/, '');
  return (ROUTES as readonly string[]).includes(value) ? (value as Route) : 'shots';
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

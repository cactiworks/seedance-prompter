import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles/base.css';
import { App } from './App.tsx';
import { UiGallery } from './routes/UiGallery.tsx';

const container = document.getElementById('root');
if (container === null) throw new Error('Нет #root в index.html');

createRoot(container).render(
  <StrictMode>
    {window.location.pathname.startsWith('/ui') ? <UiGallery /> : <App />}
  </StrictMode>,
);

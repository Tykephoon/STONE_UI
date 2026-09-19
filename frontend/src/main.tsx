import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ensureSampleData } from './data/sample';
import './styles/tokens.css';
import './styles/base.css';

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root element missing from index.html.');
}

/*
  Seed the sample dataset before the first render when the database is empty,
  so a new visitor never sees an empty dashboard flash into a populated one.
  A failure here is non-fatal: the app starts empty and prompts for an import.
*/
void ensureSampleData().finally(() => {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getHoomi } from 'hoomi.microapps.js';
import { installMockHost } from 'hoomi.microapps.js/mock';
import { HoomiProvider } from 'hoomi.microapps.js/react';

import { App } from './App';

// Outside the real Hoomi host, run against the mock. Try scenarios from the
// URL, e.g.  ?hoomi_scenario=deny-forever&hoomi_latency=1200
declare global {
  interface Window {
    __hoomiBootstrap?: unknown;
  }
}
if (!window.__hoomiBootstrap) {
  installMockHost({
    appId: 'app.example.cafe',
    launchParams: { table: '12', promo: 'WELCOME10' },
    panel: true,
  });
}

const hoomi = getHoomi();
void hoomi.ready().then(() => hoomi.lifecycle.ready());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HoomiProvider hoomi={hoomi}>
      <App />
    </HoomiProvider>
  </StrictMode>,
);

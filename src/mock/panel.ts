/** Tiny optional DevTools overlay for the mock host. Display-only + two buttons. */

import type { MockHost } from './mockHost.js';

export interface MockPanel {
  destroy(): void;
}

export function createMockPanel(host: MockHost): MockPanel | null {
  if (typeof document === 'undefined' || !document.body) return null;

  const root = document.createElement('div');
  root.setAttribute('data-hoomi-mock-panel', '');
  root.style.cssText = [
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:2147483647',
    'font:11px/1.4 ui-monospace,Menlo,monospace',
    'background:rgba(20,20,28,0.92)',
    'color:#d7f5d7',
    'border:1px solid #3c4',
    'border-radius:6px',
    'padding:6px 8px',
    'max-width:280px',
    'max-height:40vh',
    'overflow:auto',
    'pointer-events:auto',
  ].join(';');

  const header = document.createElement('div');
  header.style.cssText = 'font-weight:bold;margin-bottom:4px;color:#8f8';
  const log = document.createElement('div');
  log.style.cssText = 'white-space:pre-wrap;word-break:break-all;color:#cde';

  const buttons = document.createElement('div');
  buttons.style.cssText = 'margin-top:4px;display:flex;gap:6px';
  const mkButton = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:inherit;background:#243;color:#cfc;border:1px solid #3c4;border-radius:4px;padding:1px 6px;cursor:pointer';
    b.addEventListener('click', onClick);
    buttons.appendChild(b);
  };
  mkButton('back', () => void host.pressBack());
  let offline = false;
  mkButton('net', () => {
    offline = !offline;
    host.setOffline(offline);
  });

  root.append(header, log, buttons);
  document.body.appendChild(root);

  const render = () => {
    header.textContent = `hoomi mock · ${host.scenario} · ${host.calls.length} calls · ${host.activeSubscriptionCount} subs${offline ? ' · OFFLINE' : ''}`;
    log.textContent = host.frames
      .slice(-8)
      .map((f) => `${f.dir === 'in' ? '→' : f.dir === 'out' ? '←' : '⇠'} ${f.frame.slice(0, 110)}`)
      .join('\n');
  };
  render();
  const timer = setInterval(render, 500);

  return {
    destroy() {
      clearInterval(timer);
      root.remove();
    },
  };
}

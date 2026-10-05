import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

(globalThis as { window?: unknown }).window ??= {};

import { App } from '../../app/renderer/src/App';
import { createDestinationRouteRouter } from '../../app/electron/deep-link';
import { DESTINATION_ROUTE_APPLIES, formatDestinationRoute, type DestinationRoute } from '../../shared/destination-route';
import { checkDestinationRouteWiring } from '../../scripts/destination-route-wiring.mjs';
import { resolve } from 'node:path';

/** Drive the production router and renderer together. The older pending/onNavigate bridge
 * belonged to a separate parser; the shipped bridge is onDestination, with a main-process
 * latest-route buffer. The capture tuple is validated but only its destination is applied. */
function harness(withBridge = true) {
  let listener: ((route: DestinationRoute) => void) | undefined;
  let ready = false;
  const router = createDestinationRouteRouter((route) => {
    if (!ready || !listener) return false;
    listener(route);
    return true;
  });
  const win = (globalThis as { window: Record<string, unknown> }).window;
  win.addEventListener = () => undefined;
  win.removeEventListener = () => undefined;
  win.dingDesktop = withBridge ? { deepLink: {
    onDestination: (callback: (route: DestinationRoute) => void) => {
      listener = callback;
      return () => { listener = undefined; };
    },
  } } : undefined;
  const app = new App({}) as unknown as {
    state: Record<string, unknown>;
    setState(update: unknown): void;
    toast(message: string): void;
    listenForDestinationRoutes(): void;
    componentWillUnmount(): void;
  };
  const updates: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  app.setState = (update) => {
    const next = typeof update === 'function' ? update(app.state) : update;
    updates.push(next);
    app.state = { ...app.state, ...next };
  };
  app.toast = (message) => { toasts.push(message); };
  return {
    app, updates, toasts, router,
    mount: () => { app.listenForDestinationRoutes(); ready = true; router.flush(); },
    subscribed: () => listener !== undefined,
  };
}

test('a link queued before the renderer existed opens its screen and rail once ready', () => {
  const h = harness();
  assert.deepEqual(h.router.offer(formatDestinationRoute('cdr')), { ok: true, delivered: false });
  assert.equal(h.app.state.screen, 'dash');
  h.mount();
  assert.equal(h.app.state.screen, 'cdr');
  assert.equal(h.app.state.railId, 'data');
  assert.equal(h.router.pending(), undefined);
});

test('a live link opens its screen, while capture metadata leaves window settings alone', () => {
  const h = harness();
  h.mount();
  assert.deepEqual(h.router.offer(formatDestinationRoute('appearance', {
    state: 'paletteOpen', theme: 'light', width: 1920, height: 1080, scale: 2,
  })), { ok: true, delivered: true });
  assert.equal(h.app.state.screen, 'appearance');
  assert.equal(h.app.state.railId, 'app');
  assert.deepEqual(DESTINATION_ROUTE_APPLIES, ['destinationId']);
  for (const update of h.updates) {
    for (const key of ['theme', 'width', 'height', 'scale', 'paletteOpen']) assert.ok(!(key in update));
  }
});

test('a malformed route returns its refusal and does not displace the pending valid route', () => {
  const h = harness();
  h.router.offer(formatDestinationRoute('queues'));
  const refusal = h.router.offer('ding-pbx://destination/dash?theme=purple');
  assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.match(refusal.reason, /theme.*purple/u);
  assert.equal(h.app.state.screen, 'dash');
  h.mount();
  assert.equal(h.app.state.screen, 'queues');
});

test('an unknown destination is reported by the real catalogue without navigation', () => {
  const h = harness();
  h.mount();
  h.router.offer(formatDestinationRoute('nosuchscreen'));
  assert.deepEqual(h.updates.filter((update) => update.screen !== undefined), []);
  assert.ok(h.toasts.some((line) => line.includes("no destination called 'nosuchscreen'")));
});

test('the live listener is dropped on unmount and later routes cannot update a dead tree', () => {
  const h = harness();
  h.mount();
  assert.equal(h.subscribed(), true);
  h.app.componentWillUnmount();
  assert.equal(h.subscribed(), false);
  const count = h.updates.length;
  assert.deepEqual(h.router.offer(formatDestinationRoute('cdr')), { ok: true, delivered: false });
  assert.equal(h.updates.length, count);
});

test('a hosted surface with no deep-link bridge degrades without throwing', () => {
  const h = harness(false);
  h.mount();
  assert.equal(h.subscribed(), false);
  assert.deepEqual(h.toasts, []);
});

test('the main process registers, holds and forwards startup and live activations', () => {
  const result = checkDestinationRouteWiring({ root: resolve(import.meta.dirname, '../../..') });
  assert.deepEqual(result.problems, []);
  const main = readFileSync(new URL('../../app/electron/main.ts', import.meta.url), 'utf8');
  assert.match(main, /if \(launchRoute\) destinationRoutes\.offer\(launchRoute\);/u);
  assert.match(main, /if \(route\) destinationRoutes\.offer\(route\);/u);
  assert.match(main, /app\.on\('open-url',[\s\S]*?destinationRoutes\.offer\(url\);/u);
  assert.doesNotMatch(main, /mainWindow\.setContentSize\(/u);
});

test('both preloads expose the same live channel and remove their exact handler', () => {
  for (const file of ['preload.cjs', 'preload.ts']) {
    const text = readFileSync(new URL(`../../app/electron/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
    assert.match(text, /^\s*ipcRenderer\.on\('deep-link:destination', handler\);$/mu);
    assert.match(text, /^\s*return \(\) => ipcRenderer\.removeListener\('deep-link:destination', handler\);$/mu);
  }
});

test('the renderer subscribes on mount and the newest startup destination wins', () => {
  const app = readFileSync(new URL('../../app/renderer/src/App.tsx', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  assert.match(app, /^\s*this\.listenForDestinationRoutes\(\);$/mu);
  const h = harness();
  h.router.offer(formatDestinationRoute('cdr'));
  h.router.offer(formatDestinationRoute('queues'));
  h.mount();
  assert.equal(h.app.state.screen, 'queues');
  assert.equal(h.updates.filter((update) => update.screen !== undefined).length, 1);
});

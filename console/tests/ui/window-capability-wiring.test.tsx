import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../../app/renderer/src/App';
import { installHttpBridge } from '../../app/renderer/src/bridge/http-bridge';

function app() {
  const instance = new App({}) as any;
  instance.state = { ...instance.state, onboardOpen: false };
  return instance;
}

test('the real hosted bridge does not render fake native window controls', () => {
  (globalThis as { window?: unknown }).window = {};
  installHttpBridge();
  const instance = app();
  assert.equal(instance.renderVals().hasWindowControls, false);
  const html = renderToStaticMarkup(instance.render());
  assert.ok(!html.includes('data-window-button'));
  assert.ok(html.includes('role="banner"'), 'browser retains the real application menus and title');
});

test('a missing preload does not render native actions without a target', () => {
  (globalThis as { window?: unknown }).window = {};
  const instance = app();
  assert.equal(instance.renderVals().hasWindowControls, false);
  assert.ok(!renderToStaticMarkup(instance.render()).includes('data-window-button'));
});

for (const platform of ['win32', 'linux', 'darwin']) test(`${platform} desktop titlebar retains named keyboard buttons and real bridge calls`, () => {
  const calls: string[] = [];
  (globalThis as { window?: unknown }).window = { dingDesktop: { platform, window: {
    minimize: () => calls.push('minimize'), toggleMaximize: () => calls.push('maximize'), close: () => calls.push('close'),
  } } };
  const instance = app();
  const values = instance.renderVals();
  assert.equal(values.hasWindowControls, true);
  const html = renderToStaticMarkup(instance.render());
  assert.equal((html.match(/data-window-button/gu) ?? []).length, 3);
  for (const label of ['Minimize', 'Maximize', 'Close']) assert.ok(html.includes(`<button type="button" aria-label="${label}"`));
  values.__window.minimize(); values.__window.toggleMaximize(); values.__window.close();
  assert.deepEqual(calls, ['minimize', 'maximize', 'close']);
});

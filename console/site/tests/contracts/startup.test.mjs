import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { PAGE_NAMES } from './site-pages.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = readFileSync(join(siteRoot, 'app.js'), 'utf8').replaceAll('\r\n', '\n');
const css = readFileSync(join(siteRoot, 'styles.css'), 'utf8');

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  const body = app.indexOf('{', app.indexOf(')', start));
  let depth = 0;
  for (let index = body; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}' && --depth === 0) return app.slice(start, index + 1);
  }
  throw new Error(`${name} is not brace-balanced`);
}

test('build timestamps format with the real Intl implementation', () => {
  const format = new Function(`${functionSource('formatBuildTime')};return formatBuildTime;`)();
  const formatted = format('2026-10-15T10:30:45.000Z');
  assert.equal(typeof formatted, 'string');
  assert.ok(formatted.length > 8);
  assert.notEqual(formatted, 'updated-at unavailable');
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date('2026-10-15T10:30:45.000Z')).find(part => part.type === 'timeZoneName').value;
  assert.ok(formatted.includes(zone), 'the local time-zone label was lost');
  assert.equal(format('not a date'), 'updated-at unavailable');
  assert.equal(format(''), 'updated-at unavailable');
});

test('static content is visible before reveal enhancement starts', () => {
  const defaultRule = css.match(/(?:^|\n)\.reveal\{([^}]+)\}/u)?.[1];
  assert.ok(defaultRule, 'the default reveal rule is missing');
  assert.match(defaultRule, /opacity:1(?:;|$)/u);
  assert.match(defaultRule, /transform:none(?:;|$)/u);
});

function revealHarness({ reduced = false, observer = 'silent' } = {}) {
  const items = Array.from({ length: 3 }, () => {
    const classes = new Set(['reveal']);
    return { classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
    } };
  });
  const timers = [];
  const observers = [];
  const all = selector => items.filter(item =>
    !(selector.includes(':not(.visible)') && item.classList.contains('visible')) &&
    !(selector.includes(':not(.reveal-pending)') && item.classList.contains('reveal-pending')));
  class Observer {
    constructor(callback) {
      if (observer === 'constructor-error') throw new Error('observer construction failed');
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(item) {
      assert.equal(item.classList.contains('reveal-pending'), false, 'content was hidden before registration');
      if (observer === 'observe-error' && this.observed.length === 1) throw new Error('observer registration failed');
      this.observed.push(item);
    }
    unobserve() { if (observer === 'callback-error') throw new Error('observer cleanup failed'); }
    disconnect() { this.disconnected = true; }
  }
  const window = observer === 'missing' ? {} : { IntersectionObserver: Observer };
  const init = new Function('all', 'reduceMotion', 'window', 'IntersectionObserver', 'setTimeout', 'clearTimeout',
    `${functionSource('initReveals')};return initReveals;`)(
    all, () => reduced, window, Observer,
    (handler, ms) => { timers.push({ handler, ms }); return timers.length; }, () => {},
  );
  return { items, timers, observers, init };
}

test('reveal enhancement fails open when motion or observation is unavailable', () => {
  for (const options of [{ reduced: true }, { observer: 'missing' }, { observer: 'constructor-error' }, { observer: 'observe-error' }]) {
    const harness = revealHarness(options);
    assert.doesNotThrow(harness.init);
    assert.ok(harness.items.every(item => item.classList.contains('visible')));
    assert.ok(harness.items.every(item => !item.classList.contains('reveal-pending')));
  }
});

test('a silent observer has a bounded fallback and repeated setup does not hide content again', () => {
  const harness = revealHarness();
  harness.init();
  assert.ok(harness.items.every(item => item.classList.contains('reveal-pending')));
  assert.equal(harness.timers.length, 1);
  assert.ok(harness.timers[0].ms > 0 && harness.timers[0].ms <= 2500);
  harness.init();
  assert.equal(harness.observers.length, 1, 'pending items were registered again');
  harness.timers[0].handler();
  assert.ok(harness.items.every(item => item.classList.contains('visible') && !item.classList.contains('reveal-pending')));
  assert.equal(harness.observers[0].disconnected, true);
  harness.init();
  assert.equal(harness.observers.length, 1, 'visible items were hidden again');
});

test('an intersection reveals an item immediately', () => {
  const harness = revealHarness();
  harness.init();
  harness.observers[0].callback([{ target: harness.items[0], isIntersecting: true }]);
  assert.equal(harness.items[0].classList.contains('visible'), true);
  assert.equal(harness.items[0].classList.contains('reveal-pending'), false);
});

test('an observer callback failure immediately restores every pending item', () => {
  const harness = revealHarness({ observer: 'callback-error' });
  harness.init();
  assert.doesNotThrow(() => harness.observers[0].callback([{ target: harness.items[0], isIntersecting: true }]));
  assert.ok(harness.items.every(item => item.classList.contains('visible') && !item.classList.contains('reveal-pending')));
  assert.equal(harness.observers[0].disconnected, true);
});

// A DOM integration test, not a visual browser test. Layout and canvas are not
// measured here; Intl and the full composed application startup are left intact.
test('composed pages boot with a real build identity and stay readable after startup failures', async () => {
  execFileSync(process.execPath, [join(siteRoot, 'build.mjs')], {
    cwd: resolve(siteRoot, '..', '..'), stdio: 'pipe',
    env: { ...process.env, DING_PBX_SITE_RELEASE_MANIFEST: join(siteRoot, '__absent_startup_test_manifest__.json') },
  });
  const dist = join(siteRoot, 'dist');
  const identity = JSON.parse(await readFile(join(dist, 'version.json'), 'utf8'));
  const composedApp = await readFile(join(dist, 'app.js'), 'utf8');
  assert.match(identity.commit, /^[0-9a-f]{40}$/u, 'exercise composed output, not the empty source identity');
  const cases = [
    ...PAGE_NAMES.map(page => ({ page, mode: 'normal' })),
    ...['no-script', 'early-failure', 'late-failure', 'silent-observer', 'broken-observer'].map(mode => ({ page: 'index', mode })),
  ];
  for (const { page, mode } of cases) {
    const label = `${page}/${mode}`;
    const dom = new JSDOM(await readFile(join(dist, `${page}.html`), 'utf8'), {
      url: `https://ding-ding-projects.github.io/material-asterisk/${page}.html`,
      runScripts: 'outside-only', pretendToBeVisual: true,
    });
    try {
      const { window } = dom;
      const style = window.document.createElement('style');
      style.textContent = css;
      window.document.head.append(style);
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.fetch = () => Promise.reject(new Error('network omitted from startup contract'));
      window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
      const timers = [];
      window.setTimeout = (handler, ms) => { timers.push({ handler, ms }); return timers.length; };
      window.clearTimeout = () => {};
      if (mode === 'early-failure') window.Intl.DateTimeFormat = function () { throw new Error('Injected early failure'); };
      if (mode === 'late-failure' || mode === 'silent-observer') {
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      }
      if (mode === 'late-failure') window.HTMLCanvasElement.prototype.getContext = () => { throw new Error('Injected late failure'); };
      if (mode === 'broken-observer') {
        let attempts = 0;
        window.IntersectionObserver = class {
          constructor() { if (++attempts === 1) throw new Error('Injected observer failure'); }
          observe() {} unobserve() {} disconnect() {}
        };
      }
      let startupError;
      if (mode !== 'no-script') {
        try { window.eval(composedApp); } catch (error) { startupError = error; }
      }
      if (mode === 'normal' || mode === 'silent-observer' || mode === 'broken-observer') {
        assert.equal(startupError, undefined, `${label}: ${startupError?.stack}`);
        assert.ok(window.document.querySelector('.site-build-identity')?.textContent.includes(identity.commit), `${label}: the composed identity did not reach the page`);
        assert.equal(typeof window.document.getElementById('nav-toggle')?.onclick, 'function', `${label}: startup stopped before navigation was wired`);
      }
      if (mode === 'early-failure' || mode === 'late-failure') {
        assert.match(startupError?.message || '', /Injected/u, `${label}: the intended failure was not exercised`);
      }
      // Advance only the reveal fallback. Other startup timers and network results
      // are outside this contract, and must not be mistaken for browser evidence.
      for (const timer of timers) if (timer.ms === 2000) timer.handler();
      const items = [...window.document.querySelectorAll('.reveal')];
      if (page === 'index') assert.ok(items.length >= 5, `${label}: the landing content was not measured`);
      assert.equal(window.document.querySelectorAll('.reveal-pending').length, 0, `${label}: pending state was stranded`);
      for (const item of items) assert.equal(window.getComputedStyle(item).opacity, '1', `${label}: static content is still hidden`);
      await Promise.resolve();
    } finally { dom.window.close(); }
  }
});

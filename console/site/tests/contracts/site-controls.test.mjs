import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { siteRoot, PAGE_NAMES } from './site-pages.mjs';
import { join } from 'node:path';

const app = readFileSync(join(siteRoot, 'app.js'), 'utf8');
const css = readFileSync(join(siteRoot, 'styles.css'), 'utf8');

// These are DOM and CSS contracts, not browser layout or mobile-device evidence.
function page(name = 'settings', width = 1180) {
  const dom = new JSDOM(readFileSync(join(siteRoot, `${name}.html`), 'utf8'), {
    url: `https://example.test/${name}.html`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const style = window.document.createElement('style');
  style.textContent = css;
  window.document.head.append(style);
  // jsdom does not apply viewport media queries. Select the shipped max-width
  // rules explicitly so narrow-layout display contracts are still exercised.
  const active = [...style.sheet.cssRules].flatMap(rule => {
    if (!rule.conditionText) return [rule.cssText];
    const max = /^\(max-width:\s*(\d+)px\)$/.exec(rule.conditionText);
    return max && width <= Number(max[1]) ? [...rule.cssRules].map(child => child.cssText) : [];
  });
  style.textContent = active.join('\n');
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.fetch = () => Promise.reject(new Error('network excluded from this contract'));
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.setTimeout = () => 1;
  window.clearTimeout = () => {};
  window.eval(app);
  const document = window.document;
  const cards = () => [...document.querySelectorAll('.setting-card')];
  const visible = () => cards().filter(card => window.getComputedStyle(card).display !== 'none');
  const headings = () => visible().map(card => card.querySelector('h2').textContent);
  const search = query => {
    const field = document.getElementById('settings-search');
    field.focus();
    field.value = query;
    field.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: query ? 'insertText' : 'deleteContentBackward' }));
  };
  return { dom, window, document, cards, visible, headings, search };
}

test('filtered-card styles override the authored flex display', () => {
  // jsdom alone can give hidden precedence over flex unlike the real browser.
  // Keep this explicit cascade regression beside the behavioral assertions.
  assert.match(css, /\.setting-card\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/);
});

test('settings filter hides actual cards and matches visible headings and search aliases', () => {
  const p = page();
  try {
    assert.equal(p.cards().length, 18);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const [query, heading] of [['Published version', 'Published version'], ['logo studio', 'Logo studio'], ['tts', 'Spoken narration'], ['  TEXT SIZE  ', 'Text size']]) {
        p.search(query);
        assert.deepEqual(p.headings(), [heading], `${query}: the real visible result must match`);
        assert.equal(p.document.activeElement.id, 'settings-search', 'filtering must not move keyboard focus');
        assert.equal(p.document.getElementById('settings-filter-status').textContent, ' — 1 of 18 settings');
        p.search('');
        assert.equal(p.visible().length, 18, 'clearing must restore every card');
      }
    }
    p.search('no-setting-matches-this-value');
    assert.deepEqual(p.headings(), []);
    assert.equal(p.document.getElementById('settings-filter-status').textContent, ' — No settings match');
    p.search('   ');
    assert.equal(p.visible().length, 18);
  } finally { p.dom.window.close(); }
});

test('settings regex can match an exact visible heading and clearing the pattern restores plain search', () => {
  const p = page();
  try {
    const d = p.document;
    d.querySelector('[data-regex-for="settings-search"]').click();
    assert.equal(d.getElementById('regex-dialog').open, true);
    d.getElementById('regex-pattern').value = '^Published version$';
    d.getElementById('regex-apply').click();
    assert.deepEqual(p.headings(), ['Published version']);
    assert.equal(d.getElementById('regex-dialog').open, false);
    p.search('unrelated plain text');
    assert.deepEqual(p.headings(), ['Published version'], 'enabled regex remains the declared search mode');
    d.querySelector('[data-regex-for="settings-search"]').click();
    d.getElementById('regex-pattern').value = '';
    d.getElementById('regex-apply').click();
    assert.deepEqual(p.headings(), [], 'disabling regex restores the typed query');
    p.search('');
    assert.equal(p.visible().length, 18);
  } finally { p.dom.window.close(); }
});

test('all page headers keep build identity outside the navigation row', () => {
  for (const name of PAGE_NAMES) {
    const p = page(name);
    try {
      const identity = p.document.querySelector('.site-build-identity');
      assert.equal(p.document.querySelectorAll('.site-build-identity').length, 1);
      assert.equal(identity.previousElementSibling, p.document.querySelector('.topbar'));
      assert.equal(p.window.getComputedStyle(identity).overflowWrap, 'anywhere');
      assert.equal(p.document.querySelector('.brand .site-build-identity'), null);
    } finally { p.dom.window.close(); }
  }
});

test('narrow layout keeps search and actions available and exposes all nine navigation destinations', () => {
  for (const width of [320, 375, 720, 1100, 1180, 1600]) {
    const p = page('settings', width);
    try {
      const { document: d, window: w } = p;
      const nav = d.getElementById('site-nav'), toggle = d.getElementById('nav-toggle'), search = d.getElementById('palette-open');
      assert.equal(w.getComputedStyle(nav).display, 'none', `${width}: navigation must collapse`);
      assert.equal(w.getComputedStyle(nav).position, 'absolute');
      assert.equal(w.getComputedStyle(nav).top, '100%', 'dropdown must follow the actual header height');
      assert.equal(w.getComputedStyle(nav).overflow, 'auto', 'all links remain reachable in short viewports');
      for (const node of [toggle, search, d.getElementById('notification-open')]) {
        assert.notEqual(w.getComputedStyle(node).display, 'none', `${width}: header action was hidden`);
        assert.equal(node.disabled, false);
      }
      assert.match(search.getAttribute('aria-label'), /Search destinations/);
      if (width <= 720) assert.equal(w.getComputedStyle(search.querySelector('.command-label')).display, 'none');
      for (let repeat = 0; repeat < 3; repeat += 1) {
        toggle.click();
        assert.equal(w.getComputedStyle(nav).display, 'flex');
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        const links = [...nav.querySelectorAll('a')];
        assert.deepEqual(links.map(link => link.textContent), ['Home', 'Product', 'Documentation', 'Converter', 'Downloads', 'Status', 'Settings', 'Ollama', 'History']);
        assert.equal(d.activeElement, links[0]);
        links.at(-1).focus();
        links.at(-1).dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        assert.equal(w.getComputedStyle(nav).display, 'none');
        assert.equal(toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(d.activeElement, toggle, 'Escape must return focus to the visible trigger');
        toggle.click();
        links[0].addEventListener('click', event => event.preventDefault(), { once: true });
        links[0].click();
        assert.equal(w.getComputedStyle(nav).display, 'none', 'pointer destination click closes the menu');
      }
      search.click();
      assert.equal(d.getElementById('command-palette').open, true, 'compact search still opens the real palette');
      d.getElementById('command-palette').close();
      d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
      assert.equal(d.getElementById('command-palette').open, true, 'keyboard search still works');
      assert.equal(w.getComputedStyle(d.querySelector('.brand')).minWidth, '0px');
      assert.equal(w.getComputedStyle(d.querySelector('.top-actions')).flexShrink, '0');
    } finally { p.dom.window.close(); }
  }
});


test('Escape across an open navigation and native modal restores a visible focus target', () => {
  const p = page('settings', 320);
  try {
    const d=p.document,w=p.window,toggle=d.getElementById('nav-toggle'),nav=d.getElementById('site-nav');
    toggle.click();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, bubbles: true }));
    const dialog=d.getElementById('command-palette');
    assert.equal(dialog.open,true);
    d.getElementById('palette-search').focus();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(nav.classList.contains('open'),false);
    // Native dialogs restore their previous focus before emitting close. That
    // target can now be in the hidden menu, so the close listener must repair it.
    d.getElementById('palette-search').focus();
    assert.notEqual(d.activeElement,toggle,'the close event must perform the focus repair');
    dialog.close();
    assert.equal(d.activeElement,toggle);
  } finally { p.dom.window.close(); }
});

test('the optional timer cannot crowd the actions or display an empty hidden chip', () => {
  const p=page();
  try {
    const timer=p.document.getElementById('session-timer');
    assert.equal(timer.previousElementSibling,p.document.querySelector('.site-build-identity'));
    assert.equal(timer.hidden,true);
    assert.equal(p.window.getComputedStyle(timer).display,'none');
    assert.match(css,/\.site-build-identity\+\.session-timer:not\(\[hidden\]\)\{/);
    const checkbox=p.document.getElementById('attention-time-awareness');
    checkbox.click();
    assert.equal(timer.hidden,false);
    assert.match(timer.textContent,/On this page:/);
    assert.notEqual(p.window.getComputedStyle(timer).display,'none');
    checkbox.click();
    assert.equal(timer.hidden,true);
    assert.equal(p.window.getComputedStyle(timer).display,'none');
  } finally { p.dom.window.close(); }
});

test('compact search has a no-script sizing fallback', () => {
  assert.match(css,/\.command-button\{padding:0;min-width:var\(--touch\);font-size:0\}/);
  assert.match(css,/\.command-button kbd\{display:none\}/);
  assert.match(css,/\.command-button::before\{content:"⌕";font-size:1\.5rem\}/);
});

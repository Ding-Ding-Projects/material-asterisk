import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../../app/renderer/src/App';

(globalThis as { window?: unknown }).window ??= {};

const triggers = [
  { id: 'tab-search-strip', icon: 'search', label: 'Search this tab strip', scope: 'strip' },
  { id: 'tab-search-groups', icon: 'group_work', label: 'Search tab groups', scope: 'groups' },
  { id: 'tab-search-master', icon: 'travel_explore', label: 'Search every open tab', scope: 'master' },
] as const;

function createApp(): any {
  const app = new App({}) as any;
  app.state = { ...app.state, onboardOpen: false };
  app.updater = {
    enqueueForceUpdate() {},
    enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    },
  };
  return app;
}

function findId(node: any, id: string): any {
  if (!node || typeof node !== 'object') return undefined;
  if (node.props?.id === id) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const found = findId(child, id);
    if (found) return found;
  }
  return undefined;
}

for (const trigger of triggers) {
  test(`${trigger.id} applies the bundled icon font to its ligature`, () => {
    const button = findId(createApp().render(), trigger.id);
    assert.ok(button, 'the real rendered button is present');
    const icon = button.props.children;
    assert.equal(icon.type, 'span');
    assert.equal(icon.props.className, 'msym');
    assert.equal(icon.props.children, trigger.icon);
    assert.match(renderToStaticMarkup(button), /class="msym"/u);
  });

  test(`${trigger.id} has an accessible action name instead of announcing the ligature`, () => {
    const button = findId(createApp().render(), trigger.id);
    assert.equal(button.props.type, 'button');
    assert.equal(button.props['aria-label'], trigger.label);
    assert.equal(button.props.title, trigger.label);
    assert.equal(button.props.children.props['aria-hidden'], true);
    assert.match(renderToStaticMarkup(button), /aria-hidden="true"/u);
  });

  test(`${trigger.id} still opens its original search scope`, () => {
    const app = createApp();
    findId(app.render(), trigger.id).props.onClick({});
    assert.equal(app.state.tabSearchOpen, true);
    assert.equal(app.state.tabSearchScope, trigger.scope);
  });
}

test('the shared icon class and local font face name agree', () => {
  const styles = readFileSync(new URL('../../app/renderer/src/generated/design-styles.css', import.meta.url), 'utf8');
  const fonts = readFileSync(new URL('../../assets/fonts/fonts.css', import.meta.url), 'utf8');
  assert.match(styles, /\.msym\s*\{[^}]*font-family:\s*['"]Material Symbols Outlined['"]/u);
  assert.match(fonts, /font-family:\s*['"]Material Symbols Outlined['"]/u);
  assert.match(fonts, /material-symbols-outlined-100-700-0\.woff2/u);
});

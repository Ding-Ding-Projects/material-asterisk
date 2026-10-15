import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { App } from '../../app/renderer/src/App';
import M3Control from '../../app/renderer/src/generated/m3-control';
import { createControlPlaneDispatcher } from '../../control-plane/dispatch';
import { connectionFormControls, connectionInput } from '../../app/renderer/src/server-connection-form';

(globalThis as { window?: unknown }).window ??= {};
const discovery = { wsl: ['Verified-Distribution'], containers: [] };
function harness() {
  const app = new App({}) as any;
  app.updater = {
    enqueueForceUpdate() {},
    enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    },
  };
  app.target = { id: 'prior-target', label: 'Prior target', connected: true };
  app.state = { ...app.state, screen: 'servers', onboardOpen: true, onboardStep: 4, values: {} };
  app.connectionDiscovery = discovery;
  const messages: string[] = [];
  app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
  app.toast = () => {};
  return { app, messages };
}

async function withDispatcher(run: (h: ReturnType<typeof harness>, dispatcher: ReturnType<typeof createControlPlaneDispatcher>, requests: any[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'server-form-'));
  try {
    const dispatcher = createControlPlaneDispatcher({ userDataPath: root, resourcesPath: root, hosted: true });
    const h = harness();
    const requests: any[] = [];
    h.app.bridge = () => ({ controlPlane: { request: async (request: any) => {
      requests.push(request);
      if (request.action === 'server.list') return { ok: true, requestId: request.requestId, data: discovery };
      return dispatcher.controlPlaneRequest(request);
    } } });
    await run(h, dispatcher, requests);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(root, { recursive: true, force: true });
  }
}

test('Local Add supplies the selected discovered distribution to the real inventory validator', async () => {
  await withDispatcher(async ({ app, messages }, dispatcher, requests) => {
    app.state.values = { sv_kind: 'Local', sv_distribution: 'Verified-Distribution', sv_name: 'Chosen target' };
    await app.onAddServer();
    assert.equal(dispatcher.serverInventory().list().length, 1);
    assert.equal(dispatcher.serverInventory().list()[0]!.wslDistribution, 'Verified-Distribution');
    assert.equal(requests.some((request) => request.action === 'server.connect'), false);
    assert.match(messages.join('\n'), /Connection added/u);
    assert.ok(!messages.some((message) => message.startsWith('Connected:')));
  });
});

test('a missing or invented WSL distribution never reaches inventory.add', async () => {
  await withDispatcher(async ({ app, messages }, dispatcher, requests) => {
    for (const value of ['', 'Invented-Distribution']) {
      app.state.values = { sv_kind: 'Local', sv_distribution: value };
      await app.onAddServer();
    }
    assert.equal(dispatcher.serverInventory().list().length, 0);
    assert.equal(requests.some((request) => request.action === 'server.inventory.add'), false);
    assert.match(messages.join('\n'), /current discovery result/u);
  });
});

for (const type of ['SSH', 'Local Docker', 'SSH Docker']) test(`${type} stored form values cannot add, probe, activate or claim a connection`, async () => {
  await withDispatcher(async ({ app, messages }, dispatcher, requests) => {
    for (const prefix of ['ob', 'sv']) {
      app.state.values = { [`${prefix === 'ob' ? 'ob_where' : 'sv_kind'}`]: type, [`${prefix}_distribution`]: 'Verified-Distribution', [`${prefix}_host`]: 'pbx.example.invalid', [`${prefix}_user`]: 'operator', [`${prefix}_project`]: 'saved-project' };
      if (prefix === 'ob') await app.onboardConnect(); else await app.onAddServer();
    }
    assert.equal(dispatcher.serverInventory().list().length, 0);
    assert.equal(requests.length, 0, 'unsupported types must be refused before discovery or connection work');
    assert.equal(app.target.id, 'prior-target');
    assert.equal(app.state.onboardOpen, true);
    assert.match(messages.join('\n'), /connections are unavailable in this build/u);
    assert.ok(!messages.some((message) => message.startsWith('Connected:')));
  });
});

test('the real inventory error remains visible instead of a generic add refusal', async () => {
  await withDispatcher(async ({ app, messages }, dispatcher) => {
    dispatcher.serverInventory().add({ name: 'Existing profile', connectionKind: 'wsl', wslDistribution: 'Verified-Distribution' });
    app.state.values = { sv_kind: 'Local', sv_distribution: 'Verified-Distribution' };
    await app.onAddServer();
    assert.equal(dispatcher.serverInventory().list().length, 1);
    assert.match(messages.join('\n'), /Existing profile.*already points at the same target/u);
  });
});

test('onboarding cannot submit twice while discovery is pending', async () => {
  const { app, messages } = harness();
  app.state.values = { ob_where: 'This machine' };
  let release!: (value: any) => void;
  let reads = 0;
  app.request = () => { reads++; return new Promise((resolve) => { release = resolve; }); };
  const first = app.onboardConnect();
  await app.onboardConnect();
  assert.equal(reads, 1);
  release({ ok: true, data: discovery });
  await first;
  assert.match(messages.join('\n'), /Choose a WSL distribution/u);
  assert.equal(app.connectionBusy, false);
});

test('real connection fields are editable controls and never contain design sample hosts', () => {
  const { app } = harness();
  const controls = connectionFormControls('ob', { ob_where: 'This machine' }, discovery);
  for (const id of ['ob_name']) {
    const control = controls.find((candidate) => candidate.id === id)!;
    const built = app.buildCtl(control);
    const html = renderToStaticMarkup(createElement(M3Control, { ctl: built }));
    assert.match(html, /<input/u);
    assert.ok(html.includes(`aria-label="${control.label}"`));
    built.set('operator-entered');
    assert.equal(app.state.values[id], 'operator-entered');
  }
  assert.ok(!JSON.stringify(controls).includes('pbx-hq.internal'));
});

test('the visible connection controls offer WSL only and explain unsupported transports beside the selector', () => {
  const { app } = harness();
  for (const prefix of ['sv', 'ob'] as const) {
    const controls = connectionFormControls(prefix, {}, discovery);
    assert.deepEqual(controls[0].options, [prefix === 'sv' ? 'Local' : 'This machine']);
    assert.deepEqual(controls.map((c) => c.id), [prefix === 'sv' ? 'sv_kind' : 'ob_where', `${prefix}_name`, `${prefix}_distribution`]);
  }
  app.state.onboardStep = 2;
  const values = app.renderVals();
  assert.match(values.onboardBody, /SSH, Docker and native Linux connections are unavailable/u);
  assert.match(JSON.stringify(values.groups), /SSH, Docker and native Linux connections are unavailable/u);
  assert.ok(!JSON.stringify(values.groups).includes('Manager interface'));
});

test('native Linux discovery does not claim a connection type this build cannot probe', () => {
  assert.throws(() => connectionInput('sv', {}, { localLinux: { available: true } }), /Choose a WSL distribution/u);
  assert.deepEqual(connectionInput('sv', { sv_distribution: 'Verified-Distribution' }, { ...discovery, localLinux: { available: true } }), {
    name: 'Verified-Distribution', connectionKind: 'wsl', wslDistribution: 'Verified-Distribution',
  });
});

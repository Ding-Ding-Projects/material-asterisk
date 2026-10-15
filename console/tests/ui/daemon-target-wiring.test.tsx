import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../app/renderer/src/App';
import { createControlPlaneDispatcher } from '../../control-plane/dispatch';

(globalThis as { window?: unknown }).window ??= {};

function harness() {
  const app = new App({}) as any;
  app.updater = {
    enqueueForceUpdate() {},
    enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    },
  };
  app.target = { id: 'target-a', label: 'Target A', connected: true };
  const messages: string[] = [];
  app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
  app.toast = () => {};
  return { app, messages };
}

// The renderer talks to the actual dispatcher here. No bridge accepts a malformed
// request, and a missing target is rejected before any external process can run.
test('daemon controls carry the registered target through real dispatcher validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-target-wiring-'));
  try {
    const dispatcher = createControlPlaneDispatcher({ userDataPath: root, resourcesPath: root, hosted: true });
    const registered = dispatcher.serverInventory().add({ name: 'Unconnected test target', connectionKind: 'remoteLinux', host: 'pbx.example.invalid', user: 'asterisk' });
    const missing = await dispatcher.controlPlaneRequest({ requestId: 'missing', action: 'daemon.status' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.message, /Select a server first/u);
    const { app, messages } = harness();
    app.target.id = registered.id;
    const requests: any[] = [];
    app.bridge = () => ({ controlPlane: { request: async (request: any) => {
      requests.push(request);
      return dispatcher.controlPlaneRequest(request);
    } } });
    await app.ensureDaemon();
    await app.refreshDaemonStatus();
    for (const verb of ['start', 'stop', 'restart']) await app.daemonAction(verb);
    assert.ok(requests.length >= 5);
    assert.ok(requests.every((request) => request.serverId === registered.id));
    assert.ok(['daemon.status', 'daemon.start', 'daemon.stop', 'daemon.restart'].every((action) => requests.some((request) => request.action === action)));
    assert.ok(!messages.join('\n').includes('Select a server first'));
    assert.ok(!messages.join('\n').includes('Phone system started'));
  } finally {
    // Dispatcher startup initializes local stores asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic start stays scoped to the target whose stopped status was read', async () => {
  const { app } = harness();
  const calls: any[] = [];
  app.request = async (action: string, extra: any) => {
    calls.push({ action, ...extra });
    return { ok: true, data: { status: { state: action === 'daemon.start' ? 'daemonAnswering' : 'daemonNotRunning' } } };
  };
  await app.ensureDaemon();
  assert.ok(calls.some((request) => request.action === 'daemon.start'));
  assert.ok(calls.every((request) => request.serverId === 'target-a'));
});

test('automatic start is abandoned if selection changes while status is pending', async () => {
  const { app } = harness();
  const calls: string[] = [];
  app.request = async (action: string) => {
    calls.push(action);
    app.target = { id: 'target-b', label: 'Target B', connected: true };
    return { ok: true, data: { status: { state: 'daemonNotRunning' } } };
  };
  await app.ensureDaemon();
  assert.deepEqual(calls, ['daemon.status']);
});

test('a late action response neither clears another target readings nor reports success', async () => {
  const { app, messages } = harness();
  const readings = { target: 'b' };
  app.request = async () => {
    app.target = { id: 'target-b', label: 'Target B', connected: true };
    app.readings = readings;
    return { ok: true };
  };
  await app.daemonAction('restart');
  assert.equal(app.readings, readings);
  assert.deepEqual(messages, []);
});

test('late and superseded status responses cannot overwrite the current reading', async () => {
  const { app } = harness();
  const pending: Array<(value: any) => void> = [];
  app.request = () => new Promise((resolve) => pending.push(resolve));
  const first = app.refreshDaemonStatus();
  const second = app.refreshDaemonStatus();
  pending[1]!({ ok: true, data: { status: { state: 'daemonAnswering' } } });
  await second;
  pending[0]!({ ok: true, data: { status: { state: 'daemonNotRunning' } } });
  await first;
  assert.equal(app.daemonStatusLine, 'Answering');
  const third = app.refreshDaemonStatus();
  app.target.id = 'target-b';
  pending[2]!({ ok: false, message: 'Old target unavailable.' });
  await third;
  assert.equal(app.daemonStatusLine, 'Answering');
});

test('no selected target never issues an untargeted status request', async () => {
  const { app } = harness();
  app.target.id = '';
  app.request = () => assert.fail('untargeted request');
  await app.ensureDaemon();
  await app.refreshDaemonStatus();
  assert.match(app.daemonStatusLine, /no target selected/u);
});

test('continuous slow polling still applies completed readings while newer requests remain pending', async () => {
  const { app } = harness();
  const pending: Array<(value: any) => void> = [];
  app.request = () => new Promise((resolve) => pending.push(resolve));
  const reads = [app.refreshDaemonStatus()];
  for (let index = 0; index < 5; index++) {
    reads.push(app.refreshDaemonStatus());
    pending[index]!({ ok: true, data: { status: { state: 'daemonNotRunning', reason: `Observed ${index}` } } });
    await reads[index];
    assert.match(app.daemonStatusLine, new RegExp(`Observed ${index}$`));
  }
  pending[5]!({ ok: true, data: { status: { state: 'daemonAnswering' } } });
  await reads[5];
  assert.equal(app.daemonStatusLine, 'Answering');
});

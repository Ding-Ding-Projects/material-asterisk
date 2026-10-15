import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { App } from '../../app/renderer/src/App';

(globalThis as { window?: unknown }).window ??= {};
function harness() {
  const app = new App({}) as any;
  app.updater = { enqueueForceUpdate() {}, enqueueSetState(instance: any, partial: any, callback?: () => void) {
    instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) }; callback?.();
  } };
  app.state = { ...app.state, screen: 'servers', credits: 3, ceremonyOpen: true, ceremonyTitle: 'Delete 1 objects', ceremonyCmd: 'delete selected-id', selected: ['selected-id'] };
  app.servers.servers = [{ id: 'selected-id', name: 'selected-row', connectionKind: 'wsl', wslDistribution: 'Selected', state: 'idle' }];
  app.target = { id: 'chosen-target', label: 'Chosen target', connected: true };
  app.ceremony(app.state.ceremonyTitle, app.state.ceremonyCmd);
  const messages: string[] = [];
  app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
  app.toast = () => {};
  return { app, messages };
}

test('the actual unsupported bulk delete result cannot spend a confirmation credit', async () => {
  const { app, messages } = harness();
  app.request = () => assert.fail('unsupported deletion must not send a command');
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(app.state.credits, 3);
  assert.match(messages.join('\n'), /no verified write executor/u);
  assert.ok(!messages.some((message) => /credit spent|completed command/u.test(message)));
  assert.deepEqual(app.state.selected, ['selected-id']);
});

test('a credit is deducted once only after an awaited command succeeds', async () => {
  const { app, messages } = harness();
  app.state.ceremonyTitle = 'Reload module';
  app.state.ceremonyCmd = 'module reload res_pjsip.so';
  let finish!: (value: any) => void;
  let count = 0;
  app.request = (_action: string, extra: any) => {
    count++;
    assert.equal(extra.serverId, 'chosen-target');
    return new Promise((resolve) => { finish = resolve; });
  };
  const skip = app.renderVals().skipCeremony;
  skip(); skip();
  assert.equal(app.state.credits, 3);
  assert.equal(count, 1);
  finish({ ok: true, data: { output: 'Reload complete' } });
  await setImmediate();
  assert.equal(app.state.credits, 2);
  assert.equal(messages.filter((message) => /credit spent/u.test(message)).length, 1);
});

for (const mode of ['refused', 'throwing', 'missing'] as const) test(`a ${mode} command does not spend a credit`, async () => {
  const { app, messages } = harness();
  app.state.ceremonyTitle = 'Reload module';
  app.state.ceremonyCmd = 'module reload res_pjsip.so';
  app.request = async () => {
    if (mode === 'throwing') throw new Error('Transport interrupted');
    return mode === 'missing' ? undefined : { ok: false, message: 'Target refused reload' };
  };
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(app.state.credits, 3);
  assert.equal(app.ceremonyPending, false);
  assert.ok(!messages.some((message) => /credit spent/u.test(message)));
});

test('an empty credit balance cannot execute a shortcut', async () => {
  const { app, messages } = harness();
  app.state.credits = 0;
  app.request = () => assert.fail('no credit');
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(app.state.ceremonyOpen, true);
  assert.match(messages.join('\n'), /No credits/u);
});

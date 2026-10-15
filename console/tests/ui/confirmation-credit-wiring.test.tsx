import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../app/renderer/src/App';
import { createControlPlaneDispatcher } from '../../control-plane/dispatch';
import { NodeProcessExecutor, type CommandRequest } from '../../control-plane/executor';

(globalThis as { window?: unknown }).window ??= {};

function harness(command = 'module unload res_pjsip.so', settings: Record<string, unknown> = {}, credits = 5) {
  const app = new App({}) as any;
  app.updater = { enqueueForceUpdate() {}, enqueueSetState(instance: any, partial: any, callback?: () => void) {
    instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) }; callback?.();
  } };
  app.state = { ...app.state, screen: 'modules', credits, values: { ...app.state.values, ...settings } };
  app.target = { id: 'Confirmation-Test', label: 'Confirmation test', connected: true };
  const messages: string[] = [];
  const requests: unknown[] = [];
  app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
  app.toast = () => {};
  app.request = async (action: string, extra: unknown) => { requests.push({ action, extra }); return { ok: true, data: { output: 'Completed' } }; };
  app.ceremony('Unrelated display title', command);
  return { app, messages, requests };
}

test('protected high-danger commands cannot use a displayed, direct or incomplete-confirmation callback', async () => {
  for (const command of ['module unload res_pjsip.so', 'core restart gracefully', 'delete extension-one', 'manager kick session 12', 'mixmonitor start PJSIP/one', 'unknown mutation']) {
    const { app, requests, messages } = harness(command);
    const values = app.renderVals();
    assert.equal(values.canSkip, false, command);
    values.skipCeremony();
    values.executeCeremony();
    await setImmediate();
    assert.equal(requests.length, 0, command);
    assert.equal(app.state.credits, 5);
    assert.equal(app.state.ceremonyOpen, true);
    assert.match(messages.join('\n'), /full confirmation/u);
    assert.match(messages.join('\n'), /Complete all four/u);
  }
});

test('a complete protected confirmation still runs normally without spending credits', async () => {
  const { app, requests } = harness();
  app.state.cStep = 4;
  app.renderVals().executeCeremony();
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(app.state.credits, 5);
});

for (const changedSettings of [{ cr_enable: false }, { cr_danger: true }, { cr_danger: null }, { cr_cost: 5 }, { cr_cost: '1' }]) {
  test(`a retained shortcut rechecks current settings ${JSON.stringify(changedSettings)}`, async () => {
    const { app, requests } = harness('module unload res_pjsip.so', { cr_danger: false }, 3);
    const previous = app.renderVals();
    assert.equal(previous.canSkip, true);
    assert.equal(previous.creditSkipLabel, 'Spend 2 confirmation credits and skip all four gates');
    app.state.values = { ...app.state.values, ...changedSettings };
    assert.equal(app.renderVals().canSkip, false);
    previous.skipCeremony();
    await setImmediate();
    assert.equal(requests.length, 0);
    assert.equal(app.state.credits, 3);
    assert.equal(app.state.ceremonyOpen, true);
  });
}

test('the current configured cost is charged exactly once, only after successful completion', async () => {
  const { app, messages } = harness('module reload res_pjsip.so', { cr_cost: 1 }, 6);
  const previous = app.renderVals();
  app.state.values = { ...app.state.values, cr_cost: 5 };
  assert.equal(app.renderVals().creditSkipLabel, 'Spend 5 confirmation credits and skip all four gates');
  let finish!: (value: unknown) => void;
  let calls = 0;
  app.request = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  previous.skipCeremony();
  previous.skipCeremony();
  assert.equal(calls, 1);
  assert.equal(app.state.credits, 6);
  // Changing the next operation's cost cannot change this accepted operation's debit.
  app.state.values = { ...app.state.values, cr_cost: 1 };
  finish({ ok: true, data: { output: 'Reloaded' } });
  await setImmediate();
  assert.equal(app.state.credits, 1);
  assert.equal(messages.filter((message) => /credit spent/u.test(message)).length, 1);
  assert.match(messages.join('\n'), /used 5 confirmation credits/u);
});

test('a new ceremony cannot reuse credits while a successful debit is queued by React', async () => {
  const { app, requests } = harness('module reload res_pjsip.so', {}, 1);
  const immediate = app.updater;
  const queued: Array<() => void> = [];
  app.updater = { ...immediate, enqueueSetState(instance: any, partial: any, callback?: () => void) {
    queued.push(() => immediate.enqueueSetState(instance, partial, callback));
  } };
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(requests.length, 1);
  assert.equal(app.state.credits, 1, 'the successful debit is still queued');
  assert.equal(app.reservedConfirmationCredits, 1);
  // A different ceremony is opened synchronously before the earlier queued debit commits.
  app.updater = immediate;
  app.ceremony('Second operation', 'module reload app_queue.so');
  assert.equal(app.renderVals().canSkip, false);
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(requests.length, 1);
  for (const update of queued) update();
  assert.equal(app.state.credits, 0);
  assert.equal(app.reservedConfirmationCredits, 0);
});

test('a failed request immediately releases its reservation for a later operation', async () => {
  const { app } = harness('module reload res_pjsip.so', {}, 1);
  app.request = async () => ({ ok: false, message: 'Refused' });
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(app.reservedConfirmationCredits, 0);
  assert.equal(app.state.credits, 1);
  app.ceremony('Try again', 'module reload res_pjsip.so');
  assert.equal(app.renderVals().canSkip, true);
});

for (const mode of ['refused', 'throwing', 'missing'] as const) test(`a ${mode} high-danger shortcut never debits credits`, async () => {
  const { app, messages } = harness('module unload res_pjsip.so', { cr_danger: false, cr_cost: 5 });
  app.request = async () => {
    if (mode === 'throwing') throw new Error('Transport interrupted');
    return mode === 'missing' ? undefined : { ok: false, message: 'Refused' };
  };
  app.renderVals().skipCeremony();
  await setImmediate();
  assert.equal(app.state.credits, 5);
  assert.ok(!messages.some((message) => /credit spent/u.test(message)));
});

test('the real dispatcher remains allowlisted behind the credit guard, with all process execution mocked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'confirmation-credit-'));
  const processes: CommandRequest[] = [];
  t.mock.method(NodeProcessExecutor.prototype, 'execute', async (request: CommandRequest) => {
    processes.push(request);
    assert.equal(request.executable, 'wsl.exe');
    const discovery = request.args.join(' ') === '--list --quiet';
    if (!discovery) assert.deepEqual(request.args, ['-d', 'Confirmation-Test', '--', 'asterisk', '-rx', 'module unload res_pjsip.so']);
    return { status: 'succeeded', exitCode: 0, stdout: discovery ? 'Confirmation-Test\n' : 'Unloaded\n', stderr: '', durationMs: 1 };
  });
  try {
    const dispatcher = createControlPlaneDispatcher({ userDataPath: root, resourcesPath: root, hosted: true });
    const { app } = harness();
    let requests = 0;
    let pending: Promise<unknown> | undefined;
    app.request = (action: any, extra: any) => {
      requests++;
      pending = dispatcher.controlPlaneRequest({ requestId: `credit-${requests}`, action, ...extra });
      return pending;
    };
    app.renderVals().skipCeremony();
    await setImmediate();
    assert.equal(requests, 0);
    assert.equal(processes.length, 0);
    app.state.values = { ...app.state.values, cr_danger: false };
    app.renderVals().skipCeremony();
    await pending;
    await setImmediate();
    assert.equal(requests, 1);
    assert.equal(processes.length, 2);
    assert.equal(app.state.credits, 3);
    app.ceremony('Harmless title', 'core restart gracefully');
    app.renderVals().skipCeremony();
    await pending;
    await setImmediate();
    assert.equal(requests, 2);
    assert.equal(processes.length, 2, 'an unsupported restart must not reach the process executor');
    assert.equal(app.state.credits, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

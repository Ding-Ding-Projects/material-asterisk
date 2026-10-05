import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { App } from '../../app/renderer/src/App';

(globalThis as { window?: unknown }).window ??= {};

function harness(options: { historyFails?: boolean; historyThrows?: boolean; applyFails?: boolean; switchAfterApply?: boolean; readResponse?: unknown; readThrows?: boolean } = {}) {
  const app = new App({}) as any;
  app.updater = {
    enqueueForceUpdate() {},
    enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    },
  };
  app.target = { id: 'synthetic-target', label: 'Synthetic target', connected: true };
  app.state = { ...app.state, values: { ob_phones: 2, ob_menu: true, ob_tls: false, ob_gates: 'Credits allowed' } };
  const calls: Array<{ action: string; extra: any }> = [];
  const spoken: string[] = [];
  const displayed: string[] = [];
  app.baseFire = (title: string, body: string) => displayed.push(`${title}: ${body}`);
  app.narrator.enqueue = (_kind: string, text: string) => spoken.push(text);
  app.request = async (action: string, extra: any = {}) => {
    calls.push({ action, extra });
    if (action === 'pbx.config') {
      if (options.readThrows) throw new Error('Synthetic configuration transport failure.');
      return Object.hasOwn(options, 'readResponse') ? options.readResponse : { ok: true, data: { state: 'present', value: [] } };
    }
    if (action === 'pbx.apply' && options.switchAfterApply) app.target = { id: 'different-target', label: 'Different target', connected: true };
    if (action === 'pbx.apply') return options.applyFails
      ? { ok: false, message: 'Synthetic apply refusal.' }
      : { ok: true, data: { result: { status: 'applied', backups: [{ resource: '/etc/asterisk/pjsip.conf', handle: '/etc/asterisk/pjsip.conf.backup-synthetic' }] } } };
    if (action === 'local-history.record') {
      if (options.historyThrows) throw new Error('Synthetic history transport failure.');
      return options.historyFails ? { ok: false, message: 'Synthetic history write refusal.' } : { ok: true, data: { id: 'synthetic-history-entry' } };
    }
    return { ok: true };
  };
  return {
    app, calls, spoken, displayed,
    gate: () => String(app.state.sureBody),
    async deploy() {
      await app.onboardDeploy();
      assert.equal(typeof app.state.sureAction, 'function', 'the real deploy must first ask for confirmation');
      app.renderVals().sureYes();
      for (let tries = 0; app.onboardBusy && tries < 30; tries++) await setImmediate();
      assert.equal(app.onboardBusy, false, 'the real deploy completed');
    },
    secrets(): string[] {
      const documents = calls.find((call) => call.action === 'pbx.apply')?.extra.payload.documents ?? [];
      return documents.flatMap((document: any) => document.value.flatMap((section: any) => section.entries.filter((entry: any) => entry.key === 'password').map((entry: any) => entry.value)));
    },
  };
}

test('a verified wizard deployment records a secret-free receipt in actual local history', async () => {
  const h = harness();
  await h.deploy();
  const recorded = h.calls.filter((call) => call.action === 'local-history.record');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].extra.payload.action, 'updated');
  assert.match(recorded[0].extra.payload.subject, /deploy/iu);
  for (const secret of h.secrets()) {
    assert.ok(!JSON.stringify(recorded).includes(secret));
    assert.ok(!h.gate().includes(secret));
  }
  assert.match(h.displayed.join('\n'), /recorded in local history/iu);
  assert.match(h.displayed.join('\n'), /Configuration backups/u);
});

test('extension secrets appear once in a dismissible dialog and never in notification history or narration', async () => {
  const h = harness();
  await h.deploy();
  assert.equal(h.secrets().length, 2);
  for (const secret of h.secrets()) {
    assert.ok(!JSON.stringify(h.app.notificationHistory).includes(secret), 'notification history must exclude credentials');
    assert.ok(!h.spoken.join('\n').includes(secret), 'automatic narration must exclude credentials');
    assert.ok(!h.displayed.join('\n').includes(secret), 'outcome notices must exclude credentials');
    assert.ok(String(h.app.state.infoBody).includes(secret), 'the original generated credential is still available once');
  }
  assert.equal(h.app.state.infoOpen, true);
  assert.equal(h.app.state.sureAction, null, 'the accepted gate must release its secret-bearing callback');
  h.app.renderVals().closeInfo();
  assert.equal(h.app.state.infoOpen, false);
  for (const secret of h.secrets()) assert.ok(!JSON.stringify(h.app.state).includes(secret), 'dismissal clears credential-bearing state');
});

test('canceling the real deploy gate drops its secret-bearing callback without applying anything', async () => {
  const h = harness();
  await h.app.onboardDeploy();
  assert.equal(typeof h.app.state.sureAction, 'function');
  h.app.renderVals().closeSure();
  assert.equal(h.app.state.sureOpen, false);
  assert.equal(h.app.state.sureAction, null);
  assert.equal(h.calls.some((call) => call.action === 'pbx.apply'), false);
  assert.equal(h.app.state.infoOpen, false);
});

test('functional state updates clear hidden credential content and confirmation callbacks too', async () => {
  const h = harness();
  await h.deploy();
  h.app.setState(() => ({ infoOpen: false, sureOpen: false }));
  assert.equal(h.app.state.sureAction, null);
  assert.equal(h.app.state.infoBody, '');
});

test('the local-history receipt identifies the applied target even if selection changes during the write', async () => {
  const h = harness({ switchAfterApply: true });
  await h.deploy();
  assert.equal(h.calls.find((call) => call.action === 'pbx.apply')!.extra.serverId, 'synthetic-target');
  assert.equal(h.calls.find((call) => call.action === 'local-history.record')!.extra.payload.payload.targetId, 'synthetic-target');
});

test('changing targets before confirmation refuses to apply the stale plan', async () => {
  const h = harness();
  await h.app.onboardDeploy();
  h.app.target = { id: 'different-target', label: 'Different target', connected: true };
  h.app.renderVals().sureYes();
  assert.equal(h.calls.some((call) => call.action === 'pbx.apply'), false);
  assert.match(h.displayed.join('\n'), /Target changed/u);
  assert.equal(h.app.state.sureAction, null);
});

for (const options of [{ historyFails: true }, { historyThrows: true }]) {
  test(`a ${options.historyThrows ? 'throwing' : 'refused'} history write reports partial evidence without losing the deployed credentials`, async () => {
    const h = harness(options);
    await h.deploy();
    assert.equal(h.app.state.infoOpen, true);
    assert.match(h.displayed.join('\n'), /not recorded in local history/iu);
    assert.ok(!h.displayed.join('\n').includes('is in local history if you need to undo'));
  });
}

test('a refused deployment neither records success nor shows credentials', async () => {
  const h = harness({ applyFails: true });
  await h.deploy();
  assert.equal(h.calls.some((call) => call.action === 'local-history.record'), false);
  assert.equal(h.app.state.infoOpen, false);
});

for (const [name, response] of [
  ['refused', { ok: false, message: 'Read refused.', data: { state: 'present', value: [] } }],
  ['missing', undefined],
  ['malformed', { ok: true, data: { state: 'present', value: {} } }],
  ['malformed section', { ok: true, data: { state: 'present', value: [null] } }],
  ['unverified state', { ok: true, data: { value: [] } }],
] as const) {
  test(`a ${name} configuration read cannot become an empty deployment target`, async () => {
    const h = harness({ readResponse: response });
    await h.app.onboardDeploy();
    assert.equal(h.app.state.sureOpen, false);
    assert.equal(h.app.state.sureAction, null);
    assert.equal(h.calls.some((call) => call.action === 'pbx.apply'), false);
    assert.match(h.displayed.join('\n'), /not prepared/iu);
  });
}

test('a throwing configuration read reports refusal without an unhandled rejection', async () => {
  const h = harness({ readThrows: true });
  await h.app.onboardDeploy();
  assert.equal(h.app.state.sureOpen, false);
  assert.match(h.displayed.join('\n'), /not prepared/iu);
});

test('explicitly absent configuration remains a supported first-deployment state', async () => {
  const h = harness({ readResponse: { ok: true, data: { state: 'absent' } } });
  await h.deploy();
  assert.equal(h.calls.some((call) => call.action === 'pbx.apply'), true);
});

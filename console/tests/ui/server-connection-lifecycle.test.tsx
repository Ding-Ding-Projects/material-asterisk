import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { App } from '../../app/renderer/src/App';
import { createControlPlaneDispatcher } from '../../control-plane/dispatch';
import { NodeProcessExecutor } from '../../control-plane/executor';

(globalThis as { window?: unknown }).window ??= {};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Real dispatcher, persistent inventory and transport validation. Only the OS
 * process boundary is replaced; this suite never contacts a real PBX. */
async function withTarget(run: (h: any) => Promise<void>, { fresh = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'connection-lifecycle-'));
  const original = NodeProcessExecutor.prototype.execute;
  const processes: any[] = [];
  let beforeProcess: ((request: any) => Promise<void>) | undefined;
  NodeProcessExecutor.prototype.execute = async function (request: any) {
    processes.push(request);
    await beforeProcess?.(request);
    let stdout: string;
    if (request.executable === 'wsl.exe' && request.args[0] === '--list') stdout = 'Distro-A\nDistro-B\nDistro-C\n';
    else if (request.executable === 'wsl.exe' && request.args.includes('/etc/os-release')) stdout = 'ID=debian\nVERSION_ID="12"\nPRETTY_NAME="Debian"\n';
    else if (request.executable === 'wsl.exe' && request.args.includes('core show version')) stdout = 'Asterisk 22.4.1';
    else if (request.executable === 'wsl.exe' && request.args.includes('module reload res_pjsip.so')) stdout = 'Module reloaded';
    else if (request.executable === 'docker') stdout = '';
    else throw new Error('Unexpected test process: ' + JSON.stringify(request));
    return { status: 'succeeded', exitCode: 0, stdout, stderr: '', durationMs: 0 };
  };
  try {
    const dispatcher = createControlPlaneDispatcher({ userDataPath: root, resourcesPath: root, hosted: true });
    const prior = fresh ? undefined : dispatcher.serverInventory().add({ name: 'PBX', connectionKind: 'wsl', wslDistribution: 'Distro-A' });
    if (prior) dispatcher.serverInventory().setActive(prior.id);
    const app = new App({}) as any;
    app.updater = { enqueueForceUpdate() {}, enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    } };
    app.state = { ...app.state, screen: 'servers', onboardOpen: true, onboardStep: 4,
      values: { ob_intent: 'Connect to an existing one', ob_where: 'This machine', ob_distribution: 'Distro-B' } };
    app.target = prior ? { id: prior.id, label: prior.name, detail: 'Previous target', connected: true }
      : { id: '', label: 'No target', detail: 'No target selected', connected: false };
    const messages: string[] = [];
    app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
    app.toast = () => {};
    const requests: any[] = [];
    let beforeRequest: ((request: any) => Promise<void>) | undefined;
    let afterRequest: ((request: any) => Promise<void>) | undefined;
    app.bridge = () => ({ controlPlane: { request: async (request: any) => {
      requests.push(request);
      await beforeRequest?.(request);
      const response = await dispatcher.controlPlaneRequest(request);
      await afterRequest?.(request);
      return response;
    } } });
    await app.servers.load();
    await run({ app, dispatcher, prior, requests, processes, messages,
      beforeProcess: (fn: any) => { beforeProcess = fn; },
      beforeRequest: (fn: any) => { beforeRequest = fn; },
      afterRequest: (fn: any) => { afterRequest = fn; },
    });
  } finally {
    NodeProcessExecutor.prototype.execute = original;
    await rm(root, { recursive: true, force: true });
  }
}

test('existing-target onboarding verifies the exact saved target before activation and navigation', async () => {
  await withTarget(async ({ app, dispatcher, requests, processes, messages }) => {
    await app.onboardConnect();
    const saved = dispatcher.serverInventory().list().find((server: any) => server.wslDistribution === 'Distro-B');
    assert.ok(saved, messages.join('\n'));
    assert.equal(saved.state, 'connected');
    assert.equal(app.target.id, saved.id);
    assert.equal(dispatcher.serverInventory().activeId(), saved.id);
    assert.equal(app.state.onboardOpen, false);
    assert.equal(app.state.screen, 'servers');
    assert.ok(requests.findIndex((r: any) => r.action === 'server.connect') < requests.findIndex((r: any) => r.action === 'server.inventory.set-active'));
    const probes = processes.filter((p: any) => p.args.includes('/etc/os-release') || p.args.includes('core show version'));
    assert.equal(probes.length, 2);
    assert.ok(probes.every((p: any) => p.args[1] === 'Distro-B'));
    assert.ok(messages.some((m: string) => m.startsWith('Connected:')));
  });
});

for (const reorder of [false, true]) test(`the rendered second duplicate-name row keeps its immutable identity${reorder ? ' after inventory reordering' : ''}`, async () => {
  await withTarget(async ({ app, dispatcher, prior, requests }) => {
    const second = dispatcher.serverInventory().add({ name: prior.name, connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    const secondRow = app.renderVals().tableRows[1];
    assert.equal(secondRow.cells[0].text, prior.name);
    if (reorder) app.servers.servers.reverse();
    secondRow.pick();
    while (app.connectionBusy) await tick();
    assert.equal(requests.find((r: any) => r.action === 'server.connect').serverId, second.id);
    assert.equal(app.target.id, second.id);
    assert.equal(dispatcher.serverInventory().activeId(), second.id);
  });
});

for (const stage of ['discovery', 'save', 'probe', 'activation'] as const) {
  for (const interruption of ['skip', 'back', 'navigate'] as const) {
    test(`${interruption} during ${stage} prevents late onboarding selection, success and navigation`, async () => {
      await withTarget(async ({ app, dispatcher, prior, requests, messages, beforeProcess, beforeRequest, afterRequest }) => {
        const paused = deferred(); const release = deferred(); let held = false;
        const hold = async () => { if (held) return; held = true; paused.resolve(); await release.promise; };
        if (stage === 'discovery') beforeRequest(async (r: any) => { if (r.action === 'server.list') await hold(); });
        if (stage === 'save') afterRequest(async (r: any) => { if (r.action === 'server.inventory.add') await hold(); });
        if (stage === 'probe') beforeProcess(async (r: any) => { if (r.args.includes('core show version')) await hold(); });
        if (stage === 'activation') beforeRequest(async (r: any) => { if (r.action === 'server.inventory.set-active') await hold(); });
        const pending = app.onboardConnect();
        await Promise.race([paused.promise, pending.then(() => { throw new Error('Connection finished before the expected request boundary'); })]);
        await app.onboardConnect();
        if (interruption === 'skip') app.renderVals().skipOnboard();
        else if (interruption === 'back') app.renderVals().onboardBack();
        else app.openScreen('modules');
        release.resolve();
        await pending;
        assert.equal(app.target.id, prior.id);
        assert.equal(dispatcher.serverInventory().activeId(), prior.id);
        assert.equal(app.connectionBusy, false);
        assert.equal(app.state.screen, interruption === 'navigate' ? 'modules' : 'servers');
        assert.equal(app.state.onboardOpen, interruption !== 'skip');
        assert.equal(app.state.onboardStep, interruption === 'back' ? 3 : 4);
        assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
        assert.equal(requests.filter((r: any) => r.action === 'server.inventory.add').length, stage === 'discovery' ? 0 : 1);
        if (stage === 'discovery' || stage === 'save') assert.ok(!requests.some((r: any) => r.action === 'server.connect'));
      });
    });
  }
}

test('opening a destructive confirmation cancels a pending connection and keeps the command on its reviewed target', async () => {
  await withTarget(async ({ app, dispatcher, prior, beforeProcess, requests, processes }) => {
    const second = dispatcher.serverInventory().add({ name: 'Other', connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    const paused = deferred(); const release = deferred();
    beforeProcess(async (r: any) => { if (r.args[1] === 'Distro-B' && r.args.includes('core show version')) { paused.resolve(); await release.promise; } });
    const pending = app.onConnectServerRow(second.id);
    await Promise.race([paused.promise, pending.then(() => { throw new Error('Connection finished before the expected request boundary'); })]);
    app.ceremony('Reload module', 'module reload res_pjsip.so');
    release.resolve(); await pending;
    assert.equal(app.target.id, prior.id);
    assert.equal(app.state.ceremonyTargetId, prior.id);
    assert.equal(await app.executeCeremonyCommand(), true);
    assert.equal(requests.find((r: any) => r.action === 'pbx.command').serverId, prior.id);
    assert.equal(processes.find((p: any) => p.args.includes('module reload res_pjsip.so')).args[1], 'Distro-A');
  });
});

test('a confirmation cannot execute after its target or screen changes', async () => {
  await withTarget(async ({ app, requests, messages }) => {
    for (const change of ['target', 'screen']) {
      app.ceremony('Reload module', 'module reload res_pjsip.so');
      if (change === 'target') app.target = { ...app.target, id: 'another-target' };
      else app.openScreen('modules');
      assert.equal(await app.executeCeremonyCommand(), false);
    }
    assert.ok(!requests.some((r: any) => r.action === 'pbx.command'));
    assert.equal(messages.filter((m: string) => m.startsWith('Not run:')).length, 2);
  });
});

test('closed or replaced confirmation handlers cannot run again or spend another credit', async () => {
  await withTarget(async ({ app, requests }) => {
    app.state.credits = 3;
    app.ceremony('Reload module', 'module reload res_pjsip.so');
    const oldSkip = app.renderVals().skipCeremony;
    oldSkip();
    while (app.ceremonyPending) await tick();
    await tick();
    assert.equal(app.state.credits, 2);
    oldSkip(); await tick();
    app.ceremony('Reload again', 'module reload res_pjsip.so');
    oldSkip(); await tick();
    assert.equal(requests.filter((r: any) => r.action === 'pbx.command').length, 1);
    assert.equal(app.state.credits, 2);
    assert.equal(app.state.ceremonyOpen, true);
  });
});


test('a row handler retained after navigation cannot start a new connection', async () => {
  await withTarget(async ({ app, requests }) => {
    const row = app.renderVals().tableRows[0];
    app.openScreen('modules');
    row.pick(); await tick();
    assert.ok(!requests.some((r: any) => r.action === 'server.connect'));
  });
});

test('an activation applied before an interrupted IPC reply restores the prior inventory selection', async () => {
  await withTarget(async ({ app, dispatcher, prior, messages, afterRequest }) => {
    let interrupted = false;
    afterRequest(async (r: any) => {
      if (r.action === 'server.inventory.set-active' && !interrupted) {
        interrupted = true;
        app.renderVals().skipOnboard();
        throw new Error('Activation reply interrupted');
      }
    });
    await app.onboardConnect();
    assert.equal(interrupted, true);
    assert.equal(dispatcher.serverInventory().activeId(), prior.id);
    assert.equal(app.target.id, prior.id);
    assert.equal(app.state.onboardOpen, false);
    assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
  });
});


for (const stage of ['save', 'probe', 'activation'] as const) test(`first-run cancellation during ${stage} leaves no inventory selection`, async () => {
  await withTarget(async ({ app, dispatcher, beforeProcess, beforeRequest, afterRequest, messages }) => {
    const paused = deferred(); const release = deferred(); let held = false;
    const hold = async () => { if (held) return; held = true; paused.resolve(); await release.promise; };
    if (stage === 'save') afterRequest(async (r: any) => { if (r.action === 'server.inventory.add') await hold(); });
    if (stage === 'probe') beforeProcess(async (r: any) => { if (r.args.includes('core show version')) await hold(); });
    if (stage === 'activation') beforeRequest(async (r: any) => { if (r.action === 'server.inventory.set-active') await hold(); });
    const pending = app.onboardConnect(); await Promise.race([paused.promise, pending.then(() => { throw new Error('Connection finished before the expected request boundary'); })]);
    assert.equal(dispatcher.serverInventory().activeId(), undefined, 'saving a first record must not select it before verification');
    app.renderVals().skipOnboard(); release.resolve(); await pending;
    assert.equal(dispatcher.serverInventory().activeId(), undefined);
    assert.equal(app.target.connected, false);
    assert.equal(app.state.onboardOpen, false);
    assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
  }, { fresh: true });
});

for (const fresh of [false, true]) for (const order of ['before', 'after'] as const) test(`cancelled activation cannot replace a newer selection made ${order} its dispatch, with ${fresh ? 'no' : 'a'} prior target`, async () => {
  await withTarget(async ({ app, dispatcher, beforeRequest, afterRequest }) => {
    const third = dispatcher.serverInventory().add({ name: 'Newest', connectionKind: 'wsl', wslDistribution: 'Distro-C' }, false);
    const verified = await dispatcher.controlPlaneRequest({ requestId: 'verify-newest', action: 'server.connect', serverId: third.id });
    assert.equal(verified.ok, true);
    const paused = deferred(); const release = deferred(); let held = false;
    const hold = async (r: any) => {
      if (r.action !== 'server.inventory.set-active' || held) return;
      held = true; paused.resolve(); await release.promise;
    };
    if (order === 'before') beforeRequest(hold); else afterRequest(hold);
    const pending = app.onboardConnect(); await Promise.race([paused.promise, pending.then(() => { throw new Error('Connection finished before the expected request boundary'); })]);
    app.renderVals().skipOnboard();
    const newer = await dispatcher.controlPlaneRequest({ requestId: 'select-newest', action: 'server.inventory.set-active', serverId: third.id });
    assert.equal(newer.ok, true);
    release.resolve(); await pending;
    assert.equal(dispatcher.serverInventory().activeId(), third.id);
    assert.notEqual(app.target.id, dispatcher.serverInventory().list().find((s: any) => s.wslDistribution === 'Distro-B').id);
  }, { fresh });
});

test('context deletion binds the exact duplicate-name row across reorder and rename before confirmation', async () => {
  await withTarget(async ({ app, dispatcher, prior, requests }) => {
    const second = dispatcher.serverInventory().add({ name: prior.name, connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    app.renderVals().tableRows[1].ctx({ preventDefault() {}, clientX: 100, clientY: 100 });
    const deletion = app.renderVals().ctxItems.find((item: any) => item.icon === 'delete');
    assert.ok(deletion);
    deletion.run();
    assert.equal(app.state.sureOpen, true);
    dispatcher.serverInventory().update(second.id, { name: 'Renamed after review' });
    await app.servers.load(); app.servers.servers.reverse();
    app.state.sureAction(); await tick(); await tick();
    assert.equal(requests.find((r: any) => r.action === 'server.inventory.remove').serverId, second.id);
    assert.equal(dispatcher.serverInventory().get(second.id), undefined);
    assert.ok(dispatcher.serverInventory().get(prior.id));
  });
});


for (const action of ['navigate', 'back']) test(`a queued React ${action} invalidates the connection before its updater runs`, async () => {
  await withTarget(async ({ app, dispatcher, prior, beforeProcess, messages }) => {
    const paused = deferred(); const release = deferred();
    beforeProcess(async (r: any) => { if (r.args.includes('core show version')) { paused.resolve(); await release.promise; } });
    const pending = app.onboardConnect(); await paused.promise;
    const enqueue = app.updater.enqueueSetState;
    const queued: Array<() => void> = [];
    app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => {
      if (typeof partial === 'function') queued.push(() => enqueue(instance, partial, callback));
      else enqueue(instance, partial, callback);
    };
    if (action === 'navigate') app.openScreen('modules'); else app.renderVals().onboardBack();
    release.resolve(); await pending;
    assert.equal(app.target.id, prior.id);
    assert.equal(dispatcher.serverInventory().activeId(), prior.id);
    assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
    queued.forEach((flush) => flush());
    assert.equal(action === 'navigate' ? app.state.screen : app.state.onboardStep, action === 'navigate' ? 'modules' : 3);
  });
});

for (const fresh of [false, true]) for (const newer of [false, true]) test(`a missing activation reply after cancellation preserves ${newer ? 'a newer selection' : fresh ? 'no selection' : 'the prior selection'}`, async () => {
  await withTarget(async ({ app, dispatcher, prior }) => {
    const third = newer ? dispatcher.serverInventory().add({ name: 'Newest', connectionKind: 'wsl', wslDistribution: 'Distro-C' }, false) : undefined;
    const bridge = app.bridge(); let dropped = false;
    app.bridge = () => ({ controlPlane: { request: async (r: any) => {
      const response = await bridge.controlPlane.request(r);
      if (r.action === 'server.inventory.set-active' && !dropped) {
        dropped = true;
        app.renderVals().skipOnboard();
        if (third) await dispatcher.controlPlaneRequest({ requestId: 'newer-after-missing', action: 'server.inventory.set-active', serverId: third.id });
        return undefined;
      }
      return response;
    } } });
    await app.onboardConnect();
    assert.equal(dropped, true);
    assert.equal(dispatcher.serverInventory().activeId(), third?.id ?? prior?.id);
    assert.equal(app.target.id, prior?.id ?? '');
    assert.equal(app.state.onboardOpen, false);
  }, { fresh });
});

test('a newer inventory selection during the connection probe supersedes its original activation intent', async () => {
  await withTarget(async ({ app, dispatcher, prior, beforeProcess, messages }) => {
    const third = dispatcher.serverInventory().add({ name: 'Newest', connectionKind: 'wsl', wslDistribution: 'Distro-C' }, false);
    const paused = deferred(); const release = deferred();
    beforeProcess(async (r: any) => { if (r.args[1] === 'Distro-B' && r.args.includes('core show version')) { paused.resolve(); await release.promise; } });
    const pending = app.onboardConnect(); await paused.promise;
    const newer = await dispatcher.controlPlaneRequest({ requestId: 'select-during-probe', action: 'server.inventory.set-active', serverId: third.id });
    assert.equal(newer.ok, true);
    release.resolve(); await pending;
    assert.equal(dispatcher.serverInventory().activeId(), third.id);
    assert.equal(app.target.id, prior.id);
    assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
    assert.ok(messages.some((m: string) => /superseded/u.test(m)));
  });
});

for (const connectionKind of ['remoteLinux', 'localDocker', 'remoteDocker']) test(`existing ${connectionKind} profiles remain saved and refuse connection before any process`, async () => {
  await withTarget(async ({ app, dispatcher, prior, requests, processes, messages }) => {
    const saved = dispatcher.serverInventory().add({ name: 'Saved profile', connectionKind, host: 'pbx.example.invalid', user: 'operator', dockerProject: 'saved-project' });
    await app.servers.load();
    const requestCount = requests.length; const processCount = processes.length;
    await app.onConnectServerRow(saved.id);
    assert.deepEqual(dispatcher.serverInventory().get(saved.id), saved);
    assert.equal(requests.length, requestCount);
    assert.equal(processes.length, processCount);
    assert.equal(app.target.id, prior.id);
    assert.match(messages.join('\n'), /remains saved.*connection is unavailable/u);
    assert.ok(!messages.some((message: string) => message.startsWith('Connected:')));
    const response = await dispatcher.controlPlaneRequest({ requestId: 'unsupported-connection', action: 'server.connect', serverId: saved.id });
    assert.equal(response.ok, false);
    assert.equal(response.code, 'CONNECTION_KIND_NOT_WIRED');
    assert.equal(processes.length, processCount);
    assert.ok(dispatcher.serverInventory().get(saved.id));
  });
});

test('ordinary confirmation consumes its action once before React commits the close update', async () => {
  await withTarget(async ({ app, requests, processes }) => {
    app.areYouSure('Reload module', 'Reload the reviewed module', 3, () => {
      void app.request('pbx.command', { serverId: app.target.id, payload: { command: 'module reload res_pjsip.so' } });
    });
    app.state.sureHits = app.state.sureNeed;
    const yes = app.renderVals().sureYes; const rawAction = app.state.sureAction;
    const enqueue = app.updater.enqueueSetState; const queued: Array<() => void> = [];
    app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => queued.push(() => enqueue(instance, partial, callback));
    yes(); yes(); rawAction(); await tick(); await tick();
    assert.equal(requests.filter((r: any) => r.action === 'pbx.command').length, 1);
    assert.equal(processes.filter((p: any) => p.args.includes('module reload res_pjsip.so')).length, 1);
    queued.forEach((flush) => flush());
    assert.equal(app.state.sureOpen, false);
  });
});

test('ordinary confirmation rejects cancelled, replaced and changed-target callbacks', async () => {
  await withTarget(async ({ app, requests }) => {
    const command = () => { void app.request('pbx.command', { serverId: app.target.id, payload: { command: 'module reload res_pjsip.so' } }); };
    app.areYouSure('Cancelled reload', 'Review', 3, command);
    const cancelled = app.renderVals(); const cancelledRaw = app.state.sureAction;
    cancelled.closeSure(); cancelled.sureYes(); cancelledRaw();
    app.areYouSure('Old reload', 'Review', 3, command);
    const old = app.renderVals(); const oldRaw = app.state.sureAction;
    app.areYouSure('Replacement reload', 'Review again', 3, command);
    old.sureYes(); old.closeSure(); oldRaw();
    assert.equal(app.state.sureOpen, true);
    const current = app.renderVals().sureYes;
    app.target = { ...app.target, id: 'different-target' };
    current(); await tick(); await tick();
    assert.ok(!requests.some((r: any) => r.action === 'pbx.command'));
  });
});

test('an accepted ordinary confirmation may open a fresh confirmation without reusing its action', async () => {
  await withTarget(async ({ app, requests }) => {
    app.areYouSure('Review first', 'First review', 3, () => {
      app.areYouSure('Review second', 'Second review', 3, () => {
        void app.request('pbx.command', { serverId: app.target.id, payload: { command: 'module reload res_pjsip.so' } });
      });
    });
    const first = app.renderVals().sureYes;
    first(); first();
    assert.equal(app.state.sureOpen, true);
    const second = app.renderVals().sureYes;
    second(); second(); await tick(); await tick();
    assert.equal(requests.filter((r: any) => r.action === 'pbx.command').length, 1);
  });
});

for (const action of ['checkbox', 'context']) test(`duplicate-name server ${action} selection uses immutable identity and highlights only the selected row`, async () => {
  await withTarget(async ({ app, dispatcher, prior }) => {
    const second = dispatcher.serverInventory().add({ name: prior.name, connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    const row = app.renderVals().tableRows[1];
    if (action === 'checkbox') row.toggle();
    else {
      row.ctx({ preventDefault() {}, clientX: 0, clientY: 0 });
      app.renderVals().ctxItems.find((item: any) => item.label === 'Select this row').run();
    }
    assert.deepEqual(app.state.selected, [second.id]);
    const values = app.renderVals();
    assert.equal(values.tableRows[0].checkIcon, '');
    assert.equal(values.tableRows[1].checkIcon, 'check');
    values.bulkActions.find((item: any) => item.label === 'Invert selection').run();
    assert.deepEqual(app.state.selected, [prior.id]);
    app.renderVals().toggleAll();
    assert.deepEqual(new Set(app.state.selected), new Set([prior.id, second.id]));
  });
});

test('context select-all includes both duplicate-name immutable records', async () => {
  await withTarget(async ({ app, dispatcher, prior }) => {
    const second = dispatcher.serverInventory().add({ name: prior.name, connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    app.state.ctxKind = 'screen';
    app.renderVals().ctxItems.find((item: any) => item.label === 'Select all rows').run();
    assert.deepEqual(new Set(app.state.selected), new Set([prior.id, second.id]));
  });
});

test('a retained context callback keeps its captured label and ID after rows reorder on a later render', async () => {
  await withTarget(async ({ app, dispatcher }) => {
    const second = dispatcher.serverInventory().add({ name: 'Distinct second', connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    const row = app.renderVals().tableRows[1];
    app.servers.servers.reverse(); app.renderVals();
    row.ctx({ preventDefault() {}, clientX: 0, clientY: 0 });
    assert.equal(app.state.ctxTarget, second.name);
    assert.equal(app.state.ctxServerId, second.id);
  });
});

test('export follows the selected duplicate-name inventory ID after reorder and includes only that record', async () => {
  await withTarget(async ({ app, dispatcher, prior }) => {
    const second = dispatcher.serverInventory().add({ name: prior.name, connectionKind: 'wsl', wslDistribution: 'Distro-B' });
    await app.servers.load();
    app.renderVals().tableRows[1].toggle();
    app.servers.servers.reverse(); app.renderVals();
    const exportSelection = app.renderVals().bulkActions.find((item: any) => item.label === 'Export').run;
    const originalDocument = (globalThis as any).document;
    const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
    let artifact: Blob | undefined; let clicked = 0;
    (globalThis as any).document = { createElement() { return { click() { clicked++; } }; } };
    URL.createObjectURL = (blob: Blob) => { artifact = blob; return 'blob:selection-test'; };
    URL.revokeObjectURL = () => {};
    try {
      exportSelection();
      await tick();
      assert.equal(clicked, 1); assert.ok(artifact);
      const content = await artifact.text();
      assert.match(content, /Distro-B/u);
      assert.doesNotMatch(content, /Distro-A/u);
      assert.deepEqual(app.state.selected, []);
    } finally {
      (globalThis as any).document = originalDocument;
      URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    }
  });
});

for (const queued of [false, true]) test(`a retained onboarding completion cannot restart work after Skip${queued ? ' before React commits' : ' and navigation'}`, async () => {
  await withTarget(async ({ app, dispatcher, prior, requests, messages }) => {
    const oldNext = app.renderVals().onboardNext;
    const enqueue = app.updater.enqueueSetState; const updates: Array<() => void> = [];
    if (queued) app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => updates.push(() => enqueue(instance, partial, callback));
    app.renderVals().skipOnboard();
    if (!queued) app.openScreen('modules');
    const before = requests.length;
    oldNext(); while (app.connectionBusy) await tick();
    updates.forEach((flush) => flush());
    assert.equal(requests.length, before);
    assert.equal(app.target.id, prior.id);
    assert.equal(dispatcher.serverInventory().activeId(), prior.id);
    assert.equal(app.state.onboardOpen, false);
    assert.equal(app.state.screen, queued ? 'servers' : 'modules');
    assert.ok(!messages.some((m: string) => m.startsWith('Connected:')));
  });
});

test('navigation invalidates an idle onboarding callback before the functional navigation update commits', async () => {
  await withTarget(async ({ app, requests }) => {
    const oldNext = app.renderVals().onboardNext;
    const enqueue = app.updater.enqueueSetState; const updates: Array<() => void> = [];
    app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => updates.push(() => enqueue(instance, partial, callback));
    app.openScreen('modules');
    const before = requests.length;
    oldNext(); while (app.connectionBusy) await tick();
    assert.equal(requests.length, before);
    updates.forEach((flush) => flush());
    assert.equal(app.state.screen, 'modules');
  });
});

test('a completed ceremony callback is consumed even while React still queues its close update', async () => {
  await withTarget(async ({ app, requests }) => {
    app.state.credits = 3;
    app.ceremony('Reload module', 'module reload res_pjsip.so');
    const skip = app.renderVals().skipCeremony;
    const enqueue = app.updater.enqueueSetState; const updates: Array<() => void> = [];
    app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => updates.push(() => enqueue(instance, partial, callback));
    skip(); while (app.ceremonyPending) await tick(); await tick();
    skip(); while (app.ceremonyPending) await tick(); await tick();
    assert.equal(requests.filter((r: any) => r.action === 'pbx.command').length, 1);
    updates.forEach((flush) => flush());
    assert.equal(app.state.credits, 2);
  });
});

test('a cancelled ceremony cannot execute before React commits its close, and old close handlers cannot cancel a replacement', async () => {
  await withTarget(async ({ app, requests }) => {
    app.ceremony('Reload module', 'module reload res_pjsip.so');
    const cancelled = app.renderVals();
    const enqueue = app.updater.enqueueSetState; const updates: Array<() => void> = [];
    app.updater.enqueueSetState = (instance: any, partial: any, callback?: () => void) => updates.push(() => enqueue(instance, partial, callback));
    cancelled.cancelCeremony(); cancelled.executeCeremony();
    assert.equal(await app.executeCeremonyCommand(), false);
    await tick();
    assert.ok(!requests.some((r: any) => r.action === 'pbx.command'));
    updates.forEach((flush) => flush()); app.updater.enqueueSetState = enqueue;
    app.ceremony('Review again', 'module reload res_pjsip.so');
    cancelled.cancelCeremony();
    assert.equal(app.state.ceremonyOpen, true);
    assert.equal(await app.executeCeremonyCommand(), true);
    assert.equal(requests.filter((r: any) => r.action === 'pbx.command').length, 1);
  });
});

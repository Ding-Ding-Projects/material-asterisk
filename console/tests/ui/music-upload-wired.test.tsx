import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../../app/renderer/src/App.tsx';
import { PbxAdminApp } from '../../app/renderer/src/PbxAdminApp.tsx';
import { SCREENS } from '../../app/renderer/src/generated/console.tsx';
import { loadVocabularyFile, vocabularyStatus } from '../../app/renderer/src/personal-vocabulary.ts';
import { createControlPlaneDispatcher } from '../../control-plane/dispatch.ts';
import { NodeProcessExecutor, type CommandRequest } from '../../control-plane/executor.ts';

(globalThis as { window?: unknown }).window ??= {};

const MUSIC = { id: 'h_upload' };
const VOCABULARY = { id: 'va_file' };
const AUDIO = new File(['RIFF', new Uint8Array(4), 'WAVE', 'task-owned audio bytes'], 'hold.wav', { type: 'audio/wav' });
const VOCABULARY_TEXT = JSON.stringify({ version: 1, replacements: [{ from: 'Original wording', to: 'Personal wording' }] });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const landed = (file = AUDIO) => ({ ok: true, data: { name: file.name, path: `/var/lib/asterisk/moh/${file.name}`, extension: 'wav', bytes: file.size } });

function harness(Host: typeof App = App) {
  const app = new Host({}) as any;
  app.updater = {
    enqueueForceUpdate() {},
    enqueueSetState(instance: any, partial: any, callback?: () => void) {
      instance.state = { ...instance.state, ...(typeof partial === 'function' ? partial(instance.state) : partial) };
      callback?.();
    },
  };
  app.target = { id: 'selected-target', label: 'Selected target', connected: true };
  app.state = { ...app.state, screen: 'moh', values: { ...app.state.values, h_mode: 'files' } };
  const values = new Map<string, string>();
  const storageWrites: string[] = [];
  app.vocabStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { storageWrites.push(key); values.set(key, value); },
    removeItem: (key: string) => { storageWrites.push(key); values.delete(key); },
  };
  assert.equal(loadVocabularyFile(app.vocabStorage, VOCABULARY_TEXT).ok, true);
  storageWrites.length = 0;
  const messages: string[] = [];
  const requests: any[] = [];
  app.fire = (title: string, body: string) => messages.push(`${title}: ${body}`);
  app.toast = (body: string) => messages.push(body);
  app.onUserMutation = () => {};
  app.request = async (action: string, extra: any) => { requests.push({ action, ...extra }); return landed(); };
  return { app, values, storageWrites, messages, requests };
}

function fileReader(t: TestContext, manual = false) {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  const readers: Reader[] = [];
  class Reader {
    result: string | null = null;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    file?: File;
    constructor() { readers.push(this); }
    readAsDataURL(file: File) {
      this.file = file;
      if (!manual) void this.complete();
    }
    async complete() {
      this.result = `data:audio/wav;base64,${Buffer.from(await this.file!.arrayBuffer()).toString('base64')}`;
      this.onload?.();
    }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, writable: true, value: Reader });
  t.after(() => {
    if (before) Object.defineProperty(globalThis, 'FileReader', before);
    else Reflect.deleteProperty(globalThis, 'FileReader');
  });
  return readers;
}

async function choose(app: any, file: File = AUDIO) {
  app.onFilePicked(MUSIC, file);
  for (let attempt = 0; attempt < 30; attempt++) {
    await tick();
    if (!['reading', 'uploading'].includes(app.musicFileSelection?.phase)) return;
  }
  assert.fail('Music file upload did not settle');
}

function assertVocabularyUntouched(h: ReturnType<typeof harness>) {
  assert.equal(vocabularyStatus(h.app.vocabStorage).replacementCount, 1);
  assert.deepEqual(h.storageWrites, []);
}

test('music picker metadata declares the existing fixed-root media contract', () => {
  const control = (SCREENS as any).moh.groups.flatMap((group: any) => group.ctls).find((candidate: any) => candidate.id === MUSIC.id);
  assert.equal(control.accept, '.wav,.gsm,.ulaw,.alaw,.g722,.sln,.sln16,.ogg,.opus');
  assert.match(control.info, /fixed library \/var\/lib\/asterisk\/moh/u);
  assert.match(control.info, /10 MiB/u);
  assert.match(control.info, /Clear only dismisses the local selection/u);
  assert.doesNotMatch(control.info, /directory above/u);
});

test('music selection is empty independently of a loaded vocabulary', () => {
  const h = harness();
  assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
  assert.equal(h.app.fileControlHasFile(MUSIC), false);
  h.app.onFileCleared(MUSIC);
  assertVocabularyUntouched(h);
  assert.deepEqual(h.requests, []);
});

test('the compiled music picker resets its native value for same-file retries only', async (t) => {
  fileReader(t);
  const h = harness();
  const control = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' });
  h.app.request = async () => ({ ok: false, message: 'Try again.' });
  const input = { files: [AUDIO], value: 'selected-file' };
  control.onFileOpen({ currentTarget: input });
  control.onPick({ target: input });
  await tick();
  assert.equal(input.value, '');
  assert.match(h.app.fileControlName(MUSIC), /not uploaded/u);
  h.app.request = async () => landed();
  input.value = 'selected-file';
  control.onFileOpen({ currentTarget: input });
  control.onPick({ target: input });
  await tick();
  assert.equal(input.value, '');
  assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploaded)');
  assertVocabularyUntouched(h);

  const vocabulary = h.app.buildCtl({ ...VOCABULARY, kind: 'file', label: 'Vocabulary file', value: '' });
  const vocabularyInput = { files: [new File([VOCABULARY_TEXT], 'words.json')], value: 'vocabulary-selection' };
  vocabulary.onPick({ target: vocabularyInput });
  await tick();
  assert.equal(vocabularyInput.value, 'vocabulary-selection');
  assert.equal(h.app.fileControlName(VOCABULARY), 'words.json');
  assert.equal(vocabulary.onFileOpen, undefined);
});

for (const change of ['target', 'target-return', 'screen', 'mode'] as const) {
  test(`native picker ownership survives rerender and refuses a ${change} change`, async (t) => {
    const readers = fileReader(t);
    const h = harness();
    const input = { files: [AUDIO], value: 'selected-file' };
    const original = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' });
    original.onFileOpen({ currentTarget: input });
    if (change === 'target' || change === 'target-return') {
      h.app.target = { id: 'other-target', label: 'Other target', connected: true };
      if (change === 'target-return') h.app.target = { id: 'selected-target', label: 'Selected target', connected: true };
    } else if (change === 'screen') h.app.state.screen = 'sounds';
    else h.app.state.values.h_mode = 'custom';
    const rerendered = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' });
    rerendered.onPick({ target: input });
    await tick();
    assert.equal(readers.length, 0);
    assert.deepEqual(h.requests, []);
    assertVocabularyUntouched(h);
  });
}

test('same-target rerender retains the original native picker intent and uploads once', async (t) => {
  fileReader(t);
  const h = harness();
  const input = { files: [AUDIO], value: 'selected-file' };
  h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' }).onFileOpen({ currentTarget: input });
  const rerendered = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' });
  rerendered.onPick({ target: input });
  await tick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].serverId, 'selected-target');
  rerendered.onPick({ target: input });
  await tick();
  assert.equal(h.requests.length, 1, 'an opening intent can only be consumed once');
  assertVocabularyUntouched(h);
});

test('clear while a native picker is open invalidates the pending selection intent', async (t) => {
  const readers = fileReader(t);
  const h = harness();
  const input = { files: [AUDIO], value: 'selected-file' };
  const control = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' });
  control.onFileOpen({ currentTarget: input });
  control.onClear();
  control.onPick({ target: input });
  await tick();
  assert.equal(readers.length, 0);
  assert.deepEqual(h.requests, []);
  assertVocabularyUntouched(h);
});

for (const change of ['target', 'target-return', 'screen', 'mode'] as const) {
  test(`a retained picker callback cannot upload after a ${change} change`, async (t) => {
    const readers = fileReader(t);
    const h = harness();
    const picker = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' }).onPick;
    if (change === 'target' || change === 'target-return') {
      h.app.target = { id: 'other-target', label: 'Other target', connected: true };
      if (change === 'target-return') h.app.target = { id: 'selected-target', label: 'Selected target', connected: true };
    } else if (change === 'screen') h.app.state.screen = 'sounds';
    else h.app.state.values.h_mode = 'custom';
    picker({ target: { files: [AUDIO], value: 'chosen-file' } });
    await tick();
    assert.equal(readers.length, 0);
    assert.deepEqual(h.requests, []);
    assertVocabularyUntouched(h);
  });
}

for (const change of ['screen', 'mode'] as const) {
  test(`a direct music handler rejects an initially unsupported ${change}`, async (t) => {
    const readers = fileReader(t);
    const h = harness();
    if (change === 'screen') h.app.state.screen = 'sounds';
    else h.app.state.values.h_mode = 'custom';
    await choose(h.app);
    assert.equal(readers.length, 0);
    assert.deepEqual(h.requests, []);
    assert.match(h.messages.join('\n'), /Open Music on hold in files mode/u);
    assertVocabularyUntouched(h);
  });
}

test('a retained clear callback cannot clear another target local selection', () => {
  const h = harness();
  const clear = h.app.buildCtl({ ...MUSIC, kind: 'file', label: 'Add an audio file', value: '' }).onClear;
  h.app.target = { id: 'other-target', label: 'Other target', connected: true };
  const selection = { serverId: 'other-target', name: 'other.wav', label: 'other.wav (uploaded)', phase: 'uploaded' };
  h.app.musicFileSelection = selection;
  clear();
  assert.equal(h.app.musicFileSelection, selection);
  assert.deepEqual(h.requests, []);
  assertVocabularyUntouched(h);
});

for (const Host of [App, PbxAdminApp]) {
  test(`${Host.name} routes music bytes only to the selected server media library`, async (t) => {
    fileReader(t);
    const h = harness(Host);
    await choose(h.app);
    assert.deepEqual(h.requests, [{ action: 'media.upload', serverId: 'selected-target', payload: {
      root: 'musicOnHold', name: 'hold.wav', contentBase64: Buffer.from(await AUDIO.arrayBuffer()).toString('base64'),
    } }]);
    assert.equal(h.app.fileControlHasFile(MUSIC), true);
    assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploaded)');
    assert.match(h.messages.join('\n'), /Music file uploaded: hold.wav was confirmed/u);
    assertVocabularyUntouched(h);
    h.app.onFileCleared(MUSIC);
    assert.equal(h.app.fileControlHasFile(MUSIC), false);
    assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
    assert.equal(h.requests.length, 1, 'clear must never remove server media');
    assertVocabularyUntouched(h);
  });
}

test('an unknown file control cannot read, replace or clear vocabulary', () => {
  const h = harness();
  const unknown = { id: 'unrecognized-file-control' };
  const file = { name: 'vocabulary.json', text: () => assert.fail('Unknown control read a file') } as unknown as File;
  h.app.onFilePicked(unknown, file);
  h.app.onFileCleared(unknown);
  assert.equal(h.app.fileControlName(unknown), 'No file chosen');
  assert.equal(h.app.fileControlHasFile(unknown), false);
  assertVocabularyUntouched(h);
  assert.deepEqual(h.requests, []);
  assert.match(h.messages.join('\n'), /no supported upload action/u);
});

test('vocabulary pick and clear still use their own local loader only', async () => {
  const h = harness();
  h.app.onFilePicked(VOCABULARY, new File([VOCABULARY_TEXT], 'words.json'));
  await tick();
  assert.equal(h.app.fileControlName(VOCABULARY), 'words.json');
  assert.equal(h.app.fileControlHasFile(VOCABULARY), true);
  h.app.onFileCleared(VOCABULARY);
  assert.equal(vocabularyStatus(h.app.vocabStorage).replacementCount, 0);
  assert.equal(h.app.fileControlHasFile(MUSIC), false);
  assert.deepEqual(h.requests, []);
});

for (const [name, size] of [['not-audio.json', 30], ['../hold.wav', 30], ['hold.wav', 0], ['hold.wav', 10 * 1024 * 1024 + 1]] as const) {
  test(`invalid music input ${name} (${size} bytes) is refused before reading or dispatch`, async (t) => {
    const readers = fileReader(t);
    const h = harness();
    await choose(h.app, { name, size } as File);
    assert.deepEqual(h.requests, []);
    assert.equal(readers.length, 0);
    assert.match(h.messages.join('\n'), /Music file not uploaded/u);
    assertVocabularyUntouched(h);
  });
}

for (const target of [{ id: '', connected: true }, { id: 'unconnected', connected: false }]) {
  test(`no connected selected target (${JSON.stringify(target)}) never reads or uploads`, async (t) => {
    const readers = fileReader(t);
    const h = harness();
    h.app.target = target;
    await choose(h.app);
    assert.equal(readers.length, 0);
    assert.deepEqual(h.requests, []);
    assertVocabularyUntouched(h);
  });
}

test('a target switch while file reading is pending cancels the upload before dispatch', async (t) => {
  const readers = fileReader(t, true);
  const h = harness();
  h.app.onFilePicked(MUSIC, AUDIO);
  h.app.target = { id: 'other-target', label: 'Other target', connected: true };
  await readers[0]!.complete();
  await tick();
  assert.deepEqual(h.requests, []);
  assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
  assert.equal(h.app.fileControlHasFile(MUSIC), false);
  assertVocabularyUntouched(h);
});

test('returning to the original target after switching cannot revive a pending file read', async (t) => {
  const readers = fileReader(t, true);
  const h = harness();
  h.app.onFilePicked(MUSIC, AUDIO);
  h.app.target = { id: 'other-target', label: 'Other target', connected: true };
  h.app.target = { id: 'selected-target', label: 'Selected target', connected: true };
  await readers[0]!.complete();
  await tick();
  assert.deepEqual(h.requests, []);
  assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
  assertVocabularyUntouched(h);
});

for (const change of ['screen', 'mode', 'connection'] as const) {
  test(`${change} change while reading cancels before the media request`, async (t) => {
    const readers = fileReader(t, true);
    const h = harness();
    h.app.onFilePicked(MUSIC, AUDIO);
    if (change === 'screen') h.app.state = { ...h.app.state, screen: 'sounds' };
    else if (change === 'mode') h.app.state = { ...h.app.state, values: { ...h.app.state.values, h_mode: 'custom' } };
    else h.app.target.connected = false;
    await readers[0]!.complete();
    await tick();
    assert.deepEqual(h.requests, []);
    assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
    assertVocabularyUntouched(h);
  });
}

test('clearing a pending local read cancels dispatch and allows a fresh selection', async (t) => {
  const readers = fileReader(t, true);
  const h = harness();
  h.app.onFilePicked(MUSIC, AUDIO);
  h.app.onFileCleared(MUSIC);
  await readers[0]!.complete();
  await tick();
  assert.deepEqual(h.requests, []);
  h.app.onFilePicked(MUSIC, AUDIO);
  await readers[1]!.complete();
  await tick();
  assert.equal(h.requests.length, 1);
  assertVocabularyUntouched(h);
});

test('repeat picks and clear cannot claim to cancel an upload already sent to the server', async (t) => {
  const readers = fileReader(t);
  const h = harness();
  let finish!: (value: unknown) => void;
  h.app.request = (action: string, extra: any) => {
    h.requests.push({ action, ...extra });
    return new Promise((resolve) => { finish = resolve; });
  };
  h.app.onFilePicked(MUSIC, AUDIO);
  await tick();
  assert.equal(h.app.musicFileSelection.phase, 'uploading');
  assert.ok(!h.messages.some((message) => message.startsWith('Music file uploaded')));
  h.app.onFilePicked(MUSIC, AUDIO);
  h.app.onFileCleared(MUSIC);
  assert.equal(readers.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploading)');
  finish(landed());
  await tick();
  assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploaded)');
  assertVocabularyUntouched(h);
});

test('a late upload result cannot label or invalidate another selected server', async (t) => {
  fileReader(t);
  const h = harness();
  let finish!: (value: unknown) => void;
  h.app.request = () => new Promise((resolve) => { finish = resolve; });
  h.app.onFilePicked(MUSIC, AUDIO);
  await tick();
  h.app.target = { id: 'other-target', label: 'Other target', connected: true };
  const currentReading = { untouched: true };
  h.app.readings.moh = currentReading;
  finish(landed());
  await tick();
  assert.equal(h.app.fileControlName(MUSIC), 'No audio file chosen');
  assert.equal(h.app.fileControlHasFile(MUSIC), false);
  assert.equal(h.app.readings.moh, currentReading);
  assert.deepEqual(h.messages, []);
  assertVocabularyUntouched(h);
});

for (const [name, response] of [
  ['backend refusal', { ok: false, message: 'The target refused the file.' }],
  ['missing bridge answer', undefined],
  ['unverified success', { ok: true, data: {} }],
  ['wrong target path', { ...landed(), data: { ...landed().data, path: '/another/location/hold.wav' } }],
] as const) {
  test(`${name} is reported as failure without a success notification`, async (t) => {
    fileReader(t);
    const h = harness();
    h.app.request = async () => response;
    await choose(h.app);
    assert.match(h.app.fileControlName(MUSIC), /not uploaded/u);
    assert.match(h.messages.join('\n'), /Music file not uploaded/u);
    assert.ok(!h.messages.some((message) => message.startsWith('Music file uploaded')));
    assertVocabularyUntouched(h);
  });
}

test('bridge rejection is awaited and leaves a retryable file selection', async (t) => {
  fileReader(t);
  const h = harness();
  h.app.request = async () => { throw new Error('Transport disconnected.'); };
  await choose(h.app);
  assert.match(h.messages.join('\n'), /Transport disconnected/u);
  h.app.request = async () => landed();
  await choose(h.app);
  assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploaded)');
  assertVocabularyUntouched(h);
});

for (const event of ['onerror', 'onabort', 'malformed'] as const) {
  test(`file reader ${event} cannot dispatch or report success`, async (t) => {
    const readers = fileReader(t, true);
    const h = harness();
    h.app.onFilePicked(MUSIC, AUDIO);
    if (event === 'malformed') { readers[0]!.result = 'not a data URL'; readers[0]!.onload?.(); }
    else readers[0]![event]?.();
    await tick();
    assert.deepEqual(h.requests, []);
    assert.match(h.app.fileControlName(MUSIC), /not uploaded/u);
    assertVocabularyUntouched(h);
  });
}

test('an unavailable file reader reports its real blocker without dispatch', async (t) => {
  fileReader(t);
  Reflect.deleteProperty(globalThis, 'FileReader');
  const h = harness();
  await choose(h.app);
  assert.deepEqual(h.requests, []);
  assert.match(h.messages.join('\n'), /no local file reader/u);
  assertVocabularyUntouched(h);
});

test('the real dispatcher enforces discovery, media headers, write failures and confirmed size using process mocks', async (t) => {
  fileReader(t);
  const root = await mkdtemp(join(tmpdir(), 'music-upload-wiring-'));
  const commands: CommandRequest[] = [];
  let failWrite = false;
  let reportedSize = AUDIO.size;
  t.mock.method(NodeProcessExecutor.prototype, 'execute', async (request: CommandRequest) => {
    commands.push(request);
    const result = { status: 'succeeded', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    if (request.executable === 'git') return result; // Task-owned local-history initialization.
    assert.equal(request.executable, 'wsl.exe', 'Unexpected process must never escape the mock');
    if (request.args[0] === '--list') return { ...result, stdout: 'Test-WSL\n' };
    assert.equal(request.args[1], 'Test-WSL');
    const verb = request.args[3];
    assert.ok(['mkdir', 'base64', 'stat'].includes(verb!), `Unexpected media process: ${verb}`);
    if (verb === 'base64' && failWrite) return { ...result, status: 'failed', exitCode: 1, stderr: 'Write refused by target.' };
    if (verb === 'stat') return { ...result, stdout: String(reportedSize) };
    return result;
  });
  try {
    const dispatcher = createControlPlaneDispatcher({ userDataPath: root, resourcesPath: root, hosted: false });
    const server = dispatcher.serverInventory().add({ name: 'Task-owned WSL target', connectionKind: 'wsl', wslDistribution: 'Test-WSL' });
    const h = harness();
    h.app.target.id = server.id;
    h.app.request = async (action: string, extra: any) => {
      h.requests.push({ action, ...extra });
      return dispatcher.controlPlaneRequest({ requestId: `music-${h.requests.length}`, action, ...extra });
    };
    await choose(h.app);
    assert.equal(h.requests[0].serverId, server.id);
    const write = commands.find((command) => command.args[3] === 'base64');
    assert.deepEqual(write?.args, ['-d', 'Test-WSL', '--', 'base64', '-d', '-o', '/var/lib/asterisk/moh/hold.wav']);
    assert.equal(write?.input, Buffer.from(await AUDIO.arrayBuffer()).toString('base64'));
    assert.equal(h.app.fileControlName(MUSIC), 'hold.wav (uploaded)');

    commands.length = 0;
    await choose(h.app, new File(['not a wave header'], 'not-wave.wav'));
    assert.match(h.messages.at(-1)!, /RIFF\/WAVE header/u);
    assert.equal(commands.filter((command) => command.args[3] === 'base64').length, 0);

    failWrite = true;
    await choose(h.app);
    assert.match(h.messages.at(-1)!, /Write refused by target/u);
    failWrite = false;
    reportedSize = AUDIO.size - 1;
    await choose(h.app);
    assert.match(h.messages.at(-1)!, /but .* were sent/u);

    const unsupported = dispatcher.serverInventory().add({ name: 'Task-owned remote target', connectionKind: 'remoteLinux', host: 'pbx.example.invalid', user: 'asterisk' });
    h.app.target.id = unsupported.id;
    commands.length = 0;
    await choose(h.app);
    assert.match(h.messages.at(-1)!, /transport is registered but not yet wired/u);
    assert.equal(commands.length, 0);

    h.app.target.id = 'Not-discovered';
    await choose(h.app);
    assert.match(h.messages.at(-1)!, /not in the current discovery result/u);
    assert.equal(commands.filter((command) => command.args[3] === 'base64').length, 0);
    assertVocabularyUntouched(h);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(root, { recursive: true, force: true });
  }
});

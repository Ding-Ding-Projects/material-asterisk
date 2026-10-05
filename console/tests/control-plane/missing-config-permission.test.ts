import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WslConfigTransport } from '../../control-plane/wsl-config-transport.js';
import type { CommandRequest, CommandResult, ProcessExecutor } from '../../control-plane/executor.js';

class PermissionExecutor implements ProcessExecutor {
  readonly calls: CommandRequest[] = [];
  async execute(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    return {
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: `cp: cannot stat '/etc/asterisk/geolocation.conf': Permission denied`,
      durationMs: 1,
    };
  }
}

test('cannot-stat permission failure is never treated as an absent optional config', async () => {
  const executor = new PermissionExecutor();
  const transport = new WslConfigTransport({ executor, distribution: 'ding-pbx-console' });
  await assert.rejects(() => transport.backup('/etc/asterisk/geolocation.conf'), /Permission denied/u);
  assert.equal(executor.calls.some((call) => call.args[3] === 'touch'), false, 'permission failure created an absent marker');
});

test('a staging read failure cannot regenerate a configuration as if its original contents were empty', async () => {
  const executor = new PermissionExecutor();
  const transport = new WslConfigTransport({ executor, distribution: 'ding-pbx-console' });
  await assert.rejects(() => transport.stage('/etc/asterisk/geolocation.conf', [
    { name: 'location', entries: [{ key: 'type', value: 'location_info' }] },
  ]), /Permission denied/u);
  assert.equal(executor.calls.some((call) => call.args[3] === 'tee'), false, 'a failed original read reached the staged-file writer');
});

test('staging an explicitly absent resource still creates the requested initial configuration', async () => {
  const calls: CommandRequest[] = [];
  const executor: ProcessExecutor = {
    async execute(request): Promise<CommandResult> {
      calls.push(request);
      return request.args[3] === 'base64'
        ? { status: 'failed', exitCode: 1, stdout: '', stderr: 'No such file or directory', durationMs: 1 }
        : { status: 'succeeded', exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    },
  };
  const transport = new WslConfigTransport({ executor, distribution: 'ding-pbx-console' });
  await transport.stage('/etc/asterisk/geolocation.conf', [
    { name: 'location', entries: [{ key: 'type', value: 'location_info' }] },
  ]);
  const write = calls.find((call) => call.args[3] === 'tee');
  assert.ok(write);
  assert.match(String(write.input), /\[location\]/u);
});

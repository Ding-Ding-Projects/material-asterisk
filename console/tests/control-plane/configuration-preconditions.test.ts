import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigTransaction, StructuredConfigPlanner, type ConfigTransport } from '../../control-plane/config-transaction.js';

const RESOURCE = '/etc/asterisk/precondition.json';
const before = { setting: 'original' };
const after = { setting: 'desired' };

function transportAt(value: unknown) {
  let live = structuredClone(value);
  const mutations: string[] = [];
  const transport: ConfigTransport = {
    async read() { return structuredClone(live); },
    async backup() { mutations.push('backup'); return 'synthetic-backup'; },
    async stage(_resource, value) { mutations.push('stage'); live = value; return 'synthetic-stage'; },
    async validate() { mutations.push('validate'); },
    async apply() { mutations.push('apply'); },
    async rollback() { mutations.push('rollback'); },
  };
  return { transport, mutations, replace(value: unknown) { live = structuredClone(value); } };
}

test('a supplied stale precondition is refused instead of replacing a changed configuration', async () => {
  const h = transportAt({ setting: 'changed-by-someone-else' });
  await assert.rejects(new StructuredConfigPlanner().createPlan('plan', 'target', [
    { resource: RESOURCE, value: after, expectedBefore: before },
  ], h.transport), /changed since.*read/iu);
  assert.deepEqual(h.mutations, []);
});

test('a stale precondition is still refused when the requested value already matches live state', async () => {
  const h = transportAt(after);
  await assert.rejects(new StructuredConfigPlanner().createPlan('plan', 'target', [
    { resource: RESOURCE, value: after, expectedBefore: before },
  ], h.transport), /changed since.*read/iu);
});

test('matching empty and reordered-object preconditions are accepted without changing their meaning', async () => {
  for (const [live, expected] of [[[], []], [{ first: 1, second: 2 }, { second: 2, first: 1 }]]) {
    const h = transportAt(live);
    const plan = await new StructuredConfigPlanner().createPlan('plan', 'target', [
      { resource: RESOURCE, value: after, expectedBefore: expected },
    ], h.transport);
    assert.equal(plan.diffs.length, 1);
    assert.deepEqual(h.mutations, []);
  }
});

test('legacy callers without a precondition still receive a plan bound to the actual reading', async () => {
  const h = transportAt(before);
  const plan = await new StructuredConfigPlanner().createPlan('plan', 'target', [{ resource: RESOURCE, value: after }], h.transport);
  assert.deepEqual(plan.diffs[0].before, before);
});

test('a change after planning is refused before any transaction mutation', async () => {
  const h = transportAt(before);
  const plan = await new StructuredConfigPlanner().createPlan('plan', 'target', [{ resource: RESOURCE, value: after }], h.transport);
  h.replace({ setting: 'changed-after-planning' });
  const result = await new ConfigTransaction(h.transport).apply(plan);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /changed since.*read/iu);
  assert.deepEqual(h.mutations, []);
});

test('an unreadable preflight does not take a backup or stage a replacement', async () => {
  const h = transportAt(before);
  const plan = await new StructuredConfigPlanner().createPlan('plan', 'target', [{ resource: RESOURCE, value: after }], h.transport);
  h.transport.read = async () => { throw new Error('Synthetic read permission failure.'); };
  const result = await new ConfigTransaction(h.transport).apply(plan);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /read permission/u);
  assert.deepEqual(h.mutations, []);
});

test('a stale later resource prevents writes to the entire planned set', async () => {
  const first = RESOURCE;
  const second = '/etc/asterisk/second.json';
  const h = transportAt(before);
  const plan = await new StructuredConfigPlanner().createPlan('plan', 'target', [
    { resource: first, value: after }, { resource: second, value: after },
  ], h.transport);
  h.transport.read = async (resource) => resource === second ? { setting: 'newer' } : before;
  const result = await new ConfigTransaction(h.transport).apply(plan);
  assert.equal(result.status, 'failed');
  assert.equal(result.failedAction, `verify-before:${second}`);
  assert.deepEqual(h.mutations, []);
});

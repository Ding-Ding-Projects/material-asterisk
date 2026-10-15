import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmationCreditEligibility, confirmationCreditLabel, isHighDangerCeremony, type ConfirmationCreditContext } from '../../app/renderer/src/confirmation-credit';

const context = (extra: Partial<ConfirmationCreditContext> = {}): ConfirmationCreditContext => ({
  command: 'module reload res_pjsip.so', open: true, step: 0, credits: 5, settings: {}, ...extra,
});

test('high danger uses command semantics and fails closed for unknown commands, without display titles', () => {
  for (const command of ['module unload res_pjsip.so', ' module unload app_queue.so ', 'module unload -f res_pjsip.so', 'core restart gracefully', 'core restart now', 'core stop now', 'delete extension-one', 'channel request hangup PJSIP/one', 'mixmonitor start PJSIP/one', 'manager kick session 12', 'unrecognized operation', 'module reload res_pjsip.so; module unload app_queue.so']) {
    assert.equal(isHighDangerCeremony(command), true, command);
  }
  for (const command of ['module load res_pjsip.so', 'module reload res_pjsip.so', 'module show', 'core show uptime seconds']) {
    assert.equal(isHighDangerCeremony(command), false, command);
  }
});

test('missing or malformed high-danger protection never enables a shortcut', () => {
  for (const value of [undefined, true, null, 0, 1, '', 'false', [], {}]) {
    const result = confirmationCreditEligibility(context({ command: 'module unload res_pjsip.so', settings: { cr_danger: value } }));
    assert.equal(result.allowed, false, JSON.stringify(value));
    if (!result.allowed) assert.match(result.reason, /full confirmation/u);
  }
});

test('only explicitly enabled or default-enabled credit use is eligible', () => {
  assert.deepEqual(confirmationCreditEligibility(context()), { allowed: true, cost: 1 });
  assert.equal(confirmationCreditEligibility(context({ settings: { cr_enable: true } })).allowed, true);
  for (const value of [false, null, 0, 1, '', 'true', [], {}]) {
    assert.equal(confirmationCreditEligibility(context({ settings: { cr_enable: value } })).allowed, false, JSON.stringify(value));
  }
});

test('normal shortcuts cost exactly the configured amount and high-danger shortcuts cost at least two', () => {
  for (const cost of [1, 2, 3, 4, 5]) {
    assert.deepEqual(confirmationCreditEligibility(context({ settings: { cr_cost: cost } })), { allowed: true, cost });
    assert.deepEqual(confirmationCreditEligibility(context({ command: 'module unload res_pjsip.so', settings: { cr_danger: false, cr_cost: cost } })), { allowed: true, cost: Math.max(cost, 2) });
  }
});

test('invalid configured costs fail closed rather than silently charging one', () => {
  for (const cost of [null, false, true, 0, -1, 1.5, 6, Number.NaN, Number.POSITIVE_INFINITY, '1', [], {}]) {
    const result = confirmationCreditEligibility(context({ settings: { cr_cost: cost } }));
    assert.equal(result.allowed, false, String(cost));
    if (!result.allowed) assert.match(result.reason, /whole number/u);
  }
});

test('insufficient and invalid balances cannot execute a credit shortcut', () => {
  for (const credits of [undefined, null, 0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
    assert.equal(confirmationCreditEligibility(context({ credits, settings: { cr_cost: 5 } })).allowed, false, String(credits));
  }
  assert.equal(confirmationCreditEligibility(context({ credits: 1, command: 'module unload res_pjsip.so', settings: { cr_danger: false } })).allowed, false);
});

test('a closed or finished ceremony cannot spend a credit', () => {
  assert.equal(confirmationCreditEligibility(context({ open: false })).allowed, false);
  for (const step of [-1, 1.5, 4, 5, Number.NaN]) assert.equal(confirmationCreditEligibility(context({ step })).allowed, false);
});

test('the button label discloses the exact effective cost', () => {
  assert.equal(confirmationCreditLabel(1), 'Spend 1 confirmation credit and skip all four gates');
  assert.equal(confirmationCreditLabel(5), 'Spend 5 confirmation credits and skip all four gates');
});

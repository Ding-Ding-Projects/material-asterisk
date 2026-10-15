import { isAllowedCommandLine } from '../../../control-plane/asterisk-readings';
import { isAllowlistedWriteCommand } from '../../../control-plane/write-commands';

/** Credit eligibility is derived from action semantics, never translated titles. */
export interface ConfirmationCreditContext {
  command: string;
  open: boolean;
  step: number;
  credits: unknown;
  settings: Record<string, unknown>;
}

export type ConfirmationCreditEligibility =
  | { allowed: true; cost: number }
  | { allowed: false; reason: string };

/** This is a confirmation policy, not a command allowlist. The control plane still
 * independently rejects commands for which it has no verified executor. */
export function isHighDangerCeremony(command: string): boolean {
  const normalized = command.trim();
  if (isAllowedCommandLine(normalized)) return false;
  if (/^module (?:load|reload) /u.test(normalized) && isAllowlistedWriteCommand(normalized)) return false;
  // Unknown commands fail closed, including restart, unload, deletion and call actions.
  return true;
}

export function confirmationCreditEligibility(context: ConfirmationCreditContext): ConfirmationCreditEligibility {
  if (!context.open || !Number.isInteger(context.step) || context.step < 0 || context.step >= 4) {
    return { allowed: false, reason: 'No unfinished confirmation is open. Nothing was run or deducted.' };
  }
  if ((context.settings.cr_enable === undefined ? true : context.settings.cr_enable) !== true) {
    return { allowed: false, reason: 'Confirmation-credit shortcuts are disabled. Complete the confirmation instead.' };
  }
  const highDanger = isHighDangerCeremony(context.command);
  if (highDanger && context.settings.cr_danger !== false) {
    return { allowed: false, reason: 'This high-danger action requires the full confirmation. No credit was spent.' };
  }
  const configuredCost = context.settings.cr_cost === undefined ? 1 : context.settings.cr_cost;
  if (typeof configuredCost !== 'number' || !Number.isInteger(configuredCost) || configuredCost < 1 || configuredCost > 5) {
    return { allowed: false, reason: 'The confirmation-credit cost must be a whole number from 1 to 5. Complete the confirmation instead.' };
  }
  const cost = highDanger ? Math.max(configuredCost, 2) : configuredCost;
  if (typeof context.credits !== 'number' || !Number.isSafeInteger(context.credits) || context.credits < cost) {
    return { allowed: false, reason: `This action needs ${cost} confirmation credit${cost === 1 ? '' : 's'}. The available balance is insufficient; nothing was run or deducted.` };
  }
  return { allowed: true, cost };
}

export function confirmationCreditLabel(cost: number): string {
  return `Spend ${cost} confirmation credit${cost === 1 ? '' : 's'} and skip all four gates`;
}

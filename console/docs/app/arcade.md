# Confirmation credits

## Behavior

The four-gate ceremony is thorough and, twelve times a day, exhausting. Win credits here and spend the configured cost to skip a ceremony. Credits are earned, never bought with money. High-danger actions require the full ceremony while protection is on; otherwise they cost at least two credits. Credits are deducted only after the action succeeds. A credit never authorizes an unsupported command. It is backed by `arcade`. It lives on the App rail, under the Deploy & application group: Stand up a new server, then appearance, updates and the console itself.

## Configuration

### Spending rules

How credits are allowed to replace a ceremony.

- **Allow credits to skip ceremonies** (`cr_enable`) — a switch control, default `true`.
- **Cost per skip** (`cr_cost`) — a stepper control, default `1`, from `1` to `5`. An eligible high-danger shortcut costs the greater of this value and `2`; other eligible shortcuts cost exactly this value. The confirmation button shows the effective cost.
- **High-danger actions still need the full ceremony** (`cr_danger`) — a switch control, default `true`. Restarting Asterisk, unloading a module and deleting an endpoint are above the danger line. Leave this on unless you enjoy explaining outages.
- **Maximum credits held** (`cr_cap`) — a stepper control, default `20`.
- **Credits expire after** (`cr_expire`) — a slider control, default `7`.

## Failure modes and security

Every control here maps to a real key in arcade; an unreachable configuration store is shown as unreachable, never backfilled with placeholder values.

The shortcut checks its current enablement, danger protection, effective cost and balance again when invoked. Unknown commands require the same protection as high-danger actions; changing a display title cannot lower that protection. The control-plane command allowlist remains independently enforced.

Credit-cap and expiration values are stored but are not yet enforced by a grant ledger. There are no recorded grant timestamps from which to expire existing credits. Those controls should not be relied on to limit the balance or expire credits.

## Verification

Exercise every control against its documented default and its full option range, confirm the write lands in arcade, and confirm an invalid combination is rejected before it reaches Asterisk. Confirm every default shown here matches what a fresh install actually ships, and that changing a value here is reflected the next time this screen loads.

## Suggested articles

[History & git](history.md), [Customise everything](customise.md), and [Notifications](notifications.md).

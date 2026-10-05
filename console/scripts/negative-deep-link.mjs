#!/usr/bin/env node
/**
 * Deliberate red-then-green regression for the `ding-pbx://` product route.
 *
 * The defect this guards is one nothing can see, and it is the exact defect this route was
 * built to close. `inventories/design-parity.json` mapped every audited destination to a
 * product route, `design-reference/capture-manifest.generated.json` generated one for all
 * 32, and no code anywhere read a single one -- so no test failed, no build broke, and the
 * only symptom was a column that looked authoritative while naming an address nothing
 * answered. A route wired at one end and consumed at neither ships silently. That is what
 * these breaks are for.
 *
 * Each break removes exactly ONE guarded thing, runs the tests that are supposed to notice,
 * and requires them to fail; then restores it and requires the file to be byte-identical
 * again. Breaking several at once proves only that *something* among them is watched, which
 * is precisely how a wiring line ends up commented out with every unit test still green.
 *
 * Three traps this guards itself against, each of which has cost this repository real time:
 *
 *  - **A break that never landed.** Every replacement asserts the file's bytes actually
 *    changed. An edit that matched nothing reports success and changes nothing, and "no
 *    effect" then reads exactly like a passing guard.
 *  - **A restore that never landed.** Every restore asserts the file is byte-identical to
 *    what it was before, so a later break cannot run against a tree an earlier one damaged.
 *  - **CRLF.** Needles written with `\n` match nothing in a file stored with `\r\n`, so the
 *    break silently never lands -- see `forFile` at the foot of this file.
 *
 *     node console/scripts/negative-deep-link.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WIRING } from './destination-route-wiring.mjs';

const root = resolve(import.meta.dirname, '..');
const RULES = 'tests/control-plane/deep-link.test.ts';
const WIRED = 'tests/ui/deep-link-wired.test.tsx';

/** @type {Array<{name: string, file: string, find: string, replace: string, tests: string[]}>} */
const BREAKS = [
  // ------------------------------------------------------- what the route refuses
  {
    name: 'the light theme is accepted, so a link asking for a palette this build does not have opens dark and says nothing',
    file: 'shared/deep-link.ts',
    find: "    return refuse('This console has only a dark theme, so a link asking for the light one cannot be opened as written.');",
    replace: "    return { ok: true, target: { destinationId: rest, state: 'default', theme: 'dark', width: 1440, height: 1000, scale: 1 } };",
    tests: [RULES],
  },
  {
    name: 'any theme at all is accepted, so a spelling mistake in a link opens a screen instead of reporting itself',
    file: 'shared/deep-link.ts',
    find: "  if (theme !== 'dark') {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: "a display scale factor is accepted from a link, which no window can actually change",
    file: 'shared/deep-link.ts',
    find: "  if (scaleRaw !== null && scaleRaw !== '1') {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a state other than the default is accepted, so a link names a screen state nothing produces',
    file: 'shared/deep-link.ts',
    find: "  if (state !== 'default') {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a size below the window own minimum is accepted and silently widened instead of refused',
    file: 'shared/deep-link.ts',
    find: '  if (value < minimum) {',
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a size is no longer required to be a whole number of pixels',
    file: 'shared/deep-link.ts',
    find: '  if (!Number.isInteger(value)) {',
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'an unbounded size is accepted, so one link can ask for a window of hundreds of megapixels',
    file: 'shared/deep-link.ts',
    find: '  if (value > DEEP_LINK_MAX_EDGE) {',
    replace: '  if (false) {',
    tests: [RULES],
  },

  // ------------------------------------------------------- what the route is
  {
    name: 'any scheme is accepted, so an https link opens a screen in this console',
    file: 'shared/deep-link.ts',
    find: '  if (url.protocol !== `${DEEP_LINK_SCHEME}:`) {',
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'any authority is accepted, so this scheme quietly gains addresses it never defined',
    file: 'shared/deep-link.ts',
    find: '  if (url.hostname.toLowerCase() !== DEEP_LINK_HOST) {',
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'the schemeless-authority form stops being named, so ding-pbx:destination/dash reports the wrong problem',
    file: 'shared/deep-link.ts',
    find: "  if (url.hostname === '') {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a destination id is no longer checked for shape, so a link may name anything at all',
    file: 'shared/deep-link.ts',
    find: '  if (!DESTINATION_ID.test(rest)) {',
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a path is no longer decoded before the single-segment check, so %2F smuggles a second segment past it',
    file: 'shared/deep-link.ts',
    find: "  const rest = decodeURIComponent(url.pathname).replace(/^\\//u, '');",
    replace: "  const rest = url.pathname.replace(/^\\//u, '');",
    tests: [RULES],
  },
  {
    name: 'a link is no longer required to name exactly one destination',
    file: 'shared/deep-link.ts',
    find: "  if (rest.includes('/')) {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'a non-string command-line entry is coerced instead of refused',
    file: 'shared/deep-link.ts',
    find: "  if (typeof raw !== 'string' || raw.trim() === '') {",
    replace: '  if (false) {',
    tests: [RULES],
  },
  {
    name: 'membership stops being checked, so a link naming a screen this build has never had reports success',
    file: 'shared/deep-link.ts',
    find: '  if (knownDestinationIds.includes(target.destinationId)) {',
    replace: '  if (true) {',
    tests: [RULES, WIRED],
  },
  {
    name: 'the command line is searched for the wrong scheme, so no link is ever found on it',
    file: 'shared/deep-link.ts',
    find: '  const prefix = `${DEEP_LINK_SCHEME}:`;',
    replace: "  const prefix = 'ding-pbx-console:';",
    tests: [RULES],
  },
  {
    /* One break, two properties: the scheme match stops being case-insensitive, so an
     * upper-cased link on the command line is skipped -- and the next one along is
     * returned instead, which is also the first-wins ordering going wrong. */
    name: 'the command-line scan becomes case-sensitive, so an upper-cased link is skipped and a later one wins',
    file: 'shared/deep-link.ts',
    find: '    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed;',
    replace: '    if (trimmed.startsWith(prefix)) return trimmed;',
    tests: [RULES],
  },

  // Production wiring uses destination-route.ts and the onDestination bridge. Keep
  // the historical parser's rule regressions above, and mutate the live seams here.
  ...WIRING.map(([file, pattern, consequence]) => {
    const relative = file.replace(/^console\//u, '');
    const source = readFileSync(resolve(root, relative), 'utf8').replaceAll('\r\n', '\n');
    const matched = source.match(pattern)?.[0];
    if (!matched) throw new Error(`No production wiring anchor found: ${file}: ${consequence}`);
    return {
      name: consequence, file: relative, find: matched,
      replace: matched.replace(/^(\s*)(\S)/u, '$1// $2'), tests: [WIRED],
    };
  }),
  {
    name: 'a startup route is discarded instead of held for the renderer',
    file: 'app/electron/deep-link.ts',
    find: '    held = sent ? undefined : route;',
    replace: '    held = undefined;', tests: [WIRED],
  },
  {
    name: 'the screen moves without the rail',
    file: 'app/renderer/src/App.tsx',
    find: '    this.openScreen(resolution.destinationId);',
    replace: '    this.setState({ screen: resolution.destinationId });', tests: [WIRED],
  },
  {
    name: 'malformed destination encodings are thrown instead of refused',
    file: 'shared/destination-route.ts',
    find: "    return { ok: false, reason: 'destination has invalid percent encoding' };",
    replace: "    throw new URIError('invalid encoding');", tests: ['tests/control-plane/destination-route.test.ts'],
  },

  // ------------------------------------------------------- the generated product-route column
  {
    /* The column the roadmap item is about. This is the break that matters most, because
     * it is the exact state the route was in before this change: a generated `builtRoute`
     * naming an address the application does not answer, with nothing anywhere to notice. */
    name: 'one generated product route goes back to naming an address this application does not answer',
    file: 'design-reference/capture-manifest.generated.json',
    find: '"builtRoute": "ding-pbx://destination/dash?',
    replace: '"builtRoute": "ding-pbx-console://open/dash?',
    tests: [RULES],
  },
  {
    name: 'one generated product route opens a different destination from the row it sits in',
    file: 'design-reference/capture-manifest.generated.json',
    find: '"builtRoute": "ding-pbx://destination/cdr?',
    replace: '"builtRoute": "ding-pbx://destination/dash?',
    tests: [RULES],
  },
];

/**
 * Every `find`/`replace` above is written with `\n`, and parts of this checkout are stored
 * with CRLF. A multi-line needle written with `\n` matches nothing in a CRLF file, so the
 * break silently never lands -- which reads exactly like a guard that passed.
 */
function forFile(source, text) {
  return source.includes('\r\n') ? text.replace(/\n/gu, '\r\n') : text;
}

function run(tests) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

if (run([RULES, WIRED, 'tests/control-plane/destination-route.test.ts']) !== 0) {
  throw new Error('The untouched route tests must pass before planting failures.');
}
let failures = 0;
for (const breakage of BREAKS) {
  const path = resolve(root, breakage.file);
  const original = readFileSync(path, 'utf8');
  const find = forFile(original, breakage.find);
  if (!original.includes(find)) {
    console.error(`SKIPPED-AS-FAILURE: ${breakage.name}\n  the text this break edits is not in ${breakage.file} any more, so the break would never land`);
    failures += 1;
    continue;
  }
  const broken = original.replace(find, forFile(original, breakage.replace));
  if (broken === original) {
    console.error(`SKIPPED-AS-FAILURE: ${breakage.name}\n  the replacement changed nothing in ${breakage.file}`);
    failures += 1;
    continue;
  }
  let redStatus;
  try {
    writeFileSync(path, broken);
    redStatus = run(breakage.tests);
  } finally {
    writeFileSync(path, original);
  }
  if (readFileSync(path, 'utf8') !== original) {
    console.error(`FATAL: ${breakage.file} was not restored byte-for-byte; stop and check the tree`);
    process.exit(2);
  }
  if (redStatus === 0) {
    console.error(`FAILED (stayed green): ${breakage.name}`);
    failures += 1;
    continue;
  }
  if (run(breakage.tests) !== 0) {
    console.error(`FAILED after restoring: ${breakage.name}`);
    failures += 1;
    continue;
  }
  console.log(`red then restored green: ${breakage.name}`);
}

if (failures > 0) {
  console.error(`\n${failures} of ${BREAKS.length} break(s) did not turn the tests red.`);
  process.exit(1);
}
console.log(`\nall ${BREAKS.length} breaks turned their tests red and restored green.`);

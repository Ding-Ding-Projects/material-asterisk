# Browser-style tabbed navigation

Presents application and settings content as discrete, navigable tabs rather than one long scrolling page.

## Behavior

Every major surface, including settings, is meant to use a persistent tab strip, dockable to any screen edge, with overflow handling, reordering, and pinning, rather than a single scrolling column.

## Configuration

Tabs would support keyboard navigation with correct roles and states, and the strip would collapse gracefully at narrow widths without clipping labels.

## Current status

**Desktop application:** Partial. The desktop renders a tab strip with separate searches for the current strip, tab groups, and all open tabs. Each search trigger uses a bundled Material Symbols glyph, an explicit accessible action name, and its existing search scope. This repair does not establish complete native tab-management or accessibility acceptance.

**Documentation website:** Partial. Every top-level page and composed article receives the same ARIA tablist with persisted left, right, top, and bottom docking. Left is the default, and side docking collapses to the compact header below 900px. Reordering, pinning, grouping, overflow management, and the four independent tab searches remain incomplete.

## Failure modes

When more tabs are open than the strip can show, the intended behavior is an overflow menu listing the rest rather than silently clipping the last tab off-screen. This icon repair does not verify every overflow state.

## Accessibility and localization

The three search buttons have explicit action names; their decorative ligature text is hidden from the accessibility tree. Focused tests verify those attributes and activation scopes. Native screen-reader behavior, focus visibility, reduced motion, and the complete language-mode matrix still require broader acceptance testing.

## Verification

`tests/ui/tab-strip-icons.test.tsx` verifies the actual rendered button markup, accessible names, font-class binding, and three activation scopes. `tests/ui/design-drift.test.mjs` checks that a fresh compiler and extension run reproduces the generated source. Inspection of the bundled font's substitution table confirmed all three required ligatures. These checks do not replace packaged Windows rendering or native assistive-technology verification.

## Suggested articles

[Tab groups and tab search](tab-groups-and-searches.md), [Command palette](command-palette.md), [Material appearance system](material-appearance.md), [Appearance](../app/appearance.md), [Platform feature index](README.md).

# Customise everything

## Behavior

The global layer reaches across the console, while each rendered element can still override it from its own context menu. It is backed by the local console profile.

## Configuration

### Fun

English and Cantonese have independent funny levels from 1 (fully serious) to 5 (maximum playfulness), both defaulting to 5. `fun_english` and `fun_cantonese` persist separately, and each has its own reset control. Notification and dialog wrappers preserve facts while styling the selected language.

Other fun controls cover copy tone, celebrations, confetti, sound, hidden surprises and per-element appearance randomness. The global summary derives from the two language levels.

### School mode and narration

- `school_mode` forces English text and narration, fully serious copy, and hides the covered Cantonese/bilingual options, funny-level controls, vocabulary controls and destination. Existing startup-surprise suppression also reads this mode. Search and unrelated controls remain available; hidden entries are removed from palettes.
- The stored language, narration, funny levels and uploaded vocabulary return after successful unlock. Applying the active mode cancels earlier speech without disabling narration.
- `school_name` changes the local group heading and status messages. Some authored control labels and palette entries still retain the shipped name; no cross-application synchronization is implemented.
- `school_set_credential` consumes the entered PIN/password into a local digest, and `school_unlock` verifies it before deactivation. This is a presentation speed bump, not a security boundary or operating-system credential-vault integration. The input is cleared after consumption.
- `nar_enabled` is off by default. The narrator persists language, compatible voice identities, rate, pitch, quiet state and the explicit screen-reader override. Platform accessibility state is also read when available.

### Motion

Global timing. Individual elements can still set their own.

- `mo_speed` controls animation speed.
- `mo_curve` selects easing.
- `mo_screen` and `mo_dialog` select screen and dialog transitions.
- `mo_reduce` respects reduced motion.

### Layout, theme, behavior and profiles

The remaining groups control rail position, density, dimensions, theme, accent, contrast, launch behavior, confirmation behavior, history, profile selection and export behavior. Each value is persisted by the owning control and has a generated explanation.

## Failure modes and security

An unavailable settings store leaves the last known state in place and reports the refresh failure. Invalid names restore the previous valid name. The credential value never enters settings, exports, history, logs, captures or renderer state after submission.

## Verification

The design source is compiled into the renderer. The dynamic event inventory records localized events and intentional plain-English fallbacks. The focused narration and language modules cover the pure behavior; built-artifact interaction evidence remains in the per-surface inventory.

## Suggested articles

[Appearance](appearance.md), [Language modes](../platform/language-modes.md), [School mode](../platform/school-mode.md), [Spoken narration](../platform/narration.md), [Notifications](notifications.md).

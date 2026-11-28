---
name: fitness-platform-parity
description: Keep the Fitness website (apps/fitness) and iPhone app (apps/fitness-ios) familiar to the same person. Use for any user-visible change to either app, including UI fixes, copy, layout, interactions and week, workout, food, body or progress screens.
---

# Fitness platform parity

People use Fitness on the website and on the iPhone, often on the same day. A screen they know on one should feel familiar on the other. Every user-visible change to one app carries the matching change to the other, in the same pull request where practical.

## What stays the same

- **Words.** Headings, button labels, status text, empty states, notices and errors use the same wording. "Reorganise week", "Save week", "Back to today" and "No changes yet." read the same on both.
- **Structure.** Screens show the same information in the same order, grouped the same way.
- **Interaction.** The same task works the same way. Dragging sessions between days on the iPhone means dragging them on the website too.
- **Rules.** Behaviour that decides what the user sees or saves lives in `@bent/fitness-contracts`, and both apps import it. Weekly plan progress and week reorganisation are in `packages/fitness-contracts/src/week.ts`. Move a rule there before porting the screen that uses it. Never write a second copy in one app.
- **Meaning of colour and symbols.** Done is green, missed is orange, planned is the accent colour. A met plan shows a check. Progress shows a bar.

## What follows the platform

Each app uses its platform's controls and conventions for the shared design.

| iPhone app | Website |
| --- | --- |
| SwiftUI lists, sheets and native date pickers | Semantic HTML, `<dialog class="sheet">`, `<input type="date">` |
| SF Symbols | Line icons in `src/components/icons.tsx` |
| Haptics and VoiceOver hints | Focus handling, `aria-live` announcements and visually hidden text |
| Drag in edit mode | Pointer drag for mouse and touch, plus arrow keys on a focused handle |
| Liquid Glass header controls | Standard header buttons |

Features that need the device stay on the iPhone: Apple Health sync, Live Activities, the home screen widget, workout reminders and the workout screen staying awake. Features that need a browser or server stay on the website: MCP connections, API keys and browser agent tools. Keep their surrounding screens consistent.

## Workflow

1. List each user-visible change in the work, with its screen.
2. Mark each one as shared, platform-adapted or platform-only, using the sections above.
3. Move any rule it depends on into `@bent/fitness-contracts`, with tests in `packages/fitness-contracts/tests`. Re-export it from the app's logic module if existing tests import it there.
4. Make the change on both apps. Copy wording exactly.
5. Check both apps. Run the website's typecheck, lint and browser checks, and the iPhone app's typecheck, lint and tests. Compare before and after screenshots of the website at phone and desktop widths with the iPhone screens.
6. Describe both platforms' changes in the pull request. When the other platform's change has to follow separately, open an issue for it and link it from the pull request.

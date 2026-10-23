# pi-interrupt-me

[![npm version](https://img.shields.io/npm/v/pi-interrupt-me?style=for-the-badge)](https://www.npmjs.com/package/pi-interrupt-me)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge)]()

When you press Esc mid-reply in [pi](https://pi.dev), pi drops the interrupted assistant message from every later request. The model never sees what it was thinking, so your next message reads as if you replied to yourself.

This extension keeps that message in the outgoing context as a finished reply:

- **Thinking block:** the last 300 characters of the interrupted reasoning (prefixed `[…]` when cut), replayed in the model's normal reasoning slot.
- **Text block:**

  ```
  [Interrupted by the user before this reply finished.]

  Partial answer:
  any text it had started

  Unfinished tool call (not executed): read
  ```

Only what is sent to the model changes. The session file is untouched, and messages with no content are still dropped as before.

## Install

```bash
pi install npm:pi-interrupt-me
```

Then restart pi.

## Notes

- **Why 300 characters, from the end:** an interrupt usually means the reasoning was going wrong, and failed attempts left in context raise later error rates ([arXiv 2605.08563](https://arxiv.org/abs/2605.08563)). 300 is CliffCompaction's cap on old thoughts ([arXiv 2609.26779](https://arxiv.org/abs/2609.26779)), about one paragraph: enough for your correction to have something to refer to. The end is kept because it is what you reacted to. Change `MAX_REASONING_CHARS` in `index.ts` to adjust.
- Unfinished tool calls are listed by name and never executed or replayed, since their arguments are incomplete.
- The rewrite happens in pi's `context` event, before provider-specific conversion.

## Test

```bash
node test.ts
```

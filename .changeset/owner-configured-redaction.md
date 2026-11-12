---
"intervu": minor
---

Owner-configured redaction makes URL-mode reviews safe on apps with personal data. Markup under `data-intervu-redact` is masked in every snapshot and annotation, regardless of configuration. With `intervu({ redact: true })` in the Vite config the whole page masks: every text node and the `value`, `placeholder`, `alt`, `title` and `aria-label` attributes are replaced per character (letters to `x`, digits to `0`), preserving length, whitespace and DOM structure, so selectors, ids and `data-intervu-src` still resolve. Masking happens in the browser before anything leaves the page, and nothing the agent or the CLI sends can turn it off; the human's typed message is never redacted, and `poll` marks a Feedback whose snapshot was redacted so the agent knows the placeholders are deliberate.

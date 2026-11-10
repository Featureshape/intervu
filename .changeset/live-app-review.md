---
"intervu": minor
---

Review a running Vite + React app, not just an HTML file: add `intervu()` from `intervu/vite` to the app's Vite plugins, then `intervu <url>` opens a floating panel in the app's own tab. Annotations carry the JSX `file:line:col` that rendered the clicked element, so the agent edits the right file. `poll`, `reply` and `end` take the URL as well as a file, and the Conversation stays live across tabs, HMR and full reloads. The plugin runs on the dev server only and answers only the app's own origin. Re-run `intervu setup` to pick up the updated Skill.

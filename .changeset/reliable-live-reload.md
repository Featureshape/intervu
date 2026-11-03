---
"intervu": minor
---

Make live-reload reliable: the browser no longer misses edits when its connection drops, and artifacts inside large repos no longer trigger a recursive file watch. Add `intervu reply <file> <message>` so the agent can post into the conversation without waiting, and teach the Skill to explore the codebase during a review while a poll keeps listening. Keep the scroll position across live-reloads, fix `intervu <file>` failing when it had to start the daemon, and teach the Skill to show a skeleton early, keep a reusable brief, and make targeted edits. Re-run `intervu setup` to pick up the updated Skill.

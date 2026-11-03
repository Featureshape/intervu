---
"intervu": minor
---

`intervu poll` now writes each DOM snapshot to a file and prints `domSnapshotPath` instead of the whole page, so long reviews use far less of the agent's context. It falls back to the inline `domSnapshot` if the file cannot be written. Re-run `intervu setup` to pick up the updated Skill.

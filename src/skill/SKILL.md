---
name: intervu
description: Drive a collaborative human review of an HTML artifact you generated - open a review, long-poll for the human's annotated feedback, edit the file so the browser live-reloads, and reply while you keep listening. Use when you have produced an HTML artifact and want a human to review it before you continue.
---

# intervu

intervu turns an HTML artifact you generated into a collaborative browser review surface.
You open a review for the file, the human annotates the rendered page in their browser, and you long-poll for that feedback and live-edit the file in response.
Every command prints content-first TOON with a `help` line telling you the next step.

## When to reach for intervu

Reach for intervu when you have produced an HTML artifact - a page, a prototype, a report - and you want a human to review it before you move on, or when you are about to build one with a human waiting to see it.
Open a review instead of guessing whether the result is right, or asking the human to describe what they see in prose.

## The loop

1. **Open or resume a Session.**
   Run `intervu <file>` (an alias for `intervu open <file>`) on the artifact's path.
   This starts the review daemon if needed, opens a Session for the file, and pops a browser tab showing your artifact inside intervu's chrome.
   Re-running `open` on the same path resumes the same Session - the key is derived from the path, so it is stable across your edits.

2. **Poll for Feedback.**
   Run `intervu poll <file>` and block.
   The poll holds open silently until the human sends, then returns their queued Feedback as TOON.
   While the poll is open the human sees your presence as `listening`.

3. **Read the Feedback and edit the artifact.**
   Apply the changes to the file on disk.
   The browser live-reloads on save, so the human sees your edit immediately.

4. **Reply and keep listening.**
   Run `intervu poll <file> --agent-reply "<what you changed>"`.
   The `--agent-reply` message is posted into the human's conversation panel before the poll waits again, so the thread reads as one conversation and the human knows what you did.

5. **End when you are done.**
   When the review is finished, run `intervu end <file>` to end the Session.
   The human can also end it from the browser; your current or next poll then returns `ended`.
   Ending is reversible - re-running `intervu <file>` reopens the path to a live review.

## Keeping the human waiting less

The human is often live with someone else, such as a customer on a call, so time to something visible matters as much as total time.

**Show a skeleton first.**
If the artifact will take more than about a minute, write a skeleton before you start deep research: the real title, the layout, and a labelled placeholder for each planned section.
Open the review straight away, then fill in one section at a time and save after each, because every save reloads the page while keeping the human's scroll position.
Mark unfinished sections clearly so nobody mistakes a placeholder for a finding.

**Keep a brief next to the artifact.**
After your first exploration, write `<artifact>.brief.md` beside it: the key files, the data shapes, and the decisions made so far, each with enough detail to act on without re-reading the source.
Read it first on every later turn, and add to it whenever you explore something new.
It does not replace exploring - it means you only explore what you have not already seen.
Do not commit it unless the human asks.

**Edit, do not rewrite.**
Change only what the Feedback asks for, using targeted edits to the existing file.
Rewrite the whole file only when the human asks for a different structure, because a rewrite's time grows with the size of the artifact.

## Keeping the human informed

Run `intervu reply <file> "<message>"` to post into the conversation panel and return immediately.
Unlike `poll --agent-reply`, it never waits, so you can use it while a poll is open.
Before any edit or investigation that takes more than a few seconds, post a one-line acknowledgement so the human knows what you are doing.

## Exploring the codebase during a review

Not every Feedback is an edit.
The human may ask how something else in the codebase works, or ask you to look at another part of it before deciding what to change.
Treat that as a normal part of the review, and go wherever the question leads, including outside the artifact's directory:

1. Acknowledge with `intervu reply`.
2. Keep a poll open while you explore, so a follow-up reaches you straight away.
   Run the poll as a background command if your harness supports it, and delegate long investigations to a subagent so you can still respond.
3. Post the answer with `intervu reply`, and edit the artifact only if the human asked for that.

Exploring does not disturb the review: only writes to the artifact itself reload the page.
To show what you found as a new page, write a new artifact and run `intervu <new-file>` alongside the current one.
Each artifact has its own Session, so each needs its own poll.

## Reading a Feedback

Each Feedback carries three things:

- **Annotations** - the markers the human attached to the page.
  Each has a CSS `selector`, the element `tag`, and the surrounding `text` (a `text` annotation also carries the exact `selectedText`).
- **The message** - the human's words for this submission.
- **The DOM snapshot** - the serialized live DOM the human actually annotated.
  The annotation selectors resolve against this snapshot, not against your on-disk source.
  For an interactive artifact the rendered DOM diverges from the file on disk, so read the snapshot to locate what each selector points at, then make the change in the source file.

## Poll discipline

The poll is built to be safe under interruption:

- It is safe to kill and re-run.
  Queued Feedback is never lost - a re-run drains whatever is waiting.
- A silent poll means it is listening, not that it failed or hung.
  Leave it blocked until the human sends.
- Pass `--timeout <seconds>` if you want the poll to return `timedOut` instead of waiting indefinitely, then re-run to keep listening.
- If your shell tool kills foreground commands after a time limit, run the poll in the background instead, so Feedback does not wait for you to notice and re-run it.
- Keep one poll open per artifact at a time.

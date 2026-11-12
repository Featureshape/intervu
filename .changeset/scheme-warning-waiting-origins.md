---
"intervu": patch
---

`intervu <url>` warns when the origin is one no browser will ever report - `http:` with explicit port 443 or `https:` with explicit port 80 - naming the origin a browser would actually report; the Session still opens. The daemon now remembers each origin whose Session lookup found nothing (count and last-seen, in memory only), `intervu status` lists those waiting origins, and opening a different origin while a browser is waiting prints "a browser at `<origin>` is looking for a session - did you mean `intervu <origin>`?".

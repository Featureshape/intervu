---
"intervu": patch
---

The in-page badge tells the truth about why no review is running. When the relay refuses the page's request, the badge reads "intervu: refused by dev server" and its card names the rejection in plain words, echoes the page origin the browser sent, and points at the dev server log for the full comparison. When no daemon answers behind the dev server, the badge's card says so and names the port it tried, beside the open command. The 403 body now carries the rejection reason and the origins the refused request itself presented - never the server's trusted-host list.

---
"intervu": minor
---

The agent can now see what the browser side sees without a human relaying the tab. The `intervu/vite` plugin pushes plugin-reports to the local daemon over loopback - its dev server's origin, the page origins it has seen succeed, and refusal tallies - on dev server start, every 30s while tabs hold relay connections, and promptly after a refusal. The new `intervu status` asks the live daemon and prints its version, port and state dir, every Session with its Presence, the reporting plugins and their refusal tallies; bare `intervu` stays offline. When `intervu <url>`'s probe cannot reach the app but the daemon holds a fresh plugin-report covering that origin, the help line says what the plugin reported instead of the false "plugin missing" warning. Reports live in daemon memory only; an old daemon ignores them and an old plugin keeps working untouched.

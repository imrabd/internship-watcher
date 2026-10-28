# internship-watcher

Checks a list of company job boards (Greenhouse and Lever) every 5 minutes using GitHub Actions. It sends a phone notification through [ntfy](https://ntfy.sh) when a new Summer 2027 engineering internship is posted.

- `boards.json`: the companies to watch. Add `{"ats": "greenhouse", "slug": "<name>"}` or `{"ats": "lever", "slug": "<name>"}`.
- `watch.js`: fetches the boards, filters for US engineering internships, and pushes new ones.
- `state.json`: jobs already seen (updated automatically).
- The ntfy channel is stored as the `NTFY_TOPIC` repository secret.

To run it by hand: Actions tab → "Watch internship boards" → Run workflow.

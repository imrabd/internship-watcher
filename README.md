# internship-watcher

Every 5 minutes, GitHub Actions checks for new Summer 2027 engineering internships and sends a phone notification through [ntfy](https://ntfy.sh). It watches two sources:

- **Company job boards** in `boards.json`: Greenhouse and Lever (`{"ats": "greenhouse", "slug": "<name>"}` or `{"ats": "lever", "slug": "<name>"}`), and 42 Workday career sites (NVIDIA, Intel, Micron, RTX, Northrop Grumman, Cisco, Salesforce, and others) read by `workday.js`. A Workday entry looks like `{"ats": "workday", "name": "NVIDIA", "slug": "nvidia", "host": "nvidia.wd5.myworkdayjobs.com", "site": "NVIDIAExternalCareerSite"}`, taken from the company's job URL. Workday only gives the posting day, so Workday alerts cover jobs posted today or yesterday that haven't been seen before. Bursts are grouped into one alert, as with intern-list. A newly added board's first check only records its current postings.
- **[intern-list.com](https://www.intern-list.com/)**: its Software Engineering, Data Analysis, ML and AI, Engineering and Development, and Cybersecurity lists, read from the public Airtable tables the site embeds (`internlist.js`). intern-list refreshes these in bursts through the day. One check with up to 3 new jobs sends one alert per job; a bigger burst sends a single summary alert listing them, with buttons for the first three. Companies already in `boards.json` are skipped here because their board alerts come sooner.

Both sources use the same filters: US, internship or co-op, Summer 2027 (or no term given), engineering-type role, not PhD-only. intern-list and Workday jobs also skip mechanical, civil, and similar fields. intern-list jobs dated more than 3 days ago are skipped too.

Files:
- `watch.js`: runs one check and sends the alerts. `DRY=1 node watch.js` prints the alerts instead of sending them.
- `state.json` (boards) and `seen_internlist.txt` (intern-list): jobs already seen, updated automatically.
- The ntfy channel is stored as the `NTFY_TOPIC` repository secret.

To run it by hand: Actions tab → "Watch internship boards" → Run workflow.

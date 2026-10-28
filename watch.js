// Cloud version of the internship watcher, run by GitHub Actions on a schedule.
// Checks the Greenhouse and Lever boards in boards.json plus intern-list.com's engineering lists, and sends new
// Summer 2027 engineering internships to the ntfy channel in the NTFY_TOPIC secret.
// Seen jobs are tracked in state.json (boards) and seen_internlist.txt (intern-list), committed back by the workflow.
// DRY=1 prints what would be sent instead of sending it.
const fs = require('fs');
const IL = require('./internlist');

const BOARDS = JSON.parse(fs.readFileSync('boards.json', 'utf8'));
const STATE_FILE = 'state.json', IL_FILE = 'seen_internlist.txt';
const TOPIC = process.env.NTFY_TOPIC, DRY = !!process.env.DRY;
const FIRST_RUN_HOURS = 2; // on the very first run, only postings from the last 2 hours count as new
const DIGEST_OVER = 3;      // more new intern-list jobs than this in one check are sent as a single summary alert

const INTERN = /\bintern(ship)?s?\b|co-?op/i;
const WRONG_TERM = /\b(2025|2026)\b|fall|spring|winter/i;
const PHD = /\bph\.?d\b|doctoral|master'?s only|mba\b/i;
const TECH = /engineer|software|developer|\bdata\b|machine learning|\bml\b|\bai\b|research|quant|firmware|embedded|hardware|electrical|security|cyber|infrastructure|platform|systems|robotic|analytics|computer|technolog|\bswe\b|\bsre\b|devops|cloud|fpga|silicon|asic|autonomy|perception|controls/i;
const NOT_TECH = /consult|sales|account (development|executive|manager)|marketing|recruit|talent|business (operations|development|analyst)|\bfinance\b|accounting|legal|product manag|program manag|\bhr\b|people|customer|support|communications|content|design intern|product design|industrial design|graphic/i;
const NON_US = /london|toronto|vancouver|montreal|canada|united kingdom|\buk\b|india|bangalore|bengaluru|hyderabad|singapore|hong kong|japan|tokyo|china|shanghai|germany|berlin|munich|ireland|dublin|paris|france|amsterdam|netherlands|israel|tel aviv|australia|sydney|poland|warsaw|mexico|brazil|spain|madrid|zurich|switzerland|sweden|stockholm|taiwan|korea|seoul/i;

const isMatch = (title, loc) => INTERN.test(title) && TECH.test(title) && !NOT_TECH.test(title)
  && !(WRONG_TERM.test(title) && !/2027/.test(title)) && !PHD.test(title)
  && !(NON_US.test(loc) && !/remote|united states|\busa?\b/i.test(loc));

async function fetchBoard(b) {
  if (b.ats === 'lever') {
    const r = await fetch(`https://api.lever.co/v0/postings/${b.slug}?mode=json`);
    if (!r.ok) throw new Error(r.status);
    return (await r.json()).map(j => ({ key: `lever:${b.slug}:${j.id}`, company: b.slug, title: j.text,
      loc: [j.categories?.location, j.country].filter(Boolean).join(', '), url: j.hostedUrl, published: j.createdAt }));
  }
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs`);
  if (!r.ok) throw new Error(r.status);
  return ((await r.json()).jobs || []).map(j => ({ key: `gh:${b.slug}:${j.id}`, company: j.company_name || b.slug, title: j.title,
    loc: j.location?.name || '', url: j.absolute_url, published: Date.parse(j.first_published || j.updated_at) }));
}

const ascii = s => s.replace(/[^\x20-\x7E]/g, '');
async function send(title, body, click, actions) {
  if (DRY) return console.log(`[dry] ${title}\n${body}\n-> ${click}` + (actions ? `\n   buttons: ${actions}` : ''));
  const headers = { Title: ascii(title), Click: click, Tags: 'briefcase', Priority: 'high' };
  if (actions) headers.Actions = ascii(actions);
  const r = await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body, headers });
  console.log(`${r.ok ? 'sent' : 'push failed ' + r.status}: ${title}`);
}

async function push(j) {
  const age = Math.max(0, Math.round((Date.now() - j.published) / 60000));
  await send(`New internship: ${j.company}`, `${j.title} (${j.loc}), posted ${age} min ago`, j.url);
}

// A few new intern-list jobs get one alert each; a bigger batch (the lists refresh in bursts) gets one summary
// alert listing them, with buttons for the first three. Tapping the alert opens intern-list.com.
async function pushInternList(jobs) {
  if (jobs.length <= DIGEST_OVER) {
    for (const j of jobs) await send(`New internship: ${j.company}`, `${j.title} (${j.loc}), via intern-list`, j.url);
    return;
  }
  const lines = jobs.slice(0, 15).map(j => `${j.company}: ${j.title} (${j.loc})`);
  if (jobs.length > 15) lines.push(`...and ${jobs.length - 15} more on intern-list.com`);
  const buttons = jobs.slice(0, 3).map(j => `view, ${j.company.replace(/[,;]/g, ' ').slice(0, 24)}, ${j.url}`).join('; ');
  await send(`${jobs.length} new internships on intern-list`, lines.join('\n'), 'https://www.intern-list.com/', buttons);
}

(async () => {
  if (!TOPIC && !DRY) throw new Error('NTFY_TOPIC secret is not set');
  const old = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const firstRun = !Object.keys(old).length;
  const next = {}, found = [], failed = [], covered = new Set();
  const cutoff = Date.now() - FIRST_RUN_HOURS * 3600e3;
  for (let i = 0; i < BOARDS.length; i += 8) {
    await Promise.all(BOARDS.slice(i, i + 8).map(async b => {
      try {
        const jobs = await fetchBoard(b);
        covered.add(IL.norm(b.slug));
        for (const j of jobs) {
          covered.add(IL.norm(j.company));
          if (!isMatch(j.title, j.loc)) continue;
          next[j.key] = 1; // only matching internships still posted are remembered, so state.json stays tiny
          if (!old[j.key] && (!firstRun || j.published >= cutoff)) found.push(j);
        }
      } catch (e) {
        failed.push(`${b.slug}(${e.message})`);
        for (const k of Object.keys(old)) if (k.split(':')[1] === b.slug) next[k] = old[k]; // a failed board keeps its state
      }
    }));
  }
  for (const j of found.sort((a, b) => b.published - a.published)) await push(j);
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));

  // intern-list.com: skips companies whose own board is watched above (those alerts come sooner from the board).
  const ilOld = new Set(fs.existsSync(IL_FILE) ? fs.readFileSync(IL_FILE, 'utf8').split('\n').filter(Boolean) : []);
  const il = await IL.fetchAll().catch(e => ({ jobs: [], failed: [`all(${e.message})`] }));
  const ilNext = new Set(), ilFound = [];
  for (const j of il.jobs) {
    if (!IL.matches(j)) continue;
    ilNext.add(j.key);
    // The first intern-list check only records what's already listed.
    if (ilOld.size && !ilOld.has(j.key) && IL.isFresh(j) && !covered.has(IL.norm(j.company))) ilFound.push(j);
  }
  // If a list couldn't be read, keep everything seen before so those jobs don't alert again next time.
  if (il.failed.length) for (const k of ilOld) ilNext.add(k);
  if (ilFound.length) await pushInternList(ilFound);
  fs.writeFileSync(IL_FILE, [...ilNext].sort().join('\n') + '\n');

  console.log(`checked ${BOARDS.length} boards, ${found.length} new` + (failed.length ? `, unreachable: ${failed.join(', ')}` : ''));
  console.log(`checked intern-list (${il.jobs.length} listings), ${ilFound.length} new` + (ilOld.size ? '' : ' (first check: recorded current listings)')
    + (il.failed.length ? `, unreadable: ${il.failed.join(', ')}` : ''));
})().catch(e => { console.error(e); process.exit(1); });

// Cloud version of the internship watcher, run by GitHub Actions on a schedule.
// Checks the Greenhouse, Lever, and Workday boards in boards.json plus intern-list.com's engineering lists, and sends new
// Summer 2027 engineering internships to the ntfy channel in the NTFY_TOPIC secret.
// Seen jobs are tracked in state.json (boards) and seen_internlist.txt (intern-list), committed back by the workflow.
// DRY=1 prints what would be sent instead of sending it.
const fs = require('fs');
const IL = require('./internlist');
const WD = require('./workday');

const BOARDS = JSON.parse(fs.readFileSync('boards.json', 'utf8'));
const STATE_FILE = 'state.json', IL_FILE = 'seen_internlist.txt';
const TOPIC = process.env.NTFY_TOPIC, DRY = !!process.env.DRY;
const FIRST_RUN_HOURS = 2; // a board's first check only counts Greenhouse/Lever postings from the last 2 hours as new
const DIGEST_OVER = 3;      // more new intern-list or Workday jobs than this in one check are sent as a single summary alert

const INTERN = /\bintern(ship)?s?\b|co-?op/i;
const WRONG_TERM = /\b(2025|2026)\b|fall|spring|winter/i;
const PHD = /\bph\.?d\b|doctoral|master'?s only|mba\b/i;
const TECH = /engineer|software|developer|\bdata\b|machine learning|\bml\b|\bai\b|research|quant|firmware|embedded|hardware|electrical|security|cyber|infrastructure|platform|systems|robotic|analytics|computer|technolog|\bswe\b|\bsre\b|devops|cloud|fpga|silicon|asic|autonomy|perception|controls/i;
const NOT_TECH = /consult|sales|account (development|executive|manager)|marketing|recruit|talent|business (operations|development|analyst)|\bfinance\b|accounting|legal|product manag|program manag|\bhr\b|people|customer|support|communications|content|design intern|product design|industrial design|graphic/i;
const NON_US = /london|toronto|vancouver|montreal|ottawa|quebec|ontario|canada|united kingdom|\buk\b|england|scotland|india|bangalore|bengaluru|hyderabad|karnataka|chennai|pune|noida|gurgaon|gurugram|mumbai|delhi|singapore|hong kong|japan|tokyo|china|shanghai|shenzhen|beijing|suzhou|tianjin|jiangsu|changzhou|germany|berlin|munich|ireland|dublin|cork|galway|paris|france|amsterdam|netherlands|belgium|israel|tel aviv|petah tikva|yokneam|haifa|australia|sydney|new zealand|poland|warsaw|wroclaw|mexico|queretaro|guadalajara|monterrey|san luis potosi|brazil|sao paulo|são paulo|campinas|itajuba|argentina|chile|colombia|peru|lima|costa rica|dominican|santo domingo|spain|madrid|barcelona|cugat|italy|milan|milano|bolzano|vicenz|portugal|lisbon|zurich|switzerland|austria|vienna|sweden|stockholm|denmark|norway|finland|czech|prague|romania|hungary|croatia|zagreb|turkey|istanbul|armenia|saudi|riyadh|uae|dubai|qatar|egypt|south africa|taiwan|korea|seoul|malaysia|penang|kulim|thailand|chon buri|vietnam|philippines|manila|taguig|indonesia/i;

const isMatch = j => INTERN.test(j.title) && TECH.test(j.title) && !NOT_TECH.test(j.title)
  && !(WRONG_TERM.test(j.title) && !/2027/.test(j.title)) && !PHD.test(j.title)
  && !(NON_US.test(j.loc) && !/remote|united states|\busa?\b/i.test(j.loc))
  && !(j.ats === 'workday' && IL.OFF_FIELD.test(j.title)); // big Workday employers post lots of mechanical/civil roles

async function fetchBoard(b) {
  if (b.ats === 'workday') return WD.fetchWorkday(b);
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

// A few new jobs get one alert each; a bigger batch (intern-list refreshes and big Workday employers post in bursts)
// gets one summary alert listing them, with buttons for the first three.
async function pushBatch(jobs, source, click) {
  const note = j => source === 'Workday' ? `on Workday, posted ${j.postedText}` : 'via intern-list';
  if (jobs.length <= DIGEST_OVER) {
    for (const j of jobs) await send(`New internship: ${j.company}`, `${j.title} (${j.loc}), ${note(j)}`, j.url);
    return;
  }
  const lines = jobs.slice(0, 15).map(j => `${j.company}: ${j.title} (${j.loc})`);
  if (jobs.length > 15) lines.push(`...and ${jobs.length - 15} more`);
  const buttons = jobs.slice(0, 3).map(j => `view, ${j.company.replace(/[,;]/g, ' ').slice(0, 24)}, ${j.url}`).join('; ');
  await send(`${jobs.length} new internships on ${source}`, lines.join('\n'), click || jobs[0].url, buttons);
}

(async () => {
  if (!TOPIC && !DRY) throw new Error('NTFY_TOPIC secret is not set');
  const old = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const next = {}, found = [], wdFound = [], failed = [], covered = new Set();
  const cutoff = Date.now() - FIRST_RUN_HOURS * 3600e3;
  for (let i = 0; i < BOARDS.length; i += 8) {
    await Promise.all(BOARDS.slice(i, i + 8).map(async b => {
      const marker = `board:${b.ats}:${b.slug}`;
      try {
        const jobs = await fetchBoard(b);
        covered.add(IL.norm(b.slug)); if (b.name) covered.add(IL.norm(b.name));
        // A board's first check (new to the list) only records its postings, so adding a company doesn't flood alerts.
        const firstCheck = !old[marker];
        next[marker] = 1;
        for (const j of jobs) {
          covered.add(IL.norm(j.company));
          if (!isMatch(j)) continue;
          // only matching internships still posted are remembered, so state.json stays small
          next[j.key] = j.ats === 'workday' ? old[j.key] || Date.now() : 1;
          if (old[j.key]) continue;
          if (j.ats === 'workday') { if (!firstCheck && j.fresh) wdFound.push(j); }
          else if (!firstCheck || j.published >= cutoff) found.push(j);
        }
        // Workday only returns the newest postings (and keyword-search sites can reorder them), so a job that drops off the
        // first pages is remembered for 14 days rather than forgotten and re-alerted if it comes back.
        if (b.ats === 'workday') for (const [k, t] of Object.entries(old))
          if (k.startsWith(`wd:${b.slug}:`) && !next[k] && t > Date.now() - 14 * 864e5) next[k] = t;
      } catch (e) {
        failed.push(`${b.slug}(${e.message})`);
        // a failed board keeps its state
        for (const k of Object.keys(old)) if (k === marker || (k.split(':')[1] === b.slug && !k.startsWith('board:'))) next[k] = old[k];
      }
    }));
  }
  for (const j of found.sort((a, b) => b.published - a.published)) await push(j);
  if (wdFound.length) await pushBatch(wdFound, 'Workday');
  fs.writeFileSync(STATE_FILE, JSON.stringify(next));

  // intern-list.com: skips companies whose own board is watched above (those alerts come sooner from the board).
  // seen_internlist.txt lines: "<key> <first seen ms>".
  const now = Date.now();
  const ilOld = new Map(fs.existsSync(IL_FILE) ? fs.readFileSync(IL_FILE, 'utf8').split(/\s*\n/).filter(Boolean)
    .map(l => { const [k, t] = l.trim().split(' '); return [k, +t || now]; }) : []);
  const il = await IL.fetchAll().catch(e => ({ jobs: [], failed: [`all(${e.message})`] }));
  const ilNext = new Map(), ilFound = [];
  for (const j of il.jobs) {
    if (!IL.matches(j)) continue;
    ilNext.set(j.key, ilOld.get(j.key) || now);
    // The first intern-list check only records what's already listed.
    if (ilOld.size && !ilOld.has(j.key) && IL.isFresh(j) && !covered.has(IL.norm(j.company))) ilFound.push(j);
  }
  // intern-list rebuilds its tables in place, so a check can catch a list half-filled. Jobs missing from this read are
  // remembered for 30 days so they don't alert again when they reappear.
  for (const [k, t] of ilOld) if (!ilNext.has(k) && t > now - 30 * 864e5) ilNext.set(k, t);
  if (ilFound.length) await pushBatch(ilFound, 'intern-list', 'https://www.intern-list.com/');
  fs.writeFileSync(IL_FILE, [...ilNext].sort().map(([k, t]) => `${k} ${t}`).join('\n') + '\n');

  console.log(`checked ${BOARDS.length} boards, ${found.length + wdFound.length} new` + (failed.length ? `, unreachable: ${failed.join(', ')}` : ''));
  console.log(`checked intern-list (${il.jobs.length} listings), ${ilFound.length} new` + (ilOld.size ? '' : ' (first check: recorded current listings)')
    + (il.failed.length ? `, unreadable: ${il.failed.join(', ')}` : ''));
})().catch(e => { console.error(e); process.exit(1); });

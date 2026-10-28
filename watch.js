// Cloud version of the internship watcher, run by GitHub Actions on a schedule.
// Checks the Greenhouse and Lever boards in boards.json and sends new Summer 2027 engineering internships
// to the ntfy channel in the NTFY_TOPIC secret. Seen jobs are tracked in state.json (committed back by the workflow).
const fs = require('fs');

const BOARDS = JSON.parse(fs.readFileSync('boards.json', 'utf8'));
const STATE_FILE = 'state.json';
const TOPIC = process.env.NTFY_TOPIC;
const FIRST_RUN_HOURS = 2; // on the very first run, only postings from the last 2 hours count as new

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

async function push(j) {
  const age = Math.max(0, Math.round((Date.now() - j.published) / 60000));
  const r = await fetch(`https://ntfy.sh/${TOPIC}`, { method: 'POST', body: `${j.title} (${j.loc}), posted ${age} min ago`,
    headers: { Title: `New internship: ${j.company}`.replace(/[^\x20-\x7E]/g, ''), Click: j.url, Tags: 'briefcase', Priority: 'high' } });
  console.log(`${r.ok ? 'sent' : 'push failed ' + r.status}: ${j.company} | ${j.title} | ${j.loc} | ${age} min ago`);
}

(async () => {
  if (!TOPIC) throw new Error('NTFY_TOPIC secret is not set');
  const old = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const firstRun = !Object.keys(old).length;
  const next = {}, found = [], failed = [];
  const cutoff = Date.now() - FIRST_RUN_HOURS * 3600e3;
  for (let i = 0; i < BOARDS.length; i += 8) {
    await Promise.all(BOARDS.slice(i, i + 8).map(async b => {
      try {
        for (const j of await fetchBoard(b)) {
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
  console.log(`checked ${BOARDS.length} boards, ${found.length} new` + (failed.length ? `, unreachable: ${failed.join(', ')}` : ''));
})().catch(e => { console.error(e); process.exit(1); });

// Reads intern-list.com's US internship tables. The site shows them as public Airtable views, refreshed through the day.
// Each refresh rebuilds a whole table, so a posting counts as new when its Jobright job id hasn't been seen before.
// The same file is in tools/autofill (laptop watcher) and tools/cloud-watcher (GitHub copy); change both.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// [category, Airtable base, shared view] for the engineering-type lists on intern-list.com (US).
const TABLES = [
  ['Software Engineering', 'app17F0kkWQZhC6HB', 'shrOTtndhc6HSgnYb'],
  ['Data Analysis', 'appbsiP1flCoaXCSm', 'shreRS1cFLbduwBaU'],
  ['Machine Learning and AI', 'appjSXAWiVF4d1HoZ', 'shrf04yGbrK3IebAl'],
  ['Engineering and Development', 'appFuMULJB6cXtL6L', 'shrabXspvMx1kfuQw'],
  ['Cybersecurity', 'appvVpV9JOUFrdDyu', 'shrPvpTT69P8fVy6H'],
];

const INTERN = /\bintern(ship)?s?\b|co-?op/i;
const PHD = /\bph\.?d\b|doctoral|master'?s only|mba\b/i;
const TECH = /engineer|software|developer|\bdata\b|machine learning|\bml\b|\bai\b|research|quant|firmware|embedded|hardware|electrical|security|cyber|infrastructure|platform|systems|robotic|analytics|computer|technolog|\bswe\b|\bsre\b|devops|cloud|fpga|silicon|asic|autonomy|perception|controls/i;
const NOT_TECH = /consult|sales|account (development|executive|manager)|marketing|recruit|talent|business (operations|development|analyst)|\bfinance\b|accounting|legal|product manag|program manag|\bhr\b|people|customer|support|communications|content|design intern|product design|industrial design|graphic/i;
// The "Engineering and Development" list mixes in non-ECE engineering (Workday postings get the same filter).
const OFF_FIELD = /mechanical|civil|chemical|structural|environmental|construction|manufacturing|process eng|quality eng|industrial eng|biomedical|petroleum|mining|geotech|transportation eng|water resources|packaging|facilities|estimat|surveying|hvac|plumbing|clinical/i;
// Title + "Hire Time" must not point at a term other than Summer 2027.
const otherTerm = s => !/summer/i.test(s) && (/fall|spring|winter|autumn|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i.test(s)
  || (/\b20(2[4-68]|29)\b/.test(s) && !/2027/.test(s)));

const matches = j => INTERN.test(j.title) && TECH.test(j.title) && !NOT_TECH.test(j.title) && !OFF_FIELD.test(j.title)
  && !PHD.test(j.title) && !otherTerm(`${j.title} ${j.hire}`) && !/palantir/i.test(j.company);
// Only alert on postings dated in the last 3 days (older rows that reappear after a refresh are not news).
const isFresh = j => Date.parse(j.date) >= Date.now() - 3 * 864e5;
// Company key for skipping companies the Greenhouse/Lever board watcher already covers (it is faster for those).
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs?|the)\b/g, '').replace(/\s+/g, '');

function shortLoc(s) {
  const parts = String(s || '').split('\n').map(x => x.trim().replace(/, United States$/, '')).filter(x => x && x !== 'Multi Location');
  return parts.length > 1 ? `${parts[0]} +${parts.length - 1} more` : parts[0] || 'United States';
}

async function readTable([category, app, shr]) {
  const page = await fetch(`https://airtable.com/embed/${app}/${shr}`, { headers: { 'User-Agent': UA } });
  if (!page.ok) throw new Error(`page ${page.status}`);
  const m = (await page.text()).match(/urlWithParams: "([^"]+)"/);
  if (!m) throw new Error('no data link');
  const r = await fetch('https://airtable.com' + JSON.parse(`"${m[1]}"`), { headers: { 'User-Agent': UA,
    'x-airtable-application-id': app, 'x-requested-with': 'XMLHttpRequest', 'x-time-zone': 'America/Chicago', 'x-user-locale': 'en' } });
  if (!r.ok) throw new Error(`data ${r.status}`);
  const t = (await r.json()).data.table, col = name => t.columns.find(c => c.name === name)?.id;
  const C = { title: col('Position Title'), date: col('Date'), apply: col('Apply'), loc: col('Location'), company: col('Company'), hire: col('Hire Time') };
  return t.rows.map(row => {
    const v = row.cellValuesByColumnId, id = ((v[C.apply]?.url || '').match(/jobs\/info\/(\w+)/) || [])[1];
    return id && { key: `il:${id}`, company: String(v[C.company] || '').trim(), title: String(v[C.title] || '').trim(),
      loc: shortLoc(v[C.loc]), url: `https://jobright.ai/jobs/info/${id}`, date: v[C.date] || '', hire: v[C.hire] || '', category };
  }).filter(Boolean);
}

// All rows from every table, one per job (a job can be listed under two categories). failed = tables that couldn't be read.
async function fetchAll() {
  const jobs = new Map(), failed = [];
  const results = await Promise.allSettled(TABLES.map(readTable));
  results.forEach((res, i) => {
    if (res.status === 'rejected') return failed.push(`${TABLES[i][0]}(${res.reason.message})`);
    for (const j of res.value) if (!jobs.has(j.key)) jobs.set(j.key, j);
  });
  return { jobs: [...jobs.values()], failed };
}

module.exports = { fetchAll, matches, isFresh, norm, TABLES, OFF_FIELD };

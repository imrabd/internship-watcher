// Reads internship postings from a company's Workday career site (the public JSON the site itself uses).
// Board entry: {"ats": "workday", "name": "NVIDIA", "slug": "nvidia", "host": "nvidia.wd5.myworkdayjobs.com", "site": "NVIDIAExternalCareerSite"}
// Workday only says "Posted Today / Yesterday / N Days Ago", so a posting is new when its job id hasn't been seen before.
// The same file is in tools/autofill (laptop watcher) and tools/cloud-watcher (GitHub copy); change both.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const FACET_PARAMS = /^(workerSubType|jobFamilyGroup|jobFamily|jobFamilies|Job_Family)$/;
const INTERN_LABEL = /\b(interns?|internships?|co-?op)\b/i;

async function post(b, body) {
  const r = await fetch(`https://${b.host}/wday/cxs/${b.slug}/${b.site}/jobs`, { method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

// The site's own "Intern" filter (job type or job family), e.g. workerSubType "Intern (Fixed Term)". null if it has none.
function internFilter(facets) {
  const ids = {};
  for (const f of facets || []) {
    if (!FACET_PARAMS.test(f.facetParameter)) continue;
    for (const v of f.values || []) if (INTERN_LABEL.test(v.descriptor || '')) (ids[f.facetParameter] ||= []).push(v.id);
  }
  const param = ['workerSubType', ...Object.keys(ids)].find(p => ids[p]);
  return param ? { [param]: ids[param] } : null;
}

const daysAgo = s => /today/i.test(s) ? 0 : /yesterday/i.test(s) ? 1 : +((s || '').match(/(\d+)\+? Days? Ago/i) || [, 99])[1];

// Newest intern postings first. Sites with an Intern filter are sorted newest first, so 2 pages cover anything new;
// sites without one fall back to a keyword search for "intern".
async function fetchWorkday(b) {
  const first = await post(b, { appliedFacets: {}, limit: 1, offset: 0, searchText: '' });
  const filter = internFilter(first.facets);
  const postings = [];
  for (let offset = 0; offset < 40; offset += 20) {
    const page = await post(b, { appliedFacets: filter || {}, limit: 20, offset, searchText: filter ? '' : 'intern' });
    postings.push(...(page.jobPostings || []));
    if ((page.jobPostings || []).length < 20 || (filter && daysAgo(postings[postings.length - 1].postedOn) > 2)) break;
  }
  return postings.filter(p => p.externalPath).map(p => {
    const seg = p.externalPath.split('/').pop(), id = seg.includes('_') ? seg.slice(seg.lastIndexOf('_') + 1) : seg;
    const age = daysAgo(p.postedOn);
    return { key: `wd:${b.slug}:${id}`, ats: 'workday', company: b.name || b.slug, title: p.title || '', loc: p.locationsText || '',
      url: `https://${b.host}/en-US/${b.site}${p.externalPath}`, published: Date.now() - age * 864e5,
      postedText: (p.postedOn || '').replace(/^Posted /i, '').toLowerCase(), fresh: age <= 1 };
  });
}

module.exports = { fetchWorkday };

#!/usr/bin/env node
// Prospect finder for the migration offer: which public GitHub organisations still run Jenkins, and which of
// them are mid-migration to GitHub Actions right now? Writes a ranked list, an audit per organisation and an
// email draft per organisation. Read-only against the GitHub API; nothing is posted or sent.
//
//   GITHUB_TOKEN=… node tools/prospects.js [--out DIR] [--queries N] [--top N] [--step collect|enrich|rank|audit|emails|all]
//
// Everything is cached under <out>/cache so re-runs are cheap.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null)).filter(Boolean));
const OUT = String(args.out || join(process.env.HOME, 'dev', 'prospects'));
const CACHE = join(OUT, 'cache');
mkdirSync(CACHE, { recursive: true });
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is required'); process.exit(1); }
const STEP = String(args.step || 'all');
const TOP = Number(args.top || 40);
const DAY = 86400e3;
const now = Date.now();
const days = (iso) => (iso ? Math.round((now - Date.parse(iso)) / DAY) : null);
const log = (...a) => process.stderr.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ GitHub client with caching and rate handling
async function gh(url, { ttlDays = 7, allow404 = false } = {}) {
  const key = createHash('sha1').update(url).digest('hex');
  const f = join(CACHE, key + '.json');
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, 'utf8'));
    if (now - c.at < ttlDays * DAY) return c.body;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url.startsWith('http') ? url : 'https://api.github.com' + url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'jenkins-to-actions-prospects' } });
    if (res.status === 404 && allow404) { writeFileSync(f, JSON.stringify({ at: now, body: null })); return null; }
    if ((res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'))) {
      const reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000;
      const wait = Math.max(Number(res.headers.get('retry-after') || 0) * 1000, reset ? reset - Date.now() + 2000 : 60000);
      log(`rate limited on ${url.replace(/\?.*/, '')}; waiting ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 15 * 60e3));
      continue;
    }
    if (res.status === 422 || res.status === 451 || res.status === 409 || res.status === 403) { writeFileSync(f, JSON.stringify({ at: now, body: null })); return null; }
    if (!res.ok) { if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; } throw new Error(`${res.status} for ${url}`); }
    const body = await res.json();
    writeFileSync(f, JSON.stringify({ at: now, body }));
    return body;
  }
  return null;
}

// ------------------------------------------------------------ 1. collect candidate repositories via code search
const QUERIES = [
  'filename:Jenkinsfile size:>8000',
  'filename:Jenkinsfile size:4000..8000',
  'filename:Jenkinsfile size:2500..4000',
  'filename:Jenkinsfile size:1500..2500',
  'filename:Jenkinsfile size:900..1500',
  'filename:Jenkinsfile kubernetes',
  'filename:Jenkinsfile docker',
  'filename:Jenkinsfile withCredentials',
  'filename:Jenkinsfile parallel',
  'filename:Jenkinsfile sonar',
  'filename:Jenkinsfile helm',
  'filename:Jenkinsfile terraform',
  'filename:Jenkinsfile slackSend',
  'filename:Jenkinsfile junit',
  'filename:Jenkinsfile language:Groovy',
];
async function collect() {
  const file = join(OUT, 'candidates.json');
  const seen = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const n = Number(args.queries || QUERIES.length);
  for (const q of QUERIES.slice(0, n)) {
    for (let page = 1; page <= 10; page++) {
      const r = await gh(`/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`, { ttlDays: 30 });
      if (!r || !r.items) break;
      for (const it of r.items) {
        const repo = it.repository;
        if (!repo || repo.fork || repo.private) continue;
        if (!/^Jenkinsfile/i.test(it.path.split('/').pop()) && !/\.jenkinsfile$/i.test(it.path)) continue;
        const cur = seen[repo.full_name] || { full: repo.full_name, owner: repo.owner.login, ownerType: repo.owner.type, paths: [] };
        if (!cur.paths.includes(it.path)) cur.paths.push(it.path);
        seen[repo.full_name] = cur;
      }
      log(`${q} page ${page}: ${r.items.length} items, ${Object.keys(seen).length} repos so far`);
      if (r.items.length < 100) break;
      await sleep(6500); // code search: 10 requests/minute
    }
    writeFileSync(file, JSON.stringify(seen, null, 1));
  }
  return seen;
}

// ------------------------------------------------------------ 2. enrich: activity, workflows, dates
async function enrich(cands) {
  const file = join(OUT, 'repos.json');
  const out = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const list = Object.values(cands).filter((c) => c.ownerType === 'Organization');
  log(`enriching ${list.length} organisation repositories`);
  let i = 0;
  for (const c of list) {
    i++;
    if (out[c.full] && out[c.full].checked && now - Date.parse(out[c.full].checked) < 7 * DAY) continue;
    const r = await gh(`/repos/${c.full}`, { allow404: true });
    if (!r || r.archived || r.disabled || r.fork) { out[c.full] = { full: c.full, skip: true, checked: new Date().toISOString() }; continue; }
    const rec = { full: c.full, owner: c.owner, stars: r.stargazers_count, pushed: r.pushed_at, pushedDays: days(r.pushed_at), language: r.language, defaultBranch: r.default_branch, paths: c.paths, checked: new Date().toISOString() };
    if (rec.pushedDays > 240) { rec.skip = true; out[c.full] = rec; continue; }
    const jfPath = c.paths.sort((a, b) => a.length - b.length)[0];
    const jf = await gh(`/repos/${c.full}/commits?path=${encodeURIComponent(jfPath)}&per_page=1`, { allow404: true });
    rec.jenkinsfileTouched = jf && jf[0] ? jf[0].commit.committer.date : null;
    rec.jenkinsfileDays = days(rec.jenkinsfileTouched);
    const wf = await gh(`/repos/${c.full}/contents/.github/workflows?ref=${encodeURIComponent(r.default_branch)}`, { allow404: true });
    rec.workflows = Array.isArray(wf) ? wf.filter((f) => /\.ya?ml$/.test(f.name)).map((f) => f.name) : [];
    if (rec.workflows.length) {
      const wc = await gh(`/repos/${c.full}/commits?path=.github/workflows&per_page=1`, { allow404: true });
      rec.workflowsTouched = wc && wc[0] ? wc[0].commit.committer.date : null;
      rec.workflowsDays = days(rec.workflowsTouched);
    }
    rec.status = status(rec);
    out[c.full] = rec;
    if (i % 25 === 0) { writeFileSync(file, JSON.stringify(out, null, 1)); log(`[${i}/${list.length}] ${c.full}: ${rec.status}`); }
  }
  writeFileSync(file, JSON.stringify(out, null, 1));
  return out;
}
function status(r) {
  const jfLive = r.jenkinsfileDays !== null && r.jenkinsfileDays <= 365;
  const wfLive = r.workflows.length > 0 && r.workflowsDays !== null && r.workflowsDays <= 180;
  if (jfLive && wfLive) return 'migrating';
  if (jfLive && !r.workflows.length) return 'jenkins';
  if (jfLive) return 'jenkins+old-workflows';
  if (wfLive) return 'finishing';
  return 'stale';
}

// ------------------------------------------------------------ 3. rank organisations
const WEIGHT = { migrating: 3, jenkins: 2, 'jenkins+old-workflows': 1.5, finishing: 0.5, stale: 0 };
async function rank(repos) {
  const orgs = {};
  for (const r of Object.values(repos)) {
    if (r.skip || !r.status || r.status === 'stale') continue;
    const o = orgs[r.owner] || (orgs[r.owner] = { org: r.owner, repos: [], score: 0 });
    o.repos.push(r);
    o.score += WEIGHT[r.status] * (1 + Math.log10(1 + (r.stars || 0)) / 2);
  }
  const ranked = Object.values(orgs).sort((a, b) => b.score - a.score).slice(0, TOP * 2);
  for (const o of ranked) {
    const p = await gh(`/orgs/${o.org}`, { allow404: true, ttlDays: 30 });
    if (p) Object.assign(o, { name: p.name, email: p.email, blog: p.blog, publicRepos: p.public_repos, location: p.location, twitter: p.twitter_username, description: p.description });
    o.repos.sort((a, b) => WEIGHT[b.status] - WEIGHT[a.status] || b.stars - a.stars);
    o.counts = Object.fromEntries(['migrating', 'jenkins', 'jenkins+old-workflows', 'finishing'].map((s) => [s, o.repos.filter((r) => r.status === s).length]));
  }
  writeFileSync(join(OUT, 'orgs.json'), JSON.stringify(ranked, null, 1));
  const L = ['# Jenkins → Actions prospects', '', `Generated ${new Date().toISOString().slice(0, 10)} from public GitHub data. "migrating" = Jenkinsfile touched in the last year and .github/workflows touched in the last 6 months; "jenkins" = live Jenkinsfile, no workflows.`, '', '| # | Organisation | Score | Migrating | Jenkins only | Stars (top repo) | Contact | Site |', '|---|---|---|---|---|---|---|---|'];
  ranked.slice(0, TOP).forEach((o, i) => L.push(`| ${i + 1} | [${o.name || o.org}](https://github.com/${o.org}) | ${o.score.toFixed(1)} | ${o.counts.migrating} | ${o.counts.jenkins} | ${o.repos[0].stars} | ${o.email || ''} | ${o.blog || ''} |`));
  L.push('', '## Repositories per organisation', '');
  for (const o of ranked.slice(0, TOP)) {
    L.push(`### ${o.name || o.org} (${o.org})`, '', o.description ? `> ${o.description}` : '', '');
    for (const r of o.repos.slice(0, 12)) L.push(`- ${r.status} · [${r.full}](https://github.com/${r.full}) · ★${r.stars} · Jenkinsfile ${r.jenkinsfileDays}d ago${r.workflows.length ? ` · ${r.workflows.length} workflow(s), last ${r.workflowsDays}d ago` : ''} · ${r.paths.join(', ')}`);
    L.push('');
  }
  writeFileSync(join(OUT, 'index.md'), L.join('\n'));
  log(`ranked ${ranked.length} organisations → ${join(OUT, 'index.md')}`);
  return ranked;
}

// ------------------------------------------------------------ 4. audit the top organisations' candidate repos
function audit(ranked) {
  const cli = new URL('../cli/index.js', import.meta.url).pathname;
  for (const o of ranked.slice(0, TOP)) {
    const dir = join(OUT, 'orgs', o.org);
    if (existsSync(join(dir, 'report.md'))) continue;
    const repos = o.repos.slice(0, 15).map((r) => r.full).join(',');
    log(`auditing ${o.org}: ${o.repos.length} repos`);
    try { execFileSync('node', [cli, 'audit', '--repos', repos, '--out', dir], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, timeout: 10 * 60e3 }); }
    catch (e) { log(`audit failed for ${o.org}: ${String(e.stderr || e.message).slice(-300)}`); }
  }
}

// ------------------------------------------------------------ 5. email drafts
function emails(ranked) {
  for (const o of ranked.slice(0, TOP)) {
    const dir = join(OUT, 'orgs', o.org);
    const inv = existsSync(join(dir, 'inventory.json')) ? JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8')) : null;
    const jobs = inv ? inv.jobs.filter((j) => j.type && j.type.startsWith('pipeline')) : [];
    const clean = jobs.filter((j) => j.todos === 0 && !j.sharedLibrary).length;
    const todo = jobs.filter((j) => j.todos > 0).length;
    const shared = jobs.filter((j) => j.sharedLibrary).length;
    const migrating = o.repos.filter((r) => r.status === 'migrating');
    const example = (migrating[0] || o.repos[0]).full.split('/')[1];
    const name = o.name || o.org;
    const subject = migrating.length ? `${name}'s remaining Jenkinsfiles, converted` : `${name}'s Jenkinsfiles → GitHub Actions, converted (free)`;
    const body = [
      'Hi,', '',
      migrating.length
        ? `I noticed ${name} is part-way through moving CI to GitHub Actions: ${example} has both a Jenkinsfile and recent workflow commits${migrating.length > 1 ? `, and ${migrating.length - 1} other ${migrating.length - 1 === 1 ? 'repository is' : 'repositories are'} in the same state` : ''}.`
        : `I noticed ${name} still runs Jenkins for ${o.repos.length === 1 ? example : `${o.repos.length} public repositories (${example} among them)`}.`,
      '',
      `I build ci2actions.dev, a free Jenkinsfile → GitHub Actions converter, and I ran it over your public Jenkinsfiles${jobs.length ? `: ${jobs.length} pipeline${jobs.length === 1 ? '' : 's'}, ${clean} convert${clean === 1 ? 's' : ''} cleanly, ${todo} need${todo === 1 ? 's' : ''} some hand work${shared ? `, ${shared} use${shared === 1 ? 's' : ''} a shared library` : ''}` : ''}. The report and the converted workflows are attached; the TODO steps fail loudly so nothing disappears silently. No strings attached, use them if they help.`,
      '',
      `If there is a private estate behind these, I do a fixed-fee audit (£490): a ranked inventory of every job with an effort estimate, converted workflows for everything that maps, the secrets list and a cut-over order. Done-for-you migration is quoted off the back of that. Details: https://ci2actions.dev/migration/`,
      '',
      'Either way, happy to hear which Jenkinsfile broke the converter.',
      '',
      'Adam Gibbons', 'Lead DevOps engineer · ALGD LTD', 'https://ci2actions.dev',
    ].join('\n');
    const draft = [`To: ${o.email || '(no public email; try the site or a maintainer of ' + (migrating[0] || o.repos[0]).full + ')'}`, `Site: ${o.blog || ''}`, `Subject: ${subject}`, '', body, '', `Attach: ${join(dir, 'report.md')} and ${join(dir, 'workflows')}`].join('\n');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'email.md'), draft);
  }
  log(`email drafts written for ${Math.min(TOP, ranked.length)} organisations`);
}

const cands = STEP === 'collect' || STEP === 'all' ? await collect() : JSON.parse(readFileSync(join(OUT, 'candidates.json'), 'utf8'));
const repos = STEP === 'enrich' || STEP === 'all' ? await enrich(cands) : existsSync(join(OUT, 'repos.json')) ? JSON.parse(readFileSync(join(OUT, 'repos.json'), 'utf8')) : {};
const ranked = ['rank', 'all', 'audit', 'emails'].includes(STEP) ? await rank(repos) : [];
if (STEP === 'audit' || STEP === 'all') audit(ranked);
if (STEP === 'emails' || STEP === 'all') emails(ranked);

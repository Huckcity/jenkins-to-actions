// Crawl a GitHub organisation (or user) for CI configuration files of any supported system.
import { client, progress, progressDone, CI_FILES } from '../http.js';

export async function fromGithub({ org, token, api = 'https://api.github.com', wanted = () => true, repos: only = null }) {
  if (!token) throw new Error('A GitHub token is required (GITHUB_TOKEN or --token) with repo read access.');
  const gh = client({ base: api, auth: { bearer: token }, headers: { 'X-GitHub-Api-Version': '2022-11-28' } });
  let repos;
  if (only && only.length) repos = await Promise.all(only.map((full) => gh.get(`/repos/${full}`)));
  else {
    let isOrg = true;
    try { await gh.get(`/orgs/${org}`); } catch (e) { if (e.status === 404) isOrg = false; else throw e; }
    repos = await gh.pages(isOrg ? `/orgs/${org}/repos?type=all` : `/users/${org}/repos?type=owner`);
  }
  repos = repos.filter((r) => !r.archived && !r.fork || (only && only.length));
  process.stderr.write(`Found ${repos.length} repositories under ${org}\n`);
  const items = [];
  let n = 0;
  for (const r of repos) {
    n++;
    if (!wanted(r.full_name)) continue;
    progress(`[${n}/${repos.length}] ${r.full_name}`);
    const branch = r.default_branch || 'main';
    for (const f of CI_FILES) {
      let content;
      try {
        const res = await gh.get(`/repos/${r.full_name}/contents/${f.path}?ref=${encodeURIComponent(branch)}`, { allow404: true, headers: { Accept: 'application/vnd.github.raw+json' }, text: true });
        if (res === null) continue;
        content = res;
      } catch (e) { if (e.status === 403 || e.status === 404) continue; throw e; }
      items.push({ name: `${r.full_name}/${f.path}`, url: `${r.html_url}/blob/${branch}/${f.path}`, system: f.system, content, repo: r.full_name, path: f.path, defaultBranch: branch, platform: 'github' });
    }
  }
  progressDone();
  return { source: `GitHub ${org}`, platform: 'github', version: '', plugins: [], nodes: [], items, repoCount: repos.length };
}

// Crawl a GitHub organisation (or user) for CI configuration files of any supported system.
// Lists each repository's tree once and picks out CI configs wherever they live (Jenkinsfile at the root,
// .jenkins/Jenkinsfile, ci/*.jenkinsfile, azure-pipelines-*.yml, …); falls back to probing the well-known root paths.
import { client, progress, progressDone, CI_FILES, findCiPaths } from '../http.js';

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
  const owners = [...new Set(repos.map((r) => r.full_name.split('/')[0]))];
  const label = only && only.length ? `${repos.length} repositories` : `${repos.length} repositories under ${org}`;
  process.stderr.write(`Found ${label}\n`);
  const items = [];
  let n = 0;
  for (const r of repos) {
    n++;
    if (!wanted(r.full_name)) continue;
    progress(`[${n}/${repos.length}] ${r.full_name}`);
    const branch = r.default_branch || 'main';
    const found = await listCiFiles(gh, r.full_name, branch);
    for (const f of found) {
      let content;
      try {
        const res = await gh.get(`/repos/${r.full_name}/contents/${encodePath(f.path)}?ref=${encodeURIComponent(branch)}`, { allow404: true, headers: { Accept: 'application/vnd.github.raw+json' }, text: true });
        if (res === null) continue;
        content = res;
      } catch (e) { if (e.status === 403 || e.status === 404) continue; throw e; }
      items.push({ name: `${r.full_name}/${f.path}`, url: `${r.html_url}/blob/${branch}/${f.path}`, system: f.system, content, repo: r.full_name, path: f.path, defaultBranch: branch, platform: 'github' });
    }
  }
  progressDone();
  const source = only && only.length ? `GitHub ${owners.length === 1 ? owners[0] : owners.join(', ')}` : `GitHub ${org}`;
  return { source, platform: 'github', version: '', plugins: [], nodes: [], items, repoCount: repos.length };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// One recursive tree call per repository. Trees over GitHub's size limit come back truncated; then (or on any
// error, e.g. an empty repository) probe the well-known root paths instead.
async function listCiFiles(gh, full, branch) {
  try {
    const tree = await gh.get(`/repos/${full}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tree && Array.isArray(tree.tree) && !tree.truncated) return findCiPaths(tree.tree.filter((t) => t.type === 'blob').map((t) => t.path));
  } catch (e) { if (e.status !== 404 && e.status !== 409 && e.status !== 403) throw e; }
  return CI_FILES;
}

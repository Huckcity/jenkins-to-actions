// Crawl a Bitbucket Cloud workspace for bitbucket-pipelines.yml and any other CI configs kept in the repos.
import { client, progress, progressDone, CI_FILES, findCiPaths } from '../http.js';

export async function fromBitbucket({ workspace, user, token, api = 'https://api.bitbucket.org/2.0', wanted = () => true }) {
  if (!token) throw new Error('Bitbucket credentials are required: --user USERNAME --token APP_PASSWORD (or BITBUCKET_USER / BITBUCKET_TOKEN), or an access token as --token.');
  const bb = client({ base: api, auth: user ? { basic: `${user}:${token}` } : { bearer: token } });
  const repos = [];
  let url = `/repositories/${encodeURIComponent(workspace)}?pagelen=100`;
  while (url) { const r = await bb.get(url); repos.push(...(r.values || [])); url = r.next || null; }
  process.stderr.write(`Found ${repos.length} repositories in ${workspace}\n`);
  const items = [];
  let n = 0;
  for (const r of repos) {
    n++;
    if (!wanted(r.full_name)) continue;
    progress(`[${n}/${repos.length}] ${r.full_name}`);
    const branch = (r.mainbranch && r.mainbranch.name) || 'main';
    const found = await listCiFiles(bb, r.full_name, branch);
    const paths = found === CI_FILES ? [{ path: 'bitbucket-pipelines.yml', system: 'bitbucket' }, ...CI_FILES.filter((x) => x.system !== 'bitbucket')] : found;
    for (const f of paths) {
      let content;
      try { content = await bb.get(`/repositories/${r.full_name}/src/${encodeURIComponent(branch)}/${f.path}`, { text: true, allow404: true }); } catch (e) { if (e.status === 403) continue; throw e; }
      if (content === null) continue;
      items.push({ name: `${r.full_name}/${f.path}`, url: `${r.links.html.href}/src/${branch}/${f.path}`, system: f.system, content, repo: r.full_name, path: f.path, defaultBranch: branch, platform: 'bitbucket' });
    }
  }
  progressDone();
  return { source: `Bitbucket ${workspace}`, platform: 'bitbucket', version: '', plugins: [], nodes: [], items, repoCount: repos.length };
}

// Recursive src listing (max_depth keeps it bounded); on failure fall back to the well-known root paths.
async function listCiFiles(bb, full, branch) {
  try {
    const paths = [];
    let url = `/repositories/${full}/src/${encodeURIComponent(branch)}/?pagelen=100&max_depth=4&q=type%3D%22commit_file%22`;
    for (let i = 0; url && i < 50; i++) { const r = await bb.get(url); for (const v of r.values || []) if (v.path) paths.push(v.path); url = r.next || null; }
    return findCiPaths(paths);
  } catch (e) { if (e.status && e.status < 500) return CI_FILES; throw e; }
}

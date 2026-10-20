// Crawl a Bitbucket Cloud workspace for bitbucket-pipelines.yml (and other CI configs kept in the repos).
import { client, progress, progressDone, CI_FILES } from '../http.js';

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
    for (const f of [{ path: 'bitbucket-pipelines.yml', system: 'bitbucket' }, ...CI_FILES.filter((x) => x.system !== 'bitbucket')]) {
      let content;
      try { content = await bb.get(`/repositories/${r.full_name}/src/${encodeURIComponent(branch)}/${f.path}`, { text: true, allow404: true }); } catch (e) { if (e.status === 403) continue; throw e; }
      if (content === null) continue;
      items.push({ name: `${r.full_name}/${f.path}`, url: `${r.links.html.href}/src/${branch}/${f.path}`, system: f.system, content, repo: r.full_name, path: f.path, defaultBranch: branch, platform: 'bitbucket' });
    }
  }
  progressDone();
  return { source: `Bitbucket ${workspace}`, platform: 'bitbucket', version: '', plugins: [], nodes: [], items, repoCount: repos.length };
}

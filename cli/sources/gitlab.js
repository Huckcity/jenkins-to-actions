// Crawl a GitLab group (including subgroups) for .gitlab-ci.yml files and any other CI configs kept in the repos.
import { client, progress, progressDone, CI_FILES, findCiPaths } from '../http.js';

export async function fromGitlab({ group, token, api = 'https://gitlab.com/api/v4', wanted = () => true, insecure = false }) {
  if (!token) throw new Error('A GitLab token is required (GITLAB_TOKEN or --token) with read_api + read_repository.');
  const gl = client({ base: api, headers: { 'PRIVATE-TOKEN': token }, insecure });
  const enc = encodeURIComponent(group);
  const projects = await gl.pages(`/groups/${enc}/projects?include_subgroups=true&archived=false&simple=false`);
  process.stderr.write(`Found ${projects.length} projects under ${group}\n`);
  const items = [];
  let n = 0;
  for (const p of projects) {
    n++;
    if (!wanted(p.path_with_namespace)) continue;
    progress(`[${n}/${projects.length}] ${p.path_with_namespace}`);
    const branch = p.default_branch || 'main';
    const ciPath = (p.ci_config_path || '.gitlab-ci.yml').split('@')[0] || '.gitlab-ci.yml';
    if (p.ci_config_path && p.ci_config_path.includes('@')) items.push({ name: `${p.path_with_namespace}/${p.ci_config_path}`, url: p.web_url, system: 'gitlab', content: null, repo: p.path_with_namespace, path: p.ci_config_path, platform: 'gitlab', error: `CI config lives in another project (${p.ci_config_path}); convert it from there.` });
    const found = await listCiFiles(gl, p.id, branch);
    const paths = [{ path: ciPath, system: 'gitlab' }, ...found.filter((f) => f.path !== ciPath && !(f.system === 'gitlab' && found === CI_FILES))];
    for (const f of paths) {
      let content;
      try { content = await gl.get(`/projects/${p.id}/repository/files/${encodeURIComponent(f.path)}/raw?ref=${encodeURIComponent(branch)}`, { text: true, allow404: true }); } catch (e) { if (e.status === 403) continue; throw e; }
      if (content === null) continue;
      items.push({ name: `${p.path_with_namespace}/${f.path}`, url: `${p.web_url}/-/blob/${branch}/${f.path}`, system: f.system, content, repo: p.path_with_namespace, path: f.path, defaultBranch: branch, platform: 'gitlab' });
    }
  }
  progressDone();
  return { source: `GitLab ${group}`, platform: 'gitlab', version: '', plugins: [], nodes: [], items, repoCount: projects.length };
}

// Recursive tree listing (paged); on failure fall back to the well-known root paths.
async function listCiFiles(gl, id, branch) {
  try {
    const tree = await gl.pages(`/projects/${id}/repository/tree?recursive=true&ref=${encodeURIComponent(branch)}`);
    return findCiPaths(tree.filter((t) => t.type === 'blob').map((t) => t.path));
  } catch (e) { if (e.status && e.status < 500) return CI_FILES; throw e; }
}

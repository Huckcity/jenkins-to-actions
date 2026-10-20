// Crawl an Azure DevOps organisation: every project, every YAML pipeline, the YAML file behind it.
import { client, progress, progressDone } from '../http.js';

export async function fromAzure({ org, token, api = 'https://dev.azure.com', wanted = () => true }) {
  if (!token) throw new Error('An Azure DevOps PAT is required (AZURE_DEVOPS_TOKEN or --token) with Build (read) and Code (read).');
  const az = client({ base: `${api}/${org}`, auth: { basic: `:${token}` } });
  const v = 'api-version=7.1';
  const projects = (await az.get(`/_apis/projects?${v}&$top=500`)).value || [];
  process.stderr.write(`Found ${projects.length} projects in ${org}\n`);
  const items = [];
  let n = 0;
  for (const p of projects) {
    n++;
    progress(`[${n}/${projects.length}] ${p.name}`);
    let pipelines = [];
    try { pipelines = (await az.get(`/${encodeURIComponent(p.name)}/_apis/pipelines?${v}&$top=1000`)).value || []; } catch (e) { items.push({ name: p.name, url: '', system: 'azure', content: null, error: e.message, platform: 'azure' }); continue; }
    for (const pl of pipelines) {
      const full = `${p.name}/${pl.name}`;
      if (!wanted(full)) continue;
      let detail;
      try { detail = await az.get(`/${encodeURIComponent(p.name)}/_apis/pipelines/${pl.id}?${v}`); } catch (e) { items.push({ name: full, url: pl._links && pl._links.web ? pl._links.web.href : '', system: 'azure', content: null, error: e.message, platform: 'azure' }); continue; }
      const cfg = detail.configuration || {};
      if (cfg.type !== 'yaml') { items.push({ name: full, url: detail._links && detail._links.web ? detail._links.web.href : '', system: 'azure-classic', content: null, platform: 'azure', error: `Classic (designer) pipeline, type ${cfg.type}; export it as YAML in Azure DevOps first.` }); continue; }
      const repo = cfg.repository || {};
      let content = null, err = null;
      if (repo.type === 'azureReposGit' && repo.id) {
        try { content = await az.get(`/${encodeURIComponent(p.name)}/_apis/git/repositories/${repo.id}/items?path=${encodeURIComponent(cfg.path)}&${v}&includeContent=true&$format=text`, { text: true, headers: { Accept: 'text/plain' } }); }
        catch (e) { err = e.message; }
      } else if (repo.type === 'gitHub' || repo.type === 'github') { err = `Pipeline YAML lives in GitHub repo ${repo.fullName || repo.name || ''} at ${cfg.path}; audit that GitHub org to convert it.`; }
      else err = `Repository type ${repo.type || 'unknown'}; fetch ${cfg.path} by hand.`;
      items.push({ name: `${full} (${cfg.path})`, url: detail._links && detail._links.web ? detail._links.web.href : '', system: 'azure', content, repo: repo.name ? `${p.name}/${repo.name}` : null, path: cfg.path, platform: 'azure', error: err });
    }
  }
  progressDone();
  return { source: `Azure DevOps ${org}`, platform: 'azure', version: '', plugins: [], nodes: [], items, repoCount: projects.length };
}

#!/usr/bin/env node
// Jenkins estate audit: inventory every job on a Jenkins server (or a directory of config.xml files),
// convert what can be converted to GitHub Actions, score the effort for the rest, and write a report.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { convert } from '../public/convert.js';
import { convertFreestyle, classifyConfig } from './freestyle.js';
import { child, text, findAll } from './xml.js';
import { SOURCES, detect } from '../public/converters/index.js';
import { fromGithub } from './sources/github.js';
import { fromGitlab } from './sources/gitlab.js';
import { fromAzure } from './sources/azure.js';
import { fromBitbucket } from './sources/bitbucket.js';
import { openPullRequests } from './migrate.js';

const args = parseArgs(process.argv.slice(2));
const hasSource = args.url || args.dir || process.env.JENKINS_URL || args['github-org'] || args['gitlab-group'] || args['azure-org'] || args['bitbucket-workspace'] || args.repos;
if (args.help || !hasSource) {
  console.log(`jenkins-to-actions audit — inventory a CI estate and convert it to GitHub Actions

Sources (pick one):
  --url https://jenkins.example.com [--user U --token T]   Jenkins server (read-only API). Also JENKINS_URL/JENKINS_USER/JENKINS_TOKEN.
  --dir ./exported-configs                                  Jenkins config.xml files and/or any CI config files on disk.
  --github-org ORG [--token T]                              Every repo in a GitHub org or user: Jenkinsfile, .gitlab-ci.yml, azure-pipelines.yml,
                                                            .circleci/config.yml, bitbucket-pipelines.yml, .travis.yml. GITHUB_TOKEN works too.
  --repos owner/a,owner/b                                   Specific GitHub repositories instead of a whole org.
  --gitlab-group GROUP [--token T] [--api URL]              Every project in a GitLab group and its subgroups (GITLAB_TOKEN).
  --azure-org ORG [--token PAT]                             Every YAML pipeline in an Azure DevOps organisation (AZURE_DEVOPS_TOKEN).
  --bitbucket-workspace WS --user U --token APP_PASSWORD    Every repository in a Bitbucket Cloud workspace (BITBUCKET_USER/BITBUCKET_TOKEN).

Output:
  --out DIR               Default ./ci-migration: report.md, inventory.json, workflows/<repo>/<file>.yml
  --json                  Print the inventory JSON to stdout instead of writing files.
  --include, --exclude    Glob-ish filters on names (comma separated; * matches anything).

Opening pull requests (GitHub repositories only):
  --open-prs              Push each converted workflow to a branch in its repository and open a pull request with the notes as the body.
  --branch NAME           Branch name for the PRs (default ci/github-actions).
  --dry-run               With --open-prs: show what would be opened without pushing anything.

Nothing leaves your machine except the API calls to the platform you point it at; without --open-prs the tool only reads.`);
  process.exit(args.help ? 0 : 1);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; } }
    else out._.push(a);
  }
  return out;
}
const globToRe = (g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
const includes = args.include ? String(args.include).split(',').map(globToRe) : null;
const excludes = args.exclude ? String(args.exclude).split(',').map(globToRe) : [];
const wanted = (name) => (!includes || includes.some((r) => r.test(name))) && !excludes.some((r) => r.test(name));

// ---------------------------------------------------------------- sources

async function fromJenkins(base, user, token) {
  base = base.replace(/\/+$/, '');
  if (args.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const headers = { Accept: 'application/json' };
  if (user && token) headers.Authorization = 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  const get = async (url, asText = false) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return asText ? res.text() : res.json();
  };
  const info = await get(`${base}/api/json?tree=jobs[name,url,_class,jobs[name,url,_class,jobs[name,url,_class,jobs[name,url,_class]]]]`);
  const jobs = [];
  const walk = (list, prefix) => {
    for (const j of list || []) {
      const full = prefix ? `${prefix}/${j.name}` : j.name;
      const isFolder = /Folder|OrganizationFolder/.test(j._class) && !/MultiBranch/.test(j._class);
      if (isFolder) walk(j.jobs, full);
      else jobs.push({ name: full, url: j.url, _class: j._class, children: j.jobs });
    }
  };
  walk(info.jobs, '');
  process.stderr.write(`Found ${jobs.length} jobs on ${base}\n`);
  const out = [];
  let n = 0;
  for (const j of jobs) {
    if (!wanted(j.name)) continue;
    n++;
    process.stderr.write(`\r[${n}/${jobs.length}] ${j.name.slice(0, 60).padEnd(60)}`);
    try {
      const xml = await get(`${j.url}config.xml`, true);
      const item = { name: j.name, url: j.url, xml, system: 'jenkins-config', platform: 'jenkins' };
      if (/MultiBranch/.test(j._class)) {
        item.branches = (j.children || []).map((b) => b.name);
      }
      out.push(item);
    } catch (e) { out.push({ name: j.name, url: j.url, error: e.message, system: 'jenkins-config', platform: 'jenkins' }); }
  }
  process.stderr.write('\n');
  // Server-level facts
  let version = '';
  try { const r = await fetch(`${base}/api/json`, { headers }); version = r.headers.get('x-jenkins') || ''; } catch {}
  let plugins = [];
  try { plugins = (await get(`${base}/pluginManager/api/json?depth=1&tree=plugins[shortName,version,active]`)).plugins.filter((p) => p.active).map((p) => `${p.shortName}@${p.version}`); } catch {}
  let nodes = [];
  try { nodes = (await get(`${base}/computer/api/json?tree=computer[displayName,offline,assignedLabels[name],numExecutors]`)).computer.map((c) => ({ name: c.displayName, offline: c.offline, labels: (c.assignedLabels || []).map((l) => l.name), executors: c.numExecutors })); } catch {}
  return { source: base, platform: 'jenkins', version, plugins, nodes, items: out };
}

function fromDir(dir) {
  const items = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) { if (!['builds', 'workspace', 'modules', 'branches', 'node_modules', '.git'].includes(f)) walk(p); continue; }
      if (f === 'config.xml' || f.endsWith('.config.xml')) {
        const name = f === 'config.xml' ? relName(dir, dirname(p)) : f.replace(/\.config\.xml$/, '');
        if (!name || name === '.') continue;
        items.push({ name, url: p, xml: readFileSync(p, 'utf8') });
      } else if (/^Jenkinsfile(\..*)?$/.test(f) || f.endsWith('.Jenkinsfile') || f.endsWith('.jenkinsfile')) {
        items.push({ name: relName(dir, p), url: p, system: 'jenkins', content: readFileSync(p, 'utf8'), path: f, platform: 'dir' });
      } else if (/^(\.gitlab-ci\.ya?ml|azure-pipelines.*\.ya?ml|bitbucket-pipelines\.ya?ml|\.travis\.ya?ml)$/.test(f) || (f === 'config.yml' && basename(d) === '.circleci')) {
        const content = readFileSync(p, 'utf8');
        items.push({ name: relName(dir, p), url: p, system: detect(f === 'config.yml' ? '.circleci/config.yml' : f, content), content, path: f, platform: 'dir' });
      }
    }
  };
  walk(dir);
  return { source: resolve(dir), platform: 'dir', version: '', plugins: [], nodes: [], items: items.filter((i) => wanted(i.name)) };
}
const relName = (root, p) => resolve(p).slice(resolve(root).length + 1).replace(/\\/g, '/').replace(/\/jobs\//g, '/');

// ---------------------------------------------------------------- analysis

import * as gitlabConv from '../public/converters/gitlab.js';
import * as azureConv from '../public/converters/azure.js';
import * as circleConv from '../public/converters/circleci.js';
import * as bitbucketConv from '../public/converters/bitbucket.js';
import * as travisConv from '../public/converters/travis.js';
const CONVERTERS = { gitlab: gitlabConv, azure: azureConv, circleci: circleConv, bitbucket: bitbucketConv, travis: travisConv };

const EFFORT = { trivial: 0.25, small: 1, medium: 3, large: 6, xlarge: 12 }; // hours, rough
function score(hours) { return hours <= 0.5 ? 'trivial' : hours <= 1.5 ? 'small' : hours <= 4 ? 'medium' : hours <= 8 ? 'large' : 'xlarge'; }

function analyse(item) {
  const rec = { name: item.name, url: item.url, type: 'unknown', system: item.system || 'jenkins-config', platform: item.platform || 'jenkins', repo: item.repo || null, path: item.path || null, defaultBranch: item.defaultBranch || null, disabled: false, description: '', notes: [], secrets: [], plugins: [], todos: 0, hours: 0, yaml: '', scriptPath: null, branches: item.branches || null };
  if (item.error && !item.content) { rec.type = item.system === 'azure-classic' ? 'azure-classic' : 'error'; rec.notes.push(item.error); rec.hours = item.system === 'azure-classic' ? 4 : 1; return rec; }
  if (item.system === 'jenkins' && item.content !== undefined) {
    const r = convert(item.content, { mode: 'jobs', workflowName: basename(item.name) });
    Object.assign(rec, { type: r.scripted ? 'pipeline-scripted' : 'pipeline-declarative', notes: r.notes, secrets: r.secrets, yaml: r.yaml, todos: countTodos(r.yaml) });
    rec.hours = pipelineHours(rec, item.content);
    return rec;
  }
  if (item.system && item.system !== 'jenkins-config' && item.content !== undefined && item.content !== null) {
    const conv = CONVERTERS[item.system];
    if (!conv) { rec.type = item.system; rec.notes.push(`No converter for ${item.system}.`); rec.hours = 4; return rec; }
    let r;
    try { r = conv.convert(item.content, { workflowName: basename(item.repo || item.name) }); } catch (e) { r = { yaml: '', notes: [`Converter crashed: ${e.message}`], secrets: [] }; }
    rec.type = item.system;
    rec.notes = r.notes; rec.secrets = r.secrets || []; rec.yaml = r.yaml; rec.todos = countTodos(r.yaml);
    const manual = r.notes.filter((n) => /by hand|manual|rewrite|not resolved|no mapping|not translated|TODO/i.test(n)).length;
    rec.hours = Math.min(16, (r.yaml ? 0.5 : 3) + rec.todos * 1.5 + manual * 0.5 + (String(item.content).split('\n').length > 200 ? 1.5 : 0));
    if (/include:|template:|orbs:|@Library/.test(String(item.content))) rec.hours += 1;
    return rec;
  }
  if (!item.xml) { rec.type = 'error'; rec.notes.push('Nothing to analyse.'); rec.hours = 1; return rec; }
  const { type, root } = classifyConfig(item.xml);
  rec.type = type;
  if (!root) { rec.notes.push('Unreadable config.xml'); rec.hours = 1; return rec; }
  rec.disabled = text(root, 'disabled') === 'true';
  rec.description = text(root, 'description');
  if (type === 'pipeline') {
    const def = child(root, 'definition');
    const cls = def ? def.attrs.class || '' : '';
    if (/CpsScmFlowDefinition/.test(cls)) {
      rec.type = 'pipeline-scm';
      rec.scriptPath = text(def, 'scriptPath') || 'Jenkinsfile';
      const url = findAll(def, (c) => c.name === 'url').map((c) => c.text.trim())[0] || '';
      const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
      rec.repo = m ? m[1] : url || null;
      rec.notes.push(`Jenkinsfile lives in the repository at \`${rec.scriptPath}\`; run \`npx jenkins-to-actions convert ${rec.scriptPath}\` inside that checkout, or paste it into the web converter.`);
      rec.hours = 2;
    } else {
      const script = text(def, 'script');
      const r = convert(script, { mode: 'jobs', workflowName: basename(item.name) });
      rec.type = r.scripted ? 'pipeline-scripted' : 'pipeline-declarative';
      rec.notes = r.notes; rec.secrets = r.secrets; rec.yaml = r.yaml; rec.todos = countTodos(r.yaml);
      rec.hours = pipelineHours(rec, script);
    }
    return rec;
  }
  if (type === 'multibranch') {
    const src = findAll(root, (c) => c.name === 'source' && /SCMSource|Source$/.test(c.attrs.class || ''))[0] || findAll(root, (c) => /SCMSource$/.test(c.name))[0];
    const repoOwner = src ? text(src, 'repoOwner') : '';
    const repository = src ? text(src, 'repository') : '';
    const remote = src ? text(src, 'remote') : '';
    rec.repo = repoOwner && repository ? `${repoOwner}/${repository}` : (/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote) || [])[1] || remote || null;
    rec.scriptPath = findAll(root, (c) => c.name === 'scriptPath').map((c) => c.text.trim())[0] || 'Jenkinsfile';
    rec.notes.push(`Multibranch pipeline: one workflow replaces all branch jobs. Convert \`${rec.scriptPath}\` from ${rec.repo || 'the source repository'}; \`on: push\` + \`on: pull_request\` replace branch discovery.`);
    if (rec.branches && rec.branches.length) rec.notes.push(`${rec.branches.length} branch job(s) currently indexed: ${rec.branches.slice(0, 8).join(', ')}${rec.branches.length > 8 ? ', …' : ''}.`);
    rec.hours = 2.5;
    return rec;
  }
  if (['freestyle', 'maven', 'matrix'].includes(type)) {
    const r = convertFreestyle(item.xml, { name: basename(item.name) });
    Object.assign(rec, { notes: r.notes, secrets: r.secrets, plugins: r.plugins, yaml: r.yaml, repo: r.repo, todos: countTodos(r.yaml) });
    rec.hours = Math.min(12, 0.5 + rec.todos * 1.5 + r.notes.filter((n) => /dropped|no mapping|manual|rewrite|by hand/i.test(n)).length * 0.5 + (type === 'matrix' ? 1 : 0) + (type === 'maven' ? 0.5 : 0));
    return rec;
  }
  if (type === 'folder' || type === 'organization-folder') { rec.hours = 0; return rec; }
  rec.notes.push(`Job type \`${type}\` is not handled; migrate by hand.`);
  rec.hours = 4;
  return rec;
}

function pipelineHours(rec, src) {
  let h = 0.5 + rec.todos * 1.5 + rec.notes.filter((n) => /by hand|manual|rewrite|unconverted|no equivalent/i.test(n)).length * 0.25;
  if (/@Library|library\(/.test(src)) { h += 4; rec.notes.unshift('Uses a shared library (`@Library`); its steps must be re-implemented as reusable workflows or composite actions.'); rec.sharedLibrary = true; }
  if (rec.type === 'pipeline-scripted') h += 2;
  const lines = src.split('\n').length; if (lines > 300) h += 2; else if (lines > 120) h += 1;
  return Math.min(16, h);
}

// ---------------------------------------------------------------- report

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job'; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function buildReport(estate, recs) {
  const active = recs.filter((r) => !['folder', 'organization-folder'].includes(r.type));
  const byType = {};
  for (const r of active) byType[r.type] = (byType[r.type] || 0) + 1;
  const totalHours = active.reduce((a, r) => a + (r.disabled ? 0 : r.hours), 0);
  const pluginUse = {};
  for (const r of active) for (const p of r.plugins) pluginUse[p] = (pluginUse[p] || 0) + 1;
  const secretsAll = new Set(active.flatMap((r) => r.secrets));
  const L = [];
  const systems = [...new Set(active.map((r) => TYPE_LABEL[r.type] || r.type))];
  L.push(`# ${estate.platform === 'jenkins' ? 'Jenkins' : 'CI'} → GitHub Actions migration audit`, '');
  L.push(`Source: \`${estate.source}\`${estate.version ? ` (Jenkins ${estate.version})` : ''}${estate.repoCount ? ` · ${estate.repoCount} repositories scanned` : ''} · generated ${new Date().toISOString().slice(0, 10)} by [jenkins-to-actions](https://github.com/Huckcity/jenkins-to-actions)`, '');
  L.push('## Summary', '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| ${estate.platform === 'jenkins' ? 'Jobs' : 'CI configurations'} | **${active.length}** (${active.filter((r) => r.disabled).length} disabled) |`);
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) L.push(`| ${TYPE_LABEL[t] || t} | ${n} |`);
  L.push(`| Converted automatically | ${active.filter((r) => r.yaml && r.todos === 0).length} clean, ${active.filter((r) => r.yaml && r.todos > 0).length} with TODOs |`);
  if (estate.platform === 'jenkins') L.push(`| Jenkinsfiles to fetch from repos | ${active.filter((r) => r.type === 'pipeline-scm' || r.type === 'multibranch').length} |`);
  if (estate.platform !== 'jenkins' && estate.repoCount) L.push(`| Repositories without any CI config | ${Math.max(0, estate.repoCount - new Set(active.map((r) => r.repo)).size)} |`);
  L.push(`| Secrets to create | ${secretsAll.size} |`);
  L.push(`| Estimated hands-on effort | **${fmtHours(totalHours)}** (${fmtHours(totalHours * 0.6)}–${fmtHours(totalHours * 1.8)}) for enabled jobs, excluding testing and cut-over |`);
  if (estate.nodes.length) L.push(`| Agents | ${estate.nodes.length} (${estate.nodes.filter((n) => n.offline).length} offline); labels: ${[...new Set(estate.nodes.flatMap((n) => n.labels))].slice(0, 12).join(', ')} |`);
  L.push('');
  L.push('Effort is a rough per-job figure from the job type, the number of unconverted steps and the plugins involved. Multiply by your own factor once you have migrated the first three jobs.', '');

  L.push('## Suggested order', '');
  L.push('Start with the clean conversions to build confidence, then the small TODO jobs, and leave shared-library pipelines and plugin-heavy freestyle jobs for last.', '');
  const enabled = active.filter((r) => !r.disabled);
  const tiers = [
    ['Converted clean: review and commit', enabled.filter((r) => r.yaml && r.todos === 0)],
    ['Converted with TODOs', enabled.filter((r) => r.yaml && r.todos > 0).sort((a, b) => a.hours - b.hours)],
    ['Jenkinsfile in repository: convert from the checkout', enabled.filter((r) => r.type === 'pipeline-scm' || r.type === 'multibranch')],
    ['Manual', enabled.filter((r) => !r.yaml && r.type !== 'pipeline-scm' && r.type !== 'multibranch')],
  ];
  for (const [title, list] of tiers) {
    if (!list.length) continue;
    L.push(`### ${title} (${list.length})`, '', '| Job | Type | Effort | Notes |', '|---|---|---|---|');
    for (const r of list) L.push(`| ${r.name} | ${TYPE_LABEL[r.type] || r.type} | ${score(r.hours)} (~${fmtHours(r.hours)}) | ${r.todos ? `${r.todos} TODO${r.todos > 1 ? 's' : ''}; ` : ''}${r.sharedLibrary ? 'shared library; ' : ''}${r.notes.length} note${r.notes.length === 1 ? '' : 's'} |`);
    L.push('');
  }
  const disabled = active.filter((r) => r.disabled);
  if (disabled.length) L.push(`### Disabled (${disabled.length}): probably not worth migrating`, '', disabled.map((r) => `- ${r.name}`).join('\n'), '');

  if (Object.keys(pluginUse).length) {
    L.push('## Plugin and step usage across freestyle jobs', '', '| Plugin / step | Jobs | Replacement |', '|---|---|---|');
    for (const [p, n] of Object.entries(pluginUse).sort((a, b) => b[1] - a[1])) L.push(`| ${p} | ${n} | ${REPLACEMENT[p] || 'see job notes'} |`);
    L.push('');
  }
  if (secretsAll.size) L.push('## Secrets to create', '', 'Repository or organisation secrets referenced by the generated workflows (derived from Jenkins credential IDs):', '', [...secretsAll].sort().map((s) => `- \`${s}\``).join('\n'), '');
  const repos = [...new Set(active.map((r) => r.repo).filter(Boolean))];
  if (repos.length) L.push('## Repositories involved', '', repos.map((r) => `- ${r}`).join('\n'), '');

  L.push('## Per-job detail', '');
  for (const r of active) {
    L.push(`### ${r.name}${r.disabled ? ' (disabled)' : ''}`, '');
    L.push(`Type: ${TYPE_LABEL[r.type] || r.type} · effort ${score(r.hours)} (~${fmtHours(r.hours)})${r.yaml ? ` · workflow: \`workflows/${workflowFile(r)}\`` : ''}${r.repo ? ` · repo: ${r.repo}` : ''}${r.scriptPath ? ` · script: ${r.scriptPath}` : ''}${r.pr ? ` · PR: ${r.pr}` : ''}`, '');
    if (r.description) L.push(`> ${r.description.split('\n')[0]}`, '');
    if (r.notes.length) L.push(r.notes.map((n) => `- ${n}`).join('\n'), '');
  }
  L.push('---', '', 'Need this done for the whole estate, including the shared libraries and the cut-over plan? The author does Jenkins → GitHub Actions migrations as contract work: adam.p.gibbons@gmail.com. If the tool alone saved you time, [sponsorship](https://github.com/sponsors/Huckcity) keeps it maintained.', '');
  return L.join('\n');
}
const TYPE_LABEL = { gitlab: 'GitLab CI', azure: 'Azure Pipelines (YAML)', 'azure-classic': 'Azure Pipelines (classic)', circleci: 'CircleCI', bitbucket: 'Bitbucket Pipelines', travis: 'Travis CI', freestyle: 'Freestyle', maven: 'Maven project', matrix: 'Matrix (multi-configuration)', 'pipeline-declarative': 'Pipeline (declarative, inline)', 'pipeline-scripted': 'Pipeline (scripted, inline)', 'pipeline-scm': 'Pipeline (Jenkinsfile from SCM)', multibranch: 'Multibranch pipeline', folder: 'Folder', unknown: 'Unknown', error: 'Unreadable', multijob: 'MultiJob', external: 'External job' };
const REPLACEMENT = { Shell: '`run:`', BatchFile: '`run:` with `shell: cmd`', PowerShell: '`run:` with `shell: pwsh`', Maven: '`run: mvn` + actions/setup-java', Gradle: '`run: ./gradlew` + gradle/actions/setup-gradle', Ant: '`run: ant`', git: 'actions/checkout', TimerTrigger: '`on.schedule`', SCMTrigger: '`on.push`', ArtifactArchiver: 'actions/upload-artifact', JUnitResultArchiver: 'mikepenz/action-junit-report', Mailer: 'built-in failure notifications', ExtendedEmailPublisher: 'dawidd6/action-send-mail', BuildTrigger: '`workflow_run` / `gh workflow run`', SecretBuildWrapper: '`${{ secrets.* }}` in `env:`', BuildTimeoutWrapper: '`timeout-minutes`', PreBuildCleanup: 'not needed (fresh runner)', TimestamperBuildWrapper: 'built in', AnsiColorBuildWrapper: 'built in', ParametersDefinitionProperty: '`workflow_dispatch.inputs`', EnvInjectBuildWrapper: '`env:`', EnvInjectJobProperty: '`env:`', CopyArtifact: 'actions/download-artifact', HtmlPublisher: 'actions/upload-artifact', SlackNotifier: 'slackapi/slack-github-action', SonarRunnerBuilder: 'SonarSource/sonarqube-scan-action', NodeJSBuildWrapper: 'actions/setup-node', SSHAgentBuildWrapper: 'webfactory/ssh-agent', GitHubPushTrigger: '`on.push`', ReverseBuildTrigger: '`workflow_run`', DockerBuildAndPublish: 'docker/build-push-action', MsBuildBuilder: 'microsoft/setup-msbuild', ConditionalBuilder: 'step `if:`', TriggerBuilder: '`gh workflow run`', GitPublisher: '`run: git push`', WsCleanup: 'not needed' };
function fmtHours(h) { return h < 1 ? `${Math.round(h * 60)} min` : h < 8 ? `${Math.round(h * 2) / 2} h` : `${Math.round(h / 8 * 10) / 10} days`; }

// ---------------------------------------------------------------- main

async function main() {
  let estate;
  const token = args.token;
  if (args.dir) estate = fromDir(String(args.dir));
  else if (args['github-org'] || args.repos) estate = await fromGithub({ org: String(args['github-org'] || String(args.repos).split('/')[0]), token: token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN, api: args.api || process.env.GITHUB_API_URL || 'https://api.github.com', wanted, repos: args.repos ? String(args.repos).split(',').map((s) => s.trim()).filter(Boolean) : null });
  else if (args['gitlab-group']) estate = await fromGitlab({ group: String(args['gitlab-group']), token: token || process.env.GITLAB_TOKEN, api: args.api || process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4', wanted, insecure: !!args.insecure });
  else if (args['azure-org']) estate = await fromAzure({ org: String(args['azure-org']), token: token || process.env.AZURE_DEVOPS_TOKEN || process.env.AZURE_DEVOPS_EXT_PAT, api: args.api || 'https://dev.azure.com', wanted });
  else if (args['bitbucket-workspace']) estate = await fromBitbucket({ workspace: String(args['bitbucket-workspace']), user: args.user || process.env.BITBUCKET_USER, token: token || process.env.BITBUCKET_TOKEN, wanted });
  else estate = await fromJenkins(String(args.url || process.env.JENKINS_URL), args.user || process.env.JENKINS_USER, token || process.env.JENKINS_TOKEN);
  const recs = estate.items.map(analyse);
  if (args['open-prs']) {
    if (estate.platform !== 'github') { console.error('--open-prs needs a GitHub source (--github-org or --repos).'); process.exit(1); }
    await openPullRequests(recs, { token: token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN, api: args.api || process.env.GITHUB_API_URL || 'https://api.github.com', branch: String(args.branch || 'ci/github-actions'), dryRun: !!args['dry-run'] });
  }
  const inventory = { source: estate.source, version: estate.version, generated: new Date().toISOString(), plugins: estate.plugins, nodes: estate.nodes, jobs: recs.map(({ yaml, ...r }) => r) };
  if (args.json) { console.log(JSON.stringify(inventory, null, 2)); return; }
  const out = String(args.out || (estate.platform === 'jenkins' ? './jenkins-migration' : './ci-migration'));
  mkdirSync(join(out, 'workflows'), { recursive: true });
  for (const r of recs) if (r.yaml) { const f = join(out, 'workflows', workflowFile(r)); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, r.yaml); }
  writeFileSync(join(out, 'inventory.json'), JSON.stringify(inventory, null, 2));
  const report = buildReport(estate, recs);
  writeFileSync(join(out, 'report.md'), report);
  const active = recs.filter((r) => !['folder', 'organization-folder'].includes(r.type));
  const hours = active.reduce((a, r) => a + (r.disabled ? 0 : r.hours), 0);
  console.log(`\n${active.length} ${estate.platform === 'jenkins' ? 'jobs' : 'CI configurations'} analysed · ${recs.filter((r) => r.yaml).length} workflows written to ${join(out, 'workflows')} · estimated effort ${fmtHours(hours)}`);
  console.log(`Report: ${join(out, 'report.md')}`);
  const top = [...active].filter((r) => !r.disabled).sort((a, b) => b.hours - a.hours).slice(0, 5);
  if (top.length) { console.log('\nHardest jobs:'); for (const r of top) console.log(`  ${pad(score(r.hours), 8)} ${pad(fmtHours(r.hours), 8)} ${r.name}`); }
}
main().catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });

function countTodos(yaml) { return (yaml.match(/^\s*- name: '?TODO/gm) || []).length; }

// Where a converted workflow lands under <out>/workflows/. Repo-based sources get a folder per repository.
function workflowFile(r) {
  if (r.repo && r.platform !== 'jenkins') return `${r.repo.replace(/[^\w.-]+/g, '-')}/${(r.path || 'ci').replace(/^\./, '').replace(/[\/]/g, '-').replace(/\.ya?ml$/, '')}.yml`;
  return `${slug(r.name)}.yml`;
}

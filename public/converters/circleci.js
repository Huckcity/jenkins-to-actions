// CircleCI (.circleci/config.yml) -> GitHub Actions
import { parse as parseYaml } from '../vendor/yaml.js';
import { makeCtx, slug, asList, str, script, firstLine, finish, orderJob, todoStep } from './common.js';

const CIRCLE_VARS = { CIRCLE_SHA1: '${{ github.sha }}', CIRCLE_BRANCH: '${{ github.ref_name }}', CIRCLE_TAG: '${{ github.ref_name }}', CIRCLE_BUILD_NUM: '${{ github.run_number }}', CIRCLE_BUILD_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}', CIRCLE_WORKFLOW_ID: '${{ github.run_id }}', CIRCLE_PIPELINE_NUMBER: '${{ github.run_number }}', CIRCLE_PROJECT_REPONAME: '${{ github.event.repository.name }}', CIRCLE_PROJECT_USERNAME: '${{ github.repository_owner }}', CIRCLE_REPOSITORY_URL: '${{ github.server_url }}/${{ github.repository }}', CIRCLE_PR_NUMBER: '${{ github.event.pull_request.number }}', CIRCLE_PULL_REQUEST: '${{ github.event.pull_request.html_url }}', CIRCLE_USERNAME: '${{ github.actor }}', CIRCLE_WORKING_DIRECTORY: '${{ github.workspace }}', CIRCLE_JOB: '${{ github.job }}', CIRCLE_NODE_INDEX: '${{ matrix.index }}', CIRCLE_NODE_TOTAL: '', CIRCLE_COMPARE_URL: '${{ github.event.compare }}', CI: 'true', CIRCLECI: 'true' };

function sub(s, params, ctx) {
  if (typeof s !== 'string') return s;
  return s.replace(/<<\s*([\w.-]+)\s*>>/g, (m, k) => {
    if (k.startsWith('parameters.')) { const n = k.slice(11); if (params && n in params) return str(params[n]); return `\${{ inputs.${n} }}`; }
    if (k === 'pipeline.git.branch') return '${{ github.ref_name }}';
    if (k === 'pipeline.git.revision') return '${{ github.sha }}';
    if (k === 'pipeline.git.tag') return '${{ github.ref_name }}';
    if (k === 'pipeline.number' || k === 'pipeline.id') return '${{ github.run_number }}';
    if (k === 'pipeline.project.git_url') return '${{ github.server_url }}/${{ github.repository }}';
    if (k.startsWith('pipeline.parameters.')) return `\${{ inputs.${k.slice(20)} }}`;
    if (k.startsWith('pipeline.')) { ctx.note(`Pipeline value \`${m}\` has no mapping.`); return m; }
    return m;
  });
}

function cacheKey(key, ctx) {
  return String(key)
    .replace(/\{\{\s*checksum\s+"([^"]+)"\s*\}\}/g, (m, f) => `\${{ hashFiles('${f}') }}`)
    .replace(/\{\{\s*\.Branch\s*\}\}/g, '${{ github.ref_name }}')
    .replace(/\{\{\s*\.Revision\s*\}\}/g, '${{ github.sha }}')
    .replace(/\{\{\s*arch\s*\}\}/g, '${{ runner.os }}-${{ runner.arch }}')
    .replace(/\{\{\s*\.Environment\.([A-Z_]+)\s*\}\}/g, '${{ env.$1 }}')
    .replace(/-?\{\{\s*epoch\s*\}\}/g, '')
    .replace(/\{\{\s*\.BuildNum\s*\}\}/g, '${{ github.run_number }}');
}

function executorToJob(exec, ctx, doc) {
  const out = {};
  if (!exec) return out;
  if (typeof exec === 'string' || (exec.name && !exec.docker && !exec.machine && !exec.macos)) {
    const name = typeof exec === 'string' ? exec : exec.name;
    const def = doc.executors && doc.executors[name];
    if (def) { const r = executorToJob(def, ctx, doc); if (typeof exec === 'object') Object.assign(r, executorToJob({ ...exec, name: undefined }, ctx, doc)); return r; }
    if (/win/i.test(name)) { out.runsOn = 'windows-latest'; return out; }
    ctx.note(`Executor \`${name}\` comes from an orb and was not resolved; set \`runs-on\`/\`container\` by hand.`);
    out.runsOn = ctx.opts.runner; return out;
  }
  if (exec.docker) {
    const imgs = asList(exec.docker);
    const primary = imgs[0] || {};
    out.runsOn = ctx.opts.runner;
    if (primary.image) { out.container = { image: String(primary.image) }; if (primary.environment) out.container.env = primary.environment; if (primary.auth) { out.container.credentials = { username: sub(str(primary.auth.username), null, ctx).replace(/^\$(\w+)$/, '${{ secrets.$1 }}'), password: sub(str(primary.auth.password), null, ctx).replace(/^\$(\w+)$/, '${{ secrets.$1 }}') }; } }
    if (imgs.length > 1) { out.services = {}; for (const s of imgs.slice(1)) { const nm = s.name || String(s.image).split(':')[0].replace(/.*\//, ''); out.services[nm] = { image: String(s.image), env: s.environment }; } ctx.note('Secondary docker images became `services:`; they are reachable by service name from the container job (CircleCI used localhost).'); }
    if (/^cimg\/base|^circleci\/buildpack|^ubuntu/.test(String(primary.image || ''))) { ctx.note(`Image \`${primary.image}\` looks like a base image; consider dropping \`container:\` and running directly on ubuntu-latest.`); }
  } else if (exec.machine) {
    const img = typeof exec.machine === 'object' ? String(exec.machine.image || '') : '';
    out.runsOn = /windows/.test(img) ? 'windows-latest' : /ubuntu-2004/.test(img) ? 'ubuntu-22.04' : 'ubuntu-latest';
    if (/arm/.test(String(exec.resource_class || ''))) out.runsOn = 'ubuntu-24.04-arm';
  } else if (exec.macos) { out.runsOn = 'macos-latest'; if (exec.macos.xcode) ctx.note(`macOS executor requested Xcode ${exec.macos.xcode}; use \`maxim-lobanov/setup-xcode\` to select a version.`); }
  else out.runsOn = ctx.opts.runner;
  if (exec.resource_class && !/arm/.test(String(exec.resource_class)) && !/^(small|medium|medium\+|large)$/.test(String(exec.resource_class))) ctx.note(`resource_class \`${exec.resource_class}\`: pick a larger GitHub-hosted runner if needed.`);
  if (exec.working_directory) { const wd = String(exec.working_directory); if (!/^~\/(project|repo|app|code)$|^\/home\/circleci\/project$/.test(wd)) out.workdir = wd; }
  if (exec.environment) out.env = Object.fromEntries(Object.entries(exec.environment).map(([k, v]) => [k, str(v)]));
  if (exec.shell) out.shell = String(exec.shell);
  return out;
}

function convertSteps(list, ctx, doc, params, scope) {
  const out = [];
  for (const st of asList(list)) {
    if (st === 'checkout') { out.push({ name: 'Checkout', uses: 'actions/checkout@v4' }); scope.checkedOut = true; continue; }
    if (typeof st === 'string') {
      if (st === 'setup_remote_docker') { ctx.note('`setup_remote_docker` dropped: Docker is available directly on GitHub-hosted Linux runners.'); continue; }
      if (st === 'add_ssh_keys') { ctx.note('`add_ssh_keys` became `webfactory/ssh-agent`; store the key as a secret.'); out.push({ name: 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}` } }); continue; }
      if (doc.commands && doc.commands[st]) { out.push(...expandCommand(st, {}, ctx, doc, params, scope)); continue; }
      if (st.includes('/')) { ctx.note(`Orb command \`${st}\` has no mapping; look for the equivalent action.`); out.push(todoStep(`Orb command ${st}`, st, ctx)); continue; }
      out.push(todoStep(`Step ${st}`, st, ctx)); continue;
    }
    if (!st || typeof st !== 'object') continue;
    const [key, val] = Object.entries(st)[0];
    const v = val || {};
    switch (key) {
      case 'checkout': { const step = { name: 'Checkout', uses: 'actions/checkout@v4' }; if (v.path) step.with = { path: sub(String(v.path), params, ctx) }; out.push(step); scope.checkedOut = true; break; }
      case 'run': {
        const r = typeof v === 'string' ? { command: v } : v;
        const cmd = sub(script(r.command), params, ctx);
        const step = { name: r.name ? sub(String(r.name), params, ctx) : firstLine(cmd), run: cmd };
        if (r.working_directory) step['working-directory'] = sub(String(r.working_directory), params, ctx);
        if (r.environment) step.env = Object.fromEntries(Object.entries(r.environment).map(([k, x]) => [k, sub(str(x), params, ctx)]));
        if (r.when === 'always') step.if = 'always()'; else if (r.when === 'on_fail') step.if = 'failure()';
        if (r.shell && !/^\/bin\/bash|bash( -eo pipefail)?$/.test(String(r.shell))) step.shell = /pwsh|powershell/.test(String(r.shell)) ? 'pwsh' : /python/.test(String(r.shell)) ? 'python' : /sh$/.test(String(r.shell)) ? 'sh' : String(r.shell);
        if (r.background) { step.run = `${cmd} &`; ctx.note('A background `run` step was kept with a trailing `&`; background processes survive until the job ends.'); }
        if (r.no_output_timeout) { const m = /(\d+)\s*m/.exec(String(r.no_output_timeout)); if (m) step['timeout-minutes'] = Number(m[1]); }
        out.push(step); break;
      }
      case 'save_cache': { const key = cacheKey(sub(String(v.key), params, ctx), ctx); const paths = asList(v.paths).map((p) => sub(String(p), params, ctx)); const existing = scope.caches.find((c) => c.key === key); if (existing) { existing.step.with.path = paths.join('\n'); } else { ctx.note('`save_cache` without a matching `restore_cache` became a cache step; `actions/cache` restores and saves in one step.'); const step = { name: 'Cache', uses: 'actions/cache@v4', with: { path: paths.join('\n'), key } }; scope.caches.push({ key, step }); out.push(step); } break; }
      case 'restore_cache': { const keys = asList(v.keys || v.key).map((k) => cacheKey(sub(String(k), params, ctx), ctx)); const step = { name: v.name ? String(v.name) : 'Restore cache', uses: 'actions/cache@v4', with: { path: 'TODO', key: keys[0], 'restore-keys': keys.length > 1 ? keys.slice(1).join('\n') : undefined } }; scope.caches.push({ key: keys[0], step }); out.push(step); break; }
      case 'persist_to_workspace': { const root = sub(String(v.root || '.'), params, ctx); const paths = asList(v.paths).map((p) => (root === '.' || root === './' ? String(p) : `${root.replace(/\/$/, '')}/${p}`)); out.push({ name: 'Persist workspace', uses: 'actions/upload-artifact@v4', with: { name: `workspace-${scope.jobId}`, path: paths.join('\n'), 'include-hidden-files': true } }); scope.persists = true; ctx.note('`persist_to_workspace`/`attach_workspace` became upload/download-artifact; artifacts do not keep file permissions, so `chmod +x` after download if needed.'); break; }
      case 'attach_workspace': { const at = sub(String(v.at || '.'), params, ctx); const deps = scope.persisters(); for (const dep of deps) out.push({ name: `Attach workspace from ${dep}`, uses: 'actions/download-artifact@v4', with: { name: `workspace-${dep}`, path: at === '.' || at === './' ? undefined : at } }); if (!deps.length) out.push({ name: 'Attach workspace', uses: 'actions/download-artifact@v4', with: { pattern: 'workspace-*', 'merge-multiple': true, path: at === '.' ? undefined : at } }); break; }
      case 'store_artifacts': out.push({ name: 'Store artifacts', uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: v.destination ? slug(String(v.destination)) : `artifacts-${scope.jobId}`, path: sub(String(v.path), params, ctx) } }); break;
      case 'store_test_results': out.push({ name: 'Publish test results', uses: 'mikepenz/action-junit-report@v5', if: 'always()', with: { report_paths: `${sub(String(v.path), params, ctx).replace(/\/$/, '')}/**/*.xml` } }); ctx.note('`store_test_results` became `mikepenz/action-junit-report` (needs `permissions: checks: write`).'); break;
      case 'setup_remote_docker': ctx.note('`setup_remote_docker` dropped: Docker is available directly on GitHub-hosted Linux runners.'); break;
      case 'add_ssh_keys': ctx.note('`add_ssh_keys` became `webfactory/ssh-agent`; store the key as a secret.'); out.push({ name: 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}` } }); break;
      case 'when': case 'unless': { const c = v.condition; let expr = null; if (typeof c === 'string') expr = sub(c, params, ctx); else if (c && typeof c === 'object') { if (c.equal) expr = `${asList(c.equal).map((x) => sub(str(x), params, ctx)).map((x) => (/^\$\{\{/.test(x) ? x.replace(/^\$\{\{\s*|\s*\}\}$/g, '') : `'${x}'`)).join(' == ')}`; else if (c.and || c.or || c.not) { ctx.note('Complex `when` logic condition flattened; check the `if:`.'); expr = 'true'; } } const inner = convertSteps(v.steps, ctx, doc, params, scope); const cond = expr === null || expr === 'true' ? null : /^(true|false)$/.test(expr) ? expr : /^\$\{\{/.test(expr) ? expr.replace(/^\$\{\{\s*|\s*\}\}$/g, '') : /==/.test(expr) ? expr : `${expr} != ''`; for (const s of inner) { if (cond) s.if = key === 'unless' ? `!(${cond})` : cond; else if (expr === 'false') s.if = key === 'unless' ? 'true' : 'false'; } if (cond === null && expr !== 'false' && expr !== 'true') ctx.note(`\`${key}\` condition was not translated.`); out.push(...inner); break; }
      case 'deploy': out.push({ name: 'Deploy', run: sub(script(typeof v === 'string' ? v : v.command), params, ctx) }); break;
      case 'queue': case 'early_exit': ctx.note(`Step \`${key}\` dropped.`); break;
      default: {
        if (doc.commands && doc.commands[key]) { out.push(...expandCommand(key, v, ctx, doc, params, scope)); break; }
        if (key.includes('/')) { out.push(...orbStep(key, v, ctx, params)); break; }
        out.push(todoStep(`Step ${key}`, JSON.stringify(v).slice(0, 300), ctx));
      }
    }
  }
  return out;
}

function orbStep(key, v, ctx, params) {
  const s = (x, d = '') => (x === undefined ? d : sub(str(x), params, ctx));
  switch (key) {
    case 'node/install': case 'node/install-packages': if (key === 'node/install-packages') return [{ name: 'Install packages', run: v['pkg-manager'] === 'yarn' ? 'yarn install --frozen-lockfile' : v['pkg-manager'] === 'pnpm' ? 'pnpm install --frozen-lockfile' : 'npm ci' }]; return [{ name: 'Set up Node.js', uses: 'actions/setup-node@v4', with: { 'node-version': s(v['node-version'], 'lts/*') } }];
    case 'python/install-packages': return [{ name: 'Install packages', run: v['pkg-manager'] === 'poetry' ? 'poetry install' : v['pkg-manager'] === 'pipenv' ? 'pipenv install' : 'pip install -r requirements.txt' }];
    case 'aws-cli/setup': case 'aws-cli/install': ctx.note('AWS CLI orb: use `aws-actions/configure-aws-credentials` (OIDC preferred); the CLI is preinstalled.'); return [{ name: 'Configure AWS credentials', uses: 'aws-actions/configure-aws-credentials@v4', with: { 'aws-region': s(v.region, 'us-east-1'), 'role-to-assume': 'TODO' } }];
    case 'docker/build': return [{ name: 'Docker build', uses: 'docker/build-push-action@v6', with: { context: s(v.path, '.'), file: v.dockerfile ? s(v.dockerfile) : undefined, tags: `${s(v.image, 'app')}:${s(v.tag, 'latest')}`, push: false } }];
    case 'docker/push': return [{ name: 'Docker push', run: `docker push ${s(v.image, 'app')}:${s(v.tag, 'latest')}` }];
    case 'docker/check': return [{ name: 'Docker login', uses: 'docker/login-action@v3', with: { registry: v.registry ? s(v.registry) : undefined, username: `\${{ secrets.${ctx.secret('DOCKER_USERNAME')} }}`, password: `\${{ secrets.${ctx.secret('DOCKER_PASSWORD')} }}` } }];
    case 'slack/notify': ctx.note('Slack orb: use `slackapi/slack-github-action` with a webhook secret.'); return [todoStep('Slack notification', JSON.stringify(v).slice(0, 200), ctx)];
    case 'codecov/upload': return [{ name: 'Upload coverage', uses: 'codecov/codecov-action@v5', with: { files: v.file ? s(v.file) : undefined, token: `\${{ secrets.${ctx.secret('CODECOV_TOKEN')} }}` } }];
    case 'browser-tools/install-browser-tools': case 'browser-tools/install-chrome': case 'browser-tools/install-chromedriver': ctx.note('Browser tools orb dropped: Chrome and Firefox are preinstalled on ubuntu runners.'); return [];
    case 'gh/setup': case 'gh/install': ctx.note('GitHub CLI is preinstalled on hosted runners; set `GH_TOKEN`.'); return [];
    case 'ruby/install-deps': return [{ name: 'Install gems', run: 'bundle install' }];
    case 'go/load-cache': case 'go/save-cache': case 'go/mod-download': return key === 'go/mod-download' ? [{ name: 'Download modules', run: 'go mod download' }] : [];
    case 'heroku/deploy-via-git': ctx.note('Heroku orb: use `akhileshns/heroku-deploy` or `git push` with HEROKU_API_KEY.'); return [todoStep('Heroku deploy', JSON.stringify(v).slice(0, 200), ctx)];
    default: ctx.note(`Orb step \`${key}\` has no mapping; look for the equivalent action.`); return [todoStep(`Orb step ${key}`, JSON.stringify(v).slice(0, 300), ctx)];
  }
}

function expandCommand(name, args, ctx, doc, outerParams, scope) {
  const cmd = doc.commands[name];
  const params = { ...(outerParams || {}) };
  for (const [k, p] of Object.entries(cmd.parameters || {})) params[k] = args && k in args ? args[k] : p && p.default !== undefined ? p.default : '';
  for (const k of Object.keys(args || {})) if (!(k in params)) params[k] = args[k];
  if (scope.depth > 10) return [todoStep(`Command ${name} (recursion)`, name, ctx)];
  const steps = convertSteps(cmd.steps, ctx, doc, params, { ...scope, depth: (scope.depth || 0) + 1 });
  const firstName = cmd.description ? String(cmd.description).split('\n')[0].slice(0, 60) : name;
  if (steps.length && !steps[0].name) steps[0].name = firstName;
  return steps;
}

function filterCond(filters, ctx) {
  if (!filters) return { cond: null, tags: false };
  const parts = [];
  let tags = false;
  const pat = (p, prefix) => { const v = String(p); if (/^\/.*\/$/.test(v)) { const inner = v.slice(1, -1).replace(/^\^/, '').replace(/\$$/, '').replace(/\\/g, ''); if (inner === '.*' || inner === '.+') return `startsWith(github.ref, '${prefix}')`; const lit = inner.replace(/\.\*$|\.\+$/, ''); if (/[[\]()|?+]/.test(lit)) { ctx.note(`Regex filter \`${v}\` approximated with startsWith.`); } return `startsWith(github.ref, '${prefix}${lit.replace(/[[\]()|?+*].*$/, '')}')`; } return `github.ref == '${prefix}${v}'`; };
  if (filters.branches) {
    const only = asList(filters.branches.only).map((b) => pat(b, 'refs/heads/'));
    const ignore = asList(filters.branches.ignore).map((b) => pat(b, 'refs/heads/'));
    if (only.length) parts.push(only.length > 1 ? `(${only.join(' || ')})` : only[0]);
    if (ignore.length) parts.push(`!(${ignore.join(' || ')})`);
  }
  if (filters.tags) {
    tags = true;
    const only = asList(filters.tags.only).map((t) => pat(t, 'refs/tags/'));
    if (only.length) { const tagCond = only.length > 1 ? `(${only.join(' || ')})` : only[0]; // branches ignore all + tags only => tag-only job
      if (filters.branches && asList(filters.branches.ignore).some((b) => /^\/\.\*\/$/.test(String(b)))) { parts.length = 0; parts.push(tagCond); } else parts.push(`(${tagCond} || !startsWith(github.ref, 'refs/tags/'))`); }
    if (filters.tags.ignore) parts.push(`!(${asList(filters.tags.ignore).map((t) => pat(t, 'refs/tags/')).join(' || ')})`);
  }
  return { cond: parts.length ? parts.join(' && ') : null, tags };
}

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src, { merge: true }); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object') return { yaml: '', notes: ['Empty or invalid config.yml'], secrets: [] };
  const wf = { name: ctx.opts.workflowName || 'CI' };
  if (doc.orbs) { for (const [k, v] of Object.entries(doc.orbs)) if (typeof v === 'string') ctx.note(`Orb \`${k}\` (${v}): its executors, commands and jobs were mapped where known; the rest are TODOs.`); }
  if (doc.setup) ctx.note('Dynamic config (`setup: true`) cannot be converted; convert the generated configuration instead.');
  const inputs = {};
  for (const [k, p] of Object.entries(doc.parameters || {})) { const t = String((p && p.type) || 'string'); inputs[k] = { description: p && p.description ? String(p.description) : undefined, required: false, type: t === 'boolean' ? 'boolean' : t === 'integer' ? 'number' : t === 'enum' ? 'choice' : 'string', default: p && p.default !== undefined ? (t === 'boolean' ? !!p.default : t === 'integer' ? Number(p.default) : str(p.default)) : undefined, options: t === 'enum' ? asList(p.enum).map(str) : undefined }; }
  const on = { push: { branches: ['**'] }, pull_request: {} };
  on.workflow_dispatch = Object.keys(inputs).length ? { inputs } : {};
  const jobs = {};
  const workflows = Object.entries(doc.workflows || {}).filter(([k, v]) => k !== 'version' && v && typeof v === 'object');
  const multi = workflows.length > 1;
  let anyTags = false;
  const schedules = [];
  const defineJob = (jobName, invocation, wfName, wfCond, jobIds) => {
    const def = doc.jobs && doc.jobs[jobName];
    const inv = invocation || {};
    const displayName = inv.name ? String(inv.name) : jobName;
    const id = slug(multi ? `${wfName}-${displayName}` : displayName, ctx.jobIds);
    jobIds.set(displayName, id); if (!jobIds.has(jobName)) jobIds.set(jobName, id);
    const job = { name: multi ? `${wfName} / ${displayName}` : displayName };
    const requires = asList(inv.requires).map(String);
    const needs = requires.map((r) => jobIds.get(r)).filter(Boolean);
    if (needs.length) job.needs = needs;
    const { cond, tags } = filterCond(inv.filters, ctx);
    if (tags) anyTags = true;
    const conds = [wfCond, cond].filter(Boolean);
    if (conds.length) job.if = conds.join(' && ');
    if (inv.type === 'approval' || (def && def.type === 'approval')) { job.environment = 'manual-approval'; job['runs-on'] = ctx.opts.runner; job.steps = [{ run: 'echo "Approved"' }]; ctx.note(`Approval job \`${jobName}\` became a job gated by environment \`manual-approval\`; add required reviewers to that environment.`); jobs[id] = orderJob(job); return id; }
    if (inv.context) ctx.note(`Context \`${asList(inv.context).join(', ')}\` on \`${jobName}\`: recreate its variables as repository or environment secrets.`);
    if (!def) {
      if (jobName.includes('/')) { ctx.note(`Orb job \`${jobName}\` was not resolved; write the equivalent job by hand.`); job['runs-on'] = ctx.opts.runner; job.steps = [todoStep(`Orb job ${jobName}`, JSON.stringify(inv).slice(0, 300), ctx)]; }
      else { job['runs-on'] = ctx.opts.runner; job.steps = [todoStep(`Job ${jobName} not found in config`, jobName, ctx)]; }
      jobs[id] = orderJob(job); return id;
    }
    // parameters
    const params = {};
    for (const [k, p] of Object.entries(def.parameters || {})) params[k] = k in inv ? inv[k] : p && p.default !== undefined ? p.default : `<< parameters.${k} >>`;
    for (const k of Object.keys(inv)) if (!['requires', 'filters', 'context', 'name', 'type', 'matrix', 'pre-steps', 'post-steps', 'serial-group'].includes(k)) params[k] = inv[k];
    let matrixKeys = [];
    if (inv.matrix && inv.matrix.parameters) { const m = {}; for (const [k, v] of Object.entries(inv.matrix.parameters)) m[k] = asList(v).map(str); if (inv.matrix.exclude) m.exclude = asList(inv.matrix.exclude); job.strategy = { matrix: m }; matrixKeys = Object.keys(inv.matrix.parameters); for (const k of matrixKeys) params[k] = `\${{ matrix.${k} }}`; job.name = `${job.name} (${matrixKeys.map((k) => `\${{ matrix.${k} }}`).join(', ')})`; }
    const ex = executorToJob(def.executor || def, ctx, doc);
    job['runs-on'] = ex.runsOn || ctx.opts.runner;
    if (ex.container) { job.container = ex.container; if (ex.container.image) job.container.image = sub(ex.container.image, params, ctx); }
    if (ex.services) job.services = ex.services;
    if (def.parallelism && Number(def.parallelism) > 1) { job.strategy = job.strategy || { matrix: {} }; job.strategy.matrix.index = Array.from({ length: Number(def.parallelism) }, (_, i) => i); ctx.note(`\`parallelism: ${def.parallelism}\` on \`${jobName}\` became a matrix of indexes; replace \`circleci tests split\` with your own sharding using CIRCLE_NODE_INDEX/CIRCLE_NODE_TOTAL.`); }
    const jenv = { ...(ex.env || {}), ...Object.fromEntries(Object.entries(def.environment || {}).map(([k, v]) => [k, sub(str(v), params, ctx)])) };
    if (def.parallelism > 1) { jenv.CIRCLE_NODE_INDEX = '${{ matrix.index }}'; jenv.CIRCLE_NODE_TOTAL = String(def.parallelism); }
    if (Object.keys(jenv).length) job.env = jenv;
    if (ex.workdir) { job.defaults = { run: { 'working-directory': sub(ex.workdir, params, ctx) } }; ctx.note(`working_directory \`${ex.workdir}\`: checkout goes to the workspace root; the directory default was set but you may want to drop it.`); }
    const persisters = () => { const seen = new Set(); const out = []; const walk = (ids) => { for (const d of ids) { if (seen.has(d)) continue; seen.add(d); const jd = jobs[d]; if (!jd) continue; if ((jd.steps || []).some((s) => s.uses === 'actions/upload-artifact@v4' && String(s.with && s.with.name).startsWith('workspace-'))) out.push(d); walk(jd.needs || []); } }; walk(needs); return out; };
    const scope = { jobId: id, requires: needs, persisters, caches: [], checkedOut: false };
    const steps = [...convertSteps(inv['pre-steps'], ctx, doc, params, scope), ...convertSteps(def.steps, ctx, doc, params, scope), ...convertSteps(inv['post-steps'], ctx, doc, params, scope)];
    if (job.defaults && job.defaults.run) for (const s of steps) if (s.uses === 'actions/checkout@v4' && !s.with) { /* checkout ignores working-directory */ }
    for (const c of scope.caches) if (c.step.with.path === 'TODO') { c.step.with.path = '# TODO: paths from the matching save_cache'; ctx.note('A `restore_cache` had no matching `save_cache` key in the same job; set the cache `path` by hand.'); }
    if (!steps.length) steps.push({ run: 'echo "No steps"' });
    job.steps = steps;
    jobs[id] = orderJob(job);
    return id;
  };
  if (!workflows.length) {
    // no workflows: run every job in parallel
    const ids = new Map();
    for (const name of Object.keys(doc.jobs || {})) defineJob(name, {}, '', null, ids);
  }
  const scheduledWfs = new Set(workflows.filter(([, w]) => asList(w.triggers).some((t) => t && t.schedule)).map(([k]) => k));
  for (const [wfName, w] of workflows) {
    let wfCond = scheduledWfs.size && !scheduledWfs.has(wfName) ? "github.event_name != 'schedule'" : null;
    for (const t of asList(w.triggers)) { if (t && t.schedule) { schedules.push({ cron: String(t.schedule.cron) }); wfCond = "github.event_name == 'schedule'"; if (t.schedule.filters) ctx.note(`Schedule filters on workflow \`${wfName}\` were dropped; scheduled runs use the default branch.`); } }
    if (w.when !== undefined) { const c = w.when; if (typeof c === 'string') { const m = /<<\s*pipeline\.parameters\.(\w+)\s*>>/.exec(c); if (m) wfCond = [wfCond, `inputs.${m[1]}`].filter(Boolean).join(' && '); } else if (c && typeof c === 'object' && c.not) { const m = /<<\s*pipeline\.parameters\.(\w+)\s*>>/.exec(str(c.not)); if (m) wfCond = [wfCond, `!inputs.${m[1]}`].filter(Boolean).join(' && '); } else if (c === false) wfCond = 'false'; else ctx.note(`Workflow \`${wfName}\` has a \`when\` clause that was not translated.`); }
    const ids = new Map();
    for (const item of asList(w.jobs)) {
      if (typeof item === 'string') defineJob(item, {}, wfName, wfCond, ids);
      else if (item && typeof item === 'object') { const [jn, inv] = Object.entries(item)[0]; defineJob(jn, inv || {}, wfName, wfCond, ids); }
    }
  }
  if (anyTags) on.push.tags = ['*'];
  if (schedules.length) on.schedule = schedules;
  wf.on = on;
  // env shim for CIRCLE_* variables used in scripts
  const used = new Set();
  for (const j of Object.values(jobs)) for (const s of j.steps) for (const m of String(s.run || '').matchAll(/\$\{?(CIRCLE_[A-Z0-9_]+)\}?/g)) used.add(m[1]);
  const env = {};
  for (const v of used) if (CIRCLE_VARS[v] && !/matrix/.test(CIRCLE_VARS[v])) env[v] = CIRCLE_VARS[v];
  if (used.has('CIRCLE_TAG')) ctx.note('`CIRCLE_TAG` maps to `github.ref_name`, which is also set for branches; guard with `startsWith(github.ref, \'refs/tags/\')`.');
  if (Object.keys(env).length) wf.env = env;
  wf.jobs = Object.keys(jobs).length ? jobs : { build: { 'runs-on': ctx.opts.runner, steps: [{ run: 'echo "No jobs found"' }] } };
  return finish(wf, ctx);
}

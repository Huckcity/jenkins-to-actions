// GitLab CI (.gitlab-ci.yml) -> GitHub Actions
import { parse as parseYaml } from '../vendor/yaml.js';
import { makeCtx, slug, asList, str, script, firstLine, branchPatterns, finish, orderJob, todoStep } from './common.js';

const RESERVED = new Set(['stages', 'default', 'variables', 'include', 'workflow', 'image', 'services', 'before_script', 'after_script', 'cache', 'types', 'pages']);
const CI_VARS = {
  CI_COMMIT_SHA: '${{ github.sha }}', CI_COMMIT_SHORT_SHA: '${{ github.sha }}', CI_COMMIT_REF_NAME: '${{ github.ref_name }}', CI_COMMIT_BRANCH: '${{ github.ref_name }}', CI_COMMIT_REF_SLUG: '${{ github.ref_name }}', CI_COMMIT_TAG: '${{ github.ref_name }}',
  CI_DEFAULT_BRANCH: '${{ github.event.repository.default_branch }}', CI_PROJECT_DIR: '${{ github.workspace }}', CI_PROJECT_NAME: '${{ github.event.repository.name }}', CI_PROJECT_PATH: '${{ github.repository }}', CI_PROJECT_NAMESPACE: '${{ github.repository_owner }}', CI_PROJECT_URL: '${{ github.server_url }}/${{ github.repository }}',
  CI_PIPELINE_ID: '${{ github.run_id }}', CI_PIPELINE_IID: '${{ github.run_number }}', CI_PIPELINE_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}', CI_JOB_ID: '${{ github.run_id }}-${{ github.job }}', CI_JOB_NAME: '${{ github.job }}', CI_JOB_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
  CI_REGISTRY: 'ghcr.io', CI_REGISTRY_IMAGE: 'ghcr.io/${{ github.repository }}', CI_REGISTRY_USER: '${{ github.actor }}', CI_REGISTRY_PASSWORD: '${{ secrets.GITHUB_TOKEN }}',
  CI_MERGE_REQUEST_IID: '${{ github.event.pull_request.number }}', CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: '${{ github.head_ref }}', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: '${{ github.base_ref }}', CI_PIPELINE_SOURCE: '${{ github.event_name }}',
  GITLAB_USER_LOGIN: '${{ github.actor }}', GITLAB_USER_EMAIL: '', CI_SERVER_URL: '${{ github.server_url }}', CI_COMMIT_MESSAGE: '${{ github.event.head_commit.message }}', CI_COMMIT_TITLE: '${{ github.event.head_commit.message }}', CI_COMMIT_AUTHOR: '${{ github.event.head_commit.author.name }}', CI_ENVIRONMENT_NAME: '', CI: 'true', GITLAB_CI: 'true',
};

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out && typeof out[k] === 'object' && !Array.isArray(out[k]) && typeof v === 'object' && v !== null && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}

function resolveExtends(name, doc, seen = new Set()) {
  const job = doc[name];
  if (!job || typeof job !== 'object') return job;
  if (!job.extends) return job;
  if (seen.has(name)) return job;
  seen.add(name);
  let base = {};
  for (const parent of asList(job.extends)) { const p = resolveExtends(parent, doc, seen); if (p) base = deepMerge(base, p); }
  const { extends: _e, ...rest } = job;
  return deepMerge(base, rest);
}

function ruleIf(cond, ctx) {
  if (!cond) return null;
  let c = String(cond).trim();
  const simple = [
    [/^\$CI_COMMIT_BRANCH\s*==\s*\$CI_DEFAULT_BRANCH$/, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)"],
    [/^\$CI_COMMIT_BRANCH\s*==\s*["']([^"']+)["']$/, (m) => `github.ref == 'refs/heads/${m[1]}'`],
    [/^\$CI_COMMIT_BRANCH\s*!=\s*["']([^"']+)["']$/, (m) => `github.ref != 'refs/heads/${m[1]}'`],
    [/^\$CI_COMMIT_REF_NAME\s*==\s*["']([^"']+)["']$/, (m) => `github.ref_name == '${m[1]}'`],
    [/^\$CI_COMMIT_BRANCH\s*=~\s*\/\^?([^$/]+?)\.\*\$?\/$/, (m) => `startsWith(github.ref, 'refs/heads/${m[1]}')`],
    [/^\$CI_COMMIT_TAG\s*=~\s*\/\^?([^$/]+?)\.\*\$?\/$/, (m) => `startsWith(github.ref, 'refs/tags/${m[1]}')`],
    [/^\$CI_COMMIT_TAG$/, "startsWith(github.ref, 'refs/tags/')"],
    [/^\$CI_COMMIT_BRANCH$/, "startsWith(github.ref, 'refs/heads/')"],
    [/^\$CI_PIPELINE_SOURCE\s*==\s*["']merge_request_event["']$/, "github.event_name == 'pull_request'"],
    [/^\$CI_PIPELINE_SOURCE\s*!=\s*["']merge_request_event["']$/, "github.event_name != 'pull_request'"],
    [/^\$CI_PIPELINE_SOURCE\s*==\s*["']schedule["']$/, "github.event_name == 'schedule'"],
    [/^\$CI_PIPELINE_SOURCE\s*==\s*["']web["']$/, "github.event_name == 'workflow_dispatch'"],
    [/^\$CI_PIPELINE_SOURCE\s*==\s*["']push["']$/, "github.event_name == 'push'"],
    [/^\$CI_MERGE_REQUEST_IID$/, "github.event_name == 'pull_request'"],
    [/^\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME\s*==\s*["']([^"']+)["']$/, (m) => `github.base_ref == '${m[1]}'`],
    [/^\$([A-Z_][A-Z0-9_]*)\s*==\s*["']([^"']*)["']$/, (m) => (CI_VARS[m[1]] ? null : `env.${m[1]} == '${m[2]}'`)],
    [/^\$([A-Z_][A-Z0-9_]*)\s*!=\s*["']([^"']*)["']$/, (m) => (CI_VARS[m[1]] ? null : `env.${m[1]} != '${m[2]}'`)],
    [/^\$([A-Z_][A-Z0-9_]*)$/, (m) => (CI_VARS[m[1]] ? null : `env.${m[1]} != ''`)],
  ];
  const one = (expr) => {
    expr = expr.trim().replace(/^\((.*)\)$/, '$1').trim();
    for (const [re, rep] of simple) { const m = re.exec(expr); if (m) { const r = typeof rep === 'function' ? rep(m) : rep; if (r) return r; } }
    return null;
  };
  // split on && / ||
  const parts = c.split(/\s*(&&|\|\|)\s*/);
  if (parts.length > 1) {
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '&&' || parts[i] === '||') { out.push(parts[i]); continue; }
      const r = one(parts[i]); if (!r) { ctx.note(`Rule \`${c}\` could not be translated fully; check the generated \`if:\`.`); return `true /* TODO: ${c.replace(/\*\//g, '* /')} */`; }
      out.push(`(${r})`);
    }
    return out.join(' ');
  }
  const r = one(c);
  if (r) return r;
  ctx.note(`Rule \`${c}\` could not be translated; a placeholder was emitted.`);
  return `true /* TODO: ${c.replace(/\*\//g, '* /')} */`;
}

function refCond(list, ctx) {
  const parts = [];
  for (const r of asList(list)) {
    const v = String(r);
    if (v === 'merge_requests') parts.push("github.event_name == 'pull_request'");
    else if (v === 'tags') parts.push("startsWith(github.ref, 'refs/tags/')");
    else if (v === 'branches') parts.push("startsWith(github.ref, 'refs/heads/')");
    else if (v === 'schedules') parts.push("github.event_name == 'schedule'");
    else if (v === 'web' || v === 'api' || v === 'triggers' || v === 'pipelines') parts.push("github.event_name == 'workflow_dispatch'");
    else if (v === 'pushes') parts.push("github.event_name == 'push'");
    else if (/^\/.*\/$/.test(v)) { const p = v.slice(1, -1).replace(/^\^/, '').replace(/\$$/, '').replace(/\.\*$/, '').replace(/\\/g, ''); parts.push(`startsWith(github.ref_name, '${p}')`); }
    else if (v.includes('*')) parts.push(`startsWith(github.ref, 'refs/heads/${v.split('*')[0]}')`);
    else parts.push(`github.ref == 'refs/heads/${v}'`);
  }
  return parts.length ? parts.map((p) => `(${p})`).join(' || ') : null;
}

function jobCondition(job, ctx) {
  const conds = [];
  if (job.rules) {
    const allow = [], deny = [];
    for (const rule of asList(job.rules)) {
      if (typeof rule !== 'object' || rule === null) continue;
      if (rule.changes) ctx.note('`rules: changes` has no job-level equivalent; use `on.push.paths` filters or `dorny/paths-filter`.');
      if (rule.exists) ctx.note('`rules: exists` became a note; use `hashFiles()` in an `if:` if needed.');
      const c = rule.if ? ruleIf(rule.if, ctx) : null;
      if (rule.when === 'never') { if (c) deny.push(c); continue; }
      if (rule.when === 'manual') ctx.note(`A rule marks \`${job.__name}\` as manual; use a protected environment for approval.`);
      if (c) allow.push(c); else if (!rule.if) { allow.length = 0; allow.push(null); break; } // catch-all rule
    }
    const a = allow.includes(null) ? null : allow.length ? allow.map((x) => `(${x})`).join(' || ') : null;
    const d = deny.length ? deny.map((x) => `!(${x})`).join(' && ') : null;
    if (a) conds.push(a); if (d) conds.push(d);
    if (!allow.length && !deny.length && asList(job.rules).length) { /* only when/changes rules */ }
  } else {
    const only = job.only, except = job.except;
    if (only) { const c = refCond(Array.isArray(only) ? only : only.refs, ctx); if (c) conds.push(c); if (only.variables) ctx.note('`only: variables` must be rewritten as an `if:` expression.'); }
    if (except) { const c = refCond(Array.isArray(except) ? except : except.refs, ctx); if (c) conds.push(`!(${c})`); }
  }
  if (job.when === 'manual') { ctx.note(`Job \`${job.__name}\` is \`when: manual\`; it was given \`environment: manual-approval\`. Create that environment with required reviewers.`); }
  return conds.length ? conds.join(' && ') : null;
}

function runnerFromTags(tags, ctx) {
  const t = asList(tags).map(String);
  if (!t.length) return null;
  const l = t.join(' ').toLowerCase();
  if (/windows/.test(l)) return 'windows-latest';
  if (/macos|osx|mac/.test(l)) return 'macos-latest';
  if (/saas|docker|linux|gitlab-org|shared/.test(l)) return null;
  ctx.note(`Runner tags \`${t.join(', ')}\` mapped to \`[self-hosted, …]\`; switch to a hosted runner if those were GitLab shared runners.`);
  return ['self-hosted', ...t];
}

function imageOf(v) { return v && typeof v === 'object' ? v.name : v; }

function cacheStep(cache, ctx, label) {
  const paths = asList(cache.paths).map(String);
  if (!paths.length) return null;
  let key = cache.key;
  let keyExpr = '${{ runner.os }}-cache';
  if (typeof key === 'string') keyExpr = `\${{ runner.os }}-${key.replace(/\$CI_COMMIT_REF_SLUG|\$\{CI_COMMIT_REF_SLUG\}/g, '${{ github.ref_name }}').replace(/\$\{?([A-Z_]+)\}?/g, '${{ env.$1 }}')}`;
  else if (key && key.files) keyExpr = `\${{ runner.os }}-${label}-\${{ hashFiles(${asList(key.files).map((f) => `'${f}'`).join(', ')}) }}`;
  const step = { name: `Cache${label ? ' ' + label : ''}`, uses: 'actions/cache@v4', with: { path: paths.join('\n'), key: keyExpr } };
  if (key && key.files) step.with['restore-keys'] = `\${{ runner.os }}-${label}-`;
  if (cache.policy === 'pull') ctx.note('`cache: policy: pull` became a normal cache step (GitHub restores and saves).');
  return step;
}

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src, { merge: true }); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object') return { yaml: '', notes: ['Empty or invalid .gitlab-ci.yml'], secrets: [] };
  const wf = { name: ctx.opts.workflowName || 'CI' };
  const defaults = doc.default || {};
  const globalImage = imageOf(defaults.image || doc.image);
  const globalServices = defaults.services || doc.services;
  const globalBefore = defaults.before_script || doc.before_script;
  const globalAfter = defaults.after_script || doc.after_script;
  const globalCache = defaults.cache || doc.cache;
  const stages = asList(doc.stages).length ? asList(doc.stages).map(String) : ['.pre', 'build', 'test', 'deploy', '.post'];
  if (doc.include) ctx.note('`include:` files/templates were not resolved; jobs defined there are missing from this workflow.');
  if (doc.workflow && doc.workflow.rules) ctx.note('`workflow: rules` (pipeline-level) was not translated; set `on:` filters by hand if the pipeline only ran for some refs.');
  // env
  const env = {};
  const vars = doc.variables || {};
  for (const [k, v] of Object.entries(vars)) env[k] = typeof v === 'object' && v !== null ? str(v.value) : str(v);
  if (Object.keys(vars).length) ctx.note('Variables defined in GitLab CI/CD settings (not in the file) must be recreated as repository variables or secrets.');

  // jobs
  const names = Object.keys(doc).filter((k) => !RESERVED.has(k) && !k.startsWith('.') && doc[k] && typeof doc[k] === 'object');
  const jobs = {};
  const ids = new Map();
  const byStage = new Map();
  const resolved = new Map();
  for (const n of names) { const j = resolveExtends(n, doc); if (!j || typeof j !== 'object') continue; if (j.trigger) { ctx.note(`Job \`${n}\` triggers a downstream pipeline; use \`gh workflow run\` or a reusable workflow (\`uses: owner/repo/.github/workflows/x.yml@main\`).`); } j.__name = n; resolved.set(n, j); const st = String(j.stage || 'test'); if (!byStage.has(st)) byStage.set(st, []); byStage.get(st).push(n); ids.set(n, slug(n, ctx.jobIds)); }
  const stageOrder = stages.filter((s) => byStage.has(s)).concat([...byStage.keys()].filter((s) => !stages.includes(s)));
  const usedVars = new Set();
  const scan = (s) => { for (const m of String(s).matchAll(/\$\{?(CI_[A-Z0-9_]+|GITLAB_[A-Z_]+)\}?/g)) usedVars.add(m[1]); };

  let anyTags = false, anyPR = false;
  for (const stage of stageOrder) {
    const prevStages = stageOrder.slice(0, stageOrder.indexOf(stage));
    for (const n of byStage.get(stage)) {
      const j = resolved.get(n);
      const job = { name: n };
      const image = imageOf(j.image) || globalImage;
      const runs = runnerFromTags(j.tags, ctx);
      job['runs-on'] = runs || ctx.opts.runner;
      if (image && !runs) { job.container = { image: String(image) }; if (/^docker:/.test(String(image))) ctx.note(`Job \`${n}\` ran in a \`docker:\` image to use Docker; on GitHub drop the container and run \`docker\` directly on the runner.`); }
      else if (image && runs) ctx.note(`Job \`${n}\` has both runner tags and an image; the image was dropped because container jobs need a Linux runner.`);
      // needs
      let needs;
      if (j.needs !== undefined) { needs = asList(j.needs).map((x) => (typeof x === 'object' && x !== null ? x.job : x)).filter((x) => x && resolved.has(String(x))).map((x) => ids.get(String(x))); if (asList(j.needs).some((x) => typeof x === 'object' && x && x.pipeline)) ctx.note(`Job \`${n}\` needs an artifact from another pipeline; download it with \`dawidd6/action-download-artifact\`.`); }
      else if (prevStages.length) needs = prevStages.flatMap((s) => byStage.get(s)).map((x) => ids.get(x));
      if (needs && needs.length) job.needs = [...new Set(needs)];
      const cond = jobCondition(j, ctx);
      if (cond) job.if = cond;
      if (j.when === 'manual') job.environment = 'manual-approval';
      if (j.environment) { const e = typeof j.environment === 'object' ? j.environment.name : j.environment; job.environment = String(e).replace(/\$CI_COMMIT_REF_SLUG|\$CI_COMMIT_REF_NAME/g, '${{ github.ref_name }}'); }
      if (j.allow_failure === true || (j.allow_failure && typeof j.allow_failure === 'object')) job['continue-on-error'] = true;
      if (j.timeout) { const m = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(String(j.timeout)); const mins = (Number(m[1] || 0) * 60) + Number(m[2] || 0); if (mins) job['timeout-minutes'] = mins; }
      if (j.retry) ctx.note(`Job \`${n}\` has \`retry\`; GitHub has no job-level retry. Re-run failed jobs from the UI or wrap fragile steps in \`nick-fields/retry\`.`);
      if (j.resource_group) job.concurrency = { group: String(j.resource_group), 'cancel-in-progress': false };
      // services
      const services = j.services !== undefined ? j.services : globalServices;
      if (services) {
        const sv = {};
        for (const s of asList(services)) {
          const sn = typeof s === 'object' ? s.name : s; if (!sn) continue;
          if (/docker:.*dind|docker:dind/.test(String(sn))) { ctx.note('`docker:dind` service dropped: Docker is available on GitHub-hosted Linux runners without a service. Remove `DOCKER_HOST`/`DOCKER_TLS_CERTDIR` variables.'); continue; }
          const alias = (typeof s === 'object' && s.alias) || String(sn).split(':')[0].replace(/.*\//, '');
          sv[alias] = { image: String(sn) };
          if (typeof s === 'object' && s.variables) sv[alias].env = s.variables;
        }
        if (Object.keys(sv).length) { job.services = sv; if (!job.container) ctx.note(`Job \`${n}\` uses service containers without an image; services are reachable on \`localhost\` with their published ports when the job runs directly on the runner (add \`ports:\`).`); }
      }
      // matrix
      let matrixVars = [];
      let nodeEnv = null;
      if (j.parallel) {
        if (typeof j.parallel === 'number') { job.strategy = { matrix: { index: Array.from({ length: j.parallel }, (_, i) => i) } }; nodeEnv = { CI_NODE_INDEX: '${{ matrix.index }}', CI_NODE_TOTAL: String(j.parallel) }; ctx.note(`\`parallel: ${j.parallel}\` on \`${n}\` became a matrix of indexes; GitLab's CI_NODE_INDEX is 1-based while this matrix is 0-based.`); }
        else if (j.parallel.matrix) { const include = asList(j.parallel.matrix); const keys = [...new Set(include.flatMap((o) => Object.keys(o)))]; matrixVars = keys; if (include.length === 1) { const m = {}; for (const [k, v] of Object.entries(include[0])) m[k] = asList(v).map(str); job.strategy = { matrix: m }; } else { job.strategy = { matrix: { include: include.flatMap((o) => expand(o)) } }; } ctx.note(`\`parallel: matrix\` on \`${n}\` became \`strategy.matrix\`; variables ${keys.join(', ')} are exposed via \`env\`.`); }
      }
      // env
      const jenv = {};
      for (const [k, v] of Object.entries(j.variables || {})) jenv[k] = typeof v === 'object' && v !== null ? str(v.value) : str(v);
      for (const k of matrixVars) jenv[k] = `\${{ matrix.${k} }}`;
      if (nodeEnv) Object.assign(jenv, nodeEnv);
      if (Object.keys(jenv).length) job.env = jenv;
      // steps
      const steps = [];
      if (ctx.opts.checkout !== false && !(j.variables && j.variables.GIT_STRATEGY === 'none')) steps.push({ name: 'Checkout', uses: 'actions/checkout@v4' });
      const cache = j.cache !== undefined ? j.cache : globalCache;
      for (const c of asList(cache)) { if (c && typeof c === 'object') { const s = cacheStep(c, ctx, typeof c.key === 'string' ? c.key.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 20) : 'deps'); if (s) steps.push(s); } }
      const needsArtifacts = (j.dependencies !== undefined ? asList(j.dependencies) : (j.needs !== undefined ? asList(j.needs).map((x) => (typeof x === 'object' && x !== null ? (x.artifacts === false ? null : x.job) : x)) : prevStages.flatMap((s) => byStage.get(s)))).filter((x) => x && resolved.has(String(x)) && resolved.get(String(x)).artifacts && asList(resolved.get(String(x)).artifacts.paths).length);
      for (const dep of needsArtifacts) steps.push({ name: `Download artifacts from ${dep}`, uses: 'actions/download-artifact@v4', with: { name: `${ids.get(String(dep))}-artifacts` } });
      const before = j.before_script !== undefined ? j.before_script : globalBefore;
      if (before && asList(before).length) { steps.push({ name: 'Before script', run: script(before) }); scan(script(before)); }
      if (j.script !== undefined && asList(j.script).length) { const s = script(j.script); steps.push({ name: firstLine(s), run: s }); scan(s); }
      else if (!j.trigger) ctx.note(`Job \`${n}\` has no script.`);
      if (j.trigger) steps.push(todoStep(`Trigger downstream pipeline ${typeof j.trigger === 'object' ? j.trigger.project || j.trigger.include && 'child pipeline' : j.trigger}`, JSON.stringify(j.trigger), ctx));
      const after = j.after_script !== undefined ? j.after_script : globalAfter;
      if (after && asList(after).length) { steps.push({ name: 'After script', if: 'always()', run: script(after) }); scan(script(after)); }
      if (j.artifacts) {
        const a = j.artifacts;
        const paths = asList(a.paths).map(String);
        if (paths.length) { const st = { name: 'Upload artifacts', uses: 'actions/upload-artifact@v4', if: a.when === 'on_failure' ? 'failure()' : 'always()', with: { name: `${ids.get(n)}-artifacts`, path: paths.join('\n') } }; if (a.exclude) st.with.path += '\n' + asList(a.exclude).map((p) => '!' + p).join('\n'); if (a.expire_in) { const d = /(\d+)\s*(day|week|month|year)/.exec(String(a.expire_in)); if (d) st.with['retention-days'] = Math.min(90, Number(d[1]) * ({ day: 1, week: 7, month: 30, year: 365 })[d[2]]); } steps.push(st); }
        if (a.reports && a.reports.junit) { steps.push({ name: 'Publish test results', uses: 'mikepenz/action-junit-report@v5', if: 'always()', with: { report_paths: asList(a.reports.junit).join('\n') } }); ctx.note('`artifacts: reports: junit` became `mikepenz/action-junit-report`; it needs `permissions: checks: write`.'); }
        if (a.reports && (a.reports.coverage_report || a.reports.cobertura)) ctx.note('Coverage report artifact: upload it as an artifact or use `codecov/codecov-action`.');
      }
      if (j.coverage) ctx.note(`Coverage regex on \`${n}\` has no equivalent; use a coverage action or a job summary.`);
      if (j.release) { steps.push({ name: 'Create release', uses: 'softprops/action-gh-release@v2', if: "startsWith(github.ref, 'refs/tags/')", with: { body: str(j.release.description) || undefined } }); }
      if (j.pages !== undefined || n === 'pages') ctx.note('GitLab Pages job: deploy with `actions/upload-pages-artifact` + `actions/deploy-pages` instead.');
      if (!steps.length) steps.push({ run: 'echo "No steps"' });
      job.steps = steps;
      jobs[ids.get(n)] = orderJob(job);
      if (job.if && /refs\/tags/.test(job.if)) anyTags = true;
      if (job.if && /pull_request/.test(job.if)) anyPR = true;
    }
  }
  for (const v of usedVars) if (CI_VARS[v]) env[v] = CI_VARS[v];
  if (usedVars.has('CI_REGISTRY_PASSWORD') || usedVars.has('CI_REGISTRY')) ctx.note('`CI_REGISTRY*` variables were mapped to GitHub Container Registry (ghcr.io) with `GITHUB_TOKEN`; the job needs `permissions: packages: write`.');
  if (usedVars.has('CI_COMMIT_SHORT_SHA')) ctx.note('`CI_COMMIT_SHORT_SHA` maps to the full SHA; use `${GITHUB_SHA::8}` in shell if you need the short form.');
  if (usedVars.has('CI_MERGE_REQUEST_IID') || anyPR) wf.on = { push: { branches: ['main'] }, pull_request: {} };
  else wf.on = { push: { branches: ['**'] } };
  if (anyTags) wf.on.push.tags = ['*'];
  if (anyPR && !wf.on.pull_request) wf.on.pull_request = {};
  wf.on.workflow_dispatch = {};
  if (Object.keys(env).length) wf.env = env;
  wf.jobs = Object.keys(jobs).length ? jobs : { build: { 'runs-on': ctx.opts.runner, steps: [{ run: 'echo "No jobs found"' }] } };
  const out = finish(wf, ctx);
  return out;
}

function expand(o) { // {A:[1,2], B:[x]} -> [{A:1,B:x},{A:2,B:x}]
  let rows = [{}];
  for (const [k, v] of Object.entries(o)) { const vals = asList(v).map(str); rows = rows.flatMap((r) => vals.map((x) => ({ ...r, [k]: x }))); }
  return rows;
}

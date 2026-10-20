// Bitbucket Pipelines (bitbucket-pipelines.yml) -> GitHub Actions
import { parse as parseYaml } from '../vendor/yaml.js';
import { makeCtx, slug, asList, str, script, firstLine, finish, orderJob, todoStep } from './common.js';

const BB_VARS = { BITBUCKET_COMMIT: '${{ github.sha }}', BITBUCKET_BRANCH: '${{ github.ref_name }}', BITBUCKET_TAG: '${{ github.ref_name }}', BITBUCKET_BUILD_NUMBER: '${{ github.run_number }}', BITBUCKET_REPO_SLUG: '${{ github.event.repository.name }}', BITBUCKET_REPO_FULL_NAME: '${{ github.repository }}', BITBUCKET_WORKSPACE: '${{ github.repository_owner }}', BITBUCKET_REPO_OWNER: '${{ github.repository_owner }}', BITBUCKET_CLONE_DIR: '${{ github.workspace }}', BITBUCKET_PR_ID: '${{ github.event.pull_request.number }}', BITBUCKET_PR_DESTINATION_BRANCH: '${{ github.base_ref }}', BITBUCKET_STEP_TRIGGERER_UUID: '${{ github.actor }}', BITBUCKET_GIT_HTTP_ORIGIN: '${{ github.server_url }}/${{ github.repository }}', BITBUCKET_GIT_SSH_ORIGIN: 'git@github.com:${{ github.repository }}.git', BITBUCKET_PIPELINE_UUID: '${{ github.run_id }}', BITBUCKET_STEP_UUID: '${{ github.job }}', BITBUCKET_DEPLOYMENT_ENVIRONMENT: '', BITBUCKET_PROJECT_KEY: '', CI: 'true' };
const CACHES = { node: { path: 'node_modules', key: "${{ runner.os }}-node-${{ hashFiles('**/package-lock.json', '**/yarn.lock') }}" }, npm: { path: '~/.npm', key: "${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}" }, pip: { path: '~/.cache/pip', key: "${{ runner.os }}-pip-${{ hashFiles('**/requirements*.txt') }}" }, maven: { path: '~/.m2/repository', key: "${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}" }, gradle: { path: '~/.gradle/caches', key: "${{ runner.os }}-gradle-${{ hashFiles('**/*.gradle*') }}" }, composer: { path: '~/.composer/cache', key: "${{ runner.os }}-composer-${{ hashFiles('**/composer.lock') }}" }, sbt: { path: '~/.sbt', key: '${{ runner.os }}-sbt' }, ivy2: { path: '~/.ivy2/cache', key: '${{ runner.os }}-ivy2' }, dotnetcore: { path: '~/.nuget/packages', key: "${{ runner.os }}-nuget-${{ hashFiles('**/*.csproj') }}" } };

function pipeStep(pipe, vars, ctx) {
  const v = Object.fromEntries(Object.entries(vars || {}).map(([k, x]) => [k, str(x)]));
  const name = String(pipe).replace(/^docker:\/\//, '');
  const base = name.split(':')[0];
  const secretRef = (val) => String(val).replace(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/, (m, n) => { ctx.secret(n); return `\${{ secrets.${n} }}`; });
  switch (base) {
    case 'atlassian/aws-s3-deploy': return [{ name: 'Configure AWS credentials', uses: 'aws-actions/configure-aws-credentials@v4', with: { 'aws-access-key-id': secretRef(v.AWS_ACCESS_KEY_ID || '$AWS_ACCESS_KEY_ID'), 'aws-secret-access-key': secretRef(v.AWS_SECRET_ACCESS_KEY || '$AWS_SECRET_ACCESS_KEY'), 'aws-region': v.AWS_DEFAULT_REGION || 'us-east-1' } }, { name: 'Deploy to S3', run: `aws s3 sync ${v.LOCAL_PATH || '.'} s3://${v.S3_BUCKET || 'TODO'} ${v.DELETE_FLAG === 'true' ? '--delete' : ''} ${v.ACL ? `--acl ${v.ACL}` : ''} ${v.EXTRA_ARGS || ''}`.replace(/\s+/g, ' ').trim() }];
    case 'atlassian/aws-ecs-deploy': ctx.note('ECS deploy pipe: use `aws-actions/amazon-ecs-deploy-task-definition` after configuring AWS credentials.'); return [{ name: 'Deploy to ECS', uses: 'aws-actions/amazon-ecs-deploy-task-definition@v2', with: { 'task-definition': v.TASK_DEFINITION || 'task-definition.json', service: v.SERVICE_NAME || 'TODO', cluster: v.CLUSTER_NAME || 'TODO', 'wait-for-service-stability': true } }];
    case 'atlassian/aws-lambda-deploy': return [{ name: 'Deploy Lambda', run: `aws lambda update-function-code --function-name ${v.FUNCTION_NAME || 'TODO'} --zip-file fileb://${v.ZIP_FILE || 'function.zip'}` }];
    case 'atlassian/aws-cloudformation-deploy': return [{ name: 'Deploy CloudFormation', uses: 'aws-actions/aws-cloudformation-github-deploy@v1', with: { name: v.STACK_NAME || 'TODO', template: v.TEMPLATE || 'template.yml', capabilities: v.CAPABILITIES || undefined } }];
    case 'atlassian/ssh-run': ctx.note('ssh-run pipe became `appleboy/ssh-action`; store the key as a secret.'); return [{ name: 'Run over SSH', uses: 'appleboy/ssh-action@v1', with: { host: v.SERVER || 'TODO', username: v.SSH_USER || 'TODO', key: `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}`, script: v.COMMAND || 'TODO', port: v.PORT || undefined } }];
    case 'atlassian/scp-deploy': ctx.note('scp-deploy pipe became `appleboy/scp-action`.'); return [{ name: 'Copy over SCP', uses: 'appleboy/scp-action@v1', with: { host: v.SERVER || 'TODO', username: v.USER || 'TODO', key: `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}`, source: v.LOCAL_PATH || '.', target: v.REMOTE_PATH || 'TODO' } }];
    case 'atlassian/rsync-deploy': return [{ name: 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}` } }, { name: 'rsync deploy', run: `rsync -az ${v.EXTRA_ARGS || ''} ${v.LOCAL_PATH || '.'} ${v.USER || 'TODO'}@${v.SERVER || 'TODO'}:${v.REMOTE_PATH || 'TODO'}`.replace(/\s+/g, ' ') }];
    case 'atlassian/slack-notify': ctx.note('Slack pipe: use `slackapi/slack-github-action` with a webhook secret.'); return [{ name: 'Slack notification', uses: 'slackapi/slack-github-action@v2', with: { 'webhook-type': 'incoming-webhook', webhook: secretRef(v.WEBHOOK_URL || '$SLACK_WEBHOOK'), payload: `text: "${(v.MESSAGE || 'Build ${{ github.run_number }} finished').replace(/"/g, '\\"')}"` } }];
    case 'atlassian/firebase-deploy': return [{ name: 'Deploy to Firebase', run: `npx firebase-tools deploy --project ${v.PROJECT_ID || 'TODO'} --token "$FIREBASE_TOKEN" ${v.EXTRA_ARGS || ''}`.trim(), env: { FIREBASE_TOKEN: secretRef(v.FIREBASE_TOKEN || '$FIREBASE_TOKEN') } }];
    case 'atlassian/heroku-deploy': return [{ name: 'Deploy to Heroku', uses: 'akhileshns/heroku-deploy@v3.13.15', with: { heroku_api_key: secretRef(v.HEROKU_API_KEY || '$HEROKU_API_KEY'), heroku_app_name: v.HEROKU_APP_NAME || 'TODO', heroku_email: 'TODO' } }];
    case 'atlassian/npm-publish': return [{ name: 'Publish to npm', run: 'npm publish', env: { NODE_AUTH_TOKEN: secretRef(v.NPM_TOKEN || '$NPM_TOKEN') } }];
    case 'atlassian/git-secrets-scan': return [{ name: 'Scan for secrets', uses: 'gitleaks/gitleaks-action@v2' }];
    case 'atlassian/trigger-pipeline': ctx.note('trigger-pipeline pipe: use `gh workflow run` on the target workflow.'); return [{ name: 'Trigger pipeline', run: `gh workflow run ${v.PIPELINE || 'TODO.yml'} -R ${v.REPOSITORY || '${{ github.repository }}'}`, env: { GH_TOKEN: '${{ github.token }}' } }];
    case 'atlassian/azure-web-apps-deploy': return [{ name: 'Azure login', uses: 'azure/login@v2', with: { creds: `\${{ secrets.${ctx.secret('AZURE_CREDENTIALS')} }}` } }, { name: 'Deploy to Azure Web App', uses: 'azure/webapps-deploy@v3', with: { 'app-name': v.AZURE_APP_NAME || 'TODO', package: v.ZIP_FILE || '.' } }];
    case 'atlassian/google-app-engine-deploy': return [{ name: 'Authenticate to Google Cloud', uses: 'google-github-actions/auth@v2', with: { credentials_json: secretRef(v.KEY_FILE || '$GCLOUD_KEY') } }, { name: 'Deploy to App Engine', uses: 'google-github-actions/deploy-appengine@v2', with: { project_id: v.PROJECT || 'TODO' } }];
    case 'atlassian/kubectl-run': ctx.note('kubectl-run pipe: write the kubeconfig from a secret, then run kubectl.'); return [{ name: 'kubectl', run: `kubectl ${v.KUBECTL_COMMAND || 'apply'} ${v.KUBECTL_ARGS || ''}`.trim(), env: { KUBECONFIG_B64: secretRef(v.KUBE_CONFIG || '$KUBE_CONFIG') } }];
    case 'atlassian/sonarcloud-scan': case 'sonarsource/sonarcloud-scan': return [{ name: 'SonarCloud scan', uses: 'SonarSource/sonarqube-scan-action@v5', env: { SONAR_TOKEN: secretRef(v.SONAR_TOKEN || '$SONAR_TOKEN'), SONAR_HOST_URL: 'https://sonarcloud.io' } }];
    case 'snyk/snyk-scan': return [{ name: 'Snyk scan', uses: 'snyk/actions/node@master', env: { SNYK_TOKEN: secretRef(v.SNYK_TOKEN || '$SNYK_TOKEN') } }];
    case 'atlassian/jira-upload-build-info': case 'atlassian/jira-upload-deployment-info': ctx.note('Jira integration pipes were dropped; the GitHub-for-Jira app handles this.'); return [];
    case 'atlassian/checkstyle-report': case 'atlassian/eslint-report': return [{ name: `${base.split('/')[1]}`, run: `# TODO: ${base} produced a code-insights report; upload the report as an artifact instead\necho skipped` }];
    default:
      if (/^docker:\/\//.test(String(pipe)) || !/^atlassian\//.test(base)) { const envs = Object.entries(v).map(([k, x]) => `-e ${k}="${x}"`).join(' '); return [{ name: `Run ${name}`, run: `docker run --rm ${envs} -v "$PWD":/work -w /work ${name}`.replace(/\s+/g, ' ') }]; }
      ctx.note(`Pipe \`${pipe}\` has no mapping; find the equivalent action.`); return [todoStep(`Pipe ${pipe}`, JSON.stringify(v).slice(0, 300), ctx)];
  }
}

function stepToJob(stepDef, ctx, sectionCond, defs, globals, state) {
  const s = stepDef || {};
  const name = s.name ? String(s.name) : `Step ${state.count + 1}`;
  const id = slug(state.prefix ? `${state.prefix}-${name}` : name, ctx.jobIds);
  state.count++;
  const job = { name: state.prefix ? `${state.prefix} / ${name}` : name };
  const runsOn = s['runs-on'] ? ['self-hosted', ...asList(s['runs-on']).map(String).filter((x) => x !== 'self.hosted')] : null;
  job['runs-on'] = runsOn || ctx.opts.runner;
  if (runsOn) ctx.note(`Step \`${name}\` ran on self-hosted runners with labels ${asList(s['runs-on']).join(', ')}.`);
  const image = s.image !== undefined ? s.image : globals.image;
  if (image && !runsOn) {
    const img = typeof image === 'object' ? image : { name: image };
    job.container = { image: String(img.name) };
    if (img.username) { job.container.credentials = { username: String(img.username).replace(/^\$(\w+)$/, (m, n) => `\${{ secrets.${ctx.secret(n)} }}`), password: String(img.password || '').replace(/^\$(\w+)$/, (m, n) => `\${{ secrets.${ctx.secret(n)} }}`) }; }
    if (/^atlassian\/default-image/.test(String(img.name))) { delete job.container; ctx.note('`atlassian/default-image` dropped: ubuntu-latest has the same common tooling.'); }
  }
  if (state.prev.length) job.needs = [...state.prev];
  if (sectionCond) job.if = sectionCond;
  if (s.deployment) job.environment = String(s.deployment);
  if (s.trigger === 'manual') { job.environment = job.environment || 'manual-approval'; ctx.note(`Manual step \`${name}\` became a job gated by environment \`${job.environment}\`; add required reviewers.`); }
  if (s['max-time'] || globals.maxTime) job['timeout-minutes'] = Number(s['max-time'] || globals.maxTime);
  if (s.size) ctx.note(`Step \`${name}\` requested size ${s.size}; pick a larger hosted runner if memory matters.`);
  if (s.condition && s.condition.changesets) ctx.note(`Step \`${name}\` has a changeset condition (${asList(s.condition.changesets.includePaths).join(', ')}); use \`dorny/paths-filter\` or \`on.push.paths\`.`);
  if (s['fail-fast'] === false) job['continue-on-error'] = true;
  // services
  const sv = {};
  for (const svc of asList(s.services)) {
    const def = (defs.services || {})[svc];
    if (svc === 'docker') { continue; }
    if (def && def.image) { sv[svc] = { image: String(typeof def.image === 'object' ? def.image.name : def.image) }; if (def.variables) sv[svc].env = Object.fromEntries(Object.entries(def.variables).map(([k, v]) => [k, str(v)])); if (def.ports) sv[svc].ports = asList(def.ports).map(String); }
    else ctx.note(`Service \`${svc}\` is not defined under \`definitions.services\`.`);
  }
  if (Object.keys(sv).length) { job.services = sv; if (!job.container) ctx.note(`Services on \`${name}\` are reachable at localhost only if \`ports:\` are published; add them.`); }
  const steps = [];
  const clone = { ...(globals.clone || {}), ...(s.clone || {}) };
  if (clone.enabled !== false && ctx.opts.checkout !== false) { const st = { name: 'Checkout', uses: 'actions/checkout@v4' }; const w = {}; if (clone.depth && clone.depth !== 'full') w['fetch-depth'] = Number(clone.depth); if (clone.lfs) w.lfs = true; if (Object.keys(w).length) st.with = w; steps.push(st); }
  for (const c of asList(s.caches)) {
    const cname = String(c);
    const custom = (defs.caches || {})[cname];
    if (custom) { const path = typeof custom === 'object' ? String(custom.path) : String(custom); const key = typeof custom === 'object' && custom.key && custom.key.files ? `\${{ runner.os }}-${cname}-\${{ hashFiles(${asList(custom.key.files).map((f) => `'${f}'`).join(', ')}) }}` : `\${{ runner.os }}-${cname}`; steps.push({ name: `Cache ${cname}`, uses: 'actions/cache@v4', with: { path, key } }); }
    else if (CACHES[cname]) steps.push({ name: `Cache ${cname}`, uses: 'actions/cache@v4', with: { path: CACHES[cname].path, key: CACHES[cname].key } });
    else if (cname === 'docker') ctx.note('`docker` cache: use `docker/build-push-action` with `cache-from: type=gha`.');
    else ctx.note(`Cache \`${cname}\` is not a known preset or definition.`);
  }
  // artifacts from previous steps
  for (const prev of state.artifactJobs) steps.push({ name: `Download artifacts from ${prev.name}`, uses: 'actions/download-artifact@v4', with: { name: `${prev.id}-artifacts` } });
  // script
  const lines = [];
  const flush = () => { if (lines.length) { const body = script(lines.splice(0)); steps.push({ name: firstLine(body), run: body }); } };
  for (const item of asList(s.script)) {
    if (item && typeof item === 'object' && item.pipe) { flush(); steps.push(...pipeStep(item.pipe, item.variables, ctx)); }
    else lines.push(String(item));
  }
  flush();
  if (s['after-script']) { const body = script(asList(s['after-script']).map(String)); steps.push({ name: 'After script', if: 'always()', run: body }); }
  if (s.artifacts) {
    const a = Array.isArray(s.artifacts) || typeof s.artifacts === 'string' ? { paths: asList(s.artifacts) } : s.artifacts;
    const paths = asList(a.paths).map(String);
    if (paths.length) { steps.push({ name: 'Upload artifacts', uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: `${id}-artifacts`, path: paths.join('\n') } }); state.artifactJobs.push({ id, name }); }
  }
  if (s.oidc) ctx.note(`Step \`${name}\` used OIDC; add \`permissions: id-token: write\` and the cloud provider's OIDC login action.`);
  if (!steps.length) steps.push({ run: 'echo "No script"' });
  job.steps = steps;
  return { id, job: orderJob(job) };
}

function convertItems(items, ctx, sectionCond, defs, globals, state, jobs) {
  for (const item of asList(items)) {
    if (!item || typeof item !== 'object') continue;
    if (item.step) { const { id, job } = stepToJob(item.step, ctx, sectionCond, defs, globals, state); jobs[id] = job; state.prev = [id]; continue; }
    if (item.parallel) {
      const list = Array.isArray(item.parallel) ? item.parallel : asList(item.parallel.steps);
      const ids = [];
      const before = [...state.prev];
      for (const p of list) { if (p && p.step) { state.prev = before; const { id, job } = stepToJob(p.step, ctx, sectionCond, defs, globals, state); jobs[id] = job; ids.push(id); } }
      state.prev = ids; continue;
    }
    if (item.stage) {
      ctx.note(`Stage \`${item.stage.name || ''}\` was flattened into its steps; a GitHub environment (${item.stage.deployment || 'none'}) was applied to each.`);
      for (const st of asList(item.stage.steps)) { if (st && st.step) { const { id, job } = stepToJob({ ...st.step, deployment: st.step.deployment || item.stage.deployment, trigger: st.step.trigger || item.stage.trigger }, ctx, sectionCond, defs, globals, state); jobs[id] = job; state.prev = [id]; } }
      continue;
    }
    if (item.variables) { state.inputs = asList(item.variables).map((v) => ({ name: String(v.name), default: v.default !== undefined ? str(v.default) : undefined, options: v['allowed-values'] ? asList(v['allowed-values']).map(str) : undefined, description: v.description ? String(v.description) : undefined })); continue; }
    if (item.import) { ctx.note(`Imported pipeline \`${item.import}\` was not resolved.`); continue; }
  }
}

function patternCond(pattern, prefix) {
  const p = String(pattern);
  if (p === '*' || p === '**') return `startsWith(github.ref, '${prefix}')`;
  if (/^\{.*\}$/.test(p)) return `(${p.slice(1, -1).split(',').map((x) => patternCond(x.trim(), prefix)).join(' || ')})`;
  if (p.endsWith('/**') || p.endsWith('/*')) return `startsWith(github.ref, '${prefix}${p.replace(/\/\*+$/, '/')}')`;
  if (p.endsWith('*')) return `startsWith(github.ref, '${prefix}${p.slice(0, -1)}')`;
  if (p.includes('*')) return `contains(github.ref, '${p.split('*')[0]}')`;
  return `github.ref == '${prefix}${p}'`;
}

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src, { merge: true }); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object' || !doc.pipelines) return { yaml: '', notes: ['No `pipelines:` section found; is this a bitbucket-pipelines.yml?'], secrets: [] };
  const wf = { name: ctx.opts.workflowName || 'CI' };
  const defs = doc.definitions || {};
  const globals = { image: doc.image, clone: doc.clone, maxTime: doc.options && doc.options['max-time'] };
  const jobs = {};
  const on = {};
  const pl = doc.pipelines;
  const sections = [];
  if (pl.default) sections.push({ key: 'default', items: pl.default, cond: null });
  for (const [pat, items] of Object.entries(pl.branches || {})) sections.push({ key: `branch ${pat}`, prefix: Object.keys(pl.branches).length > 1 || pl.default ? pat.replace(/[^\w-]+/g, '-') : '', items, cond: patternCond(pat, 'refs/heads/'), branch: pat });
  for (const [pat, items] of Object.entries(pl['pull-requests'] || {})) sections.push({ key: `pr ${pat}`, prefix: 'pr', items, cond: `github.event_name == 'pull_request'${pat === '**' || pat === '*' ? '' : ` && ${patternCond(pat, 'refs/heads/').replace('github.ref', 'format(\'refs/heads/{0}\', github.head_ref)')}`}`, pr: true });
  for (const [pat, items] of Object.entries(pl.tags || {})) sections.push({ key: `tag ${pat}`, prefix: 'tag', items, cond: patternCond(pat, 'refs/tags/'), tag: true });
  for (const [pat, items] of Object.entries(pl.bookmarks || {})) ctx.note(`Mercurial bookmark pipeline \`${pat}\` skipped.`);
  const customs = Object.entries(pl.custom || {});
  for (const [cname, items] of customs) sections.push({ key: `custom ${cname}`, prefix: cname, items, cond: `github.event_name == 'workflow_dispatch' && inputs.pipeline == '${cname}'`, custom: cname });
  const branches = sections.filter((s) => s.branch).map((s) => s.branch);
  if (pl.default) { on.push = { branches: ['**'] }; if (branches.length) ctx.note('`default` runs for every branch without its own pipeline on Bitbucket; on GitHub the default jobs were given an `if:` that excludes the branches with their own pipeline.'); }
  else if (branches.length) on.push = { branches: branches.map((b) => b.replace(/\*\*/g, '**')) };
  if (sections.some((s) => s.tag)) { on.push = on.push || {}; on.push.tags = ['*']; }
  if (sections.some((s) => s.pr)) on.pull_request = {};
  const dispatch = {};
  if (customs.length) dispatch.inputs = { pipeline: { description: 'Custom pipeline to run', type: 'choice', options: customs.map(([k]) => k), required: true } };
  on.workflow_dispatch = dispatch;
  if (customs.length) ctx.note('Custom pipelines became a `workflow_dispatch` input `pipeline`; each custom pipeline\'s jobs run only when it is selected.');
  const defaultCond = branches.length ? branches.map((b) => `!(${patternCond(b, 'refs/heads/')})`).join(' && ') : null;
  for (const sec of sections) {
    const state = { count: 0, prev: [], artifactJobs: [], prefix: sections.length > 1 ? (sec.key === 'default' ? 'default' : sec.prefix) : '', inputs: null };
    let cond = sec.cond;
    if (sec.key === 'default') { const parts = []; if (defaultCond) parts.push(defaultCond); if (on.pull_request) parts.push("github.event_name != 'pull_request'"); if (on.push && on.push.tags) parts.push("!startsWith(github.ref, 'refs/tags/')"); if (customs.length) parts.push("github.event_name != 'workflow_dispatch'"); cond = parts.length ? parts.join(' && ') : null; }
    else if (sec.branch && (on.pull_request || customs.length)) cond = `${cond} && github.event_name == 'push'`;
    convertItems(sec.items, ctx, cond, defs, globals, state, jobs);
    if (state.inputs) { for (const i of state.inputs) { dispatch.inputs = dispatch.inputs || {}; dispatch.inputs[i.name] = { description: i.description, default: i.default, type: i.options ? 'choice' : 'string', options: i.options, required: false }; } }
  }
  if (Object.keys(dispatch).length) on.workflow_dispatch = dispatch;
  wf.on = on;
  const used = new Set();
  for (const j of Object.values(jobs)) for (const s of j.steps) for (const m of String(s.run || '').matchAll(/\$\{?(BITBUCKET_[A-Z0-9_]+)\}?/g)) used.add(m[1]);
  const env = {};
  for (const v of used) if (BB_VARS[v]) env[v] = BB_VARS[v];
  if (Object.keys(env).length) wf.env = env;
  ctx.note('Repository and deployment variables set in Bitbucket must be recreated as GitHub variables or secrets.');
  wf.jobs = Object.keys(jobs).length ? jobs : { build: { 'runs-on': ctx.opts.runner, steps: [{ run: 'echo "No steps found"' }] } };
  return finish(wf, ctx);
}

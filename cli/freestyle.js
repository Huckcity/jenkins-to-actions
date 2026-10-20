// Convert a Jenkins freestyle (hudson.model.Project), Maven (hudson.maven.MavenModuleSet) or matrix
// (hudson.matrix.MatrixProject) job config.xml into a GitHub Actions workflow object plus notes.
import { parseXml, child, children, text, findAll } from './xml.js';
import { toYaml } from '../public/convert.js';

const short = (cls) => cls.replace(/^.*\./, '');

export function classifyConfig(xmlSrc) {
  const doc = parseXml(xmlSrc);
  const root = doc.children.find((c) => c.name !== '#document');
  if (!root) return { type: 'unknown', root: null };
  const map = {
    'project': 'freestyle',
    'maven2-moduleset': 'maven',
    'matrix-project': 'matrix',
    'flow-definition': 'pipeline',
    'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject': 'multibranch',
    'com.cloudbees.hudson.plugins.folder.Folder': 'folder',
    'jenkins.branch.OrganizationFolder': 'organization-folder',
    'hudson.model.ExternalJob': 'external',
    'com.tikal.jenkins.plugins.multijob.MultiJobProject': 'multijob',
  };
  return { type: map[root.name] || (root.name.includes('Folder') ? 'folder' : 'unknown'), root, rootName: root.name };
}

function cronToSchedule(spec, notes) {
  const out = [];
  for (let line of spec.split('\n')) {
    line = line.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (/^TZ=/.test(line)) { notes.push(`Cron timezone \`${line}\` dropped: GitHub schedules run in UTC.`); continue; }
    if (/H/.test(line)) notes.push(`Jenkins \`H\` in cron \`${line}\` replaced with fixed values.`);
    out.push({ cron: line.replace(/H\((\d+)-(\d+)\)/g, '$1').replace(/H\/(\d+)/g, '*/$1').replace(/\bH\b/g, '0') });
  }
  return out;
}

function labelToRunsOn(label, notes) {
  if (!label) return 'ubuntu-latest';
  const l = label.toLowerCase();
  if (/windows|\bwin\b/.test(l)) return 'windows-latest';
  if (/mac|osx|darwin/.test(l)) return 'macos-latest';
  if (/linux|ubuntu|docker|master|built-in/.test(l)) return 'ubuntu-latest';
  notes.push(`Node label \`${label}\` mapped to a self-hosted runner; change \`runs-on\` if a hosted runner will do.`);
  return ['self-hosted', ...label.split(/\s*(?:&&|\|\|)\s*|\s+/).filter(Boolean)];
}

function secretName(id, suffix) { return (id + (suffix ? '_' + suffix : '')).toUpperCase().replace(/[^A-Z0-9_]/g, '_'); }

function dedent(s) {
  const lines = s.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const ind = lines.filter((l) => l.trim()).reduce((m, l) => Math.min(m, l.match(/^\s*/)[0].length), Infinity);
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n').replace(/^#!\/bin\/(ba)?sh\s*\n/, '');
}

export function convertFreestyle(xmlSrc, { name = 'job', runner = 'ubuntu-latest' } = {}) {
  const notes = [];
  const secrets = new Set();
  const plugins = new Set();
  const { type, root } = classifyConfig(xmlSrc);
  if (!root || !['freestyle', 'maven', 'matrix'].includes(type)) return { yaml: '', notes: [`Not a freestyle/maven/matrix job (root element ${root ? root.name : 'missing'}).`], secrets: [], plugins: [], type };
  const noteOnce = (m) => { if (!notes.includes(m)) notes.push(m); };
  const sec = (id, suffix) => { const n = secretName(id, suffix); secrets.add(n); return n; };

  const wf = { name: text(root, 'displayName') || name };
  const on = {};
  const env = {};
  const steps = [];
  const inputs = {};
  let timeoutMinutes = null;
  let concurrency = null;
  let skipCheckout = false;
  let repo = null;

  // ---- properties: parameters, throttling, etc.
  const props = child(root, 'properties');
  for (const p of children(props)) {
    plugins.add(short(p.name));
    if (p.name === 'hudson.model.ParametersDefinitionProperty') {
      for (const def of children(child(p, 'parameterDefinitions'))) {
        const pn = text(def, 'name'); if (!pn) continue;
        const desc = text(def, 'description');
        const input = { description: desc || undefined, required: false };
        const dv = child(def, 'defaultValue');
        switch (short(def.name)) {
          case 'BooleanParameterDefinition': input.type = 'boolean'; input.default = text(def, 'defaultValue') === 'true'; break;
          case 'ChoiceParameterDefinition': { input.type = 'choice'; const ch = children(child(child(def, 'choices'), 'a'), 'string').map((s) => s.text.trim()); input.options = ch; if (ch.length) input.default = ch[0]; break; }
          case 'PasswordParameterDefinition': input.type = 'string'; noteOnce(`Password parameter \`${pn}\` became a plain input; use a repository secret instead.`); break;
          default: input.type = 'string'; if (dv) input.default = dv.text.trim();
        }
        inputs[pn] = input;
      }
    } else if (/DisableConcurrentBuildsJobProperty|ThrottleJobProperty/.test(p.name)) {
      concurrency = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': false };
    } else if (/BuildDiscarderProperty|RebuildSettings|GithubProjectProperty|EnvInjectJobProperty|HudsonJobProperty|JiraProjectProperty/.test(p.name)) {
      if (p.name.includes('EnvInjectJobProperty')) { const content = text(child(p, 'info'), 'propertiesContent'); for (const line of content.split('\n')) { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line); if (m) env[m[1]] = m[2].trim(); } }
    } else noteOnce(`Job property \`${short(p.name)}\` dropped.`);
  }

  // ---- SCM
  const scm = child(root, 'scm');
  const scmClass = scm ? scm.attrs.class || scm.name : '';
  if (scm && /GitSCM/.test(scmClass)) {
    plugins.add('git');
    const urls = findAll(scm, (c) => c.name === 'url').map((u) => u.text.trim());
    const url = urls[0] || '';
    const branches = findAll(scm, (c) => c.name === 'name' && c.text.includes('/')).map((b) => b.text.trim());
    const branch = (branches[0] || '').replace(/^\*\//, '').replace(/^refs\/heads\//, '');
    const w = {};
    const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (url && !m) noteOnce(`SCM URL \`${url}\` is not on GitHub; actions/checkout only clones GitHub repositories, so use a \`run: git clone\` step.`);
    else if (m) { repo = m[1]; noteOnce(`This workflow assumes it lives in \`${m[1]}\` (the repository the job checked out). If it lives elsewhere, add \`repository:\` and a token to the checkout step.`); }
    if (branch && branch !== 'master' && branch !== 'main' && !branch.includes('*')) w.ref = branch;
    const credId = findAll(scm, (c) => c.name === 'credentialsId').map((c) => c.text.trim())[0];
    if (credId && !m) w.token = `\${{ secrets.${sec(credId)} }}`;
    for (const ext of children(child(scm, 'extensions'))) {
      const en = short(ext.name);
      if (en === 'SubmoduleOption') w.submodules = 'recursive';
      else if (en === 'CloneOption') { const d = text(ext, 'depth'); if (d && d !== '0') w['fetch-depth'] = Number(d); else if (text(ext, 'shallow') === 'true') w['fetch-depth'] = 1; }
      else if (en === 'RelativeTargetDirectory') w.path = text(ext, 'relativeTargetDir');
      else if (/GitLFSPull/.test(en)) w.lfs = true;
      else if (/CleanBeforeCheckout|CleanCheckout|WipeWorkspace|LocalBranch|PruneStaleBranch|CheckoutOption|UserIdentity|AuthorInChangelog|DisableRemotePoll|PathRestriction|MessageExclusion|UserExclusion|BuildChooserSetting/.test(en)) { /* default behaviour or irrelevant */ }
      else noteOnce(`Git extension \`${en}\` dropped.`);
    }
    steps.push({ name: 'Checkout', uses: 'actions/checkout@v4', with: Object.keys(w).length ? w : undefined });
    on.push = { branches: [branch && !branch.includes('*') ? branch : 'main'] };
  } else if (scm && /SubversionSCM/.test(scmClass)) {
    plugins.add('subversion');
    noteOnce('Subversion SCM: GitHub Actions needs the code in a Git repository. Migrate the repo first (git svn or svn2git), then use actions/checkout.');
    steps.push({ name: 'TODO: checkout from Subversion', run: '# TODO: this job checked out from Subversion\necho "migrate the repository to git" && exit 1' });
  } else if (scm && !/NullSCM/.test(scmClass)) {
    noteOnce(`SCM \`${short(scmClass)}\` not recognised; add a checkout step by hand.`);
  } else {
    skipCheckout = true;
  }

  // ---- triggers
  for (const t of children(child(root, 'triggers'))) {
    const tn = short(t.name);
    plugins.add(tn);
    if (tn === 'TimerTrigger') on.schedule = cronToSchedule(text(t, 'spec'), notes);
    else if (tn === 'SCMTrigger') { on.push = on.push || { branches: ['main'] }; }
    else if (/GitHubPushTrigger|GitLabPushTrigger|BitBucketTrigger/.test(tn)) { on.push = on.push || { branches: ['main'] }; }
    else if (tn === 'ReverseBuildTrigger') { on.workflow_run = { workflows: text(t, 'upstreamProjects').split(',').map((s) => s.trim()).filter(Boolean), types: ['completed'] }; }
    else if (/ghprb|PullRequest/i.test(tn)) { on.pull_request = { branches: ['main'] }; }
    else noteOnce(`Trigger \`${tn}\` has no equivalent and was dropped.`);
  }
  if (!on.push && !on.schedule && !on.workflow_run && !on.pull_request) { on.push = { branches: ['main'] }; }
  if (Object.keys(inputs).length) { on.workflow_dispatch = { inputs }; } else on.workflow_dispatch = {};

  // ---- build wrappers (credentials, timeouts, env)
  const wrapperEnv = {};
  for (const w of children(child(root, 'buildWrappers'))) {
    const wn = short(w.name);
    plugins.add(wn);
    if (wn === 'SecretBuildWrapper') {
      for (const b of children(child(w, 'bindings'))) {
        const bn = short(b.name); const id = text(b, 'credentialsId');
        if (bn === 'StringBinding') wrapperEnv[text(b, 'variable')] = `\${{ secrets.${sec(id)} }}`;
        else if (bn === 'UsernamePasswordMultiBinding') { wrapperEnv[text(b, 'usernameVariable')] = `\${{ secrets.${sec(id, 'USERNAME')} }}`; wrapperEnv[text(b, 'passwordVariable')] = `\${{ secrets.${sec(id, 'PASSWORD')} }}`; }
        else if (bn === 'UsernamePasswordBinding') wrapperEnv[text(b, 'variable')] = `\${{ secrets.${sec(id, 'USERNAME')} }}:\${{ secrets.${sec(id, 'PASSWORD')} }}`;
        else if (bn === 'FileBinding') { wrapperEnv[text(b, 'variable')] = `\${{ runner.temp }}/${text(b, 'variable').toLowerCase()}`; sec(id); noteOnce(`File credential \`${id}\`: store it base64-encoded as secret \`${secretName(id)}\` and decode it into \`$${text(b, 'variable')}\` in a step.`); }
        else if (bn === 'SSHUserPrivateKeyBinding') { sec(id); noteOnce(`SSH key credential \`${id}\`: use \`webfactory/ssh-agent\` with secret \`${secretName(id)}\`.`); steps.push({ name: 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${secretName(id)} }}` } }); }
        else if (/AmazonWebServicesCredentialsBinding/.test(bn)) { wrapperEnv.AWS_ACCESS_KEY_ID = `\${{ secrets.${sec(id, 'AWS_ACCESS_KEY_ID')} }}`; wrapperEnv.AWS_SECRET_ACCESS_KEY = `\${{ secrets.${sec(id, 'AWS_SECRET_ACCESS_KEY')} }}`; noteOnce('AWS credentials: prefer `aws-actions/configure-aws-credentials` with OIDC.'); }
        else { sec(id); noteOnce(`Credential binding \`${bn}\` (${id}) needs manual handling.`); }
      }
    } else if (wn === 'BuildTimeoutWrapper') {
      const strategy = child(w, 'strategy'); const mins = text(strategy, 'timeoutMinutes') || text(w, 'timeoutMinutes');
      if (mins) timeoutMinutes = Number(mins); else noteOnce('Build timeout wrapper uses a non-absolute strategy; set `timeout-minutes` by hand.');
    } else if (wn === 'EnvInjectBuildWrapper') {
      const content = text(child(w, 'info'), 'propertiesContent');
      for (const line of content.split('\n')) { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line); if (m) env[m[1]] = m[2].trim(); }
      if (text(child(w, 'info'), 'scriptContent')) noteOnce('EnvInject script content must be rewritten as a step that appends to `$GITHUB_ENV`.');
    } else if (/PreBuildCleanup|TimestamperBuildWrapper|AnsiColorBuildWrapper|MaskPasswordsBuildWrapper|BuildUser|ColorizerWrapper/.test(wn)) { /* implicit on hosted runners */ }
    else if (wn === 'NodeJSBuildWrapper') { const v = (text(w, 'nodeJSInstallationName').match(/\d+(\.\d+)*/) || ['lts/*'])[0]; steps.push({ name: 'Set up Node.js', uses: 'actions/setup-node@v4', with: { 'node-version': v } }); }
    else if (/SSHAgentBuildWrapper/.test(wn)) { const id = findAll(w, (c) => c.name === 'string').map((c) => c.text.trim())[0]; if (id) { sec(id); steps.push({ name: 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${secretName(id)} }}` } }); } }
    else if (/ConfigFileBuildWrapper/.test(wn)) noteOnce('Config File Provider: commit the config file or write it from a secret in a `run` step.');
    else if (/Xvfb/.test(wn)) noteOnce('Xvfb wrapper: on ubuntu runners use `xvfb-run` around the command that needs a display.');
    else noteOnce(`Build wrapper \`${wn}\` dropped.`);
  }
  Object.assign(env, wrapperEnv);

  // ---- builders
  const convertBuilders = (container) => {
    for (const b of children(container)) {
      const bn = short(b.name);
      plugins.add(bn);
      switch (bn) {
        case 'Shell': steps.push({ name: firstLine(text(b, 'command')), run: dedent(text(b, 'command')) }); break;
        case 'BatchFile': steps.push({ name: firstLine(text(b, 'command')), shell: 'cmd', run: dedent(text(b, 'command')) }); break;
        case 'PowerShell': steps.push({ name: firstLine(text(b, 'command')), shell: 'pwsh', run: dedent(text(b, 'command')) }); break;
        case 'Maven': { const targets = text(b, 'targets'); const pom = text(b, 'pom'); const props = text(b, 'properties'); const cmd = ['mvn -B -ntp', pom ? `-f ${pom}` : '', props ? props.split('\n').filter(Boolean).map((p) => `-D${p.trim()}`).join(' ') : '', targets].filter(Boolean).join(' '); ensureJava(); steps.push({ name: `Maven ${targets}`, run: cmd }); break; }
        case 'Gradle': { const tasks = text(b, 'tasks'); const useWrapper = text(b, 'useWrapper') === 'true'; const sw = text(b, 'switches'); ensureJava(); steps.push({ name: `Gradle ${tasks}`, run: `${useWrapper ? './gradlew' : 'gradle'} ${sw} ${tasks}`.replace(/\s+/g, ' ').trim() }); break; }
        case 'Ant': { ensureJava(); steps.push({ name: `Ant ${text(b, 'targets')}`, run: `ant ${text(b, 'targets')}`.trim() }); break; }
        case 'TriggerBuilder': case 'BuildTrigger': { const projects = findAll(b, (c) => c.name === 'projects').map((c) => c.text.trim()).join(','); noteOnce(`Downstream build of \`${projects}\` became \`gh workflow run\`; the target needs \`workflow_dispatch\`.`); for (const p of projects.split(',').map((s) => s.trim()).filter(Boolean)) steps.push({ name: `Trigger ${p}`, run: `gh workflow run ${JSON.stringify(p + '.yml')}`, env: { GH_TOKEN: '${{ github.token }}' } }); break; }
        case 'CopyArtifact': { const project = text(b, 'project'); const filter = text(b, 'filter'); noteOnce(`CopyArtifact from \`${project}\`: use \`actions/download-artifact\` with \`run-id\` + \`github-token\`, or \`dawidd6/action-download-artifact\`.`); steps.push({ name: `Copy artifacts from ${project}`, uses: 'dawidd6/action-download-artifact@v6', with: { workflow: `${project}.yml`, path: text(b, 'target') || '.', name: filter || undefined } }); break; }
        case 'ConditionalBuilder': case 'SingleConditionalBuilder': { noteOnce('Conditional build step: condition was dropped; add an `if:` to the generated step.'); const inner = child(b, 'buildStep') || child(b, 'conditionalbuilders'); if (inner) convertBuilders(inner.name === 'buildStep' ? { children: [inner] } : inner); break; }
        case 'DockerBuilderControl': case 'DockerBuildAndPublish': noteOnce('Docker build step plugin: rewrite as `docker build`/`docker push` run steps (or docker/build-push-action).'); steps.push(todo('Docker plugin build step', bn)); break;
        case 'SonarRunnerBuilder': steps.push({ name: 'SonarQube scan', uses: 'SonarSource/sonarqube-scan-action@v5', env: { SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}', SONAR_HOST_URL: '${{ secrets.SONAR_HOST_URL }}' } }); secrets.add('SONAR_TOKEN'); secrets.add('SONAR_HOST_URL'); break;
        case 'Python': case 'PythonBuilder': steps.push({ name: 'Python script', shell: 'python', run: dedent(text(b, 'command')) }); break;
        case 'SystemGroovy': case 'Groovy': noteOnce('Groovy build step: rewrite as a shell or script step; system Groovy has no equivalent.'); steps.push(todo('Groovy build step', bn)); break;
        case 'EnvInjectBuilder': { const content = text(child(b, 'info'), 'propertiesContent'); const lines = content.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_]\w*=/.test(l)); if (lines.length) steps.push({ name: 'Set environment', run: lines.map((l) => `echo ${JSON.stringify(l)} >> "$GITHUB_ENV"`).join('\n') }); break; }
        case 'MsBuildBuilder': steps.push({ name: 'Set up MSBuild', uses: 'microsoft/setup-msbuild@v2' }, { name: 'MSBuild', run: `msbuild ${text(b, 'msBuildFile')} ${text(b, 'cmdLineArgs')}`.trim() }); break;
        case 'NodeJSCommandInterpreter': steps.push({ name: 'Node script', run: `node <<'EOF'\n${dedent(text(b, 'command'))}\nEOF` }); break;
        default: noteOnce(`Build step \`${bn}\` (plugin) has no mapping; rewrite it.`); steps.push(todo(`Build step ${bn}`, bn));
      }
    }
  };
  let javaDone = false;
  const ensureJava = () => { if (javaDone) return; javaDone = true; const jdk = text(root, 'jdk'); const v = (jdk.match(/\d+/) || ['17'])[0]; steps.splice(steps.findIndex((s) => s.uses !== 'actions/checkout@v4') === -1 ? steps.length : Math.max(1, steps.findIndex((s) => s.uses !== 'actions/checkout@v4')), 0, { name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': v, cache: 'maven' } }); };
  const todo = (title, raw) => ({ name: `TODO: ${title}`, run: `# TODO: ${title} (${raw})\necho "TODO: unconverted Jenkins step" && exit 1` });
  const firstLine = (s) => { const l = s.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))[0] || 'Run'; return l.length > 60 ? l.slice(0, 57) + '…' : l; };

  if (type === 'maven') {
    ensureJava();
    const goals = text(root, 'goals') || 'clean install';
    const pom = text(root, 'rootPOM');
    steps.push({ name: `Maven ${goals}`, run: `mvn -B -ntp ${pom ? `-f ${pom} ` : ''}${goals}` });
    const pre = child(root, 'prebuilders'); if (pre) { const tmp = steps.length; convertBuilders(pre); const moved = steps.splice(tmp); steps.splice(steps.length - 1, 0, ...moved); }
    const post = child(root, 'postbuilders'); if (post) convertBuilders(post);
    noteOnce('Maven project type: the "Maven project" job ran goals on each module; the workflow runs them from the root POM.');
  } else {
    convertBuilders(child(root, 'builders'));
  }

  // ---- publishers
  const postSteps = [];
  for (const p of children(child(root, 'publishers'))) {
    const pn = short(p.name);
    plugins.add(pn);
    switch (pn) {
      case 'ArtifactArchiver': postSteps.push({ name: 'Upload artifacts', uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: 'artifacts', path: text(p, 'artifacts').split(',').map((s) => s.trim()).join('\n') + (text(p, 'excludes') ? '\n' + text(p, 'excludes').split(',').map((s) => '!' + s.trim()).join('\n') : ''), 'if-no-files-found': text(p, 'allowEmptyArchive') === 'true' ? 'ignore' : 'warn' } }); break;
      case 'JUnitResultArchiver': postSteps.push({ name: 'Publish test results', uses: 'mikepenz/action-junit-report@v5', if: 'always()', with: { report_paths: text(p, 'testResults') } }); noteOnce('`junit` publisher became `mikepenz/action-junit-report`; it needs `permissions: checks: write`.'); break;
      case 'Mailer': case 'ExtendedEmailPublisher': noteOnce(`\`${pn}\` dropped: GitHub notifies the committer on failure; use \`dawidd6/action-send-mail\` for custom mail.`); break;
      case 'BuildTrigger': case 'BuildPipelineTrigger': { const projects = text(p, 'childProjects') || text(p, 'downstreamProjectNames'); noteOnce(`Downstream trigger of \`${projects}\`: use \`workflow_run\` in the downstream workflow, or \`gh workflow run\`.`); break; }
      case 'Fingerprinter': case 'JavadocArchiver': case 'WsCleanup': case 'FlowDownStream': break;
      case 'HtmlPublisher': { const dir = findAll(p, (c) => c.name === 'reportDir').map((c) => c.text.trim())[0] || '.'; postSteps.push({ name: 'Upload HTML report', uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: 'html-report', path: dir } }); break; }
      case 'SlackNotifier': noteOnce('Slack notifier dropped; use `slackapi/slack-github-action` with a webhook secret.'); break;
      case 'GitPublisher': noteOnce('Git publisher (push tags/branches): add a `run: git push` step with `contents: write` permission.'); break;
      case 'CoberturaPublisher': case 'JacocoPublisher': noteOnce(`\`${pn}\`: upload the coverage report as an artifact or use codecov/codecov-action.`); break;
      case 'CheckStylePublisher': case 'WarningsPublisher': case 'IssuesRecorder': noteOnce(`\`${pn}\` (Warnings NG): annotate with a problem matcher or upload the report as an artifact.`); break;
      case 'ArchiveArtifacts': break;
      default: noteOnce(`Publisher \`${pn}\` dropped (no mapping).`);
    }
  }

  // ---- matrix axes
  let strategy = null;
  const jobEnv = {};
  if (type === 'matrix') {
    const m = {};
    for (const ax of children(child(root, 'axes'))) {
      const an = text(ax, 'name'); const vals = children(child(ax, 'values'), 'string').map((s) => s.text.trim());
      if (short(ax.name) === 'LabelAxis') { m.os = vals.map((v) => labelToRunsOn(v, notes)).map((v) => (Array.isArray(v) ? v.join(',') : v)); noteOnce('Label axis became an `os` matrix dimension on `runs-on`.'); }
      else if (short(ax.name) === 'JDKAxis') { m.java = vals.map((v) => (v.match(/\d+/) || ['17'])[0]); }
      else { m[an] = vals; }
    }
    if (Object.keys(m).length) { strategy = { matrix: m }; for (const k of Object.keys(m)) if (k !== 'os') jobEnv[k] = `\${{ matrix.${k} }}`; }
    if (text(root, 'combinationFilter')) noteOnce(`Matrix combination filter \`${text(root, 'combinationFilter')}\` must become \`matrix.exclude\` entries.`);
  }

  if (strategy && strategy.matrix.os && strategy.matrix.os.length > 1) {
    for (const st of steps) {
      if (st.shell === 'cmd' || st.shell === 'pwsh') st.if = "runner.os == 'Windows'";
      else if (st.run !== undefined && !st.shell) st.if = "runner.os != 'Windows'";
    }
    noteOnce('Shell and batch steps were given `runner.os` conditions so each runs only on its platform.');
  }
  // ---- assemble
  wf.on = on;
  if (Object.keys(env).length) wf.env = env;
  if (concurrency) wf.concurrency = concurrency;
  const job = { 'runs-on': strategy && strategy.matrix.os ? '${{ matrix.os }}' : labelToRunsOn(text(root, 'assignedNode'), notes) };
  if (strategy) job.strategy = strategy;
  if (timeoutMinutes) job['timeout-minutes'] = timeoutMinutes;
  if (Object.keys(jobEnv).length) job.env = jobEnv;
  if (strategy && strategy.matrix.java) { steps.unshift({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': '${{ matrix.java }}' } }); }
  const allSteps = [...steps, ...postSteps];
  if (!allSteps.length) allSteps.push({ run: 'echo "This job had no build steps"' });
  job.steps = allSteps;
  wf.jobs = { build: job };
  if (secrets.size) notes.push(`Create these repository secrets: ${[...secrets].join(', ')}.`);
  if (text(root, 'disabled') === 'true') notes.unshift('This job is disabled in Jenkins; consider not migrating it.');
  const ordered = {}; for (const k of ['name', 'on', 'env', 'concurrency', 'jobs']) if (wf[k] !== undefined) ordered[k] = wf[k];
  return { yaml: toYaml(ordered).join('\n') + '\n', notes, secrets: [...secrets], plugins: [...plugins], type, repo, disabled: text(root, 'disabled') === 'true', description: text(root, 'description'), skipCheckout };
}

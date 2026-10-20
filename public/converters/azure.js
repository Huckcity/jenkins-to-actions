// Azure Pipelines (azure-pipelines.yml) -> GitHub Actions
import { parse as parseYaml } from '../vendor/yaml.js';
import { makeCtx, slug, asList, str, script, firstLine, finish, orderJob, todoStep } from './common.js';

const PREDEF = {
  'Build.SourceBranchName': '${{ github.ref_name }}', 'Build.SourceBranch': '${{ github.ref }}', 'Build.SourceVersion': '${{ github.sha }}', 'Build.BuildId': '${{ github.run_id }}', 'Build.BuildNumber': '${{ github.run_number }}', 'Build.BuildUri': '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
  'Build.Repository.Name': '${{ github.repository }}', 'Build.Repository.Uri': '${{ github.server_url }}/${{ github.repository }}', 'Build.SourcesDirectory': '${{ github.workspace }}', 'Build.Repository.LocalPath': '${{ github.workspace }}', 'System.DefaultWorkingDirectory': '${{ github.workspace }}', 'Build.ArtifactStagingDirectory': '${{ github.workspace }}/_artifacts', 'Build.StagingDirectory': '${{ github.workspace }}/_artifacts', 'Build.BinariesDirectory': '${{ github.workspace }}/_binaries', 'Agent.TempDirectory': '${{ runner.temp }}', 'Agent.BuildDirectory': '${{ github.workspace }}/..', 'Agent.ToolsDirectory': '${{ runner.tool_cache }}', 'Agent.OS': '${{ runner.os }}', 'Agent.Name': '${{ runner.name }}',
  'Build.Reason': '${{ github.event_name }}', 'Build.RequestedFor': '${{ github.actor }}', 'Build.RequestedForEmail': '', 'Build.DefinitionName': '${{ github.workflow }}', 'Build.SourceVersionMessage': '${{ github.event.head_commit.message }}', 'System.PullRequest.PullRequestNumber': '${{ github.event.pull_request.number }}', 'System.PullRequest.PullRequestId': '${{ github.event.pull_request.number }}', 'System.PullRequest.SourceBranch': '${{ github.head_ref }}', 'System.PullRequest.TargetBranch': '${{ github.base_ref }}', 'System.TeamProject': '${{ github.repository_owner }}', 'System.JobName': '${{ github.job }}', 'System.StageName': '', 'Pipeline.Workspace': '${{ github.workspace }}/_pipeline', 'System.AccessToken': '${{ secrets.GITHUB_TOKEN }}', 'Build.Repository.Provider': 'GitHub',
};

function mapMacros(s, ctx, { inShell = false } = {}) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\$\{\{\s*parameters\.([A-Za-z_][\w]*)\s*\}\}/g, '${{ inputs.$1 }}')
    .replace(/\$\{\{\s*variables\.([A-Za-z_][\w.]*)\s*\}\}/g, (m, v) => PREDEF[v] || `\${{ env.${v.replace(/\./g, '_')} }}`)
    .replace(/\$\{\{\s*variables\['([^']+)'\]\s*\}\}/g, (m, v) => PREDEF[v] || `\${{ env.${v.replace(/\./g, '_')} }}`)
    .replace(/\$\[\s*([^\]]+)\]/g, (m, e) => { ctx.note(`Runtime expression \`${m}\` left for manual translation.`); return m; })
    .replace(/\$\(([A-Za-z_][\w.]*)\)/g, (m, v) => {
      if (PREDEF[v] !== undefined) { if (v === 'Build.ArtifactStagingDirectory' || v === 'Build.StagingDirectory') ctx.note('`$(Build.ArtifactStagingDirectory)` became `${{ github.workspace }}/_artifacts`; create it with `mkdir -p` before use (and add `_artifacts/` to .gitignore if steps commit).'); return PREDEF[v]; }
      if (/^(Build|System|Agent|Pipeline)\./.test(v)) { ctx.note(`Predefined variable \`$(${v})\` has no mapping; translated to env.`); }
      return `\${{ env.${v.replace(/\./g, '_')} }}`;
    });
}

// Azure condition expressions -> GitHub expression
function cond(expr, ctx) {
  if (expr === undefined || expr === null) return null;
  const s = mapMacros(String(expr).trim(), ctx);
  let i = 0;
  const peek = () => s[i];
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const ident = () => { const st = i; while (i < s.length && /[A-Za-z0-9_.]/.test(s[i])) i++; return s.slice(st, i); };
  const value = () => {
    ws();
    if (peek() === "'") { let j = i + 1; let out = ''; while (j < s.length && !(s[j] === "'" && s[j + 1] !== "'")) { out += s[j] === "'" ? "'" : s[j]; j += s[j] === "'" ? 2 : 1; } i = j + 1; const ex = /^\$\{\{\s*(.+?)\s*\}\}$/.exec(out); if (ex) return ex[1]; return `'${out.replace(/'/g, "''")}'`; }
    if (s.startsWith('variables[', i)) { i += 'variables['.length; const v = value(); ws(); if (peek() === ']') i++; const name = v.replace(/^'|'$/g, ''); return PREDEF[name] ? PREDEF[name].replace(/^\$\{\{\s*|\s*\}\}$/g, '') : `env.${name.replace(/\./g, '_')}`; }
    if (s.startsWith('variables.', i)) { i += 'variables.'.length; const name = ident(); return PREDEF[name] ? PREDEF[name].replace(/^\$\{\{\s*|\s*\}\}$/g, '') : `env.${name.replace(/\./g, '_')}`; }
    if (s.startsWith('parameters.', i)) { i += 'parameters.'.length; return `inputs.${ident()}`; }
    if (s.startsWith('parameters[', i)) { i += 'parameters['.length; const v = value(); ws(); if (peek() === ']') i++; return `inputs.${v.replace(/^'|'$/g, '')}`; }
    if (s.startsWith('dependencies.', i)) { i += 'dependencies.'.length; const rest = ident(); ctx.note(`Condition on \`dependencies.${rest}\`; translate to \`needs.<job>.result\` or \`needs.<job>.outputs\`.`); return `needs.${rest.split('.')[0]}.result`; }
    const name = ident();
    ws();
    if (peek() === '(') {
      i++; const args = []; ws();
      while (i < s.length && peek() !== ')') { args.push(value()); ws(); if (peek() === ',') { i++; ws(); } }
      i++;
      switch (name.toLowerCase()) {
        case 'succeeded': return 'success()';
        case 'failed': return 'failure()';
        case 'always': return 'always()';
        case 'succeededorfailed': return 'always()';
        case 'canceled': return 'cancelled()';
        case 'and': return args.map((a) => `(${a})`).join(' && ');
        case 'or': return args.map((a) => `(${a})`).join(' || ');
        case 'not': return `!(${args[0]})`;
        case 'eq': return `${args[0]} == ${args[1]}`;
        case 'ne': return `${args[0]} != ${args[1]}`;
        case 'startswith': return `startsWith(${args[0]}, ${args[1]})`;
        case 'endswith': return `endsWith(${args[0]}, ${args[1]})`;
        case 'contains': return `contains(${args[0]}, ${args[1]})`;
        case 'in': return args.slice(1).map((a) => `${args[0]} == ${a}`).join(' || ');
        case 'notin': return args.slice(1).map((a) => `${args[0]} != ${a}`).join(' && ');
        case 'ge': return `${args[0]} >= ${args[1]}`; case 'gt': return `${args[0]} > ${args[1]}`; case 'le': return `${args[0]} <= ${args[1]}`; case 'lt': return `${args[0]} < ${args[1]}`;
        case 'containsvalue': return `contains(${args[0]}, ${args[1]})`;
        default: ctx.note(`Condition function \`${name}()\` not translated.`); return `true /* TODO: ${name}(${args.join(', ')}) */`;
      }
    }
    if (name === 'true' || name === 'false') return name;
    if (/^\d+$/.test(name)) return name;
    return name ? `'${name}'` : "''";
  };
  try { const r = value(); return r.replace(/== 'true'/g, '== true').replace(/== 'false'/g, '== false'); } catch { ctx.note(`Condition \`${s}\` could not be parsed.`); return `true /* TODO: ${s.replace(/\*\//g, '* /')} */`; }
}

function poolToRunner(pool, ctx) {
  if (!pool) return null;
  if (typeof pool === 'string') { ctx.note(`Agent pool \`${pool}\` mapped to \`[self-hosted]\`; pick a hosted runner if that pool was Microsoft-hosted.`); return ['self-hosted', pool]; }
  if (pool.vmImage) {
    const v = String(pool.vmImage).toLowerCase();
    if (/^ubuntu-latest|^windows-latest|^macos-latest/.test(v)) return v;
    if (/^ubuntu-\d/.test(v)) return v; if (/^windows-(\d{4})/.test(v)) return v; if (/^macos-(\d+)/.test(v)) return v;
    if (/win/.test(v)) return 'windows-latest'; if (/mac/.test(v)) return 'macos-latest'; return 'ubuntu-latest';
  }
  if (pool.name) { const d = asList(pool.demands).map(String).map((x) => x.split(/\s+-?equals\s+/)[0]); ctx.note(`Agent pool \`${pool.name}\` mapped to \`[self-hosted, …]\`.`); return ['self-hosted', ...d.filter(Boolean)]; }
  return null;
}

function stepsFrom(list, ctx, scope) {
  const out = [];
  for (const st of asList(list)) {
    if (!st || typeof st !== 'object') continue;
    const name = st.displayName ? mapMacros(String(st.displayName), ctx) : undefined;
    const common = (step) => {
      if (name) step.name = name;
      if (st.condition !== undefined) step.if = cond(st.condition, ctx);
      if (st.continueOnError) step['continue-on-error'] = true;
      if (st.env) step.env = Object.fromEntries(Object.entries(st.env).map(([k, v]) => [k, mapMacros(str(v), ctx)]));
      if (st.workingDirectory && step.run !== undefined) step['working-directory'] = mapMacros(String(st.workingDirectory), ctx);
      if (st.timeoutInMinutes) step['timeout-minutes'] = Number(st.timeoutInMinutes);
      if (st.enabled === false) step.if = 'false';
      return step;
    };
    const run = (body, shell) => { const s = mapMacros(script(body), ctx, { inShell: true }); const step = { name: name || firstLine(s), run: s }; if (shell) step.shell = shell; return common(step); };
    if (st.script !== undefined) { out.push(run(st.script, scope.windows ? 'cmd' : undefined)); continue; }
    if (st.bash !== undefined) { out.push(run(st.bash, 'bash')); continue; }
    if (st.pwsh !== undefined) { out.push(run(st.pwsh, 'pwsh')); continue; }
    if (st.powershell !== undefined) { out.push(run(st.powershell, 'powershell')); continue; }
    if (st.checkout !== undefined) {
      if (st.checkout === 'none') { scope.noCheckout = true; continue; }
      const step = { name: name || 'Checkout', uses: 'actions/checkout@v4' };
      const w = {};
      if (st.submodules) w.submodules = st.submodules === 'recursive' ? 'recursive' : true;
      if (st.fetchDepth !== undefined) w['fetch-depth'] = Number(st.fetchDepth);
      if (st.lfs) w.lfs = true;
      if (st.persistCredentials === false) w['persist-credentials'] = false;
      if (st.checkout !== 'self') { ctx.note(`\`checkout: ${st.checkout}\` refers to a repository resource; set \`repository:\` on the checkout step.`); w.repository = `TODO-${st.checkout}`; }
      if (Object.keys(w).length) step.with = w;
      scope.checkedOut = true;
      out.push(common(step)); continue;
    }
    if (st.template !== undefined) { ctx.note(`Step template \`${st.template}\` was not resolved; inline its steps or turn it into a composite action.`); out.push(common(todoStep(`Step template ${st.template}`, JSON.stringify(st.parameters || {}), ctx))); continue; }
    if (st.download !== undefined) { const art = st.artifact ? String(st.artifact) : undefined; out.push(common({ name: name || 'Download artifacts', uses: 'actions/download-artifact@v4', with: { name: art, path: st.path ? mapMacros(String(st.path), ctx) : art ? `\${{ github.workspace }}/_pipeline/${art}` : '${{ github.workspace }}/_pipeline' } })); if (st.download !== 'current') ctx.note(`\`download: ${st.download}\` pulls from another pipeline; use \`dawidd6/action-download-artifact\`.`); continue; }
    if (st.publish !== undefined) { out.push(common({ name: name || 'Upload artifact', uses: 'actions/upload-artifact@v4', with: { name: st.artifact ? String(st.artifact) : 'drop', path: mapMacros(String(st.publish), ctx) } })); continue; }
    if (st.task !== undefined) { out.push(...taskSteps(st, ctx, common, name, scope)); continue; }
    if (st.reviewApp !== undefined) continue;
    out.push(common(todoStep(`Step ${Object.keys(st)[0]}`, JSON.stringify(st).slice(0, 300), ctx)));
  }
  return out;
}

function taskSteps(st, ctx, common, name, scope) {
  const [task, ver] = String(st.task).split('@');
  const inp = st.inputs || {};
  const m = (v) => mapMacros(str(v), ctx);
  const run = (cmd, extra = {}) => common({ name: name || firstLine(cmd), run: cmd, ...extra });
  switch (task) {
    case 'NodeTool': case 'UseNode': return [common({ name: name || 'Set up Node.js', uses: 'actions/setup-node@v4', with: { 'node-version': m(inp.versionSpec || inp.version || 'lts/*') } })];
    case 'UsePythonVersion': return [common({ name: name || 'Set up Python', uses: 'actions/setup-python@v5', with: { 'python-version': m(inp.versionSpec || '3.x'), architecture: inp.architecture ? String(inp.architecture) : undefined } })];
    case 'UseDotNet': case 'DotNetCoreInstaller': return [common({ name: name || 'Set up .NET', uses: 'actions/setup-dotnet@v4', with: { 'dotnet-version': m(inp.version || inp.versionSpec || '8.x') } })];
    case 'JavaToolInstaller': return [common({ name: name || 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': String(inp.versionSpec || '17') } })];
    case 'GoTool': return [common({ name: name || 'Set up Go', uses: 'actions/setup-go@v5', with: { 'go-version': m(inp.version || 'stable') } })];
    case 'UseRubyVersion': return [common({ name: name || 'Set up Ruby', uses: 'ruby/setup-ruby@v1', with: { 'ruby-version': m(inp.versionSpec || '3.3') } })];
    case 'Npm': { const cmd = inp.command === 'custom' ? `npm ${m(inp.customCommand || '')}` : `npm ${inp.command || 'install'}`; const step = run(cmd); if (inp.workingDir) step['working-directory'] = m(inp.workingDir); return [step]; }
    case 'DotNetCoreCLI': { const c = inp.command || 'build'; let cmd; if (c === 'custom') cmd = `dotnet ${m(inp.custom)} ${m(inp.arguments || '')}`.trim(); else { const proj = inp.projects ? m(inp.projects) : ''; cmd = `dotnet ${c} ${proj} ${m(inp.arguments || '')}`.replace(/\s+/g, ' ').trim(); if (c === 'test' && inp.publishTestResults !== false) ctx.note('DotNetCoreCLI test: add `--logger trx` and a test-report action if you need results in the UI.'); if (c === 'push' && inp.nuGetFeedType) ctx.note('dotnet nuget push: set the feed URL and an API key secret by hand.'); } const step = run(cmd); if (inp.workingDirectory) step['working-directory'] = m(inp.workingDirectory); if (/\*/.test(cmd) && c !== 'custom') ctx.note(`DotNetCoreCLI with a glob (\`${inp.projects}\`): dotnet does not expand globs; loop over the files or name the solution.`); return [step]; }
    case 'Maven': { const cmd = `mvn -B ${inp.options ? m(inp.options) + ' ' : ''}${inp.mavenPomFile ? `-f ${m(inp.mavenPomFile)} ` : ''}${m(inp.goals || 'package')}`.trim(); const steps = []; if (!scope.javaSetup) { scope.javaSetup = true; steps.push({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': String(inp.jdkVersionOption || '1.17').replace(/^1\./, ''), cache: 'maven' } }); } steps.push(run(cmd)); if (inp.publishJUnitResults !== false) ctx.note('Maven task published JUnit results; add `mikepenz/action-junit-report` if you need that.'); return steps; }
    case 'Gradle': { const cmd = `${inp.gradleWrapperFile ? m(inp.gradleWrapperFile) : './gradlew'} ${m(inp.options || '')} ${m(inp.tasks || 'build')}`.replace(/\s+/g, ' ').trim(); const steps = []; if (!scope.javaSetup) { scope.javaSetup = true; steps.push({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': String(inp.jdkVersionOption || '1.17').replace(/^1\./, '') } }, { name: 'Set up Gradle', uses: 'gradle/actions/setup-gradle@v4' }); } steps.push(run(cmd)); return steps; }
    case 'PublishBuildArtifacts': return [common({ name: name || 'Upload artifact', uses: 'actions/upload-artifact@v4', with: { name: m(inp.ArtifactName || inp.artifactName || 'drop'), path: m(inp.PathtoPublish || inp.pathToPublish || '$(Build.ArtifactStagingDirectory)') } })];
    case 'PublishPipelineArtifact': return [common({ name: name || 'Upload artifact', uses: 'actions/upload-artifact@v4', with: { name: m(inp.artifact || inp.artifactName || 'drop'), path: m(inp.targetPath || inp.path || '$(Build.ArtifactStagingDirectory)') } })];
    case 'DownloadBuildArtifacts': case 'DownloadPipelineArtifact': { if ((inp.source || inp.buildType) && /specific/.test(String(inp.source || inp.buildType))) ctx.note('Download from another pipeline: use `dawidd6/action-download-artifact` with the workflow name.'); return [common({ name: name || 'Download artifact', uses: 'actions/download-artifact@v4', with: { name: inp.artifact || inp.artifactName ? m(inp.artifact || inp.artifactName) : undefined, path: m(inp.path || inp.downloadPath || inp.targetPath || '.') } })]; }
    case 'PublishTestResults': { ctx.note('`PublishTestResults` became `mikepenz/action-junit-report` (JUnit only; needs `permissions: checks: write`). For NUnit/VSTest/xUnit formats use `dorny/test-reporter` or `EnricoMi/publish-unit-test-result-action`.'); const pattern = m(inp.testResultsFiles || '**/TEST-*.xml'); const fmt = String(inp.testResultsFormat || inp.testRunner || 'JUnit'); if (/junit/i.test(fmt)) return [common({ name: name || 'Publish test results', uses: 'mikepenz/action-junit-report@v5', if: 'always()', with: { report_paths: inp.searchFolder ? `${m(inp.searchFolder)}/${pattern}` : pattern } })]; return [common({ name: name || 'Publish test results', uses: 'dorny/test-reporter@v1', if: 'always()', with: { name: 'Test results', path: pattern, reporter: /nunit/i.test(fmt) ? 'dotnet-nunit' : /vstest|trx/i.test(fmt) ? 'dotnet-trx' : /xunit/i.test(fmt) ? 'dotnet-trx' : 'java-junit' } })]; }
    case 'PublishCodeCoverageResults': ctx.note('`PublishCodeCoverageResults`: upload the report as an artifact or use `codecov/codecov-action` / `irongut/CodeCoverageSummary`.'); return [common({ name: name || 'Upload coverage', uses: 'actions/upload-artifact@v4', if: 'always()', with: { name: 'coverage', path: m(inp.summaryFileLocation || inp.reportDirectory || 'coverage') } })];
    case 'Cache': { const key = String(inp.key || '').split('|').map((p) => p.trim()).filter(Boolean).map((p) => (/^"?[\w./*-]+"?$/.test(p) && /[./]/.test(p) ? `\${{ hashFiles('${p.replace(/"/g, '')}') }}` : p.replace(/"/g, '').replace(/\$\(Agent\.OS\)/, '${{ runner.os }}'))).join('-'); const steps = [common({ name: name || 'Cache', uses: 'actions/cache@v4', with: { path: m(inp.path || ''), key: mapMacros(key, ctx), 'restore-keys': inp.restoreKeys ? mapMacros(String(inp.restoreKeys).split('\n').map((k) => k.split('|').map((x) => x.trim()).join('-')).join('\n'), ctx) : undefined } })]; if (inp.cacheHitVar) ctx.note(`Cache hit variable \`${inp.cacheHitVar}\`: use \`steps.<id>.outputs.cache-hit\` instead.`); return steps; }
    case 'CmdLine': return [run(mapMacros(script(inp.script || ''), ctx), scope.windows ? { shell: 'cmd' } : {})];
    case 'Bash': case 'ShellScript': { if (inp.targetType === 'filePath' || inp.scriptPath || task === 'ShellScript') { const step = run(`bash ${m(inp.filePath || inp.scriptPath)} ${m(inp.arguments || inp.args || '')}`.trim()); if (inp.workingDirectory || inp.cwd) step['working-directory'] = m(inp.workingDirectory || inp.cwd); return [step]; } const step = run(script(inp.script || ''), { shell: 'bash' }); if (inp.workingDirectory) step['working-directory'] = m(inp.workingDirectory); return [step]; }
    case 'PowerShell': { const pwsh = inp.pwsh !== false && inp.pwsh !== 'false' ? 'pwsh' : 'powershell'; if (inp.targetType === 'filePath' || inp.filePath) { const step = run(`${m(inp.filePath)} ${m(inp.arguments || '')}`.trim(), { shell: pwsh }); return [step]; } const step = run(script(inp.script || ''), { shell: pwsh }); if (inp.workingDirectory) step['working-directory'] = m(inp.workingDirectory); return [step]; }
    case 'CopyFiles': return [run(`mkdir -p ${m(inp.TargetFolder || inp.targetFolder)} && rsync -a${inp.CleanTargetFolder || inp.cleanTargetFolder ? ' --delete' : ''} ${inp.SourceFolder || inp.sourceFolder ? m(inp.SourceFolder || inp.sourceFolder) + '/' : './'} ${m(inp.TargetFolder || inp.targetFolder)}/ ${inp.Contents || inp.contents ? '# TODO: apply the Contents patterns: ' + m(inp.Contents || inp.contents) : ''}`.trim())];
    case 'DeleteFiles': return [run(`rm -rf ${m(inp.Contents || inp.contents || '')}`)];
    case 'ArchiveFiles': { const root = m(inp.rootFolderOrFile || '.'); const out = m(inp.archiveFile || '$(Build.ArtifactStagingDirectory)/archive.zip'); const type = String(inp.archiveType || 'zip'); return [run(type === 'zip' ? `mkdir -p "$(dirname ${out})" && cd ${root} && zip -r ${out} .` : `tar czf ${out} -C ${root} .`)]; }
    case 'ExtractFiles': return [run(`mkdir -p ${m(inp.destinationFolder)} && unzip -o ${m(inp.archiveFilePatterns)} -d ${m(inp.destinationFolder)}`)];
    case 'Docker': { const c = String(inp.command || 'buildAndPush'); const steps = []; if (inp.containerRegistry) { steps.push(common({ name: 'Docker login', uses: 'docker/login-action@v3', with: { registry: `TODO-${inp.containerRegistry}`, username: `\${{ secrets.${ctx.secret(inp.containerRegistry + '_USERNAME')} }}`, password: `\${{ secrets.${ctx.secret(inp.containerRegistry + '_PASSWORD')} }}` } })); ctx.note(`Docker task uses service connection \`${inp.containerRegistry}\`; set the registry host and credentials as secrets.`); } const tags = asList(inp.tags ? String(inp.tags).split('\n') : ['$(Build.BuildId)']).map((t) => `${m(inp.repository || 'app')}:${m(t.trim())}`); if (c === 'build' || c === 'buildAndPush') steps.push(common({ name: name || 'Build and push image', uses: 'docker/build-push-action@v6', with: { context: m(inp.buildContext || '.'), file: inp.Dockerfile || inp.dockerfile ? m(inp.Dockerfile || inp.dockerfile) : undefined, push: c === 'buildAndPush', tags: tags.join('\n'), 'build-args': inp.arguments ? m(inp.arguments) : undefined } })); else if (c === 'push') steps.push(run(tags.map((t) => `docker push ${t}`).join('\n'))); else if (c === 'login' || c === 'logout') { /* handled */ } else steps.push(run(`docker ${c} ${m(inp.arguments || '')}`.trim())); return steps; }
    case 'DockerCompose': return [run(`docker compose -f ${m(inp.dockerComposeFile || 'docker-compose.yml')} ${String(inp.action || 'up').replace(/Run services/i, 'up -d').replace(/Build services/i, 'build').replace(/Run a Docker Compose command/i, m(inp.dockerComposeCommand || ''))}`)];
    case 'AzureCLI': { ctx.note('`AzureCLI` task: add `azure/login@v2` with OIDC (`client-id`, `tenant-id`, `subscription-id` secrets) before running `az` commands.'); scope.azureLogin = true; const body = inp.scriptType && /ps|pscore/.test(String(inp.scriptType)) ? { shell: 'pwsh' } : {}; return [run(inp.inlineScript ? mapMacros(script(inp.inlineScript), ctx) : `bash ${m(inp.scriptPath)} ${m(inp.arguments || '')}`, body)]; }
    case 'AzurePowerShell': ctx.note('`AzurePowerShell`: use `azure/login@v2` with `enable-AzPSSession: true`, then a `pwsh` step.'); return [run(inp.Inline ? mapMacros(script(inp.Inline), ctx) : `pwsh ${m(inp.ScriptPath)}`, { shell: 'pwsh' })];
    case 'AzureWebApp': case 'AzureRmWebAppDeployment': case 'AzureWebAppContainer': ctx.note(`\`${task}\`: became \`azure/webapps-deploy@v3\`; add \`azure/login@v2\` first.`); return [common({ name: name || 'Deploy to Azure Web App', uses: 'azure/webapps-deploy@v3', with: { 'app-name': m(inp.appName || inp.WebAppName || 'TODO'), package: m(inp.package || inp.Package || '.'), 'slot-name': inp.slotName || inp.SlotName ? m(inp.slotName || inp.SlotName) : undefined, images: inp.containers || inp.imageName ? m(inp.containers || inp.imageName) : undefined } })];
    case 'AzureFunctionApp': return [common({ name: name || 'Deploy Azure Function', uses: 'Azure/functions-action@v1', with: { 'app-name': m(inp.appName || 'TODO'), package: m(inp.package || '.') } })];
    case 'AzureStaticWebApp': return [common({ name: name || 'Deploy Static Web App', uses: 'Azure/static-web-apps-deploy@v1', with: { azure_static_web_apps_api_token: `\${{ secrets.${ctx.secret('AZURE_STATIC_WEB_APPS_API_TOKEN')} }}`, app_location: m(inp.app_location || '/'), output_location: m(inp.output_location || ''), action: 'upload' } })];
    case 'AzureKeyVault': ctx.note('`AzureKeyVault` task: move the secrets into GitHub secrets, or use `Azure/get-keyvault-secrets` after `azure/login`.'); return [common(todoStep('Azure Key Vault secrets', m(inp.SecretsFilter || '*'), ctx))];
    case 'NuGetCommand': case 'NuGetToolInstaller': { if (task === 'NuGetToolInstaller') return [common({ name: name || 'Set up NuGet', uses: 'nuget/setup-nuget@v2' })]; const c = String(inp.command || 'restore'); return [run(c === 'restore' ? `dotnet restore ${m(inp.restoreSolution || '')}`.trim() : `nuget ${c} ${m(inp.arguments || '')}`.trim())]; }
    case 'VSBuild': case 'MSBuild': return [common({ name: 'Set up MSBuild', uses: 'microsoft/setup-msbuild@v2' }), run(`msbuild ${m(inp.solution || inp.msbuildFile || '*.sln')} ${inp.configuration ? `/p:Configuration=${m(inp.configuration)}` : ''} ${inp.platform ? `/p:Platform="${m(inp.platform)}"` : ''} ${m(inp.msbuildArgs || inp.msbuildArguments || '')}`.replace(/\s+/g, ' ').trim())];
    case 'VSTest': ctx.note('`VSTest`: became `dotnet test`; adjust the assembly filter.'); return [run(`dotnet test ${m(inp.testAssemblyVer2 ? String(inp.testAssemblyVer2).split('\n')[0] : '')} --logger trx`.replace(/\s+/g, ' ').trim())];
    case 'SonarQubePrepare': case 'SonarCloudPrepare': case 'SonarQubeAnalyze': case 'SonarCloudAnalyze': case 'SonarQubePublish': case 'SonarCloudPublish': if (/Prepare/.test(task)) { ctx.note(`Sonar tasks became \`SonarSource/sonarqube-scan-action\`; set SONAR_TOKEN and SONAR_HOST_URL secrets.`); return [common({ name: name || 'SonarQube scan', uses: 'SonarSource/sonarqube-scan-action@v5', env: { SONAR_TOKEN: `\${{ secrets.${ctx.secret('SONAR_TOKEN')} }}`, SONAR_HOST_URL: `\${{ secrets.${ctx.secret('SONAR_HOST_URL')} }}` } })]; } return [];
    case 'Kubernetes': case 'KubernetesManifest': ctx.note(`\`${task}\`: use \`azure/k8s-set-context\` (or write the kubeconfig from a secret) and \`azure/k8s-deploy\` or \`kubectl apply\`.`); return [common(todoStep(`Kubernetes deploy (${inp.action || inp.command || 'apply'})`, m(inp.manifests || inp.arguments || ''), ctx))];
    case 'HelmDeploy': case 'HelmInstaller': if (task === 'HelmInstaller') return [common({ name: name || 'Set up Helm', uses: 'azure/setup-helm@v4' })]; return [run(`helm ${m(inp.command || 'upgrade')} ${m(inp.releaseName || '')} ${m(inp.chartName || inp.chartPath || '')} ${m(inp.arguments || '')}`.replace(/\s+/g, ' ').trim())];
    case 'TerraformInstaller': case 'TerraformTaskV1': case 'TerraformTaskV2': case 'TerraformTaskV3': case 'TerraformTaskV4': case 'TerraformCLI': if (/Installer/.test(task)) return [common({ name: name || 'Set up Terraform', uses: 'hashicorp/setup-terraform@v3', with: { terraform_version: inp.terraformVersion ? m(inp.terraformVersion) : undefined } })]; ctx.note('Terraform task: backend and provider credentials came from a service connection; supply them as secrets/OIDC.'); return [run(`terraform ${m(inp.command || 'plan')} ${m(inp.commandOptions || '')}`.trim(), inp.workingDirectory ? { 'working-directory': m(inp.workingDirectory) } : {})];
    case 'GitHubRelease': return [common({ name: name || 'Create GitHub release', uses: 'softprops/action-gh-release@v2', with: { files: inp.assets ? m(inp.assets) : undefined, tag_name: inp.tag ? m(inp.tag) : undefined } })];
    case 'InstallSSHKey': ctx.note('`InstallSSHKey`: use `webfactory/ssh-agent` with the private key in a secret.'); return [common({ name: name || 'Start ssh-agent', uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${ctx.secret('SSH_PRIVATE_KEY')} }}` } })];
    case 'DownloadSecureFile': ctx.note(`Secure file \`${inp.secureFile}\`: store it base64-encoded as a secret and decode it in a step.`); return [common(todoStep(`Secure file ${inp.secureFile}`, `echo "$SECURE_FILE_B64" | base64 -d > ${inp.secureFile}`, ctx))];
    case 'Cache@2': return [];
    case 'PythonScript': return [run(inp.scriptSource === 'inline' ? mapMacros(script(inp.script), ctx) : `python ${m(inp.scriptPath)} ${m(inp.arguments || '')}`.trim(), inp.scriptSource === 'inline' ? { shell: 'python' } : {})];
    case 'CondaEnvironment': return [common({ name: name || 'Set up Conda', uses: 'conda-incubator/setup-miniconda@v3', with: { 'environment-file': inp.environmentFile ? m(inp.environmentFile) : undefined } })];
    case 'TwineAuthenticate': case 'PipAuthenticate': case 'NuGetAuthenticate': case 'npmAuthenticate': ctx.note(`\`${task}\`: Azure Artifacts feed auth has no equivalent; put the feed token in a secret and configure the tool directly.`); return [];
    case 'Xcode': return [run(`xcodebuild -scheme ${m(inp.scheme || 'TODO')} -configuration ${m(inp.configuration || 'Release')} ${String(inp.actions || 'build')}`)];
    case 'CocoaPods': return [run('pod install')];
    case 'Gulp': return [run(`npx gulp ${m(inp.targets || '')}`.trim())];
    case 'Grunt': return [run(`npx grunt ${m(inp.targets || '')}`.trim())];
    case 'ManualValidation': ctx.note('`ManualValidation`: use a protected environment with required reviewers on the next job.'); return [];
    case 'DeleteFiles@1': return [];
    default: ctx.note(`Task \`${task}@${ver || ''}\` has no mapping; look for an equivalent action on the Marketplace.`); return [common(todoStep(`Task ${task}@${ver || ''}`, JSON.stringify(inp).slice(0, 400), ctx))];
  }
}

function variablesOf(v, ctx) {
  const env = {};
  if (!v) return env;
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && item.name !== undefined) env[String(item.name).replace(/\./g, '_')] = mapMacros(str(item.value), ctx);
      else if (item && item.group) ctx.note(`Variable group \`${item.group}\` must be recreated as repository/environment variables and secrets.`);
      else if (item && item.template) ctx.note(`Variable template \`${item.template}\` was not resolved.`);
    }
  } else for (const [k, val] of Object.entries(v)) env[k.replace(/\./g, '_')] = mapMacros(str(val && typeof val === 'object' && 'value' in val ? val.value : val), ctx);
  return env;
}

function inputsOf(params, ctx) {
  const inputs = {};
  for (const p of asList(params)) {
    if (!p || !p.name) continue;
    const i = { description: p.displayName ? String(p.displayName) : undefined, required: false };
    const t = String(p.type || 'string');
    if (t === 'boolean') { i.type = 'boolean'; i.default = p.default === true || p.default === 'true'; }
    else if (p.values) { i.type = 'choice'; i.options = asList(p.values).map(str); i.default = p.default !== undefined ? str(p.default) : i.options[0]; }
    else if (t === 'number') { i.type = 'number'; if (p.default !== undefined) i.default = Number(p.default); }
    else if (t === 'object' || t === 'step' || t === 'stepList' || t === 'job' || t === 'jobList' || t === 'stage' || t === 'stageList') { ctx.note(`Parameter \`${p.name}\` of type ${t} cannot be a workflow input; hard-code it or use a reusable workflow.`); continue; }
    else { i.type = 'string'; if (p.default !== undefined) i.default = str(p.default); }
    inputs[p.name] = i;
  }
  return inputs;
}

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src, { merge: true }); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object') return { yaml: '', notes: ['Empty or invalid azure-pipelines.yml'], secrets: [] };
  const wf = { name: ctx.opts.workflowName || (doc.name && !/\$\(/.test(String(doc.name)) ? String(doc.name) : 'CI') };
  if (doc.name && /\$\(/.test(String(doc.name))) wf['run-name'] = mapMacros(String(doc.name), ctx).replace(/\$\([Rr]ev:[^)]*\)/g, '${{ github.run_attempt }}').replace(/\$\(Date:[^)]*\)/g, '').replace(/-\$\{\{ github\.run_attempt \}\}$/, ' #${{ github.run_number }}.${{ github.run_attempt }}');
  // triggers
  const on = {};
  const t = doc.trigger;
  if (t === 'none' || t === null && 'trigger' in doc) { /* no CI trigger */ }
  else if (t === undefined) on.push = { branches: ['**'] };
  else if (Array.isArray(t)) on.push = { branches: t.map(String) };
  else if (typeof t === 'object') {
    const push = {};
    if (t.branches) { if (t.branches.include) push.branches = asList(t.branches.include).map(String); if (t.branches.exclude) push['branches-ignore'] = asList(t.branches.exclude).map(String); }
    if (t.tags) { if (t.tags.include) push.tags = asList(t.tags.include).map(String); if (t.tags.exclude) push['tags-ignore'] = asList(t.tags.exclude).map(String); }
    if (t.paths) { if (t.paths.include) push.paths = asList(t.paths.include).map(String); if (t.paths.exclude) push['paths-ignore'] = asList(t.paths.exclude).map(String); }
    if (push.branches && push['branches-ignore']) { ctx.note('`branches` include and exclude cannot both be used on `on.push`; the excludes were turned into negated patterns.'); push.branches.push(...push['branches-ignore'].map((b) => '!' + b)); delete push['branches-ignore']; }
    if (push.paths && push['paths-ignore']) { push.paths.push(...push['paths-ignore'].map((p) => '!' + p)); delete push['paths-ignore']; }
    if (t.batch) on.push = push; else on.push = push;
    if (t.batch) wf.concurrency = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': false };
  }
  const pr = doc.pr;
  if (pr === 'none') { /* none */ }
  else if (pr === undefined) { on.pull_request = { branches: ['**'] }; }
  else if (Array.isArray(pr)) on.pull_request = { branches: pr.map(String) };
  else if (typeof pr === 'object' && pr) { const p = {}; if (pr.branches && pr.branches.include) p.branches = asList(pr.branches.include).map(String); if (pr.branches && pr.branches.exclude) p.branches = [...(p.branches || ['**']), ...asList(pr.branches.exclude).map((b) => '!' + b)]; if (pr.paths && pr.paths.include) p.paths = asList(pr.paths.include).map(String); if (pr.paths && pr.paths.exclude) p.paths = [...(p.paths || []), ...asList(pr.paths.exclude).map((x) => '!' + x)]; if (pr.drafts === false) p.types = ['opened', 'synchronize', 'reopened', 'ready_for_review']; on.pull_request = p; }
  if (doc.schedules) { on.schedule = asList(doc.schedules).map((s) => ({ cron: String(s.cron) })); ctx.note('Schedules run on the default branch in GitHub; the `branches` filter on each schedule was dropped.'); }
  const inputs = inputsOf(doc.parameters, ctx);
  on.workflow_dispatch = Object.keys(inputs).length ? { inputs } : {};
  wf.on = on;
  if (doc.resources) { if (doc.resources.repositories) ctx.note('`resources.repositories`: check out extra repositories with `actions/checkout` and `repository:`.'); if (doc.resources.pipelines) ctx.note('`resources.pipelines` triggers became a note; use `workflow_run` for pipeline-completion triggers.'); if (doc.resources.containers) ctx.note('`resources.containers`: declare them as `container:`/`services:` on the jobs that use them.'); }
  if (doc.extends) ctx.note(`\`extends: ${doc.extends.template}\`: the template was not resolved; its stages are missing.`);
  const allEnv = variablesOf(doc.variables, ctx);
  const env = {}; const jobLevelEnv = {};
  for (const [k, v0] of Object.entries(allEnv)) { let v = v0; if (/\$\{\{\s*runner\./.test(v)) { v = v.replace(/\$\{\{\s*runner\.temp\s*\}\}/g, '${{ github.workspace }}/_tmp'); ctx.note(`Variable \`${k}\` referenced the runner temp directory, which env blocks cannot use; it points at \`_tmp\` in the workspace instead.`); } if (/\$\{\{\s*(matrix|env|job|steps|strategy)\./.test(v)) jobLevelEnv[k] = v; else env[k] = v; }
  if (Object.keys(env).length) wf.env = env;
  const globalPool = poolToRunner(doc.pool, ctx);
  const jobs = {};
  // normalise stages/jobs/steps
  let stages;
  if (doc.stages) stages = asList(doc.stages);
  else if (doc.jobs) stages = [{ stage: '', jobs: asList(doc.jobs) }];
  else if (doc.steps) stages = [{ stage: '', jobs: [{ job: 'build', steps: doc.steps, pool: doc.pool, container: doc.container, services: doc.services }] }];
  else stages = [];
  const stageIds = new Map();
  const stageJobIds = new Map(); // stage -> [job ids]
  for (const st of stages) {
    if (st.template) { ctx.note(`Stage template \`${st.template}\` was not resolved.`); continue; }
    const sname = String(st.stage || '');
    stageIds.set(sname, sname);
  }
  const multiStage = stages.filter((s) => s.stage).length > 1;
  const order = [];
  for (const st of stages) {
    if (st.template) continue;
    const sname = String(st.stage || '');
    const sdeps = st.dependsOn !== undefined ? asList(st.dependsOn).map(String) : order.slice(-1);
    const stageCond = st.condition !== undefined ? cond(st.condition, ctx) : null;
    const stagePool = poolToRunner(st.pool, ctx) || globalPool;
    const stageEnv = variablesOf(st.variables, ctx);
    const jobIds = [];
    const localIds = new Map();
    const jlist = asList(st.jobs);
    for (const j of jlist) {
      if (j.template) { ctx.note(`Job template \`${j.template}\` was not resolved.`); continue; }
      const isDeploy = j.deployment !== undefined;
      const jname = String(j.job || j.deployment || 'job');
      const id = slug(multiStage && sname ? `${sname}-${jname}` : jname, ctx.jobIds);
      localIds.set(jname, id);
      const job = { name: j.displayName ? mapMacros(String(j.displayName), ctx) : (multiStage && sname ? `${sname} / ${jname}` : jname) };
      const runs = poolToRunner(j.pool, ctx) || stagePool || ctx.opts.runner;
      job['runs-on'] = runs;
      const scope = { windows: /windows/.test(String(runs)) };
      // needs
      let needs = [];
      if (j.dependsOn !== undefined) needs = asList(j.dependsOn).map((d) => localIds.get(String(d)) || slug(multiStage && sname ? `${sname}-${d}` : String(d))).filter(Boolean);
      else if (jlist.indexOf(j) > 0 && j.dependsOn === undefined) { /* jobs in a stage run in parallel by default */ }
      const stageNeeds = sdeps.flatMap((d) => stageJobIds.get(d) || []);
      needs = [...new Set([...stageNeeds, ...needs])];
      if (needs.length) job.needs = needs;
      const conds = [];
      if (stageCond) conds.push(stageCond);
      if (j.condition !== undefined) conds.push(cond(j.condition, ctx));
      if (conds.filter(Boolean).length) job.if = conds.filter(Boolean).map((c) => (conds.length > 1 ? `(${c})` : c)).join(' && ');
      if (isDeploy) { const envName = mapMacros(String(typeof j.environment === 'object' && j.environment ? j.environment.name : j.environment || 'production'), ctx); job.environment = /\$\{\{/.test(envName) ? envName : envName.split('.')[0]; ctx.note(`Deployment job \`${jname}\` became a job with \`environment:\`; approvals and checks move to the GitHub environment settings.`); }
      if (j.timeoutInMinutes) job['timeout-minutes'] = Number(j.timeoutInMinutes);
      if (j.continueOnError) job['continue-on-error'] = true;
      if (j.container) { const c = typeof j.container === 'string' ? { image: j.container } : j.container; job.container = { image: String(c.image || c.alias || c), options: c.options ? String(c.options) : undefined, env: c.env }; }
      if (j.services) { job.services = Object.fromEntries(Object.entries(j.services).map(([k, v]) => [k, { image: String(typeof v === 'string' ? v : v.image) }])); ctx.note('Service containers were declared with image names only; add `ports:` and `env:` as needed.'); }
      const jenv = { ...jobLevelEnv, ...stageEnv, ...variablesOf(j.variables, ctx) };
      if (j.strategy && j.strategy.matrix) {
        const m = j.strategy.matrix;
        if (typeof m === 'string') ctx.note('Matrix from a runtime expression cannot be converted; define the matrix statically.');
        else {
          const rows = Object.entries(m).map(([legName, vars]) => ({ name: legName, ...Object.fromEntries(Object.entries(vars || {}).map(([k, v]) => [k, mapMacros(str(v), ctx)])) }));
          const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'name');
          job.strategy = { matrix: { include: rows }, 'fail-fast': false };
          if (j.strategy.maxParallel) job.strategy['max-parallel'] = Number(j.strategy.maxParallel);
          for (const k of keys) jenv[k] = `\${{ matrix.${k} }}`;
          job.name = `${job.name} (\${{ matrix.name }})`;
          if (keys.some((k) => /image|vmImage|os/i.test(k)) && rows.every((r) => /latest|ubuntu|windows|macos/i.test(str(r.imageName || r.vmImage || r.image || r.os || '')))) { const key = keys.find((k) => /image|vmImage|os/i.test(k)); job['runs-on'] = `\${{ matrix.${key} }}`; delete jenv[key]; }
        }
      }
      if (j.strategy && j.strategy.parallel) { job.strategy = { matrix: { index: Array.from({ length: Number(j.strategy.parallel) }, (_, i) => i) } }; jenv.System_JobPositionInPhase = '${{ matrix.index }}'; jenv.System_TotalJobsInPhase = String(j.strategy.parallel); }
      if (Object.keys(jenv).length) job.env = jenv;
      // steps
      let stepList = j.steps;
      if (isDeploy && j.strategy) { const strat = j.strategy.runOnce || j.strategy.rolling || j.strategy.canary; if (strat) { stepList = [...asList(strat.preDeploy && strat.preDeploy.steps), ...asList(strat.deploy && strat.deploy.steps), ...asList(strat.routeTraffic && strat.routeTraffic.steps), ...asList(strat.postRouteTraffic && strat.postRouteTraffic.steps), ...asList(strat.on && strat.on.success && strat.on.success.steps).map((s) => ({ ...s, condition: 'succeeded()' })), ...asList(strat.on && strat.on.failure && strat.on.failure.steps).map((s) => ({ ...s, condition: 'failed()' }))]; if (j.strategy.rolling || j.strategy.canary) ctx.note('Rolling/canary deployment strategy flattened into sequential steps.'); } }
      const steps = stepsFrom(stepList, ctx, scope);
      if (scope.azureLogin) steps.unshift({ name: 'Azure login', uses: 'azure/login@v2', with: { 'client-id': `\${{ secrets.${ctx.secret('AZURE_CLIENT_ID')} }}`, 'tenant-id': `\${{ secrets.${ctx.secret('AZURE_TENANT_ID')} }}`, 'subscription-id': `\${{ secrets.${ctx.secret('AZURE_SUBSCRIPTION_ID')} }}` } });
      if (!scope.checkedOut && !scope.noCheckout && !isDeploy && ctx.opts.checkout !== false) steps.unshift({ name: 'Checkout', uses: 'actions/checkout@v4' });
      if (isDeploy && !scope.checkedOut && !scope.noCheckout) ctx.note(`Deployment job \`${jname}\` does not check out sources by default on Azure; add \`actions/checkout\` if the steps need the repo.`);
      if (!steps.length) steps.push({ run: 'echo "No steps"' });
      job.steps = steps;
      jobs[id] = orderJob(job);
      jobIds.push(id);
    }
    stageJobIds.set(sname, jobIds);
    order.push(sname);
  }
  wf.jobs = Object.keys(jobs).length ? jobs : { build: { 'runs-on': ctx.opts.runner, steps: [{ run: 'echo "No jobs found"' }] } };
  return finish(wf, ctx);
}

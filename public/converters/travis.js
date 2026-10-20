// Travis CI (.travis.yml) -> GitHub Actions
import { parse as parseYaml } from '../vendor/yaml.js';
import { makeCtx, slug, asList, str, script, firstLine, finish, orderJob, todoStep } from './common.js';

const TRAVIS_VARS = { TRAVIS_BRANCH: '${{ github.ref_name }}', TRAVIS_COMMIT: '${{ github.sha }}', TRAVIS_TAG: '${{ github.ref_name }}', TRAVIS_BUILD_NUMBER: '${{ github.run_number }}', TRAVIS_BUILD_ID: '${{ github.run_id }}', TRAVIS_JOB_NUMBER: '${{ github.run_number }}.${{ github.run_attempt }}', TRAVIS_BUILD_DIR: '${{ github.workspace }}', TRAVIS_REPO_SLUG: '${{ github.repository }}', TRAVIS_EVENT_TYPE: '${{ github.event_name }}', TRAVIS_PULL_REQUEST: "${{ github.event.pull_request.number || 'false' }}", TRAVIS_PULL_REQUEST_BRANCH: '${{ github.head_ref }}', TRAVIS_PULL_REQUEST_SHA: '${{ github.event.pull_request.head.sha }}', TRAVIS_COMMIT_MESSAGE: '${{ github.event.head_commit.message }}', TRAVIS_BUILD_WEB_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}', TRAVIS_OS_NAME: '${{ matrix.os_name }}', TRAVIS_CPU_ARCH: '${{ runner.arch }}', TRAVIS: 'true', CI: 'true', CONTINUOUS_INTEGRATION: 'true' };

const LANG = {
  node_js: { key: 'node_js', setup: (v) => ({ name: 'Set up Node.js', uses: 'actions/setup-node@v4', with: { 'node-version': v } }), install: 'npm ci || npm install', script: 'npm test', matrixKey: 'node' },
  python: { key: 'python', setup: (v) => ({ name: 'Set up Python', uses: 'actions/setup-python@v5', with: { 'python-version': v } }), install: 'pip install -r requirements.txt', script: 'pytest', matrixKey: 'python' },
  ruby: { key: 'rvm', alt: 'ruby', setup: (v) => ({ name: 'Set up Ruby', uses: 'ruby/setup-ruby@v1', with: { 'ruby-version': v, 'bundler-cache': true } }), install: 'bundle install --jobs=3 --retry=3', script: 'bundle exec rake', matrixKey: 'ruby' },
  go: { key: 'go', setup: (v) => ({ name: 'Set up Go', uses: 'actions/setup-go@v5', with: { 'go-version': v } }), install: 'go get -t ./...', script: 'go test ./...', matrixKey: 'go' },
  java: { key: 'jdk', setup: (v) => ({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': String(v).replace(/^(openjdk|oraclejdk)/, '') } }), install: '', script: 'mvn test -B', matrixKey: 'java' },
  php: { key: 'php', setup: (v) => ({ name: 'Set up PHP', uses: 'shivammathur/setup-php@v2', with: { 'php-version': v } }), install: 'composer install', script: 'phpunit', matrixKey: 'php' },
  rust: { key: 'rust', setup: (v) => ({ name: 'Set up Rust', uses: 'dtolnay/rust-toolchain@master', with: { toolchain: v } }), install: '', script: 'cargo build --verbose && cargo test --verbose', matrixKey: 'rust' },
  elixir: { key: 'elixir', setup: (v) => ({ name: 'Set up Elixir', uses: 'erlef/setup-beam@v1', with: { 'elixir-version': v, 'otp-version': '26' } }), install: 'mix deps.get', script: 'mix test', matrixKey: 'elixir' },
  dart: { key: 'dart', setup: (v) => ({ name: 'Set up Dart', uses: 'dart-lang/setup-dart@v1', with: { 'sdk': v } }), install: 'dart pub get', script: 'dart test', matrixKey: 'dart' },
  csharp: { key: 'dotnet', setup: (v) => ({ name: 'Set up .NET', uses: 'actions/setup-dotnet@v4', with: { 'dotnet-version': v } }), install: 'dotnet restore', script: 'dotnet test', matrixKey: 'dotnet' },
  haskell: { key: 'ghc', setup: (v) => ({ name: 'Set up GHC', uses: 'haskell-actions/setup@v2', with: { 'ghc-version': v } }), install: 'cabal update', script: 'cabal test', matrixKey: 'ghc' },
  perl: { key: 'perl', setup: (v) => ({ name: 'Set up Perl', uses: 'shogo82148/actions-setup-perl@v1', with: { 'perl-version': v } }), install: 'cpanm --installdeps .', script: 'prove -l t', matrixKey: 'perl' },
  scala: { key: 'scala', setup: () => ({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': '17' } }), install: '', script: 'sbt ++$TRAVIS_SCALA_VERSION test', matrixKey: 'scala' },
  c: { key: 'compiler', setup: null, install: '', script: './configure && make && make test', matrixKey: 'compiler' },
  cpp: { key: 'compiler', setup: null, install: '', script: './configure && make && make test', matrixKey: 'compiler' },
  generic: { key: null, setup: null, install: '', script: '', matrixKey: null }, minimal: { key: null, setup: null, install: '', script: '', matrixKey: null }, shell: { key: null, setup: null, install: '', script: '', matrixKey: null },
};
const OS_RUNNER = { linux: 'ubuntu-latest', osx: 'macos-latest', windows: 'windows-latest', freebsd: 'ubuntu-latest' };
const SERVICES = { postgresql: { image: 'postgres:16', env: { POSTGRES_HOST_AUTH_METHOD: 'trust' }, ports: ['5432:5432'] }, mysql: { image: 'mysql:8', env: { MYSQL_ALLOW_EMPTY_PASSWORD: 'yes' }, ports: ['3306:3306'] }, redis: { image: 'redis:7', ports: ['6379:6379'] }, 'redis-server': { image: 'redis:7', ports: ['6379:6379'] }, mongodb: { image: 'mongo:7', ports: ['27017:27017'] }, memcached: { image: 'memcached:1', ports: ['11211:11211'] }, rabbitmq: { image: 'rabbitmq:3', ports: ['5672:5672'] }, elasticsearch: { image: 'elasticsearch:8.13.0', env: { 'discovery.type': 'single-node', 'xpack.security.enabled': 'false' }, ports: ['9200:9200'] }, cassandra: { image: 'cassandra:4', ports: ['9042:9042'] }, neo4j: { image: 'neo4j:5', ports: ['7474:7474', '7687:7687'] }, mariadb: { image: 'mariadb:11', env: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: 'yes' }, ports: ['3306:3306'] } };

function parseEnvString(s) { // "A=1 B='x y'" -> {A:'1', B:'x y'}
  const out = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|(\S*))/g;
  let m; while ((m = re.exec(String(s)))) out[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
  return out;
}
function envOf(v) { if (!v) return {}; if (typeof v === 'string') return parseEnvString(v); if (Array.isArray(v)) return Object.assign({}, ...v.map(envOf)); if (typeof v === 'object') { if (v.secure !== undefined) return { __secure: true }; return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, str(x)])); } return {}; }

function travisIf(expr, ctx) {
  const s = String(expr).trim();
  const one = (e) => {
    e = e.trim().replace(/^\((.*)\)$/, '$1');
    let m;
    if ((m = /^branch\s*(=|==|!=)\s*(\S+)$/.exec(e))) return `github.ref_name ${m[1] === '!=' ? '!=' : '=='} '${m[2]}'`;
    if ((m = /^branch\s*=~\s*\/?\^?(.+?)\/?$/.exec(e))) return `startsWith(github.ref_name, '${m[1].replace(/\.\*.*$/, '').replace(/\$$/, '')}')`;
    if ((m = /^branch\s+IN\s*\((.+)\)$/i.exec(e))) return `(${m[1].split(',').map((b) => `github.ref_name == '${b.trim()}'`).join(' || ')})`;
    if (/^tag\s+IS\s+present$/i.test(e)) return "startsWith(github.ref, 'refs/tags/')";
    if (/^tag\s+IS\s+blank$/i.test(e)) return "!startsWith(github.ref, 'refs/tags/')";
    if ((m = /^tag\s*=~\s*\/?\^?(.+?)\/?$/.exec(e))) return `startsWith(github.ref, 'refs/tags/${m[1].replace(/\.\*.*$/, '').replace(/\\/g, '')}')`;
    if ((m = /^type\s*(=|==|!=)\s*(\S+)$/.exec(e))) { const map = { push: 'push', pull_request: 'pull_request', cron: 'schedule', api: 'workflow_dispatch' }; return `github.event_name ${m[1] === '!=' ? '!=' : '=='} '${map[m[2]] || m[2]}'`; }
    if ((m = /^type\s+IN\s*\((.+)\)$/i.exec(e))) return `(${m[1].split(',').map((t) => `github.event_name == '${({ push: 'push', pull_request: 'pull_request', cron: 'schedule', api: 'workflow_dispatch' })[t.trim()] || t.trim()}'`).join(' || ')})`;
    if ((m = /^env\(([A-Z_]+)\)\s*(=|==|!=)\s*(\S+)$/.exec(e))) return `env.${m[1]} ${m[2] === '!=' ? '!=' : '=='} '${m[3].replace(/^["']|["']$/g, '')}'`;
    if ((m = /^(?:env\()?([A-Z_]+)\)?\s+IS\s+present$/i.exec(e))) return `env.${m[1]} != ''`;
    if ((m = /^repo\s*(=|==|!=)\s*(\S+)$/.exec(e))) return `github.repository ${m[1] === '!=' ? '!=' : '=='} '${m[2]}'`;
    if (/^fork\s*=\s*false$/i.test(e)) return 'github.event.pull_request.head.repo.fork != true';
    if (/^fork\s*=\s*true$/i.test(e)) return 'github.event.pull_request.head.repo.fork == true';
    if ((m = /^commit_message\s*=~\s*\/(.+)\/$/.exec(e))) return `contains(github.event.head_commit.message, '${m[1].replace(/[\\^$.*]/g, '')}')`;
    if ((m = /^NOT\s+(.+)$/i.exec(e))) { const r = one(m[1]); return r ? `!(${r})` : null; }
    return null;
  };
  const parts = s.split(/\s+(AND|OR)\s+/i);
  const out = [];
  for (const p of parts) { if (/^(AND|OR)$/i.test(p)) { out.push(p.toUpperCase() === 'AND' ? '&&' : '||'); continue; } const r = one(p); if (!r) { ctx.note(`Travis condition \`${s}\` could not be fully translated.`); return `true /* TODO: ${s.replace(/\*\//g, '* /')} */`; } out.push(parts.length > 1 ? `(${r})` : r); }
  return parts.length > 1 ? `(${out.join(' ')})` : out.join(' ');
}

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src, { merge: true }); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object') return { yaml: '', notes: ['Empty or invalid .travis.yml'], secrets: [] };
  const wf = { name: ctx.opts.workflowName || 'CI' };
  // triggers
  const on = { push: {}, pull_request: {} };
  if (doc.branches) {
    if (doc.branches.only) { const b = asList(doc.branches.only).map((x) => String(x).replace(/^\/\^?|\$?\/$/g, '').replace(/\.\*/g, '*').replace(/\\/g, '')); on.push.branches = b; on.pull_request.branches = b; }
    if (doc.branches.except) { const b = asList(doc.branches.except).map((x) => String(x).replace(/^\/\^?|\$?\/$/g, '').replace(/\.\*/g, '*')); on.push['branches-ignore'] = b; on.pull_request['branches-ignore'] = b; }
  }
  if (!on.push.branches && !on.push['branches-ignore']) { on.push.branches = ['**']; }
  if (on.push.branches) on.push.tags = ['*'];
  on.workflow_dispatch = {};
  if (doc['if']) { const c = travisIf(doc['if'], ctx); ctx.note(`Top-level \`if: ${doc['if']}\` was applied to every job.`); wf.__cond = c; }
  wf.on = on;
  if (doc.notifications) ctx.note('`notifications` dropped; GitHub emails failures to the committer. Use `slackapi/slack-github-action` for Slack.');
  const globalEnv = {};
  const envSpec = doc.env;
  let envMatrix = [];
  let secureSeen = false;
  if (envSpec) {
    if (Array.isArray(envSpec) || typeof envSpec === 'string') envMatrix = asList(envSpec).map(envOf);
    else { Object.assign(globalEnv, envOf(envSpec.global)); envMatrix = asList(envSpec.matrix || envSpec.jobs).map(envOf); }
  }
  for (const e of [globalEnv, ...envMatrix]) if (e.__secure) { secureSeen = true; delete e.__secure; }
  if (secureSeen) ctx.note('Encrypted `secure:` variables cannot be decrypted; recreate each as a repository secret and reference it from `env:`.');
  envMatrix = envMatrix.filter((e) => Object.keys(e).length);

  const language = String(doc.language || 'generic');
  const L = LANG[language] || LANG.generic;
  if (!LANG[language]) ctx.note(`Language \`${language}\` has no setup action mapping.`);
  const versions = L.key ? asList(doc[L.key] !== undefined ? doc[L.key] : doc[L.alt]).map(str) : [];
  const oses = asList(doc.os).map(String);
  const dist = doc.dist ? String(doc.dist) : null;
  const osRunner = (o) => { if (o === 'linux' && dist) { const d = { focal: 'ubuntu-20.04', jammy: 'ubuntu-22.04', noble: 'ubuntu-24.04' }[dist]; if (d) return d; } return OS_RUNNER[o] || 'ubuntu-latest'; };

  // Common step builders
  const stepsFor = (job, ctx2) => {
    const steps = [];
    if (ctx.opts.checkout !== false) { const st = { name: 'Checkout', uses: 'actions/checkout@v4' }; const w = {}; if (doc.git && doc.git.depth !== undefined && doc.git.depth !== false) w['fetch-depth'] = Number(doc.git.depth); if (doc.git && doc.git.submodules === false) { /* default */ } else if (doc.git && doc.git.submodules === true) w.submodules = 'recursive'; if (doc.git && doc.git.depth === false) w['fetch-depth'] = 0; if (doc.git && doc.git.lfs_skip_smudge) { /* ignore */ } if (Object.keys(w).length) st.with = w; steps.push(st); }
    const lang = job.language ? LANG[job.language] || L : L;
    const ver = job.version;
    if (lang.setup && ver !== undefined) steps.push(lang.setup(ver));
    else if (lang.setup && versions.length === 0 && lang.key) { ctx.note(`No \`${lang.key}\` version listed; the setup action uses its default.`); }
    if (job.compiler) steps.push({ name: `Use ${job.compiler}`, run: `echo "CC=${job.compiler}" >> "$GITHUB_ENV"; echo "CXX=${job.compiler === 'gcc' ? 'g++' : job.compiler === 'clang' ? 'clang++' : job.compiler}" >> "$GITHUB_ENV"` });
    // addons
    const addons = { ...(doc.addons || {}), ...(job.addons || {}) };
    if (addons.apt) { const pk = [...asList(addons.apt.packages), ...asList(addons.apt_packages)].map(String); if (addons.apt.sources) ctx.note('`addons.apt.sources` dropped; add the apt repository in a run step if needed.'); if (pk.length) steps.push({ name: 'Install apt packages', if: "runner.os == 'Linux'", run: `sudo apt-get update && sudo apt-get install -y ${pk.join(' ')}` }); }
    if (addons.apt_packages) { const pk = asList(addons.apt_packages).map(String); if (pk.length && !addons.apt) steps.push({ name: 'Install apt packages', if: "runner.os == 'Linux'", run: `sudo apt-get update && sudo apt-get install -y ${pk.join(' ')}` }); }
    if (addons.homebrew) { const pk = asList(addons.homebrew.packages || addons.homebrew).map(String); if (pk.length) steps.push({ name: 'Install Homebrew packages', if: "runner.os == 'macOS'", run: `brew install ${pk.join(' ')}` }); }
    if (addons.snaps) steps.push({ name: 'Install snaps', run: asList(addons.snaps).map((s) => `sudo snap install ${typeof s === 'object' ? `${s.name} ${s.classic ? '--classic' : ''} ${s.channel ? `--channel=${s.channel}` : ''}` : s}`.trim()).join('\n') });
    if (addons.chrome || addons.firefox) ctx.note('Chrome/Firefox addons dropped: both browsers are preinstalled on ubuntu runners.');
    if (addons.sonarcloud) { steps.push({ name: 'SonarCloud scan', uses: 'SonarSource/sonarqube-scan-action@v5', env: { SONAR_TOKEN: `\${{ secrets.${ctx.secret('SONAR_TOKEN')} }}`, SONAR_HOST_URL: 'https://sonarcloud.io' } }); }
    if (addons.ssh_known_hosts) steps.push({ name: 'Add known hosts', run: `mkdir -p ~/.ssh && ssh-keyscan ${asList(addons.ssh_known_hosts).join(' ')} >> ~/.ssh/known_hosts` });
    if (addons.postgresql || addons.mariadb) ctx.note('Database addons: a service container was added; adjust the version and credentials.');
    // cache
    const cache = job.cache !== undefined ? job.cache : doc.cache;
    if (cache) {
      const dirs = []; const presets = [];
      for (const c of asList(cache)) { if (typeof c === 'string') presets.push(c); else if (typeof c === 'object') { for (const d of asList(c.directories)) dirs.push(String(d)); for (const k of ['npm', 'yarn', 'pip', 'bundler', 'cargo', 'ccache', 'cocoapods', 'packages', 'apt']) if (c[k]) presets.push(k); } }
      const preset = { npm: '~/.npm', yarn: '~/.cache/yarn', pip: '~/.cache/pip', bundler: 'vendor/bundle', cargo: '~/.cargo\ntarget', ccache: '~/.ccache', cocoapods: 'Pods', packages: '~/R/Library', apt: '' };
      const paths = [...dirs, ...presets.map((p) => preset[p]).filter(Boolean)];
      if (paths.length) steps.push({ name: 'Cache', uses: 'actions/cache@v4', with: { path: paths.join('\n'), key: `\${{ runner.os }}-${language}-\${{ hashFiles('**/package-lock.json', '**/yarn.lock', '**/Gemfile.lock', '**/requirements*.txt', '**/Cargo.lock', '**/pom.xml', '**/go.sum') }}`, 'restore-keys': `\${{ runner.os }}-${language}-` } });
      if (presets.includes('apt')) ctx.note('`cache: apt` has no equivalent; apt installs are fast on hosted runners.');
    }
    const phases = ['before_install', 'install', 'before_script', 'script', 'after_success', 'after_failure', 'after_script', 'before_deploy'];
    const get = (p) => (job[p] !== undefined ? job[p] : doc[p]);
    for (const p of phases) {
      let body = get(p);
      if (p === 'install' && body === undefined && lang.install) body = lang.install;
      if (p === 'script' && body === undefined && lang.script) { body = lang.script; ctx.note(`No \`script\` given; Travis would run the ${language} default (\`${lang.script}\`), which was emitted.`); }
      if (p === 'install' && (body === true || body === 'skip')) continue;
      if (body === undefined || body === null || body === false) continue;
      const lines = asList(body).map(String);
      if (!lines.length) continue;
      const st = { name: p === 'script' ? firstLine(lines[0]) : p.replace(/_/g, ' '), run: script(lines) };
      if (p === 'after_success') st.if = 'success()'; if (p === 'after_failure') st.if = 'failure()'; if (p === 'after_script') st.if = 'always()';
      if (p === 'before_deploy') { ctx.note('`before_deploy` was kept as a step before the deploy TODO.'); }
      steps.push(st);
    }
    // deploy
    for (const d of asList(job.deploy !== undefined ? job.deploy : doc.deploy)) {
      if (!d) continue;
      const prov = typeof d === 'string' ? d : String(d.provider || '');
      const o = typeof d === 'object' ? d : {};
      const onTags = o.on && (o.on.tags === true); const onBranch = o.on && o.on.branch; const skipCleanup = o.skip_cleanup;
      void skipCleanup;
      const cond = onTags ? "startsWith(github.ref, 'refs/tags/')" : onBranch ? `github.ref == 'refs/heads/${onBranch}'` : "github.ref == 'refs/heads/main'";
      if (o.on && o.on.condition) ctx.note(`Deploy condition \`${o.on.condition}\` must be added to the deploy step \`if:\` by hand.`);
      switch (prov) {
        case 'pages': steps.push({ name: 'Deploy to GitHub Pages', if: cond, uses: 'peaceiris/actions-gh-pages@v4', with: { github_token: '${{ secrets.GITHUB_TOKEN }}', publish_dir: String(o.local_dir || o.local_directory || '.'), publish_branch: o.target_branch ? String(o.target_branch) : undefined } }); ctx.note('Pages deploy needs `permissions: contents: write` (or switch to `actions/deploy-pages`).'); break;
        case 'npm': steps.push({ name: 'Publish to npm', if: cond, run: 'npm publish', env: { NODE_AUTH_TOKEN: `\${{ secrets.${ctx.secret('NPM_TOKEN')} }}` } }); ctx.note('npm deploy: add `registry-url: https://registry.npmjs.org` to setup-node and an NPM_TOKEN secret.'); break;
        case 'releases': steps.push({ name: 'Create GitHub release', if: cond, uses: 'softprops/action-gh-release@v2', with: { files: asList(o.file).map(String).join('\n') || undefined, draft: o.draft ? true : undefined, prerelease: o.prerelease ? true : undefined } }); ctx.note('GitHub Releases deploy needs `permissions: contents: write`.'); break;
        case 'pypi': steps.push({ name: 'Publish to PyPI', if: cond, run: 'pip install build twine && python -m build && twine upload dist/*', env: { TWINE_USERNAME: '__token__', TWINE_PASSWORD: `\${{ secrets.${ctx.secret('PYPI_API_TOKEN')} }}` } }); break;
        case 'rubygems': steps.push({ name: 'Publish gem', if: cond, run: 'gem build *.gemspec && gem push *.gem', env: { GEM_HOST_API_KEY: `\${{ secrets.${ctx.secret('RUBYGEMS_API_KEY')} }}` } }); break;
        case 'heroku': steps.push({ name: 'Deploy to Heroku', if: cond, uses: 'akhileshns/heroku-deploy@v3.13.15', with: { heroku_api_key: `\${{ secrets.${ctx.secret('HEROKU_API_KEY')} }}`, heroku_app_name: String(o.app || 'TODO'), heroku_email: 'TODO' } }); break;
        case 's3': steps.push({ name: 'Configure AWS credentials', if: cond, uses: 'aws-actions/configure-aws-credentials@v4', with: { 'aws-access-key-id': `\${{ secrets.${ctx.secret('AWS_ACCESS_KEY_ID')} }}`, 'aws-secret-access-key': `\${{ secrets.${ctx.secret('AWS_SECRET_ACCESS_KEY')} }}`, 'aws-region': String(o.region || 'us-east-1') } }, { name: 'Upload to S3', if: cond, run: `aws s3 sync ${o.local_dir || o['local-dir'] || '.'} s3://${o.bucket || 'TODO'}/${o.upload_dir || o['upload-dir'] || ''}`.replace(/\/$/, '') }); break;
        case 'script': steps.push({ name: 'Deploy', if: cond, run: String(o.script || 'TODO') }); break;
        case 'firebase': steps.push({ name: 'Deploy to Firebase', if: cond, run: 'npx firebase-tools deploy --non-interactive', env: { FIREBASE_TOKEN: `\${{ secrets.${ctx.secret('FIREBASE_TOKEN')} }}` } }); break;
        case 'cloudfoundry': case 'elasticbeanstalk': case 'lambda': case 'gae': case 'azure_web_apps': case 'codedeploy': case 'surge': case 'netlify': case 'cargo': case 'hackage': case 'bintray': case 'openshift': case 'gcs': default:
          ctx.note(`Deploy provider \`${prov}\` became a TODO; see the Marketplace for an equivalent action.`); steps.push({ ...todoStep(`Deploy provider ${prov}`, JSON.stringify(o).slice(0, 300), ctx), if: cond });
      }
    }
    return steps;
  };

  // Build matrix legs
  const jobsSpec = doc.jobs || doc.matrix || {};
  const includes = asList(jobsSpec.include);
  const excludes = asList(jobsSpec.exclude);
  const allowFail = asList(jobsSpec.allow_failures).map((a) => (typeof a === 'object' ? a : {}));
  const fastFinish = jobsSpec.fast_finish === true;
  const stagesOrder = asList(doc.stages).map((s) => (typeof s === 'object' ? String(s.name) : String(s)));
  const stageConds = Object.fromEntries(asList(doc.stages).filter((s) => typeof s === 'object' && s.if).map((s) => [String(s.name), travisIf(s.if, ctx)]));

  const legs = []; // {os, version, env, name, stage, extra}
  const dims = { os: oses.length ? oses : ['linux'], version: versions.length ? versions : [undefined], env: envMatrix.length ? envMatrix : [{}] };
  const implicit = !(includes.length && !oses.length && !versions.length && !envMatrix.length);
  if (implicit) for (const os of dims.os) for (const v of dims.version) for (const e of dims.env) legs.push({ os, version: v, env: e, stage: 'test' });
  for (const inc of includes) {
    const lang = inc.language ? LANG[inc.language] || L : L;
    const v = lang.key ? (inc[lang.key] !== undefined ? str(asList(inc[lang.key])[0]) : inc[lang.alt] !== undefined ? str(asList(inc[lang.alt])[0]) : undefined) : undefined;
    legs.push({ os: inc.os ? String(asList(inc.os)[0]) : dims.os[0], version: v !== undefined ? v : versions[0], env: envOf(inc.env), name: inc.name, stage: inc.stage ? String(inc.stage) : 'test', if: inc.if ? travisIf(inc.if, ctx) : null, extra: inc, compiler: inc.compiler });
  }
  for (const ex of excludes) { const idx = legs.findIndex((l) => (ex.os === undefined || l.os === ex.os) && (ex[L.key] === undefined || String(l.version) === str(ex[L.key])) && (ex.env === undefined || JSON.stringify(envOf(ex.env)) === JSON.stringify(l.env))); if (idx >= 0) legs.splice(idx, 1); }
  // Group legs by stage, then build jobs: the implicit test matrix becomes one job with strategy.matrix.
  const jobs = {};
  const stageNames = [...new Set([...stagesOrder, ...legs.map((l) => l.stage)])];
  let prevStageIds = [];
  for (const stage of stageNames) {
    const sl = legs.filter((l) => l.stage === stage);
    if (!sl.length) continue;
    const ids = [];
    const implicitLegs = sl.filter((l) => !l.extra);
    const explicitLegs = sl.filter((l) => l.extra);
    const allowFailMatch = (leg) => allowFail.some((a) => Object.entries(a).every(([k, val]) => (k === 'os' ? leg.os === val : k === 'env' ? JSON.stringify(envOf(val)) === JSON.stringify(leg.env) : k === L.key ? String(leg.version) === str(val) : k === 'name' ? leg.name === val : true)));
    if (implicitLegs.length) {
      const id = slug(stageNames.length > 1 ? `${stage}` : 'test', ctx.jobIds);
      const rows = implicitLegs.map((l) => { const r = {}; if (dims.os.length > 1 || oses.length) { r.os = osRunner(l.os); r.os_name = l.os; } if (l.version !== undefined) r[L.matrixKey || 'version'] = l.version; if (Object.keys(l.env).length) Object.assign(r, l.env); if (allowFailMatch(l)) r.experimental = true; return r; });
      const envKeys = [...new Set(implicitLegs.flatMap((l) => Object.keys(l.env)))];
      const job = { name: stage === 'test' ? 'test' : stage };
      const single = rows.length === 1 && !rows[0].os;
      const jenv = { ...globalEnv };
      if (!single) {
        job.strategy = { matrix: {} };
        // Use cartesian form when possible (clean), else include rows
        const cartesianOk = !excludes.length && !allowFail.length && rows.length === dims.os.length * dims.version.length * dims.env.length && envKeys.length <= 1;
        if (cartesianOk) { if (rows[0].os) { job.strategy.matrix.os = [...new Set(rows.map((r) => r.os))]; } if (L.matrixKey && versions.length) job.strategy.matrix[L.matrixKey] = versions; if (envKeys.length === 1) job.strategy.matrix[envKeys[0]] = [...new Set(rows.map((r) => r[envKeys[0]]))]; if (rows[0].os) { job.strategy.matrix.include = [...new Set(rows.map((r) => r.os_name))].map((n) => ({ os: osRunner(n), os_name: n })); } }
        else job.strategy.matrix = { include: rows };
        if (fastFinish === false || allowFail.length) job.strategy['fail-fast'] = false;
        if (rows.some((r) => r.experimental)) { job['continue-on-error'] = '${{ matrix.experimental == true }}'; ctx.note('`allow_failures` legs became `continue-on-error` via a `experimental` matrix flag.'); }
        job['runs-on'] = rows[0].os ? '${{ matrix.os }}' : osRunner(dims.os[0]);
        for (const k of envKeys) jenv[k] = `\${{ matrix.${k} }}`;
        if (rows[0].os_name) jenv.TRAVIS_OS_NAME = '${{ matrix.os_name }}';
        job.name = `${job.name} (${[rows[0].os ? '${{ matrix.os_name }}' : null, L.matrixKey && versions.length ? `\${{ matrix.${L.matrixKey} }}` : null, ...envKeys.map((k) => `\${{ matrix.${k} }}`)].filter(Boolean).join(', ')})`;
      } else { job['runs-on'] = osRunner(implicitLegs[0].os); Object.assign(jenv, implicitLegs[0].env); }
      if (prevStageIds.length) job.needs = prevStageIds;
      if (wf.__cond || stageConds[stage]) job.if = [wf.__cond, stageConds[stage]].filter(Boolean).join(' && ');
      if (Object.keys(jenv).length) job.env = jenv;
      const legModel = { version: single ? implicitLegs[0].version : (versions.length ? `\${{ matrix.${L.matrixKey} }}` : undefined) };
      job.steps = stepsFor(legModel, ctx);
      addServices(job, doc, ctx);
      jobs[id] = orderJob(job); ids.push(id);
    }
    for (const l of explicitLegs) {
      const nm = l.name || `${stage}${l.version !== undefined ? ' ' + l.version : ''}${Object.keys(l.env).length ? ' ' + Object.entries(l.env).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`;
      const id = slug(nm, ctx.jobIds);
      const job = { name: nm, 'runs-on': osRunner(l.os) };
      if (prevStageIds.length) job.needs = prevStageIds;
      const conds = [wf.__cond, stageConds[stage], l.if].filter(Boolean); if (conds.length) job.if = conds.join(' && ');
      if (allowFailMatch(l)) job['continue-on-error'] = true;
      const jenv = { ...globalEnv, ...l.env }; if (Object.keys(jenv).length) job.env = jenv;
      if (oses.length) jenv.TRAVIS_OS_NAME = l.os;
      job.steps = stepsFor({ ...l.extra, version: l.version, language: l.extra.language, compiler: l.compiler }, ctx);
      addServices(job, { ...doc, services: l.extra.services !== undefined ? l.extra.services : doc.services }, ctx);
      jobs[id] = orderJob(job); ids.push(id);
    }
    prevStageIds = ids;
  }
  if (stageNames.length > 1) ctx.note('Build stages became sequential job groups via `needs`.');
  // TRAVIS_* env shim
  const used = new Set();
  for (const j of Object.values(jobs)) for (const s of j.steps) for (const m of String(s.run || '').matchAll(/\$\{?(TRAVIS_[A-Z0-9_]+)\}?/g)) used.add(m[1]);
  const env = {};
  for (const v of used) if (TRAVIS_VARS[v] && !/matrix/.test(TRAVIS_VARS[v])) env[v] = TRAVIS_VARS[v];
  if (used.has('TRAVIS_OS_NAME') && !Object.values(jobs).some((j) => j.env && j.env.TRAVIS_OS_NAME)) env.TRAVIS_OS_NAME = 'linux';
  if (used.has('TRAVIS_TAG')) ctx.note('`TRAVIS_TAG` maps to `github.ref_name`, which is also set for branches; guard with `startsWith(github.ref, \'refs/tags/\')`.');
  if (used.has('TRAVIS_PULL_REQUEST')) ctx.note("`TRAVIS_PULL_REQUEST` is `false` on non-PR builds; the mapping reproduces that with `|| 'false'`.");
  if (Object.keys(env).length) wf.env = env;
  if (doc.sudo !== undefined) { /* ignore */ }
  delete wf.__cond;
  wf.jobs = Object.keys(jobs).length ? jobs : { build: { 'runs-on': ctx.opts.runner, steps: [{ run: 'echo "No jobs"' }] } };
  return finish(wf, ctx);
}

function addServices(job, doc, ctx) {
  if (/matrix\.os|macos|windows/.test(String(job['runs-on']))) { if (asList(doc.services).length) ctx.note('Service containers only work on Linux runners; the services were left off a job that can run on macOS/Windows. Split the matrix if the services are needed.'); return; }
  const list = asList(doc.services).map(String);
  const addons = doc.addons || {};
  if (addons.postgresql) list.push('postgresql'); if (addons.mariadb) list.push('mariadb');
  const sv = {};
  for (const s of list) {
    if (s === 'docker') continue;
    if (s === 'xvfb') { ctx.note('`xvfb` service: run GUI commands under `xvfb-run` on ubuntu runners.'); continue; }
    const def = SERVICES[s];
    if (def) { sv[s.replace(/-server$/, '')] = { image: def.image, env: def.env, ports: def.ports }; if (addons.postgresql && s === 'postgresql') sv[s].image = `postgres:${addons.postgresql}`; }
    else ctx.note(`Service \`${s}\` has no container mapping; add it under \`services:\` by hand.`);
  }
  if (Object.keys(sv).length) { job.services = sv; ctx.note('Travis services became service containers on localhost with the default ports; credentials differ from Travis defaults (check `env`).'); }
}

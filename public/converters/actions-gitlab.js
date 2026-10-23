// GitHub Actions workflow (.github/workflows/*.yml) -> GitLab CI (.gitlab-ci.yml)
// The reverse direction: jobs become jobs, needs become needs (DAG), triggers become workflow rules,
// matrix becomes parallel:matrix, upload-artifact becomes artifacts, actions/cache becomes cache, and the
// common Marketplace actions become the shell commands or GitLab keywords that replace them. Everything that
// has no clean equivalent becomes a TODO that fails loudly, so nothing silently disappears.
import { parse as parseYaml } from '../vendor/yaml.js';
import { toYaml, Comment } from '../emit.js';

const DEFAULT_IMAGE = 'ubuntu:24.04';

// ---------------------------------------------------------------- context

function makeCtx(opts) {
  const notes = [];
  const ctx = {
    opts: { image: DEFAULT_IMAGE, ...opts },
    notes, secrets: new Set(), vars: new Set(),
    note(m) { if (!notes.includes(m)) notes.push(m); },
    secret(name) { const n = sanitizeVar(name); if (n !== 'CI_JOB_TOKEN') ctx.secrets.add(n); return n; },
    matrixVars: {}, inputVars: {}, dotenv: false, includes: [], artifactsByName: {},
  };
  return ctx;
}
const sanitizeVar = (s) => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
const upperVar = (s) => sanitizeVar(s).toUpperCase();
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');

// ---------------------------------------------------------------- expressions inside strings

const GITHUB_VARS = {
  sha: '$CI_COMMIT_SHA', ref_name: '$CI_COMMIT_REF_NAME', ref: '$CI_COMMIT_REF_NAME', ref_type: '', repository: '$CI_PROJECT_PATH', repository_owner: '$CI_PROJECT_NAMESPACE',
  run_id: '$CI_PIPELINE_ID', run_number: '$CI_PIPELINE_IID', run_attempt: '1', actor: '$GITLAB_USER_LOGIN', triggering_actor: '$GITLAB_USER_LOGIN', workspace: '$CI_PROJECT_DIR', event_name: '$CI_PIPELINE_SOURCE',
  head_ref: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', base_ref: '$CI_MERGE_REQUEST_TARGET_BRANCH_NAME', server_url: '$CI_SERVER_URL', api_url: '$CI_API_V4_URL', token: '$CI_JOB_TOKEN', job: '$CI_JOB_NAME', workflow: '$CI_PIPELINE_NAME',
  'event.repository.name': '$CI_PROJECT_NAME', 'event.repository.default_branch': '$CI_DEFAULT_BRANCH', 'event.repository.full_name': '$CI_PROJECT_PATH', 'event.repository.html_url': '$CI_PROJECT_URL',
  'event.pull_request.number': '$CI_MERGE_REQUEST_IID', 'event.pull_request.base.sha': '$CI_MERGE_REQUEST_DIFF_BASE_SHA', 'event.pull_request.html_url': '$CI_MERGE_REQUEST_PROJECT_URL/-/merge_requests/$CI_MERGE_REQUEST_IID', 'event.pull_request.title': '$CI_MERGE_REQUEST_TITLE', 'event.pull_request.head.sha': '$CI_COMMIT_SHA', 'event.pull_request.head.ref': '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', 'event.pull_request.base.ref': '$CI_MERGE_REQUEST_TARGET_BRANCH_NAME', 'event.pull_request.user.login': '$GITLAB_USER_LOGIN',
  'event.head_commit.message': '$CI_COMMIT_MESSAGE', 'event.head_commit.id': '$CI_COMMIT_SHA', 'event.head_commit.author.name': '$CI_COMMIT_AUTHOR', 'event.before': '$CI_COMMIT_BEFORE_SHA', 'event.after': '$CI_COMMIT_SHA', 'event.release.tag_name': '$CI_COMMIT_TAG', 'event.number': '$CI_MERGE_REQUEST_IID',
};
const ENV_VARS = {
  GITHUB_SHA: '$CI_COMMIT_SHA', GITHUB_REF_NAME: '$CI_COMMIT_REF_NAME', GITHUB_REF: '$CI_COMMIT_REF_NAME', GITHUB_REPOSITORY: '$CI_PROJECT_PATH', GITHUB_REPOSITORY_OWNER: '$CI_PROJECT_NAMESPACE', GITHUB_RUN_ID: '$CI_PIPELINE_ID', GITHUB_RUN_NUMBER: '$CI_PIPELINE_IID',
  GITHUB_ACTOR: '$GITLAB_USER_LOGIN', GITHUB_WORKSPACE: '$CI_PROJECT_DIR', GITHUB_EVENT_NAME: '$CI_PIPELINE_SOURCE', GITHUB_HEAD_REF: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME', GITHUB_BASE_REF: '$CI_MERGE_REQUEST_TARGET_BRANCH_NAME', GITHUB_SERVER_URL: '$CI_SERVER_URL', GITHUB_API_URL: '$CI_API_V4_URL',
  GITHUB_JOB: '$CI_JOB_NAME', GITHUB_WORKFLOW: '$CI_PIPELINE_NAME', GITHUB_TOKEN: '$CI_JOB_TOKEN', RUNNER_TEMP: '/tmp', RUNNER_WORKSPACE: '$CI_BUILDS_DIR', RUNNER_ARCH: '$CI_RUNNER_EXECUTABLE_ARCH', GITHUB_ACTIONS: '$GITLAB_CI', CI: '$CI',
};
const EVENT_SOURCE = { push: 'push', pull_request: 'merge_request_event', pull_request_target: 'merge_request_event', merge_group: 'merge_request_event', schedule: 'schedule', workflow_dispatch: 'web', repository_dispatch: 'api', workflow_call: 'parent_pipeline', workflow_run: 'pipeline' };

// Translate one `${{ … }}` expression used inside a string value (not a condition) to its GitLab form.
function exprValue(inner, ctx, scope = {}) {
  const e = inner.trim();
  let m;
  if ((m = /^secrets\.([A-Za-z0-9_-]+)$/.exec(e))) return m[1] === 'GITHUB_TOKEN' ? '$CI_JOB_TOKEN' : '$' + ctx.secret(m[1]);
  if ((m = /^env\.([A-Za-z0-9_-]+)$/.exec(e))) return '$' + sanitizeVar(m[1]);
  if ((m = /^vars\.([A-Za-z0-9_-]+)$/.exec(e))) { ctx.vars.add(sanitizeVar(m[1])); return '$' + sanitizeVar(m[1]); }
  if ((m = /^matrix\.([A-Za-z0-9_-]+)$/.exec(e))) return '$' + (ctx.matrixVars[m[1]] || upperVar(m[1]));
  if ((m = /^matrix\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(e))) return '$' + (ctx.matrixVars[m[1] + '.' + m[2]] || upperVar(m[1] + '_' + m[2].replace(/\./g, '_')));
  if ((m = /^(?:inputs|github\.event\.inputs)\.([A-Za-z0-9_-]+)$/.exec(e))) return '$' + (ctx.inputVars[m[1]] || upperVar(m[1]));
  if ((m = /^steps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)$/.exec(e))) { ctx.note('Step outputs (`steps.*.outputs.*`) became plain variables; the producing step writes them to `build.env`, which is exported as a `dotenv` report for later jobs.'); return '$' + sanitizeVar(m[1]); }
  if ((m = /^needs\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)$/.exec(e))) { ctx.note('Job outputs (`needs.*.outputs.*`) are passed between jobs as `dotenv` artifacts; the producing job must write `NAME=value` to `build.env`.'); return '$' + sanitizeVar(m[1]); }
  if ((m = /^github\.(.+)$/.exec(e))) {
    const v = GITHUB_VARS[m[1]];
    if (m[1] === 'ref') ctx.note('`github.ref` was mapped to `$CI_COMMIT_REF_NAME`, which has no `refs/heads/` prefix; adjust string comparisons that relied on it.');
    if (v) return v;
    if (m[1] === 'ref_type') return '${CI_COMMIT_TAG:+tag}${CI_COMMIT_BRANCH:+branch}';
    if (/^event\.inputs\./.test(m[1])) return '$' + upperVar(m[1].split('.').pop());
  }
  if ((m = /^runner\.(os|arch|temp|name|tool_cache)$/.exec(e))) return { os: 'Linux', arch: '$CI_RUNNER_EXECUTABLE_ARCH', temp: '/tmp', name: '$CI_RUNNER_DESCRIPTION', tool_cache: '/opt' }[m[1]];
  if ((m = /^job\.status$/.exec(e))) return '$CI_JOB_STATUS';
  if ((m = /^format\(\s*'([^']*)'\s*,\s*(.*)\)$/.exec(e))) {
    const parts = splitArgs(m[2]).map((a) => (/^'.*'$/.test(a.trim()) ? a.trim().slice(1, -1) : exprValue(a, ctx, scope)));
    if (parts.every((p) => p !== null)) return m[1].replace(/\{(\d+)\}/g, (_, i) => parts[Number(i)] ?? '');
  }
  if ((m = /^hashFiles\((.*)\)$/.exec(e))) { const files = splitArgs(m[1]).map((a) => a.trim().replace(/^'|'$/g, '')); return `$(cat ${files.join(' ')} 2>/dev/null | sha256sum | cut -c1-16)`; }
  if ((m = /^(.+?)\s*&&\s*('[^']*'|[A-Za-z_][\w.-]*)\s*\|\|\s*('[^']*'|[A-Za-z_][\w.-]*)$/.exec(e)) && !/\|\|/.test(m[1])) {
    const c = condition(m[1], ctx); const t = c.if && !c.todo ? shellTest(c.if) : null;
    const val = (x) => (/^'.*'$/.test(x) ? x.slice(1, -1) : exprValue(x, ctx, scope));
    const a = val(m[2]), b = val(m[3]);
    if (t && a !== null && b !== null) return `$(if ${t}; then echo "${a}"; else echo "${b}"; fi)`;
  }
  if (/^'[^']*'$/.test(e)) return e.slice(1, -1);
  if (/^(true|false|\d+)$/.test(e)) return e;
  if ((m = /^(.+?)\s*\|\|\s*'([^']*)'$/.exec(e))) { const a = exprValue(m[1], ctx, scope); if (a && a.startsWith('$')) return `\${${a.slice(1)}:-${m[2]}}`; }
  return null;
}
function splitArgs(s) { const out = []; let depth = 0, cur = '', inStr = false; for (const ch of s) { if (ch === "'" ) inStr = !inStr; if (!inStr) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; } } cur += ch; } if (cur.trim()) out.push(cur); return out; }

// Replace every `${{ … }}` in a string; untranslatable ones are kept and noted.
function subst(s, ctx, scope) {
  if (typeof s !== 'string' || !s.includes('${{')) return s;
  return s.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (all, inner) => {
    const v = exprValue(inner, ctx, scope);
    if (v !== null && v !== undefined) return v;
    ctx.note(`Expression \`\${{ ${inner} }}\` has no direct equivalent and was left in place; rewrite it by hand.`);
    return `\${{ ${inner} }}`;
  });
}

// Rewrite the shell of a `run:` step: $GITHUB_* variables, $GITHUB_OUTPUT/$GITHUB_ENV files, workflow commands.
function shellRewrite(script, ctx, job) {
  let s = subst(script, ctx);
  if (/\$\{?GITHUB_OUTPUT\}?|::set-output/.test(s)) { ctx.dotenv = true; job.__dotenv = true; }
  if (/\$\{?GITHUB_ENV\}?/.test(s)) { job.__dotenv = true; job.__sourceEnv = true; }
  s = s.replace(/>>\s*"?\$\{?GITHUB_OUTPUT\}?"?/g, '>> build.env').replace(/>>\s*"?\$\{?GITHUB_ENV\}?"?/g, '>> build.env');
  s = s.replace(/echo\s+"::set-output name=([^:]+)::(.*?)"/g, 'echo "$1=$2" >> build.env');
  s = s.replace(/echo\s+"?([^"\n]*?)"?\s*>>\s*"?\$\{?GITHUB_PATH\}?"?/g, 'export PATH="$1:$PATH"');
  if (/\$\{?GITHUB_STEP_SUMMARY\}?/.test(s)) { ctx.note('`$GITHUB_STEP_SUMMARY` has no GitLab equivalent; those writes now go to the job log.'); s = s.replace(/>>\s*"?\$\{?GITHUB_STEP_SUMMARY\}?"?/g, ''); }
  s = s.replace(/\$\{?(GITHUB_[A-Z_]+|RUNNER_[A-Z_]+)\}?/g, (all, name) => { if (name === 'GITHUB_OUTPUT' || name === 'GITHUB_ENV' || name === 'GITHUB_PATH') return all; if (ENV_VARS[name]) return ENV_VARS[name]; if (name === 'RUNNER_OS') { ctx.note('`$RUNNER_OS` has no equivalent; it was replaced by the literal `Linux`.'); return 'Linux'; } ctx.note(`Environment variable \`$${name}\` has no GitLab equivalent.`); return all; });
  s = s.replace(/echo\s+"::(group|endgroup)[^"]*"\s*\n?/g, '');
  s = s.replace(/echo\s+"::(error|warning|notice)[^:]*::([^"]*)"/g, 'echo "$1: $2"');
  if (/ghcr\.io\/\$CI_PROJECT_PATH/.test(s)) s = s.replace(/ghcr\.io\/\$CI_PROJECT_PATH/g, '$CI_REGISTRY_IMAGE');
  return s;
}

// ---------------------------------------------------------------- conditions -> rules

const EVENT_RULE = (ev) => (ev === 'release' ? '$CI_COMMIT_TAG' : ev === 'pull_request' || ev === 'pull_request_target' ? '$CI_PIPELINE_SOURCE == "merge_request_event"' : ev === 'workflow_dispatch' ? '$CI_PIPELINE_SOURCE == "web"' : ev === 'schedule' ? '$CI_PIPELINE_SOURCE == "schedule"' : ev === 'push' ? '$CI_PIPELINE_SOURCE == "push"' : EVENT_SOURCE[ev] ? `$CI_PIPELINE_SOURCE == "${EVENT_SOURCE[ev]}"` : null);

// Translate an Actions boolean expression into a GitLab `rules: if:` string. Returns { if, when, todo }.
function condition(cond, ctx) {
  let c = String(cond).trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  const out = { if: null, when: null, todo: null };
  if (/^always\(\)$/.test(c)) return { ...out, when: 'always' };
  if (/^!cancelled\(\)$/.test(c)) return { ...out, when: 'always' };
  if (/^failure\(\)$/.test(c)) return { ...out, when: 'on_failure' };
  if (/^success\(\)$/.test(c)) return out;
  c = c.replace(/^(always|!cancelled)\(\)\s*&&\s*/, () => { out.when = 'always'; return ''; }).replace(/^failure\(\)\s*&&\s*/, () => { out.when = 'on_failure'; return ''; }).replace(/^success\(\)\s*&&\s*/, '').replace(/\s*&&\s*success\(\)$/, '');
  if (!c) return out;
  const orig = c;
  const lit = (v) => q(String(v).replace(/^['"]|['"]$/g, ''));
  const rx = (v) => `/${String(v).replace(/^['"]|['"]$/g, '').replace(/\//g, '\\/')}/`;
  const steps = [
    [/github\.event_name\s*(==|!=)\s*'([a-z_]+)'/g, (m, op, ev) => { if (ev === 'release') return op === '==' ? '$CI_COMMIT_TAG' : '$CI_COMMIT_TAG == null'; const src = EVENT_SOURCE[ev]; return src ? `$CI_PIPELINE_SOURCE ${op} "${src}"` : null; }],
    [/github\.ref\s*(==|!=)\s*'refs\/heads\/([^']+)'/g, (m, op, b) => `$CI_COMMIT_BRANCH ${op} ${q(b)}`],
    [/github\.ref\s*(==|!=)\s*'refs\/tags\/([^']+)'/g, (m, op, t) => `$CI_COMMIT_TAG ${op} ${q(t)}`],
    [/github\.ref\s*(==|!=)\s*format\('refs\/heads\/\{0\}',\s*github\.event\.repository\.default_branch\)/g, (m, op) => `$CI_COMMIT_BRANCH ${op} $CI_DEFAULT_BRANCH`],
    [/github\.ref_name\s*(==|!=)\s*'([^']+)'/g, (m, op, b) => `$CI_COMMIT_REF_NAME ${op} ${q(b)}`],
    [/github\.ref_name\s*(==|!=)\s*github\.event\.repository\.default_branch/g, (m, op) => `$CI_COMMIT_REF_NAME ${op} $CI_DEFAULT_BRANCH`],
    [/github\.ref_type\s*==\s*'tag'/g, '$CI_COMMIT_TAG'], [/github\.ref_type\s*==\s*'branch'/g, '$CI_COMMIT_BRANCH'], [/github\.ref_type\s*!=\s*'tag'/g, '$CI_COMMIT_TAG == null'],
    [/(!?)startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/'\s*\)/g, (m, n) => (n ? '$CI_COMMIT_TAG == null' : '$CI_COMMIT_TAG')],
    [/(!?)startsWith\(\s*github\.ref\s*,\s*'refs\/heads\/'\s*\)/g, (m, n) => (n ? '$CI_COMMIT_BRANCH == null' : '$CI_COMMIT_BRANCH')],
    [/(!?)startsWith\(\s*github\.ref\s*,\s*'refs\/tags\/([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_TAG ${n ? '!~' : '=~'} /^${reEsc(p)}/`],
    [/(!?)startsWith\(\s*github\.ref\s*,\s*'refs\/heads\/([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_BRANCH ${n ? '!~' : '=~'} /^${reEsc(p)}/`],
    [/(!?)startsWith\(\s*github\.ref_name\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_REF_NAME ${n ? '!~' : '=~'} /^${reEsc(p)}/`],
    [/(!?)endsWith\(\s*github\.ref(?:_name)?\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_REF_NAME ${n ? '!~' : '=~'} /${reEsc(p)}$/`],
    [/(!?)contains\(\s*github\.ref(?:_name)?\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_REF_NAME ${n ? '!~' : '=~'} ${rx(reEsc(p))}`],
    [/(!?)contains\(\s*github\.event\.head_commit\.message\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_COMMIT_MESSAGE ${n ? '!~' : '=~'} ${rx(reEsc(p))}`],
    [/(!?)contains\(\s*github\.event\.pull_request\.title\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_MERGE_REQUEST_TITLE ${n ? '!~' : '=~'} ${rx(reEsc(p))}`],
    [/(!?)contains\(\s*github\.event\.pull_request\.labels\.\*\.name\s*,\s*'([^']+)'\s*\)/g, (m, n, p) => `$CI_MERGE_REQUEST_LABELS ${n ? '!~' : '=~'} ${rx('(^|,)' + reEsc(p) + '(,|$)')}`],
    [/github\.repository\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$CI_PROJECT_PATH ${op} ${q(v)}`],
    [/github\.repository_owner\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$CI_PROJECT_NAMESPACE ${op} ${q(v)}`],
    [/github\.(?:actor|triggering_actor)\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$GITLAB_USER_LOGIN ${op} ${q(v)}`],
    [/github\.base_ref\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME ${op} ${q(v)}`],
    [/github\.head_ref\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME ${op} ${q(v)}`],
    [/github\.event\.pull_request\.base\.ref\s*(==|!=)\s*'([^']+)'/g, (m, op, v) => `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME ${op} ${q(v)}`],
    [/github\.event\.pull_request\.draft\s*==\s*false/g, '$CI_MERGE_REQUEST_TITLE !~ /^Draft:/'], [/github\.event\.pull_request\.draft\s*==\s*true/g, '$CI_MERGE_REQUEST_TITLE =~ /^Draft:/'],
    [/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/g, '$CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH'],
    [/github\.event\.pull_request\.head\.repo\.fork\s*==\s*false/g, '$CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH'],
    [/github\.event\.repository\.fork\s*==\s*false/g, '$CI_PROJECT_PATH'],
    [/github\.event\.pull_request\b(?!\.)/g, '$CI_MERGE_REQUEST_IID'],
    [/github\.event\.pull_request\.merged\s*==\s*true/g, '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'],
    [/github\.event\.inputs\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + (ctx.inputVars[k] || upperVar(k))],
    [/\binputs\.([A-Za-z0-9_-]+)\s*(==|!=)\s*(true|false)/g, (m, k, op, v) => `$${ctx.inputVars[k] || upperVar(k)} ${op} "${v}"`],
    [/\binputs\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + (ctx.inputVars[k] || upperVar(k))],
    [/\bmatrix\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + (ctx.matrixVars[k] || upperVar(k))],
    [/\benv\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + sanitizeVar(k)],
    [/\bvars\.([A-Za-z0-9_-]+)/g, (m, k) => { ctx.vars.add(sanitizeVar(k)); return '$' + sanitizeVar(k); }],
    [/\bsecrets\.([A-Za-z0-9_-]+)\s*(!=|==)\s*''/g, (m, k, op) => `$${ctx.secret(k)} ${op === '!=' ? '!=' : '=='} ""`],
    [/\bsecrets\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + ctx.secret(k)],
    [/\bneeds\.[A-Za-z0-9_-]+\.result\s*==\s*'success'/g, () => { ctx.note('`needs.*.result == \'success\'` is implied by `needs:` in GitLab and was dropped from the condition.'); return '$CI_PROJECT_PATH'; }],
    [/\bneeds\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + sanitizeVar(k)],
    [/\bsteps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/g, (m, k) => '$' + sanitizeVar(k)],
    [/\bjob\.status\s*(==|!=)\s*'([a-z]+)'/g, (m, op, v) => `$CI_JOB_STATUS ${op} "${v === 'failure' ? 'failed' : v}"`],
    [/(\$[A-Za-z0-9_]+)\s*(==|!=)\s*'([^']*)'/g, (m, v, op, s) => `${v} ${op} ${q(s)}`],
    [/(\$[A-Za-z0-9_]+)\s*(==|!=)\s*(true|false|\d+(?:\.\d+)?)\b/g, (m, v, op, s) => `${v} ${op} "${s}"`],
    [/!\s*(\$[A-Za-z0-9_]+)(?!\s*[=!~])/g, (m, v) => `${v} == null`],
    [/'([^']*)'\s*(==|!=)\s*(\$[A-Za-z0-9_]+)/g, (m, s, op, v) => `${v} ${op} ${q(s)}`],
  ];
  let failed = false;
  for (const [re, rep] of steps) c = c.replace(re, (...m) => { const r = typeof rep === 'function' ? rep(...m) : rep; if (r === null) { failed = true; return m[0]; } return r; });
  // Variable-to-variable comparisons like $A == $B need no quoting. Comparisons of two literals are static.
  if (failed || /\b(github|steps|needs|runner|job)\.|[a-zA-Z_]+\(|\bfromJSON\b|\btoJSON\b/.test(c) || /(^|[^=!<>])!\s*[\($]/.test(c)) { out.todo = orig; return out; }
  out.if = c;
  return out;
}

// GitLab rule -> shell test for step-level conditions.
function shellTest(ifExpr) {
  if (!ifExpr) return null;
  if (/[()]/.test(ifExpr)) return null;
  const parts = ifExpr.split(/\s*(&&|\|\|)\s*/);
  const out = [];
  for (const p of parts) {
    if (p === '&&' || p === '||') { out.push(p); continue; }
    let m;
    if ((m = /^(\$[A-Za-z0-9_]+)\s*(==|!=)\s*"(.*)"$/.exec(p))) out.push(`[ "${m[1]}" ${m[2] === '==' ? '=' : '!='} "${m[3]}" ]`);
    else if ((m = /^(\$[A-Za-z0-9_]+)\s*(==|!=)\s*(\$[A-Za-z0-9_]+)$/.exec(p))) out.push(`[ "${m[1]}" ${m[2] === '==' ? '=' : '!='} "${m[3]}" ]`);
    else if ((m = /^(\$[A-Za-z0-9_]+)\s*(==|!=)\s*null$/.exec(p))) out.push(`[ ${m[2] === '==' ? '-z' : '-n'} "${m[1]}" ]`);
    else if ((m = /^(\$[A-Za-z0-9_]+)\s*(=~|!~)\s*\/(.*)\/$/.exec(p))) out.push(`${m[2] === '!~' ? '! ' : ''}echo "${m[1]}" | grep -Eq '${m[3].replace(/\\\//g, '/').replace(/'/g, "'\\''")}'`);
    else if ((m = /^(\$[A-Za-z0-9_]+)$/.exec(p))) out.push(`[ -n "${m[1]}" ]`);
    else return null;
  }
  return out.join(' ');
}

// ---------------------------------------------------------------- runners, images, tool setup

function runnerOf(runsOn, job, ctx) {
  const list = asList(runsOn).map((x) => subst(String(x), ctx));
  const l = list.join(' ').toLowerCase();
  if (typeof runsOn === 'object' && !Array.isArray(runsOn) && runsOn !== null) { if (runsOn.group) { job.tags = [String(runsOn.group), ...asList(runsOn.labels).map(String)]; ctx.note(`Runner group \`${runsOn.group}\` became runner tags; create runners with those tags.`); } return; }
  if (/\$/.test(l)) { ctx.note(`\`runs-on: ${list.join(', ')}\` is dynamic; the job was left on the default image, add \`tags:\` by hand.`); return; }
  if (/self-hosted/.test(l)) { const tags = list.filter((x) => x !== 'self-hosted'); job.tags = tags.length ? tags : ['self-hosted']; ctx.note(`Self-hosted runner labels \`${list.join(', ')}\` became runner tags; register GitLab runners with those tags.`); return; }
  if (/windows/.test(l)) { job.tags = ['saas-windows-medium-amd64']; ctx.note('Windows jobs were given the gitlab.com `saas-windows-medium-amd64` tag; its shell is PowerShell, so bash scripts need rewriting.'); job.__windows = true; return; }
  if (/macos/.test(l)) { job.tags = ['saas-macos-medium-m1']; job.image = 'macos-14-xcode-15'; ctx.note('macOS jobs were given the gitlab.com `saas-macos-medium-m1` tag and the `macos-14-xcode-15` image (self-managed runners need their own).'); return; }
  if (/ubuntu|linux/.test(l) || !l) return;
  job.tags = list; ctx.note(`Unrecognised \`runs-on: ${list.join(', ')}\` became runner tags.`);
}

function version(v) { v = String(v ?? '').trim(); return v.replace(/\.x$/, '').replace(/^v(?=\d)/, ''); }
function setImage(job, ctx, image, tool) {
  if (job.__windows) { return false; }
  if (job.image && job.image !== ctx.opts.image && !job.__imageFromSetup) { ctx.note(`\`${tool}\` was dropped because the job already runs in \`${typeof job.image === 'object' ? job.image.name : job.image}\`; install the tool in that image.`); return false; }
  if (job.__imageFromSetup) { return false; }
  job.image = image; job.__imageFromSetup = tool; return true;
}
function addCache(job, key, paths, ctx, extra = {}) {
  const c = { key, paths, ...extra };
  if (!job.cache) job.cache = c;
  else if (Array.isArray(job.cache)) job.cache.push(c);
  else job.cache = [job.cache, c];
}
function keyFromFiles(files) { const list = asList(files).map((f) => String(f).replace(/^\*\*\//, '')).slice(0, 2); return { files: list }; }

// ---------------------------------------------------------------- Marketplace actions

// Each handler returns script lines (array of strings/Comments) or null when the step produced no script.
const ACTIONS = {
  'actions/checkout': (w, job, ctx) => {
    if (w['fetch-depth'] !== undefined && String(w['fetch-depth']) === '0') job.variables = { ...(job.variables || {}), GIT_DEPTH: 0 };
    if (w.submodules) job.variables = { ...(job.variables || {}), GIT_SUBMODULE_STRATEGY: String(w.submodules) === 'recursive' ? 'recursive' : 'normal' };
    if (w.lfs) job.variables = { ...(job.variables || {}), GIT_LFS_SKIP_SMUDGE: 0 };
    if (w.repository || w.ref || w.path) ctx.note('`actions/checkout` with `repository`, `ref` or `path` checks out something other than the current commit; GitLab clones the pipeline commit only, add a `git clone` for the rest.');
    if (w.token || w['ssh-key']) ctx.note('`actions/checkout` used a token or SSH key; GitLab clones with `CI_JOB_TOKEN` automatically.');
    return null;
  },
  'actions/setup-node': (w, job, ctx) => {
    const lines = [];
    let v = version(w['node-version']);
    if (w['node-version-file']) { v = 'lts'; ctx.note(`\`node-version-file: ${w['node-version-file']}\` became \`node:lts\`; pin the image tag to match the file.`); }
    if (!v || v === 'latest') v = v || 'lts';
    if (v.startsWith('lts/')) v = 'lts';
    if (!setImage(job, ctx, `node:${v}`, 'actions/setup-node')) lines.push(`# TODO: install Node ${v} in this image (actions/setup-node)`);
    if (w.cache) { const lock = { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[w.cache] || 'package-lock.json'; const dir = { npm: '.npm/', yarn: '.yarn-cache/', pnpm: '.pnpm-store/' }[w.cache] || '.npm/'; addCache(job, keyFromFiles(w['cache-dependency-path'] || lock), [dir], ctx); if (w.cache === 'npm') job.variables = { npm_config_cache: '$CI_PROJECT_DIR/.npm', ...(job.variables || {}) }; if (w.cache === 'yarn') job.variables = { YARN_CACHE_FOLDER: '$CI_PROJECT_DIR/.yarn-cache', ...(job.variables || {}) }; if (w.cache === 'pnpm') lines.push('pnpm config set store-dir .pnpm-store'); }
    if (w['registry-url']) { const reg = String(w['registry-url']).replace(/^https?:/, ''); lines.push(`echo "${reg.replace(/\/$/, '')}/:_authToken=\${NODE_AUTH_TOKEN}" > ~/.npmrc`); ctx.note('`registry-url` became a `.npmrc` line; `NODE_AUTH_TOKEN` must be set in CI/CD variables.'); }
    return lines.length ? lines : null;
  },
  'actions/setup-python': (w, job, ctx) => { let v = version(w['python-version']) || '3'; if (w['python-version-file']) v = '3'; if (/^pypy/.test(v)) v = v.replace(/^pypy-?/, 'pypy:'); if (!setImage(job, ctx, v.startsWith('pypy') ? v : `python:${v}`, 'actions/setup-python')) return [`# TODO: install Python ${v} in this image (actions/setup-python)`]; if (w.cache === 'pip') { addCache(job, keyFromFiles(w['cache-dependency-path'] || 'requirements.txt'), ['.cache/pip'], ctx); job.variables = { PIP_CACHE_DIR: '$CI_PROJECT_DIR/.cache/pip', ...(job.variables || {}) }; } return null; },
  'actions/setup-go': (w, job, ctx) => { let v = version(w['go-version']) || '1'; if (w['go-version-file']) { v = '1'; ctx.note('`go-version-file` became `golang:1`; pin the image tag to the version in go.mod.'); } if (!setImage(job, ctx, `golang:${v}`, 'actions/setup-go')) return [`# TODO: install Go ${v} in this image (actions/setup-go)`]; if (w.cache !== false && w.cache !== 'false') { addCache(job, keyFromFiles('go.sum'), ['.go/pkg/mod'], ctx); job.variables = { GOPATH: '$CI_PROJECT_DIR/.go', ...(job.variables || {}) }; } return null; },
  'actions/setup-java': (w, job, ctx) => { const v = version(w['java-version']) || '17'; const d = String(w.distribution || 'temurin'); const img = d === 'corretto' ? `amazoncorretto:${v}` : d === 'zulu' ? `azul/zulu-openjdk:${v}` : d === 'microsoft' ? `mcr.microsoft.com/openjdk/jdk:${v}-ubuntu` : `eclipse-temurin:${v}`; if (!setImage(job, ctx, img, 'actions/setup-java')) return [`# TODO: install Java ${v} (${d}) in this image (actions/setup-java)`]; if (w.cache === 'maven') { addCache(job, keyFromFiles('pom.xml'), ['.m2/repository'], ctx); job.variables = { MAVEN_OPTS: '-Dmaven.repo.local=$CI_PROJECT_DIR/.m2/repository', ...(job.variables || {}) }; } if (w.cache === 'gradle') { addCache(job, keyFromFiles('build.gradle'), ['.gradle/caches', '.gradle/wrapper'], ctx); job.variables = { GRADLE_USER_HOME: '$CI_PROJECT_DIR/.gradle', ...(job.variables || {}) }; } return null; },
  'actions/setup-dotnet': (w, job, ctx) => { const v = version(asList(w['dotnet-version'])[0]).replace(/\.\d+$/, '') || '8.0'; if (!setImage(job, ctx, `mcr.microsoft.com/dotnet/sdk:${v}`, 'actions/setup-dotnet')) return [`# TODO: install .NET SDK ${v} in this image (actions/setup-dotnet)`]; return null; },
  'ruby/setup-ruby': (w, job, ctx) => { const v = version(w['ruby-version']) || '3.3'; const ok = setImage(job, ctx, `ruby:${v}`, 'ruby/setup-ruby'); const lines = ok ? [] : [`# TODO: install Ruby ${v} in this image (ruby/setup-ruby)`]; if (w['bundler-cache']) { addCache(job, keyFromFiles('Gemfile.lock'), ['vendor/bundle'], ctx); lines.push('bundle config set --local path vendor/bundle', 'bundle install'); } return lines.length ? lines : null; },
  'dtolnay/rust-toolchain': (w, job, ctx, ref) => { const t = version(w.toolchain || ref || 'stable'); const img = t === 'nightly' ? 'rustlang/rust:nightly' : t === 'stable' || t === 'beta' ? 'rust:latest' : `rust:${t}`; if (!setImage(job, ctx, img, 'dtolnay/rust-toolchain')) return [`rustup toolchain install ${t} && rustup default ${t}`]; return w.components ? [`rustup component add ${String(w.components).split(/[\s,]+/).join(' ')}`] : null; },
  'actions-rs/toolchain': (w, job, ctx) => ACTIONS['dtolnay/rust-toolchain'](w, job, ctx),
  'Swatinem/rust-cache': (w, job, ctx) => { addCache(job, keyFromFiles('Cargo.lock'), ['target/', '.cargo/registry', '.cargo/git'], ctx); job.variables = { CARGO_HOME: '$CI_PROJECT_DIR/.cargo', ...(job.variables || {}) }; return null; },
  'pnpm/setup': (w, job, ctx) => ACTIONS['pnpm/action-setup'](w, job, ctx),
  'dsherret/rust-toolchain-file': (w, job, ctx) => ACTIONS['dtolnay/rust-toolchain']({}, job, ctx),
  'step-security/harden-runner': () => null,
  're-actors/alls-green': (w, job) => { job.__drop = 'the "all jobs green" gate is not needed; GitLab merge checks look at the pipeline status'; return null; },
  'dessant/lock-threads': (w, job) => { job.__drop = 'issue locking is repository automation, not CI'; return null; },
  'actions/attest': (w, job, ctx) => ACTIONS['actions/attest-build-provenance'](w, job, ctx),
  'PyO3/maturin-action': (w, job, ctx) => [`pip install maturin`, `maturin ${w.command || 'build'} ${w.args || '--release'}${w.target ? ` --target ${w.target}` : ''}`.trim()],
  'pnpm/action-setup': (w, job, ctx) => [`corepack enable && corepack prepare pnpm@${version(w.version) || 'latest'} --activate`],
  'oven-sh/setup-bun': (w, job, ctx) => { if (!setImage(job, ctx, `oven/bun:${version(w['bun-version']) || '1'}`, 'oven-sh/setup-bun')) return ['curl -fsSL https://bun.sh/install | bash && export PATH="$HOME/.bun/bin:$PATH"']; return null; },
  'denoland/setup-deno': (w, job, ctx) => { if (!setImage(job, ctx, `denoland/deno:${version(w['deno-version']) || 'latest'}`, 'denoland/setup-deno')) return ['curl -fsSL https://deno.land/install.sh | sh && export PATH="$HOME/.deno/bin:$PATH"']; return null; },
  'shivammathur/setup-php': (w, job, ctx) => { const v = version(w['php-version']) || '8.3'; if (!setImage(job, ctx, `php:${v}-cli`, 'shivammathur/setup-php')) return [`# TODO: install PHP ${v} in this image (shivammathur/setup-php)`]; const lines = []; if (w.extensions) { lines.push(`docker-php-ext-install ${String(w.extensions).split(/[\s,]+/).filter((e) => !/^(mbstring|xml|curl|json|zip|bcmath|intl|gd|pdo_mysql|mysqli|pcntl)$/.test(e) ? false : true).join(' ') || '# extensions'}`); ctx.note('PHP extensions are installed with `docker-php-ext-install`; some (gd, intl, zip) need their system libraries first.'); } if (w.tools && /composer/.test(String(w.tools))) lines.push('curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer'); return lines.length ? lines : null; },
  'erlef/setup-beam': (w, job, ctx) => { if (!setImage(job, ctx, `elixir:${version(w['elixir-version']) || 'latest'}`, 'erlef/setup-beam')) return ['# TODO: install Erlang/Elixir in this image (erlef/setup-beam)']; return null; },
  'hashicorp/setup-terraform': (w, job, ctx) => { const v = version(w.terraform_version) || 'latest'; if (!setImage(job, ctx, { name: `hashicorp/terraform:${v}`, entrypoint: [''] }, 'hashicorp/setup-terraform')) return [`# TODO: install Terraform ${v} in this image`]; return null; },
  'google-github-actions/setup-gcloud': (w, job, ctx) => { if (!setImage(job, ctx, 'google/cloud-sdk:slim', 'google-github-actions/setup-gcloud')) return ['curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts && export PATH="$HOME/google-cloud-sdk/bin:$PATH"']; return null; },
  'google-github-actions/auth': (w, job, ctx) => { if (w.workload_identity_provider) { job.id_tokens = { GITLAB_OIDC_TOKEN: { aud: 'https://gitlab.com' } }; ctx.note('Google workload identity federation: create a GitLab OIDC pool/provider and swap the `GITLAB_OIDC_TOKEN` for a GCP access token (gcloud iam workload-identity-pools create-cred-config).'); return ['# TODO: exchange $GITLAB_OIDC_TOKEN for Google credentials via workload identity federation', `echo "$GITLAB_OIDC_TOKEN" > .ci_token && gcloud iam workload-identity-pools create-cred-config ${w.workload_identity_provider} --service-account=${w.service_account || 'SERVICE_ACCOUNT'} --credential-source-file=.ci_token --output-file=gcp-creds.json && export GOOGLE_APPLICATION_CREDENTIALS="$PWD/gcp-creds.json"`]; } ctx.secret('GCP_SA_KEY'); return ['echo "$GCP_SA_KEY" > gcp-key.json && gcloud auth activate-service-account --key-file gcp-key.json && export GOOGLE_APPLICATION_CREDENTIALS="$PWD/gcp-key.json"']; },
  'aws-actions/configure-aws-credentials': (w, job, ctx) => { const region = subst(String(w['aws-region'] || w.region || 'us-east-1'), ctx); const lines = [`export AWS_DEFAULT_REGION=${region} AWS_REGION=${region}`]; if (w['role-to-assume']) { job.id_tokens = { GITLAB_OIDC_TOKEN: { aud: 'https://gitlab.com' } }; ctx.note('AWS OIDC: add gitlab.com as an identity provider in IAM and trust `GITLAB_OIDC_TOKEN`; the generated `aws sts assume-role-with-web-identity` call then works unchanged.'); lines.push(`export $(printf "AWS_ACCESS_KEY_ID=%s AWS_SECRET_ACCESS_KEY=%s AWS_SESSION_TOKEN=%s" $(aws sts assume-role-with-web-identity --role-arn ${subst(String(w['role-to-assume']), ctx)} --role-session-name "gitlab-$CI_PIPELINE_ID" --web-identity-token "$GITLAB_OIDC_TOKEN" --duration-seconds ${w['role-duration-seconds'] || 3600} --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text))`); } else { ctx.secret('AWS_ACCESS_KEY_ID'); ctx.secret('AWS_SECRET_ACCESS_KEY'); ctx.note('AWS credentials: set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as masked CI/CD variables; the AWS CLI picks them up.'); } return lines; },
  'aws-actions/amazon-ecr-login': (w, job, ctx) => ['aws ecr get-login-password | docker login --username AWS --password-stdin "$(aws sts get-caller-identity --query Account --output text).dkr.ecr.${AWS_REGION}.amazonaws.com"'],
  'azure/login': (w, job, ctx) => { ctx.secret('AZURE_CLIENT_ID'); ctx.secret('AZURE_TENANT_ID'); if (w['client-secret'] || !w['client-id']) { ctx.secret('AZURE_CLIENT_SECRET'); return ['az login --service-principal -u "$AZURE_CLIENT_ID" -p "$AZURE_CLIENT_SECRET" --tenant "$AZURE_TENANT_ID"']; } job.id_tokens = { GITLAB_OIDC_TOKEN: { aud: 'api://AzureADTokenExchange' } }; ctx.note('Azure OIDC: add a federated credential for gitlab.com on the app registration.'); return ['az login --service-principal -u "$AZURE_CLIENT_ID" --tenant "$AZURE_TENANT_ID" --federated-token "$GITLAB_OIDC_TOKEN"']; },
  'docker/setup-buildx-action': (w, job, ctx) => { dind(job, ctx); return ['docker buildx create --use']; },
  'docker/setup-qemu-action': (w, job, ctx) => { dind(job, ctx); return ['docker run --privileged --rm tonistiigi/binfmt --install all']; },
  'docker/login-action': (w, job, ctx) => { dind(job, ctx); const reg = subst(String(w.registry || ''), ctx); const user = subst(String(w.username || ''), ctx); const pass = subst(String(w.password || ''), ctx); if (/ghcr\.io/.test(reg) || (!reg && /CI_JOB_TOKEN|GITLAB_USER_LOGIN/.test(user + pass))) return ['echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"']; return [`echo "${pass}" | docker login -u "${user}" --password-stdin ${reg || 'docker.io'}`.trim()]; },
  'docker/build-push-action': (w, job, ctx) => {
    dind(job, ctx);
    const tags = asList(typeof w.tags === 'string' ? w.tags.split('\n') : w.tags).map((t) => subst(String(t).trim(), ctx).replace(/ghcr\.io\/\$CI_PROJECT_PATH/g, '$CI_REGISTRY_IMAGE')).filter(Boolean);
    const args = [];
    if (w.file) args.push(`-f ${subst(String(w.file), ctx)}`);
    if (w.platforms) args.push(`--platform ${String(w.platforms).replace(/\s+/g, '')}`);
    for (const a of asList(typeof w['build-args'] === 'string' ? w['build-args'].split('\n') : w['build-args']).map((x) => subst(String(x).trim(), ctx)).filter(Boolean)) args.push(`--build-arg ${a}`);
    if (w.target) args.push(`--target ${w.target}`);
    if (w['cache-from'] && /type=gha/.test(String(w['cache-from']))) ctx.note('`cache-from: type=gha` became a registry cache on `$CI_REGISTRY_IMAGE:buildcache`.');
    if (w['cache-from']) args.push(/type=gha/.test(String(w['cache-from'])) ? '--cache-from type=registry,ref=$CI_REGISTRY_IMAGE:buildcache' : `--cache-from ${subst(String(w['cache-from']), ctx)}`);
    if (w['cache-to']) args.push(/type=gha/.test(String(w['cache-to'])) ? '--cache-to type=registry,ref=$CI_REGISTRY_IMAGE:buildcache,mode=max' : `--cache-to ${subst(String(w['cache-to']), ctx)}`);
    if (tags.some((t) => /steps\.|\$\{\{/.test(t))) ctx.note('Image tags came from `docker/metadata-action`; set them explicitly (for example `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA`).');
    const tagArgs = (tags.length ? tags : ['$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA']).map((t) => `-t ${t}`).join(' ');
    const push = w.push === true || String(w.push) === 'true' || /\$/.test(String(w.push || ''));
    const ctxDir = subst(String(w.context || '.'), ctx);
    const buildx = w.platforms || w['cache-to'] || w['cache-from'];
    const cmd = `docker ${buildx ? 'buildx ' : ''}build ${args.join(' ')} ${tagArgs} ${buildx ? (push ? '--push ' : '--load ') : ''}${ctxDir}`.replace(/\s+/g, ' ').trim();
    const lines = [cmd];
    if (push && !buildx) lines.push(...(tags.length ? tags : ['$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA']).map((t) => `docker push ${t}`));
    if (/\$/.test(String(w.push || '')) && !/^(true|false)$/.test(String(w.push))) ctx.note(`\`push: ${w.push}\` is conditional; the push lines run unconditionally, wrap them in a shell \`if\` or split the job.`);
    return lines;
  },
  'docker/metadata-action': (w, job, ctx) => { ctx.note('`docker/metadata-action` has no equivalent; tags/labels were replaced by `$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA` in the build step.'); return ['export DOCKER_TAGS="$CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA"']; },
  'actions/cache': (w, job, ctx, ref, step) => { cacheFromStep(step.with || {}, job, ctx, step.uses.includes('/restore') ? 'pull' : step.uses.includes('/save') ? 'push' : null); return null; },
  'actions/cache/restore': (w, job, ctx, ref, step) => { cacheFromStep(step.with || {}, job, ctx, 'pull'); return null; },
  'actions/cache/save': (w, job, ctx, ref, step) => { cacheFromStep(step.with || {}, job, ctx, 'push'); return null; },
  'actions/upload-artifact': (w, job, ctx, ref, step) => {
    const paths = asList(typeof w.path === 'string' ? w.path.split('\n') : w.path).map((p) => subst(String(p).trim(), ctx)).filter((p) => p && !p.startsWith('!'));
    const excl = asList(typeof w.path === 'string' ? w.path.split('\n') : w.path).map((p) => String(p).trim()).filter((p) => p.startsWith('!')).map((p) => p.slice(1));
    const a = job.artifacts || (job.artifacts = {});
    a.paths = [...new Set([...(a.paths || []), ...paths])];
    if (excl.length) a.exclude = [...(a.exclude || []), ...excl];
    if (w.name && !a.name) a.name = subst(String(w.name), ctx);
    if (w['retention-days']) a.expire_in = `${w['retention-days']} days`;
    if (step.if && /always\(\)/.test(String(step.if))) a.when = 'always';
    if (w.name) ctx.artifactsByName[subst(String(w.name), ctx)] = job.__id;
    if (w['if-no-files-found'] === 'error') ctx.note('`if-no-files-found: error` has no equivalent; GitLab only warns when artifact paths match nothing.');
    return null;
  },
  'actions/upload-pages-artifact': (w, job, ctx) => { const a = job.artifacts || (job.artifacts = {}); a.paths = [...new Set([...(a.paths || []), 'public'])]; const src = subst(String(w.path || '_site'), ctx); job.__pages = src; return src !== 'public' ? [`rm -rf public && mv ${src} public`] : null; },
  'actions/deploy-pages': (w, job, ctx) => { job.__pagesJob = true; return null; },
  'actions/configure-pages': () => null,
  'peaceiris/actions-gh-pages': (w, job, ctx) => { job.__pagesJob = true; const a = job.artifacts || (job.artifacts = {}); a.paths = ['public']; const src = subst(String(w.publish_dir || './public'), ctx).replace(/^\.\//, ''); return src !== 'public' ? [`rm -rf public && mv ${src} public`] : null; },
  'JamesIves/github-pages-deploy-action': (w, job, ctx) => { job.__pagesJob = true; const a = job.artifacts || (job.artifacts = {}); a.paths = ['public']; const src = subst(String(w.folder || 'public'), ctx).replace(/^\.\//, ''); return src !== 'public' ? [`rm -rf public && mv ${src} public`] : null; },
  'actions/download-artifact': (w, job, ctx) => {
    const name = w.name ? subst(String(w.name), ctx) : null;
    const from = name && findProducer(name, ctx);
    if (from) { const cur = asList(job.needs).map((n) => (typeof n === 'object' ? n.job : n)); if (!cur.includes(from)) job.needs = [...asList(job.needs), { job: from, artifacts: true }]; }
    else if (!name) { ctx.note('`actions/download-artifact` without a name downloads everything; GitLab passes the artifacts of every job in `needs:` automatically.'); }
    else ctx.note(`Artifact \`${name}\` is not uploaded by a job in this workflow; add \`needs:\` on the job that produces it (or \`needs: project:\` for another pipeline).`);
    if (w.path && String(w.path) !== '.') ctx.note(`\`actions/download-artifact\` wrote to \`${w.path}\`; GitLab restores artifacts to their original paths, so adjust commands that read from \`${w.path}\`.`);
    return null;
  },
  'actions/github-script': (w, job, ctx) => { ctx.note('`actions/github-script` runs JavaScript against the GitHub API; rewrite it against the GitLab API (`$CI_API_V4_URL`) with `glab` or curl.'); return todo('actions/github-script', String(w.script || '').slice(0, 400)); },
  'codecov/codecov-action': (w, job, ctx) => { ctx.secret('CODECOV_TOKEN'); return ['curl -Os https://cli.codecov.io/latest/linux/codecov && chmod +x codecov', `./codecov upload-process -t "$CODECOV_TOKEN"${w.files ? ` -f ${String(w.files).split(',')[0].trim()}` : ''}${w.flags ? ` -F ${w.flags}` : ''}`]; },
  'coverallsapp/github-action': (w, job, ctx) => { ctx.secret('COVERALLS_REPO_TOKEN'); return ['pip install coveralls 2>/dev/null || npm i -g coveralls', 'coveralls || npx coveralls < lcov.info']; },
  'mikepenz/action-junit-report': (w, job, ctx) => junit(w.report_paths, job, ctx), 'dorny/test-reporter': (w, job, ctx) => junit(w.path, job, ctx), 'EnricoMi/publish-unit-test-result-action': (w, job, ctx) => junit(w.files || w.junit_files, job, ctx), 'test-summary/action': (w, job, ctx) => junit(w.paths, job, ctx),
  'softprops/action-gh-release': (w, job, ctx) => release(w, job, ctx), 'ncipollo/release-action': (w, job, ctx) => release({ ...w, files: w.artifacts }, job, ctx), 'actions/create-release': (w, job, ctx) => release(w, job, ctx), 'marvinpinto/action-automatic-releases': (w, job, ctx) => release(w, job, ctx),
  'goreleaser/goreleaser-action': (w, job, ctx) => { setImage(job, ctx, { name: 'goreleaser/goreleaser:latest', entrypoint: [''] }, 'goreleaser'); ctx.note('GoReleaser publishes to GitLab releases when `GITLAB_TOKEN` is set; see the `release.gitlab` section of its docs.'); return [`goreleaser ${String(w.args || 'release --clean')}`]; },
  'cycjimmy/semantic-release-action': (w, job, ctx) => { ctx.secret('GITLAB_TOKEN'); ctx.note('semantic-release needs `@semantic-release/gitlab` instead of `@semantic-release/github`, and a `GITLAB_TOKEN` with api scope.'); return ['npx semantic-release']; },
  'pypa/gh-action-pypi-publish': (w, job, ctx) => { ctx.secret('PYPI_API_TOKEN'); return ['pip install twine', `TWINE_USERNAME=__token__ TWINE_PASSWORD="$PYPI_API_TOKEN" twine upload ${w.repository_url ? `--repository-url ${w.repository_url} ` : ''}${w.packages_dir || 'dist'}/*`]; },
  'JS-DevTools/npm-publish': (w, job, ctx) => { ctx.secret('NPM_TOKEN'); return ['echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc', `npm publish${w.access ? ` --access ${w.access}` : ''}`]; },
  'pre-commit/action': () => ['pip install pre-commit', 'pre-commit run --all-files --show-diff-on-failure'],
  'golangci/golangci-lint-action': (w, job, ctx) => [`curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b "$(go env GOPATH)/bin" ${version(w.version) && w.version !== 'latest' ? 'v' + version(w.version) : ''}`.trim(), `"$(go env GOPATH)/bin/golangci-lint" run ${w.args || ''}`.trim()],
  'astral-sh/setup-uv': () => ['curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"'],
  'astral-sh/ruff-action': (w) => ['pip install ruff', `ruff ${w.args || 'check'}`],
  'gradle/actions/setup-gradle': (w, job, ctx) => { addCache(job, keyFromFiles('gradle/wrapper/gradle-wrapper.properties'), ['.gradle/caches', '.gradle/wrapper'], ctx); job.variables = { GRADLE_USER_HOME: '$CI_PROJECT_DIR/.gradle', ...(job.variables || {}) }; return w.arguments ? [`./gradlew ${w.arguments}`] : null; },
  'gradle/gradle-build-action': (w, job, ctx) => ACTIONS['gradle/actions/setup-gradle'](w, job, ctx),
  'subosito/flutter-action': (w, job, ctx) => { if (!setImage(job, ctx, `ghcr.io/cirruslabs/flutter:${version(w['flutter-version']) || 'stable'}`, 'subosito/flutter-action')) return ['# TODO: install Flutter in this image']; return null; },
  'webfactory/ssh-agent': (w, job, ctx) => { const key = subst(String(w['ssh-private-key'] || '$SSH_PRIVATE_KEY'), ctx); return ['eval "$(ssh-agent -s)"', `echo "${key}" | tr -d '\\r' | ssh-add -`, 'mkdir -p ~/.ssh && chmod 700 ~/.ssh', 'ssh-keyscan github.com gitlab.com >> ~/.ssh/known_hosts 2>/dev/null']; },
  'shimataro/ssh-key-action': (w, job, ctx) => { const key = subst(String(w.key || '$SSH_PRIVATE_KEY'), ctx); return ['mkdir -p ~/.ssh && chmod 700 ~/.ssh', `echo "${key}" > ~/.ssh/${w.name || 'id_rsa'} && chmod 600 ~/.ssh/${w.name || 'id_rsa'}`, w.known_hosts && w.known_hosts !== 'unnecessary' ? `echo "${subst(String(w.known_hosts), ctx)}" >> ~/.ssh/known_hosts` : 'echo "StrictHostKeyChecking no" >> ~/.ssh/config']; },
  'appleboy/ssh-action': (w, job, ctx) => { const host = subst(String(w.host || ''), ctx), user = subst(String(w.username || ''), ctx); const lines = ['mkdir -p ~/.ssh && chmod 700 ~/.ssh']; if (w.key) lines.push(`echo "${subst(String(w.key), ctx)}" > ~/.ssh/deploy_key && chmod 600 ~/.ssh/deploy_key`); lines.push(`ssh -o StrictHostKeyChecking=no ${w.key ? '-i ~/.ssh/deploy_key ' : ''}${w.port ? `-p ${w.port} ` : ''}${user}@${host} '${String(w.script || '').trim().replace(/'/g, "'\\''")}'`); return lines; },
  'appleboy/scp-action': (w, job, ctx) => [`scp -o StrictHostKeyChecking=no -r ${subst(String(w.source || '.'), ctx)} ${subst(String(w.username || ''), ctx)}@${subst(String(w.host || ''), ctx)}:${subst(String(w.target || '~'), ctx)}`],
  'burnett01/rsync-deployments': (w, job, ctx) => [`rsync ${w.switches || '-avzr --delete'} -e "ssh -o StrictHostKeyChecking=no" ${subst(String(w.path || './'), ctx)} ${subst(String(w.remote_user || ''), ctx)}@${subst(String(w.remote_host || ''), ctx)}:${subst(String(w.remote_path || ''), ctx)}`],
  'cloudflare/wrangler-action': (w, job, ctx) => { ctx.secret('CLOUDFLARE_API_TOKEN'); return [`npx wrangler ${w.command || 'deploy'}`]; },
  'superfly/flyctl-actions/setup-flyctl': () => ['curl -L https://fly.io/install.sh | sh && export PATH="$HOME/.fly/bin:$PATH"'],
  'amondnet/vercel-action': (w, job, ctx) => { ctx.secret('VERCEL_TOKEN'); return [`npx vercel ${/prod/.test(String(w['vercel-args'] || '')) ? '--prod ' : ''}--token "$VERCEL_TOKEN" --yes`]; },
  'nwtgck/actions-netlify': (w, job, ctx) => { ctx.secret('NETLIFY_AUTH_TOKEN'); ctx.secret('NETLIFY_SITE_ID'); return [`npx netlify-cli deploy ${w['production-deploy'] ? '--prod ' : ''}--dir ${w['publish-dir'] || 'dist'}`]; },
  'akhileshns/heroku-deploy': (w, job, ctx) => { ctx.secret('HEROKU_API_KEY'); return [`git push https://heroku:$HEROKU_API_KEY@git.heroku.com/${subst(String(w.heroku_app_name || 'APP'), ctx)}.git HEAD:main`]; },
  'slackapi/slack-github-action': (w, job, ctx) => slack(w.payload || w['slack-message'] || w.text, ctx), '8398a7/action-slack': (w, job, ctx) => slack(w.text || w.custom_payload || 'Pipeline $CI_PIPELINE_URL: $CI_JOB_STATUS', ctx), 'rtCamp/action-slack-notify': (w, job, ctx) => slack('Pipeline $CI_PIPELINE_URL: $CI_JOB_STATUS', ctx),
  'stefanzweifel/git-auto-commit-action': (w, job, ctx) => { ctx.note('Pushing from a pipeline needs a project access token in `GIT_PUSH_TOKEN` (CI_JOB_TOKEN cannot push).'); ctx.secret('GIT_PUSH_TOKEN'); return ['git config user.name "gitlab-ci" && git config user.email "gitlab-ci@$CI_SERVER_HOST"', `git add -A && git diff --cached --quiet || (git commit -m "${subst(String(w.commit_message || 'Apply automatic changes'), ctx)}" && git push "https://oauth2:$GIT_PUSH_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git" HEAD:$CI_COMMIT_REF_NAME)`]; },
  'ad-m/github-push-action': (w, job, ctx) => { ctx.secret('GIT_PUSH_TOKEN'); return [`git push "https://oauth2:$GIT_PUSH_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git" HEAD:${subst(String(w.branch || '$CI_COMMIT_REF_NAME'), ctx)}${w.tags ? ' --tags' : ''}`]; },
  'peter-evans/create-pull-request': (w, job, ctx) => { ctx.secret('GIT_PUSH_TOKEN'); ctx.note('`peter-evans/create-pull-request` became a push plus `glab mr create`; install glab in the image or use the merge request API.'); return [`git checkout -B ${subst(String(w.branch || 'automated-changes'), ctx)} && git add -A && git commit -m "${subst(String(w['commit-message'] || 'Automated changes'), ctx)}" || true`, `git push -o merge_request.create -o merge_request.title="${subst(String(w.title || 'Automated changes'), ctx)}" "https://oauth2:$GIT_PUSH_TOKEN@$CI_SERVER_HOST/$CI_PROJECT_PATH.git" HEAD`]; },
  'tj-actions/changed-files': (w, job, ctx) => { ctx.note('`tj-actions/changed-files` became a `git diff` against the merge request base; outputs like `all_changed_files` are in `$CHANGED_FILES`.'); return ['git fetch origin "${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-$CI_DEFAULT_BRANCH}" --depth=50 2>/dev/null || true', 'export CHANGED_FILES="$(git diff --name-only "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-${CI_COMMIT_BEFORE_SHA:-HEAD~1}}" HEAD | tr \'\\n\' \' \')"']; },
  'dorny/paths-filter': (w, job, ctx) => { ctx.note('`dorny/paths-filter` has no step equivalent; use `rules: changes:` on the jobs that depend on it.'); return ['# TODO: replace dorny/paths-filter with rules: changes: on the dependent jobs']; },
  'nick-fields/retry': (w, job, ctx) => { job.retry = Math.min(2, Number(w.max_attempts || 2) - 1) || 1; return [String(w.command || '')]; },
  'styfle/cancel-workflow-action': (w, job, ctx) => { job.interruptible = true; return null; },
  'github/codeql-action/init': (w, job, ctx) => { ctx.includes.push('Jobs/SAST.gitlab-ci.yml'); job.__drop = 'CodeQL became the GitLab SAST template'; return null; }, 'github/codeql-action/analyze': (w, job) => { job.__drop = 'CodeQL became the GitLab SAST template'; return null; }, 'github/codeql-action/autobuild': () => null, 'github/codeql-action/upload-sarif': () => null,
  'aquasecurity/trivy-action': (w, job, ctx) => { if (w['image-ref']) { ctx.includes.push('Jobs/Container-Scanning.gitlab-ci.yml'); ctx.note('Trivy image scanning became the Container Scanning template; set `CS_IMAGE` to the image to scan.'); return null; } return [`curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin`, `trivy ${w['scan-type'] || 'fs'} ${w.severity ? `--severity ${w.severity} ` : ''}${w['exit-code'] ? `--exit-code ${w['exit-code']} ` : ''}${w['scan-ref'] || '.'}`]; },
  'trufflesecurity/trufflehog': (w, job, ctx) => { ctx.includes.push('Jobs/Secret-Detection.gitlab-ci.yml'); job.__drop = 'secret scanning became the GitLab Secret Detection template'; return null; }, 'gitleaks/gitleaks-action': (w, job, ctx) => { ctx.includes.push('Jobs/Secret-Detection.gitlab-ci.yml'); job.__drop = 'secret scanning became the GitLab Secret Detection template'; return null; },
  'actions/dependency-review-action': (w, job, ctx) => { ctx.includes.push('Jobs/Dependency-Scanning.gitlab-ci.yml'); job.__drop = 'dependency review became the GitLab Dependency Scanning template'; return null; },
  'snyk/actions': (w, job, ctx) => { ctx.secret('SNYK_TOKEN'); return ['npm i -g snyk', `snyk ${w.command || 'test'} ${w.args || ''}`.trim()]; },
  'sonarsource/sonarcloud-github-action': (w, job, ctx) => sonar(w, job, ctx), 'SonarSource/sonarcloud-github-action': (w, job, ctx) => sonar(w, job, ctx), 'sonarsource/sonarqube-scan-action': (w, job, ctx) => sonar(w, job, ctx), 'SonarSource/sonarqube-scan-action': (w, job, ctx) => sonar(w, job, ctx),
  'actions/stale': (w, job) => { job.__drop = 'repository automation (stale issues) is not CI; use GitLab issue policies'; return null; }, 'actions/labeler': (w, job) => { job.__drop = 'repository automation (labeler) is not CI'; return null; }, 'release-drafter/release-drafter': (w, job) => { job.__drop = 'release drafting is not CI; GitLab has release notes from changelog'; return null; }, 'amannn/action-semantic-pull-request': (w, job) => { job.__drop = 'PR title linting is not CI; use GitLab push rules or a commit-lint job'; return null; }, 'actions/first-interaction': (w, job) => { job.__drop = 'first-interaction greeting has no GitLab equivalent'; return null; }, 'dependabot/fetch-metadata': (w, job) => { job.__drop = 'Dependabot automation has no GitLab equivalent; see GitLab dependency updates'; return null; }, 'actions/add-to-project': (w, job) => { job.__drop = 'project boards automation has no GitLab equivalent'; return null; },
  'actions/create-github-app-token': (w, job, ctx) => { ctx.secret('GIT_PUSH_TOKEN'); ctx.note('GitHub App tokens became a project access token in `GIT_PUSH_TOKEN`.'); return null; }, 'tibdex/github-app-token': (w, job, ctx) => ACTIONS['actions/create-github-app-token'](w, job, ctx),
  'actions/attest-build-provenance': (w, job, ctx) => { ctx.note('Build provenance attestations became SLSA provenance artifacts (`RUNNER_GENERATE_ARTIFACTS_METADATA`).'); job.variables = { RUNNER_GENERATE_ARTIFACTS_METADATA: 'true', ...(job.variables || {}) }; return null; },
  'sigstore/cosign-installer': () => ['curl -sSfL -o /usr/local/bin/cosign https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 && chmod +x /usr/local/bin/cosign'],
  'cachix/install-nix-action': (w, job, ctx) => { if (!setImage(job, ctx, 'nixos/nix:latest', 'install-nix-action')) return ['curl -L https://nixos.org/nix/install | sh -s -- --no-daemon && . ~/.nix-profile/etc/profile.d/nix.sh']; return null; }, 'DeterminateSystems/nix-installer-action': (w, job, ctx) => ACTIONS['cachix/install-nix-action'](w, job, ctx),
  'conda-incubator/setup-miniconda': (w, job, ctx) => { if (!setImage(job, ctx, 'continuumio/miniconda3:latest', 'setup-miniconda')) return ['# TODO: install conda in this image']; return w['environment-file'] ? [`conda env update -n base -f ${w['environment-file']}`] : null; },
  'julia-actions/setup-julia': (w, job, ctx) => { if (!setImage(job, ctx, `julia:${version(w.version) || 'latest'}`, 'setup-julia')) return ['# TODO: install Julia in this image']; return null; },
  'r-lib/actions/setup-r': (w, job, ctx) => { if (!setImage(job, ctx, `rocker/r-ver:${version(w['r-version']) || 'latest'}`, 'setup-r')) return ['# TODO: install R in this image']; return null; },
  'haskell-actions/setup': (w, job, ctx) => { if (!setImage(job, ctx, `haskell:${version(w['ghc-version']) || 'latest'}`, 'haskell-actions/setup')) return ['# TODO: install GHC in this image']; return null; },
  'microsoft/setup-msbuild': (w, job, ctx) => ['# MSBuild is on the Windows runner image'], 'ilammy/msvc-dev-cmd': () => ['# TODO: call vcvarsall.bat on the Windows runner'],
  'android-actions/setup-android': (w, job, ctx) => { if (!setImage(job, ctx, 'ghcr.io/cirruslabs/android-sdk:34', 'setup-android')) return ['# TODO: install the Android SDK in this image']; return null; },
};
function todo(title, raw) { const body = String(raw || '').split('\n').slice(0, 12).map((l) => '# ' + l); return [`# TODO: ${title}`, ...body, 'echo "TODO: unconverted step" && exit 1'].join('\n'); }
function dind(job, ctx) { if (job.__dind) return; job.__dind = true; if (!job.image || job.image === ctx.opts.image) { job.image = 'docker:27'; job.__imageFromSetup = 'docker'; } job.services = [...asList(job.services), 'docker:27-dind']; job.variables = { DOCKER_TLS_CERTDIR: '/certs', ...(job.variables || {}) }; ctx.note('Docker jobs use the `docker:27` image with a `docker:27-dind` service; self-managed runners need `privileged = true` for Docker-in-Docker.'); }
function cacheFromStep(w, job, ctx, policy) {
  const raw = asList(typeof w.path === 'string' ? w.path.split('\n') : w.path).map((p) => subst(String(p).trim(), ctx)).filter(Boolean);
  const paths = raw.map((p) => p.replace(/^~\//, '').replace(/^\$HOME\//, '').replace(/^\$CI_PROJECT_DIR\//, ''));
  let key = subst(String(w.key || 'cache'), ctx);
  const hf = /hashFiles\(([^)]*)\)/.exec(String(w.key || ''));
  let k;
  if (hf) { const files = splitArgs(hf[1]).map((a) => a.trim().replace(/^'|'$/g, '')); k = keyFromFiles(files); const prefix = String(w.key).replace(/\$\{\{\s*runner\.os\s*\}\}-?/g, '').replace(/-?\$\{\{\s*hashFiles\([^)]*\)\s*\}\}/, '').replace(/\$\{\{[^}]*\}\}/g, '').replace(/-+$/, ''); if (prefix) k.prefix = prefix; if (files.some((f) => /\*/.test(f))) ctx.note(`Cache key \`hashFiles(${files.join(', ')})\` became \`cache:key:files\`, which needs exact paths (no globs); check \`${files.map((f) => f.replace(/^\*\*\//, '')).join(', ')}\`.`); }
  else k = key.replace(/\$\{\{\s*runner\.os\s*\}\}-?/g, '').replace(/\$\{\{[^}]*\}\}/g, '').replace(/^-|-$/g, '') || 'cache';
  const extra = {};
  if (raw.some((p) => p.startsWith('~') || p.startsWith('$HOME') || p.startsWith('/'))) ctx.note('Cache paths outside the project directory (`~/.npm`, `~/.cache`) cannot be cached by GitLab; point the tool at a directory inside `$CI_PROJECT_DIR` (for example `npm_config_cache=$CI_PROJECT_DIR/.npm`).');
  if (w['restore-keys']) { const rk = asList(typeof w['restore-keys'] === 'string' ? w['restore-keys'].split('\n') : w['restore-keys']).map((r) => String(r).replace(/\$\{\{\s*runner\.os\s*\}\}-?/g, '').replace(/\$\{\{[^}]*\}\}/g, '').replace(/-+$/, '').trim()).filter(Boolean); if (rk.length) extra.fallback_keys = rk; }
  if (policy) extra.policy = policy;
  addCache(job, k, paths, ctx, extra);
}
function findProducer(name, ctx) {
  if (ctx.artifactsByName[name]) return ctx.artifactsByName[name];
  for (const [k, v] of Object.entries(ctx.artifactsByName)) if (k.includes('$') && new RegExp('^' + reEsc(k).replace(/\\\$[A-Za-z0-9_]+/g, '.+') + '$').test(name)) return v;
  return null;
}
function junit(paths, job, ctx) { const a = job.artifacts || (job.artifacts = {}); a.reports = { ...(a.reports || {}), junit: asList(typeof paths === 'string' ? paths.split(/[\n,]/) : paths).map((p) => String(p).trim()).filter(Boolean) }; a.when = 'always'; return null; }
function release(w, job, ctx) {
  job.image = { name: 'registry.gitlab.com/gitlab-org/release-cli:latest', entrypoint: [''] }; job.__imageFromSetup = 'release-cli';
  const tag = subst(String(w.tag_name || w.tag || w.automatic_release_tag || '$CI_COMMIT_TAG'), ctx);
  job.release = { tag_name: tag, description: subst(String(w.body || w.name || w.title || `Release ${tag}`), ctx).slice(0, 500) };
  if (w.body_path) job.release.description = `$(cat ${w.body_path})`;
  if (!job.rules) job.rules = [{ if: '$CI_COMMIT_TAG' }];
  if (w.files || w.artifacts) ctx.note('Release assets (`files:`) must be uploaded to the package registry or generic packages and linked with `release:assets:links`; the uploads were not generated.');
  return null;
}
function slack(text, ctx) { ctx.secret('SLACK_WEBHOOK_URL'); const msg = typeof text === 'object' ? JSON.stringify(text) : String(text || 'Pipeline $CI_PIPELINE_URL finished: $CI_JOB_STATUS'); return [`curl -sS -X POST -H 'Content-type: application/json' --data '{"text": "${subst(msg, ctx).replace(/'/g, "'\\''").replace(/"/g, '\\"')}"}' "$SLACK_WEBHOOK_URL"`]; }
function sonar(w, job, ctx) { ctx.secret('SONAR_TOKEN'); job.image = { name: 'sonarsource/sonar-scanner-cli:latest', entrypoint: [''] }; job.__imageFromSetup = 'sonar'; return [`sonar-scanner ${w.args || ''}`.trim()]; }

function actionKey(uses) { const u = String(uses).split('@')[0]; if (ACTIONS[u]) return u; const parts = u.split('/'); for (let i = parts.length; i >= 2; i--) { const k = parts.slice(0, i).join('/'); if (ACTIONS[k] !== undefined) return k; } return null; }

// ---------------------------------------------------------------- jobs

function timeoutOf(min) { const n = Number(min); if (!n) return undefined; return n % 60 === 0 ? `${n / 60}h` : n > 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n}m`; }

function matrixOf(strategy, job, ctx) {
  const m = strategy && strategy.matrix;
  if (!m) return;
  if (typeof m === 'string') { ctx.note(`Dynamic matrix \`${m}\` cannot be expressed statically; write the \`parallel: matrix:\` entries by hand.`); job.parallel = { matrix: [{ TODO: ['dynamic matrix'] }] }; return; }
  let entries = [];
  const base = {};
  const objDims = [];
  for (const [k, v] of Object.entries(m)) {
    if (k === 'include' || k === 'exclude') continue;
    if (asList(v).some((x) => typeof x === 'object' && x !== null)) { objDims.push([k, asList(v)]); continue; }
    const name = upperVar(k); ctx.matrixVars[k] = name;
    base[name] = asList(v).map((x) => subst(String(x), ctx));
  }
  if (Object.keys(base).length) entries.push(base);
  // A dimension whose values are objects ({target: …, arch: …}) becomes one row per object with flattened variables.
  for (const [k, vals] of objDims) {
    const flat = (obj, prefix) => Object.entries(obj).flatMap(([a, b]) => (b && typeof b === 'object' && !Array.isArray(b) ? flat(b, `${prefix}.${a}`) : [[`${prefix}.${a}`, b]]));
    const rows = [];
    for (const v of vals) {
      const row = {};
      if (v && typeof v === 'object') for (const [path, val] of flat(v, k)) { const name = upperVar(path.replace(/\./g, '_')); ctx.matrixVars[path] = name; row[name] = [typeof val === 'object' ? JSON.stringify(val) : subst(String(val), ctx)]; }
      else { const name = upperVar(k); ctx.matrixVars[k] = name; row[name] = [subst(String(v), ctx)]; }
      rows.push(row);
    }
    entries = entries.length ? entries.flatMap((e) => rows.map((r) => ({ ...e, ...r }))) : rows;
    ctx.note(`Matrix dimension \`${k}\` holds objects; each became its own \`parallel: matrix\` row with variables like \`${Object.keys(rows[0] || {}).join(', ')}\`.`);
  }
  for (const inc of asList(m.include)) {
    if (typeof inc !== 'object' || inc === null) continue;
    const extraKeys = Object.keys(inc).filter((k) => !ctx.matrixVars[k]);
    if (Object.keys(base).length && !extraKeys.length) { ctx.note('`matrix.include` entries that only add combinations were appended as extra `parallel: matrix` rows.'); }
    else if (Object.keys(base).length) { ctx.note(`\`matrix.include\` adds \`${extraKeys.join(', ')}\` to some combinations; GitLab cannot extend rows, so those entries became separate rows and the extra variables default to empty elsewhere.`); }
    const row = {};
    for (const [k, v] of Object.entries(inc)) { const name = ctx.matrixVars[k] || (ctx.matrixVars[k] = upperVar(k)); row[name] = [typeof v === 'object' && v !== null ? JSON.stringify(v) : subst(String(v), ctx)]; }
    entries.push(row);
  }
  if (m.exclude) ctx.note('`matrix.exclude` has no equivalent; the excluded combinations are still generated, remove them by splitting the matrix rows.');
  if (strategy['fail-fast'] === false) ctx.note('`fail-fast: false` is the GitLab default; matrix jobs do not cancel each other.');
  if (strategy['max-parallel']) ctx.note('`max-parallel` has no equivalent; limit concurrency on the runner instead.');
  const vals = (e) => Object.values(e).map((a) => a.length);
  if (entries.length) job.parallel = { matrix: entries.map((e) => Object.fromEntries(Object.entries(e).map(([k, a]) => [k, a.length === 1 ? a[0] : a]))) };
  const total = entries.reduce((n, e) => n + vals(e).reduce((a, b) => a * b, 1), 0);
  if (total > 200) ctx.note(`Matrix expands to ${total} jobs; GitLab allows at most 200 per \`parallel: matrix\`.`);
}

function convertJob(id, j, ctx, wf, order) {
  const job = { __id: id };
  if (j.uses) {
    const u = String(j.uses);
    const local = /^\.\//.test(u);
    job.trigger = { include: local ? [{ local: u.replace(/^\.\/\.github\/workflows\//, '.gitlab/ci/').replace(/\.ya?ml$/, '.gitlab-ci.yml') }] : [{ project: u.split('/.github/')[0], file: '/' + u.replace(/^[^/]+\/[^/]+\//, '').replace(/@.*$/, '').replace(/\.github\/workflows\//, '.gitlab/ci/').replace(/\.ya?ml$/, '.gitlab-ci.yml'), ref: (u.split('@')[1] || 'main') }], strategy: 'depend' };
    if (j.with) job.variables = Object.fromEntries(Object.entries(j.with).map(([k, v]) => [upperVar(k), subst(str(v), ctx)]));
    ctx.note(`Job \`${id}\` calls the reusable workflow \`${u}\`; it became a child pipeline (\`trigger: include:\`). Convert that workflow separately to the path in \`include:\`.`);
    if (j.needs) job.needs = asList(j.needs).map(String);
    const c = j.if ? condition(j.if, ctx) : null; if (c && c.if) job.rules = [{ if: c.if }];
    delete job.__id; return job;
  }
  if (j.name && String(j.name) !== id) job.__comment = subst(String(j.name), ctx);
  let runsOn = j['runs-on'];
  let strategy = j.strategy;
  const mos = typeof runsOn === 'string' && /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(runsOn);
  if (mos && strategy && strategy.matrix && typeof strategy.matrix === 'object') {
    const key = mos[1]; const vals = asList(strategy.matrix[key]).map(String);
    if (vals.length && vals.every((v) => /ubuntu/.test(v))) {
      const { [key]: _drop, ...rest } = strategy.matrix;
      strategy = { ...strategy, matrix: { ...rest, ...(rest.include ? { include: asList(rest.include).map((e) => { const { [key]: _d, ...r } = e; return r; }) } : {}) } };
      runsOn = 'ubuntu-latest';
    } else ctx.note(`Matrix dimension \`${key}\` selects the operating system (${vals.join(', ')}); GitLab cannot pick runners per matrix row, split the job per OS and add \`tags:\`.`);
  }
  runnerOf(runsOn, job, ctx);
  if (j.container) { const c = typeof j.container === 'string' ? { image: j.container } : j.container; job.image = subst(String(c.image), ctx); if (c.credentials) ctx.note(`Job \`${id}\` pulls a private image; set \`DOCKER_AUTH_CONFIG\` as a CI/CD variable.`); if (c.env) job.variables = { ...(job.variables || {}), ...Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, subst(str(v), ctx)])) }; if (c.options || c.volumes) ctx.note(`Container \`options\`/\`volumes\` on job \`${id}\` need runner configuration (\`[runners.docker]\` volumes/privileged).`); }
  if (j.services) {
    job.services = Object.entries(j.services).map(([alias, s]) => { const svc = { name: subst(String(s.image || s), ctx), alias }; if (s.env) svc.variables = Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, subst(str(v), ctx)])); if (s.options && /--health/.test(String(s.options))) ctx.note(`Service \`${alias}\` had health-check options; GitLab waits for the service port instead (\`FF_NETWORK_PER_BUILD\` recommended).`); return svc; });
    if (Object.values(j.services).some((s) => s && s.ports)) ctx.note('Service `ports:` mappings are not needed on GitLab; services are reachable by alias on their native port.');
    for (const [alias, s] of Object.entries(j.services)) for (const p of asList(s && s.ports)) { const m = /^(\d+):(\d+)$/.exec(String(p)); if (m) job.__hostRewrites = [...(job.__hostRewrites || []), [new RegExp(`(localhost|127\\.0\\.0\\.1):${m[1]}\\b`, 'g'), `${alias}:${m[2]}`]]; }
    if (!job.image) ctx.note(`Job \`${id}\` uses services but no container; on GitLab the job runs in \`${ctx.opts.image}\` and reaches each service by its alias (not localhost).`);
  }
  if (j.needs) job.needs = asList(j.needs).map(String);
  if (j.environment) { const e = typeof j.environment === 'object' ? { name: subst(String(j.environment.name), ctx), ...(j.environment.url ? { url: subst(String(j.environment.url), ctx) } : {}) } : subst(String(j.environment), ctx); job.environment = e; }
  if (j['timeout-minutes']) job.timeout = timeoutOf(subst(String(j['timeout-minutes']), ctx));
  if (j['continue-on-error'] === true) job.allow_failure = true;
  if (j.concurrency) { const c = typeof j.concurrency === 'object' ? j.concurrency : { group: j.concurrency }; if (c['cancel-in-progress']) job.interruptible = true; if (c.group) job.resource_group = subst(String(c.group), ctx); }
  if (j.permissions) ctx.note('`permissions:` has no equivalent; `CI_JOB_TOKEN` scope is set in the project settings.');
  if (strategy) matrixOf(strategy, job, ctx);
  if (j.env) job.variables = { ...(job.variables || {}), ...Object.fromEntries(Object.entries(j.env).map(([k, v]) => [k, subst(str(v), ctx)])) };
  const hostFix = (s) => { for (const [re, to] of job.__hostRewrites || []) { if (re.test(s)) { ctx.note(`\`localhost\` in job \`${id}\` was rewritten to the service alias; GitLab reaches services by alias, not localhost.`); s = s.replace(re, to); } re.lastIndex = 0; } return s; };
  if (job.variables) for (const k of Object.keys(job.variables)) job.variables[k] = hostFix(String(job.variables[k]));
  const cond = j.if ? condition(j.if, ctx) : null;
  if (cond) {
    if (cond.todo) { job.rules = [{ __comment: `TODO: condition could not be translated: ${cond.todo}`, when: 'on_success' }]; ctx.note(`Condition \`${cond.todo}\` on job \`${id}\` could not be translated; the job runs unconditionally until you fix the rule.`); }
    else if (cond.if) job.rules = [{ if: cond.if, ...(cond.when ? { when: cond.when } : {}) }];
    else if (cond.when) job.rules = [{ when: cond.when }];
  }
  const dflt = (j.defaults && j.defaults.run) || (wf.defaults && wf.defaults.run) || {};
  const script = [], before = [], after = [];
  let dotenvWritten = false;
  if (dflt['working-directory']) script.push(`cd ${subst(String(dflt['working-directory']), ctx)}`);
  if (dflt.shell && !/^(bash|sh)/.test(String(dflt.shell))) ctx.note(`Default shell \`${dflt.shell}\` is not bash; GitLab runs scripts with the image's shell, so adjust the commands.`);
  for (const step of asList(j.steps)) {
    if (!step || typeof step !== 'object') continue;
    const label = step.name ? subst(String(step.name), ctx) : null;
    const c = step.if ? condition(step.if, ctx) : null;
    const target = c && c.when === 'always' ? after : c && c.when === 'on_failure' ? after : script;
    const lines = [];
    if (step.uses) {
      const key = actionKey(step.uses);
      const w = Object.fromEntries(Object.entries(step.with || {}).map(([k, v]) => [k, typeof v === 'string' ? subst(v, ctx) : v]));
      const ref = String(step.uses).split('@')[1];
      if (key && ACTIONS[key]) { const r = ACTIONS[key](w, job, ctx, ref, step); if (r) lines.push(...asList(r)); }
      else if (/^\.\//.test(String(step.uses))) { ctx.note(`Local composite action \`${step.uses}\` was not expanded; inline its steps or turn it into a \`!reference\` block.`); lines.push(todo(`local action ${step.uses}`, Object.entries(w).map(([k, v]) => `${k}: ${str(v)}`).join('\n'))); }
      else if (/docker:\/\//.test(String(step.uses))) { lines.push(`docker run --rm -v "$PWD:/work" -w /work ${String(step.uses).replace(/^docker:\/\//, '')} ${asList(step.args).join(' ')}`.trim()); dind(job, ctx); }
      else { ctx.note(`No mapping for action \`${String(step.uses).split('@')[0]}\`; it became a TODO step.`); lines.push(todo(`replace action ${step.uses}`, Object.entries(w).map(([k, v]) => `with ${k}: ${str(v)}`).join('\n'))); }
    } else if (step.run !== undefined) {
      let s = hostFix(shellRewrite(String(step.run), ctx, job));
      const sh = String(step.shell || dflt.shell || 'bash');
      if (/^(pwsh|powershell)/.test(sh)) { ctx.note(`Step \`${label || 'run'}\` uses PowerShell; the Linux image has no pwsh, install it or rewrite the step.`); s = `pwsh -Command '${s.replace(/'/g, "''")}'`; }
      else if (/^cmd/.test(sh)) { ctx.note(`Step \`${label || 'run'}\` uses cmd.exe; it must run on a Windows runner.`); }
      else if (/^python/.test(sh)) s = `python - <<'PYEOF'\n${s}\nPYEOF`;
      if (step['working-directory']) { const d = subst(String(step['working-directory']), ctx); s = `cd ${d}\n${s}\ncd "$CI_PROJECT_DIR"`; }
      if (step.env) { const exports = Object.entries(step.env).map(([k, v]) => `export ${sanitizeVar(k)}=${JSON.stringify(subst(str(v), ctx))}`); s = exports.join('\n') + '\n' + s; }
      if (step['continue-on-error'] === true) s = s.includes('\n') ? `(\n${s}\n) || true` : `${s} || true`;
      lines.push(s);
    }
    if (!lines.length) continue;
    if (c && (c.if || c.todo) && !(c.when === 'always' && !c.if && !c.todo)) {
      const t = c.if ? shellTest(c.if) : null;
      if (t) lines.splice(0, lines.length, `if ${t}; then\n${lines.join('\n').split('\n').map((l) => '  ' + l).join('\n')}\nfi`);
      else { ctx.note(`Step condition \`${step.if}\` could not be turned into a shell test; the step runs unconditionally with a TODO comment.`); lines.unshift(new Comment(`TODO: this step only ran when: ${String(step.if).replace(/\n/g, ' ')}`)); }
    }
    if (c && c.when === 'on_failure') lines.splice(0, lines.length, `if [ "$CI_JOB_STATUS" = "failed" ]; then\n${lines.join('\n').split('\n').map((l) => '  ' + l).join('\n')}\nfi`);
    if (label) target.push(new Comment(label));
    target.push(...lines);
    if (job.__sourceEnv && target === script) { target.push('set -a; . ./build.env 2>/dev/null; set +a'); job.__sourceEnv = false; }
    if (job.__dotenv && !dotenvWritten) { dotenvWritten = true; }
    if (step['timeout-minutes']) ctx.note(`Step-level \`timeout-minutes\` on \`${label || 'a step'}\` became nothing; use the job \`timeout\` or wrap the command in \`timeout\`.`);
  }
  if (job.__drop && !script.some((l) => typeof l === 'string' && !/^#/.test(l))) { ctx.note(`Job \`${id}\` was dropped: ${job.__drop}.`); return null; }
  if (job.__pagesJob) { job.__rename = 'pages'; ctx.note(`Job \`${id}\` deploys GitHub Pages; it became the \`pages\` job, which publishes the \`public/\` artifact to GitLab Pages.`); }
  if (dotenvWritten || job.__dotenv) { job.artifacts = job.artifacts || {}; job.artifacts.reports = { ...(job.artifacts.reports || {}), dotenv: 'build.env' }; script.unshift('touch build.env'); }
  if (j.outputs) ctx.note(`Job \`${id}\` declares outputs; they are passed to later jobs through the \`build.env\` dotenv report (write \`NAME=value\` lines to it).`);
  if (before.length) job.before_script = before;
  job.script = script.length ? script : ['echo "nothing to run"'];
  if (after.length) job.after_script = after;
  if (job.__dotenv && job.artifacts && job.artifacts.paths === undefined && !job.artifacts.reports.junit) { /* dotenv only */ }
  return job;
}

// ---------------------------------------------------------------- triggers -> workflow rules

function branchRule(v, b) { const s = String(b); if (/^\*\*?$/.test(s)) return `$${v}`; if (/[*?[]/.test(s)) return `$${v} =~ /^${reEsc(s).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '.')}$/`; return `$${v} == ${q(s)}`; }
function triggers(on, ctx, wf) {
  const rules = [];
  const notes = [];
  if (on === undefined || on === null) return { rules: [] };
  const ev = typeof on === 'string' ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on;
  const pushCfg = ev.push, pr = ev.pull_request !== undefined ? ev.pull_request : ev.pull_request_target;
  if (pr !== undefined) {
    const r = { if: '$CI_PIPELINE_SOURCE == "merge_request_event"' };
    const branches = asList(pr && (pr.branches || pr['branches-ignore']));
    if (pr && pr.branches && branches.length) r.if += ' && (' + branches.map((b) => branchRule('CI_MERGE_REQUEST_TARGET_BRANCH_NAME', b)).join(' || ') + ')';
    if (pr && pr['branches-ignore'] && branches.length) r.if += ' && ' + branches.map((b) => branchRule('CI_MERGE_REQUEST_TARGET_BRANCH_NAME', b).replace(' == ', ' != ').replace(' =~ ', ' !~ ')).join(' && ');
    if (pr && (pr.paths || pr['paths-ignore'])) { if (pr.paths) r.changes = asList(pr.paths).map(String); if (pr['paths-ignore']) notes.push('`paths-ignore` has no equivalent on merge request rules; use `rules: changes:` on the jobs that matter.'); }
    if (pr && pr.types && !asList(pr.types).includes('synchronize')) notes.push('`pull_request.types` filters (opened, labeled, …) have no equivalent; merge request pipelines run on every push to the MR.');
    rules.push(r);
    if (pushCfg !== undefined) rules.unshift({ if: '$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS', when: 'never' });
  }
  if (pushCfg !== undefined) {
    const p = pushCfg || {};
    const branches = asList(p.branches), ignore = asList(p['branches-ignore']), tags = asList(p.tags), tagsIgnore = asList(p['tags-ignore']);
    const changes = p.paths ? asList(p.paths).map(String) : null;
    if (p['paths-ignore']) notes.push('`push.paths-ignore` has no equivalent; use `rules: changes:` on the jobs that matter.');
    if (branches.length) for (const b of branches) rules.push({ if: branchRule('CI_COMMIT_BRANCH', b), ...(changes ? { changes } : {}) });
    else if (ignore.length) rules.push({ if: '$CI_COMMIT_BRANCH && ' + ignore.map((b) => branchRule('CI_COMMIT_BRANCH', b).replace(' == ', ' != ').replace(' =~ ', ' !~ ')).join(' && '), ...(changes ? { changes } : {}) });
    if (tags.length) for (const t of tags) rules.push({ if: branchRule('CI_COMMIT_TAG', t) });
    else if (tagsIgnore.length) rules.push({ if: '$CI_COMMIT_TAG && ' + tagsIgnore.map((t) => branchRule('CI_COMMIT_TAG', t).replace(' == ', ' != ').replace(' =~ ', ' !~ ')).join(' && ') });
    if (!branches.length && !ignore.length && !tags.length && !tagsIgnore.length) rules.push({ if: '$CI_COMMIT_BRANCH || $CI_COMMIT_TAG', ...(changes ? { changes } : {}) });
    else if (!tags.length && !tagsIgnore.length && (branches.length || ignore.length) && p.tags === undefined && !branches.length) { /* branches only */ }
  }
  if (ev.schedule !== undefined) { rules.push({ if: '$CI_PIPELINE_SOURCE == "schedule"' }); const crons = asList(ev.schedule).map((s) => s && s.cron).filter(Boolean); notes.push(`Create pipeline schedules under CI/CD → Schedules for: ${crons.map((c) => `\`${c}\``).join(', ') || 'the original cron'}.`); }
  if (ev.workflow_dispatch !== undefined) {
    rules.push({ if: '$CI_PIPELINE_SOURCE == "web"' });
    const inputs = (ev.workflow_dispatch && ev.workflow_dispatch.inputs) || {};
    for (const [k, v] of Object.entries(inputs)) {
      const name = upperVar(k); ctx.inputVars[k] = name;
      const def = v && v.default !== undefined ? str(v.default) : '';
      const entry = { value: def };
      if (v && v.description) entry.description = String(v.description);
      if (v && v.type === 'choice' && v.options) entry.options = asList(v.options).map(String);
      if (v && v.type === 'boolean') entry.options = ['true', 'false'];
      if (v && v.required && !def) entry.description = (entry.description || '') + ' (required)';
      wf.variables = wf.variables || {}; wf.variables[name] = entry;
    }
    if (Object.keys(inputs).length) notes.push('`workflow_dispatch.inputs` became top-level `variables:` with descriptions, which show as a form under "Run pipeline".');
  }
  if (ev.release !== undefined) rules.push({ if: '$CI_COMMIT_TAG' });
  if (ev.workflow_call !== undefined) notes.push('`workflow_call` means this workflow is reusable; on GitLab include it from the parent with `trigger: include:` or `include:` plus `!reference`.');
  if (ev.workflow_run !== undefined) { rules.push({ if: '$CI_PIPELINE_SOURCE == "pipeline"' }); notes.push('`workflow_run` became a pipeline-triggered rule; the upstream pipeline needs a `trigger:` job pointing here.'); }
  if (ev.repository_dispatch !== undefined) { rules.push({ if: '$CI_PIPELINE_SOURCE == "trigger" || $CI_PIPELINE_SOURCE == "api"' }); }
  for (const k of Object.keys(ev)) if (!['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'release', 'workflow_call', 'workflow_run', 'repository_dispatch', 'merge_group'].includes(k)) notes.push(`Trigger \`${k}\` has no GitLab equivalent; those runs will not happen.`);
  if (ev.merge_group !== undefined) notes.push('`merge_group` became merge request pipelines; GitLab merge trains cover the same need.');
  for (const n of notes) ctx.note(n);
  return { rules };
}

// ---------------------------------------------------------------- stages from the needs graph

function stagesFor(jobs) {
  const depth = {};
  const d = (id, seen = new Set()) => { if (depth[id] !== undefined) return depth[id]; if (seen.has(id)) return 0; seen.add(id); const needs = asList(jobs[id] && jobs[id].needs).map((n) => (typeof n === 'object' ? n.job : n)).filter((n) => jobs[n]); depth[id] = needs.length ? 1 + Math.max(...needs.map((n) => d(n, seen))) : 0; return depth[id]; };
  for (const id of Object.keys(jobs)) d(id);
  const max = Math.max(0, ...Object.values(depth));
  if (max === 0) return null;
  const names = [];
  for (let i = 0; i <= max; i++) { const at = Object.keys(jobs).filter((id) => depth[id] === i); names.push(at.length === 1 ? at[0] : `stage-${i + 1}`); }
  for (const id of Object.keys(jobs)) jobs[id].stage = names[depth[id]];
  return names;
}

// ---------------------------------------------------------------- entry

export function convert(src, options = {}) {
  const ctx = makeCtx(options);
  let doc;
  try { doc = parseYaml(src); } catch (e) { return { yaml: '', notes: [`Could not parse YAML: ${e.message}`], secrets: [], error: e.message }; }
  if (!doc || typeof doc !== 'object' || !doc.jobs) return { yaml: '', notes: ['This does not look like a GitHub Actions workflow (no `jobs:` key).'], secrets: [] };
  const out = {};
  out.__comment0 = `Converted from ${doc.name ? `the "${doc.name}" workflow` : 'a GitHub Actions workflow'} by https://ci2actions.dev/github-actions-to-gitlab-ci/ · review every TODO before you commit`;
  const wf = { variables: undefined };
  const t = triggers(doc.on !== undefined ? doc.on : doc[true], ctx, wf);
  if (doc.name || t.rules.length) out.workflow = { ...(doc.name ? { name: String(doc.name) } : {}), ...(t.rules.length ? { rules: t.rules } : {}) };
  if (doc.concurrency) { const c = typeof doc.concurrency === 'object' ? doc.concurrency : { group: doc.concurrency }; if (c['cancel-in-progress']) { out.workflow = out.workflow || {}; out.workflow.auto_cancel = { on_new_commit: 'interruptible' }; ctx.note('Workflow-level `cancel-in-progress` became `interruptible: true` on every job plus `workflow: auto_cancel`.'); ctx.interruptible = true; } else ctx.note('Workflow-level `concurrency` without cancel has no pipeline-wide equivalent; add `resource_group` to the jobs that must not overlap.'); }
  if (doc.permissions) ctx.note('`permissions:` has no equivalent; `CI_JOB_TOKEN` scope is set in the project settings.');
  const variables = { ...(wf.variables || {}) };
  for (const [k, v] of Object.entries(doc.env || {})) variables[sanitizeVar(k)] = subst(str(v), ctx);
  if (doc.defaults && doc.defaults.run && doc.defaults.run['working-directory']) ctx.note('`defaults.run.working-directory` became a `cd` at the start of every job script.');

  // Pre-scan artifact names and job ids so download-artifact can find its producer.
  const ids = Object.keys(doc.jobs);
  for (const id of ids) for (const s of asList(doc.jobs[id] && doc.jobs[id].steps)) if (s && /^actions\/upload-artifact/.test(String(s.uses || '')) && s.with && s.with.name) ctx.artifactsByName[subst(String(s.with.name), ctx)] = id;
  const jobs = {};
  for (const id of ids) { const j = doc.jobs[id]; if (!j || typeof j !== 'object') continue; const job = convertJob(id, j, ctx, doc); if (job) jobs[id] = job; }
  // renames (pages) and drops that other jobs need
  const renamed = {};
  for (const [id, job] of Object.entries(jobs)) if (job.__rename) { renamed[id] = job.__rename; }
  const finalJobs = {};
  for (const [id, job] of Object.entries(jobs)) {
    const name = renamed[id] || id;
    if (job.needs) job.needs = job.needs.map((n) => (typeof n === 'object' ? { ...n, job: renamed[n.job] || n.job } : renamed[n] || n)).filter((n) => jobs[typeof n === 'object' ? n.job : n] || Object.values(renamed).includes(typeof n === 'object' ? n.job : n));
    if (job.needs && !job.needs.length) delete job.needs;
    if (ctx.interruptible && !job.trigger) job.interruptible = true;
    finalJobs[name] = job;
  }
  const stages = stagesFor(finalJobs);
  if (ctx.includes.length) out.include = [...new Set(ctx.includes)].map((template) => ({ template }));
  if (Object.keys(variables).length) out.variables = variables;
  const anyDefault = Object.values(finalJobs).some((j) => !j.image && !j.trigger && !j.__windows);
  if (anyDefault) { out.default = { image: ctx.opts.image }; ctx.note(`Jobs that ran on \`ubuntu-latest\` use the \`${ctx.opts.image}\` image; GitHub's runner image has far more tools preinstalled, so add \`apt-get install\` lines for anything missing.`); }
  if (stages) out.stages = stages;
  for (const [name, job] of Object.entries(finalJobs)) {
    const ordered = {};
    if (job.__comment) ordered.__comment = job.__comment;
    for (const k of ['stage', 'image', 'tags', 'services', 'needs', 'rules', 'environment', 'resource_group', 'interruptible', 'allow_failure', 'retry', 'timeout', 'id_tokens', 'variables', 'parallel', 'cache', 'before_script', 'script', 'after_script', 'artifacts', 'release', 'trigger']) if (job[k] !== undefined) ordered[k] = job[k];
    for (const k of Object.keys(job)) if (!(k in ordered) && !k.startsWith('__')) ordered[k] = job[k];
    if (ordered.artifacts && Object.keys(ordered.artifacts).length === 0) delete ordered.artifacts;
    out[name] = ordered;
  }
  if (ctx.secrets.size) ctx.notes.push(`Create these CI/CD variables (Settings → CI/CD → Variables, masked): ${[...ctx.secrets].join(', ')}.`);
  if (ctx.vars.size) ctx.notes.push(`Repository variables to recreate as CI/CD variables: ${[...ctx.vars].join(', ')}.`);
  return { yaml: toYaml(out).join('\n') + '\n', notes: ctx.notes, secrets: [...ctx.secrets] };
}

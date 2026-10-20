// Shared helpers for the YAML-based converters (GitLab CI, Azure Pipelines, CircleCI, Bitbucket, Travis).
import { toYaml } from '../emit.js';

export function makeCtx(opts = {}) {
  const notes = [];
  const secrets = new Set();
  return {
    opts: { runner: 'ubuntu-latest', workflowName: '', ...opts },
    notes, secrets,
    note(m) { if (!notes.includes(m)) notes.push(m); },
    secret(name) { const n = String(name).toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&'); secrets.add(n); return n; },
    jobIds: new Set(),
  };
}

export function slug(s, used) {
  let base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
  if (/^[0-9]/.test(base)) base = 'j-' + base;
  let id = base, i = 2;
  while (used && used.has(id)) id = `${base}-${i++}`;
  if (used) used.add(id);
  return id;
}

export const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const str = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Join script lines; arrays of commands become one multi-line run block.
export function script(lines) {
  const arr = asList(lines).map((l) => (typeof l === 'string' ? l : str(l)));
  const out = arr.join('\n').replace(/\r/g, '');
  return out.replace(/\n+$/, '');
}

export function firstLine(s) {
  const l = String(s).split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))[0] || 'Run';
  if (l.length <= 60) return l;
  let cut = l.slice(0, 57);
  const open = cut.lastIndexOf('${{'); if (open >= 0 && cut.indexOf('}}', open) < 0) cut = cut.slice(0, open);
  return cut.trimEnd() + '…';
}

// Map a docker image name to a hosted runner when it is obviously an OS image; else container.
export function imageToRunner(image, ctx) {
  if (!image) return { runsOn: ctx.opts.runner };
  const img = String(image);
  if (/^(ubuntu|debian|alpine|node|python|golang|ruby|openjdk|eclipse-temurin|maven|gradle|rust|php|dotnet|mcr\.microsoft\.com\/dotnet|cimg\/|circleci\/|amazonlinux|centos|fedora|busybox|docker)/.test(img) === false && !/\//.test(img)) {
    // unknown single-word image: still a container
  }
  return { runsOn: ctx.opts.runner, container: { image: img } };
}

// Turn a glob/branch pattern list into on.push.branches entries.
export function branchPatterns(list) {
  return asList(list).map((b) => String(b)).map((b) => b.replace(/^\/|\/$/g, '')).filter(Boolean).map((b) => (/^[\w./*-]+$/.test(b) ? b : b.replace(/\^|\$/g, '').replace(/\.\*/g, '*').replace(/\\/g, '')));
}

export function finish(wf, ctx) {
  const ordered = {};
  for (const k of ['name', 'run-name', 'on', 'permissions', 'env', 'concurrency', 'defaults', 'jobs']) if (wf[k] !== undefined) ordered[k] = wf[k];
  if (ctx.secrets.size) ctx.notes.push(`Create these repository secrets (Settings → Secrets and variables → Actions): ${[...ctx.secrets].join(', ')}.`);
  return { yaml: toYaml(ordered).join('\n') + '\n', notes: ctx.notes, secrets: [...ctx.secrets] };
}

export function orderJob(job) {
  const ordered = {};
  for (const k of ['name', 'runs-on', 'needs', 'if', 'permissions', 'environment', 'container', 'services', 'strategy', 'timeout-minutes', 'continue-on-error', 'env', 'defaults', 'outputs', 'steps']) if (job[k] !== undefined) ordered[k] = job[k];
  for (const k of Object.keys(job)) if (!(k in ordered)) ordered[k] = job[k];
  return ordered;
}

export function todoStep(title, raw, ctx) {
  ctx.todoCount = (ctx.todoCount || 0) + 1;
  const body = String(raw || '').slice(0, 600);
  return { name: `TODO: ${title.replace(/`/g, '')}`, run: `# TODO: ${title.replace(/`/g, "'")}\n${body.split('\n').map((l) => '# ' + l).join('\n')}\necho "TODO: unconverted step" && exit 1` };
}

// Reorder keys so `needs` comes after `runs-on` even when jobs were built incrementally.
export function needsOf(names, ids) { const out = names.map((n) => ids.get(n)).filter(Boolean); return out.length ? out : undefined; }

// Jenkinsfile -> GitHub Actions converter. Runs entirely client-side (also under Node for tests).
// Parses the Groovy-ish Jenkins pipeline DSL (declarative and basic scripted) into a generic tree,
// then emits a GitHub Actions workflow with TODO notes for anything that has no clean equivalent.

// ---------------------------------------------------------------- tokenizer

const PUNCT = new Set(['{', '}', '(', ')', '[', ']', ',', ':', '=', '.', ';', '!', '&', '|', '?', '+', '-', '*', '/', '<', '>', '%']);

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  const push = (type, value, start, end) => toks.push({ type, value, start, end });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { push('nl', '\n', i, i + 1); i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { const s = i; while (i < n && src[i] !== '\n') i++; push('comment', src.slice(s + 2, i).trim(), s, i); continue; }
    if (c === '/' && src[i + 1] === '*') { const s = i; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; push('comment', src.slice(s + 2, i - 2).trim(), s, i); continue; }
    if (c === "'" || c === '"') {
      const triple = src.startsWith(c + c + c, i);
      const q = triple ? c + c + c : c;
      const s = i; i += q.length;
      let out = '';
      while (i < n && !src.startsWith(q, i)) {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'", $: '$' };
          if (e in map) { out += map[e]; i += 2; continue; }
          if (e === '\n') { i += 2; continue; }
          out += e; i += 2; continue;
        }
        out += src[i++];
      }
      i += q.length;
      if (triple) out = out.replace(/^\n/, '');
      push('string', out, s, i);
      toks[toks.length - 1].interpolate = c === '"';
      continue;
    }
    if (/[0-9]/.test(c)) { const s = i; while (i < n && /[0-9._]/.test(src[i])) i++; push('number', Number(src.slice(s, i).replace(/_/g, '')), s, i); continue; }
    if (/[A-Za-z_$]/.test(c)) { const s = i; while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++; push('ident', src.slice(s, i), s, i); continue; }
    if (PUNCT.has(c)) { push('punct', c, i, i + 1); i++; continue; }
    push('other', c, i, i + 1); i++;
  }
  push('eof', '', n, n);
  return toks;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src).filter((t) => t.type !== 'comment');
    this.p = 0;
  }
  peek(o = 0) { return this.toks[this.p + o]; }
  next() { return this.toks[this.p++]; }
  skipNl() { while (this.peek().type === 'nl' || (this.peek().type === 'punct' && this.peek().value === ';')) this.p++; }
  is(type, value) { const t = this.peek(); return t.type === type && (value === undefined || t.value === value); }
  expect(type, value) {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) throw new SyntaxError(`Expected ${value || type} at offset ${t.start}, got '${t.value}'`);
    return t;
  }

  // Parse a whole file: a sequence of statements.
  parseFile() { return this.parseStatements(() => this.is('eof')); }

  parseStatements(stop) {
    const out = [];
    this.skipNl();
    while (!stop()) {
      if (this.is('eof')) break;
      const st = this.parseStatement();
      if (st) out.push(st);
      this.skipNl();
    }
    return out;
  }

  // statement := ident [args] [block] | ident '=' expr | 'def' ident '=' expr | anything-else (raw)
  parseStatement() {
    const startTok = this.peek();
    const t = this.peek();
    if (t.type === 'ident' && t.value === 'def' && this.peek(1).type === 'ident' && this.peek(2).type === 'punct' && this.peek(2).value === '=') {
      this.next(); const nameTok = this.next(); this.next();
      const value = this.parseExpr();
      return { kind: 'assign', name: nameTok.value, value, def: true, raw: this.src.slice(startTok.start, this.lastEnd()) };
    }
    if (t.type === 'ident' && t.value === 'if' && this.peek(1).type === 'punct' && this.peek(1).value === '(') {
      this.next();
      const cs = this.peek().start; this.skipBalanced('(', ')'); const cond = this.src.slice(cs + 1, this.lastEnd() - 1).trim();
      this.skipNl();
      let block = [], elseBlock = null;
      if (this.is('punct', '{')) block = this.parseBlock(); else { const st = this.parseStatement(); if (st) block = [st]; }
      const save = this.p; this.skipNl();
      if (this.is('ident', 'else')) {
        this.next(); this.skipNl();
        if (this.is('ident', 'if')) { const st = this.parseStatement(); elseBlock = st ? [st] : []; }
        else if (this.is('punct', '{')) elseBlock = this.parseBlock();
        else { const st = this.parseStatement(); elseBlock = st ? [st] : []; }
      } else this.p = save;
      return { kind: 'if', cond, block, elseBlock, raw: this.src.slice(startTok.start, this.lastEnd()) };
    }
    if (t.type === 'ident' && t.value === 'try' && this.peek(1).type === 'punct' && this.peek(1).value === '{') {
      this.next();
      const block = this.parseBlock();
      let catchBlock = null, finallyBlock = null;
      for (;;) {
        const save = this.p; this.skipNl();
        if (this.is('ident', 'catch')) { this.next(); if (this.is('punct', '(')) this.skipBalanced('(', ')'); this.skipNl(); catchBlock = this.parseBlock(); continue; }
        if (this.is('ident', 'finally')) { this.next(); this.skipNl(); finallyBlock = this.parseBlock(); continue; }
        this.p = save; break;
      }
      return { kind: 'try', block, catchBlock, finallyBlock, raw: this.src.slice(startTok.start, this.lastEnd()) };
    }
    if (t.type === 'ident' && (t.value === 'def' || t.value === 'if' || t.value === 'for' || t.value === 'while' || t.value === 'try' || t.value === 'return' || t.value === 'else' || t.value === 'switch' || t.value === 'throw')) {
      return this.parseRawStatement(startTok);
    }
    if (t.type === 'ident') {
      // assignment: NAME = value
      if (this.peek(1).type === 'punct' && this.peek(1).value === '=' ) {
        this.next(); this.next();
        const value = this.parseExpr();
        return { kind: 'assign', name: t.value, value, raw: this.src.slice(startTok.start, this.lastEnd()) };
      }
      // dotted assignment or dotted call: env.FOO = 'x', docker.build(...)
      const name = this.parseDottedName();
      const node = { kind: 'call', name, args: [], named: {}, block: null, raw: '' };
      if (this.is('punct', '=')) {
        this.next();
        const value = this.parseExpr();
        return { kind: 'assign', name, value, raw: this.src.slice(startTok.start, this.lastEnd()) };
      }
      if (this.is('punct', '(')) {
        this.next();
        this.parseArgList(node, ')');
        this.expect('punct', ')');
      } else if (!this.is('punct', '{') && !this.is('nl') && !this.is('eof') && !this.is('punct', '}') && !this.is('punct', ';')) {
        // bare args: sh 'x', label 'y', echo "z", sh script: 'x', returnStdout: true
        this.parseArgList(node, null);
      }
      // trailing method chain like .trim() -> record as raw suffix
      while (this.is('punct', '.') && this.peek(1).type === 'ident') {
        this.next(); const m = this.next().value;
        node.chain = node.chain || [];
        let cargs = '';
        if (this.is('punct', '(')) { const s = this.peek().start; this.skipBalanced('(', ')'); cargs = this.src.slice(s, this.lastEnd()); }
        node.chain.push(m + cargs);
      }
      if (this.is('punct', '{')) {
        node.block = this.parseBlock();
      }
      node.raw = this.src.slice(startTok.start, this.lastEnd()).trim();
      return node;
    }
    return this.parseRawStatement(startTok);
  }

  parseDottedName() {
    let name = this.expect('ident').value;
    while (this.is('punct', '.') && this.peek(1).type === 'ident' && !(this.peek(2).type === 'punct' && this.peek(2).value === '(' && false)) {
      // Only fold dotted names when followed by something that makes sense (assignment or call args)
      this.next(); name += '.' + this.next().value;
    }
    return name;
  }

  lastEnd() { return this.toks[this.p - 1] ? this.toks[this.p - 1].end : 0; }

  // Consume a statement we don't understand up to end of line, balancing braces/parens.
  parseRawStatement(startTok) {
    let depth = 0;
    while (!this.is('eof')) {
      const t = this.peek();
      if (t.type === 'punct' && (t.value === '{' || t.value === '(' || t.value === '[')) depth++;
      if (t.type === 'punct' && (t.value === '}' || t.value === ')' || t.value === ']')) { if (depth === 0) break; depth--; }
      if (t.type === 'nl' && depth === 0) break;
      this.next();
      if (depth === 0 && t.type === 'punct' && t.value === '}') break;
    }
    const raw = this.src.slice(startTok.start, this.lastEnd()).trim();
    return raw ? { kind: 'raw', raw } : null;
  }

  skipBalanced(open, close) {
    this.expect('punct', open);
    let depth = 1;
    while (depth > 0 && !this.is('eof')) {
      const t = this.next();
      if (t.type === 'punct' && t.value === open) depth++;
      if (t.type === 'punct' && t.value === close) depth--;
    }
  }

  parseBlock() {
    this.expect('punct', '{');
    // closure params: { it -> ... } or { a, b -> ... }
    const save = this.p;
    let params = null;
    if (this.peek().type === 'ident') {
      let q = this.p; const names = [];
      while (this.toks[q].type === 'ident') { names.push(this.toks[q].value); q++; if (this.toks[q].type === 'punct' && this.toks[q].value === ',') q++; else break; }
      if (this.toks[q].type === 'punct' && this.toks[q].value === '-' && this.toks[q + 1].type === 'punct' && this.toks[q + 1].value === '>') { params = names; this.p = q + 2; }
      else this.p = save;
    }
    const body = this.parseStatements(() => this.is('punct', '}'));
    this.expect('punct', '}');
    if (params) body.params = params;
    return body;
  }

  parseArgList(node, closer) {
    for (;;) {
      if (closer && this.is('punct', closer)) return;
      if (!closer && (this.is('nl') || this.is('eof') || this.is('punct', '{') || this.is('punct', '}'))) return;
      // named arg?  ident ':' expr   or  string ':' expr
      if ((this.peek().type === 'ident' || this.peek().type === 'string') && this.peek(1).type === 'punct' && this.peek(1).value === ':') {
        const key = this.next().value; this.next();
        this.skipNl();
        node.named[key] = this.parseExpr();
      } else {
        node.args.push(this.parseExpr());
      }
      if (closer) this.skipNl();
      if (this.is('punct', ',')) { this.next(); if (closer) this.skipNl(); continue; }
      if (closer && !this.is('punct', closer)) { this.skipNl(); if (this.is('punct', closer)) return; }
      if (!closer) {
        // allow trailing closure block args like: dir('x') { } handled by caller
        return;
      }
      if (!this.is('punct', closer)) { this.skipNl(); }
      if (this.is('punct', closer)) return;
    }
  }

  // expr := primary (binop primary)*  -- we keep binary expressions mostly raw
  parseExpr() {
    const startTok = this.peek();
    let left = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'punct' && ['+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '?'].includes(t.value)) {
        // Binary/ternary expression: swallow remaining tokens to end of expr and keep raw
        let depth = 0;
        while (!this.is('eof')) {
          const u = this.peek();
          if (u.type === 'punct' && (u.value === '(' || u.value === '[' || u.value === '{')) depth++;
          if (u.type === 'punct' && (u.value === ')' || u.value === ']' || u.value === '}')) { if (depth === 0) break; depth--; }
          if (depth === 0 && (u.type === 'nl' || (u.type === 'punct' && u.value === ','))) break;
          this.next();
        }
        return { type: 'expr', raw: this.src.slice(startTok.start, this.lastEnd()).trim() };
      }
      if (t.type === 'punct' && t.value === '.' && this.peek(1).type === 'ident') {
        this.next(); const m = this.next().value;
        if (left.type === 'ident') { left = { type: 'ident', name: left.name + '.' + m }; }
        else if (left.type === 'call') {
          let cargs = '';
          if (this.is('punct', '(')) { const cs2 = this.peek().start; this.skipBalanced('(', ')'); cargs = this.src.slice(cs2, this.lastEnd()); }
          left.chain = left.chain || []; left.chain.push(m + cargs); left.raw = this.src.slice(startTok.start, this.lastEnd()).trim();
          continue;
        }
        else { left = { type: 'expr', raw: this.src.slice(startTok.start, this.lastEnd()).trim() }; }
        if (this.is('punct', '(')) { this.next(); const call = { type: 'call', name: left.name || left.raw, args: [], named: {}, block: null }; this.parseArgList(call, ')'); this.expect('punct', ')'); if (this.is('punct', '{')) call.block = this.parseBlock(); call.raw = this.src.slice(startTok.start, this.lastEnd()).trim(); left = call; }
        continue;
      }
      if (t.type === 'punct' && t.value === '[' && (left.type === 'ident' || left.type === 'expr' || left.type === 'call')) { // indexing
        this.skipBalanced('[', ']');
        left = { type: 'expr', raw: this.src.slice(startTok.start, this.lastEnd()).trim() };
        continue;
      }
      return left;
    }
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'string') { this.next(); return { type: 'string', value: t.value, interpolate: t.interpolate && t.value.includes('$') }; }
    if (t.type === 'number') { this.next(); return { type: 'number', value: t.value }; }
    if (t.type === 'punct' && t.value === '[') return this.parseListOrMap();
    if (t.type === 'punct' && t.value === '{') { const block = this.parseBlock(); return { type: 'closure', block }; }
    if (t.type === 'punct' && t.value === '(') { const s = t.start; this.skipBalanced('(', ')'); return { type: 'expr', raw: this.src.slice(s, this.lastEnd()).trim() }; }
    if (t.type === 'punct' && (t.value === '!' || t.value === '-')) { const s = t.start; this.next(); this.parsePrimary(); return { type: 'expr', raw: this.src.slice(s, this.lastEnd()).trim() }; }
    if (t.type === 'ident') {
      this.next();
      if (t.value === 'true' || t.value === 'false') return { type: 'bool', value: t.value === 'true' };
      if (t.value === 'null') return { type: 'null' };
      if (this.is('punct', '(')) {
        this.next();
        const call = { type: 'call', name: t.value, args: [], named: {}, block: null };
        this.parseArgList(call, ')');
        this.expect('punct', ')');
        if (this.is('punct', '{')) call.block = this.parseBlock();
        call.raw = this.src.slice(t.start, this.lastEnd()).trim();
        return call;
      }
      if (this.is('punct', '{')) { const block = this.parseBlock(); return { type: 'call', name: t.value, args: [], named: {}, block, raw: this.src.slice(t.start, this.lastEnd()).trim() }; }
      return { type: 'ident', name: t.value };
    }
    // Unknown: consume one token as raw
    this.next();
    return { type: 'expr', raw: this.src.slice(t.start, t.end) };
  }

  parseListOrMap() {
    const s = this.peek().start;
    this.expect('punct', '[');
    this.skipNl();
    if (this.is('punct', ']')) { this.next(); return { type: 'list', items: [] }; }
    if (this.is('punct', ':')) { this.next(); this.skipNl(); this.expect('punct', ']'); return { type: 'map', entries: {} }; }
    // map if first element is key ':'
    const isMap = (this.peek().type === 'ident' || this.peek().type === 'string') && this.peek(1).type === 'punct' && this.peek(1).value === ':';
    if (isMap) {
      const entries = {};
      for (;;) {
        this.skipNl();
        if (this.is('punct', ']')) break;
        const k = this.next().value; this.expect('punct', ':'); this.skipNl();
        entries[k] = this.parseExpr();
        this.skipNl();
        if (this.is('punct', ',')) this.next();
      }
      this.expect('punct', ']');
      return { type: 'map', entries, raw: this.src.slice(s, this.lastEnd()) };
    }
    const items = [];
    for (;;) {
      this.skipNl();
      if (this.is('punct', ']')) break;
      items.push(this.parseExpr());
      this.skipNl();
      if (this.is('punct', ',')) this.next();
    }
    this.expect('punct', ']');
    return { type: 'list', items, raw: this.src.slice(s, this.lastEnd()) };
  }
}

export function parse(src) { return new Parser(src).parseFile(); }

// ---------------------------------------------------------------- helpers over the tree

const find = (block, name) => (block || []).find((n) => n.kind === 'call' && n.name === name);
const findAll = (block, name) => (block || []).filter((n) => n.kind === 'call' && n.name === name);
const str = (v) => (v && (v.type === 'string' || v.type === 'ident' || v.type === 'number' || v.type === 'bool') ? String(v.type === 'ident' ? v.name : v.value) : v ? v.raw || '' : '');
const firstArg = (node) => (node && node.args && node.args.length ? node.args[0] : null);

// ---------------------------------------------------------------- Jenkins -> Actions expression mapping

const ENV_MAP = {
  BUILD_NUMBER: '${{ github.run_number }}',
  BUILD_ID: '${{ github.run_id }}',
  BUILD_TAG: '${{ github.workflow }}-${{ github.run_number }}',
  BUILD_URL: '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
  JOB_NAME: '${{ github.workflow }}',
  JOB_BASE_NAME: '${{ github.workflow }}',
  BRANCH_NAME: '${{ github.ref_name }}',
  GIT_BRANCH: '${{ github.ref_name }}',
  GIT_LOCAL_BRANCH: '${{ github.ref_name }}',
  GIT_COMMIT: '${{ github.sha }}',
  GIT_PREVIOUS_COMMIT: '${{ github.event.before }}',
  GIT_URL: '${{ github.server_url }}/${{ github.repository }}.git',
  WORKSPACE: '${{ github.workspace }}',
  CHANGE_ID: '${{ github.event.pull_request.number }}',
  CHANGE_TARGET: '${{ github.base_ref }}',
  CHANGE_BRANCH: '${{ github.head_ref }}',
  CHANGE_AUTHOR: '${{ github.event.pull_request.user.login }}',
  CHANGE_URL: '${{ github.event.pull_request.html_url }}',
  CHANGE_TITLE: '${{ github.event.pull_request.title }}',
  TAG_NAME: '${{ github.ref_name }}',
  NODE_NAME: '${{ runner.name }}',
  EXECUTOR_NUMBER: '1',
  JENKINS_URL: '${{ github.server_url }}',
  JENKINS_HOME: '${{ runner.temp }}',
};

// Convert a Groovy GString ("...${env.FOO}...") into a GitHub-expression-bearing string.
// `scope` tells us which bare identifiers are env vars we know about.
function mapInterpolation(s, ctx, { inShell = false } = {}) {
  if (!s.includes('$')) return s;
  return s.replace(/\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_.]*)/g, (m, braced, bare) => {
    const expr = (braced !== undefined ? braced : bare).trim();
    const r = mapExpr(expr, ctx, inShell);
    if (r === null) return m; // leave untouched (shell var etc.)
    return r;
  });
}

function mapExpr(expr, ctx, inShell) {
  let m;
  if ((m = /^(?:env\.)?([A-Z_][A-Z0-9_]*)$/.exec(expr))) {
    const name = m[1];
    if (ENV_MAP[name]) return inShell && name === 'WORKSPACE' ? '$GITHUB_WORKSPACE' : ENV_MAP[name];
    if (ctx.inlineEnv) {
      if (name in ctx.inlineEnv) return ctx.inlineEnv[name];
      ctx.note(`Workflow-level \`env\` cannot reference other variables with \`\${{ env.${name} }}\`; move it to a job-level env or inline the value.`);
    }
    if (ctx.envNames.has(name)) return inShell ? `$${name}` : `\${{ env.${name} }}`;
    if (expr.startsWith('env.')) return inShell ? `$${name}` : `\${{ env.${name} }}`;
    return inShell ? null : `\${{ env.${name} }}`;
  }
  if ((m = /^params\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr))) return `\${{ inputs.${m[1]} }}`;
  if ((m = /^env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(expr))) return inShell ? `$${m[1]}` : `\${{ env.${m[1]} }}`;
  if (/^currentBuild\.(result|currentResult)$/.test(expr)) return '${{ job.status }}';
  if (/^currentBuild\.(number|id)$/.test(expr)) return '${{ github.run_number }}';
  if (/^currentBuild\.displayName$/.test(expr)) return '${{ github.workflow }} #${{ github.run_number }}';
  if (/^currentBuild\.(absoluteUrl|url)$/.test(expr)) return ENV_MAP.BUILD_URL;
  if (/^currentBuild\.durationString$/.test(expr)) { ctx.note('`currentBuild.durationString` has no Actions equivalent; left as-is.'); return null; }
  if (/^[a-z_][A-Za-z0-9_]*$/.test(expr) && ctx.vars.has(expr)) { ctx.note(`Groovy variable \`${expr}\` is used in a string; set it as an environment variable or step output.`); return inShell ? null : `\${{ env.${expr} }}`; }
  if (/^[a-z_][A-Za-z0-9_]*$/.test(expr)) return null; // probably a shell variable
  ctx.note(`Expression \`\${${expr}}\` left unconverted; translate it to a GitHub expression by hand.`);
  return null;
}

import { toYaml, Comment } from './emit.js';
export { toYaml, Comment };

// ---------------------------------------------------------------- conversion

export function convert(src, options = {}) {
  const opts = { mode: 'jobs', runner: 'ubuntu-latest', workflowName: '', checkout: true, ...options };
  const notes = [];
  const secrets = new Set();
  const ctx = {
    opts, notes, secrets,
    envNames: new Set(),
    vars: new Set(),
    note(msg) { if (!notes.includes(msg)) notes.push(msg); },
    secret(id, suffix = '') {
      const name = (id + (suffix ? '_' + suffix : '')).toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
      secrets.add(name);
      return name;
    },
    usesInputs: false,
    needsCmd: false,
  };

  ctx.src = src;
  let tree;
  try { tree = parse(src); } catch (e) { return { yaml: '', notes: [`Could not parse this Jenkinsfile: ${e.message}`], secrets: [], error: e.message }; }

  // Collect top-level Groovy variables (def x = ...) so interpolation can flag them.
  for (const n of tree) if (n.kind === 'raw' && /^def\s+([A-Za-z_]\w*)/.test(n.raw)) ctx.vars.add(RegExp.$1);

  const pipeline = find(tree, 'pipeline');
  let wf;
  if (pipeline) wf = convertDeclarative(pipeline.block, ctx);
  else wf = convertScripted(tree, ctx);

  if (!wf.name) wf.name = opts.workflowName || 'CI';
  if (ctx.secrets.size) notes.push(`Create these repository secrets (Settings → Secrets and variables → Actions): ${[...ctx.secrets].join(', ')}.`);

  const ordered = {};
  for (const k of ['name', 'run-name', 'on', 'permissions', 'env', 'concurrency', 'defaults', 'jobs']) if (wf[k] !== undefined) ordered[k] = liftTodoComments(wf[k]);
  const yaml = toYaml(ordered).join('\n') + '\n';
  return { yaml, notes, secrets: [...ctx.secrets], scripted: !pipeline };
}

// Expressions cannot carry comments, so `true /* TODO: ... */` placeholders become a YAML comment above the `if:`.
function liftTodoComments(v) {
  if (Array.isArray(v)) return v.map(liftTodoComments);
  if (v && typeof v === 'object' && !(v instanceof Comment)) {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'if' && typeof val === 'string' && val.includes('/*')) {
        const todos = [...val.matchAll(/\/\*\s*(.*?)\s*\*\//g)].map((m) => m[1]);
        out.__comment_if = todos.join('\n');
        const cleaned = val.replace(/\s*\/\*.*?\*\//g, '').replace(/\(\s*true\s*\)/g, 'true').replace(/true && |&& true/g, '').trim();
        if (cleaned !== 'true' && cleaned !== '') out.if = cleaned;
      } else out[k] = liftTodoComments(val);
    }
    return out;
  }
  return v;
}

// ----- declarative

function convertDeclarative(body, ctx) {
  const wf = { name: ctx.opts.workflowName || undefined };
  const agent = convertAgent(find(body, 'agent'), ctx);
  const envBlock = find(body, 'environment');
  const env = envBlock ? convertEnvironment(envBlock.block, ctx, true) : null;
  const params = find(body, 'parameters');
  const inputs = params ? convertParameters(params.block, ctx) : null;
  const triggers = find(body, 'triggers');
  const on = convertTriggers(triggers ? triggers.block : null, inputs, ctx);
  const options = find(body, 'options');
  const optInfo = convertOptions(options ? options.block : null, ctx, 'pipeline');
  const tools = find(body, 'tools');
  const toolSteps = tools ? convertTools(tools.block, ctx) : [];
  const stagesNode = find(body, 'stages');
  const post = find(body, 'post');

  wf.on = on;
  if (env && Object.keys(env).length) wf.env = env;
  if (optInfo.concurrency) wf.concurrency = optInfo.concurrency;

  const jobs = {};
  const stages = stagesNode ? findAll(stagesNode.block, 'stage') : [];
  const jobDefaults = { agent, toolSteps, timeout: optInfo.timeout, checkout: ctx.opts.checkout && !optInfo.skipDefaultCheckout };

  if (ctx.opts.mode === 'single') {
    const job = buildJob('build', agent, ctx, jobDefaults);
    const steps = [];
    for (const stage of stages) steps.push(...stageToSteps(stage, ctx, null));
    job.steps.push(...steps);
    if (post) job.steps.push(...convertPost(post.block, ctx, 'job'));
    finishJob(job, ctx);
    jobs[job.__id] = stripMeta(job);
  } else {
    let prev = []; // job ids of the previous stage level
    for (const stage of stages) {
      const ids = stageToJobs(stage, ctx, jobDefaults, prev, jobs);
      prev = ids;
    }
    if (post) {
      const postSteps = convertPost(post.block, ctx, 'pipeline', Object.keys(jobs));
      if (postSteps.length) {
        const job = buildJob('post', agent, ctx, { ...jobDefaults, checkout: false, toolSteps: [] });
        job.needs = Object.keys(jobs);
        job.if = 'always()';
        job.steps.push(...postSteps);
        finishJob(job, ctx);
        jobs[job.__id] = stripMeta(job);
      }
    }
  }
  if (Object.keys(jobs).length === 0) {
    jobs.build = { 'runs-on': ctx.opts.runner, steps: [{ name: 'TODO', run: 'echo "No stages found in the Jenkinsfile"' }] };
  }
  wf.jobs = jobs;
  return wf;
}

const slug = (s, used) => {
  let base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';
  if (/^[0-9]/.test(base)) base = 'j-' + base;
  let id = base, i = 2;
  while (used && used.has(id)) id = `${base}-${i++}`;
  if (used) used.add(id);
  return id;
};

function buildJob(name, agent, ctx, defaults) {
  ctx.jobIds = ctx.jobIds || new Set();
  const job = { __id: slug(name, ctx.jobIds), name, 'runs-on': agent.runsOn };
  if (agent.container) job.container = agent.container;
  if (defaults.timeout) job['timeout-minutes'] = defaults.timeout;
  job.steps = [];
  if (defaults.checkout !== false) job.steps.push({ name: 'Checkout', uses: 'actions/checkout@v4' });
  if (defaults.toolSteps && defaults.toolSteps.length) job.steps.push(...defaults.toolSteps.map((s) => ({ ...s })));
  return job;
}

function finishJob(job, ctx) {
  if (job.steps.length === 0) job.steps.push({ run: 'echo "No steps"' });
  if (job.__cmd) { job.defaults = { run: { shell: 'cmd' } }; delete job.__cmd; }
  // Drop duplicate plain checkout steps (auto-added + explicit `checkout scm`).
  let seenCheckout = false;
  job.steps = job.steps.filter((st) => { if (st.uses === 'actions/checkout@v4' && !st.with) { if (seenCheckout) return false; seenCheckout = true; } return true; });
  const onWindows = /windows/.test(String(job['runs-on']));
  for (const st of job.steps) {
    if (st.shell === 'cmd' && !onWindows) { st.shell = 'bash'; st.run = '# TODO: this was a Windows `bat` step but the job runs on a non-Windows runner\n' + st.run; ctx.note('A `bat` step landed in a non-Windows job; either move it to a windows-latest job or rewrite it for bash.'); }
  }
}
function stripMeta(job) {
  const { __id, ...rest } = job;
  const ordered = {};
  for (const k of ['name', 'runs-on', 'needs', 'if', 'permissions', 'environment', 'container', 'strategy', 'timeout-minutes', 'env', 'defaults', 'steps']) if (rest[k] !== undefined) ordered[k] = rest[k];
  for (const k of Object.keys(rest)) if (!(k in ordered)) ordered[k] = rest[k];
  return ordered;
}

function convertAgent(agentNode, ctx) {
  const out = { runsOn: ctx.opts.runner, container: null, declared: !!agentNode };
  if (!agentNode) return out;
  const a = firstArg(agentNode);
  if (a && a.type === 'ident' && a.name === 'any') return out;
  if (a && a.type === 'ident' && a.name === 'none') { out.none = true; return out; }
  if (!agentNode.block) return out;
  const b = agentNode.block;
  const label = find(b, 'label');
  if (label) out.runsOn = labelToRunsOn(str(firstArg(label)), ctx);
  const node = find(b, 'node');
  if (node && node.block) { const l = find(node.block, 'label'); if (l) out.runsOn = labelToRunsOn(str(firstArg(l)), ctx); }
  const docker = find(b, 'docker');
  if (docker) {
    let image = str(firstArg(docker));
    let args = null;
    if (docker.block) { const im = find(docker.block, 'image'); if (im) image = str(firstArg(im)); const ar = find(docker.block, 'args'); if (ar) args = str(firstArg(ar)); const lb = find(docker.block, 'label'); if (lb) out.runsOn = labelToRunsOn(str(firstArg(lb)), ctx); }
    out.container = args ? { image, options: mapInterpolation(args, ctx) } : { image };
    if (/\$/.test(image)) out.container.image = mapInterpolation(image, ctx);
    ctx.note('Jenkins `agent { docker }` became `container:`; GitHub runs the whole job inside that image, so it must have a shell and the tools your steps need. Container jobs only work on Linux runners.');
  }
  const dockerfile = find(b, 'dockerfile');
  if (dockerfile) {
    ctx.note('`agent { dockerfile }` has no direct equivalent. Build the image in a first step (`docker build -t ci-image .`) and run commands with `docker run`, or publish the image and use `container:`.');
    out.dockerfile = true;
  }
  const k8s = find(b, 'kubernetes');
  if (k8s) ctx.note('`agent { kubernetes }` pod templates do not map to Actions. Use `container:` for a single image, or actions-runner-controller for self-hosted Kubernetes runners.');
  return out;
}

function labelToRunsOn(label, ctx) {
  const l = label.toLowerCase();
  if (/\bwindows\b|\bwin\b/.test(l)) return 'windows-latest';
  if (/\bmac|\bosx|darwin/.test(l)) return 'macos-latest';
  if (/\b(linux|ubuntu|docker|any)\b/.test(l)) return 'ubuntu-latest';
  const labels = label.split(/\s*(?:&&|\|\|)\s*|\s+/).filter(Boolean);
  ctx.note(`Agent label \`${label}\` mapped to a self-hosted runner with the same labels. Change \`runs-on\` to a hosted runner (e.g. ubuntu-latest) if you no longer need those machines.`);
  return ['self-hosted', ...labels];
}

function convertEnvironment(block, ctx, topLevel = false) {
  const env = {};
  for (const n of block) {
    if (n.kind !== 'assign') continue;
    const v = n.value;
    ctx.envNames.add(n.name);
    if (topLevel) ctx.inlineEnv = env;
    if (v.type === 'call' && v.name === 'credentials') {
      const id = str(firstArg(v));
      const name = ctx.secret(id);
      const usesPair = new RegExp(`\\b${n.name}_(USR|PSW)\\b`).test(ctx.src || '');
      if (usesPair) {
        env[`${n.name}_USR`] = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}`;
        env[`${n.name}_PSW`] = `\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`;
        env[n.name] = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}:\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`;
        ctx.envNames.add(`${n.name}_USR`); ctx.envNames.add(`${n.name}_PSW`);
        ctx.note(`\`credentials('${id}')\` was used as a username/password pair (\`${n.name}_USR\`/\`${n.name}_PSW\`), so it became two secrets.`);
      } else {
        env[n.name] = `\${{ secrets.${name} }}`;
        ctx.note(`\`credentials('${id}')\` in environment became secret \`${name}\`.`);
      }
      continue;
    }
    env[n.name] = valueToString(v, ctx);
  }
  ctx.inlineEnv = null;
  return env;
}

function valueToString(v, ctx) {
  if (!v) return '';
  if (v.type === 'string') return v.interpolate ? mapInterpolation(v.value, ctx) : v.value;
  if (v.type === 'number' || v.type === 'bool') return String(v.value);
  if (v.type === 'ident') { const r = mapExpr(v.name, ctx, false); return r === null ? v.name : r; }
  if (v.type === 'call') { ctx.note(`Groovy call \`${v.raw}\` cannot be evaluated at workflow time; replace it with a literal or a step output.`); return `TODO(${v.raw})`; }
  if (v.type === 'expr') { const r = mapExpr(v.raw, ctx, false); if (r !== null) return r; ctx.note(`Expression \`${v.raw}\` left as-is.`); return v.raw; }
  if (v.type === 'list') return v.items.map((i) => valueToString(i, ctx)).join(',');
  return v.raw || '';
}

function convertParameters(block, ctx) {
  const inputs = {};
  for (const p of findAll(block, undefined).length ? block : block) {
    if (p.kind !== 'call') continue;
    const name = str(p.named.name);
    if (!name) continue;
    const desc = p.named.description ? str(p.named.description) : undefined;
    const def = p.named.defaultValue;
    const input = {};
    if (desc) input.description = desc;
    switch (p.name) {
      case 'booleanParam': input.type = 'boolean'; input.default = def ? def.type === 'bool' ? def.value : String(def.value) === 'true' : false; input.required = false; break;
      case 'choice': {
        input.type = 'choice';
        let choices = p.named.choices;
        if (choices && choices.type === 'list') input.options = choices.items.map((c) => str(c));
        else if (choices && choices.type === 'string') input.options = choices.value.split('\n').filter(Boolean);
        else input.options = [];
        if (input.options.length) input.default = input.options[0];
        break;
      }
      case 'password': case 'credentials':
        input.type = 'string'; input.required = false;
        ctx.note(`Parameter \`${name}\` (${p.name}) became a plain string input; GitHub inputs are not secret. Prefer a repository secret.`);
        break;
      case 'text': case 'string': default:
        input.type = 'string';
        if (def) input.default = valueToString(def, ctx);
        input.required = false;
        if (!['string', 'text'].includes(p.name)) ctx.note(`Parameter type \`${p.name}\` treated as a string input.`);
    }
    inputs[name] = input;
  }
  ctx.usesInputs = Object.keys(inputs).length > 0;
  if (ctx.usesInputs) ctx.note('Parameters became `workflow_dispatch` inputs; `params.X` references became `${{ inputs.X }}`. Inputs are only set on manual runs, so give each one a default.');
  return inputs;
}

function convertTriggers(block, inputs, ctx) {
  const on = {};
  const cronList = [];
  if (block) {
    for (const t of block) {
      if (t.kind !== 'call') continue;
      if (t.name === 'cron') {
        let spec = str(firstArg(t)).trim();
        spec = spec.replace(/^TZ=\S+\s*\n?/, (m) => { ctx.note(`Cron timezone \`${m.trim()}\` dropped: GitHub schedules always run in UTC.`); return ''; }).trim();
        if (/H/.test(spec)) { ctx.note(`Jenkins \`H\` in cron \`${spec}\` spreads load randomly; GitHub needs a fixed value, so \`H\` became \`0\`/\`*\` equivalents. Pick a quiet minute (avoid the top of the hour, which is often delayed).`); }
        const fixed = spec.replace(/H\((\d+)-(\d+)\)/g, '$1').replace(/H\/(\d+)/g, '*/$1').replace(/\bH\b/g, '0');
        cronList.push({ cron: fixed });
      } else if (t.name === 'pollSCM') {
        on.push = { branches: ['main'] };
        ctx.note('`pollSCM` became `on: push`; GitHub pushes events, so polling is unnecessary. Adjust the branch filter.');
      } else if (t.name === 'upstream') {
        const names = str(t.named.upstreamProjects || firstArg(t));
        on.workflow_run = { workflows: names.split(',').map((s) => s.trim()).filter(Boolean), types: ['completed'] };
        ctx.note('`upstream` trigger became `workflow_run`; the names must match the upstream workflows\' `name:` fields in this repository.');
      } else if (t.name === 'githubPush' || t.name === 'bitbucketPush' || t.name === 'gitlab') {
        on.push = { branches: ['main'] };
      } else {
        ctx.note(`Trigger \`${t.raw}\` has no equivalent and was dropped.`);
      }
    }
  }
  if (!on.push && !on.workflow_run) { on.push = { branches: ['main'] }; on.pull_request = { branches: ['main'] }; }
  if (cronList.length) on.schedule = cronList;
  if (inputs && Object.keys(inputs).length) on.workflow_dispatch = { inputs };
  else on.workflow_dispatch = {};
  return on;
}

function convertOptions(block, ctx, scope) {
  const out = { timeout: null, concurrency: null, skipDefaultCheckout: false, retry: null };
  if (!block) return out;
  for (const o of block) {
    if (o.kind !== 'call') continue;
    switch (o.name) {
      case 'timeout': out.timeout = toMinutes(o, ctx); break;
      case 'disableConcurrentBuilds': out.concurrency = { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': !!(o.named.abortPrevious && o.named.abortPrevious.value) }; break;
      case 'skipDefaultCheckout': out.skipDefaultCheckout = !(firstArg(o) && firstArg(o).type === 'bool' && firstArg(o).value === false); break;
      case 'buildDiscarder': ctx.note('`buildDiscarder` dropped: GitHub keeps logs/artifacts per the repository retention setting (Settings → Actions).'); break;
      case 'timestamps': case 'ansiColor': case 'skipStagesAfterUnstable': case 'quietPeriod': case 'checkoutToSubdirectory': case 'newContainerPerStage': case 'preserveStashes': case 'durabilityHint': case 'parallelsAlwaysFailFast': break;
      case 'retry': out.retry = str(firstArg(o)); ctx.note('`options { retry }` has no job-level equivalent; use `nick-fields/retry` on the fragile steps or re-run failed jobs from the UI.'); break;
      case 'disableResume': break;
      default: ctx.note(`Option \`${o.raw}\` dropped (no equivalent).`);
    }
  }
  if (scope === 'pipeline' && out.timeout == null) { /* GitHub default 360 min */ }
  return out;
}

function toMinutes(node, ctx) {
  const time = node.named.time ? Number(str(node.named.time)) : node.args[0] ? Number(str(node.args[0])) : NaN;
  const unit = node.named.unit ? str(node.named.unit).toUpperCase() : 'MINUTES';
  if (Number.isNaN(time)) return null;
  const mult = { SECONDS: 1 / 60, MINUTES: 1, HOURS: 60, DAYS: 1440 }[unit] ?? 1;
  return Math.max(1, Math.ceil(time * mult));
}

function convertTools(block, ctx) {
  const steps = [];
  for (const t of block) {
    if (t.kind !== 'call') continue;
    const name = str(firstArg(t));
    const ver = (name.match(/(\d+(?:\.\d+)*)/) || [])[1];
    switch (t.name) {
      case 'jdk': case 'java': steps.push({ name: 'Set up JDK', uses: 'actions/setup-java@v4', with: { distribution: 'temurin', 'java-version': ver || '17' } }); if (!ver) ctx.note(`Could not infer a Java version from tool name \`${name}\`; defaulted to 17.`); break;
      case 'maven': ctx.note(`Maven tool \`${name}\`: hosted runners ship Maven, so no setup step was added. Pin a version with \`stCarolas/setup-maven\` if you need one.`); break;
      case 'gradle': steps.push({ name: 'Set up Gradle', uses: 'gradle/actions/setup-gradle@v4' }); break;
      case 'nodejs': case 'node': steps.push({ name: 'Set up Node.js', uses: 'actions/setup-node@v4', with: { 'node-version': ver || 'lts/*' } }); break;
      case 'go': steps.push({ name: 'Set up Go', uses: 'actions/setup-go@v5', with: { 'go-version': ver || 'stable' } }); break;
      case 'terraform': steps.push({ name: 'Set up Terraform', uses: 'hashicorp/setup-terraform@v3', with: ver ? { terraform_version: ver } : undefined }); break;
      case 'dockerTool': case 'docker': ctx.note('Docker is preinstalled on hosted Linux runners; `tools { docker }` dropped.'); break;
      case 'ant': ctx.note('Ant is preinstalled on hosted runners; `tools { ant }` dropped.'); break;
      default: ctx.note(`Tool \`${t.name} '${name}'\` has no mapped setup action; add one by hand.`);
    }
  }
  return steps;
}

// ----- stages

function stageToJobs(stage, ctx, defaults, prevIds, jobs) {
  const name = str(firstArg(stage));
  const b = stage.block || [];
  const parallel = find(b, 'parallel');
  const matrix = find(b, 'matrix');
  const nested = find(b, 'stages');
  const agentNode = find(b, 'agent');
  const agent = agentNode ? convertAgent(agentNode, ctx) : defaults.agent;
  const when = find(b, 'when');
  const cond = when ? convertWhen(when.block, ctx) : null;
  const options = find(b, 'options');
  const optInfo = convertOptions(options ? options.block : null, ctx, 'stage');
  const stageEnv = find(b, 'environment');
  const env = stageEnv ? convertEnvironment(stageEnv.block, ctx) : null;
  const stageTools = find(b, 'tools');
  const toolSteps = stageTools ? [...defaults.toolSteps, ...convertTools(stageTools.block, ctx)] : defaults.toolSteps;
  const jobDefaults = { ...defaults, agent, toolSteps, timeout: optInfo.timeout || defaults.timeout };

  if (parallel) {
    const ids = [];
    for (const sub of findAll(parallel.block, 'stage')) {
      const subIds = stageToJobs(sub, ctx, jobDefaults, prevIds, jobs);
      for (const id of subIds) { if (cond) jobs[id].if = jobs[id].if ? `(${cond}) && (${jobs[id].if})` : cond; if (env) jobs[id].env = { ...env, ...(jobs[id].env || {}) }; }
      ids.push(...subIds);
    }
    const failFast = find(b, 'failFast');
    if (failFast) ctx.note('`failFast` on parallel stages: GitHub jobs are independent; cancel siblings with `strategy.fail-fast` only inside a matrix, or use `concurrency`/the API.');
    return ids;
  }
  if (nested) {
    let prev = prevIds;
    for (const sub of findAll(nested.block, 'stage')) {
      prev = stageToJobs(sub, ctx, jobDefaults, prev, jobs);
      if (cond || env) for (const id of prev) { if (cond) jobs[id].if = jobs[id].if ? `(${cond}) && (${jobs[id].if})` : cond; if (env) jobs[id].env = { ...env, ...(jobs[id].env || {}) }; }
    }
    return prev;
  }
  const job = buildJob(name, agent, ctx, jobDefaults);
  if (prevIds.length) job.needs = prevIds;
  if (cond) job.if = cond;
  if (env) job.env = env;
  if (matrix) {
    const axes = find(matrix.block, 'axes');
    const m = {};
    for (const axis of findAll(axes ? axes.block : [], 'axis')) {
      const an = str(firstArg(find(axis.block, 'name')));
      const vals = find(axis.block, 'values');
      m[an] = vals ? vals.args.map((v) => str(v)) : [];
    }
    const excludes = find(matrix.block, 'excludes');
    if (excludes) {
      m.exclude = findAll(excludes.block, 'exclude').map((ex) => { const o = {}; for (const ax of findAll(ex.block, 'axis')) { const an = str(firstArg(find(ax.block, 'name'))); const vals = find(ax.block, 'values'); const nv = find(ax.block, 'notValues'); if (vals) o[an] = str(vals.args[0]); if (nv) ctx.note(`Matrix exclude with \`notValues\` for axis ${an} must be expanded by hand.`); } return o; });
    }
    job.strategy = { matrix: m };
    job.name = `${name} (${Object.keys(m).filter((k) => k !== 'exclude').map((k) => `\${{ matrix.${k} }}`).join(', ')})`;
    for (const k of Object.keys(m)) if (k !== 'exclude') ctx.envNames.add(k);
    const mEnv = {}; for (const k of Object.keys(m)) if (k !== 'exclude') mEnv[k] = `\${{ matrix.${k} }}`;
    job.env = { ...(job.env || {}), ...mEnv };
    const mStages = find(matrix.block, 'stages');
    const mAgent = find(matrix.block, 'agent');
    if (mAgent) { const a = convertAgent(mAgent, ctx); job['runs-on'] = a.runsOn; if (a.container) job.container = a.container; }
    for (const s of findAll(mStages ? mStages.block : [], 'stage')) job.steps.push(...stageToSteps(s, ctx, null));
    const mPost = find(matrix.block, 'post');
    if (mPost) job.steps.push(...convertPost(mPost.block, ctx, 'job'));
  } else {
    const stepsNode = find(b, 'steps');
    if (stepsNode) job.steps.push(...convertSteps(stepsNode.block, ctx, {}));
    const input = find(b, 'input');
    if (input) { ctx.note(`Stage \`${name}\` has an \`input\` step; use a GitHub environment with required reviewers instead (\`environment: production\`).`); job.environment = 'production'; }
  }
  const post = find(b, 'post');
  if (post) job.steps.push(...convertPost(post.block, ctx, 'job'));
  finishJob(job, ctx);
  jobs[job.__id] = stripMeta(job);
  return [job.__id];
}

// Flatten a stage into steps (single-job mode, nested stages and matrix bodies).
function stageToSteps(stage, ctx, parentCond) {
  const name = str(firstArg(stage));
  const b = stage.block || [];
  const when = find(b, 'when');
  let cond = when ? convertWhen(when.block, ctx) : null;
  if (parentCond) cond = cond ? `(${parentCond}) && (${cond})` : parentCond;
  const agentNode = find(b, 'agent');
  if (agentNode && ctx.opts.mode === 'single') ctx.note(`Stage \`${name}\` declares its own agent, which single-job mode ignores. Switch to one-job-per-stage mode if it needs a different runner or container.`);
  const stageEnv = find(b, 'environment');
  const env = stageEnv ? convertEnvironment(stageEnv.block, ctx) : null;
  const out = [];
  const group = { stage: name, cond, env };
  const parallel = find(b, 'parallel');
  const nested = find(b, 'stages');
  const matrix = find(b, 'matrix');
  if (parallel) {
    ctx.note(`Parallel stage \`${name}\` was flattened into sequential steps. Use one-job-per-stage mode to keep the branches parallel.`);
    for (const sub of findAll(parallel.block, 'stage')) out.push(...stageToSteps(sub, ctx, cond));
  } else if (nested) {
    for (const sub of findAll(nested.block, 'stage')) out.push(...stageToSteps(sub, ctx, cond));
  } else if (matrix) {
    ctx.note(`Matrix stage \`${name}\` cannot be expressed inside a single job; switch to one-job-per-stage mode to get \`strategy.matrix\`.`);
    const mStages = find(matrix.block, 'stages');
    for (const sub of findAll(mStages ? mStages.block : [], 'stage')) out.push(...stageToSteps(sub, ctx, cond));
  } else {
    const stepsNode = find(b, 'steps');
    if (stepsNode) out.push(...convertSteps(stepsNode.block, ctx, group));
  }
  const post = find(b, 'post');
  if (post) out.push(...convertPost(post.block, ctx, 'stage', null, name));
  return out;
}

// ----- when

function convertWhen(block, ctx) {
  const parts = [];
  for (const w of block) {
    if (w.kind !== 'call') continue;
    const c = whenCond(w, ctx);
    if (c) parts.push(c);
  }
  return parts.length ? parts.join(' && ') : null;
}

function whenCond(w, ctx) {
  const a = firstArg(w);
  switch (w.name) {
    case 'branch': {
      const pat = str(w.named.pattern || a);
      const comparator = w.named.comparator ? str(w.named.comparator) : 'GLOB';
      if (comparator === 'REGEXP') { ctx.note(`\`branch\` with REGEXP comparator (${pat}) cannot be expressed in Actions expressions; approximated.`); return `github.ref_name == '${pat}'`; }
      return globToCond(pat, 'refs/heads/');
    }
    case 'tag': { const pat = a ? str(w.named.pattern || a) : '*'; return globToCond(pat, 'refs/tags/'); }
    case 'buildingTag': return "startsWith(github.ref, 'refs/tags/')";
    case 'changeRequest': return "github.event_name == 'pull_request'";
    case 'not': { const inner = convertWhen(w.block, ctx); return inner ? `!(${inner})` : null; }
    case 'allOf': { const cs = w.block.filter((n) => n.kind === 'call').map((n) => whenCond(n, ctx)).filter(Boolean); return cs.length ? `(${cs.join(' && ')})` : null; }
    case 'anyOf': { const cs = w.block.filter((n) => n.kind === 'call').map((n) => whenCond(n, ctx)).filter(Boolean); return cs.length ? `(${cs.join(' || ')})` : null; }
    case 'environment': { const n = str(w.named.name), v = str(w.named.value); return `env.${n} == '${v}'`; }
    case 'equals': { return `${valueToString(w.named.actual, ctx).replace(/^\$\{\{\s*|\s*\}\}$/g, '')} == '${valueToString(w.named.expected, ctx)}'`; }
    case 'expression': {
      const raw = w.block ? w.block.map((n) => n.raw).join('; ') : '';
      const guess = guessExpression(raw, ctx);
      if (guess) return guess;
      ctx.note(`\`when { expression { ${raw} } }\` must be rewritten as a GitHub expression by hand; a placeholder \`true\` was emitted.`);
      return `true /* TODO: ${raw.replace(/\*\//g, '* /')} */`;
    }
    case 'triggeredBy': { const t = str(w.named.cause || a); if (/Timer/i.test(t)) return "github.event_name == 'schedule'"; if (/User/i.test(t)) return "github.event_name == 'workflow_dispatch'"; if (/SCM|Push/i.test(t)) return "github.event_name == 'push'"; ctx.note(`\`triggeredBy '${t}'\` left as TODO.`); return `true /* TODO: triggeredBy ${t} */`; }
    case 'changeset': ctx.note('`when { changeset }` became a note: use `on.push.paths` / `on.pull_request.paths` filters, or `dorny/paths-filter`.'); return null;
    case 'changelog': ctx.note('`when { changelog }` has no equivalent; use `contains(github.event.head_commit.message, ...)` if you need it.'); return null;
    case 'beforeAgent': case 'beforeInput': case 'beforeOptions': return null;
    case 'isRestartedRun': return 'github.run_attempt > 1';
    default: ctx.note(`\`when { ${w.raw} }\` not understood; left as TODO.`); return `true /* TODO: ${w.raw.replace(/\*\//g, '* /')} */`;
  }
}

function guessExpression(raw, ctx) {
  const s = raw.trim();
  let m;
  if ((m = /^return\s+(.*)$/.exec(s))) return guessExpression(m[1], ctx);
  if ((m = /^(?:env\.)?BRANCH_NAME\s*==\s*['"]([^'"]+)['"]$/.exec(s))) return `github.ref_name == '${m[1]}'`;
  if ((m = /^(?:env\.)?BRANCH_NAME\s*!=\s*['"]([^'"]+)['"]$/.exec(s))) return `github.ref_name != '${m[1]}'`;
  if ((m = /^(?:env\.)?BRANCH_NAME\s*(==~|=~)\s*\/?(.*?)\/?$/.exec(s))) { ctx.note(`Regex branch match \`${s}\` approximated with startsWith/contains; check it.`); const p = m[2].replace(/^\^|\$$/g, '').replace(/\\\//g, '/').replace(/\.\*$/, ''); return `startsWith(github.ref_name, '${p}')`; }
  if ((m = /^params\.(\w+)\s*(==|!=)\s*(true|false)$/.exec(s))) return `inputs.${m[1]} ${m[2]} ${m[3]}`;
  if ((m = /^params\.(\w+)$/.exec(s))) return `inputs.${m[1]}`;
  if ((m = /^!params\.(\w+)$/.exec(s))) return `!inputs.${m[1]}`;
  if ((m = /^params\.(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/.exec(s))) return `inputs.${m[1]} ${m[2]} '${m[3]}'`;
  if ((m = /^env\.(\w+)\s*(==|!=)\s*['"]([^'"]*)['"]$/.exec(s))) return `env.${m[1]} ${m[2]} '${m[3]}'`;
  if ((m = /^env\.(\w+)\s*(==|!=)\s*null$/.exec(s))) return `env.${m[1]} ${m[2]} ''`;
  if ((m = /^currentBuild\.(?:result|currentResult)\s*==\s*['"](\w+)['"]$/.exec(s))) return m[1] === 'SUCCESS' ? 'success()' : 'failure()';
  if ((m = /^fileExists\(\s*['"]([^'"]+)['"]\s*\)$/.exec(s))) return `hashFiles('${m[1]}') != ''`;
  if ((m = /^!fileExists\(\s*['"]([^'"]+)['"]\s*\)$/.exec(s))) return `hashFiles('${m[1]}') == ''`;
  if ((m = /^(?:env\.)?BRANCH_NAME\.startsWith\(['"]([^'"]+)['"]\)$/.exec(s))) return `startsWith(github.ref_name, '${m[1]}')`;
  if ((m = /^(?:env\.)?(TAG_NAME|GIT_TAG)\s*(!=|==)\s*null$/.exec(s))) return m[2] === '!=' ? "startsWith(github.ref, 'refs/tags/')" : "!startsWith(github.ref, 'refs/tags/')";
  if ((m = /^(?:env\.)?CHANGE_ID\s*(!=|==)\s*null$/.exec(s))) return `github.event_name ${m[1] === '!=' ? '==' : '!='} 'pull_request'`;
  if ((m = /^(.+?)\s*(&&|\|\|)\s*(.+)$/.exec(s))) { const l = guessExpression(m[1], ctx), r = guessExpression(m[3], ctx); if (l && r) return `(${l}) ${m[2]} (${r})`; }
  if ((m = /^!\s*\((.+)\)$/.exec(s))) { const i = guessExpression(m[1], ctx); if (i) return `!(${i})`; }
  return null;
}

function globToCond(pat, prefix) {
  if (!pat.includes('*') && !pat.includes('?')) return `github.ref == '${prefix}${pat}'`;
  if (/^[^*?]+\*$/.test(pat)) return `startsWith(github.ref, '${prefix}${pat.slice(0, -1)}')`;
  if (/^\*[^*?]+$/.test(pat)) return `endsWith(github.ref, '${pat.slice(1)}')`;
  if (pat === '*' || pat === '**') return `startsWith(github.ref, '${prefix}')`;
  const parts = pat.split(/\*+/).filter(Boolean);
  if (parts.length === 1) return `contains(github.ref, '${parts[0]}')`;
  return parts.map((p) => `contains(github.ref, '${p}')`).join(' && ');
}

// ----- steps

function stepName(group, name) {
  if (group && group.stage) return name && name !== group.stage ? `${group.stage}: ${name}` : group.stage;
  return name || undefined;
}

function applyGroup(step, group, scope) {
  if (!group) return step;
  if (group.cond) step.if = step.if ? `(${group.cond}) && (${step.if})` : group.cond;
  if (group.env) step.env = { ...group.env, ...(step.env || {}) };
  if (scope.env) step.env = { ...scope.env, ...(step.env || {}) };
  if (scope.dir && step.run !== undefined) step['working-directory'] = scope.dir;
  if (scope.timeout && step.run !== undefined) step['timeout-minutes'] = scope.timeout;
  if (scope.continueOnError) step['continue-on-error'] = true;
  if (scope.cond) step.if = step.if ? `(${scope.cond}) && (${step.if})` : scope.cond;
  return step;
}

function convertSteps(block, ctx, group, scope = {}) {
  const out = [];
  for (const s of block || []) {
    if (s.kind === 'raw') {
      if (/^def\s+(\w+)/.test(s.raw)) ctx.vars.add(RegExp.$1);
      out.push(todoStep(`Groovy statement needs a manual rewrite`, s.raw, group, scope, ctx));
      continue;
    }
    if (s.kind === 'if') {
      const guess = guessExpression(s.cond, ctx);
      const cond = guess || `true /* TODO: if (${s.cond.replace(/\*\//g, '* /')}) */`;
      if (!guess) ctx.note(`Groovy condition \`if (${s.cond})\` could not be translated; a placeholder \`true\` was emitted on the affected steps.`);
      const inner = (c) => ({ ...scope, cond: scope.cond ? `(${scope.cond}) && (${c})` : c });
      out.push(...convertSteps(s.block, ctx, group, inner(cond)));
      if (s.elseBlock) out.push(...convertSteps(s.elseBlock, ctx, group, inner(`!(${cond.split(' /*')[0]})`)));
      continue;
    }
    if (s.kind === 'try') {
      out.push(...convertSteps(s.block, ctx, group, scope));
      if (s.catchBlock && s.catchBlock.length) { out.push(...convertSteps(s.catchBlock, ctx, group, { ...scope, cond: scope.cond ? `(${scope.cond}) && failure()` : 'failure()' })); }
      if (s.finallyBlock && s.finallyBlock.length) { out.push(...convertSteps(s.finallyBlock, ctx, group, { ...scope, cond: scope.cond ? `(${scope.cond}) && always()` : 'always()' })); }
      continue;
    }
    if (s.kind === 'assign') {
      if (s.name.startsWith('env.')) {
        const n = s.name.slice(4); ctx.envNames.add(n);
        const v = s.value;
        if (v.type === 'call' && v.name === 'sh' && (v.named.returnStdout)) {
          out.push(applyGroup({ name: stepName(group, `Set ${n}`), run: `echo "${n}=$(${shellOf(v, ctx)})" >> "$GITHUB_ENV"` }, group, scope));
        } else {
          out.push(applyGroup({ name: stepName(group, `Set ${n}`), run: `echo "${n}=${valueToString(v, ctx)}" >> "$GITHUB_ENV"` }, group, scope));
        }
        continue;
      }
      if (/^currentBuild\./.test(s.name)) { ctx.note(`\`${s.raw}\` dropped (Jenkins build metadata).`); continue; }
      ctx.vars.add(s.name.split('.')[0]);
      // def-less variable assignment from sh returnStdout
      const v = s.value;
      if (v.type === 'call' && v.name === 'sh' && v.named.returnStdout) {
        ctx.envNames.add(s.name);
        out.push(applyGroup({ name: stepName(group, `Set ${s.name}`), run: `echo "${s.name}=$(${shellOf(v, ctx)})" >> "$GITHUB_ENV"` }, group, scope));
        ctx.note(`Groovy variable \`${s.name}\` captured from \`sh\` was exported to \`$GITHUB_ENV\`; later steps can read it as \`$${s.name}\` or \`\${{ env.${s.name} }}\`.`);
        continue;
      }
      if (v.type === 'string' || v.type === 'number' || v.type === 'bool') {
        ctx.envNames.add(s.name);
        out.push(applyGroup({ name: stepName(group, `Set ${s.name}`), run: `echo "${s.name}=${valueToString(v, ctx)}" >> "$GITHUB_ENV"` }, group, scope));
        continue;
      }
      out.push(todoStep('Groovy assignment needs a manual rewrite', s.raw, group, scope, ctx));
      continue;
    }
    if (s.kind !== 'call') continue;
    const a = firstArg(s);
    switch (s.name) {
      case 'sh': {
        const script = shellOf(s, ctx);
        const step = { name: stepName(group, labelOf(s) || firstLine(script)), run: script };
        if (s.named.returnStdout || s.named.returnStatus) ctx.note(`\`sh\` with returnStdout/returnStatus: capture the value with \`echo "name=value" >> "$GITHUB_OUTPUT"\` and read it via \`steps.<id>.outputs.name\`.`);
        out.push(applyGroup(step, group, scope));
        break;
      }
      case 'bat': {
        const script = shellOf(s, ctx);
        out.push(applyGroup({ name: stepName(group, labelOf(s) || firstLine(script)), shell: 'cmd', run: script }, group, scope));
        break;
      }
      case 'powershell': case 'pwsh': {
        const script = shellOf(s, ctx);
        out.push(applyGroup({ name: stepName(group, labelOf(s) || firstLine(script)), shell: 'pwsh', run: script }, group, scope));
        break;
      }
      case 'echo': {
        const msg = valueToString(s.named.message || a, ctx);
        out.push(applyGroup({ name: stepName(group, 'Echo'), run: `echo ${shellQuote(msg)}` }, group, scope));
        break;
      }
      case 'checkout': {
        const step = { name: stepName(group, 'Checkout'), uses: 'actions/checkout@v4' };
        if (a && a.type === 'call' && (a.name === 'scmGit' || a.name === 'scm') === false) { /* fallthrough */ }
        if (a && a.type !== 'ident') { const w = checkoutWith(a, ctx); if (w) step.with = w; }
        if (scope.dir) step.with = { ...(step.with || {}), path: scope.dir };
        out.push(applyGroup(step, group, scope));
        break;
      }
      case 'git': {
        const step = { name: stepName(group, 'Checkout'), uses: 'actions/checkout@v4' };
        const w = {};
        const url = str(s.named.url || a);
        if (url && !/^\$\{\{/.test(url)) { const repo = repoFromUrl(url); if (repo) w.repository = repo; else ctx.note(`\`git url: '${url}'\` is not a GitHub URL; checkout with \`run: git clone\` instead.`); }
        if (s.named.branch) w.ref = valueToString(s.named.branch, ctx);
        if (s.named.credentialsId) { w.token = `\${{ secrets.${ctx.secret(str(s.named.credentialsId))} }}`; }
        if (Object.keys(w).length) step.with = w;
        out.push(applyGroup(step, group, scope));
        break;
      }
      case 'dir': {
        const d = valueToString(a, ctx);
        const sub = convertSteps(s.block, ctx, group, { ...scope, dir: scope.dir ? `${scope.dir}/${d}` : d });
        for (const st of sub) if (st.uses && !st['working-directory']) { /* actions ignore cwd */ }
        out.push(...sub);
        if (sub.some((st) => st.uses && st.uses !== 'actions/checkout@v4')) ctx.note(`\`dir('${d}')\` wraps a step that uses an action; actions ignore \`working-directory\`, so pass the path as an input instead.`);
        break;
      }
      case 'withEnv': {
        const env = {};
        const list = a && a.type === 'list' ? a.items : a ? [a] : [];
        for (const item of list) { const kv = valueToString(item, ctx); const i = kv.indexOf('='); if (i > 0) { env[kv.slice(0, i)] = kv.slice(i + 1); ctx.envNames.add(kv.slice(0, i)); } }
        out.push(...convertSteps(s.block, ctx, group, { ...scope, env: { ...(scope.env || {}), ...env } }));
        break;
      }
      case 'withCredentials': {
        const env = { ...(scope.env || {}) };
        const list = a && a.type === 'list' ? a.items : a ? [a] : [];
        for (const c of list) { if (c.type === 'call') Object.assign(env, credentialBinding(c, ctx)); }
        out.push(...convertSteps(s.block, ctx, group, { ...scope, env }));
        break;
      }
      case 'timeout': {
        const mins = toMinutes(s, ctx);
        out.push(...convertSteps(s.block, ctx, group, { ...scope, timeout: mins }));
        break;
      }
      case 'retry': {
        const n = str(a);
        const sub = convertSteps(s.block, ctx, group, scope);
        for (const st of sub) {
          if (st.run !== undefined) {
            const wrapped = { name: st.name, uses: 'nick-fields/retry@v3', with: { max_attempts: Number(n) || 3, timeout_minutes: st['timeout-minutes'] || 30, command: st['working-directory'] ? `cd ${shellQuote(st['working-directory'])} && ${st.run}` : st.run } };
            if (st.if) wrapped.if = st.if; if (st.env) wrapped.env = st.env; if (st.shell) wrapped.with.shell = st.shell;
            out.push(wrapped);
          } else out.push(st);
        }
        ctx.note(`\`retry(${n})\` became \`nick-fields/retry@v3\`; review the wrapped command.`);
        break;
      }
      case 'script': {
        // Try to convert the statements inside script {} as if they were steps; unknowns become TODOs.
        out.push(...convertSteps(s.block, ctx, group, scope));
        break;
      }
      case 'archiveArtifacts': {
        const pattern = str(s.named.artifacts || a);
        const step = { name: stepName(group, 'Upload artifacts'), uses: 'actions/upload-artifact@v4', with: { name: slug(group && group.stage ? group.stage + '-artifacts' : 'artifacts'), path: pattern.split(',').map((p) => p.trim()).join('\n') } };
        if (s.named.allowEmptyArchive && s.named.allowEmptyArchive.value) step.with['if-no-files-found'] = 'ignore';
        if (s.named.excludes) step.with.path += '\n' + str(s.named.excludes).split(',').map((p) => '!' + p.trim()).join('\n');
        out.push(applyGroup(step, group, scope));
        break;
      }
      case 'junit': {
        const pattern = str(s.named.testResults || a);
        const step = { name: stepName(group, 'Publish test results'), uses: 'mikepenz/action-junit-report@v5', if: 'always()', with: { report_paths: pattern } };
        out.push(applyGroup(step, group, scope));
        ctx.note('`junit` became `mikepenz/action-junit-report`; it needs `permissions: checks: write` (add it at the top of the workflow or on the job).');
        break;
      }
      case 'stash': {
        const nm = str(s.named.name || a);
        const step = { name: stepName(group, `Stash ${nm}`), uses: 'actions/upload-artifact@v4', with: { name: `stash-${slug(nm)}`, path: s.named.includes ? str(s.named.includes).split(',').map((p) => p.trim()).join('\n') : '.' } };
        if (s.named.excludes) step.with.path += '\n' + str(s.named.excludes).split(',').map((p) => '!' + p.trim()).join('\n');
        out.push(applyGroup(step, group, scope));
        ctx.note('`stash`/`unstash` became upload/download-artifact. Artifacts persist after the run and do not keep file permissions; `chmod +x` after download if needed.');
        break;
      }
      case 'unstash': {
        const nm = str(s.named.name || a);
        out.push(applyGroup({ name: stepName(group, `Unstash ${nm}`), uses: 'actions/download-artifact@v4', with: { name: `stash-${slug(nm)}` } }, group, scope));
        break;
      }
      case 'sleep': {
        const n = str(s.named.time || a); const unit = s.named.unit ? str(s.named.unit).toUpperCase() : 'SECONDS';
        const secs = Math.ceil(Number(n) * ({ SECONDS: 1, MINUTES: 60, HOURS: 3600 }[unit] || 1));
        out.push(applyGroup({ name: stepName(group, 'Sleep'), run: `sleep ${secs}` }, group, scope));
        break;
      }
      case 'error': {
        const msg = valueToString(s.named.message || a, ctx);
        out.push(applyGroup({ name: stepName(group, 'Fail'), run: `echo "::error::${msg.replace(/"/g, '\\"')}"\nexit 1` }, group, scope));
        break;
      }
      case 'unstable': {
        const msg = valueToString(s.named.message || a, ctx);
        out.push(applyGroup({ name: stepName(group, 'Mark unstable'), run: `echo "::warning::${msg.replace(/"/g, '\\"')}"` }, group, scope));
        ctx.note('Jenkins has an UNSTABLE result; Actions does not. `unstable()` became a warning annotation.');
        break;
      }
      case 'catchError': case 'warnError': {
        out.push(...convertSteps(s.block, ctx, group, { ...scope, continueOnError: true }));
        ctx.note(`\`${s.name}\` became \`continue-on-error: true\` on the wrapped steps.`);
        break;
      }
      case 'deleteDir': out.push(applyGroup({ name: stepName(group, 'Clean workspace'), run: 'rm -rf ./* ./.[!.]*' }, group, scope)); break;
      case 'cleanWs': case 'cleanWs()': ctx.note('`cleanWs` dropped: hosted runners start with a fresh workspace. Keep a cleanup step on self-hosted runners.'); break;
      case 'milestone': case 'lock': {
        if (s.name === 'lock') { out.push(...convertSteps(s.block, ctx, group, scope)); ctx.note('`lock` became a note: use `concurrency: { group: ... }` on the job or workflow.'); }
        else ctx.note('`milestone` dropped; use `concurrency` with `cancel-in-progress: true`.');
        break;
      }
      case 'input': {
        ctx.note(`\`input\` step ("${str(s.named.message || a)}") has no step-level equivalent; put the following steps in a job with \`environment:\` protected by required reviewers.`);
        out.push(todoStep('Manual approval: use a protected environment', s.raw, group, scope, ctx));
        break;
      }
      case 'build': {
        const job = str(s.named.job || a);
        out.push(applyGroup({ name: stepName(group, `Trigger ${job}`), run: `gh workflow run ${shellQuote(job)}`, env: { GH_TOKEN: '${{ github.token }}' } }, group, scope));
        ctx.note(`\`build job: '${job}'\` became \`gh workflow run\`; the target must be a workflow with \`workflow_dispatch\` in this repo (use a PAT for other repos). Jenkins waited for the result by default; \`gh run watch\` can do that.`);
        break;
      }
      case 'publishHTML': {
        const target = a && a.type === 'map' ? a.entries : a && a.type === 'call' && a.named ? a.named : s.named.target && s.named.target.type === 'map' ? s.named.target.entries : s.named;
        const dirv = target && target.reportDir ? str(target.reportDir) : '.';
        out.push(applyGroup({ name: stepName(group, 'Upload HTML report'), uses: 'actions/upload-artifact@v4', with: { name: slug(target && target.reportName ? str(target.reportName) : 'html-report'), path: dirv } }, group, scope));
        break;
      }
      case 'withMaven': { out.push(...convertSteps(s.block, ctx, group, scope)); ctx.note('`withMaven` wrapper removed; run Maven directly (add `actions/setup-java` with `cache: maven`).'); break; }
      case 'withSonarQubeEnv': { out.push(...convertSteps(s.block, ctx, group, scope)); ctx.note('`withSonarQubeEnv` removed; set `SONAR_TOKEN`/`SONAR_HOST_URL` secrets and use `SonarSource/sonarqube-scan-action`.'); break; }
      case 'withDockerRegistry': case 'withRegistry': {
        const url = str(s.named.url || (a && a.type === 'map' ? a.entries.url : a)); const cred = s.named.credentialsId || (a && a.type === 'map' ? a.entries.credentialsId : null);
        const w = {}; if (url && !/hub\.docker|index\.docker\.io|^$/.test(url)) w.registry = url.replace(/^https?:\/\//, '');
        if (cred) { const id = str(cred); w.username = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}`; w.password = `\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`; }
        out.push(applyGroup({ name: stepName(group, 'Docker login'), uses: 'docker/login-action@v3', with: w }, group, scope));
        out.push(...convertSteps(s.block, ctx, group, scope));
        break;
      }
      case 'withAWS': { ctx.note('`withAWS` became `aws-actions/configure-aws-credentials`; prefer OIDC (`role-to-assume`) over static keys.'); out.push(applyGroup({ name: stepName(group, 'Configure AWS credentials'), uses: 'aws-actions/configure-aws-credentials@v4', with: { 'aws-region': s.named.region ? str(s.named.region) : 'us-east-1', 'role-to-assume': 'TODO' } }, group, scope)); out.push(...convertSteps(s.block, ctx, group, scope)); break; }
      case 'withKubeConfig': { ctx.note('`withKubeConfig` became a TODO; store the kubeconfig as a secret and write it to `$HOME/.kube/config`, or use `azure/k8s-set-context`.'); out.push(todoStep('Configure kubeconfig', s.raw.split('\n')[0], group, scope, ctx)); out.push(...convertSteps(s.block, ctx, group, scope)); break; }
      case 'mail': case 'emailext': ctx.note(`\`${s.name}\` dropped: GitHub emails workflow failures to the committer by default; use \`dawidd6/action-send-mail\` for custom mail.`); break;
      case 'slackSend': ctx.note('`slackSend` dropped; use `slackapi/slack-github-action` with a webhook secret.'); out.push(todoStep('Slack notification', s.raw.split('\n')[0], group, scope, ctx)); break;
      case 'tool': { ctx.note(`\`tool '${str(a)}'\` became a note; use the matching setup action instead.`); break; }
      case 'readFile': case 'writeFile': case 'readJSON': case 'readYaml': case 'readProperties': case 'fileExists': case 'findFiles': case 'pwd': case 'isUnix': case 'libraryResource': case 'load': case 'library':
        out.push(todoStep(`\`${s.name}\` is a Groovy/Pipeline Utility step; rewrite it as a shell command`, s.raw, group, scope, ctx)); break;
      case 'docker.build': case 'docker.image': case 'docker.withRegistry': {
        if (s.name === 'docker.withRegistry') { const url = str(s.args[0]); const w = {}; if (url && !/hub\.docker|index\.docker\.io/.test(url)) w.registry = url.replace(/^https?:\/\//, ''); if (s.args[1]) { const id = str(s.args[1]); w.username = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}`; w.password = `\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`; } out.push(applyGroup({ name: stepName(group, 'Docker login'), uses: 'docker/login-action@v3', with: w }, group, scope)); out.push(...convertSteps(s.block, ctx, group, scope)); break; }
        if (s.name === 'docker.build') { const tag = valueToString(s.args[0], ctx); const rest = s.args[1] ? valueToString(s.args[1], ctx) : '.'; out.push(applyGroup({ name: stepName(group, 'Docker build'), run: `docker build -t ${shellQuote(tag)} ${rest}` }, group, scope)); if (s.chain) ctx.note(`Chained docker call \`.${s.chain.join('.')}\` on docker.build needs a manual \`docker push\`/\`docker run\` step.`); break; }
        out.push(todoStep('Docker DSL call needs a manual rewrite (use docker CLI or docker/* actions)', s.raw, group, scope, ctx)); break;
      }
      case 'parallel': {
        ctx.note('Scripted `parallel` branches were flattened into sequential steps; split them into separate jobs if they must run concurrently.');
        for (const [k, v] of Object.entries(s.named)) if (v.type === 'closure') out.push(...convertSteps(v.block, ctx, { ...(group || {}), stage: group && group.stage ? `${group.stage} / ${k}` : k }, scope));
        if (a && a.type === 'map') for (const [k, v] of Object.entries(a.entries)) if (v.type === 'closure') out.push(...convertSteps(v.block, ctx, { ...(group || {}), stage: k }, scope));
        break;
      }
      case 'stage': { // scripted stage inside steps
        const nm = str(a); out.push(...convertSteps(s.block, ctx, { ...(group || {}), stage: group && group.stage ? `${group.stage} / ${nm}` : nm }, scope)); break;
      }
      case 'node': case 'ws': case 'ansiColor': case 'timestamps': case 'wrap': case 'withGradle': case 'configFileProvider': case 'sshagent': case 'nodejs': case 'withPythonEnv': case 'withNPM': case 'withGroovy': {
        if (s.name === 'sshagent') { ctx.note('`sshagent` became `webfactory/ssh-agent`; store the private key as a secret.'); const id = a && a.type === 'list' && a.items[0] ? str(a.items[0]) : a ? str(a) : 'ssh'; out.push(applyGroup({ name: stepName(group, 'Start ssh-agent'), uses: 'webfactory/ssh-agent@v0.9.0', with: { 'ssh-private-key': `\${{ secrets.${ctx.secret(id)} }}` } }, group, scope)); }
        else if (s.name === 'configFileProvider') ctx.note('`configFileProvider` dropped; commit the config file or write it from a secret in a `run` step.');
        else if (s.name === 'wrap') ctx.note(`\`wrap\` (${s.raw.split('\n')[0]}) removed; ANSI colour and Xvfb need no wrapper on Actions (use \`FORCE_COLOR=1\`).`);
        out.push(...convertSteps(s.block, ctx, group, scope));
        break;
      }
      case 'step': case 'properties': case 'currentBuild': case 'println': {
        if (s.name === 'println') { out.push(applyGroup({ name: stepName(group, 'Echo'), run: `echo ${shellQuote(valueToString(a, ctx))}` }, group, scope)); break; }
        if (s.name === 'properties') { ctx.note('Scripted `properties([...])` (parameters, triggers, options) should be moved into `on:`/`concurrency:`; emitted as a TODO.'); }
        out.push(todoStep(`\`${s.name}\` needs a manual rewrite`, s.raw, group, scope, ctx)); break;
      }
      default: {
        out.push(todoStep(`Unknown step \`${s.name}\` (probably a plugin); rewrite it`, s.raw, group, scope, ctx));
      }
    }
  }
  return out;
}

function todoStep(title, raw, group, scope, ctx) {
  const body = raw.length > 600 ? raw.slice(0, 600) + '\n…' : raw;
  ctx.todoCount = (ctx.todoCount || 0) + 1;
  const step = { name: stepName(group, `TODO: ${title.replace(/`/g, '')}`), run: `# TODO: ${title.replace(/`/g, "'")}\n` + body.split('\n').map((l) => '# ' + l).join('\n') + '\necho "TODO: unconverted Jenkins step" && exit 1' };
  return applyGroup(step, group, scope);
}

function labelOf(s) { return s.named.label ? str(s.named.label) : null; }
function firstLine(script) {
  const l = script.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'))[0] || 'Run';
  if (l.length <= 60) return l;
  let cut = l.slice(0, 57);
  const open = cut.lastIndexOf('${{'); if (open >= 0 && cut.indexOf('}}', open) < 0) cut = cut.slice(0, open);
  return cut.trimEnd() + '…';
}

function shellOf(s, ctx) {
  const v = s.named.script || firstArg(s);
  if (!v) return '';
  let script;
  if (v.type === 'string') script = v.interpolate ? mapInterpolation(v.value, ctx, { inShell: true }) : v.value;
  else script = valueToString(v, ctx);
  // Normalise Groovy-style triple-quoted indentation
  const lines = script.replace(/\r/g, '').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), 0) || 0;
  const minIndent = lines.filter((l) => l.trim()).reduce((m, l) => Math.min(m, l.match(/^\s*/)[0].length), Infinity);
  const out = lines.map((l) => l.slice(Number.isFinite(minIndent) ? minIndent : 0)).join('\n');
  void indent;
  return out.replace(/^#!\/bin\/(ba)?sh\s*\n/, '');
}

function shellQuote(s) { s = String(s); if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s; if (s.includes('${{')) return '"' + s.replace(/(["\\])/g, '\\$1') + '"'; return "'" + s.replace(/'/g, "'\\''") + "'"; }

function checkoutWith(a, ctx) {
  // checkout([$class: 'GitSCM', branches: [[name: '*/main']], userRemoteConfigs: [[url: 'x', credentialsId: 'y']]])
  // checkout scmGit(branches: [[name: 'main']], userRemoteConfigs: [[url: 'x']])
  const w = {};
  const entries = a.type === 'map' ? a.entries : a.type === 'call' ? a.named : null;
  if (!entries) return null;
  if (entries.branches && entries.branches.type === 'list' && entries.branches.items[0] && entries.branches.items[0].type === 'map') {
    const ref = str(entries.branches.items[0].entries.name).replace(/^\*\//, '');
    if (ref && ref !== '**' && !ref.includes('*')) w.ref = ref;
  }
  if (entries.userRemoteConfigs && entries.userRemoteConfigs.type === 'list' && entries.userRemoteConfigs.items[0] && entries.userRemoteConfigs.items[0].type === 'map') {
    const rc = entries.userRemoteConfigs.items[0].entries;
    const url = rc.url ? str(rc.url) : '';
    const repo = repoFromUrl(url);
    if (repo) w.repository = repo; else if (url) ctx.note(`Checkout URL \`${url}\` is not a GitHub URL; actions/checkout only clones GitHub repos. Use \`git clone\` in a run step.`);
    if (rc.credentialsId) w.token = `\${{ secrets.${ctx.secret(str(rc.credentialsId))} }}`;
  }
  if (entries.extensions && entries.extensions.type === 'list') {
    for (const ext of entries.extensions.items) {
      const cls = ext.type === 'map' ? str(ext.entries.$class) : ext.type === 'call' ? ext.name : '';
      if (/SubmoduleOption|submodule/i.test(cls)) w.submodules = 'recursive';
      else if (/CloneOption|cloneOption/i.test(cls)) { const e = ext.type === 'map' ? ext.entries : ext.named; if (e && e.depth) w['fetch-depth'] = Number(str(e.depth)); if (e && e.shallow && !e.depth) w['fetch-depth'] = 1; }
      else if (/LocalBranch|localBranch/i.test(cls)) { /* default */ }
      else if (/CleanBeforeCheckout|CleanCheckout|cleanBeforeCheckout/i.test(cls)) { /* default on hosted */ }
      else if (/RelativeTargetDirectory|relativeTargetDirectory/i.test(cls)) { const e = ext.type === 'map' ? ext.entries : ext.named; if (e && e.relativeTargetDir) w.path = str(e.relativeTargetDir); }
      else if (/WipeWorkspace|PruneStaleBranch|CheckoutOption|UserIdentity|PathRestriction|lfs|GitLFSPull/i.test(cls)) { if (/lfs/i.test(cls)) w.lfs = true; }
      else ctx.note(`Checkout extension \`${cls}\` dropped.`);
    }
  }
  return Object.keys(w).length ? w : null;
}

function repoFromUrl(url) {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? m[1] : null;
}

function credentialBinding(c, ctx) {
  const id = str(c.named.credentialsId);
  const env = {};
  switch (c.name) {
    case 'string': { const v = str(c.named.variable); env[v] = `\${{ secrets.${ctx.secret(id)} }}`; ctx.envNames.add(v); break; }
    case 'usernamePassword': { const u = str(c.named.usernameVariable), p = str(c.named.passwordVariable); if (u) { env[u] = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}`; ctx.envNames.add(u); } if (p) { env[p] = `\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`; ctx.envNames.add(p); } break; }
    case 'usernameColonPassword': { const v = str(c.named.variable); env[v] = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}:\${{ secrets.${ctx.secret(id, 'PASSWORD')} }}`; ctx.envNames.add(v); break; }
    case 'file': { const v = str(c.named.variable); env[v] = `\${{ runner.temp }}/${v.toLowerCase()}`; ctx.secret(id); ctx.envNames.add(v); ctx.note(`\`file\` credential \`${id}\`: store the file base64-encoded in secret \`${ctx.secret(id)}\` and add a step: \`echo "\${{ secrets.${ctx.secret(id)} }}" | base64 -d > "$${v}"\` before it is used.`); break; }
    case 'sshUserPrivateKey': { const k = str(c.named.keyFileVariable), u = str(c.named.usernameVariable), pp = str(c.named.passphraseVariable); if (k) { env[k] = `\${{ runner.temp }}/${k.toLowerCase()}`; ctx.envNames.add(k); } if (u) { env[u] = `\${{ secrets.${ctx.secret(id, 'USERNAME')} }}`; ctx.envNames.add(u); } if (pp) { env[pp] = `\${{ secrets.${ctx.secret(id, 'PASSPHRASE')} }}`; ctx.envNames.add(pp); } ctx.note(`SSH key credential \`${id}\`: store the key in secret \`${ctx.secret(id)}\` and write it to "$${k || 'KEY'}" with \`chmod 600\` in a step before use, or use \`webfactory/ssh-agent\`.`); break; }
    case 'certificate': case 'dockerCert': case 'zip': { ctx.note(`Credential binding \`${c.name}\` (${id}) must be handled manually (store as base64 secret and decode).`); ctx.secret(id); break; }
    case 'aws': case 'AmazonWebServicesCredentialsBinding': { env.AWS_ACCESS_KEY_ID = `\${{ secrets.${ctx.secret(id, 'AWS_ACCESS_KEY_ID')} }}`; env.AWS_SECRET_ACCESS_KEY = `\${{ secrets.${ctx.secret(id, 'AWS_SECRET_ACCESS_KEY')} }}`; ctx.note('AWS credential binding: prefer `aws-actions/configure-aws-credentials` with OIDC instead of static keys.'); break; }
    default: { ctx.note(`Credential binding \`${c.name}\` not recognised; mapped to one secret.`); const v = str(c.named.variable) || id.toUpperCase(); env[v] = `\${{ secrets.${ctx.secret(id)} }}`; }
  }
  return env;
}

// ----- post

const POST_IF = { always: 'always()', success: 'success()', failure: 'failure()', unstable: 'failure()', changed: 'always()', fixed: 'success()', regression: 'failure()', aborted: 'cancelled()', cleanup: 'always()', unsuccessful: '!success()', notBuilt: 'cancelled()' };

function convertPost(block, ctx, scope, jobIds, stageName) {
  const out = [];
  for (const p of block || []) {
    if (p.kind !== 'call') continue;
    let cond = POST_IF[p.name];
    if (!cond) { ctx.note(`post condition \`${p.name}\` unknown; treated as always().`); cond = 'always()'; }
    if (p.name === 'changed' || p.name === 'fixed' || p.name === 'regression') ctx.note(`post { ${p.name} } compares with the previous build; Actions has no such state, so it runs on ${cond}.`);
    if (p.name === 'unstable') ctx.note('post { unstable } runs on failure(); Actions has no UNSTABLE result.');
    if (scope === 'pipeline' && jobIds && jobIds.length) {
      const map = { 'success()': jobIds.map((j) => `needs.${j}.result == 'success'`).join(' && '), 'failure()': `contains(needs.*.result, 'failure')`, 'cancelled()': `contains(needs.*.result, 'cancelled')`, '!success()': `contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')`, 'always()': 'always()' };
      cond = map[cond] || cond;
    }
    const group = stageName ? { stage: `${stageName} (post ${p.name})` } : { stage: `post ${p.name}` };
    const steps = convertSteps(p.block, ctx, group, { cond });
    out.push(...steps);
  }
  return out;
}

// ----- scripted pipelines

function convertScripted(tree, ctx) {
  ctx.note('This is a scripted (Groovy) pipeline. Control flow, variables and library calls were turned into TODO steps; expect to finish the conversion by hand.');
  const wf = { on: convertTriggers(null, null, ctx) };
  const jobs = {};
  // Find node { } blocks (possibly inside other blocks like timeout/properties/timestamps)
  const nodes = [];
  const walk = (block, parentLabel) => {
    for (const n of block || []) {
      if (n.kind !== 'call') continue;
      if (n.name === 'node') { nodes.push({ label: n.args.length ? str(n.args[0]) : null, block: n.block }); continue; }
      if (n.name === 'properties') { ctx.note('Scripted `properties([...])` was dropped; move parameters/triggers into `on:` by hand.'); continue; }
      if (n.block) walk(n.block, parentLabel);
    }
  };
  walk(tree);
  if (!nodes.length) nodes.push({ label: null, block: tree });
  const agentOf = (label) => (label ? { runsOn: labelToRunsOn(label, ctx), container: null } : { runsOn: ctx.opts.runner, container: null });
  if (ctx.opts.mode === 'single' || nodes.length === 1) {
    const agent = agentOf(nodes[0].label);
    const job = buildJob('build', agent, ctx, { checkout: false, toolSteps: [] });
    for (const nd of nodes) {
      const body = nd.block || [];
      job.steps.push(...convertSteps(body, ctx, {}, {}));
    }
    finishJob(job, ctx);
    jobs[job.__id] = stripMeta(job);
  } else {
    let prev = [];
    for (const nd of nodes) {
      const agent = agentOf(nd.label);
      const body = nd.block || [];
      const stages = body.filter((n) => n.kind === 'call' && n.name === 'stage');
      if (ctx.opts.mode === 'jobs' && stages.length) {
        for (const st of stages) {
          const job = buildJob(str(firstArg(st)), agent, ctx, { checkout: false, toolSteps: [] });
          if (prev.length) job.needs = prev;
          job.steps.push(...convertSteps(st.block, ctx, {}, {}));
          finishJob(job, ctx); jobs[job.__id] = stripMeta(job); prev = [job.__id];
        }
      } else {
        const job = buildJob(nd.label || 'build', agent, ctx, { checkout: false, toolSteps: [] });
        if (prev.length) job.needs = prev;
        job.steps.push(...convertSteps(body, ctx, {}, {}));
        finishJob(job, ctx); jobs[job.__id] = stripMeta(job); prev = [job.__id];
      }
    }
  }
  // If no checkout step was produced, add one at the top of the first job.
  const first = jobs[Object.keys(jobs)[0]];
  if (first && !first.steps.some((s) => s.uses === 'actions/checkout@v4') && ctx.opts.checkout) first.steps.unshift({ name: 'Checkout', uses: 'actions/checkout@v4' });
  wf.jobs = jobs;
  return wf;
}

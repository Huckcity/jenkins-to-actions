import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { convertFreestyle, classifyConfig } from '../cli/freestyle.js';
import { parseXml, text, child } from '../cli/xml.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const actionlint = new URL('../tools/actionlint/actionlint', import.meta.url).pathname;
const lint = (yaml, label) => { const dir = mkdtempSync(join(tmpdir(), 'j2a-')); const p = join(dir, `${label}.yml`); execFileSync('sh', ['-c', `cat > "${p}"`], { input: yaml }); execFileSync(actionlint, ['-no-color', '-shellcheck=', '-pyflakes=', p], { stdio: 'pipe' }); };

test('xml parser handles attributes, cdata, entities and nesting', () => {
  const d = parseXml('<a x="1 &amp; 2"><b><![CDATA[<c>]]></b><d/>t &lt; u</a>');
  const a = child(d, 'a');
  assert.equal(a.attrs.x, '1 & 2'); assert.equal(text(a, 'b'), '<c>'); assert.equal(a.children.length, 2); assert.equal(a.text.trim(), 't < u');
});

test('classifies job types', () => {
  assert.equal(classifyConfig(fx('freestyle-maven.config.xml')).type, 'freestyle');
  assert.equal(classifyConfig(fx('matrix-windows.config.xml')).type, 'matrix');
  assert.equal(classifyConfig(fx('pipeline-inline.config.xml')).type, 'pipeline');
});

test('freestyle maven job converts to a valid workflow', () => {
  const r = convertFreestyle(fx('freestyle-maven.config.xml'), { name: 'widgets' });
  parseYaml(r.yaml); lint(r.yaml, 'freestyle');
  assert.match(r.yaml, /cron: '0 2 \* \* 1-5'/);
  assert.match(r.yaml, /timeout-minutes: 30/);
  assert.match(r.yaml, /NEXUS_USER: \$\{\{ secrets.NEXUS_CREDS_USERNAME \}\}/);
  assert.match(r.yaml, /mvn -B -ntp -f pom.xml -DskipTests=\$SKIP_TESTS -Drevision=\$VERSION clean verify/);
  assert.match(r.yaml, /type: choice\n\s+options: \[dev, staging\]/);
  assert.match(r.yaml, /fetch-depth: 1\n\s+submodules: recursive/);
  assert.ok(!r.yaml.includes('repository:'), 'same-repo checkout should not pin repository');
  assert.equal(r.repo, 'acme/widgets');
  assert.deepEqual(r.secrets.sort(), ['NEXUS_CREDS_PASSWORD', 'NEXUS_CREDS_USERNAME', 'SONAR_TOKEN']);
});

test('matrix job becomes strategy.matrix with os conditions', () => {
  const r = convertFreestyle(fx('matrix-windows.config.xml'), { name: 'cli' });
  parseYaml(r.yaml); lint(r.yaml, 'matrix');
  assert.match(r.yaml, /os: \[ubuntu-latest, windows-latest\]/);
  assert.match(r.yaml, /GO: \['1.22', '1.23'\]/);
  assert.match(r.yaml, /shell: cmd\n\s+run: [\s\S]*?if: runner.os == 'Windows'/);
  assert.match(r.yaml, /TODO: Build step FancyPlugin/);
});

test('audit over a directory writes report, inventory and workflows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j2a-audit-'));
  const out = execFileSync('node', [new URL('../cli/index.js', import.meta.url).pathname, 'audit', '--dir', new URL('./fixtures/', import.meta.url).pathname, '--out', dir], { encoding: 'utf8' });
  assert.match(out, /jobs analysed/);
  assert.ok(existsSync(join(dir, 'report.md')) && existsSync(join(dir, 'inventory.json')));
  const inv = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
  const types = Object.fromEntries(inv.jobs.map((j) => [j.name, j.type]));
  assert.equal(types['freestyle-maven'], 'freestyle');
  assert.equal(types['matrix-windows'], 'matrix');
  assert.equal(types['pipeline-inline'], 'pipeline-declarative');
  assert.equal(types['pipeline-scm'], 'pipeline-scm');
  assert.equal(inv.jobs.find((j) => j.name === 'matrix-windows').todos, 1);
  assert.ok(readdirSync(join(dir, 'workflows')).length >= 3);
  const report = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.match(report, /## Suggested order/); assert.match(report, /Secrets to create/);
  for (const f of readdirSync(join(dir, 'workflows'))) lint(readFileSync(join(dir, 'workflows', f), 'utf8'), f.replace('.yml', ''));
});

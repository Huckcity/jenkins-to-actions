import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { convert } from '../public/convert.js';

const dir = new URL('./fixtures/', import.meta.url);
const outDir = new URL('./out/', import.meta.url);
mkdirSync(outDir, { recursive: true });
let failed = 0;
const modes = ['jobs', 'single'];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.Jenkinsfile'))) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  for (const mode of modes) {
    const name = `${f.replace('.Jenkinsfile', '')}.${mode}.yml`;
    let res;
    try { res = convert(src, { mode }); } catch (e) { console.log(`FAIL ${name}: converter threw: ${e.stack}`); failed++; continue; }
    if (res.error) { console.log(`FAIL ${name}: ${res.error}`); failed++; continue; }
    const outPath = new URL(name, outDir);
    writeFileSync(outPath, res.yaml);
    try { parseYaml(res.yaml); } catch (e) { console.log(`FAIL ${name}: invalid YAML: ${e.message}`); failed++; continue; }
    try {
      execFileSync(new URL('../tools/actionlint/actionlint', import.meta.url).pathname, ['-no-color', '-shellcheck=', '-pyflakes=', outPath.pathname], { stdio: 'pipe' });
      console.log(`ok   ${name} (${res.notes.length} notes)`);
    } catch (e) {
      console.log(`FAIL ${name}: actionlint:\n${e.stdout.toString()}`);
      failed++;
    }
  }
}
// Spot checks on content
const full = convert(readFileSync(new URL('declarative-full.Jenkinsfile', dir), 'utf8'), { mode: 'jobs' });
const checks = [
  ['secrets mapped', full.secrets.includes('SONAR_TOKEN') && full.secrets.includes('GHCR_CREDS_USERNAME')],
  ['params -> inputs', full.yaml.includes('${{ inputs.DEPLOY_ENV }}')],
  ['BUILD_NUMBER mapped', full.yaml.includes('${{ github.run_number }}')],
  ['cron H replaced', /cron: '0 2 \* \* 1-5'/.test(full.yaml)],
  ['timeout', full.yaml.includes('timeout-minutes: 45')],
  ['concurrency', full.yaml.includes('cancel-in-progress: true')],
  ['when branch', full.yaml.includes("!(startsWith(github.ref, 'refs/heads/release/'))")],
  ['needs chain', /needs: \[build\]/.test(full.yaml)],
  ['retry wrapper', full.yaml.includes('nick-fields/retry@v3')],
  ['working-directory', full.yaml.includes('working-directory: e2e')],
  ['junit', full.yaml.includes('mikepenz/action-junit-report')],
];
for (const [label, ok] of checks) { if (!ok) { console.log(`FAIL check: ${label}`); failed++; } else console.log(`ok   check: ${label}`); }
const pm = convert(readFileSync(new URL('parallel-matrix.Jenkinsfile', dir), 'utf8'), { mode: 'jobs' });
for (const [label, ok] of [
  ['matrix', pm.yaml.includes('matrix:') && pm.yaml.includes('PLATFORM: [linux, darwin]')],
  ['exclude', pm.yaml.includes('exclude:')],
  ['windows runner', pm.yaml.includes('runs-on: windows-latest')],
  ['container', pm.yaml.includes('image: node:20-alpine')],
  ['parallel fan-in', /needs: \[unit, windows, integration\]/.test(pm.yaml)],
  ['tag cond', pm.yaml.includes("startsWith(github.ref, 'refs/tags/v')")],
]) { if (!ok) { console.log(`FAIL check(pm): ${label}`); failed++; } else console.log(`ok   check(pm): ${label}`); }
const sc = convert(readFileSync(new URL('scripted.Jenkinsfile', dir), 'utf8'), { mode: 'jobs' });
for (const [label, ok] of [
  ['scripted flagged', sc.scripted === true],
  ['withEnv', sc.yaml.includes('CI: \'true\'') || sc.yaml.includes('CI: true')],
  ['string cred', sc.yaml.includes('NPM_TOKEN: ${{ secrets.NPM_TOKEN }}')],
]) { if (!ok) { console.log(`FAIL check(sc): ${label}`); failed++; } else console.log(`ok   check(sc): ${label}`); }
console.log(failed ? `\n${failed} failure(s)` : '\nall passed');
process.exit(failed ? 1 : 0);

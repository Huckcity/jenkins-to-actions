#!/usr/bin/env node
// Entry point: `jenkins-to-actions audit ...` or `jenkins-to-actions convert <Jenkinsfile>`
import { readFileSync } from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'audit') { process.argv = [process.argv[0], process.argv[1], ...rest]; await import('./audit.js'); }
else if (cmd === 'convert') {
  const { SOURCES, TARGETS, detect } = await import('../public/converters/index.js');
  const file = rest.find((a) => !a.startsWith('--') && !['--mode', '--from', '--to', '--image'].includes(rest[rest.indexOf(a) - 1])) || 'Jenkinsfile';
  const mode = rest.includes('--mode') ? rest[rest.indexOf('--mode') + 1] : 'jobs';
  const src = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const to = rest.includes('--to') ? rest[rest.indexOf('--to') + 1] : null;
  if (to && !TARGETS[to]) { console.error(`Unknown target "${to}". Use one of: ${Object.keys(TARGETS).join(', ')}`); process.exit(1); }
  const from = to ? TARGETS[to] : rest.includes('--from') ? rest[rest.indexOf('--from') + 1] : detect(file === '-' ? '' : file, src);
  if (!SOURCES[from]) { console.error(`Unknown source "${from}". Use one of: ${Object.keys(SOURCES).filter((k) => !SOURCES[k].target).join(', ')}`); process.exit(1); }
  const { convert } = await SOURCES[from].load();
  process.stderr.write(`Converting ${SOURCES[from].name} → ${SOURCES[from].target || 'GitHub Actions'}\n`);
  const image = rest.includes('--image') ? rest[rest.indexOf('--image') + 1] : undefined;
  const r = convert(src, { mode, ...(image ? { image } : {}) });
  process.stdout.write(r.yaml);
  if (r.notes.length) process.stderr.write('\nNotes:\n' + r.notes.map((n) => `- ${n}`).join('\n') + '\n');
} else {
  console.log('Usage:\n  jenkins-to-actions audit --url https://jenkins.example.com [--user U --token T] [--out DIR]\n  jenkins-to-actions audit --dir ./configs\n  jenkins-to-actions convert <Jenkinsfile|.gitlab-ci.yml|azure-pipelines.yml|.circleci/config.yml|bitbucket-pipelines.yml|.travis.yml> [--from jenkins|gitlab|azure|circleci|bitbucket|travis] [--mode jobs|single]\n  jenkins-to-actions convert .github/workflows/ci.yml --to gitlab [--image ubuntu:24.04]     # the other direction: GitHub Actions → GitLab CI');
  process.exit(cmd ? 1 : 0);
}

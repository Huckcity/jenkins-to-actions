#!/usr/bin/env node
// Entry point: `jenkins-to-actions audit ...` or `jenkins-to-actions convert <Jenkinsfile>`
import { readFileSync } from 'node:fs';
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'audit') { process.argv = [process.argv[0], process.argv[1], ...rest]; await import('./audit.js'); }
else if (cmd === 'convert') {
  const { convert } = await import('../public/convert.js');
  const file = rest.find((a) => !a.startsWith('--')) || 'Jenkinsfile';
  const mode = rest.includes('--mode') ? rest[rest.indexOf('--mode') + 1] : 'jobs';
  const src = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  const r = convert(src, { mode });
  process.stdout.write(r.yaml);
  if (r.notes.length) process.stderr.write('\nNotes:\n' + r.notes.map((n) => `- ${n}`).join('\n') + '\n');
} else {
  console.log('Usage:\n  jenkins-to-actions audit --url https://jenkins.example.com [--user U --token T] [--out DIR]\n  jenkins-to-actions audit --dir ./configs\n  jenkins-to-actions convert Jenkinsfile [--mode jobs|single]');
  process.exit(cmd ? 1 : 0);
}

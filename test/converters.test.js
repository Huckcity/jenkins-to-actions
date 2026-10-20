import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import * as gitlab from '../public/converters/gitlab.js';
import * as azure from '../public/converters/azure.js';
import * as circleci from '../public/converters/circleci.js';
import * as bitbucket from '../public/converters/bitbucket.js';
import * as travis from '../public/converters/travis.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const actionlint = new URL('../tools/actionlint/actionlint', import.meta.url).pathname;
const outDir = mkdtempSync(join(tmpdir(), 'j2a-conv-'));
function check(label, r) {
  assert.ok(r.yaml, `${label}: no yaml (${r.notes.join('; ')})`);
  const wf = parseYaml(r.yaml);
  const p = join(outDir, `${label}.yml`);
  writeFileSync(p, r.yaml);
  try { execFileSync(actionlint, ['-no-color', '-shellcheck=', '-pyflakes=', p], { stdio: 'pipe' }); }
  catch (e) { assert.fail(`${label}: actionlint:\n${e.stdout}`); }
  return wf;
}

test('gitlab-ci', () => {
  const r = gitlab.convert(fx('gitlab-ci.yml'));
  const wf = check('gitlab', r);
  assert.deepEqual(Object.keys(wf.jobs), ['build', 'lint', 'unit', 'integration', 'docker', 'deploy-staging', 'deploy-prod']);
  assert.deepEqual(wf.jobs.docker.needs, ['build', 'lint', 'unit', 'integration']);
  assert.equal(wf.jobs.lint.needs, undefined);
  assert.equal(wf.jobs.lint['continue-on-error'], true);
  assert.equal(wf.jobs.integration['timeout-minutes'], 90);
  assert.deepEqual(wf.jobs.unit.strategy.matrix.index, [0, 1, 2]);
  assert.match(wf.jobs.unit.if, /pull_request/);
  assert.equal(wf.jobs['deploy-prod'].environment, 'production');
  assert.equal(wf.jobs['deploy-staging'].env.DEPLOY_ENV, 'staging');
  assert.match(wf.jobs['deploy-staging'].steps.at(-1).run, /apk add/);
  assert.equal(wf.env.CI_REGISTRY_IMAGE, 'ghcr.io/${{ github.repository }}');
  assert.ok(wf.jobs.unit.steps.some((s) => s.uses === 'actions/download-artifact@v4'));
  assert.ok(wf.jobs.integration.services.cache.image === 'redis:7');
});

test('azure-pipelines', () => {
  const r = azure.convert(fx('azure-pipelines.yml'));
  const wf = check('azure', r);
  assert.deepEqual(wf.on.push.branches, ['main', 'release/*']);
  assert.equal(wf.on.workflow_dispatch.inputs.deployTarget.type, 'choice');
  assert.equal(wf.jobs['build-build']['runs-on'], '${{ matrix.imageName }}');
  assert.equal(wf.jobs['build-build'].strategy.matrix.include.length, 2);
  assert.equal(wf.jobs['deploy-deploy'].environment, '${{ inputs.deployTarget }}');
  assert.match(wf.jobs['deploy-deploy'].if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(wf.jobs['deploy-perf'].if, /inputs\.runPerf == true/);
  assert.ok(wf.jobs['build-build'].steps.some((s) => s.uses === 'actions/setup-node@v4'));
  assert.ok(wf.jobs['build-build'].steps.some((s) => s.uses === 'mikepenz/action-junit-report@v5'));
  assert.equal(wf.concurrency['cancel-in-progress'], false);
  assert.match(wf['run-name'], /run_number/);
});

test('circleci', () => {
  const r = circleci.convert(fx('circleci.yml'));
  const wf = check('circleci', r);
  const ids = Object.keys(wf.jobs);
  assert.ok(ids.includes('build-test-deploy-unit-tests') && ids.includes('nightly-build'));
  assert.deepEqual(wf.jobs['build-test-deploy-unit-tests'].needs, ['build-test-deploy-build']);
  assert.equal(wf.jobs['build-test-deploy-unit-tests'].container.image, 'cimg/node:20.11');
  assert.equal(wf.jobs['build-test-deploy-unit-tests'].services.postgres.image, 'cimg/postgres:16.1');
  assert.match(wf.jobs['build-test-deploy-unit-tests'].steps.find((s) => /Run unit/.test(s.name)).run, /test:unit/);
  assert.match(wf.jobs['build-test-deploy-e2e-tests'].if, /release/);
  assert.equal(wf.jobs['build-test-deploy-hold'].environment, 'manual-approval');
  assert.match(wf.jobs['build-test-deploy-deploy'].if, /refs\/tags\/v/);
  assert.ok(wf.jobs['build-test-deploy-deploy'].steps.some((s) => s.with && s.with.name === 'workspace-build-test-deploy-build'));
  assert.ok(wf.jobs['build-test-deploy-deploy'].steps.some((s) => s.uses === 'webfactory/ssh-agent@v0.9.0'));
  assert.equal(wf.jobs['nightly-build'].if, "github.event_name == 'schedule'");
  assert.match(wf.jobs['build-test-deploy-build'].if, /!= 'schedule'/);
  assert.match(wf.jobs['build-test-deploy-build'].steps.find((s) => s.uses === 'actions/cache@v4').with.key, /hashFiles\('package-lock.json'\)/);
  assert.equal(wf.on.schedule[0].cron, '0 2 * * *');
});

test('bitbucket-pipelines', () => {
  const r = bitbucket.convert(fx('bitbucket-pipelines.yml'));
  const wf = check('bitbucket', r);
  assert.deepEqual(wf.jobs['default-unit-tests'].needs, ['default-build']);
  assert.deepEqual(wf.jobs['default-lint'].needs, ['default-build']);
  assert.equal(wf.jobs['main-integration'].services.postgres.image, 'postgres:16');
  assert.equal(wf.jobs['main-integration'].services.docker, undefined);
  assert.ok(wf.jobs['main-integration'].steps.some((s) => s.uses === 'actions/download-artifact@v4'));
  assert.equal(wf.jobs['main-deploy-to-production'].environment, 'production');
  assert.ok(wf.jobs['main-deploy-to-staging'].steps.some((s) => s.uses === 'aws-actions/configure-aws-credentials@v4'));
  assert.match(wf.jobs['tag-release'].if, /refs\/tags\/v/);
  assert.equal(wf.on.workflow_dispatch.inputs.pipeline.options[0], 'nightly-perf');
  assert.equal(wf.on.workflow_dispatch.inputs.TARGET.type, 'choice');
  assert.equal(wf.jobs['default-build']['timeout-minutes'], 30);
  assert.equal(wf.env.BITBUCKET_COMMIT, '${{ github.sha }}');
});

test('travis', () => {
  const r = travis.convert(fx('travis.yml'));
  const wf = check('travis', r);
  assert.equal(wf.jobs.test['runs-on'], '${{ matrix.os }}');
  assert.equal(wf.jobs.test.strategy.matrix.include.length, 7); // 2 os × 2 node × 2 db minus one exclude
  assert.ok(wf.jobs.test.strategy.matrix.include.some((i) => i.experimental === true));
  assert.equal(wf.jobs.test.services, undefined, 'services must not be attached to a matrix that includes macOS');
  assert.equal(wf.jobs.test.env.DB, '${{ matrix.DB }}');
  assert.ok(wf.jobs.test.steps.some((s) => s.uses === 'actions/setup-node@v4'));
  assert.ok(wf.jobs.test.steps.some((s) => s.if === 'failure()'));
  assert.deepEqual(wf.jobs['publish-package'].needs, ['test']);
  assert.match(wf.jobs['publish-package'].if, /^\(.*\) && startsWith\(github.ref, 'refs\/tags\/'\)$/);
  assert.ok(wf.jobs['publish-package'].steps.some((s) => s.name === 'Publish to npm'));
  assert.deepEqual(wf.on.push.branches, ['main', 'release/*']);
});

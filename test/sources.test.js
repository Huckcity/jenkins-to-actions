import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromGithub } from '../cli/sources/github.js';
import { fromGitlab } from '../cli/sources/gitlab.js';
import { fromAzure } from '../cli/sources/azure.js';
import { fromBitbucket } from '../cli/sources/bitbucket.js';
import { openPullRequests } from '../cli/migrate.js';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.pathname}`;
    const hit = routes.find(([k]) => (k instanceof RegExp ? k.test(key) : k === key));
    if (!hit) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const [, body, status = 200] = hit;
    const payload = typeof body === 'function' ? body(u, opts) : body;
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json' } });
  };
  return calls;
}

test('github org crawl finds configs of every system', async () => {
  mockFetch([
    ['GET /orgs/acme', { login: 'acme' }],
    ['GET /orgs/acme/repos', (u) => (u.searchParams.get('page') === '1' ? [{ full_name: 'acme/api', html_url: 'https://github.com/acme/api', default_branch: 'main' }, { full_name: 'acme/old', html_url: '', default_branch: 'master', archived: true }] : [])],
    ['GET /repos/acme/api/contents/Jenkinsfile', fx('scripted.Jenkinsfile')],
    ['GET /repos/acme/api/contents/.circleci/config.yml', fx('circleci.yml')],
  ]);
  const est = await fromGithub({ org: 'acme', token: 't' });
  assert.equal(est.repoCount, 1);
  assert.deepEqual(est.items.map((i) => [i.system, i.path]), [['jenkins', 'Jenkinsfile'], ['circleci', '.circleci/config.yml']]);
  assert.equal(est.items[0].repo, 'acme/api');
});

test('gitlab group crawl uses ci_config_path and default branch', async () => {
  mockFetch([
    ['GET /api/v4/groups/acme%2Fplatform/projects', (u) => (u.searchParams.get('page') === '1' ? [{ id: 7, path_with_namespace: 'acme/platform/svc', web_url: 'https://gitlab.com/acme/platform/svc', default_branch: 'develop', ci_config_path: 'ci/pipeline.yml' }] : [])],
    [/^GET \/api\/v4\/projects\/7\/repository\/files\/ci%2Fpipeline\.yml\/raw$/, fx('gitlab-ci.yml')],
  ]);
  const est = await fromGitlab({ group: 'acme/platform', token: 't' });
  assert.equal(est.items.length, 1);
  assert.equal(est.items[0].path, 'ci/pipeline.yml');
  assert.equal(est.items[0].defaultBranch, 'develop');
});

test('azure devops crawl fetches yaml pipelines and flags classic ones', async () => {
  mockFetch([
    ['GET /acme/_apis/projects', { value: [{ id: 'p1', name: 'Web' }] }],
    ['GET /acme/Web/_apis/pipelines', { value: [{ id: 1, name: 'web-ci' }, { id: 2, name: 'legacy' }] }],
    ['GET /acme/Web/_apis/pipelines/1', { configuration: { type: 'yaml', path: 'azure-pipelines.yml', repository: { id: 'r1', type: 'azureReposGit', name: 'web' } }, _links: { web: { href: 'https://dev.azure.com/acme/Web/_build?definitionId=1' } } }],
    ['GET /acme/Web/_apis/pipelines/2', { configuration: { type: 'designerJson' } }],
    ['GET /acme/Web/_apis/git/repositories/r1/items', fx('azure-pipelines.yml')],
  ]);
  const est = await fromAzure({ org: 'acme', token: 't' });
  assert.equal(est.items.length, 2);
  assert.equal(est.items[0].system, 'azure'); assert.match(est.items[0].content, /trigger:/);
  assert.equal(est.items[1].system, 'azure-classic');
});

test('bitbucket workspace crawl follows pagination', async () => {
  mockFetch([
    ['GET /2.0/repositories/acme', (u) => (u.searchParams.get('page') === '2' ? { values: [{ full_name: 'acme/two', mainbranch: { name: 'main' }, links: { html: { href: 'https://bitbucket.org/acme/two' } } }] } : { values: [{ full_name: 'acme/one', mainbranch: { name: 'master' }, links: { html: { href: 'https://bitbucket.org/acme/one' } } }], next: 'https://api.bitbucket.org/2.0/repositories/acme?page=2' })],
    ['GET /2.0/repositories/acme/one/src/master/bitbucket-pipelines.yml', fx('bitbucket-pipelines.yml')],
    ['GET /2.0/repositories/acme/two/src/main/.travis.yml', fx('travis.yml')],
  ]);
  const est = await fromBitbucket({ workspace: 'acme', user: 'u', token: 't' });
  assert.equal(est.repoCount, 2);
  assert.deepEqual(est.items.map((i) => i.system), ['bitbucket', 'travis']);
});

test('open pull requests creates branch, files and PR', async () => {
  const calls = mockFetch([
    ['GET /repos/acme/api', { default_branch: 'main' }],
    ['GET /repos/acme/api/git/ref/heads/main', { object: { sha: 'abc' } }],
    ['GET /repos/acme/api/git/ref/heads/ci%2Fgithub-actions', 'nope', 404],
    ['POST /repos/acme/api/git/refs', { ref: 'refs/heads/ci/github-actions' }],
    ['PUT /repos/acme/api/contents/.github/workflows/ci.yml', { content: {} }],
    ['GET /repos/acme/api/pulls', []],
    ['POST /repos/acme/api/pulls', { html_url: 'https://github.com/acme/api/pull/1' }],
  ]);
  const recs = [{ repo: 'acme/api', path: 'Jenkinsfile', system: 'jenkins', yaml: 'name: CI\n', notes: ['a note'], secrets: ['X'], hours: 1, todos: 0, defaultBranch: 'main' }];
  await openPullRequests(recs, { token: 't', api: 'https://api.github.com', branch: 'ci/github-actions', dryRun: false });
  assert.equal(recs[0].pr, 'https://github.com/acme/api/pull/1');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(JSON.parse(put.body).branch, 'ci/github-actions');
  const pr = calls.find((c) => c.method === 'POST' && /pulls/.test(c.url));
  assert.match(JSON.parse(pr.body).body, /a note/);
  assert.match(JSON.parse(pr.body).body, /`X`/);
});

test('github crawl lists the tree and finds CI configs outside the root', async () => {
  mockFetch([
    ['GET /repos/acme/mono', { full_name: 'acme/mono', html_url: 'https://github.com/acme/mono', default_branch: 'main' }],
    ['GET /repos/acme/mono/git/trees/main', { truncated: false, tree: [
      { type: 'blob', path: 'README.md' }, { type: 'blob', path: '.jenkins/Jenkinsfile' }, { type: 'blob', path: 'build/Jenkins/nightly.jenkinsfile' },
      { type: 'blob', path: '.azure-pipelines/release.yml' }, { type: 'blob', path: 'Jenkinsfile_CNP' }, { type: 'blob', path: 'test/fixtures/Jenkinsfile' }, { type: 'tree', path: 'Jenkinsfile' }, { type: 'blob', path: 'node_modules/x/.travis.yml' },
    ] }],
    [/^GET \/repos\/acme\/mono\/contents\//, fx('scripted.Jenkinsfile')],
  ]);
  const est = await fromGithub({ org: null, token: 't', repos: ['acme/mono'] });
  assert.deepEqual(est.items.map((i) => i.path), ['Jenkinsfile_CNP', '.azure-pipelines/release.yml', '.jenkins/Jenkinsfile', 'build/Jenkins/nightly.jenkinsfile']);
  assert.deepEqual(est.items.map((i) => i.system), ['jenkins', 'azure', 'jenkins', 'jenkins']);
  assert.equal(est.source, 'GitHub acme');
});

test('several configs in one repo get workflow names from their paths', async () => {
  const calls = mockFetch([
    ['GET /repos/acme/mono', { default_branch: 'main' }],
    ['GET /repos/acme/mono/git/ref/heads/main', { object: { sha: 'abc' } }],
    ['GET /repos/acme/mono/git/ref/heads/ci%2Fgithub-actions', 'nope', 404],
    ['POST /repos/acme/mono/git/refs', {}],
    [/^PUT \/repos\/acme\/mono\/contents\//, { content: {} }],
    ['GET /repos/acme/mono/pulls', []],
    ['POST /repos/acme/mono/pulls', { html_url: 'https://github.com/acme/mono/pull/2' }],
  ]);
  const mk = (path, system) => ({ repo: 'acme/mono', path, system, yaml: 'name: CI\n', notes: [], secrets: [], hours: 1, todos: 0, defaultBranch: 'main' });
  await openPullRequests([mk('.jenkins/Jenkinsfile', 'jenkins'), mk('build/Jenkins/nightly.jenkinsfile', 'jenkins'), mk('.azure-pipelines/release.yml', 'azure')], { token: 't', api: 'https://api.github.com', branch: 'ci/github-actions', dryRun: false });
  const puts = calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.split('/contents/')[1]));
  assert.deepEqual(puts, ['.github/workflows/ci-jenkins.yml', '.github/workflows/ci-build-jenkins-nightly.yml', '.github/workflows/ci-azure-pipelines-release.yml']);
});

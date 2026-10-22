// Per-source page content. Keep the mapping tables honest: they describe what the converter actually does.
import { readFileSync } from 'node:fs';
const doc = (name) => readFileSync(new URL(`./docs/${name}.html`, import.meta.url), 'utf8');

export const SITE = 'https://ci2actions.dev';

export const PAGES = [
  {
    source: 'jenkins', path: '/', slug: '', h1: 'Jenkinsfile', inputLabel: 'Jenkinsfile',
    title: 'Jenkinsfile to GitHub Actions converter',
    ogTitle: 'Jenkinsfile → GitHub Actions converter',
    description: 'Paste a Jenkinsfile, get a GitHub Actions workflow. Converts declarative and scripted pipelines (stages, parallel, matrix, when, credentials, post) in your browser. Nothing is uploaded.',
    examples: [['declarative.Jenkinsfile', 'Declarative (Maven, Docker, params)'], ['parallel-matrix.Jenkinsfile', 'Parallel stages + matrix'], ['scripted.Jenkinsfile', 'Scripted (node/stage)']],
    layout: true,
    placeholder: "pipeline {\n    agent any\n    stages {\n        stage('Build') {\n            steps {\n                sh 'make'\n            }\n        }\n    }\n}",
    doc: doc('jenkins'),
  },
  {
    source: 'gitlab', path: '/gitlab-ci-to-github-actions/', slug: 'gitlab-ci-to-github-actions', h1: 'GitLab CI', inputLabel: '.gitlab-ci.yml',
    title: 'GitLab CI to GitHub Actions converter',
    ogTitle: 'GitLab CI → GitHub Actions converter',
    description: 'Paste a .gitlab-ci.yml, get a GitHub Actions workflow. Stages become needs chains, rules become if:, artifacts, caches, services, parallel:matrix and extends are handled. Runs in your browser.',
    examples: [['gitlab-ci.yml', 'Node app: stages, rules, services, docker, deploy']],
    placeholder: "stages: [build, test]\n\nbuild:\n  stage: build\n  image: node:20\n  script:\n    - npm ci\n    - npm run build\n  artifacts:\n    paths: [dist/]\n\ntest:\n  stage: test\n  script: npm test",
    doc: doc('gitlab'),
  },
  {
    source: 'azure', path: '/azure-pipelines-to-github-actions/', slug: 'azure-pipelines-to-github-actions', h1: 'Azure Pipelines', inputLabel: 'azure-pipelines.yml',
    title: 'Azure Pipelines to GitHub Actions converter',
    ogTitle: 'Azure Pipelines → GitHub Actions converter',
    description: 'Paste an azure-pipelines.yml, get a GitHub Actions workflow. Stages, jobs, deployment jobs, matrix strategies, conditions, variables, parameters and 50+ built-in tasks are mapped. Runs in your browser.',
    examples: [['azure-pipelines.yml', 'Stages, matrix, tasks, deployment job']],
    placeholder: "trigger: [main]\n\npool:\n  vmImage: ubuntu-latest\n\nsteps:\n  - task: NodeTool@0\n    inputs:\n      versionSpec: '20.x'\n  - script: npm ci && npm test\n    displayName: Test",
    doc: doc('azure'),
  },
  {
    source: 'circleci', path: '/circleci-to-github-actions/', slug: 'circleci-to-github-actions', h1: 'CircleCI', inputLabel: '.circleci/config.yml',
    title: 'CircleCI to GitHub Actions converter',
    ogTitle: 'CircleCI → GitHub Actions converter',
    description: 'Paste a .circleci/config.yml, get a GitHub Actions workflow. Executors, commands, workflows with requires and filters, caches, workspaces, approvals and common orbs are mapped. Runs in your browser.',
    examples: [['circleci.yml', 'Executors, commands, workflows, approval, nightly']],
    placeholder: "version: 2.1\n\njobs:\n  build:\n    docker:\n      - image: cimg/node:20.11\n    steps:\n      - checkout\n      - run: npm ci\n      - run: npm test\n\nworkflows:\n  main:\n    jobs:\n      - build",
    doc: doc('circleci'),
  },
  {
    source: 'bitbucket', path: '/bitbucket-pipelines-to-github-actions/', slug: 'bitbucket-pipelines-to-github-actions', h1: 'Bitbucket Pipelines', inputLabel: 'bitbucket-pipelines.yml',
    title: 'Bitbucket Pipelines to GitHub Actions converter',
    ogTitle: 'Bitbucket Pipelines → GitHub Actions converter',
    description: 'Paste a bitbucket-pipelines.yml, get a GitHub Actions workflow. Default, branch, pull-request, tag and custom pipelines, parallel steps, caches, artifacts, services, deployments and Atlassian pipes are mapped. Runs in your browser.',
    examples: [['bitbucket-pipelines.yml', 'Branches, parallel, services, pipes, custom']],
    placeholder: "image: node:20\n\npipelines:\n  default:\n    - step:\n        name: Build and test\n        caches: [node]\n        script:\n          - npm ci\n          - npm test",
    doc: doc('bitbucket'),
  },
  {
    source: 'travis', path: '/travis-ci-to-github-actions/', slug: 'travis-ci-to-github-actions', h1: 'Travis CI', inputLabel: '.travis.yml',
    title: 'Travis CI to GitHub Actions converter',
    ogTitle: 'Travis CI → GitHub Actions converter',
    description: 'Paste a .travis.yml, get a GitHub Actions workflow. Language versions and env become a matrix, build stages become job groups, services, addons, caches, conditions and deploy providers are mapped. Runs in your browser.',
    examples: [['travis.yml', 'Node matrix, services, stages, npm deploy']],
    placeholder: "language: node_js\nnode_js:\n  - 18\n  - 20\nscript:\n  - npm test",
    doc: doc('travis'),
  },
];

// Pages that are not converters; body in site/<slug>.html
export const STATIC_PAGES = [
  { slug: 'migration', path: '/migration/', title: 'CI migration to GitHub Actions: audit and done-for-you service', ogTitle: 'CI → GitHub Actions migration service', description: 'Fixed-fee estate audit (£490) and done-for-you migrations from Jenkins, GitLab CI, Azure Pipelines, CircleCI, Bitbucket Pipelines or Travis CI to GitHub Actions, by the author of the free converters.' },
];

# CI → GitHub Actions converters

Move to GitHub Actions from **Jenkins, GitLab CI, Azure Pipelines, CircleCI, Bitbucket Pipelines or Travis CI**. Everything runs client-side or on your machine; nothing is uploaded.

| Source | Web page | CLI |
|---|---|---|
| Jenkinsfile | https://ci2actions.dev/ | `npx jenkins-to-actions convert Jenkinsfile` |
| GitLab CI | https://ci2actions.dev/gitlab-ci-to-github-actions/ | `npx jenkins-to-actions convert .gitlab-ci.yml` |
| Azure Pipelines | https://ci2actions.dev/azure-pipelines-to-github-actions/ | `npx jenkins-to-actions convert azure-pipelines.yml` |
| CircleCI | https://ci2actions.dev/circleci-to-github-actions/ | `npx jenkins-to-actions convert .circleci/config.yml` |
| Bitbucket Pipelines | https://ci2actions.dev/bitbucket-pipelines-to-github-actions/ | `npx jenkins-to-actions convert bitbucket-pipelines.yml` |
| Travis CI | https://ci2actions.dev/travis-ci-to-github-actions/ | `npx jenkins-to-actions convert .travis.yml` |

The source system is detected from the file name or content; force it with `--from gitlab|azure|circleci|bitbucket|travis|jenkins`.

## Audit a whole estate, open the pull requests

One command inventories every CI configuration in an organisation, converts what it can, estimates the effort per repository, and (optionally) opens a pull request in each GitHub repository with the workflow and the notes:

```sh
# GitHub organisation or user (finds Jenkinsfiles, .gitlab-ci.yml, azure-pipelines.yml, CircleCI, Bitbucket and Travis configs)
GITHUB_TOKEN=... npx jenkins-to-actions audit --github-org acme --out ./ci-migration
GITHUB_TOKEN=... npx jenkins-to-actions audit --github-org acme --open-prs          # one PR per repository
GITHUB_TOKEN=... npx jenkins-to-actions audit --repos acme/api,acme/web --open-prs --dry-run

# Other platforms (read-only crawl, same report and workflows)
GITLAB_TOKEN=... npx jenkins-to-actions audit --gitlab-group acme/platform
AZURE_DEVOPS_TOKEN=... npx jenkins-to-actions audit --azure-org acme
npx jenkins-to-actions audit --bitbucket-workspace acme --user me --token APP_PASSWORD

# Jenkins server (read-only), or exported config.xml files
npx jenkins-to-actions audit --url https://jenkins.example.com --user me --token APITOKEN
npx jenkins-to-actions audit --dir ./jenkins_home/jobs
```

See it done: [Huckcity/ci-migration-demo](https://github.com/Huckcity/ci-migration-demo) holds one config per system and an [open pull request](https://github.com/Huckcity/ci-migration-demo/pull/1) created by `audit --repos Huckcity/ci-migration-demo --open-prs`, untouched.

The audit writes `report.md` (summary, suggested order, plugin usage, secrets, per-job notes), `inventory.json` and `workflows/<repo>/*.yml`. Without `--open-prs` nothing is written to any platform.

Two ways to move off Jenkins specifically:

1. **Web converter** — paste one Jenkinsfile, get a workflow.
2. **Estate audit CLI** — point it at a Jenkins server (read-only) and get an inventory of every job, converted workflows for everything it can convert (pipelines *and* freestyle, Maven and matrix jobs), an effort estimate per job, the secrets to create, and a suggested migration order.

```sh
# Audit a server (read-only; an API token with Overall/Read + Job/Read is enough)
npx jenkins-to-actions audit --url https://jenkins.example.com --user me --token APITOKEN --out ./jenkins-migration

# Or audit exported config.xml files / Jenkinsfiles without network access to Jenkins
npx jenkins-to-actions audit --dir ./jenkins_home/jobs

# Convert a single Jenkinsfile from the command line
npx jenkins-to-actions convert Jenkinsfile > .github/workflows/ci.yml
```

The audit writes `report.md` (summary, suggested order, plugin usage, secrets, per-job notes), `inventory.json` (machine-readable) and `workflows/*.yml`. Nothing is sent anywhere; the CLI only reads from your Jenkins.

## What converts

| Jenkins | Handled |
|---|---|
| Declarative pipelines | agent (labels, docker), environment, credentials(), parameters, triggers (cron, pollSCM, upstream), options (timeout, concurrency, skipDefaultCheckout), tools, stages, parallel, matrix (+excludes), when (branch/tag/changeRequest/expression/environment/not/anyOf/allOf), post, and ~40 common steps |
| Scripted pipelines | node/stage, withEnv, withCredentials, dir, timeout, retry, try/finally, simple `if`, `def x = sh(returnStdout)` |
| Freestyle jobs | Git SCM (branches, credentials, submodules, depth), parameters, cron/SCM triggers, EnvInject, credentials bindings, build timeout, Shell/Batch/PowerShell/Maven/Gradle/Ant/MSBuild steps, archive/junit/HTML publishers, downstream triggers |
| Maven projects | goals, root POM, pre/post builders |
| Matrix projects | axes → `strategy.matrix`, label axis → `runs-on`, OS-conditional steps |
| Multibranch / Pipeline-from-SCM | inventoried with the repo and script path, converted from the checkout |

Anything else becomes a `TODO` step that fails loudly with the original quoted, so nothing silently disappears.

## Layout

- `public/convert.js` — Jenkinsfile parser + workflow emitter (no dependencies; browser and Node).
- `public/converters/` — GitLab CI, Azure Pipelines, CircleCI, Bitbucket Pipelines and Travis CI converters (YAML parsed with the bundled `yaml` library in `public/vendor/`).
- `site/` — page template, per-source content and `build.js`, which generates every page under `public/`.
- `public/app.js` — the page script.
- `cli/` — `audit.js` (analysis, scoring, report), `sources/` (GitHub, GitLab, Azure DevOps, Bitbucket crawlers), `migrate.js` (pull requests), `freestyle.js` (config.xml → workflow), `xml.js`, `http.js`.
- `test/` — fixtures converted in both layouts and checked with [actionlint](https://github.com/rhysd/actionlint); `test/e2e/` builds a throwaway Jenkins in Podman for end-to-end runs.

```sh
npm test        # fixtures → YAML → actionlint, plus CLI and converter tests
npm run build   # regenerate the pages from site/
npm run deploy  # build + Cloudflare Workers static assets
```

## Support

MIT. If it saved you time, [sponsor](https://github.com/sponsors/Huckcity). For a whole-estate migration done for you, including shared libraries and cut-over: adam.p.gibbons@gmail.com.

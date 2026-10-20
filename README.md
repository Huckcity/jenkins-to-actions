# Jenkinsfile → GitHub Actions

Two ways to move off Jenkins:

1. **Web converter** — paste one Jenkinsfile, get a workflow. Client-side, nothing uploaded. **Live:** https://jenkins-to-actions.adam-p-gibbons.workers.dev
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
- `public/index.html`, `public/app.js` — the web page.
- `cli/` — `audit.js` (server crawl, scoring, report), `freestyle.js` (config.xml → workflow), `xml.js`.
- `test/` — fixtures converted in both layouts and checked with [actionlint](https://github.com/rhysd/actionlint); `test/e2e/` builds a throwaway Jenkins in Podman for end-to-end runs.

```sh
npm test        # fixtures → YAML → actionlint, plus CLI tests
npm run deploy  # Cloudflare Workers static assets
```

## Support

MIT. If it saved you time, [sponsor](https://github.com/sponsors/Huckcity). For a whole-estate migration done for you, including shared libraries and cut-over: adam.p.gibbons@gmail.com.

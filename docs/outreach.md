# Outreach drafts (ready to paste)

The GitHub comments below were posted on 2026-10-23. The awesome-list PRs and the Reddit/HN/LinkedIn posts still need Adam. Each one is specific to the thread it answers; they link to unedited converter output in `docs/real-world/`.

## GitHub issue comments

Posted 2026-10-23: [eclipse-packages](https://github.com/eclipse-packages/packages/issues/564#issuecomment-6353971523), [mantid](https://github.com/mantidproject/mantid/issues/39497#issuecomment-6353979911), [hls4ml](https://github.com/fastmachinelearning/hls4ml/issues/1557#issuecomment-6353971757). Watch them for replies.

### eclipse-packages/packages#564 — https://github.com/eclipse-packages/packages/issues/564

In case it saves someone the first pass: I ran `.jenkins/Jenkinsfile` through a Jenkinsfile → GitHub Actions converter I maintain ([jenkins-to-actions](https://ci2actions.dev), MIT, runs locally). Unedited output and the converter's notes are here: https://github.com/Huckcity/jenkins-to-actions/blob/main/docs/real-world/eclipse-packages-jenkinsfile-to-actions.md

What it did with the parts that usually need thought:

- `podTemplate` / `container('jekyll')` → the job runs with `container: docker.io/jekyll/jekyll:4.1.0` on `ubuntu-latest`
- `sshagent(['github-bot-ssh'])` → `webfactory/ssh-agent` reading a `GITHUB_BOT_SSH` secret
- `disableConcurrentBuilds()` → `concurrency:`; `needToDeploy()` → `if: github.ref_name == 'master'`; the `fileExists('perform-merge')` check → `hashFiles(...)`
- `${WORKSPACE}`, `${BRANCH_NAME}` etc. in the shell scripts are defined in `env` with their Actions equivalents

Things to check by hand: the `jnlp` stages (Init, Clone, Helm Install) now also run inside the jekyll image, which needs `curl` and `tar`; and the `catch { throw err }` blocks were dropped since a failing step already fails the job. Happy to remove this comment if it's noise.

### mantidproject/mantid#39497 — https://github.com/mantidproject/mantid/issues/39497

FWIW, I ran the two `*.jenkinsfile` under `buildconfig/Jenkins/Conda/` through a converter I maintain ([jenkins-to-actions](https://ci2actions.dev), MIT, runs locally) to see how much of the boilerplate it would take off the table. Unedited output: https://github.com/Huckcity/jenkins-to-actions/blob/main/docs/real-world/mantid-jenkinsfiles-to-actions.md

- `build-and-publish-devsite.jenkinsfile` came out clean (the `credentials(...)` binding became a `MANTID_BUILDER_GITHUB_OAUTH_TOKEN` secret; `recordIssues` has no equivalent and is left as a TODO).
- `nightly_build_and_deploy.jenkinsfile` (700 lines, matrix over platforms, local Groovy functions) came out at 15 TODO steps, mostly the `toUnixStylePath(...)` assignments and the `currentBuild.getPreviousSuccessfulBuild()` loop. Parameters became `workflow_dispatch` inputs with the choices resolved from the `defaults` map, `copyArtifacts` became `download-artifact`, and the `linux-64` / `win-64` / `osx-arm64` labels became `[self-hosted, …]`, which matches the plan above to keep those on your own runners.

Not a drop-in, but it might save the mechanical pass so the time goes on the runner and caching questions instead.

### fastmachinelearning/hls4ml#1557 — https://github.com/fastmachinelearning/hls4ml/issues/1557

If it helps whoever picks this up: here is `.gitlab-ci.yml` run through a GitLab CI → GitHub Actions converter I maintain ([ci2actions.dev](https://ci2actions.dev/gitlab-ci-to-github-actions/), MIT, runs locally): https://github.com/Huckcity/jenkins-to-actions/blob/main/docs/real-world/hls4ml-gitlab-ci-to-actions.md

The one thing it cannot translate is the `generator` → `pytests` child pipeline (`generate_ci_yaml.py` writing `pytests.yml`). The Actions equivalent is a first job that writes a JSON list to `$GITHUB_OUTPUT` and a second job with `strategy: matrix: ${{ fromJson(needs.generator.outputs.matrix) }}`, so `generate_ci_yaml.py` would emit JSON instead of GitLab YAML. The `k8s-default` tag became a self-hosted label; swap it for `ubuntu-latest` if the tests don't need the cluster.

## Awesome-list pull requests

### sdras/awesome-actions (28k stars), section "Monitoring" — for the step-timing action

```
- [CI Step Timing Report](https://github.com/Huckcity/step-timing) - Flags jobs and steps that got slower than the median of recent runs, in the job summary and a PR comment.
```

### sdras/awesome-actions, section "GitHub Tools and Management" — for the converters

```
- [jenkins-to-actions](https://github.com/Huckcity/jenkins-to-actions) - Convert Jenkinsfiles, GitLab CI, Azure Pipelines, CircleCI, Bitbucket Pipelines and Travis CI configs to workflows; audits a whole organisation and opens one PR per repository.
```

### ciandcd/awesome-ciandcd (2k stars), section "Useful Sites" or "Build And Release System"

```
- [ci2actions.dev](https://ci2actions.dev) - Client-side converters from Jenkins, GitLab CI, Azure Pipelines, CircleCI, Bitbucket Pipelines and Travis CI to GitHub Actions, plus an estate audit CLI.
```

PR title for both: "Add jenkins-to-actions (CI → GitHub Actions converters)". Keep the entry alphabetical within the section.

## Reddit, HN, LinkedIn

See `launch-posts.md`. Replace the old `workers.dev` link with https://ci2actions.dev everywhere. The Show HN can go up once the `huckcity` account has a little karma (it was created 2026-10-20 and is still rate-limited).

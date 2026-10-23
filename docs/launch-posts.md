# Launch posts (drafted 2026-10-20)

## Show HN (blocked: huckcity account created 2026-10-20, karma 1; HN is restricting Show HNs from new accounts)

Title: Show HN: Jenkinsfile to GitHub Actions converter that runs in your browser
URL: https://ci2actions.dev/

I run CI for a living (CloudBees/Jenkins and GitHub Actions). GitHub's Actions Importer is the right tool for bulk migrations, but it needs a connection to the Jenkins server. I wanted something for the moment you have one Jenkinsfile in front of you and want a workflow to start from.

This parses the Groovy DSL (declarative pipelines, and the common node/stage shape of scripted ones) into a tree and emits a workflow: stages become jobs with needs chains (or steps in one job, your choice), parallel becomes sibling jobs, matrix becomes strategy.matrix, when becomes if:, credentials become secrets, params become workflow_dispatch inputs, and ~20 Jenkins env vars are mapped. Anything it can't map becomes a TODO step that fails loudly with the original code quoted in a comment, so nothing silently disappears. A notes panel lists the secrets to create and the Marketplace action that usually replaces each plugin step.

It runs entirely client-side; there's no backend, which matters because Jenkinsfiles tend to be full of internal hostnames. Every fixture in the test suite is checked with actionlint. MIT, source here: https://github.com/Huckcity/jenkins-to-actions

What it won't do: shared libraries, arbitrary Groovy, most plugin steps. I'd like to hear about Jenkinsfiles that break it.

## r/devops (check the sidebar: self-promo is usually allowed if you engage in the thread)

Title: I built a client-side Jenkinsfile → GitHub Actions converter (free, no upload)

Same body as above, minus the first sentence's "Show HN" framing.

## LinkedIn

Migrating pipelines off Jenkins? I built a small free tool: paste a Jenkinsfile, get a GitHub Actions workflow plus a list of everything that didn't map cleanly. Runs entirely in your browser, nothing uploaded. Declarative and scripted pipelines, parallel, matrix, when, credentials, post blocks. Anything it can't convert becomes a loud TODO rather than silently vanishing.

https://ci2actions.dev

Source (MIT): https://github.com/Huckcity/jenkins-to-actions

## Per-source posts (2026-10-20)

Each converter has its own page and its own community. Same body, swap the file name:

- r/gitlab: "I built a client-side .gitlab-ci.yml → GitHub Actions converter (stages, rules, services, artifacts, extends)"
- r/azuredevops: "azure-pipelines.yml → GitHub Actions converter, 50+ tasks mapped, runs in your browser"
- r/circleci (small) and the CircleCI Discuss forum: ".circleci/config.yml → GitHub Actions, with orbs/commands/workspaces handled"
- Atlassian Community (Bitbucket Pipelines): "bitbucket-pipelines.yml → GitHub Actions converter"
- Travis: no active community; the page is for search traffic only.
- Hacker News (once the account is old enough): "Show HN: Convert any CI config (Jenkins, GitLab, Azure, CircleCI, Bitbucket, Travis) to GitHub Actions in your browser"

## GitHub Actions → GitLab CI converter (2026-10-23)

Where: GitLab forum (forum.gitlab.com, "Community" or "GitLab CI/CD" category), r/gitlab, r/devops, HN (Show HN once the account is old enough), LinkedIn.

Title: I built a GitHub Actions → GitLab CI converter that runs in your browser

Moving pipelines from GitHub to GitLab (or keeping both) means rewriting every workflow by hand: Marketplace actions have no GitLab equivalent, contexts become CI_* variables, caches and artifacts work differently. I built a converter that does the mechanical part: https://ci2actions.dev/github-actions-to-gitlab-ci/

Paste a workflow, get a .gitlab-ci.yml. Jobs and needs become a DAG with stages, triggers become workflow rules (with the duplicate-pipeline guard), matrix becomes parallel:matrix, if: becomes rules:, secrets/vars/github.* become CI variables, GITHUB_OUTPUT becomes a dotenv report, upload-artifact/cache become artifacts/cache, and about 100 common actions (setup-node/python/go/java, docker build-push, AWS/GCP/Azure OIDC logins, releases, Pages, JUnit, Codecov, Slack, publish steps…) become the commands or keywords that replace them. Anything it can't map becomes a TODO step that fails loudly, with the original quoted, so nothing silently disappears.

The output is validated against GitLab's own CI schema in the test suite; 59 workflows from popular repos (Terraform, Deno, Vite, Flask, Cargo…) all produce valid files. It runs entirely client-side; nothing is uploaded. Source (MIT): https://github.com/Huckcity/jenkins-to-actions

What it won't do: composite actions, GitHub-specific automation (stale, labeler), and the ubuntu-latest tool preinstall gap is yours to fill. I'd like to hear which workflow breaks it.

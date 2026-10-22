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

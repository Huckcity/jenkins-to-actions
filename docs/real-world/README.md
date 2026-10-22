# Real-world conversions

Unedited converter output for CI configurations in public open-source repositories, produced with
`npx jenkins-to-actions audit --repos <owner>/<repo>`. They show what the tool gets right and what it
leaves as `TODO` steps (which fail on purpose so an unfinished workflow cannot be merged by accident).

| Repository | Source | Result |
|---|---|---|
| [eclipse-packages/packages](https://github.com/eclipse-packages/packages) | `.jenkins/Jenkinsfile`, scripted pipeline on the Kubernetes plugin (`podTemplate`/`container`) | [0 TODOs](eclipse-packages-jenkinsfile-to-actions.md) |
| [fastmachinelearning/hls4ml](https://github.com/fastmachinelearning/hls4ml) | `.gitlab-ci.yml` with a generated child pipeline | [1 TODO](hls4ml-gitlab-ci-to-actions.md) (the child pipeline trigger) |
| [mantidproject/mantid](https://github.com/mantidproject/mantid) | two `*.jenkinsfile` under `buildconfig/Jenkins/Conda/`, 700-line declarative matrix with local Groovy functions | [0 and 15 TODOs](mantid-jenkinsfiles-to-actions.md) |

Regenerate them with `GITHUB_TOKEN=$(gh auth token) npx jenkins-to-actions audit --repos eclipse-packages/packages,fastmachinelearning/hls4ml,mantidproject/mantid`.

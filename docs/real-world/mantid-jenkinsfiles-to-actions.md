# mantidproject/mantid: `buildconfig/Jenkins/Conda/*.jenkinsfile` → GitHub Actions

Generated with [jenkins-to-actions](https://ci2actions.dev) (`npx jenkins-to-actions audit --repos mantidproject/mantid`), MIT, runs locally. Review before use: anything without a clean equivalent is a `TODO` step that fails on purpose so it cannot be merged by accident.

## build-and-publish-devsite.jenkinsfile

Notes from the converter:

- `options { retry }` has no job-level equivalent; use `nick-fields/retry` on the fragile steps or re-run failed jobs from the UI.
- `credentials('mantid-builder-github-oauth-token')` in environment became secret `MANTID_BUILDER_GITHUB_OAUTH_TOKEN`.
- Shell scripts referenced Jenkins variables (`WORKSPACE`); they are defined in `env` with their GitHub equivalents.
- Create these repository secrets (Settings → Secrets and variables → Actions): MANTID_BUILDER_GITHUB_OAUTH_TOKEN.

`.github/workflows/devsite.yml`:

```yaml
name: build-and-publish-devsite.jenkinsfile
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch: {}
jobs:
  build-publish-developer-docs:
    name: Build/Publish Developer Docs
    runs-on: ubuntu-latest
    env:
      GITHUB_ACCESS_TOKEN: ${{ secrets.MANTID_BUILDER_GITHUB_OAUTH_TOKEN }}
      WORKSPACE: ${{ github.workspace }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        working-directory: build
      - name: ${WORKSPACE}/buildconfig/Jenkins/Conda/build-and-publish-…
        run: ${WORKSPACE}/buildconfig/Jenkins/Conda/build-and-publish-devsite.sh     ${WORKSPACE}
      - name: 'post always: TODO: Unknown step recordIssues (probably a plugin); rewrite it'
        run: |
          # TODO: Unknown step 'recordIssues' (probably a plugin); rewrite it
          # recordIssues qualityGates: [[threshold: 1, type: 'TOTAL', unstable: true]], tools: [sphinxBuild()]
          echo "TODO: unconverted Jenkins step" && exit 1
        if: always()
```

## nightly_build_and_deploy.jenkinsfile

Notes from the converter:

- `GITHUB_USER_NAME` looks like a Jenkins global environment variable; it became the repository variable `${{ vars.JENKINS_GITHUB_USER_NAME }}`. Create it under Settings → Secrets and variables → Actions → Variables.
- `GITHUB_USER_EMAIL` looks like a Jenkins global environment variable; it became the repository variable `${{ vars.JENKINS_GITHUB_USER_EMAIL }}`. Create it under Settings → Secrets and variables → Actions → Variables.
- Parameters became `workflow_dispatch` inputs; `params.X` references became `${{ inputs.X }}`. Inputs are only set on manual runs, so give each one a default.
- `currentBuild.setDescription(params.DESCRIPTION)` dropped (Jenkins build metadata has no equivalent; use `$GITHUB_STEP_SUMMARY` for a description).
- Groovy condition `if (!params.ANACONDA_CHANNEL_LABEL?.trim())` could not be translated; a placeholder `true` was emitted on the affected steps.
- Groovy condition `if (!params.ANACONDA_CHANNEL?.trim())` could not be translated; a placeholder `true` was emitted on the affected steps.
- Groovy call `params.ANACONDA_CHANNEL.trim()` cannot be evaluated at workflow time; replace it with a literal or a step output.
- Groovy condition `if (!id)` could not be translated; a placeholder `true` was emitted on the affected steps.
- Expression `${"No Jenkins credential configured for Anaconda channel '${channel}'. " +}` left unconverted; translate it to a GitHub expression by hand.
- Expression `"No Jenkins credential configured for Anaconda channel '${channel}'. " +` left as-is.
- Function `anacondaChannelToCredId()` returns a value; its steps were inlined but the returned value is not available to later steps.
- Groovy call `generate_git_tag()` cannot be evaluated at workflow time; replace it with a literal or a step output.
- Groovy condition `if (platform.startsWith('win'))` could not be translated; a placeholder `true` was emitted on the affected steps.
- Groovy variable `buildscript_path` is used in a string; set it as an environment variable or step output.
- Groovy variable `workspace_unix_style` is used in a string; set it as an environment variable or step output.
- Groovy variable `cmake_preset` is used in a string; set it as an environment variable or step output.
- Groovy condition `if (platform.startsWith('linux'))` could not be translated; a placeholder `true` was emitted on the affected steps.
- `junit` became `mikepenz/action-junit-report`; it needs `permissions: checks: write` (add it at the top of the workflow or on the job).
- A `bat` step landed in a non-Windows job; either move it to a windows-latest job or rewrite it for bash.
- `options { retry }` has no job-level equivalent; use `nick-fields/retry` on the fragile steps or re-run failed jobs from the UI.
- Groovy variable `packagescript_path` is used in a string; set it as an environment variable or step output.
- Expression `${package_conda_options(platform, base_or_workbench)}` left unconverted; translate it to a GitHub expression by hand.
- Groovy condition `if (platform != 'noarch' || buildMantiddocs)` could not be translated; a placeholder `true` was emitted on the affected steps.
- `copyArtifacts` from the same job became `actions/download-artifact` (pattern `*-artifacts`, filter was `**/conda-bld/noarch/*.conda, **/conda-bld/${{ env.PLATFORM }}/*.conda`). Artifacts only flow between jobs of one workflow run; the producing job must upload them with `actions/upload-artifact`, and the download runs in a later job.
- Groovy condition `if (isUnix())` could not be translated; a placeholder `true` was emitted on the affected steps.
- Expression `${package_standalone_options(platform)}` left unconverted; translate it to a GitHub expression by hand.
- Groovy condition `if (platform.startsWith('osx'))` could not be translated; a placeholder `true` was emitted on the affected steps.
- Groovy condition `if (pattern != '')` could not be translated; a placeholder `true` was emitted on the affected steps.
- Jenkins has an UNSTABLE result; Actions does not. `unstable()` became a warning annotation.
- `copyArtifacts` from the same job became `actions/download-artifact` (pattern `*-artifacts`, filter was `**/conda-bld/**/*.conda`). Artifacts only flow between jobs of one workflow run; the producing job must upload them with `actions/upload-artifact`, and the download runs in a later job.
- Expression `${"${CISCRIPT_DIR}/publish-to-anaconda ${WORKSPACE}" + ' ${ANACONDA_TOKEN} ' +\}` left unconverted; translate it to a GitHub expression by hand.
- Expression `"${CISCRIPT_DIR}/publish-to-anaconda ${WORKSPACE}" + ' ${ANACONDA_TOKEN} ' +\` left as-is.
- Shell scripts referenced Jenkins variables (`WORKSPACE`); they are defined in `env` with their GitHub equivalents.
- `when { expression { params.GITHUB_RELEASES_REPO.trim() != '' } }` must be rewritten as a GitHub expression by hand; a placeholder `true` was emitted.
- `credentials('${GITHUB_TOKEN_CREDENTIAL_ID}')` in environment became secret `__GITHUB_TOKEN_CREDENTIAL_ID_`.
- `copyArtifacts` from the same job became `actions/download-artifact` (pattern `*-artifacts`, filter was `*.exe, *.dmg, *.tar.xz`). Artifacts only flow between jobs of one workflow run; the producing job must upload them with `actions/upload-artifact`, and the download runs in a later job.
- Expression `${"${CISCRIPT_DIR}/publish-to-github ${WORKSPACE}" + ' ${GITHUB_TOKEN} ' +\}` left unconverted; translate it to a GitHub expression by hand.
- Expression `"${CISCRIPT_DIR}/publish-to-github ${WORKSPACE}" + ' ${GITHUB_TOKEN} ' +\` left as-is.
- `when { expression { params.ANACONDA_CHANNEL.trim() == 'mantid' } }` must be rewritten as a GitHub expression by hand; a placeholder `true` was emitted.
- `when { expression { params.ANACONDA_CHANNEL_LABEL.trim() == 'nightly' } }` must be rewritten as a GitHub expression by hand; a placeholder `true` was emitted.
- `copyArtifacts` from the same job became `actions/download-artifact` (pattern `*-artifacts`, filter was `**/conda-bld/noarch/mantiddocs*.conda`). Artifacts only flow between jobs of one workflow run; the producing job must upload them with `actions/upload-artifact`, and the download runs in a later job.
- Expression `${"${CISCRIPT_DIR}/publish-nightly-docs.sh ${WORKSPACE}/conda-bld ${GIT_SHA}" + ' ${GITHUB_TOKEN} '}` left unconverted; translate it to a GitHub expression by hand.
- Expression `"${CISCRIPT_DIR}/publish-nightly-docs.sh ${WORKSPACE}/conda-bld ${GIT_SHA}" + ' ${GITHUB_TOKEN} '` left as-is.
- Groovy condition `if (params.DESCRIPTION.isEmpty())` could not be translated; a placeholder `true` was emitted on the affected steps.
- `currentBuild.keepLog = true` dropped (Jenkins build metadata).
- `currentBuild.setDescription(keepDescription)` dropped (Jenkins build metadata has no equivalent; use `$GITHUB_STEP_SUMMARY` for a description).
- Create these repository secrets (Settings → Secrets and variables → Actions): CREDID, __GITHUB_TOKEN_CREDENTIAL_ID_.

`.github/workflows/nightly.yml`:

```yaml
name: nightly_build_and_deploy.jenkinsfile
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      DESCRIPTION:
        description: Description to be displayed on the Jenkins build page.
        type: string
        default: ''
        required: false
      BUILD_DEVEL:
        description: Choose a platform to build & test the developer configuration.
        type: choice
        options: [none, all, linux-64, win-64, osx-arm64]
        default: none
      BUILD_PACKAGE:
        description: Choose a platform to build just this standalone package
        type: choice
        options: [none, all, linux-64, win-64, osx-arm64]
        default: none
      PACKAGE_SUFFIX:
        description: A string to append to the standalone package name
        type: string
        default: Unstable
        required: false
      PUBLISH_TO_ANACONDA:
        description: If true, publish the packages to the specified Anaconda channel
        type: boolean
        default: false
        required: false
      PUBLISH_TO_GITHUB:
        description: If true, publish the packages to GitHub
        type: boolean
        default: false
        required: false
      ANACONDA_CHANNEL:
        description: The Anaconda channel where the packages will be published
        type: choice
        options: [mantid-test]
        default: mantid-test
      ANACONDA_CHANNEL_LABEL:
        description: The label attached to package in the Anaconda channel
        type: string
        default: unstable
        required: false
      GITHUB_RELEASES_REPO:
        description: The repository to house the release
        type: string
        default: mantidproject/mantid
        required: false
      GITHUB_RELEASES_TAG:
        description: The name of the tag for the release. Use this only for release candidate builds.
        type: string
        default: ''
        required: false
env:
  WIN_BASH: C:\Program Files\git\bin\bash.exe
  GIT_AUTHOR_NAME: ${{ vars.JENKINS_GITHUB_USER_NAME }}
  GIT_AUTHOR_EMAIL: ${{ vars.JENKINS_GITHUB_USER_EMAIL }}
  GIT_COMMITTER_NAME: ${{ vars.JENKINS_GITHUB_USER_NAME }}
  GIT_COMMITTER_EMAIL: ${{ vars.JENKINS_GITHUB_USER_EMAIL }}
jobs:
  check-parameters:
    name: Check parameters
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Fail
        run: |
          echo "::error::You must specify an Anaconda label to publish packages."
          exit 1
        # TODO: if (!params.ANACONDA_CHANNEL_LABEL?.trim())
        if: (inputs.PUBLISH_TO_ANACONDA)
      - name: Fail
        run: |
          echo "::error::You must specify an Anaconda channel to publish packages."
          exit 1
        # TODO: if (!params.ANACONDA_CHANNEL?.trim())
        if: (inputs.PUBLISH_TO_ANACONDA)
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def id = map[channel]
          echo "TODO: unconverted Jenkins step" && exit 1
        if: inputs.PUBLISH_TO_ANACONDA
      - name: Fail
        run: |
          echo "::error::\"No Jenkins credential configured for Anaconda channel '${channel}'. \" +"
          exit 1
        # TODO: if (!id)
        if: (inputs.PUBLISH_TO_ANACONDA)
  store-git-commit:
    name: Store git commit
    runs-on: ubuntu-latest
    needs: [check-parameters]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Set GIT_SHA
        run: echo "GIT_SHA=${{ github.sha }}" >> "$GITHUB_ENV"
  generate-git-tag:
    name: Generate git tag
    runs-on: ubuntu-latest
    needs: [store-git-commit]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set GIT_TAG
        run: echo "GIT_TAG=TODO(generate_git_tag())" >> "$GITHUB_ENV"
      - name: Echo
        run: echo "${{ env.GIT_TAG }}"
  build-and-test-linux-64:
    name: 'build and test: linux-64'
    runs-on: ubuntu-latest
    needs: [generate-git-tag]
    if: (inputs.BUILD_DEVEL == 'all' || inputs.BUILD_DEVEL == 'linux-64')
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set buildscript_path
        run: echo "buildscript_path=${{ env.CISCRIPT_DIR }}/conda-buildscript" >> "$GITHUB_ENV"
      - name: Set cmake_preset
        run: echo "cmake_preset=linux-64-ci" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_unix_style}/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests"
        # TODO: if (platform.startsWith('win'))
      - name: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${c…
        run: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests --enable-doctests
        # TODO: else branch of if (platform.startsWith('win'))
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${CHECKOUT_DIR}/build/test_logs/*.log'
        if: always()
      - name: 'post always: TODO: Unknown step xunit (probably a plugin); rewrite it'
        run: |
          # TODO: Unknown step 'xunit' (probably a plugin); rewrite it
          # xunit thresholds: [failed(failureThreshold: '0')],
          #     tools: [CTest(excludesPattern: '', pattern: "${CHECKOUT_DIR}/build/Testing/**/*.xml", stopProcessingIfError: true)]
          echo "TODO: unconverted Jenkins step" && exit 1
        if: always()
      - name: 'post always: Publish test results'
        uses: mikepenz/action-junit-report@v5
        if: (always()) && (always())
        with:
          report_paths: '${CHECKOUT_DIR}/build/Testing/SystemTests/scripts/TEST-*.xml'
  build-and-test-win-64:
    name: 'build and test: win-64'
    runs-on: windows-latest
    needs: [generate-git-tag]
    if: (inputs.BUILD_DEVEL == 'all' || inputs.BUILD_DEVEL == 'win-64')
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set buildscript_path
        run: echo "buildscript_path=${{ env.CISCRIPT_DIR }}/conda-buildscript" >> "$GITHUB_ENV"
      - name: Set cmake_preset
        run: echo "cmake_preset=win-64-ci" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_…'
        shell: cmd
        run: '"$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_unix_style}/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests"'
        # TODO: if (platform.startsWith('win'))
      - name: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${c…
        run: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests --enable-doctests
        # TODO: else branch of if (platform.startsWith('win'))
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${CHECKOUT_DIR}/build/test_logs/*.log'
        if: always()
      - name: 'post always: TODO: Unknown step xunit (probably a plugin); rewrite it'
        run: |
          # TODO: Unknown step 'xunit' (probably a plugin); rewrite it
          # xunit thresholds: [failed(failureThreshold: '0')],
          #     tools: [CTest(excludesPattern: '', pattern: "${CHECKOUT_DIR}/build/Testing/**/*.xml", stopProcessingIfError: true)]
          echo "TODO: unconverted Jenkins step" && exit 1
        if: always()
      - name: 'post always: Publish test results'
        uses: mikepenz/action-junit-report@v5
        if: (always()) && (always())
        with:
          report_paths: '${CHECKOUT_DIR}/build/Testing/SystemTests/scripts/TEST-*.xml'
      - name: 'post always: "$WIN_BASH" -ex -c "test ${{ job.status }} != UNSTABLE"'
        shell: cmd
        run: '"$WIN_BASH" -ex -c "test ${{ job.status }} != UNSTABLE"'
        if: always()
  build-and-test-osx-arm64:
    name: 'build and test: osx-arm64'
    runs-on: macos-latest
    needs: [generate-git-tag]
    if: (inputs.BUILD_DEVEL == 'all' || inputs.BUILD_DEVEL == 'osx-arm64')
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set buildscript_path
        run: echo "buildscript_path=${{ env.CISCRIPT_DIR }}/conda-buildscript" >> "$GITHUB_ENV"
      - name: Set cmake_preset
        run: echo "cmake_preset=osx-arm64-ci" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${buildscript_path}      ${workspace_unix_style}/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests"
        # TODO: if (platform.startsWith('win'))
      - name: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${c…
        run: ${buildscript_path} $GITHUB_WORKSPACE/${CHECKOUT_DIR} ${cmake_preset} --clean-build --enable-systemtests --enable-doctests
        # TODO: else branch of if (platform.startsWith('win'))
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${CHECKOUT_DIR}/build/test_logs/*.log'
        if: always()
      - name: 'post always: TODO: Unknown step xunit (probably a plugin); rewrite it'
        run: |
          # TODO: Unknown step 'xunit' (probably a plugin); rewrite it
          # xunit thresholds: [failed(failureThreshold: '0')],
          #     tools: [CTest(excludesPattern: '', pattern: "${CHECKOUT_DIR}/build/Testing/**/*.xml", stopProcessingIfError: true)]
          echo "TODO: unconverted Jenkins step" && exit 1
        if: always()
      - name: 'post always: Publish test results'
        uses: mikepenz/action-junit-report@v5
        if: (always()) && (always())
        with:
          report_paths: '${CHECKOUT_DIR}/build/Testing/SystemTests/scripts/TEST-*.xml'
  package-conda-linux-64:
    name: 'package conda: linux-64'
    runs-on: ubuntu-latest
    needs: [generate-git-tag]
    if: inputs.BUILD_PACKAGE != 'none'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        working-directory: conda-bld
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set packagescript_path
        run: echo "packagescript_path=${{ env.CISCRIPT_DIR }}/package-conda" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${packagescript_path}      ${workspac…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${packagescript_path}      ${workspace_unix_style} ${package_conda_options(platform, base_or_workbench)}"
        # TODO: if (platform.startsWith('win'))
      - name: ${packagescript_path}      $GITHUB_WORKSPACE ${package_co…
        run: ${packagescript_path}      $GITHUB_WORKSPACE ${package_conda_options(platform, base_or_workbench)}
        # TODO: else branch of if (platform.startsWith('win'))
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: artifacts
          path: '**/conda-bld/${platform}/*.conda'
        # TODO: if (platform != 'noarch' || buildMantiddocs)
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: artifacts
          path: '**/conda-bld/${platform}/*.conda'
        # TODO: if (platform != 'noarch' || buildMantiddocs)
      - name: 'post always: Set env_log_dir'
        run: 'echo "env_log_dir=**/env_logs/linux-64" >> "$GITHUB_ENV"'
        if: always()
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${env_log_dir}/**/*.txt'
        if: always()
  package-conda-win-64:
    name: 'package conda: win-64'
    runs-on: windows-latest
    needs: [generate-git-tag]
    if: (inputs.BUILD_PACKAGE == 'win-64' || inputs.BUILD_PACKAGE == 'all')
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        working-directory: conda-bld
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set packagescript_path
        run: echo "packagescript_path=${{ env.CISCRIPT_DIR }}/package-conda" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${packagescript_path}      ${workspac…'
        shell: cmd
        run: '"$WIN_BASH" -ex -c "${packagescript_path}      ${workspace_unix_style} ${package_conda_options(platform, base_or_workbench)}"'
        # TODO: if (platform.startsWith('win'))
      - name: ${packagescript_path}      $GITHUB_WORKSPACE ${package_co…
        run: ${packagescript_path}      $GITHUB_WORKSPACE ${package_conda_options(platform, base_or_workbench)}
        # TODO: else branch of if (platform.startsWith('win'))
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: artifacts
          path: '**/conda-bld/${platform}/*.conda'
        # TODO: if (platform != 'noarch' || buildMantiddocs)
      - name: 'post always: Set env_log_dir'
        run: 'echo "env_log_dir=**/env_logs/win-64" >> "$GITHUB_ENV"'
        if: always()
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${env_log_dir}/**/*.txt'
        if: always()
  package-conda-osx-arm64:
    name: 'package conda: osx-arm64'
    runs-on: macos-latest
    needs: [generate-git-tag]
    if: (inputs.BUILD_PACKAGE == 'osx-arm64' || inputs.BUILD_PACKAGE == 'all')
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        working-directory: conda-bld
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Set packagescript_path
        run: echo "packagescript_path=${{ env.CISCRIPT_DIR }}/package-conda" >> "$GITHUB_ENV"
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
      - name: '"$WIN_BASH" -ex -c "${packagescript_path}      ${workspac…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${packagescript_path}      ${workspace_unix_style} ${package_conda_options(platform, base_or_workbench)}"
        # TODO: if (platform.startsWith('win'))
      - name: ${packagescript_path}      $GITHUB_WORKSPACE ${package_co…
        run: ${packagescript_path}      $GITHUB_WORKSPACE ${package_conda_options(platform, base_or_workbench)}
        # TODO: else branch of if (platform.startsWith('win'))
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: artifacts
          path: '**/conda-bld/${platform}/*.conda'
        # TODO: if (platform != 'noarch' || buildMantiddocs)
      - name: 'post always: Set env_log_dir'
        run: 'echo "env_log_dir=**/env_logs/osx-arm64" >> "$GITHUB_ENV"'
        if: always()
      - name: 'post always: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: post-always-artifacts
          path: '${env_log_dir}/**/*.txt'
        if: always()
  package-workbench:
    name: Package workbench (${{ matrix.PLATFORM }})
    runs-on: ubuntu-latest
    needs: [build-and-test-linux-64, build-and-test-win-64, build-and-test-osx-arm64, package-conda-linux-64, package-conda-win-64, package-conda-osx-arm64]
    strategy:
      matrix:
        PLATFORM: [linux-64, win-64, osx-arm64]
    env:
      PLATFORM: ${{ matrix.PLATFORM }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: 'package workbench: Clean workspace'
        run: 'rm -rf ./* ./.[!.]*'
        if: (inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all')
        working-directory: conda-bld
      - name: 'package workbench: Checkout'
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
        if: (inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all')
      - name: 'package workbench: Download artifacts'
        uses: actions/download-artifact@v4
        with:
          pattern: '*-artifacts'
          merge-multiple: true
        if: (inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all')
      - name: 'package workbench: Set packagescript_path'
        run: echo "packagescript_path=${{ env.CISCRIPT_DIR }}/package-conda" >> "$GITHUB_ENV"
        if: (inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all')
      - name: 'package workbench: TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (platform.startsWith('win'))
        if: ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: "$WIN_BASH" -ex -c "${packagescript_path}      ${workspac…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${packagescript_path}      ${workspace_unix_style} ${package_conda_options(platform, base_or_workbench)}"
        # TODO: if (platform.startsWith('win'))
        if: ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: ${packagescript_path}      $GITHUB_WORKSPACE ${package_co…'
        run: ${packagescript_path}      $GITHUB_WORKSPACE ${package_conda_options(platform, base_or_workbench)}
        # TODO: else branch of if (platform.startsWith('win'))
        if: (false) && ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: package-workbench-artifacts
          path: '**/conda-bld/${platform}/*.conda'
        # TODO: if (platform != 'noarch' || buildMantiddocs)
        if: ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: Set packagescript_path'
        run: echo "packagescript_path=${{ env.CISCRIPT_DIR }}/package-standalone" >> "$GITHUB_ENV"
        if: (inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all')
      - name: 'package workbench: ${packagescript_path} $GITHUB_WORKSPACE ${package_standal…'
        run: ${packagescript_path} $GITHUB_WORKSPACE ${package_standalone_options(platform)}
        # TODO: if (isUnix())
        if: ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def workspace_unix_style = toUnixStylePath("${WORKSPACE}")
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: else branch of if (isUnix())
        if: (false) && ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: "$WIN_BASH" -ex -c "${packagescript_path} ${workspace_uni…'
        shell: bash
        run: |
          # TODO: this was a Windows `bat` step but the job runs on a non-Windows runner
          "$WIN_BASH" -ex -c "${packagescript_path} ${workspace_unix_style}      ${package_standalone_options(platform)}"
        # TODO: else branch of if (isUnix())
        if: (false) && ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: package-workbench-artifacts
          path: ${pattern}
        # TODO: if (pattern != '')
        if: ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench: Mark unstable'
        run: echo "::warning::Unknown platform (${{ env.PLATFORM }}) detected while archiving standalone package. Archiving skipped."
        # TODO: else branch of if (pattern != '')
        if: (false) && ((inputs.BUILD_PACKAGE == '${PLATFORM}' || inputs.BUILD_PACKAGE == 'all'))
      - name: 'package workbench (post always): Set env_log_dir'
        run: 'echo "env_log_dir=**/env_logs/${{ env.PLATFORM }}" >> "$GITHUB_ENV"'
        if: always()
      - name: 'package workbench (post always): Upload artifacts'
        uses: actions/upload-artifact@v4
        with:
          name: package-workbench-post-always-artifacts
          path: '${env_log_dir}/**/*.txt'
        if: always()
  publishing-to-anaconda:
    name: Publishing to Anaconda
    runs-on: ubuntu-latest
    needs: [package-workbench]
    if: inputs.PUBLISH_TO_ANACONDA
    env:
      WORKSPACE: ${{ github.workspace }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def channel = params.ANACONDA_CHANNEL.trim()
          echo "TODO: unconverted Jenkins step" && exit 1
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def credId = anacondaChannelToCredId(channel)
          echo "TODO: unconverted Jenkins step" && exit 1
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
        env:
          ANACONDA_TOKEN: ${{ secrets.CREDID }}
      - name: rm -fr ${WORKSPACE}/conda-packages
        run: rm -fr ${WORKSPACE}/conda-packages
        env:
          ANACONDA_TOKEN: ${{ secrets.CREDID }}
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: '*-artifacts'
          merge-multiple: true
          path: conda-packages
        env:
          ANACONDA_TOKEN: ${{ secrets.CREDID }}
      - name: '"${CISCRIPT_DIR}/publish-to-anaconda ${WORKSPACE}" + '' ${…'
        run: '"${CISCRIPT_DIR}/publish-to-anaconda ${WORKSPACE}" + '' ${ANACONDA_TOKEN} '' +\'
        env:
          ANACONDA_TOKEN: ${{ secrets.CREDID }}
      - name: 'TODO: Groovy statement needs a manual rewrite'
        run: |
          # TODO: Groovy statement needs a manual rewrite
          # "${ANACONDA_CHANNEL} ${ANACONDA_CHANNEL_LABEL} ${WORKSPACE}/conda-packages/*.conda"
          echo "TODO: unconverted Jenkins step" && exit 1
        env:
          ANACONDA_TOKEN: ${{ secrets.CREDID }}
  publishing-to-github:
    name: Publishing to Github
    runs-on: ubuntu-latest
    needs: [publishing-to-anaconda]
    # TODO: params.GITHUB_RELEASES_REPO.trim() != ''
    if: (inputs.PUBLISH_TO_GITHUB)
    env:
      GITHUB_TOKEN: ${{ secrets.__GITHUB_TOKEN_CREDENTIAL_ID_ }}
      WORKSPACE: ${{ github.workspace }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: rm -fr ${WORKSPACE}/standalone-packages
        run: rm -fr ${WORKSPACE}/standalone-packages
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: '*-artifacts'
          merge-multiple: true
          path: standalone-packages
      - name: rm -fr ${WORKSPACE}/conda-packages
        run: rm -fr ${WORKSPACE}/conda-packages
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: '*-artifacts'
          merge-multiple: true
          path: conda-packages
      - name: tar -cvf conda-packages.tar ${WORKSPACE}/conda-packages/
        run: tar -cvf conda-packages.tar ${WORKSPACE}/conda-packages/
      - name: '"${CISCRIPT_DIR}/publish-to-github ${WORKSPACE}" + '' ${GI…'
        run: '"${CISCRIPT_DIR}/publish-to-github ${WORKSPACE}" + '' ${GITHUB_TOKEN} '' +\'
      - name: 'TODO: Groovy statement needs a manual rewrite'
        run: |
          # TODO: Groovy statement needs a manual rewrite
          # "${GITHUB_RELEASES_REPO} ${GIT_TAG} ${GIT_SHA} ${prerelease_option()} " +\
          echo "TODO: unconverted Jenkins step" && exit 1
      - name: 'TODO: Groovy statement needs a manual rewrite'
        run: |
          # TODO: Groovy statement needs a manual rewrite
          # "${WORKSPACE}/standalone-packages/* ${WORKSPACE}/conda-packages.tar"
          echo "TODO: unconverted Jenkins step" && exit 1
  publish-nightly-docs:
    name: Publish nightly docs
    runs-on: ubuntu-latest
    needs: [publishing-to-github]
    # TODO: params.ANACONDA_CHANNEL.trim() == 'mantid'
    # TODO: params.ANACONDA_CHANNEL_LABEL.trim() == 'nightly'
    if: (inputs.PUBLISH_TO_ANACONDA)
    env:
      GITHUB_TOKEN: ${{ secrets.__GITHUB_TOKEN_CREDENTIAL_ID_ }}
      WORKSPACE: ${{ github.workspace }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        working-directory: conda-bld
      - name: Checkout
        uses: actions/checkout@v4
        with:
          path: ${{ env.CHECKOUT_DIR }}
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: '*-artifacts'
          merge-multiple: true
      - name: '"${CISCRIPT_DIR}/publish-nightly-docs.sh ${WORKSPACE}/con…'
        run: '"${CISCRIPT_DIR}/publish-nightly-docs.sh ${WORKSPACE}/conda-bld ${GIT_SHA}" + '' ${GITHUB_TOKEN} '''
  keep-latest-successful-build:
    name: Keep latest successful build
    runs-on: ubuntu-latest
    needs: [publish-nightly-docs]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: 'TODO: Groovy assignment needs a manual rewrite'
        run: |
          # TODO: Groovy assignment needs a manual rewrite
          # def build = currentBuild.getPreviousSuccessfulBuild()
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (params.DESCRIPTION.isEmpty())
      - name: 'TODO: Groovy statement needs a manual rewrite'
        run: |
          # TODO: Groovy statement needs a manual rewrite
          # while(build != null)
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (params.DESCRIPTION.isEmpty())
      - name: 'TODO: Groovy statement needs a manual rewrite'
        run: |
          # TODO: Groovy statement needs a manual rewrite
          # {
          #               if(build.build().getDescription() == keepDescription)
          #               {
          #                 build.build().setDescription("")
          #                 build.build().keepLog(false)
          #               }
          #               build = build.getPreviousSuccessfulBuild()
          #             }
          echo "TODO: unconverted Jenkins step" && exit 1
        # TODO: if (params.DESCRIPTION.isEmpty())
```

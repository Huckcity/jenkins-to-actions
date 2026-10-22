# eclipse-packages/packages: `.jenkins/Jenkinsfile` → GitHub Actions

Generated with [jenkins-to-actions](https://ci2actions.dev) (`npx jenkins-to-actions audit --repos eclipse-packages/packages`), MIT, runs locally. Review before use: anything without a clean equivalent is a `TODO` step that fails on purpose so it cannot be merged by accident.

## Conversion

Notes from the converter:

- This is a scripted (Groovy) pipeline. Control flow, variables and library calls were turned into TODO steps; expect to finish the conversion by hand.
- `podTemplate` (Kubernetes plugin) has no equivalent: the job runs on a hosted runner, and the container images below were mapped to `container:` or noted. Use actions-runner-controller if you still want pods on your own cluster.
- `pollSCM` became `on: push`; GitHub pushes events, so polling is unnecessary. Adjust the branch filter.
- `currentBuild.result = 'FAILED'` dropped (Jenkins build metadata).
- Groovy condition `if (needToDeploy())` could not be translated; a placeholder `true` was emitted on the affected steps.
- `sshagent` became `webfactory/ssh-agent`; store the private key as a secret.
- `dir('www')` wraps a step that uses an action; actions ignore `working-directory`, so pass the path as an input instead.
- Steps ran in pod container `jekyll`; the job now runs in `container: docker.io/jekyll/jekyll:4.1.0`. Container jobs need a Linux runner and the image must have a shell.
- Shell scripts referenced Jenkins variables (`BRANCH_NAME`, `BUILD_NUMBER`, `JOB_NAME`, `WORKSPACE`); they are defined in `env` with their GitHub equivalents.
- Create these repository secrets (Settings → Secrets and variables → Actions): GITHUB_BOT_SSH.

`.github/workflows/ci.yml`:

```yaml
name: Jenkinsfile
on:
  push:
    branches: [main]
  workflow_dispatch: {}
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false
jobs:
  build:
    name: build
    runs-on: ubuntu-latest
    container:
      image: docker.io/jekyll/jekyll:4.1.0
    timeout-minutes: 60
    env:
      BRANCH_NAME: ${{ github.ref_name }}
      BUILD_NUMBER: ${{ github.run_number }}
      JOB_NAME: ${{ github.workflow }}
      WORKSPACE: ${{ github.workspace }}
      PROJECT_NAME: packages
      PROJECT_BOT_NAME: Eclipse IoT Packages Bot
    steps:
      - name: Clean workspace
        run: 'rm -rf ./* ./.[!.]*'
        env:
          HELM_VERSION: 3.9.2
      - name: 'Init: pwd'
        run: |
          pwd
          env | sort
        env:
          HELM_VERSION: 3.9.2
      - name: 'Clone: Checkout'
        uses: actions/checkout@v4
        with:
          path: build
        env:
          HELM_VERSION: 3.9.2
      - name: 'Helm Install: curl --silent --location https://get.helm.sh/helm-v${HELM…'
        run: |
          curl --silent --location https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz --output helm.tar.gz
          tar --strip-components=1 -xvzf helm.tar.gz linux-amd64/helm
        env:
          HELM_VERSION: 3.9.2
      - name: 'Helm Build: mkdir -p helm-repository'
        run: |
          mkdir -p helm-repository
          for i in $(ls charts/*/Chart.yaml packages/*/Chart.yaml); do
              echo "Building $(dirname $i) ..."
              ${WORKSPACE}/helm package -u "$(dirname $i)" -d helm-repository
          done
          find helm-repository
        env:
          HELM_VERSION: 3.9.2
          XDG_CACHE_HOME: ${{ github.workspace }}/helm-cache
          XDG_CONFIG_HOME: ${{ github.workspace }}/helm-config
          XDG_DATA_HOME: ${{ github.workspace }}/helm-data
        working-directory: build
      - name: 'Jekyll Dependencies: cp -rd /usr/gem/. /usr/local/bundle/'
        run: |
          cp -rd /usr/gem/. /usr/local/bundle/
          bundle install --path /usr/local/bundle/
        env:
          HELM_VERSION: 3.9.2
          XDG_CACHE_HOME: ${{ github.workspace }}/helm-cache
          XDG_CONFIG_HOME: ${{ github.workspace }}/helm-config
          XDG_DATA_HOME: ${{ github.workspace }}/helm-data
        working-directory: build/homepage
      - name: 'Jekyll Build: bundle exec ruby /usr/gem/bin/jekyll build'
        run: bundle exec ruby /usr/gem/bin/jekyll build
        env:
          HELM_VERSION: 3.9.2
          XDG_CACHE_HOME: ${{ github.workspace }}/helm-cache
          XDG_CONFIG_HOME: ${{ github.workspace }}/helm-config
          XDG_DATA_HOME: ${{ github.workspace }}/helm-data
        working-directory: build/homepage
      - name: 'Checkout website: Start ssh-agent'
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.GITHUB_BOT_SSH }}
        # TODO: if (needToDeploy())
      - name: 'Checkout website: git config --global user.email "${PROJECT_NAME}-bot@eclip…'
        run: |
          git config --global user.email "${PROJECT_NAME}-bot@eclipse.org"
          git config --global user.name "${PROJECT_BOT_NAME}"
          git clone git@github.com:eclipse/${PROJECT_NAME}-website.git .
          git checkout ${BRANCH_NAME}
        working-directory: www
        # TODO: if (needToDeploy())
      - name: 'Copy content: rm -rf www/* && cp -Rvf build/homepage/_site/* www/'
        run: 'rm -rf www/* && cp -Rvf build/homepage/_site/* www/'
        # TODO: if (needToDeploy())
      - name: 'Copy content: git checkout -- charts/'
        run: git checkout -- charts/
        working-directory: www
        # TODO: if (needToDeploy())
      - name: 'Copy content: mkdir build/helm-add'
        run: |
          mkdir build/helm-add
          for i in $(ls build/helm-repository/*.tgz); do
            if [ ! -f "www/charts/$(basename $i)" ]; then
              echo "Publishing $(basename $i) ..."
              cp -v "$i" build/helm-add/
              touch build/perform-merge
            fi
          done
        # TODO: if (needToDeploy())
      - name: 'Rebuild helm Index: ${WORKSPACE}/helm repo index --merge www/charts/index.yam…'
        run: ${WORKSPACE}/helm repo index --merge www/charts/index.yaml build/helm-add --url https://eclipse.dev/packages/charts
        # TODO: if (needToDeploy())
        if: (hashFiles('build/perform-merge') != '')
      - name: 'Rebuild helm Index: cp -v build/helm-add/* www/charts/'
        run: 'cp -v build/helm-add/* www/charts/'
        # TODO: if (needToDeploy())
        if: (hashFiles('build/perform-merge') != '')
      - name: 'Commit and push: Start ssh-agent'
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.GITHUB_BOT_SSH }}
        # TODO: if (needToDeploy())
      - name: 'Commit and push: git add -A'
        run: |
          git add -A
          if ! git diff --cached --exit-code; then
            echo "Changes have been detected, publishing to repo 'www.eclipse.org/${PROJECT_NAME}'"
            git commit -m "Website build ${JOB_NAME}-${BUILD_NUMBER}"
            git log --graph --abbrev-commit --date=relative -n 5
            git push origin HEAD:${BRANCH_NAME}
          else
            echo "No changes have been detected since last build, nothing to publish"
          fi
        working-directory: www
        # TODO: if (needToDeploy())
```

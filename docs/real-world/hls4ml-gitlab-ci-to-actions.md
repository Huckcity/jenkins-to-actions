# fastmachinelearning/hls4ml: `.gitlab-ci.yml` → GitHub Actions

Generated with [jenkins-to-actions](https://ci2actions.dev) (`npx jenkins-to-actions audit --repos fastmachinelearning/hls4ml`), MIT, runs locally. Review before use: anything without a clean equivalent is a `TODO` step that fails on purpose so it cannot be merged by accident.

## Conversion

Notes from the converter:

- Job `pytests` triggers a downstream pipeline; use `gh workflow run` or a reusable workflow (`uses: owner/repo/.github/workflows/x.yml@main`).
- Runner tags `k8s-default` mapped to `[self-hosted, …]`; switch to a hosted runner if those were GitLab shared runners.
- Job `generator` has both runner tags and an image; the image was dropped because container jobs need a Linux runner.

`.github/workflows/ci.yml`:

```yaml
name: hls4ml
on:
  push:
    branches: ['**']
  workflow_dispatch: {}
jobs:
  generator:
    name: generator
    runs-on: [self-hosted, k8s-default]
    env:
      N_TESTS_PER_YAML: '4'
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Before script
        run: pip install pyyaml
      - name: cd test/pytest
        run: |
          cd test/pytest
          python generate_ci_yaml.py
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: generator-artifacts
          path: test/pytest/pytests.yml
  pytests:
    name: pytests
    runs-on: ubuntu-latest
    needs: [generator]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Download artifacts from generator
        uses: actions/download-artifact@v4
        with:
          name: generator-artifacts
      - name: 'TODO: Trigger downstream pipeline child pipeline'
        run: |
          # TODO: Trigger downstream pipeline child pipeline
          # {"include":[{"local":"test/pytest/ci-template.yml"},{"artifact":"test/pytest/pytests.yml","job":"generator"}],"strategy":"depend"}
          echo "TODO: unconverted step" && exit 1
```

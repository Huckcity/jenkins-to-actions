# Jenkinsfile → GitHub Actions converter

**Live:** https://jenkins-to-actions.adam-p-gibbons.workers.dev

Static, client-side converter from Jenkins pipelines (declarative and basic scripted) to GitHub Actions workflows. Everything runs in the browser; nothing is uploaded.

- `public/convert.js` — parser for the Jenkins Groovy DSL and the workflow emitter (no dependencies; usable from Node too).
- `public/index.html` — the page.
- `test/` — fixtures converted in both layouts and checked with [actionlint](https://github.com/rhysd/actionlint).

```sh
npm test        # convert fixtures, parse YAML, run actionlint
npm run dev     # wrangler dev
npm run deploy  # wrangler deploy (Cloudflare Workers static assets)
```

MIT licence.

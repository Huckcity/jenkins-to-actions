# Roadmap: from converter to migration product

The bar for this project is "makes more than it costs to host", and hosting costs £0. The bigger goal is a funnel: free tools at the top, a paid service at the bottom.

## Funnel

1. **Web converter** (live). One Jenkinsfile at a time. Findable by search; needs a few posts to seed traffic.
2. **Estate audit CLI** (live). Whole-server inventory + converted workflows + effort estimate. The `report.md` ends with the offer.
3. **Migration engagement** (the revenue). Fixed-price per estate, scoped from the audit's effort estimate. The audit *is* the sales document.

## Next steps, in order

- [ ] `npm login` and publish `jenkins-to-actions` so the command is `npx jenkins-to-actions` (currently `npx github:Huckcity/jenkins-to-actions`).
- [ ] Web page: "Auditing a whole server?" section with the npx command (done in the same change as this file).
- [ ] `--open-prs`: given a GitHub token, push each converted workflow to its repository on a branch and open a PR with the notes as the PR body. Turns the audit into a one-command first pass.
- [ ] Shared-library analysis: fetch `vars/*.groovy` from the library repo, list each custom step, how many Jenkinsfiles use it, and generate a composite-action skeleton per step.
- [ ] Jenkins credentials inventory (`/credentials/store/system/domain/_/api/json`) cross-referenced with the secrets the workflows need, so the secrets list is complete rather than inferred.
- [ ] Pricing page on the site: audit is free; "Migration sprint" from £X per 10 jobs; a Stripe payment link for a paid "audit review call" as a low-friction first purchase.
- [ ] Case study from the first paid engagement (anonymised), posted alongside the tool.

## Channels

- GitHub Marketplace does not list CLIs, so the action-based distribution test is `Huckcity/step-timing`.
- r/devops, r/jenkinsci, LinkedIn posts from `docs/launch-posts.md`; Show HN once the account is old enough.
- Jenkins community Discourse and the CloudBees migration threads: answer questions, link the audit when it fits.

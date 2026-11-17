# Hosting

Production hosting is GitHub Pages only. `npm run build` writes the static landing page, wallet, SDK bundle, and documentation to `dist-p2p/`. The `.github/workflows/pages.yml` workflow deploys reviewed merges to `main`. There is no server runtime and no Vercel configuration in this repository.

The guard `node scripts/verify-pages-only.mjs` rejects Vercel files and workflow references and checks that the Pages deploy actions are still configured. It guards repository code only. It cannot disable a GitHub App installed outside the repository. An owner can remove a stale Vercel app from the repository in GitHub's installed applications settings and drop any required `Vercel` status check. Do not remove branch protection to make a red check disappear.

## Verify

```sh
node scripts/verify-pages-only.mjs
npm run build
```

After a reviewed merge to `main`, check the Pages workflow and the published pages at <https://enzovezzaro.github.io/ai-auth/>. Pull requests must not trigger a production deploy.

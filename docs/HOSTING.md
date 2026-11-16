# Hosting: GitHub Pages only

AI Auth's static landing page, wallet, SDK browser bundle, and documentation are built by `npm run build` to `dist-p2p/`. Production hosting is **GitHub Pages**, via `.github/workflows/pages.yml` on merges to `main`. There is no Vercel runtime, configuration, or deploy step in this repository.

The CI guard `node scripts/verify-pages-only.mjs` rejects Vercel configuration files and workflow references, and verifies that GitHub Pages' upload/deploy actions remain configured. This guards **repository code only**; it cannot disable a separately installed GitHub App.

## Remove the old Vercel integration from GitHub

GitHub commit statuses currently identify the sender as `vercel[bot]` (the Vercel GitHub App). The app can continue writing a `Vercel` status even though the repository has no Vercel files.

An owner with GitHub installation/admin privileges should:

1. Open [GitHub's installed applications settings](https://github.com/settings/installations). Find **Vercel**, choose **Configure**, and remove **EnzoVezzaro/ai-auth** from its repository access. If this installation serves no remaining repositories, uninstall it. **Do not remove access from other repositories that still need it.**
2. In the repository's **Settings → Rules → Rulesets** and **Settings → Branches → Branch protection**, remove any required status check named **Vercel**. Keep the required GitHub Actions CI checks.
3. Confirm that new pushes/PRs no longer receive a new `Vercel` status, and that GitHub Actions' `CI` plus the GitHub Pages deployment remain successful.

Removing an app's access does **not** retroactively erase historical status entries from old commits; it stops new ones from that source. Do not publish credentials or disable branch protection to make a red check disappear.

## Verification

```sh
node scripts/verify-pages-only.mjs
npm run build
```

After a reviewed merge to `main`, verify the GitHub Pages workflow and the published pages at <https://enzovezzaro.github.io/ai-auth/>. No production deployment should be initiated by the PR itself.

# Publish PrivateCall from Windows PowerShell

These commands are written for the official GitHub account `alibaki89`. Everything is done in the terminal. **Do not run these commands inside an existing Git repository.** The archive has no `.git` folder.

## Prerequisites

Install Git, GitHub CLI (`gh`), and Node.js 20+ if not already available; re-open PowerShell. Then:

```powershell
git --version
gh --version
node --version
gh auth login
gh auth setup-git
gh api user --jq .login
```

The last command should say `alibaki89` before proceeding. Check that there is no existing repository named `alibaki89/PrivateCall`; the `gh repo create` command will fail safely rather than overwrite it.

## Check the source and create Git history

In the extracted `PrivateCall` folder:

```powershell
node .\build.mjs --check
npm test
(Get-FileHash -Algorithm SHA256 .\dist\PrivateCall.html).Hash
# Expected: 6310489FB1EF3B5FB39270034FD10F3CD736272262469FE7EA6EE97A7461268B
git init -b main
git add .
git status --short
git commit -m "Release PrivateCall 1.2.0"
```

If Git asks for your author identity, configure it with `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then rerun the commit; use your actual Git identity.

## Create and push the GitHub repository

```powershell
gh repo create alibaki89/PrivateCall --public --description "Portable peer-to-peer WebRTC voice and video calls with manual signaling" --source . --remote origin --push
```

Do **not** use `--add-readme` or `--license`: both already exist locally.

## Create the first release

```powershell
gh release create v1.2.0 .\dist\PrivateCall.html .\dist\SHA256SUMS .\documentation\PrivateCall-How-To.pdf --repo alibaki89/PrivateCall --title "PrivateCall 1.2.0" --notes-file RELEASE_NOTES.md --latest
```

Now the website's HTML download URL should resolve:

`https://github.com/alibaki89/PrivateCall/releases/latest/download/PrivateCall.html`

## Enable and publish GitHub Pages (from terminal)

```powershell
gh api -X POST repos/alibaki89/PrivateCall/pages -f build_type=workflow
gh workflow run pages.yml --repo alibaki89/PrivateCall --ref main
gh run list --repo alibaki89/PrivateCall --workflow pages.yml --limit 5
gh api repos/alibaki89/PrivateCall/pages --jq .html_url
```

Expected website: `https://alibaki89.github.io/PrivateCall/`

The workflow deploys only `site/index.html` plus the two documentation PDFs; it does not execute or host the call app. If Pages already exists, GitHub may return 409 on the POST: use `gh api -X PUT repos/alibaki89/PrivateCall/pages -f build_type=workflow` and trigger the workflow again.

You can watch the running deployment using the run ID shown by `gh run list`: `gh run watch <RUN_ID> --repo alibaki89/PrivateCall`.

## Final checks

```powershell
gh repo view alibaki89/PrivateCall --web
gh release view v1.2.0 --repo alibaki89/PrivateCall
gh run list --repo alibaki89/PrivateCall --limit 10
```

Check the landing page, click the HTML download button, compare the downloaded SHA-256 digest, and open the file locally in Chrome. A public repo and site do **not** establish security audit or censorship circumvention.

# Publishing to the DSH plugin market

The DSH plugin market does not have a "publish" button. The market app
(`dshmarket`) reads a curated registry — <https://awesome-dsh-plugin.com/plugins.json>
— generated from the **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)**
repository. Getting listed means **one PR adding one YAML file** there.

## What is already done for this repo

| Requirement | Status |
| --- | --- |
| `package.json` declares `dsh.bundle.patch` (not just `dsh.client`) | ✅ `dsh-plugin/package.json` |
| `cordis.patch.yml` exists next to the package | ✅ `dsh-plugin/cordis.patch.yml` |
| Real, working code (not a placeholder) | ✅ 27 tests, CI |
| Repo has the `dsh-plugin` topic | ✅ added |
| Repo at least **1 day old** | ⏳ created `2026-11-02T15:09:14Z` → eligible from **`2026-11-03T15:09:14Z`** |
| Entry YAML prepared | ✅ [`market/Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml`](../market/Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml) |

## Submit (after the repo turns 1 day old)

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>.
2. Add exactly one file: `data/plugins/Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml`.
   Copy the content of [`market/Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml`](../market/Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml).
   Do **not** edit the generated READMEs.
3. Open a PR titled e.g. `Add ctx-handoff-sentinel` and describe what the plugin does
   in one or two accurate sentences.

The filename rule for monorepo subpackages is `<owner>__<repo>--<path-with-dashes>.yml`
— here `Arid-G1FT__ctx-handoff-sentinel--dsh-plugin.yml`.

```yaml
url: https://github.com/Arid-G1FT/ctx-handoff-sentinel/tree/main/dsh-plugin
name: Arid-G1FT/ctx-handoff-sentinel#dsh-plugin
category: session
description:
  en: '...'
  zh: '...'
```

Requirements from the contributing guide that matter here:

- The `url` must match the repository/subdirectory exactly;
- `description.en` is the only required field, but both languages are good practice;
- a description containing `: ` must be quoted (ours is);
- the description is checked against the code — no superlatives, no APIs that do
  not exist.

## What happens after the PR merges

1. CI regenerates `README.md` / `README.zh.md` on `main`.
2. The registry at <https://awesome-dsh-plugin.com/plugins.json> refreshes daily.
3. The plugin appears in **插件 → 发现** in the market, installable with one click.
   Because the package is GitHub-hosted (no npm release), the install falls back to
   the source path form: `dsh plugin --profile <profile> add github:Arid-G1FT/ctx-handoff-sentinel#path:/dsh-plugin`.

Verify after a day:

```sh
curl -s https://awesome-dsh-plugin.com/plugins.json | grep -c ctx-handoff-sentinel
```

## Optional: publish to npm as well

The market prefers a verified npm package: faster installs, version pinning and
update checks. To do that:

1. Rename `dsh-plugin/package.json` from `@local/dsh-context-guard` to a public
   name (e.g. `dsh-context-guard`) and remove `"private": true`.
2. `npm publish` from `dsh-plugin/` (needs an npm account and 2FA).
3. Update the local profile link, since the package name changed:
   `dsh plugin --profile desktop remove @local/dsh-context-guard` then
   `dsh plugin --profile desktop add link:.../dsh-plugin`, and update
   `dsh.profile.bundles`.

The entry YAML does not need an `npm` field — the registry resolves it from the
package name when the package is published.

## Why we are not listed yet

The repo was created `2026-11-02T15:09:14Z`. The review gate rejects repos less
than one day old (it filters out PRs opened minutes after the repo was created).
Everything else is ready; submit on or after `2026-11-03 23:09` local time.

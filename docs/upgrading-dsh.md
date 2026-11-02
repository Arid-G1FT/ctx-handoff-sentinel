# Keeping the DSH plugin working across DeepSeek Harness releases

DSH is pre-1.0 (`0.2.x-rc.*`), so plugin seams can move between releases. This
page is the maintenance contract: what the plugin depends on, how to verify an
upgrade, and what to bump when something changes.

## TL;DR checklist after every DSH upgrade

```sh
# 1. run the tests (each file separately: `node --test dir/` spawns children
#    that some sandboxes block)
node dsh-plugin/test/core.test.mjs
node dsh-plugin/test/host.test.mjs
node dsh-plugin/test/client.test.mjs
python -m unittest discover -s skill/tests -p "test_*.py"

# 2. fully restart the app (host plugin code loads at boot)

# 3. smoke test inside one conversation
#    /guard status      -> renders, no error
#    /guard check       -> returns a verdict, no 400, no A/B/C dump
#    the dock appears above the composer, × hides it, /guard show restores it
```

If all three pass, bump `engines.dsh` in `dsh-plugin/package.json` to the tested
release range and note it in `CHANGELOG.md`.

## The exact seams this plugin uses

Anything not in this table is not a dependency.

| Seam | Used for | Typical breakage symptom |
| --- | --- | --- |
| `ctx.commands.register({name, description, input, handler})` | `/guard …` | command missing from the palette |
| `ctx.sessionProjections.register({key, stateSchema, stateVersion, init, apply, wire})` | durable verdict state | dock empty after restart, `unsupported state version` |
| `ctx.on('session/event', (session, event) => …)` | reacting to `compaction/end` | auto self-check never fires |
| Session event shapes: `compaction/end`, `compaction/summary`, `user/message`, `assistant/message`, `turn/end`, `tool/call`, `tool/result`, `command/run`, `command/done` | folding state, file ground truth | evidence counts wrong, verdict never appears |
| `ctx.agents.get(id)` / `ctx.agents.roots()` | live agent handle, root-only filter | "no live agent" / background probe never starts |
| `ctx.get('tokenMeter', false)` | token measurement in handoff | handoff lacks token counts (cosmetic) |
| `ctx.get('subagents')` → `startActivation({provider, label, request:{prompt, parent}, delivery:'caller', signal})` → `{childId, result, dispose}`; `result = {stopReason, output}` | background self-check in a fork child | `/guard check` returns "后台自检失败: …" |
| `agent.followup()` / `agent.inject()` must receive a **user-role message with an `id`** (`createUserMessage` shape) | inbox delivery | HTTP 400 `messages[n]: missing field role` — poisons the session log permanently |
| Client slot `conversation.input.dock` + `props.useProjection('contextGuard')` | the dock | dock missing, or view frozen |
| Profile patch: `package.json` `dsh.profile.bundles` + `cordis.patch.yml` `- insert:` entry, `dsh.bundle.patch`, `dsh.client.inject` | loading the plugin | plugin not loaded at all |

### Two rules learned the hard way

1. **Never read `ctx.<service>` as a property unless the service is in `inject`.**
   Cordis throws `cannot get property "x" without inject`. Use
   `ctx.get('x', false)` — it is the declaration-free accessor. Declaring the
   service in `inject` instead would stop the plugin from loading in compositions
   that lack it.
2. **Injected messages need `role` and `id`.** The host splices `followup`/
   `inject` payloads into the request verbatim and only assigns an identity.
   Mirror `createUserMessage` from `@deepseek-ai/dsh-llm`, or the provider rejects
   the whole request and every later turn in that session keeps failing.

## Upgrade procedure

1. **Read the release notes** for anything touching: `@deepseek-ai/dsh-agent`,
   `dsh-subagent`, `dsh-session`, `dsh-client-ui-conversation`, and the profile /
   bundle loader. Those cover every seam in the table above.
2. **Run the tests.** The suite is deliberately hermetic: the host tests use a mock
   ctx and a mock subagent service, so they catch contract-shape regressions
   without a live app.
3. **Restart the app** — host code loads at boot; a page refresh is not enough.
4. **Smoke test** the three commands above in a throwaway conversation first —
   if a background probe is broken, do not discover it in a long session.
5. **Bump and record**: `engines.dsh` + `CHANGELOG.md` + the compatibility table
   in `dsh-plugin/README.md`.

## When to bump what

| Change you made | Bump |
| --- | --- |
| Fold semantics of the projection (what an event means) | `STATE_VERSION` in `lib/core.js` **and** `stateVersion` in `index.js` registration — old checkpoints must be rebuilt from the log |
| New config option with a safe default | package version (minor) + `cordis.patch.yml` comment |
| New harness seam / new required service | package version (minor) + `engines.dsh` |
| Fix for a broken seam | package version (patch) + `CHANGELOG.md` entry |
| Tested a new DSH release | `engines.dsh` (add the range) + compat table row |

`STATE_VERSION` is about **state meaning**, not wiring: bump it when an old
checkpoint would fold differently under the new code. Replaying the session log
rebuilds state, so the cost of a bump is one recomputation, not data loss.

## Compatibility matrix (fill in as you test)

| Plugin | DSH release tested | Notes |
| --- | --- | --- |
| 0.1.0 | `0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.5` | initial: in-conversation probe |
| 0.1.0+ | (next release) | background probe via `startActivation`, `ctx.get` accessor, relaxed evidence policy |

Keep `engines.dsh` to the rows you actually ran; widening it without a test is
how a plugin breaks silently on someone else's machine.

## Rollback

- Plugin: `git checkout <previous tag>` in the repo, then
  `dsh plugin --profile desktop add link:<path>` and restart.
- State: old checkpoints rebuild from the session log, so downgrading a patch
  release is safe; downgrading across a `STATE_VERSION` bump just recomputes.
- If the dock misbehaves after an upgrade, `/guard show` restores a hidden dock
  and the client falls back to the dock's own projection view.

## Watching upstream

- Pin one "canary" DSH install and run `/guard check` after each release; the
  four surfaces most likely to move are listed in the table.
- If a release note mentions message schemas, subagent activations, or projection
  registration, upgrade the plugin in the same week — those are the seams that
  fail loudly (HTTP 400) rather than gracefully.

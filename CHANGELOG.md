# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-01

The automation half. Until now the package could write the week and read a day; the day itself and
the execution of its plan still lived in someone else's shell scripts. This release ships both, in
Node, with the same idempotency and read-only defaults as the rest of the package.

### Added

- `lib/daily.js` — one day of read-only facts: journal sections, ingest write-backs, open tasks,
  the day's git window (05:00 → 05:00 by default) and the existing Dream's shape. Never touches the
  model or the disk.
- `lib/dream.js` — the daily counterpart of `prompt.js`: facts → Dream prompt, the output contract
  (three sections in order, continuous `T`/`G` numbering, `自动批准: 常规 | 升级` only), structural
  validation, and the idempotent renderer that replaces only the
  `<!-- work-review:dream:generated --> … :end -->` block and preserves everything after it.
- `lib/nightly.js` — nightly CLI: `--date`, `--day-start-hour`, `--dry-run`, `--facts-out`,
  `--prompt-out`, `--body-file`, `--no-llm`, `--force`, `--review` / `--review-live`. Same facts-hash
  shortcut as the weekly CLI, and it refuses to overwrite a Dream it did not generate unless
  `--force` is passed.
- `lib/review.js` — approval executor: reads the Dream, splits `常规` from `升级` (missing approval
  and unnumbered plans count as escalated), prints the plan by default, runs a headless agent with
  `--run` (`DSH_PERMISSION_MODE=read-only`) or `--live` (`workspace-write`, local commits allowed,
  push forbidden), and writes the agent's JSON result back into `life/journal/<date>.md` as
  `<!-- sleep-review:begin -->` bullets that the weekly facts pack already parses.
- `automation/` — `run-nightly.sh`, `run-weekly.sh`, two launchd `.plist.example` files (Dream at
  05:05, routine on Monday 06:00), `cron.example`, and a README with the pipeline diagram, safety
  model and exit codes.
- 25 new tests (75 total) covering date windows, fact collection, prompt contract, validation,
  idempotent rendering, foreign-file protection, plan classification, agent-result parsing and
  approval-block rendering.

### Changed

- `runProvider()` takes a `permissionMode` argument (default `read-only`, so existing callers are
  unchanged); the review pass is the only caller that raises it.
- Cache writes are best-effort and fall back to `$TMPDIR` when `~/.cache/work-review` is not
  writable, instead of crashing the run that was about to report a validation failure.
- The panel footer version and `package.json` now both say `0.5.0`.
- README and README.zh-CN document the nightly → review → weekly loop and how to schedule it.

## [0.4.0] - 2026-10-31

One-click executor: the day view can now **run** the auto-approved part of a Dream's T/G plan from a
button, without opening a chat session. The panel still never writes vault files itself — it starts a
configured script and reports its exit status.

### Added

- `approve` block in `~/.dsh/work-review.json`: `label`, `python`, `script`, `args`. The script path
  is resolved against `vaultRoot`; `{date}` / `{vault}` are substituted in `args`; the default args are
  `["review", "{date}", "--live"]`. No `script` ⇒ no button, and the panel stays purely read-only.
- 「执行自动审批」/ Run approval button on the day tab. It `POST`s to `/work-review/api/approve`, which
  spawns the configured script detached (cwd = vault), then polls its state. The button shows
  「运行中…」, then the exit code; a running job can be left alone or the panel closed.
- `POST /work-review/api/approve` and `GET /work-review/api/approve?date=YYYY-MM-DD`. State lives in
  `~/.cache/work-review/approve-<date>.json` + `.log`; a second click while one run is alive is a
  no-op (`started: false`). If the host restarts mid-run the status becomes `unknown` instead of
  pretending success.
- `lib/approve.js` (runner, state machine, log tail) and `approveConfig()` in `lib/config.js`, both
  covered by tests, including handler-level tests for POST body parsing.

### Changed

- `review` / `approve` config is now read **per request** instead of once at plugin load, so editing
  `~/.dsh/work-review.json` takes effect on the next panel refresh (no host restart).
- The webServer handler accepts `POST` (JSON body, ≤16 KiB) for the approve route; every other route
  is still `GET`-only. The read-only contract for Dream/journal/routine files is unchanged: the new
  route only *starts a process*, it never edits vault files.

## [0.3.2] - 2026-10-30

Opt-in one-click review: the day view can now open a fresh session with a configured prompt, without
the panel itself ever writing anything.

### Added

- `review` block in `~/.dsh/work-review.json`: `label`, `command`, `autoSend`, `agentPreset`. When it
  is not configured the panel renders no button and stays purely read-only.
- 「去审批」/ Go review button next to the document title on the day tab. Clicking it fills the
  prompt template (`{date}`, `{week}`, `{title}`, `{path}`, `{vault}`) and opens a new session with
  that text as an unsent draft, so you press Enter yourself. With `autoSend: true` the session is
  created and the message sent immediately.
- `/work-review/api/index` now returns the configured `review` object (label / command / autoSend /
  agentPreset) so the client can render the button; nothing else on the API changed.
- `reviewConfig()` in `lib/config.js` with tests for defaults, invalid values and file loading.

### Changed

- The client half reads the optional `uiWorkspace` / `sessions` services lazily and degrades to
  clipboard copy when the running Harness build cannot create sessions.
- The panel's main-slot injection now also passes those lazily-resolved services; the sidebar entry
  and the read-only routes are unchanged.

### Fixed

- Nothing user-visible beyond the above; this release is additive and keeps the API, data layer and
  generated-file format compatible with 0.3.1.

## [0.3.1] - 2026-10-30

Panel UI rebuilt: the page now lays itself out like the built-in panel pages (own header, own
padding, single scrolling region) instead of pinning its height with JavaScript.

### Changed

- The panel owns a proper page frame: a 「工作回顾」 heading with a one-line subtitle (what it
  summarizes, read-only, vault name, version), consistent inner padding, and a footer limited to
  read-only / data-stays-local / vault / version. The content no longer starts flush against the top
  edge of the window.
- Navigation is a single row: underline tabs 「日报 / 周报」 plus a date or week `<select>` with `‹`
  and `›` jumps. The separate left-hand date/week list is gone, so the two navigations can no longer
  duplicate each other.
- The document body now strips the YAML frontmatter and the duplicate leading H1 before rendering,
  so a Dream file shows its title once, then the content.
- Layout is pure flexbox (`flex: 1 1 auto` + `min-height: 0` + an inner scroll container). The old
  `useFillHeight` / `findScrollParent` pixel-measuring code was removed, so expanding or collapsing
  the left sidebar just reflows the page.
- Day view keeps the Dream/journal toggle and links to the source file; week view keeps the week
  range, status and file path as chips under the title.

### Fixed

- Collapsing or expanding the sidebar no longer pushes content under the panel header: the header is
  in normal flow and the content scrolls below it, with no `position: sticky` and no hard-coded
  heights.
- Long week picker labels are truncated by the select instead of overflowing the toolbar.

## [0.3.0] - 2026-10-30

First public release: the plugin leaves the author's local `@local/` namespace, stops assuming a
vault path, and synthesizes with the local Harness out of the box — no patch file, no API key.

### Added

- `~/.dsh/work-review.json` as the configuration surface: `vaultRoot`, `outDir`, `cacheDir`,
  `dshCli` and an optional `providers` array. `DSH_WORK_REVIEW_CONFIG` selects another file and `~`
  is expanded in every path.
- Vault resolution chain: `--vault` → `DSH_WORK_REVIEW_VAULT` → config file → a clear error. With
  nothing configured the CLI refuses to guess and the panel says so instead of showing an empty
  vault.
- Built-in `dsh-default` provider: the CLI runs the local `dsh --profile headless` with the
  profile's existing model, so the default path needs no patch and no API key.
- `providers` as the advanced path for custom headless patches (`id`, `label`, `keyEnv`, `patch`).
  Keys are read from the environment or `~/.dsh/.credentials.yaml`; `auto` skips a provider whose
  patch or key is missing.
- Self-contained test suite under `test/`: facts come from the fictional mini-vault committed at
  `test/fixtures/vault/` and writes go to a temporary directory, so the tests never read, write or
  require a real vault.
- GitHub Actions CI (Node 22 and 24): `npm run check` plus `npm test` on every push to `main` and
  every pull request.
- Documentation: an English README, a Chinese README, this changelog, an MIT `LICENSE`, and
  `cordis.patch.example.yml` for inline bundle-row configuration.

### Changed

- Package renamed `@local/dsh-work-review` → `@dsh-external/dsh-work-review`, version `0.2.0` →
  `0.3.0`; the bundle row name follows the package name.
- `--vault` no longer falls back to a hard-coded path under the author's home directory; the
  documented default is now "resolve from config, or fail with an explanation".
- `--provider` accepts `auto`, `dsh-default`, or any provider id from the config file; the
  hard-coded two-provider list is now the fallback shape of a `providers` entry, not the only
  option.
- The README no longer documents the author's own profile, vault registration, or machine-specific
  verification steps.

### Fixed

- A fresh install with no configuration no longer reads a stranger's vault: an unconfigured plugin
  reports "not configured" in the panel and exits `2` in the CLI.
- The panel and the Host routes remain read-only — no configuration field can turn them into a
  write path.
- Run logs and rejected model output stay in `~/.cache/work-review/`, never inside the vault, even
  when `outDir` points elsewhere.
- The facts hash now covers the prompt version and the generation mode, so switching between
  `--no-llm` and synthesis rewrites the block while an unchanged rerun still touches nothing.

### Migrating from 0.2.0

0.2.0 was an internal `@local/` build that assumed the author's own vault and two hard-coded
providers. To move to 0.3.0:

1. Rename the dependency and the `dsh.profile.bundles` entry in your profile from
   `@local/dsh-work-review` to `@dsh-external/dsh-work-review`, then run `pnpm install` in
   `~/.dsh/profiles/<profile>` and restart the Harness. The bundle row ships with the package, so
   nothing has to be patched by hand.
2. Write `~/.dsh/work-review.json` with your `vaultRoot`. If you previously relied on
   `SLEEP_ROUTINE_VAULT`, either rename it to `DSH_WORK_REVIEW_VAULT` or move the value into the
   config file.
3. If you used a custom headless patch, move it into `providers` (`id`, `keyEnv`, `patch`); the
   default `dsh-default` provider needs no patch at all.
4. Existing routine files stay valid: `type: routine`, the generated-block markers and the facts
   hash are unchanged, so the first run after the upgrade either rewrites the generated block or
   reports "unchanged".

[0.3.2]: https://github.com/Wang-Chuming/dsh-work-review/releases/tag/v0.3.2
[0.3.1]: https://github.com/Wang-Chuming/dsh-work-review/releases/tag/v0.3.1
[0.3.0]: https://github.com/Wang-Chuming/dsh-work-review/releases/tag/v0.3.0

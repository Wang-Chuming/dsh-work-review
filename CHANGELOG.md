# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.0]: https://github.com/Wang-Chuming/dsh-work-review/releases/tag/v0.3.0

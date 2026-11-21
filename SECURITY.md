# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a suspected vulnerability. Include the version, what you did, what you expected and what happened. You will get an acknowledgement as soon as a maintainer can respond; there is no guaranteed response time, because this is a small project.

## Supported versions

Only the latest minor release line receives security fixes.

| Version | Supported |
| --- | --- |
| latest minor (see the npm page) | yes |
| older minors | no, please upgrade |

Pin the version you run (`npx android-architect@<version>`) and upgrade deliberately.

## Threat model in brief

- **The tool reads untrusted repositories.** Project files (code, Gradle files, docs, `.ai/` content, catalog overrides, agent output) are treated as data, never as instructions. Secret-like values and secret files are skipped or redacted before anything is written or printed. Parsers are strict and linear-time, and paths are kept inside the project.
- **It sends nothing anywhere.** The package has no telemetry, makes no network requests at runtime and has no dependencies. It runs no install scripts.
- **It writes only under `.ai/`**, plus the agent pointer files created by `init`, `.git/info/exclude` with `--local`, and an explicit `--out` path outside the project for reports. Vendored scripts in `.ai/tools` are checked against a manifest of hashes.
- **Supply chain.** Releases are published from GitHub Actions with npm provenance, through a protected `release` environment. The package ships only `bin/` and `skill/` plus package metadata.

### The `run` command has honest limits

`android-architect run` is opt-in and autonomous. Understand what it does before you use it:

- It **executes your project's build code on your machine** (Gradle scripts and plugins, test code) through the verification commands, and it launches a coding agent CLI that can edit files and run commands. A malicious or compromised repository can therefore run code as you. The validation of `.ai/run.config.json` (an allowlist of executables, no shell strings, an environment denylist) is a guard rail, not a sandbox.
- **Run it inside a container or VM for any repository you do not fully trust.** Do not run it with credentials in the environment that you would not hand to that repository.
- **Consent model:** the first run per project and per configuration needs an explicit `yes` at an interactive terminal after the full agent command, verification commands, passed environment variable names and budgets are shown. Any change to the configuration asks again. There is no flag to skip this.
- **It never pushes, merges or publishes.** It works on its own branch, commits locally, refuses to start on the default branch or a dirty tree, stops on budgets and on a `.ai/STOP` file, and pauses on steps tagged `irreversible` or `decision`.
- Default agent command lines are unverified (agent CLI flags change between releases); check the effective command shown at confirmation.

### Out of scope

Vulnerabilities in your own project, in the agent you plug in, in Gradle or in the libraries named in the catalog, and the correctness of unverified catalog data (it is marked `verified: false`).

## Telemetry

This repository and the package contain no telemetry.

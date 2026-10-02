# Codex Autoresearch

Codex Autoresearch helps improve local code through bounded investigations and repeatable benchmark experiments. You accept the goal, commands, allowed changes, evidence requirements, and budget before execution. It records observations and leaves a reviewable patch with the evidence behind it. Reviews, documentation, and one-off fixes normally stay ordinary Codex work.

Install through the Codex plugin picker (`/plugins`), choosing `TheGreenCedar -> codex-autoresearch -> Install plugin`, then start a new task in your target repository. The marketplace registration is maintained in [TheGreenCedar/AgentPluginMarketplace](https://github.com/TheGreenCedar/AgentPluginMarketplace); this directory contains the plugin source.

Start with a request that names your goal, benchmark, correctness checks, edit boundary, and time or packet budget. Ask Codex to propose the complete contract for approval before setup or execution. Follow [Start](docs/start.md) for the first measured baseline or [Bounded investigations](docs/investigations.md) when the method is still uncertain. The optional dashboard is read-only.

Approved commands run with your local permissions and can access files, start processes, contact external services, and incur costs. Packet processes receive a minimal environment by default. Keep credentials and private data out of commands, output, notes, and exports; redaction is best-effort. Read [Trust](docs/trust.md), [Privacy](docs/privacy.md), [Terms](docs/terms.md), and the [Security policy](SECURITY.md) before using sensitive repositories or expensive workloads.

Source development requires Node.js 24 or newer, npm, and Git. From this directory, run `npm ci`, `npm run check`, and `npm test`. Source-shaped marketplace installs hydrate the matching released runtime only after checksum, provenance, and archive validation. See [Maintainers](docs/maintainers.md) for packaging and verification and the [Docs index](docs/index.md) for the rest of the guide.

The 3.0 release is based on engineering verification; comparative advantage over ordinary Codex remains unproven. The repository's [public guide](https://github.com/TheGreenCedar/codex-autoresearch#readme) is the full product introduction. Licensed under [Apache License 2.0](LICENSE).

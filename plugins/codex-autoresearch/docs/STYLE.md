# Documentation style

Write these docs the way an experienced engineer would explain the tool to someone sitting beside them. The reader should feel that a person made choices about what mattered, not that every fact was poured into a template.

The public README and most pages under `docs/` are for people using the plugin. Start with the outcome, then explain the mechanism only as far as it helps them act. `SKILL.md` and its references are different: they are working instructions for Codex and can be denser. `maintainers.md`, `architecture.md`, and `control-plane.md` are allowed to assume more context, but they should still read like prose, not source code wearing Markdown.

Prefer ordinary paragraphs. Use a list when the reader really has a set of choices or steps, a table when they need to compare the same fields across several items, and a diagram when the relationship is hard to hold in a sentence. Do not turn every page into all three.

Internal names should arrive after the plain-English idea. "A structured note saved with each experiment" comes before its `asi` field. "The command that decides whether another run is safe" comes before `loopContract`. If the internal name does not help the reader do anything, leave it out.

Commands should be copyable and should appear close to the explanation they belong to. Warnings should say what can happen, not merely announce that something is unsafe. Link to the canonical explanation instead of repeating the same paragraph in Start, Operate, Trust, and the skill.

Avoid the usual generated-doc tells: a heading every few sentences, strings of one-line paragraphs, fake reassurance, symmetrical bullet lists, generic words such as "robust" and "seamless," or jokes added solely to prove the text has a pulse. Do not sprinkle personality over stiff prose and call it human. If a sentence could be pasted into almost any AI tool's documentation unchanged, it probably does not belong here.

Do not narrate what the page is about to do. Just do it.

The important facts must survive any rewrite:

- benchmarks print `METRIC name=value`
- the primary metric decides movement, while checks and constraints protect correctness
- `measure` is not a keep and cannot become finalization evidence
- `next` writes the reusable packet; `benchmark-inspect` is the bounded diagnostic probe
- keep and cleanup automation stays inside configured or explicitly supplied paths unless broad scope is explicitly allowed
- the dashboard is read-only
- `quality_gap=0` closes one accepted checklist round
- normal finalization begins with a preview and uses accepted, current keeps
- current-tree finalization is an exceptional, explicitly reviewed whole-diff contract
- benchmark and checks commands are not sandboxed

Do not add tests that pin whole sentences or editorial wording. Validate structure, stable command and field identifiers, required files, relative links and anchors, package contents, command schemas, and the behavior the docs describe.

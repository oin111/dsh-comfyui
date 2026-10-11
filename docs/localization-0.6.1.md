# Local 0.6.1 localization status

This update is LOCAL ONLY. Do not push, publish to npm, or create a release without explicit user approval.

## Completed

- UI locales are exactly Russian and English. Russian is the default, legacy zh localStorage preferences migrate to ru, and explicit en remains English. Settings, cards, panels, preset tag labels and all interpolation keys have translations.
- Tool descriptions/schemas/renderers and the model-visible companion skill use English (the companion directs Russian replies by default). Host-owned errors, generated skill-pack skeletons and parameter labels use Russian or English; none contain Han prose. Arbitrary user documents, workflow names, upstream node metadata and media filenames remain intact.
- Filename grammar is unchanged: literal Unicode ranges were rewritten as equivalent escaped ranges, not narrowed. Executable AST structure of the nine changed host modules is unchanged after ignoring text literals; filename regex equivalence was checked across all BMP characters.
- Package version is 0.6.1; examples install a local npm-pack tarball, not a nonexistent published release. Chinese README and its shipped links are removed. Editable maintainer/history/listing docs are English. Old screenshots containing Chinese UI were removed with their README references; screenshot replacement capture timed out.

## Verified

- Regression suite failed on exact Git archive 05731b0: four localization tests failed for the intended missing behavior/text. The new locale-default/parity tests were also observed failing before implementation.
- npm test and npm run typecheck pass, including unchanged backend/transport/security, host contracts, parameter persistence, skill packs, thousand-file preset roundtrip and graph conversion.
- Localization tests cover locale preference/storage failures, complete key/interpolation parity, source/bundle/editable-doc/metadata scans, registered tool schemas/renderers, companion skill and generated pack skeleton.
- The workflow skill action schema is accepted by real DSH validators on both 0.2.0-rc.2 and 0.2.1-alpha.2.
- Real browser settings on both hosts verified Russian default, legacy migration, ru/en switching across reloads, Save followed by config readback, and a successful localized connection test. These used a mocked ComfyUI system_stats endpoint and mock LLM; no GPU generation is claimed. Host UI language is independent from plugin UI language.

## Protected blocker — full acceptance NOT complete

The approval layer denied the CLAUDE.md translation. It was NOT retried through another tool or edited by a bypass. Its original Chinese maintainer contract remains unchanged, including old language/README references. CLAUDE.md is not shipped in the npm artifact, but repository-wide removal of Chinese cannot be claimed.

`npm run test:localization:full` intentionally remains failing on the protected CLAUDE.md check until an approved translation is possible. Default npm test checks production and editable docs, while this explicit additional release-acceptance gate includes the protected file. This is a blocker, not a skipped passing requirement.

CJK text retained in regression fixtures tests preservation of arbitrary user-authored content/paths; it is not shipped plugin prose.

Evidence logs and isolated probe homes are under `/home/hermes/.hermes/cache/scratch/comfy-ru-en/`.

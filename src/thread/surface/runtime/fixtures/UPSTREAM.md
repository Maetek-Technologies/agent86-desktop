# A2UI fixtures, vendored

These files come from Google's A2UI repository, <https://github.com/a2ui-project/a2ui>, at commit
`5ff1b05f02d39f969b52a942e78e864ef3ac01fa` (2026-11-20), licensed under the Apache License 2.0
(`LICENSE-APACHE` here). They were taken from agent86's `agent86-ui` crate (1.2.0), which vendors
the same commit, so this renderer and agent86's runtime are checked against the same cases.

| Here | Upstream |
|---|---|
| `basic_catalog.json` | `catalogs/basic/v1/catalog.json` |
| `conformance/*.json` | `conformance/core/*.yaml`, converted to JSON unchanged (PyYAML `safe_load`, then `json.dump`): the ten suites a renderer's runtime runs |
| `catalogs/*.json` | `conformance/test_data/catalogs/` (the catalogs the function cases use) |

The validator and message processor suites are not here: agent86 validates every batch before
the app sees it.

To refresh: copy the same files from agent86-ui's `spec/` and `tests/fixtures/` at the release the
app pins, update the commit above, and run `pnpm test`.

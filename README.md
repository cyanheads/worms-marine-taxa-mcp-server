<div align="center">
  <h1>@cyanheads/worms-marine-taxa-mcp-server</h1>
  <p><b>Resolve WoRMS marine taxa, classifications, synonyms, distributions, traits, and identifiers via MCP. STDIO or Streamable HTTP.</b></p>
  <div>8 Tools</div>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/worms-marine-taxa-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/worms-marine-taxa-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/worms-marine-taxa-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/worms-marine-taxa-mcp-server/releases/latest/download/worms-marine-taxa-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=worms-marine-taxa-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ybXMtbWFyaW5lLXRheGEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22worms-marine-taxa-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworms-marine-taxa-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Explore the [World Register of Marine Species (WoRMS)](https://www.marinespecies.org/): resolve scientific or common names to AphiaIDs, follow accepted names, and retrieve taxonomic and biological evidence. The public REST API needs no key.

### Tools

| Tool | Description |
|:---|:---|
| `worms_resolve_taxon` | Resolve exact or fuzzy scientific names, or search a common name |
| `worms_get_taxon` | Fetch full Aphia records and optional vernacular names |
| `worms_get_classification` | Fetch root-to-tip classification and optional direct children |
| `worms_get_synonyms` | Follow the accepted taxon and fetch a synonym page |
| `worms_get_distributions` | Fetch recorded distributions with optional local filters |
| `worms_get_traits` | Fetch attributes, references, and inheritance evidence |
| `worms_crosswalk_id` | Map AphiaIDs to external identifiers, or reverse an external ID |
| `worms_list_reference` | Inspect identifier codes, statuses, environment flags, ranks, and trait definitions |

## Capability reference

Names, external IDs, and text filters accept up to 512 characters. AphiaIDs are positive safe integers; paged tools use one-based offsets advancing by 50.

Reads return whole items within a 24,000-byte paired-surface response target. Keep the original inputs and options when following zero-based continuation selectors; null means consumed. `budgetLimited` identifies an early byte cut. One indivisible oversized scientific item is retained intact with `oversizedItem: true` and `requiredBytes`, then continuation advances. Values are never clipped. Continuations refetch upstream data, so changes at the source can affect later segments.

### `worms_resolve_taxon` <sub>tool</sub>

- Supply either `names` (up to 500 scientific names) or one `vernacular`; scientific reads use at most 50-name windows and return original `inputIndex` positions, preserving duplicates. Resume `nextInputOffset` and `nextMatchOffset` as `inputOffset` and `matchOffset` against the unchanged names; `deferredCount` counts unfinished input positions
- Scientific names match exactly by default; `fuzzy: true` opts in. `marineOnly` and `extantOnly` default to `true`; inspect every match and its `validAphiaId` / `validName` rather than assuming an ambiguous name has one answer
- Vernacular mode accepts upstream `offset` (one-based, default `1`) and local `resultOffset` (zero-based, default `0`); it cannot apply fuzzy matching or marine/extant filters. Consume `nextResultOffset` at the same upstream offset before advancing `page.nextOffset` and resetting `resultOffset` to zero
- Full 50-row upstream pages have uncertain continuation: `page.nextOffset` can lead to an empty page. Local scientific-match continuation exposes all fetched matches; a 50-match scientific group still has unknown upstream completeness

---

### `worms_get_taxon` <sub>tool</sub>

- Up to 500 `aphiaIds`; read at most 50 from `inputOffset` and resume `nextInputOffset` using the original array. `inputIndex` preserves duplicate and missing positions (`found: false`, `record: null`); `deferredCount` counts unfinished positions
- `includeVernaculars: true` requires exactly one submitted ID; follow `nextVernacularOffset` as `vernacularOffset`, repeating the full unchanged primary record. An optional lookup failure appears as `vernacularError` while retaining the record
- Records preserve citations, accepted-name links, and unknown fields; a null environment flag means unknown, not false

---

### `worms_get_classification` <sub>tool</sub>

- One `aphiaId` returns root-to-tip `ranks` segments; `found` distinguishes absent classification. `resultOffset` indexes the complete lineage followed by fetched children; follow `nextResultOffset` with unchanged options
- `includeChildren: true` adds one page of direct children, with one-based `offset`, `marineOnly: true`, and `extantOnly: true` defaults; these options are inactive without children
- Consume local segments at the same upstream offset before advancing `page.nextOffset` and resetting `resultOffset` to zero. A full fetched 50-row children page has uncertain continuation; `childrenError` retains the lineage when optional retrieval fails

---

### `worms_get_synonyms` <sub>tool</sub>

- One `aphiaId` follows the accepted taxon's `validAphiaId` before retrieving synonyms; `found` and `guidance` distinguish a missing taxon from a name without a known accepted ID
- One-based `offset` defaults to `1`; consume `nextResultOffset` as zero-based `resultOffset` at the same upstream offset before advancing `page.nextOffset` and resetting `resultOffset` to zero. A full fetched 50-row page has uncertain continuation

---

### `worms_get_distributions` <sub>tool</sub>

- One `aphiaId` returns recorded distributions in source order, retaining duplicates; follow `nextResultOffset` as `resultOffset` with unchanged filters
- Optional `recordStatus` (`valid`, `doubtful`, `inaccurate`), `establishmentMeans`, `invasiveness`, and `occurrence` filters combine by conjunction; status uses exact equality, the others case-insensitive whole-value equality
- Filtering scans the complete fetched set before pagination. `unfilteredCount` and `filteredCount` describe complete local evidence; `returnedCount` describes this segment. No rows does not establish biological or taxon absence

---

### `worms_get_traits` <sub>tool</sub>

- One `aphiaId`; `includeInherited` defaults to `true`
- Follow `nextResultOffset` as `resultOffset` with unchanged options. Attribute evidence retains values, references, inheritance markers, and complete-tree topology (`nodeIndex`, `parentIndex`, `depth`) in preorder; parents may be on earlier segments
- Missing traits do not prove biological absence; IUCN list membership is not a Red List threat category

---

### `worms_crosswalk_id` <sub>tool</sub>

- Supply exactly one of `aphiaId` (forward) or `externalId` (reverse); reverse requires `type`, while forward can omit it to query all nine systems
- Types: `algaebase`, `bold`, `dyntaxa`, `fishbase`, `iucn`, `lsid`, `ncbi`, `tsn`, `gisd`; IDs remain opaque strings, including leading zeros and LSIDs
- Forward `resultOffset` indexes whole identifiers across types in request order; follow `nextResultOffset` with unchanged selectors. `ids` contains this segment; `typeTotals` distinguishes successful absence (zero) from IDs on other segments, and omits `failedTypes`. Reverse returns `found` and a full `record`; `resultOffset` is inactive. No external IDs does not prove taxon absence, and an IUCN ID is not a threat assessment

---

### `worms_list_reference` <sub>tool</sub>

- Required `topic`: `external_id_types`, `statuses`, `environment_flags`, `ranks`, or `trait_types`
- The first three are available offline; statuses are a non-exhaustive guide. Ranks and trait definitions are retrieved live, with trait-key topology preserved
- Follow `nextResultOffset` as `resultOffset` with the same topic; `totalCount` is the complete fetched entry count. Tree indices stay global across segments

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

WoRMS-specific:

- Accepted-name relationships, sparse scientific facts, complete classifications, and trait hierarchy retained
- Shared conservative pacing: one active upstream request and at least 500 ms between starts; bounded calls rather than register harvesting
- A 45-second tool deadline and 8 MiB upstream response ceiling fail explicitly instead of clipping scientific data

Agent-friendly output:

- The same data in structured output and readable text, including effective options, continuation guidance, and attribution
- Optional enrichment and multi-system crosswalk outages retain useful results with typed errors; required reads fail explicitly
- Credit the [WoRMS Editorial Board](https://www.marinespecies.org/) ([doi:10.14284/170](https://doi.org/10.14284/170)) and preserve per-record citations when reusing results; see [WoRMS terms of use](https://www.marinespecies.org/about.php#terms)

## Getting started

### Self-Hosted / Local

Add this to your MCP client configuration:

```json
{
  "mcpServers": {
    "worms-marine-taxa-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/worms-marine-taxa-mcp-server@latest"]
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "worms-marine-taxa-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/worms-marine-taxa-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "worms-marine-taxa-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/worms-marine-taxa-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, run from the installed repository:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher, or Node.js v24+ to run the built package
- No WoRMS account or API key required

### Installation

```sh
git clone https://github.com/cyanheads/worms-marine-taxa-mcp-server.git
cd worms-marine-taxa-mcp-server
bun install
cp .env.example .env
bun run rebuild
```

## Configuration

No server-specific environment variables are required.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level. | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Framework storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for common framework overrides.

## Running the server

### Local development

```sh
bun run rebuild
bun run start:stdio
# or
bun run start:http
```

Run checks and tests:

```sh
bun run devcheck
bun run test
```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions/` | Eight read-only tool definitions. |
| `src/services/worms/` | WoRMS transport, normalization, schemas, and lossless formatting. |
| `tests/` | Service, tool-contract, and JSON-RPC integration tests. |
| `scripts/` | Build, validation, documentation, and packaging commands. |

See [`docs/tree.md`](./docs/tree.md) for the full tree.

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches; optional enrichment reports classified failures without discarding primary evidence
- Register tools in the `createApp()` arrays in `src/index.ts`
- Use relative ESM `.js` paths for internal source imports; package imports use their package names
- Validate upstream responses and preserve missing facts, source order, and attribution

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

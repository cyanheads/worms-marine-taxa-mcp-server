<div align="center">
  <h1>@cyanheads/worms-marine-taxa-mcp-server</h1>
  <p><b>Resolve WoRMS marine species names; fetch classifications, synonyms, distributions, traits, and IDs via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/worms-marine-taxa-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/worms-marine-taxa-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/worms-marine-taxa-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/worms-marine-taxa-mcp-server/releases/latest/download/worms-marine-taxa-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=worms-marine-taxa-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ybXMtbWFyaW5lLXRheGEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22worms-marine-taxa-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworms-marine-taxa-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://worms-marine-taxa.caseyjhand.com/mcp](https://worms-marine-taxa.caseyjhand.com/mcp)

</div>

---

## Overview

Marine taxonomy from the [World Register of Marine Species (WoRMS)](https://www.marinespecies.org/). Resolve scientific or common names to AphiaIDs, follow accepted names, and pull classifications, synonyms, distributions, traits, and external identifiers from the keyless WoRMS REST API.

Every AphiaID selector accepts a positive safe integer, a decimal string, or a canonical WoRMS LSID such as `urn:lsid:marinespecies.org:taxname:137205`; returned AphiaIDs remain numbers. For other LSIDs use `worms_crosswalk_id` with `externalId` and `type: "lsid"`, or resolve a scientific name with `worms_resolve_taxon`.

### Tools

| Tool | Description |
|:---|:---|
| `worms_resolve_taxon` | Resolve scientific names (exact or fuzzy) or one common name to AphiaIDs, with accepted-name links |
| `worms_get_taxon` | Fetch full Aphia records by AphiaID, optionally with common names or sources |
| `worms_get_classification` | Fetch the root-to-tip classification, optionally with direct children |
| `worms_get_synonyms` | List synonyms of the accepted taxon behind an AphiaID |
| `worms_get_distributions` | Fetch recorded distributions, filtered by status, establishment means, invasiveness, or occurrence |
| `worms_get_traits` | Fetch attribute trees (body size, functional group, conservation listings) with sources and inheritance |
| `worms_crosswalk_id` | Map an AphiaID to nine external identifier systems, or reverse an external ID |
| `worms_list_reference` | List identifier systems, statuses, environment flags, distribution filter values, ranks, and trait definitions |

## Capability reference

### `worms_resolve_taxon` <sub>tool</sub>

- A nonempty `names` list (no total-input ceiling, at most 50 per upstream request) or one `vernacular`, never both. `fuzzy: true` opts into TAXAMATCH matching; `marineOnly` and `extantOnly` default to `true` for names. Vernacular search matches a whole recorded common name, or with `vernacularMatch: "contains"` every recorded name containing the text (`grouper` finds no exact match but many by contains); it applies neither filter
- Each result keeps its `inputIndex` (duplicates included), every match with `status`, `validAphiaId`, and `validName`, and a `guidance` line on a miss; continue with `nextInputOffset` and `nextMatchOffset`
- Vernacular results page with the upstream `offset` (1-based, steps of 50) and the local `resultOffset`

---

### `worms_get_taxon` <sub>tool</sub>

- A nonempty `aphiaIds` list with no total-input ceiling, at most 50 fetched per request; continue with `nextInputOffset` using the unchanged list. Unknown IDs stay in position as `found: false`; every submitted element is validated before fetching
- `includeVernaculars: true` (one ID only) adds common names, paged with `vernacularOffset`; a failed lookup returns `vernacularError` beside the record
- `includeSources: true` (one ID only, not with `includeVernaculars`) adds the taxon's sources, such as its `original description` and `basis of record`, with `reference`, `page`, `url`, `link`, `fulltext`, and `doi` verbatim. Optional `sourceUse: "original description"` filters whole use values ignoring case before `sourceOffset` and the byte budget; blanks omit the filter, populated values stay untrimmed. Continue `nextSourceOffset` with unchanged options to repeat the full primary record and reconstruct every selected row in order
- Successful source results report `sourceTotalCount` for the complete selected bibliography and `unfilteredSourceCount` only with an effective filter. Notices distinguish no matching use, an empty bibliography, and a past-end offset. A failed lookup returns `sourcesError` beside the record without counts; `sourceUse` is inactive without `includeSources`

---

### `worms_get_classification` <sub>tool</sub>

- One `aphiaId`; `ranks` is the root-to-tip lineage, with `found: false` when WoRMS has none
- `includeChildren: true` adds one 50-row page of direct children (`offset`, `marineOnly`, `extantOnly`); a failed children lookup returns `childrenError` beside the lineage
- The submitted AphiaID keeps its own recorded lineage. A `notice` names its linked accepted AphiaID, or the preferred AphiaID for an accepted alternative representation; a failed status lookup returns `statusError` beside the lineage

---

### `worms_get_synonyms` <sub>tool</sub>

- One `aphiaId`, accepted or not: synonyms are listed for its accepted taxon (`validAphiaId`), 50 per upstream `offset`
- `found` and `guidance` separate a missing taxon from a name with no known accepted ID

---

### `worms_get_distributions` <sub>tool</sub>

- One `aphiaId`; optional `recordStatus` (`valid`, `doubtful`, `inaccurate`), `establishmentMeans`, `invasiveness`, and `occurrence` filters combine with AND. `recordStatus` ignores case and surrounding whitespace and echoes its lowercase code; the others match case-insensitive whole values without trimming populated strings, with observed values in `worms_list_reference` topic `distribution_terms`. Blank filters are omitted
- Reports `unfilteredCount` and `filteredCount`; rows carry the locality, its MarineRegions `locationId`, and status fields in source order
- WoRMS attaches records to individual name usages, so by default the tool reads that AphiaID's own records. `includeSynonyms: true` combines the accepted taxon's records with those of its synonyms, 10 synonyms per call, each row tagged `sourceAphiaId`; `synonymUnion` reports the window, the `nextSynonymOffset` to continue from, and any `failedSynonyms`
- A `notice` names the linked accepted AphiaID, distinguishing an accepted alternative representation from its preferred AphiaID; without `includeSynonyms`, a failed status lookup returns `statusError` beside the rows

---

### `worms_get_traits` <sub>tool</sub>

- One `aphiaId`; `includeInherited` (default `true`) adds attributes recorded on higher taxa. On an accepted taxon WoRMS also returns attributes recorded on its synonyms whatever `includeInherited` is set to; `inheritedFrom` names the source taxon in both cases
- A `notice` names the linked accepted AphiaID, distinguishing an accepted alternative representation from its preferred AphiaID; a failed status lookup returns `statusError` beside the attributes
- Every node keeps `nodeIndex`, `parentIndex`, and `depth` from the full tree, so units and qualifiers stay attached to their values across pages; values and references are verbatim
- `measurementType` (case-insensitive whole value, such as `Body size`) keeps each matching node with its subtree and ancestors, indices unchanged; `totalCount` counts that set and `unfilteredCount` the whole tree

---

### `worms_crosswalk_id` <sub>tool</sub>

- Exactly one of `aphiaId` (forward) or `externalId` with `type` (reverse). Forward reads one `type` or all nine: `algaebase`, `bold`, `dyntaxa`, `fishbase`, `iucn`, `lsid`, `ncbi`, `tsn`, `gisd`
- Forward returns `ids` per type, `typeTotals` (0 means none recorded), and `failedTypes` for systems that errored; reverse returns `found` and the full record. IDs stay opaque strings, leading zeros included

---

### `worms_list_reference` <sub>tool</sub>

- `topic`: `external_id_types`, `statuses`, `environment_flags`, and `distribution_terms` are served offline; `ranks` and `trait_types` are read live
- `statuses` covers the 28 statuses the WoRMS manual and REST API document, each with a one-line meaning and a `group` (`accepted`, `unaccepted`, `uncertain`, `technical`). A record's status can be the specific reason itself, such as `junior subjective synonym`, so test the group rather than `status === "unaccepted"`; the guide is non-exhaustive
- `distribution_terms` lists the `establishmentMeans`, `invasiveness`, and `occurrence` values observed in WoRMS distributions, for the whole-value filters of `worms_get_distributions`; the lists are non-exhaustive
- Pages with `resultOffset`; trait definitions keep their tree indices across pages

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

WoRMS-specific:

- Exact and TAXAMATCH fuzzy name matching with marine and extant filters; every match and record carries its accepted-name links
- One shared request queue: one upstream request at a time, 500 ms between starts, a 45-second tool deadline, and an 8 MiB response ceiling
- Per-call retrieval with no cache or bulk harvesting, as the [WoRMS webservice guidance](https://www.marinespecies.org/aphia.php?p=webservice) asks
- Every response carries WoRMS attribution ([doi:10.14284/170](https://doi.org/10.14284/170)); credit the WoRMS Editorial Board and keep per-record citations when reusing results ([terms](https://www.marinespecies.org/about.php#terms))

Agent-friendly output:

- Byte-bounded pages: reads return whole items within a 24,000-byte response and name the next offset (`nextResultOffset`, `nextInputOffset`, upstream `page.nextOffset`); a full 50-row upstream page reports `hasMore: null` rather than guessing
- Unknown stays unknown: null and absent fields pass through, a null environment flag means not recorded, and empty evidence never claims biological absence
- Partial failure: optional lookups (`vernacularError`, `sourcesError`, `childrenError`, `statusError`), synonym-union `failedSynonyms`, and crosswalk `failedTypes` keep the data that did arrive, with typed reasons and recovery hints

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http worms-marine-taxa-mcp-server https://worms-marine-taxa.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add worms-marine-taxa-mcp-server -- npx -y @cyanheads/worms-marine-taxa-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "worms-marine-taxa-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/worms-marine-taxa-mcp-server"]
    }
  }
}
```

No API key or account is needed: the WoRMS REST API is public. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

The server has no variables of its own; these are the common framework settings.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/worms-marine-taxa-mcp-server.git
  cd worms-marine-taxa-mcp-server && bun install
  cp .env.example .env
  ```

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/worms-marine-taxa-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/worms-marine-taxa-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/worms-marine-taxa-mcp-server:latest"]`. To build locally, `docker build -t worms-marine-taxa-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Tool definitions (`*.tool.ts`). Eight read-only tools. |
| `src/services/worms` | WoRMS service: paced transport, normalization, domain schemas, response budgeting, and formatting. |
| `docs/` | Design contract (`design.md`) and the generated directory tree. |
| `tests/` | Service, tool-contract, and JSON-RPC integration tests. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches; optional lookups report classified failures beside the primary data instead of discarding it
- Register new tools in the `createApp()` arrays in `src/index.ts`
- Internal imports are relative ESM paths with `.js` extensions
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

---
name: worms-marine-taxa-guide
description: Gates and identifier hops for the worms_* tools (World Register of Marine Species). Use when cleaning a species list against WoRMS, turning a common name into an accepted species, answering a native, alien, or invasive range question, citing trait values, finding a taxon's original description, or reconciling AphiaIDs with FishBase, NCBI, ITIS, BOLD, or IUCN identifiers.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

WoRMS is the register of marine species names, keyless. It also holds brackish, freshwater, terrestrial, and extinct taxa its editors track.

- Distribution rows are checklist records (a locality and its MarineRegions ID), not observations. Sightings, counts, and point maps come from an occurrence database such as GBIF.
- Some extinct taxa resolve with `extantOnly: false`, but WoRMS is not a fossil register: *Otodus megalodon* does not resolve under either setting. The Paleobiology Database covers fossils.

## Identifiers

| Identifier | Where it comes from | Use it for |
|:--|:--|:--|
| `aphiaId` | each match from `worms_resolve_taxon` | the name usage as submitted |
| `validAphiaId` | every match and record | the accepted taxon; pass it to every evidence tool |
| `originalAphiaId` | the `worms_get_taxon` record | the original combination, which can hold the original description after a genus change |
| `inheritedFrom` | `worms_get_traits` nodes | the higher taxon or synonym an attribute is actually recorded on |
| `sourceAphiaId` | `worms_get_distributions` rows with `includeSynonyms` | the name usage a distribution record is attached to |
| external IDs | `worms_crosswalk_id` forward | opaque strings per system; a reverse lookup needs the matching `type` |

## Gates

**Never pick `matches[0]`.** One name can return several accepted matches, such as homonym genera in different kingdoms: with both filters off, `Morus` returns the gannet genus and the mulberry genus. Matches carry authority and rank but no kingdom. Pass every candidate `aphiaId` to one `worms_get_taxon` call and decide on kingdom, phylum, and authority, or ask the user.

**Accepted means `validAphiaId` equals `aphiaId`.** An `alternative representation` is accepted yet links to its preferred form; use the preferred one. Do not test `status === "unaccepted"`: WoRMS also writes the specific reason as the status itself (`superseded combination`, `junior subjective synonym`). When `validAphiaId` is null, report the name with its status rather than substituting a guess; `worms_list_reference` with topic `statuses` groups the values.

**A fuzzy match is a proposed correction.** Fuzzy results report how each name matched in `matchType` (`phonetic` and `near_1`, for example). Show the user the submitted and matched spellings before rewriting a name, and run fuzzy matching only over the names the exact pass missed.

**A miss under the defaults is not "not in WoRMS".** The marine and extant defaults hide freshwater-only, terrestrial, and extinct taxa: `Danio rerio`, `Homo sapiens`, and `Trilobita` all miss under them; `Danio rerio` resolves with `marineOnly: false`, `Homo sapiens` resolves with both filters off and `Trilobita` with `extantOnly: false`. Retry with both off before reporting a name absent.

**Matching under the marine default does not make a taxon marine.** The default keeps taxa WoRMS flags marine or brackish, so `Dreissena polymorpha`, flagged brackish and freshwater but not marine, resolves under it. For a habitat question, read `isMarine`, `isBrackish`, `isFreshwater`, and `isTerrestrial` on the record; null means not recorded.

**Common names map to several taxa.** Vernacular hits include unaccepted names: `lionfish` with `contains` returns a superseded combination beside *Pterois volitans*, and `Atlantic cod` with `contains` returns a junior subjective synonym beside *Gadus morhua*. Start with exact matching. Collect the hits' `validAphiaId` values, deduplicate them, and ask the user when more than one accepted taxon remains.

**A negative range answer needs every synonym window.** Records attach to individual name usages, and an alien record can sit on a synonym: *Amphibalanus improvisus* returns more `Alien` rows with `includeSynonyms` than on its own AphiaID. Before saying a taxon has no alien or invasive record somewhere, walk `includeSynonyms` from `synonymOffset` 0 until `synonymUnion.nextSynonymOffset` is null, then report "no record in WoRMS", never "not present".

**Status filters drop unlabeled rows.** `establishmentMeans`, `invasiveness`, and `occurrence` are often null; many *Carcinus maenas* rows carry none. A filter never matches null and matches whole values only: `Ali` matches nothing where `Alien` matches. A row without `Alien` is not thereby native. For native-range or presence questions, read the rows unfiltered.

**Quote a trait with its provenance.** A node with `inheritedFrom` set is recorded on a higher taxon (a functional group recorded on a subclass) or on a synonym. Present it as a group-level or synonym-level record, not a measurement of the species itself. A numeric value's unit, type (minimum or maximum), and dimension sit in the subtree below it: read the descendants of the value's `nodeIndex` before quoting a number.

## Workflows

**Clean a checklist.** Send the whole list as one `names` array with duplicates and order intact. Pass 1: exact. Pass 2: the misses only, with `fuzzy: true`. Pass 3: the remaining misses, exact again, with `marineOnly: false` and `extantOnly: false`. For each input report the accepted name (`validName`, `validAphiaId`), the submitted name's status, `matchType` when it is not `exact`, and every input with more than one accepted match.

**Common name to species.** Resolve the vernacular, apply the common-name gate, then work from the chosen `validAphiaId`.

**Alien or invasive question.** Resolve to the accepted AphiaID. Call `worms_get_distributions` with `includeSynonyms: true` and an `establishmentMeans` or `invasiveness` value from `worms_list_reference` topic `distribution_terms`, walk every synonym window, and report each locality with its `sourceAphiaId`.

**Original description.** Start with the record's `authority`: in a zoological name, an author and year in parentheses mean the species was described in another genus. Call `worms_get_taxon` with `includeSources: true` and `sourceUse: "original description"` on the accepted AphiaID. When nothing matches and `originalAphiaId` differs from it, repeat the call on `originalAphiaId`. For *Amphibalanus improvisus* the description sits only on the original combination, *Balanus improvisus*.

**Reconcile identifiers.** Request one `type` when one system is needed: omitting `type` makes nine paced upstream lookups and takes several seconds. Keep every ID a type returns. A reverse lookup returns a full record; apply the accepted-name gate to it as to any match.

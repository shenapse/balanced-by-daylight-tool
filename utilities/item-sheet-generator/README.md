# Item Sheet Generator

A standalone CLI tool that reads a YAML file describing one killer's *allowed survivor items*
and produces a single PNG "allowed items" sheet — **one row per allowed item variant**, showing
that variant alongside the add-ons allowed for its item type — plus an optional BbD
balancing-preset JSON.

Items are **survivor-only**, so (unlike the perk sheet generator) there is no killer side.
Killer power add-ons are out of scope; this tool only produces `ItemWhitelist` + `AddonWhitelist`.

## Quick start

```bash
# From the repo root:
npm i js-yaml   # one-time install (canvas is already a dependency)

node utilities/item-sheet-generator/item-sheet-generator.js \
     utilities/item-sheet-generator/examples/the-trapper.yaml \
     --out utilities/item-sheet-generator/output \
     --preset utilities/item-sheet-generator/output/test-preset.json
```

## CLI

```
node utilities/item-sheet-generator/item-sheet-generator.js <file.yaml...>
     [--out <dir>]        Output directory (default: next to each input file)
     [--preset <path>]    Also compile a BbD preset JSON from all input files
     [--name "<name>"]    Preset Name field (default: "Generated Item Allow-List")
```

## Data model (why it looks the way it does)

`public/Items.json` has two levels:

- **Item types** (7): `Firecracker`, `Flashlight`, `Med-Kit`, `Toolbox`, `Key`, `Map`, `Fog Vial`.
  Each type owns its **add-on pool**.
- **Item variants** (33): e.g. `Flashlight`, `Sport Flashlight`, `Anniversary Flashlight`, all of
  `Type: Flashlight`. Variants are what a build actually equips.

The balancing preset whitelists at both levels:
- `ItemWhitelist` — a list of **variant** ids; any variant not listed is banned.
- `AddonWhitelist` — keyed by **type name**, `{ "Addons": [<local add-on ids>] }`; any add-on of a
  type not listed is banned (empty list = all of that type's add-ons banned).

So the YAML is keyed by **item type**, and within each type you control its **variants** and its
**add-ons** independently.

## YAML schema

```yaml
killer: The Trapper        # Matched against Killers.json Name + Aliases (normalized)

balancing: DBDLeague       # OPTIONAL. Label of the balancing ruleset these allow-lists
                           # come from. Rendered on the sheet and stored in the preset JSON.

default: deny              # OPTIONAL. Default for any item type NOT listed under `items:`.
                           # allow | deny (default: deny).

items:
  Flashlight:              # key = item TYPE name (Firecracker | Flashlight | Med-Kit |
                           #                        Toolbox | Key | Map | Fog Vial)
    default: deny          # which VARIANTS of this type are allowed (allow | deny)
    allow:                 # variant-name exceptions to the type default
      - Sport Flashlight
    deny: []
    addons:
      default: deny        # which ADD-ONS of this type are allowed (allow | deny).
                           # If omitted, the add-on default follows this type's variant default.
      allow:
        - Wide Lens
        - Power Bulb
      deny: []

  Med-Kit:
    default: allow
    deny:
      - Anniversary Med-Kit
    addons:
      default: allow
      deny:
        - Anti-Haemorrhagic Syringe
        - { rarity: "Ultra Rare" }   # ban all Ultra Rare add-ons (e.g. Gel Dressings)
```

### Resolution rules (applied independently for variants and for add-ons of each type)

1. **Universe** = all variants of that type (for the variant list) / all add-ons of that type
   (for the add-on list).
2. **Seed** from `default`: `allow` → everything allowed; `deny` → nothing allowed.
   - A type omitted from `items:` uses the top-level `default` for both its variants and add-ons.
   - An `addons` block with no `default` inherits its type's variant `default`.
3. Apply each `deny` selector → remove the named entry.
4. Apply each `allow` selector → add the named entry. **`allow` is applied last and wins** on
   conflicts.

### Selectors

Each entry in `allow:` / `deny:` is either:

- A **plain name string** — item-variant or add-on name, matched case-insensitively with
  spaces/dashes/underscores/apostrophes/ampersands folded.
- A **rarity object** (add-on lists only) — `{ rarity: <name-or-index> }` — selects all add-ons
  of that rarity at once. Accepted forms:

  ```yaml
  addons:
    deny:
      - { rarity: "Ultra Rare" }   # by name (case-insensitive)
      - { rarity: 4 }              # equivalent using a numeric rarity index
  ```

  Valid rarity names (and their numeric indices): `Common` (0), `Uncommon` (1), `Rare` (2),
  `Very Rare` (3), `Ultra Rare` (4), `Event` (5).

**Hard errors** (non-zero exit): an unknown killer name, an unknown item-type key, an unknown
variant/add-on name, an unknown rarity name, or an unrecognised selector shape (the message names
the offending token and the file).

## Item limits (image-only)

The allow-list above is a **candidate pool**: each survivor brings exactly **one** item, chosen
from it. On top of that pool you can express how many of a given item the team may field. These
limits are **rendered on the sheet only** — they are *not* written to the `--preset` JSON (only the
allow-lists become whitelists). Two optional top-level keys, both lists:

```yaml
# Duplicate limits: "how many survivors may bring the SAME item."
itemDuplicateLimits:
  - scope: team          # team | duo   (see note on scopes below)
    max: 1               # at most this many members may bring any one item
    items: all           # "all" (or omitted) = every allowed item; or a list narrows it
  - scope: duo
    max: 1
    items:
      - First Aid Kit
      - Ranger Med-Kit

# Pick limits: "the group may bring at most N items drawn from this set."
itemPickLimits:
  - scope: team
    max: 2               # must be less than the number of resolved items
    items:               # a list of 2+ selectors (see below)
      - { type: Med-Kit }
      - { type: Toolbox }
```

### Scopes

Item limits support only **`team`** (the whole 4-survivor squad) and **`duo`** (two members).
There is no `survivor` scope: each survivor brings a single item, so a per-survivor item limit
would be vacuous. Scope is shown on the sheet as a coloured chip (`DUO` orange, `WHOLE TEAM` red).

### Limit selectors

Each entry under a limit's `items:` is either:
- A **plain name string** — an item **variant** name (normalised like everywhere else).
- A **`{ type: <TypeName> }` object** — expands to **all allowed variants of that type**. Use this
  when you mean the whole item type (it also disambiguates a variant named like its type, e.g. the
  `Flashlight` variant vs. the `Flashlight` type).

A selector that names a variant **not** in this sheet's allowed pool is warned about and dropped
from that limit; an unknown name/type is a hard error.

### How limits are validated / reduced

- `scope` must be `team` or `duo`; `max` must be a positive integer.
- A **duplicate** limit renders per rule as its scope chip + a sentence like *"No two survivors may
  bring the same item."*, followed by the listed item icons (or an `ALL ITEMS` pill for `items: all`).
- A **pick** limit requires an explicit list of 2+ items and renders as *"The team may bring at most
  N of these items."* + the item icons. If `max` is at least the resolved item count the limit is
  **vacuous** and is warned about and dropped.

## Output

One PNG per input file into `<outDir>/`:
- `<KillerSlug>-items.png`

Layout: a dark header (killer portrait, the title **"Going against: \<killer\>"** — survivors bring
these items against that killer — "Allowed Items & Add-ons", a legend line clarifying that **each
survivor brings one item chosen from the pool**, the item count, one count-line per limit family
present (e.g. *(1 duplicate limit)*), and a provenance block with the `balancing` label if set plus
the auto-stamped generation timestamp). Below the header the allowed items are grouped under an
**item-type section header** (Flashlight, Med-Kit, …) in item-type order, each showing one row per
allowed variant — the variant icon and its type's allowed add-on icons in a strip. Rows with no
allowed add-ons show "(no add-ons allowed)". Finally, any **Duplicate Limit** and **Pick Limits**
sections render below the grid, each with a scope chip, a plain-English rule sentence, and the
affected item icons. Missing icons fall back to a grey placeholder box.

## Preset compilation (`--preset`)

When `--preset <out.json>` is given, all input files are aggregated into a single BbD balancing
preset (shape matches `ValidateCustomBalancing()`):

```json
{
  "Name": "...",
  "Balancing": "DBDLeague",
  "GeneratedDate": "2026-06-20T14:32:00.000Z",
  "MaxPerkRepetition": 1,
  "GlobalNotes": "",
  "Tiers": [ { "Name": "General", "SurvivorIndvPerkBans": [], ... } ],
  "KillerOverride": [ ... one entry per input file ... ]
}
```

Each `KillerOverride` entry is templated off `DEBUG.json` (so all required fields exist) with:
- `ItemWhitelist`  = allowed variant ids (numbers, sorted)
- `AddonWhitelist` = all 7 item types, each `{ "Addons": [<allowed local ids>] }`

All perk-related fields are left empty (this tool does not constrain perks — pair it with the
`perk-sheet-generator` preset if you need both).

Top-level `Balancing` (from the first input file that sets it) and `GeneratedDate` (ISO timestamp
of the run) are added for provenance; `ValidateCustomBalancing()` ignores unrecognised top-level keys.

## Asset paths

PNGs are resolved from the repo's `canvas-image-library/` mirror tree (node-canvas can't read WebP):
- Item variant: `canvas-image-library/Items/<basename>.png`
- Add-on:       `canvas-image-library/Addons/<basename>.png`
- Portrait:     `canvas-image-library/Portraits/<basename>.png`

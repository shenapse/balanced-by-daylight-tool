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

Each entry in `allow:` / `deny:` is a **plain name string** (item-variant name or add-on name),
matched case-insensitively with spaces/dashes/underscores/apostrophes/ampersands folded. There are
no group selectors — survivor item add-ons carry no rarity or tag metadata.

**Hard errors** (non-zero exit): an unknown killer name, an unknown item-type key, or an unknown
variant/add-on name (the message names the offending token and the file).

## Output

One PNG per input file into `<outDir>/`:
- `<KillerSlug>-items.png`

Layout: a dark header (killer portrait, the title **"Going against: \<killer\>"** — survivors bring
these items against that killer — "Allowed Items & Add-ons", item count, and a provenance block with
the `balancing` label if set plus the auto-stamped generation timestamp), then one row
per allowed variant — the variant icon, its name, and its type's allowed add-on icons in a strip.
Rows with no allowed add-ons show "(no add-ons allowed)". Variants are grouped in item-type order,
then sorted by name. Missing icons fall back to a grey placeholder box.

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

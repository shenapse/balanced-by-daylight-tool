# Add-on Sheet Generator

A standalone CLI tool that reads a YAML file describing one killer's *allowed*
power add-ons and produces a PNG "allowed add-ons" sheet — grouped by rarity
(Common → Uncommon → Rare → Very Rare → Ultra Rare) with rarity-bordered icons —
plus an optional BbD balancing-preset JSON, plus an optional text-free icon-grid
PNG with `--icons-only`.

Add-ons are killer-side only. Survivor items and their add-ons are handled by the
sibling `item-sheet-generator`; this tool only deals with the killer's power
add-on pool (`AddonTiersBanned` + `IndividualAddonBans`).

## Quick start

```bash
# From the repo root:
npm i js-yaml   # one-time install

node utilities/addon-sheet-generator/addon-sheet-generator.js \
     utilities/addon-sheet-generator/examples/the-trapper.yaml \
     --out utilities/addon-sheet-generator/output \
     --preset utilities/addon-sheet-generator/output/test-preset.json
```

## CLI

```
node utilities/addon-sheet-generator/addon-sheet-generator.js <file.yaml...>
     [--asset-root <dir>] Repo root used to resolve canvas-image-library/ assets
                          (default: DBD_BALANCING_TOOL_ROOT env var, else auto-detected)
     [--out <dir>]        Output directory (default: next to each input file)
     [--columns <n>]      Max icons per row within a rarity section (default: 8)
     [--preset <path>]    Also compile a BbD preset JSON from all input files
     [--name "<name>"]    Preset Name field (default: "Generated Add-on Allow-List")
     [--icons-only]       Also write a text-free, transparent icon-grid PNG (see Output)
```

## YAML schema

```yaml
killer: The Trapper     # Matched against Killers.json Name + Aliases (case-insensitive)

balancing: DBDLeague    # Optional. Label of the balancing ruleset these allow-lists
                        # come from. Rendered on the sheet and stored in the preset JSON.

addons:
  default: allow        # allow | deny — applied to the whole add-on pool (default: deny)
  deny:                 # exceptions to the default
    - Honing Stone               # individual add-on by name
    - { rarity: "Ultra Rare" }   # group: every add-on of that rarity
    - { tier: 4 }                # same group, by numeric rarity index (0-4)
  allow:                # opposite-direction exceptions (win on conflict)
    - Bloody Coil
```

For convenience the `default` / `allow` / `deny` keys may also be placed at the
top level instead of under `addons:`, but the nested `addons:` block is the
documented form.

## Resolution rules

The killer's full add-on list (from `public/NewAddons.json`) is the universe `U`.

1. **Seed**: `default: allow` → `allowed = U`; `default: deny` → `allowed = {}` (empty).
2. Apply each `deny` selector → remove matched add-ons from `allowed`.
3. Apply each `allow` selector → add matched add-ons (from `U`) to `allowed`.

**Precedence: `allow` is applied last and WINS on any conflict.**
If an add-on appears in both `deny` and `allow`, it ends up allowed.

## Selectors

Each item in `allow:` / `deny:` is one of:

| Form | Matches |
|------|---------|
| `"Add-on Name"` | A single add-on by name (case-insensitive; spaces/dashes/underscores/apostrophes/`&`/quotes folded) |
| `{ rarity: "Ultra Rare" }` | Every add-on of that rarity. Names: `Common`, `Uncommon`, `Rare`, `Very Rare`, `Ultra Rare` |
| `{ tier: 4 }` | Same as `rarity`, by numeric index `0`=Common … `4`=Ultra Rare |

**Hard errors** (non-zero exit): an unknown add-on name, an unknown rarity, or an
unknown killer — the message names the offending token and the input file.

## Output

One PNG file per killer into `<outDir>/` (plus one more with `--icons-only`, see below):
- `<KillerSlug>-killer-addons.png`

Add-ons are grouped into one labelled section per rarity, **in rarity order
Common → Ultra Rare**; empty rarities are skipped. Within a rarity, add-ons are
sorted alphabetically by name and wrap at `--columns` icons per row. Each icon is
composited over its rarity border (from
`utilities/addon-combine-tool/rarity-images/<index>.png`).

Header shows: killer portrait, killer name, `Allowed Killer Add-ons`,
`(N add-ons)`, and a provenance block with the `balancing` label (if set) and the
auto-stamped generation timestamp. When `count == 0` the header renders with a
"None allowed" note.

### Icon-only sheets (`--icons-only`)

When `--icons-only` is passed, one extra PNG per killer is written alongside the
regular sheet:
- `<KillerSlug>-killer-addons-icons.png`

This is a stripped-down variant meant for reuse/compositing elsewhere (embedded in a
post, a rules doc, a slide, or layered over another background) rather than as a
finished deliverable:

- Rarity sections stay stacked in the same order (Common → Ultra Rare), same
  add-ons, same alphabetical order within a section, same `--columns` wrapping —
  but with **no rarity labels** (and no left gutter reserved for them).
- No header (no portrait, title, `(N add-ons)` line, or provenance/`Generated:`/
  `Balancing:` block) — no text of any kind.
- Fully transparent background, unlike the regular sheet's opaque `#100f16`.
- Tight crop: no outer margin, and the width matches the largest rarity section's
  column count (capped at `--columns`) rather than the full `--columns` width.
- If there are zero allowed add-ons, the icon sheet is skipped entirely (no file
  written, just a log note) — there's no text-free equivalent of "None allowed".

## Preset compilation (`--preset`)

When `--preset <out.json>` is given, all input files are aggregated into a single
BbD balancing preset JSON. The shape matches what `ValidateCustomBalancing()`
expects:

```json
{
  "Name": "...",
  "Balancing": "DBDLeague",
  "GeneratedDate": "2026-06-20T14:32:00.000Z",
  "MaxPerkRepetition": 1,
  "GlobalNotes": "",
  "Tiers": [ { "Name": "General", ... } ],
  "KillerOverride": [ ... one entry per input file ... ]
}
```

Each `KillerOverride` entry has all required fields (copied from `DEBUG.json` as a
template so nothing is missing). Bans are computed by inversion of the allow-list:

- For any rarity where **every** add-on is denied, the rarity index is added to
  `AddonTiersBanned` (a compact whole-tier ban).
- Every other denied add-on is listed in `IndividualAddonBans` by its
  `globalID`.

All perk / item / offering fields are left as empty defaults.

## Asset paths

- Add-on art: derived from each add-on's `addonIcon` (a `public/…/*.webp` path),
  resolved to the PNG mirror under `canvas-image-library/PowerAddons/<Killer>/…`.
- Rarity borders: `utilities/addon-combine-tool/rarity-images/<0-4>.png`.
- Portrait: `canvas-image-library/Portraits/<basename>.png` (falls back to `Blank.png`).

Missing add-on art still renders its rarity border (or a grey placeholder if the
border is also absent) rather than crashing.

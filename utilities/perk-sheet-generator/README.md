# Perk Sheet Generator

A standalone CLI tool that reads a YAML file describing one killer's *allowed* perks
and produces two PNG "allowed perks" sheets (killer-side and survivor-side), plus an
optional BbD balancing-preset JSON when aggregating multiple killers.

## Quick start

```bash
# From the repo root:
npm i js-yaml   # one-time install

node utilities/perk-sheet-generator/perk-sheet-generator.js \
     utilities/perk-sheet-generator/examples/the-trapper.yaml \
     --out utilities/perk-sheet-generator/output \
     --preset utilities/perk-sheet-generator/output/test-preset.json
```

## CLI

```
node utilities/perk-sheet-generator/perk-sheet-generator.js <file.yaml...>
     [--out <dir>]        Output directory (default: next to each input file)
     [--columns <n>]      Grid columns (default: 8)
     [--preset <path>]    Also compile a BbD preset JSON from all input files
     [--name "<name>"]    Preset Name field (default: "Generated Allow-List")
```

## YAML schema

```yaml
killer: The Trapper     # Matched against Killers.json Name + Aliases (case-insensitive)

balancing: DBDLeague    # Optional. Label of the balancing ruleset these allow-lists
                        # come from. Rendered on both sheets and stored in the preset JSON.

# Optional. Restricts which perks are considered for each side.
# Default: every perk in dbdperks.json for that side.
# universe:
#   killer: all
#   survivor: all   # or a list of perk names

killerPerks:
  default: allow        # allow | deny — applied to the whole killer-side universe
  deny:                 # exceptions to the default
    - Bamboozle         # individual perk by name (alias-aware)
    - { exhaustion: true }   # group: every exhaustion perk (SURVIVOR side only — no killer exhaustion perks exist)
    - { tag: slowdown }      # group: every perk whose "tags" array contains "slowdown"
  allow: []             # opposite-direction exceptions

survivorPerks:
  default: deny
  allow:
    - Sprint Burst
    - Borrowed Time
    - { exhaustion: true }
  deny: []
```

## Resolution rules (applied independently per side)

1. **Universe** `U` = explicit list (if `universe.<side>` is set and is not `"all"`),
   else all perks in `dbdperks.json` whose `survivorPerk` matches the side.
2. **Seed**: `default: allow` → `allowed = U`; `default: deny` → `allowed = {}` (empty).
3. Apply each `deny` selector → remove matched perks from `allowed`.
4. Apply each `allow` selector → add matched perks (intersected with `U`) to `allowed`.

**Precedence: `allow` is applied last and WINS on any conflict.**
If a perk appears in both `deny` and `allow`, it ends up allowed.

## Selectors

Each item in `allow:` / `deny:` is one of:

| Form | Matches |
|------|---------|
| `"Perk Name"` | A single perk by its name or any alias (case-insensitive, spaces/dashes/underscores/apostrophes all folded) |
| `{ exhaustion: true }` | All perks in the side's universe that have `exhaustion: true` |
| `{ tag: "healing" }` | All perks in the side's universe whose `tags` array contains `"healing"` (case-insensitive). **Forward-looking — currently matches no perks** because every entry in `public/Perks/dbdperks.json` has an empty `tags` array. |

### Perk names with colons

Many DbD perks contain a colon in their name (e.g. "Boon: Circle of Healing",
"Teamwork: Power of Two", "Scourge Hook: Monstrous Shrine", "Hex: Ruin"). In YAML,
an unquoted list item like `- Boon: Circle of Healing` is parsed as a **mapping**
`{ "Boon": "Circle of Healing" }`, not a string — the colon makes it a key/value pair.

**Recommended form — always quote colon names:**

```yaml
deny:
  - "Boon: Circle of Healing"
  - "Hex: Ruin"
```

The tool also tolerates a single unquoted colon name by reconstructing `key: value`
back into the original perk name and looking it up automatically, so such entries will
still resolve correctly. However, quoting is the recommended, unambiguous form and
avoids any chance of misparse.

**Hard errors** (non-zero exit):
- An unknown perk name (no match after alias resolution) — the error message names the offending token and the input file.
- An unknown killer name.

## Output

Two PNG files per killer into `<outDir>/`:
- `<KillerSlug>-killer-perks.png`
- `<KillerSlug>-survivor-perks.png`

Perks are sorted **alphabetically by name**. Last row is left-aligned.

Header shows: killer portrait (thumbnail), a title, side label, `(N perks)`, and a
provenance block with the `balancing` label (if set) and the auto-stamped generation
timestamp. On the **survivor-side** sheet the title reads **"Going against: \<killer\>"**
(survivors bring these perks against that killer); the killer-side sheet shows the plain
killer name.
When `count == 0` the header still renders with a "None allowed" note.

## Preset compilation (`--preset`)

When `--preset <out.json>` is given, all input files are aggregated into a single
BbD balancing preset JSON. The shape matches what `ValidateCustomBalancing()` expects:

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

Each `KillerOverride` entry has all required fields (copied from `DEBUG.json` as a
template so nothing is missing). The ban arrays are computed by inversion:

- `KillerIndvPerkBans   = (killer universe) − (allowed killer perks)` as string IDs
- `SurvivorIndvPerkBans = (survivor universe) − (allowed survivor perks)` as string IDs

Addon/item/offering fields are left as empty defaults.

Top-level `Balancing` (from the first input file that sets it) and `GeneratedDate`
(ISO timestamp of when the run produced the output) are added for provenance. They are
extra metadata; `ValidateCustomBalancing()` ignores unrecognised top-level keys.

## Asset paths

PNGs are resolved from the repo's `canvas-image-library/` mirror tree:
- Perk: `canvas-image-library/Perks/{Killers,Survivors}/<basename>.png`
- Portrait: `canvas-image-library/Portraits/<basename>.png`

Missing assets fall back to `blank.png` / `Blank.png` rather than crashing.

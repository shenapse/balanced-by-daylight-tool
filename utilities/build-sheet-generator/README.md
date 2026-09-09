# Build Sheet Generator

A standalone CLI tool that reads a YAML file describing **specific builds** — what players
*actually brought* to a match — and renders them as a PNG sheet, one row per build.

This is the 4th sibling to `perk-sheet-generator`, `addon-sheet-generator`, and
`item-sheet-generator`. Those three all answer *"what are you allowed to bring?"* and render
allow-lists. This tool answers the complementary question and renders a concrete loadout: a
tournament organiser publishing the builds from a match, or a player registering theirs. It
shares no module with its siblings (each tool in this fork duplicates its own preamble) and has
no `--preset` compilation step — a concrete build has no allow-list to compile.

## Quick start

```bash
# From the repo root:
npm i js-yaml   # one-time install

node utilities/build-sheet-generator/build-sheet-generator.js \
     utilities/build-sheet-generator/examples/the-trapper-killer.yaml \
     utilities/build-sheet-generator/examples/the-trapper-survivors.yaml \
     --out utilities/build-sheet-generator/output \
     --rules sheetdata/examples/the-trapper.yaml
```

## CLI

```
node utilities/build-sheet-generator/build-sheet-generator.js <file.yaml...>
     [--asset-root <dir>]  Repo root used to resolve canvas-image-library/ assets
                           (default: DBD_BALANCING_TOOL_ROOT env var, else auto-detected)
     [--out <dir>]         Output directory (default: next to each input file)
     [--rules <file.yaml>] Validate the builds against an allow-list YAML
     [--icons-only]        Also write a text-free, transparent icon-strip PNG
```

There is deliberately no `--preset` or `--name`: those compile an allow-list preset, and a
concrete-build sheet has no allow-list to contribute — it is a report of what was picked, not a
policy. There is no `--columns` either: row width is fixed by the slot layout (4 perks + offering
+ optional item + 2 add-ons), it does not wrap.

## YAML schema

**One YAML file describes one side.** A top-level `builds:` key renders a killer sheet; a
top-level `survivors:` key renders a survivor sheet. A file with both, or neither, is a hard
error.

Killer side:

```yaml
killer: The Trapper           # required; matched against Killers.json Name + Aliases
balancing: DBDLeague          # optional; rendered as a second header line under the title
# title: "Grand Finals — Map 3"   # optional; overrides the default header title text

builds:                       # 1-4 rows, each an alternate loadout for this killer
  - perks:                    # 0-4; missing slots render blank.png
      - Corrupt Intervention
      - Dead Man's Switch      # denied by sheetdata/examples/the-trapper.yaml -> flagged by --rules
      - "Scourge Hook: Pain Resonance"   # names with a colon MUST be quoted in YAML
      - Bamboozle              # also denied there
    addons: [Trapper Bag, Bloody Coil]   # 0-2, from The Trapper's own pool in NewAddons.json
    offering: Ebony Memento Mori         # optional; from Offerings.json Killer[]

  - perks: [Lethal Pursuer, Discordance]   # only 2 -> 2 blank perk slots
    addons: [Honing Stone]                # only 1 -> 1 blank addon slot
    # no offering -> blank offering slot
```

Survivor side:

```yaml
killer: The Trapper           # OPTIONAL; drives the "Going against:" header + killer art
balancing: DBDLeague

survivors:                    # 1-4 rows, one loadout per survivor
  - perks: [Sprint Burst, Windows of Opportunity, Prove Thyself, Resilience]
    item: Sport Flashlight            # optional; an Items.json VARIANT name
    addons: [Wide Lens, Power Bulb]   # optional; add-ons of that item's Type
    offering: Shroud of Union         # optional; from Offerings.json Survivor[]

  - perks: [Adrenaline, Bond]
    # no item -> blank item slot; add-ons without an item is a hard error
```

A row's perks (0-4, no duplicates) and add-ons (0-2, no duplicates) are optional; unfilled slots
render the game's own empty-slot art rather than a gap or a placeholder box. `>4` rows, `>4`
perks in a row, or `>2` add-ons in a row are hard errors, independent of `--rules`.

## Name resolution

- **Perks are side-aware.** A killer perk named in a `survivors:` row (or vice versa) is a hard
  error distinct from "unknown name" — the message says which side the perk actually belongs to.
- **Killer add-ons resolve within the named killer's own pool** in `public/NewAddons.json` — add-on
  names are not globally unique across killers, so `killer:` is required on the killer side for
  this reason alone.
- **Item add-ons resolve within the row's `item:` Type**, not globally. `addons:` on a row with no
  `item:` is a hard error. Item add-on ids are also local per type (a Flashlight add-on `id: 0` is
  unrelated to a Med-Kit add-on `id: 0`), and `Firecracker` has zero add-ons — giving it any is an
  error.
- **Offerings resolve per side** against `public/Offerings.json`'s `Survivor[]` / `Killer[]`
  arrays. Eight names (the four Blueprints, the four Reagents) exist on *both* sides with the same
  numeric id, so a killer-side offering and a survivor-side offering of the same name are looked up
  independently — never merged.

**Hard errors** (non-zero exit, naming the offending token and file): an unknown killer, an
unknown or wrong-side perk, a duplicate perk or add-on within a row, an add-on not in the
resolving pool (killer's own add-ons, or the row's item's add-ons), `addons:` with no `item:`, an
unknown item variant or offering, more than 4 rows, more than 4 perks, or more than 2 add-ons in a
row, and a file with both `builds:` and `survivors:` (or neither).

## Output

- `<KillerSlug>-killer-builds.png` — killer file
- `<KillerSlug>-survivor-builds.png` — survivor file that names a `killer:`
- `<yaml-basename>-survivor-builds.png` — survivor file with no `killer:`
- `--icons-only` appends `-icons` before `.png` on any of the above

`KillerSlug` is `killer.Name` with spaces replaced by dashes (`The Trapper` → `The-Trapper`),
matching the siblings.

The canvas is a fixed 1280px wide; height is dynamic — 1-4 rows, plus the Violations section when
`--rules` finds anything. A 4-row survivor sheet with no `--rules` comes out exactly 1280×720.

This is the live site's own layout (`canvasGenerator.js:594`), not a bespoke one: a large
full-body killer render bleeds up the left edge of the row area at 80% opacity, drawn before the
rows so it sits behind them, and each build row is drawn on a translucent `#25233380` panel that
overlaps it. There is no small square portrait anymore.

The header is compact and two-line, on the left: `Playing as: <Killer>` on a killer sheet,
`Going against: <Killer>` on a survivor sheet that names a `killer:` (or just `Survivor Builds`
with no killer) — a YAML `title:` still overrides this whole line. A second line, `Balancing:
<name>`, appears only when `balancing:` is set. Top-right: `Image Date: <timestamp> UTC`, and —
only when `--rules` was passed — a status line below it, green `No violations found` or red `N
violations found`. There is no subtitle, no `(N builds)` count, and no `(N violations)` count;
the tool also does not render the live site's `balancedbydaylight.com` watermark or logo.

Below the header, one row per build: 4 perk icons, then the offering, then (survivor side only)
the item, then up to 2 add-ons, left to right. Killer rows use the same x positions as survivor
rows and simply leave the item column empty, so a killer sheet and a survivor sheet for the same
match line up column-for-column. Smaller icons are vertically centred against the tallest
(perk/offering) icons in the row rather than top- or bottom-aligned.

### Icon-only sheets (`--icons-only`)

- Just the row strip — same rows, same slot order and sizing, no header, no killer art, no
  panels, and no text of any kind.
- Fully transparent background, unlike the regular sheet's opaque `#100f16`.
- Tight crop: no outer margin; the canvas is exactly the rows' own bounding box.
- Empty slots still draw the game's `blank.png` art (it's art, not text, and dropping it would
  misalign the row), but the grey `#333333` placeholder used for a genuinely missing icon on the
  regular sheet is never drawn here — it would punch an opaque hole in the transparency.
- On a killer sheet, the empty item column is still there as an internal transparent gap in the
  strip — the price of sharing the survivor x-table for column alignment.
- Violation outlines (see below) are still drawn.

## Validation (`--rules`)

`--rules <file.yaml>` points at one of this fork's existing allow-list YAMLs (the same format
`perk-sheet-generator` / `addon-sheet-generator` / `item-sheet-generator` read) and checks each
build against it. Offending icons get a red (`#e5484d`) outline around the slot itself — not
traced around the art, since perk icons are diamonds on a transparent square and tracing the
diamond would look ragged next to the square icons — and a `Violations` section below the rows
lists every finding, prefixed by its row (`Build 2 ·` / `Survivor 3 ·`). The same list is printed
to stdout. **A violation is a finding to render, not a CLI error: the process still exits 0.**

Checked, because each is confined to a single build (one killer's loadout, or one survivor's):
individual perk allow/deny, killer add-on allow/deny, item-variant allow/deny, item add-on
allow/deny, `killerComboBans`, `killerPickLimits`, `survivorComboBans.survivor`, and
`survivorPickLimits` entries scoped `survivor`.

One deliberate suppression: a row's item add-ons are only checked when the item variant itself is
allowed. If the item is already banned, its add-ons are moot — the item ban is the actionable
finding, and reporting each of its add-ons as a second violation would outline half the row and
bury the root cause. An add-on on an *allowed* item is still checked normally.

**Not checked, deliberately:**
- **Duo/team-scoped rules** (`survivorComboBans.duo`/`.team`, `survivorRepetitionLimits`,
  `survivorPickLimits` with `scope: duo`/`team`, `itemDuplicateLimits`, `itemPickLimits`) — these
  span multiple rows, but a build sheet's rows are unlabelled loadouts with no pairing between
  them, and the schema has no `duo:`/`team:` grouping to check these rules against.
- **Offerings** — none of the allow-list formats in this fork have an offering section at all, so
  there is nothing to validate an offering pick against.

If the `--rules` file's `killer:` doesn't match the build file's, that's a hard error (not a
violation) — the power-add-on allow-list is per-killer, and validating against the wrong killer's
pool would be silently wrong rather than merely incomplete.

## Asset paths

Like its siblings, this tool reads from the repo's `canvas-image-library/` PNG mirror, never the
`.webp` assets under `public/` — node-canvas cannot read WebP.

- Perk: `canvas-image-library/Perks/{Killers,Survivors}/<basename>.png`
- Item variant / item add-on: `canvas-image-library/Items/<basename>.png`,
  `canvas-image-library/Addons/<basename>.png`
- Killer power add-on: resolved from the record's own `addonIcon` field, never built from the
  killer slug — `canvas-image-library/PowerAddons/` directories are named irregularly (`Trapper`,
  `GhostFace`, `SkullMerchant`, ...) and do not match the `The-Trapper` slug used for filenames.
- Offering: `canvas-image-library/Offerings/<basename>.png`
- Killer art: `canvas-image-library/lore/<basename>.png`, resolved from `Killers.json`'s
  `LorePortrait` field and matched case-insensitively — that field disagrees on case for one
  entry (`Ghostface.webp` vs. the file `GhostFace.png`). Unlike `Portraits/`, `lore/` has no
  `Blank.png` fallback: when nothing matches, the sheet simply renders without the art rather
  than crashing.
- Empty slots: `canvas-image-library/{Perks,Items,Addons,Offerings}/blank.png`
  (`Addons/blank.png` is shared by killer power add-ons and item add-ons alike)

`--asset-root <dir>` overrides the repo root these are resolved against (default: the
`DBD_BALANCING_TOOL_ROOT` env var, else auto-detected as two levels up from this script). It is
read once at module load — before the game-data JSON files are loaded — so a JSON load failure
can be traced back to a bad `--asset-root`. Missing individual icons fall back to the grey
`#333333` placeholder box on the regular sheet (never on the `--icons-only` variant) rather than
crashing the run.

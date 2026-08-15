# Perk Sheet Generator

A standalone CLI tool that reads a YAML file describing one killer's *allowed* perks
and produces two PNG "allowed perks" sheets (killer-side and survivor-side), plus an
optional BbD balancing-preset JSON when aggregating multiple killers, plus optional
text-free icon-grid PNGs with `--icons-only`.

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
     [--asset-root <dir>] Repo root used to resolve canvas-image-library/ assets
                          (default: DBD_BALANCING_TOOL_ROOT env var, else auto-detected)
     [--out <dir>]        Output directory (default: next to each input file)
     [--columns <n>]      Grid columns (default: 8)
     [--preset <path>]    Also compile a BbD preset JSON from all input files
     [--name "<name>"]    Preset Name field (default: "Generated Allow-List")
     [--icons-only]       Also write text-free, transparent icon-grid PNGs (see Output)
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

# Optional. Combination bans — perk PAIRINGS that are restricted even though each
# perk is individually allowed. IMAGE-ONLY: rendered on the sheets, never written
# to the --preset JSON (see below).
survivorComboBans:            # map keyed by scope (all keys optional)
  survivor:                   # one survivor may not bring both perks
    - [Prove Thyself, Botany Knowledge]
  duo:                        # neither duo may bring both between its two members
    - [Bond, Kindred]
  team:                       # if one survivor brings one, no other may bring the other
    - [Adrenaline, Sprint Burst]

killerComboBans:              # killer is one player → a flat list, single "build" scope
  - ["Scourge Hook: Pain Resonance", Pop Goes the Weasel]

# Optional. Repetition limits — cap how many survivors may each bring the SAME perk
# within a scope (survivor side only). IMAGE-ONLY, like combination bans.
survivorRepetitionLimits:     # a list of { scope, max, perks } rules
  - scope: duo                # duo | team
    max: 1                    # ≤ this many members may bring any covered perk
    perks: all                # "all"/omitted → every allowed perk
  - scope: team
    max: 2
    perks: [Self-Care, Botany Knowledge]   # a subset → cap applies per listed perk

# Optional. Pick limits — "pick at most N perks from this list". IMAGE-ONLY, both sides.
survivorPickLimits:           # a list of { scope, max, perks } rules
  - scope: duo                # survivor | duo | team
    max: 1                    # the group may bring ≤ this many perks from the list
    perks: [Sprint Burst, Lithe, Balanced Landing]   # 2+ perks to choose from (required)

killerPickLimits:             # killer is one player → { max, perks } (no scope)
  - max: 2
    perks: [Pop Goes the Weasel, Corrupt Intervention, Overcharge, Eruption]
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

## Combination bans

`survivorComboBans` / `killerComboBans` declare perk **pairings** that are
restricted even though each perk stays individually allowed (e.g. Bond and
Aftercare are both fine, but one survivor may not carry both).

- **`survivorComboBans`** is a map keyed by scope; all keys are optional:
  | Scope | Meaning |
  |-------|---------|
  | `survivor` | One survivor may not bring both perks. |
  | `duo` | The team is two duos A=(A1,A2), B=(B1,B2); neither duo may split the pair between its two members. A1+A2 is illegal; A1+B1 is fine. |
  | `team` | If any survivor brings one perk, no other survivor may bring the other. |
- **`killerComboBans`** is a flat list of combos (the killer is one player, so the
  only meaningful scope is the killer's own 4-perk build).
- Each combo is a **list of 2+ perk names**, resolved with the same alias-aware
  lookup as `allow`/`deny` (quote colon names). Group selectors
  (`{exhaustion:true}` / `{tag:…}`) are **not** allowed inside a combo.
- A combo naming a perk that is not in that side's allowed set emits a non-fatal
  **warning** (the combo is moot because the perk is already individually banned).

**Hard errors**: an unknown scope key under `survivorComboBans`, a combo with
fewer than 2 perks, or an unknown perk name.

> **Image-only.** Combination bans are rendered onto the sheets but are **not**
> written into the `--preset` JSON. The live checker only enforces
> *per-single-survivor* combos (`SurvivorComboPerkBans`) and has no duo/team
> concept, so those scopes would have no enforcement path; the sheet is the
> deliverable.

## Repetition limits

`survivorRepetitionLimits` caps how many members of a scoped group may each bring the
**same** perk. This is the complement of a combination ban: a combo ban restricts a set
of *different* perks appearing together, whereas a repetition limit restricts *copies of
one perk* across players. It is a scoped, subset-restricted generalization of the
preset's top-level `MaxPerkRepetition` (team-wide max copies of any single perk).

**Survivor side only** — the killer is one player, so "how many survivors bring it" is
meaningless there.

`survivorRepetitionLimits` is a **list of `{ scope, max, perks }` rule objects**:

| Field | Meaning |
|-------|---------|
| `scope` | `duo` or `team`. (A per-single-survivor scope is meaningless — one survivor cannot bring the same perk twice.) |
| `max` | Positive integer. Within each group of that scope, at most `max` members may bring any single covered perk. |
| `perks` | `all` / omitted → every allowed survivor perk. A **list of perk names** → the cap applies per-perk to each listed perk. Resolved with the same alias-aware lookup as `allow`/`deny` (quote colon names); group selectors (`{exhaustion}`/`{tag}`) are **not** allowed. |

Examples: `{ scope: duo, max: 1, perks: all }` — duo partners may not double up on any
perk. `{ scope: team, max: 2, perks: [Self-Care, Botany Knowledge] }` — each of those two
perks may be brought by at most two of the four survivors.

**Hard errors**: `survivorRepetitionLimits` that is not a list, an unknown `scope`, a
non-integer or `< 1` `max`, a group selector inside `perks`, or an unknown perk name.
**Non-fatal warnings**: a listed perk that is not in the allowed set (moot), or a `duo`
rule with `max ≥ 2` (vacuous — a duo has only two members).

> **Image-only.** Like combination bans, repetition limits are rendered onto the survivor
> sheet but are **not** written into the `--preset` JSON. The checker's only repetition
> surface is the top-level `MaxPerkRepetition`, which has no per-subset or duo/team concept.

## Pick limits

`survivorPickLimits` / `killerPickLimits` express **"pick at most N perks from this
list"** — within a scoped group, the members may bring at most `max` perks drawn from
the listed set in total.

- **`survivorPickLimits`** is a **list of `{ scope, max, perks }` rules**; `scope` is
  `survivor`, `duo`, or `team`.
- **`killerPickLimits`** is a **list of `{ max, perks }` rules** (the killer is one
  player, so the scope is implicitly the killer's own 4-perk build).
- `perks` is **required** and must be an explicit list of **2+ perk names** (you pick
  *from* a list), resolved with the same alias-aware lookup as `allow`/`deny` (quote
  colon names). Group selectors (`{exhaustion}`/`{tag}`) are **not** allowed.
- `max` is a positive integer.

Example: `{ scope: duo, max: 1, perks: [Sprint Burst, Lithe, Balanced Landing] }` — a duo
may bring at most one of those three exhaustion perks between its two members.

> **Distinct-pick nuance.** A pick limit counts *slots*, so `max: 2` over a duo is
> satisfied by two members both bringing the same listed perk. To additionally forbid
> that (require the picks to be *different* perks), pair the pick limit with a duplicate
> limit on the same subset (`survivorRepetitionLimits`, `max: 1`).

**Hard errors**: a list that is not a list, an unknown/omitted `scope` (survivor side), a
scope on a `killerPickLimits` entry, a non-integer or `< 1` `max`, `perks` missing or with
fewer than 2 names, a group selector inside `perks`, or an unknown perk name.
**Non-fatal warnings**: a listed perk not in the allowed set (moot).

> **Image-only.** Like the other limits, pick limits are rendered onto the sheets but are
> **not** written into the `--preset` JSON.

## Generalized perk-limit model (internal)

Combination bans, duplicate limits, and pick limits are all authoring **sugar** for one
internal model — a cap on how a scoped group may use a set of perks, `{ scope, count, max,
perks }`:

- `count: perPerk` → each perk in the set may be brought by at most `max` members of the
  group (the **duplicate** family).
- `count: total` → the group may bring at most `max` perks drawn from the set in total
  (the **pick / combo** family).

The model is never rendered directly. Each limit is **reduced** to exactly one concrete
render target:

| Render target | When |
|---------------|------|
| **Duplicate limit** | `count: perPerk` |
| **Combination ban** | `count: total`, explicit list, `max = (list length − 1)` — i.e. "not all of them together" |
| **Pick limit** | `count: total`, explicit list, `1 ≤ max < (list length − 1)` — i.e. "pick at most N" |
| *dropped (warned)* | `count: total` with `max ≥ list length` (vacuous) |

So a pick limit authored with `max = length − 1` renders under **Combination Bans**, and a
two-perk combo (`max 1`, 2 perks) is exactly the classic pairing ban. The sugar keys are
kept for convenient authoring.

## Output

Two PNG files per killer into `<outDir>/` (plus two more with `--icons-only`, see below):
- `<KillerSlug>-killer-perks.png`
- `<KillerSlug>-survivor-perks.png`

Perks are sorted **alphabetically by name**. Last row is left-aligned.

Header shows: killer portrait (thumbnail), a title, side label, `(N perks)`, and a
provenance block with the `balancing` label (if set) and the auto-stamped generation
timestamp. On the **survivor-side** sheet the title reads **"Going against: \<killer\>"**
(survivors bring these perks against that killer); the killer-side sheet shows the plain
killer name.
When `count == 0` the header still renders with a "None allowed" note.

Below the allowed-perk grid, up to three restriction sections are appended in a fixed
order — **Duplicate Limit → Pick Limits → Combination Bans** — each with a `(N …)` count
line stacked under the header:

- **Duplicate Limit** (survivor side only): each rule shows a scope chip, a plain-English
  rule line, and either an **"ALL PERKS"** pill (for `perks: all`) or the subset's perk
  icons.
- **Pick Limits**: each rule shows a scope chip, a plain-English rule line, and the listed
  perks' icons.
- **Combination Bans**: grouped by scope (each with a coloured chip and a plain-English
  rule line), every combo shown as its perk icons joined by a "+" with the perk name
  beneath.

(The section a given limit lands in is decided by the reduction described in
*Generalized perk-limit model* above — e.g. a pick limit whose `max` equals its list
length minus one appears under **Combination Bans**.)

### Icon-only sheets (`--icons-only`)

When `--icons-only` is passed, two extra PNGs per killer are written alongside the
regular sheets:
- `<KillerSlug>-killer-perks-icons.png`
- `<KillerSlug>-survivor-perks-icons.png`

These are a stripped-down variant meant for reuse/compositing elsewhere (embedded in a
post, a rules doc, a slide, or layered over another background) rather than as a
finished deliverable:

- Just the allowed-perk icon grid — same perks, same alphabetical order, same `--columns`
  count and icon size/gap geometry as the regular sheet, last row left-aligned.
- No header (no portrait, title, side label, `(N perks)` line, restriction counts, or
  provenance/`Generated:`/`Balancing:` block) and no restriction sections (Duplicate
  Limit, Pick Limits, Combination Bans) — no text of any kind.
- Fully transparent background, unlike the regular sheets' opaque `#100f16`.
- Tight crop: no outer margin, and the width matches the actual columns used (a list
  shorter than `--columns` is not padded to full width).
- If a side has zero allowed perks, its icon sheet is skipped entirely (no file written,
  just a log note) — there's no text-free equivalent of "None allowed".

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

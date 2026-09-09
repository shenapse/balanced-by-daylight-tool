![Balanced by Daylight Logo](public/iconography/Logo-Background.webp)
# Balanced by Daylight — Sheet Generation Fork

This repository is a **fork of the public [Balanced by Daylight](https://github.com/kylestarrtech/DBD-Balance-Checker) project** (a.k.a. DBD Balance Checker). Upstream is a hosted Node/Express web app for building Dead by Daylight loadouts and validating them against tournament-league balancing rulesets.

**This fork is used for a single purpose: generating rendered image files.** It produces "allowed perk / add-on / item" **sheets** (PNGs) for competitive DBD tournament balancing, plus optional balancing-preset JSON. It is **not** run as a hosted service. We simply borrow the upstream project's public game assets — icons, portraits, JSON data, and the `canvas-image-library/` PNG mirrors — as rendering inputs for these image tools.

## What this repo is for

Four standalone CLI **sheet generators** under `utilities/`. The first three each read a per-killer YAML *allow-list* and render a PNG sheet (and can optionally compile an aggregated Balanced-by-Daylight balancing-preset JSON); the fourth instead renders *specific builds* — what players actually brought, not what they were allowed to bring:

| Tool | Directory | Input | Output |
| ---- | --------- | ----- | ------ |
| Perk Sheet Generator | [`utilities/perk-sheet-generator/`](utilities/perk-sheet-generator/README.md) | Killer's allowed perks (YAML) | `<killer>-killer-perks.png`, `<killer>-survivor-perks.png` |
| Add-on Sheet Generator | [`utilities/addon-sheet-generator/`](utilities/addon-sheet-generator/README.md) | Killer's allowed power add-ons (YAML) | `<killer>-killer-addons.png` |
| Item Sheet Generator | [`utilities/item-sheet-generator/`](utilities/item-sheet-generator/README.md) | Killer's allowed survivor items + add-ons (YAML) | `<killer>-items.png` |
| Build Sheet Generator | [`utilities/build-sheet-generator/`](utilities/build-sheet-generator/README.md) | Specific killer or survivor builds actually played (YAML), optionally checked against an allow-list | `<killer>-killer-builds.png`, `<killer-or-file>-survivor-builds.png` |

Each tool has its own detailed `README.md` covering the YAML schema, selectors, limits, and preset compilation — linked in the table above.

The rendered PNGs are composited with [node-canvas](https://github.com/Automattic/node-canvas), which cannot read WebP. The live site's assets are `.webp` under `public/`, so the generators read from **`canvas-image-library/`** — a parallel PNG mirror of those assets (see `canvas-image-library/README.md`).

## Usage

A Node.js version of 18 or above is recommended.

```bash
# From the repo root:
npm i            # installs native build deps (canvas, sharp) — needs build tools
npm i js-yaml    # one-time install used by the sheet generators
```

Then run whichever generator you need, pointing it at a killer allow-list YAML. Each tool ships an example under its own `examples/` directory:

```bash
# Perk sheets (killer-side + survivor-side)
node utilities/perk-sheet-generator/perk-sheet-generator.js \
     utilities/perk-sheet-generator/examples/the-trapper.yaml \
     --out utilities/perk-sheet-generator/output \
     --preset utilities/perk-sheet-generator/output/test-preset.json

# Add-on sheet (killer power add-ons, grouped by rarity)
node utilities/addon-sheet-generator/addon-sheet-generator.js \
     utilities/addon-sheet-generator/examples/the-trapper.yaml \
     --out utilities/addon-sheet-generator/output

# Item sheet (allowed survivor items + their add-ons)
node utilities/item-sheet-generator/item-sheet-generator.js \
     utilities/item-sheet-generator/examples/the-trapper.yaml \
     --out utilities/item-sheet-generator/output

# Build sheets (specific killer/survivor loadouts actually played, optionally
# checked against an allow-list with --rules)
node utilities/build-sheet-generator/build-sheet-generator.js \
     utilities/build-sheet-generator/examples/the-trapper-killer.yaml \
     utilities/build-sheet-generator/examples/the-trapper-survivors.yaml \
     --out utilities/build-sheet-generator/output \
     --rules sheetdata/examples/the-trapper.yaml
```

Common flags: `--out <dir>` (output directory), `--asset-root <dir>` (repo root used to resolve assets), `--icons-only` (also write a text-free, transparent variant). The three allow-list tools additionally take `--preset <path>` (also compile a BbD preset JSON) and `--name "<name>"` (preset `Name` field); the Build Sheet Generator has neither, and takes `--rules <path>` instead. See each tool's README for the full flag list.

## Relationship to the upstream web app

This repo still contains the full upstream codebase, but for our purposes it is **inherited code we don't run**: the Express server (`server.js`), the autobalancer, the OCR image-extractor, and the multiplayer machinery are all part of the original hosted web app, not the sheet-generation workflow.

If you actually want the Balanced by Daylight **web app** (build creator, live balance checker, share-as-image), use the [original repository](https://github.com/kylestarrtech/DBD-Balance-Checker) instead.

## Credit

The original Balanced by Daylight project — and the game-asset library this fork borrows — is by **Kyle Starr (shaders)**. For the upstream project, its community, and updates:

- Original repository: <https://github.com/kylestarrtech/DBD-Balance-Checker>
- Discord Server: <https://discord.gg/E6zfpwvCce>
- Twitter: [@SHADERSOP](https://twitter.com/SHADERSOP) · Discord: `shaders`

All Dead by Daylight assets are property of Behaviour Interactive.

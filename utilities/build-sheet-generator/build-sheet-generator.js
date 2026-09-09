#!/usr/bin/env node
'use strict';

/**
 * build-sheet-generator.js
 *
 * Reads a YAML file describing SPECIFIC builds (what players actually brought),
 * not an allow-list, and renders them as a flat icon-row PNG sheet — one row per
 * build. This is the 4th sibling to perk-sheet-generator / addon-sheet-generator /
 * item-sheet-generator, sharing their visual language and CLI conventions, but no
 * module (each tool in this fork duplicates its own preamble; this one is no
 * exception — do not refactor the other three to share code with it).
 *
 * A killer file (`killer:` + `builds:`) renders up to 4 alternate loadouts for one
 * killer: 4 perks + 1 offering + 2 power add-ons per row.
 * A survivor file (`survivors:`, `killer:` optional) renders up to 4 loadouts, one
 * per survivor: 4 perks + 1 offering + 1 item + up to 2 item add-ons per row.
 *
 * Usage:
 *   node utilities/build-sheet-generator/build-sheet-generator.js <file.yaml...>
 *        [--asset-root <dir>] [--out <dir>] [--rules <file.yaml>] [--icons-only]
 *
 * Sheets are written next to each input file by default; --out overrides this.
 * --icons-only additionally renders a text-free, transparent-background, tightly
 * cropped icon-strip variant of each sheet (see renderIconSheet).
 *
 * --rules <allow-list.yaml> validates every rendered build against an EXISTING
 * allow-list YAML (the same format perk-sheet-generator / addon-sheet-generator /
 * item-sheet-generator consume) and flags illegal picks: individual perk/add-on/
 * item bans, plus combo bans and pick limits that are scoped to a single build
 * (killerComboBans, killerPickLimits, survivorComboBans.survivor,
 * survivorPickLimits with scope: survivor). duo/team-scoped rules and offerings
 * are intentionally out of scope — see validateRow() below. A violation is a
 * finding to render (red outline + a "Violations" section), not a CLI error —
 * the process still exits 0.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createCanvas, loadImage } = require('canvas');

function readOption(argv, flag) {
    const index = argv.indexOf(flag);
    if (index === -1 || !argv[index + 1]) return null;
    return argv[index + 1];
}

// ---------------------------------------------------------------------------
// Paths relative to the REPO ROOT (two levels up from __dirname)
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(
    readOption(process.argv.slice(2), '--asset-root') ||
    process.env.DBD_BALANCING_TOOL_ROOT ||
    path.join(__dirname, '..', '..')
);
const PERKS_FILE     = path.join(REPO_ROOT, 'public', 'Perks', 'dbdperks.json');
const KILLERS_FILE   = path.join(REPO_ROOT, 'public', 'Killers.json');
const ADDONS_FILE    = path.join(REPO_ROOT, 'public', 'NewAddons.json');
const ITEMS_FILE     = path.join(REPO_ROOT, 'public', 'Items.json');
const OFFERINGS_FILE = path.join(REPO_ROOT, 'public', 'Offerings.json');

const PNG_LIBRARY    = path.join(REPO_ROOT, 'canvas-image-library');
const PNG_PERKS_BASE = path.join(PNG_LIBRARY, 'Perks');
const PNG_ITEMS      = path.join(PNG_LIBRARY, 'Items');
const PNG_ADDONS     = path.join(PNG_LIBRARY, 'Addons');
const PNG_OFFERINGS  = path.join(PNG_LIBRARY, 'Offerings');
const PNG_LORE       = path.join(PNG_LIBRARY, 'lore');

// Empty-slot art. `Addons/blank.png` is shared by killer power add-ons AND item
// add-ons — exactly what canvasGenerator.js:542 does upstream.
const BLANK_PERK     = path.join(PNG_PERKS_BASE, 'blank.png');
const BLANK_ITEM     = path.join(PNG_ITEMS, 'blank.png');
const BLANK_ADDON    = path.join(PNG_ADDONS, 'blank.png');
const BLANK_OFFERING = path.join(PNG_OFFERINGS, 'blank.png');

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
// Row order left -> right: 4 perks | offering | (item, survivor only) | 2 add-ons.
// Every number below is lifted from canvasGenerator.js:601-602, 726-733, 740-750,
// 772-911 (GenerateSurvivorImage) — this tool reproduces that renderer's sample
// look (large killer art + translucent per-build panels) rather than the flat
// icon-row style its perk-/addon-/item-sheet-generator siblings use.
const PERK     = 118;
const OFFERING = 118;
const ITEM     = 88;
const ADDON    = 68;
const CANVAS_W      = 1280;   // fixed; height stays dynamic (rows + optional Violations section)
const HEADER_H      = 110;    // canvasGenerator: first panel at height-600-10 = 110
const PANEL_X       = 270;    // = CANVAS_W - PANEL_W - 10
const PANEL_W       = 1000;
const PANEL_H       = 138;
const PANEL_GAP     = 15;     // upstream padding 5 + margin 10 -> 153px pitch
const PANEL_COLOR   = '#25233380';
const BOTTOM_MARGIN = 13;     // makes a 4-row, rules-free survivor sheet exactly 1280x720
const LORE_W        = 384;
const LORE_H        = 761;
const LORE_ALPHA    = 0.8;
const MARGIN    = 32;   // the Violations section's inset only (rows use the x-table below)
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';
const VIOLATION_COLOR = '#e5484d';

// --rules: the "Violations" section rendered below the rows, styled like the
// siblings' limit sections (item-sheet-generator.js:683-702).
const SECTION_GAP   = 28;  // gap between the rows and the Violations divider
const VIOL_LINE_H   = 26;  // px per violation text line (wrapped lines stack at this step)
const VIOL_MARKER   = 20;  // px, the little red square marking each violation line
const VIOL_MARKER_GAP = 12; // gap between the marker and the violation text

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
const allPerks       = JSON.parse(fs.readFileSync(PERKS_FILE, 'utf8'));
const allKillers      = JSON.parse(fs.readFileSync(KILLERS_FILE, 'utf8'));
const allAddonEntries = JSON.parse(fs.readFileSync(ADDONS_FILE, 'utf8'));
const itemsData       = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));
const offeringsData   = JSON.parse(fs.readFileSync(OFFERINGS_FILE, 'utf8'));

const ITEM_TYPES    = itemsData.ItemTypes;  // [{ Name, Addons:[{id,Name,icon,Rarity}] }]
const ITEM_VARIANTS = itemsData.Items;      // [{ id, Name, Type, icon, Rarity }]

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------
// Widest of the three siblings' regexes (addon-sheet-generator.js:84-87), so item
// and add-on names with "&" / quotes fold correctly too. Verified to produce zero
// new collisions across every dataset this tool reads.
function normalize(str) {
    return String(str)
        .toLowerCase()
        .replace(/[\s\-_'.&"]+/g, '');
}

/**
 * Build a lookup map: normalized name/alias -> perk object.
 * Copied verbatim from perk-sheet-generator.js (perk-sheet-generator.js:121-138).
 */
function buildPerkLookup(perks) {
    const map = new Map();
    for (const p of perks) {
        const norm = normalize(p.name);
        if (!map.has(norm)) map.set(norm, p);
        // aliases can be a string (comma-separated) or an array
        if (p.aliases) {
            const aliasList = Array.isArray(p.aliases)
                ? p.aliases
                : String(p.aliases).split(',');
            for (const a of aliasList) {
                const na = normalize(a.trim());
                if (na && !map.has(na)) map.set(na, p);
            }
        }
    }
    return map;
}

/**
 * Copied verbatim from perk-sheet-generator.js (:140-152), INCLUDING its
 * alias-clobbering behaviour (Yamaoka / PHead / Vecna each map to two killers,
 * last wins). Kept as-is so this tool resolves those aliases identically to its
 * three siblings rather than drifting.
 */
function buildKillerLookup(killers) {
    const map = new Map();
    for (const k of killers) {
        map.set(normalize(k.Name), k);
        if (k.Aliases) {
            const aliasList = Array.isArray(k.Aliases) ? k.Aliases : [k.Aliases];
            for (const a of aliasList) {
                const na = normalize(a);
                if (na) map.set(na, k);
            }
        }
    }
    return map;
}

/** Generic normalized-Name -> object lookup, for records shaped { Name, ... }. */
function buildNameLookup(list) {
    const map = new Map();
    for (const o of list) {
        const n = normalize(o.Name);
        if (!map.has(n)) map.set(n, o);
    }
    return map;
}

/**
 * Offerings.json uses lowercase `name`/`icon` (like dbdperks.json), NOT `Name` —
 * so buildNameLookup can't be reused unmodified.
 */
function buildOfferingLookup(list) {
    const map = new Map();
    for (const o of list) {
        const n = normalize(o.name);
        if (!map.has(n)) map.set(n, o);
    }
    return map;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
const killerLookup = buildKillerLookup(allKillers);

const survivorPerksArr = allPerks.filter(p => p.survivorPerk === true);
const killerPerksArr   = allPerks.filter(p => p.survivorPerk === false);
const survivorPerkLookup = buildPerkLookup(survivorPerksArr);
const killerPerkLookup   = buildPerkLookup(killerPerksArr);

// Killer power add-ons: Map normalized killer Name -> that killer's Addons[]
// (add-on names are not globally unique across killers, so this must stay
// per-killer; never build the icon path from the killer slug either — see
// addonIconPng below).
const addonsByKiller = new Map();
for (const k of allAddonEntries) addonsByKiller.set(normalize(k.Name), k.Addons || []);

// Item types + variants. Items.json `Items[]` are VARIANTS (only these are
// acceptable as a row's `item:`); `ItemTypes[].Addons[]` are the per-type add-on
// pools a row's `addons:` must resolve within.
const typeByName    = new Map(ITEM_TYPES.map(t => [normalize(t.Name), t]));
const variantByName = buildNameLookup(ITEM_VARIANTS);

// Offerings are side-aware and MUST be indexed per side — 8 names (four
// Blueprints, four Reagents) appear on both sides with the SAME numeric `id`, so
// merging the arrays or keying by id alone would silently cross-wire them.
const survivorOfferingLookup = buildOfferingLookup(offeringsData.Survivor);
const killerOfferingLookup   = buildOfferingLookup(offeringsData.Killer);

// ---------------------------------------------------------------------------
// --rules: allow-list resolution
// ---------------------------------------------------------------------------
// This tool has no module shared with its three siblings (each duplicates its own
// preamble; see the file's doc comment), so the resolvers below are copied
// verbatim from perk-sheet-generator.js / addon-sheet-generator.js /
// item-sheet-generator.js rather than imported. They only ever read `allPerks`,
// `buildPerkLookup`, `buildNameLookup`, `normalize` and `fatal`, all already
// defined above/below in this same file.

// Fixed scope order for the survivor side (matches the increasing strictness).
// Copied from perk-sheet-generator.js:80-83. Only the "survivor" scope is ever
// actually acted on by this tool (see resolveRulesContext / validateRow) — duo
// and team span rows, and unlabelled build rows carry no pairing — but the
// resolvers below still need the full list to validate the YAML's scope keys.
const SURVIVOR_COMBO_SCOPES = ['survivor', 'duo', 'team'];
const PICK_SURVIVOR_SCOPES  = ['survivor', 'duo', 'team'];

// Two separate rarity tables (perk-sheet-generator.js has none; these mirror
// addon-sheet-generator.js:56 and item-sheet-generator.js:55). NewAddons.json
// (killer power add-ons) only goes to index 4; Items.json goes to 5 ("Event").
// Keeping them as two arrays, never merged, is what keeps `{rarity: "Event"}` in
// an `items:` block from being wrongly rejected.
const ADDON_RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Ultra Rare'];
const ITEM_RARITY_NAMES  = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Ultra Rare', 'Event'];

function rarityToIndex(names, value, filePath) {
    if (typeof value === 'number') {
        if (value >= 0 && value < names.length) return value;
        fatal(`Rarity index ${value} out of range (0-${names.length - 1}) in "${filePath}".`);
    }
    const norm = normalize(value);
    const idx = names.findIndex(n => normalize(n) === norm);
    if (idx === -1) {
        fatal(`Unknown rarity "${value}" in "${filePath}". Expected one of: ${names.join(', ')}.`);
    }
    return idx;
}

// --- Perk selector + allow-list resolution --------------------------------
// Copied verbatim from perk-sheet-generator.js:216-325 (matchSelector / resolveSide).
function matchSelector(selector, universe, lookup, filePath) {
    if (typeof selector === 'string') {
        const norm = normalize(selector);
        const perk = lookup.get(norm);
        if (!perk) {
            fatal(
                `Unknown perk name "${selector}" in file "${filePath}". ` +
                `No matching perk found on this side.`
            );
        }
        return [perk];
    }
    if (typeof selector === 'object' && selector !== null) {
        if (selector.exhaustion === true) {
            return universe.filter(p => p.exhaustion === true);
        }
        if (typeof selector.tag === 'string') {
            const tag = selector.tag.toLowerCase();
            return universe.filter(p =>
                Array.isArray(p.tags) && p.tags.some(t => t.toLowerCase() === tag)
            );
        }
        // Handle an unquoted colon perk name: YAML parses `- Boon: Circle of Healing`
        // as the object { "Boon": "Circle of Healing" } instead of a string.
        const ownKeys = Object.keys(selector);
        if (ownKeys.length === 1) {
            const key   = ownKeys[0];
            const value = selector[key];
            const reconstructed = `${key}: ${value}`;
            const norm = normalize(reconstructed);
            const perk = lookup.get(norm);
            if (perk) {
                return [perk];
            }
            fatal(
                `Unknown perk name "${reconstructed}" in file "${filePath}". ` +
                `No matching perk found on this side. ` +
                `If this is a perk name containing a colon, wrap it in quotes in the YAML ` +
                `(e.g. "Boon: Circle of Healing").`
            );
        }
        fatal(
            `Unknown group selector ${JSON.stringify(selector)} in file "${filePath}". ` +
            `Only { exhaustion: true } and { tag: "<name>" } are supported.`
        );
    }
    fatal(`Invalid selector value ${JSON.stringify(selector)} in file "${filePath}".`);
}

function resolveSide(sideConfig, universeDecl, isSurvivor, filePath) {
    const sideAll = allPerks.filter(p => p.survivorPerk === isSurvivor);
    let universe;
    if (!universeDecl || universeDecl === 'all') {
        universe = sideAll;
    } else if (Array.isArray(universeDecl)) {
        const lookup = buildPerkLookup(sideAll);
        universe = universeDecl.map(name => {
            const p = lookup.get(normalize(name));
            if (!p) fatal(`Unknown perk "${name}" in universe list in file "${filePath}".`);
            return p;
        });
    } else {
        fatal(`Invalid universe declaration in file "${filePath}".`);
    }

    const lookup = buildPerkLookup(universe);

    const defaultVal = (sideConfig && sideConfig.default) || 'allow';
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" in file "${filePath}".`);
    }
    let allowed = new Map();
    if (defaultVal === 'allow') {
        for (const p of universe) allowed.set(p.id, p);
    }

    const denyList = (sideConfig && sideConfig.deny) || [];
    for (const sel of denyList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const p of matched) allowed.delete(p.id);
    }

    const allowList = (sideConfig && sideConfig.allow) || [];
    for (const sel of allowList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const p of matched) allowed.set(p.id, p);
    }

    return [...allowed.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Copied verbatim from perk-sheet-generator.js:346-427 (resolveComboBans), minus
// the moot-combo console.warn (this tool has no "allowed perks" render step to
// warn against — a moot combo here is simply never trippable, which is fine).
function resolveComboBans(comboConfig, isSurvivor, filePath) {
    if (comboConfig == null) return [];

    const sideAll = allPerks.filter(p => p.survivorPerk === isSurvivor);
    const lookup  = buildPerkLookup(sideAll);

    const out = [];

    const resolveOneCombo = (entry, scope) => {
        if (!Array.isArray(entry)) {
            fatal(
                `Combo ban entry (scope "${scope}") in file "${filePath}" must be a list of ` +
                `perk names, got ${JSON.stringify(entry)}.`
            );
        }
        const perks = entry.map(sel => {
            if (sel && typeof sel === 'object' &&
                (sel.exhaustion === true || typeof sel.tag === 'string')) {
                fatal(
                    `Group selectors ({ exhaustion } / { tag }) are not allowed inside a combo ` +
                    `ban (scope "${scope}") in file "${filePath}".`
                );
            }
            return matchSelector(sel, sideAll, lookup, filePath)[0];
        });
        if (perks.length < 2) {
            fatal(
                `Combo ban (scope "${scope}") in file "${filePath}" needs at least 2 perks, ` +
                `got ${perks.length}: ${JSON.stringify(entry)}.`
            );
        }
        out.push({ scope, perks });
    };

    if (isSurvivor) {
        if (typeof comboConfig !== 'object' || Array.isArray(comboConfig)) {
            fatal(
                `"survivorComboBans" must be a map keyed by scope ` +
                `(${SURVIVOR_COMBO_SCOPES.join(' / ')}) in file "${filePath}".`
            );
        }
        for (const key of Object.keys(comboConfig)) {
            if (!SURVIVOR_COMBO_SCOPES.includes(key)) {
                fatal(
                    `Unknown survivor combo-ban scope "${key}" in file "${filePath}". ` +
                    `Valid scopes: ${SURVIVOR_COMBO_SCOPES.join(', ')}.`
                );
            }
        }
        for (const scope of SURVIVOR_COMBO_SCOPES) {
            const list = comboConfig[scope];
            if (list == null) continue;
            if (!Array.isArray(list)) {
                fatal(`Survivor combo-ban scope "${scope}" must be a list in file "${filePath}".`);
            }
            for (const entry of list) resolveOneCombo(entry, scope);
        }
    } else {
        if (!Array.isArray(comboConfig)) {
            fatal(`"killerComboBans" must be a list of perk-name lists in file "${filePath}".`);
        }
        for (const entry of comboConfig) resolveOneCombo(entry, 'build');
    }

    return out;
}

// Copied verbatim from perk-sheet-generator.js:551-638 (resolvePickLimits), minus
// the moot-perk console.warn (same reasoning as resolveComboBans above).
function resolvePickLimits(config, isSurvivor, filePath) {
    if (config == null) return [];

    const label = isSurvivor ? 'survivorPickLimits' : 'killerPickLimits';
    const shape = isSurvivor ? '{ scope, max, perks }' : '{ max, perks }';
    if (!Array.isArray(config)) {
        fatal(`"${label}" must be a list of ${shape} objects in file "${filePath}".`);
    }

    const sideAll = allPerks.filter(p => p.survivorPerk === isSurvivor);
    const lookup  = buildPerkLookup(sideAll);

    const out = [];

    for (const entry of config) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            fatal(`Each "${label}" entry must be a ${shape} object in file "${filePath}", got ${JSON.stringify(entry)}.`);
        }

        let scope;
        if (isSurvivor) {
            scope = entry.scope;
            if (!PICK_SURVIVOR_SCOPES.includes(scope)) {
                fatal(
                    `Invalid pick-limit scope ${JSON.stringify(scope)} in file "${filePath}". ` +
                    `Valid scopes: ${PICK_SURVIVOR_SCOPES.join(', ')}.`
                );
            }
        } else {
            if (entry.scope !== undefined && entry.scope !== 'killer' && entry.scope !== 'build') {
                fatal(
                    `"killerPickLimits" entries take no scope (the killer is a single build); ` +
                    `got scope ${JSON.stringify(entry.scope)} in file "${filePath}".`
                );
            }
            scope = 'build';
        }

        const max = entry.max;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
            fatal(
                `Pick-limit "max" (scope "${scope}") must be a positive integer in ` +
                `file "${filePath}", got ${JSON.stringify(max)}.`
            );
        }

        const perksDecl = entry.perks;
        if (!Array.isArray(perksDecl)) {
            fatal(
                `Pick-limit "perks" (scope "${scope}") must be a list of perk names in ` +
                `file "${filePath}", got ${JSON.stringify(perksDecl)}.`
            );
        }
        const perks = perksDecl.map(sel => {
            if (sel && typeof sel === 'object' &&
                (sel.exhaustion === true || typeof sel.tag === 'string')) {
                fatal(
                    `Group selectors ({ exhaustion } / { tag }) are not allowed inside a ` +
                    `pick limit (scope "${scope}") in file "${filePath}".`
                );
            }
            return matchSelector(sel, sideAll, lookup, filePath)[0];
        });
        if (perks.length < 2) {
            fatal(
                `Pick limit (scope "${scope}") in file "${filePath}" needs at least 2 perks to ` +
                `choose from, got ${perks.length}: ${JSON.stringify(perksDecl)}.`
            );
        }

        out.push({ scope, max, perks });
    }

    return out;
}

// --- Killer power add-on selector + allow-list resolution ------------------
// Copied verbatim from addon-sheet-generator.js:190-256 (matchSelector /
// resolveAllowList for add-ons), renamed to avoid colliding with the perk
// resolver above. Uses `addon.globalID` as the identity key, matching how
// addonsByKiller's records are already keyed everywhere else in this file.
function matchAddonSelector(selector, universe, lookup, filePath) {
    if (typeof selector === 'string') {
        const norm = normalize(selector);
        const addon = lookup.get(norm);
        if (!addon) {
            fatal(`Unknown add-on name "${selector}" in file "${filePath}".`);
        }
        return [addon];
    }
    if (typeof selector === 'object' && selector !== null) {
        if (selector.rarity !== undefined) {
            const idx = rarityToIndex(ADDON_RARITY_NAMES, selector.rarity, filePath);
            return universe.filter(a => a.Rarity === idx);
        }
        if (selector.tier !== undefined) {
            const idx = rarityToIndex(ADDON_RARITY_NAMES, selector.tier, filePath);
            return universe.filter(a => a.Rarity === idx);
        }
        fatal(
            `Unknown group selector ${JSON.stringify(selector)} in file "${filePath}". ` +
            `Only { rarity: "<name>" } and { tier: <0-4> } are supported.`
        );
    }
    fatal(`Invalid selector value ${JSON.stringify(selector)} in file "${filePath}".`);
}

function resolveAddonAllowList(cfg, universe, filePath) {
    const lookup = new Map();
    for (const a of universe) {
        const n = normalize(a.Name);
        if (!lookup.has(n)) lookup.set(n, a);
    }

    const defaultVal = (cfg && cfg.default) || 'deny';
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" in file "${filePath}".`);
    }
    let allowed = new Map();
    if (defaultVal === 'allow') {
        for (const a of universe) allowed.set(a.globalID, a);
    }

    const denyList = (cfg && cfg.deny) || [];
    for (const sel of denyList) {
        for (const a of matchAddonSelector(sel, universe, lookup, filePath)) allowed.delete(a.globalID);
    }

    const allowList = (cfg && cfg.allow) || [];
    for (const sel of allowList) {
        for (const a of matchAddonSelector(sel, universe, lookup, filePath)) allowed.set(a.globalID, a);
    }

    return [...allowed.values()];
}

// --- Item variant / item add-on allow-list resolution -----------------------
// Copied verbatim from item-sheet-generator.js:225-266 (resolveAllowList). Reuses
// buildNameLookup (already defined above) since item variants and per-type
// add-ons are both shaped { id, Name, ... }.
function resolveItemAllowList(cfg, universe, fallbackDefault, label, filePath) {
    const lookup = buildNameLookup(universe);

    const defaultVal = (cfg && cfg.default) || fallbackDefault;
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" (${label}) in file "${filePath}".`);
    }

    const allowed = new Map();
    if (defaultVal === 'allow') {
        for (const e of universe) allowed.set(e.id, e);
    }

    const resolveSels = (sel) => {
        if (typeof sel === 'string') {
            const e = lookup.get(normalize(sel));
            if (!e) fatal(`Unknown ${label} "${sel}" in file "${filePath}".`);
            return [e];
        }
        if (typeof sel === 'object' && sel !== null && sel.rarity !== undefined) {
            const idx = rarityToIndex(ITEM_RARITY_NAMES, sel.rarity, filePath);
            return universe.filter(a => a.Rarity === idx);
        }
        fatal(
            `Invalid ${label} selector ${JSON.stringify(sel)} in file "${filePath}". ` +
            `Expected a plain name string or a {rarity: ...} object.`
        );
    };

    for (const sel of (cfg && cfg.deny) || []) {
        for (const e of resolveSels(sel)) allowed.delete(e.id);
    }
    for (const sel of (cfg && cfg.allow) || []) {
        for (const e of resolveSels(sel)) allowed.set(e.id, e);
    }

    return [...allowed.values()];
}

/**
 * Parse + resolve an entire --rules file into the sets/lists validateRow() needs.
 * Perks, items and their add-ons are killer-independent and resolved once here;
 * killer power add-ons are resolved against the rules file's OWN killer (checked
 * against each build model's killer in validateModel — see the doc comment there
 * for why a mismatch is fatal rather than silently skipped).
 */
function loadRulesContext(rulesPath) {
    const absRulesPath = path.resolve(rulesPath);
    let raw;
    try {
        raw = fs.readFileSync(absRulesPath, 'utf8');
    } catch (e) {
        fatal(`Cannot read rules file "${absRulesPath}": ${e.message}`);
    }
    let doc;
    try {
        doc = yaml.load(raw);
    } catch (e) {
        fatal(`YAML parse error in rules file "${absRulesPath}": ${e.message}`);
    }
    if (!doc || typeof doc !== 'object') {
        fatal(`Rules file "${absRulesPath}" does not contain a YAML object.`);
    }

    let rulesKiller = null;
    if (doc.killer != null) {
        rulesKiller = killerLookup.get(normalize(doc.killer));
        if (!rulesKiller) {
            fatal(
                `Unknown killer "${doc.killer}" in rules file "${absRulesPath}". ` +
                `No matching entry in Killers.json.`
            );
        }
    }

    // Perks (side-aware individual allow/deny + the single-build limit families).
    const allowedKillerPerks   = resolveSide(doc.killerPerks, undefined, false, absRulesPath);
    const allowedSurvivorPerks = resolveSide(doc.survivorPerks, undefined, true, absRulesPath);
    const allowedKillerPerkIds   = new Set(allowedKillerPerks.map(p => p.id));
    const allowedSurvivorPerkIds = new Set(allowedSurvivorPerks.map(p => p.id));

    // Combo bans: killerComboBans carries no scope (normalised to 'build' above);
    // survivorComboBans is scope-keyed — only its 'survivor' scope is in bounds
    // (duo/team span rows, which this tool's unlabelled build rows can't express).
    const killerCombos = resolveComboBans(doc.killerComboBans, false, absRulesPath);
    const survivorCombosAll = resolveComboBans(doc.survivorComboBans, true, absRulesPath);
    const survivorCombosBuild = survivorCombosAll.filter(c => c.scope === 'survivor');

    // Pick limits: same in-scope/out-of-scope split as combo bans.
    const killerPickLimits = resolvePickLimits(doc.killerPickLimits, false, absRulesPath);
    const survivorPickLimitsAll = resolvePickLimits(doc.survivorPickLimits, true, absRulesPath);
    const survivorPickLimitsBuild = survivorPickLimitsAll.filter(l => l.scope === 'survivor');

    // Killer power add-ons: only resolvable when the rules file names a killer.
    // The actual per-model killer-match check happens in validateModel().
    let allowedKillerAddonIds = null;
    if (rulesKiller) {
        const universe = addonsByKiller.get(normalize(rulesKiller.Name)) || [];
        // Mirrors addon-sheet-generator.js's processFile fallback: `addons:` if
        // present, else the top-level default/allow/deny block.
        const cfg = doc.addons || { default: doc.default, allow: doc.allow, deny: doc.deny };
        const allowedAddons = resolveAddonAllowList(cfg, universe, absRulesPath);
        allowedKillerAddonIds = new Set(allowedAddons.map(a => a.globalID));
    }

    // Items: per-type variant + add-on allow-lists. Add-on `id` is LOCAL per type
    // (Flashlight add-on 0 !== Med-Kit add-on 0), so this MUST stay a
    // Map<typeName, Set<id>>, never a flat Set — see the doc comment on
    // allowedItemAddonsByType below.
    const topDefault = doc.default || 'deny';
    const itemsCfg = doc.items || {};
    for (const key of Object.keys(itemsCfg)) {
        if (!typeByName.has(normalize(key))) {
            fatal(`Unknown item type "${key}" in rules file "${absRulesPath}".`);
        }
    }

    const allowedItemVariantIds = new Set();
    // typeName (normalized) -> Set<local add-on id>. Never flatten this into a
    // single Set: item add-on ids collide across types by design.
    const allowedItemAddonsByType = new Map();
    for (const type of ITEM_TYPES) {
        let typeCfg;
        for (const [key, val] of Object.entries(itemsCfg)) {
            if (normalize(key) === normalize(type.Name)) { typeCfg = val; break; }
        }

        const variantUniverse = ITEM_VARIANTS.filter(v => v.Type === type.Name);
        const typeDefault = (typeCfg && typeCfg.default) || topDefault;

        const allowedVariants = resolveItemAllowList(
            typeCfg, variantUniverse, topDefault, `${type.Name} variant`, absRulesPath
        );
        for (const v of allowedVariants) allowedItemVariantIds.add(v.id);

        const addonsCfg = typeCfg && typeCfg.addons;
        const allowedAddons = resolveItemAllowList(
            addonsCfg, type.Addons || [], typeDefault, `${type.Name} add-on`, absRulesPath
        );
        allowedItemAddonsByType.set(normalize(type.Name), new Set(allowedAddons.map(a => a.id)));
    }

    return {
        rulesPath: absRulesPath,
        rulesKiller,
        allowedKillerPerkIds,
        allowedSurvivorPerkIds,
        killerCombos,
        survivorCombosBuild,
        killerPickLimits,
        survivorPickLimitsBuild,
        allowedKillerAddonIds,
        allowedItemVariantIds,
        allowedItemAddonsByType,
    };
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        files: [],
        outDir: null,
        rulesPath: null,
        iconsOnly: false,
    };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--out' && argv[i + 1]) {
            args.outDir = argv[++i];
        } else if (a === '--rules' && argv[i + 1]) {
            // Path to an allow-list YAML; validated against every rendered build
            // by loadRulesContext() / validateModel() (see main()).
            args.rulesPath = argv[++i];
        } else if (a === '--asset-root' && argv[i + 1]) {
            // Swallow the flag + its value: --asset-root is read by readOption()
            // at module load, ABOVE, before parseArgs ever runs (needed because
            // REPO_ROOT / the JSON data loads must happen at require time). This
            // branch's only job is to keep it out of args.files — without it,
            // "--asset-root" and its path would be treated as positional input
            // files. Copied verbatim from perk-sheet-generator.js:175-176; do not
            // turn this into a real option.
            i++;
        } else if (a === '--icons-only') {
            // Boolean flag: unlike the others above, this does not consume a value.
            args.iconsOnly = true;
        } else if (!a.startsWith('--')) {
            args.files.push(a);
        } else {
            fatal(`Unknown flag: ${a}`);
        }
        i++;
    }
    return args;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------
function fatal(msg) {
    console.error(`ERROR: ${msg}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Asset path resolution
// ---------------------------------------------------------------------------
function perkIconPng(perk) {
    const side = perk.survivorPerk ? 'Survivors' : 'Killers';
    const basename = path.basename(perk.icon).replace('.webp', '.png');
    const candidate = path.join(PNG_PERKS_BASE, side, basename);
    if (fs.existsSync(candidate)) return candidate;
    return BLANK_PERK;
}

/**
 * Derive the PNG mirror path for a killer power add-on from its `addonIcon` (a
 * WebP path under public/, e.g. "public/PowerAddons/Trapper/Trapper-Gloves.webp").
 * Copied verbatim from addon-sheet-generator.js:271-276. NEVER build this path
 * from the killer slug — canvas-image-library/PowerAddons/ dirs are irregular
 * (Trapper, GhostFace, SkullMerchant, First, Slasher, Onryo, ...) and different
 * from the "The-Trapper" filename slug used elsewhere in this tool.
 */
function addonIconPng(addon) {
    const rel = String(addon.addonIcon)
        .replace(/^public[\\/]/, '')
        .replace(/\.webp$/i, '.png');
    return path.join(PNG_LIBRARY, rel);
}

/** Copied verbatim from item-sheet-generator.js:344-347. */
function pngFromIcon(baseDir, iconPath) {
    const basename = path.basename(iconPath).replace(/\.webp$/i, '.png');
    return path.join(baseDir, basename);
}

// Directory listing for lore/, cached and read lazily (never touched at all when
// a run has no killer, e.g. a killer-less survivor sheet). Backs lorePng()'s
// case-insensitive rescan below.
let loreDirEntries = null;
function loreDirListing() {
    if (loreDirEntries === null) {
        loreDirEntries = fs.existsSync(PNG_LORE) ? fs.readdirSync(PNG_LORE) : [];
    }
    return loreDirEntries;
}

// Killers already warned about missing lore art, so a multi-file batch run only
// warns once per killer rather than once per rendered sheet.
const warnedMissingLore = new Set();

/**
 * Full-body killer art for the left edge, from Killers.json's LorePortrait.
 * Unlike Portraits/, canvas-image-library/lore/ has NO Blank.png fallback, and
 * at least one entry disagrees on case ("iconography/lore/Ghostface.webp" vs
 * the file GhostFace.png) — hence the case-insensitive rescan. Returns null
 * when there is genuinely no art; the sheet then renders without it.
 */
function lorePng(killer) {
    const basename = path.basename(killer.LorePortrait || '').replace(/\.webp$/i, '.png');
    if (!basename) return null;

    const exact = path.join(PNG_LORE, basename);
    if (fs.existsSync(exact)) return exact;

    const lowerBasename = basename.toLowerCase();
    const match = loreDirListing().find(f => f.toLowerCase() === lowerBasename);
    if (match) return path.join(PNG_LORE, match);

    if (!warnedMissingLore.has(killer.Name)) {
        warnedMissingLore.add(killer.Name);
        console.warn(
            `WARNING: no lore art found for "${killer.Name}" (looked for "${basename}" in ` +
            `${PNG_LORE}); rendering the sheet without it.`
        );
    }
    return null;
}

// ---------------------------------------------------------------------------
// Row layout
// ---------------------------------------------------------------------------
// x is relative to PANEL_X; y centres each icon on the PANEL_H band, which
// reproduces upstream's per-group margins (10 / 10 / 25 / 35) exactly. Values
// are canvasGenerator.js's absolute x's (:772-911) minus PANEL_X (270):
//   perk     290, 418, 546, 674  -> 20, 148, 276, 404
//   offering 842                -> 572
//   item     1010 (survivor only) -> 740
//   addon    1108, 1181         -> 838, 911
// Upstream's inter-icon/inter-group gaps are NOT uniform (10px between perks,
// 5px between add-ons, 50/50/10px between groups), so an accumulating
// addGroup-style loop can't reproduce them — hence the explicit table instead.
const SLOT_X = {
    perk:     [20, 148, 276, 404],
    offering: [572],
    item:     [740],
    addon:    [838, 911],
};

/**
 * Pure layout helper: lays out one build row's slots left -> right and returns
 * their positions. Icons are vertically centred on the PANEL_H band
 * (y = round((PANEL_H - size) / 2)); x comes straight from SLOT_X above. The
 * killer row simply omits the item column and leaves that gap empty, so a
 * killer sheet and a survivor sheet for the same match line up column-for-column.
 *
 * @param {boolean} isSurvivor
 * @returns {{ slots: Array<{kind:string, index:number, size:number, x:number, y:number}>, width: number }}
 */
function rowSlots(isSurvivor) {
    const slots = [];
    const pushGroup = (kind, size, xs) => {
        xs.forEach((x, i) => {
            slots.push({ kind, index: i, size, x, y: Math.round((PANEL_H - size) / 2) });
        });
    };
    pushGroup('perk', PERK, SLOT_X.perk);
    pushGroup('offering', OFFERING, SLOT_X.offering);
    if (isSurvivor) pushGroup('item', ITEM, SLOT_X.item);
    pushGroup('addon', ADDON, SLOT_X.addon);
    return { slots, width: PANEL_W };
}

/** Read the resolved record (or null) a given slot draws for one row. */
function slotRecord(row, slot) {
    switch (slot.kind) {
        case 'perk':     return row.perks[slot.index];
        case 'offering': return row.offering;
        case 'item':     return row.item;
        case 'addon':    return row.addons[slot.index];
        default:         return null;
    }
}

/** Resolve the PNG path a given slot draws for one row (art or blank.png). */
function slotIconPath(row, slot) {
    const record = slotRecord(row, slot);
    switch (slot.kind) {
        case 'perk':
            return record ? perkIconPng(record) : BLANK_PERK;
        case 'offering':
            return record ? pngFromIcon(PNG_OFFERINGS, record.icon) : BLANK_OFFERING;
        case 'item':
            return record ? pngFromIcon(PNG_ITEMS, record.icon) : BLANK_ITEM;
        case 'addon':
            if (!record) return BLANK_ADDON;
            return row.addonKind === 'killer'
                ? addonIconPng(record)
                : pngFromIcon(PNG_ADDONS, record.icon);
        default:
            return BLANK_PERK;
    }
}

// ---------------------------------------------------------------------------
// YAML parsing + validation (build-integrity errors are fatal() at parse time)
// ---------------------------------------------------------------------------
/**
 * Resolve one perk name against the correct-side lookup. Distinguishes an
 * unknown name from a side mismatch (e.g. a survivor perk named in a killer
 * `builds:` row) so the error is specific.
 */
function resolvePerk(name, isSurvivorSide, filePath, context) {
    if (typeof name !== 'string') {
        fatal(
            `Perk entry ${JSON.stringify(name)} (${context}) in file "${filePath}" must be a ` +
            `quoted string. If the name contains a colon, wrap it in quotes ` +
            `(e.g. "Scourge Hook: Pain Resonance").`
        );
    }
    const lookup      = isSurvivorSide ? survivorPerkLookup : killerPerkLookup;
    const wrongLookup = isSurvivorSide ? killerPerkLookup : survivorPerkLookup;
    const norm = normalize(name);
    const perk = lookup.get(norm);
    if (perk) return perk;
    const wrongPerk = wrongLookup.get(norm);
    if (wrongPerk) {
        fatal(
            `Perk "${name}" (${context}) in file "${filePath}" is a ` +
            `${isSurvivorSide ? 'killer' : 'survivor'} perk and cannot be used in a ` +
            `${isSurvivorSide ? 'survivor' : 'killer'} build.`
        );
    }
    fatal(
        `Unknown perk name "${name}" (${context}) in file "${filePath}". ` +
        `No matching perk found on this side.`
    );
}

function requireString(value, label, filePath) {
    if (typeof value !== 'string') {
        fatal(
            `${label} ${JSON.stringify(value)} in file "${filePath}" must be a quoted string. ` +
            `If it contains a colon, wrap it in quotes.`
        );
    }
    return value;
}

/**
 * Parse + validate one input file into a render-ready model. No group selectors
 * ({tag}/{rarity}/etc.) are supported here — every slot names a concrete build
 * pick, not an allow-list, so only quoted strings are accepted.
 */
function processFile(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        fatal(`Cannot read file "${filePath}": ${e.message}`);
    }

    let doc;
    try {
        doc = yaml.load(raw);
    } catch (e) {
        fatal(`YAML parse error in "${filePath}": ${e.message}`);
    }

    if (!doc || typeof doc !== 'object') {
        fatal(`File "${filePath}" does not contain a YAML object.`);
    }

    // Side auto-detection: `builds:` XOR `survivors:`.
    const hasBuilds    = doc.builds !== undefined;
    const hasSurvivors = doc.survivors !== undefined;
    if (hasBuilds === hasSurvivors) {
        fatal(
            `File "${filePath}" must have exactly one of "builds" (killer side) or ` +
            `"survivors" (survivor side) at the top level, got ` +
            `${hasBuilds ? 'both' : 'neither'}.`
        );
    }
    const isSurvivorSheet = hasSurvivors;

    // Killer: required on the killer side, optional on the survivor side.
    let killer = null;
    if (!isSurvivorSheet && !doc.killer) {
        fatal(`Missing "killer" field in "${filePath}" (required for a killer build file).`);
    }
    if (doc.killer) {
        killer = killerLookup.get(normalize(doc.killer));
        if (!killer) {
            fatal(
                `Unknown killer "${doc.killer}" in file "${filePath}". ` +
                `No matching entry in Killers.json.`
            );
        }
    }

    const balancing = (doc.balancing == null) ? '' : String(doc.balancing).trim();
    const title = (doc.title == null) ? null : requireString(doc.title, '"title"', filePath);

    const sideWord = isSurvivorSheet ? 'survivors' : 'builds';
    const rowsRaw = isSurvivorSheet ? doc.survivors : doc.builds;
    if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
        fatal(`"${sideWord}" must be a non-empty list in file "${filePath}".`);
    }
    if (rowsRaw.length > 4) {
        fatal(
            `"${sideWord}" has ${rowsRaw.length} rows in file "${filePath}"; at most 4 are allowed.`
        );
    }

    // Killer power add-on pool for THIS killer (killer side only).
    let killerAddonLookup = null;
    if (!isSurvivorSheet) {
        const universe = addonsByKiller.get(normalize(killer.Name));
        if (!universe) {
            fatal(`No add-ons found for killer "${killer.Name}" in NewAddons.json.`);
        }
        killerAddonLookup = buildNameLookup(universe);
    }

    const rows = rowsRaw.map((rowRaw, i) => {
        const rowNum = i + 1;
        const label = isSurvivorSheet ? `Survivor ${rowNum}` : `Build ${rowNum}`;
        if (!rowRaw || typeof rowRaw !== 'object' || Array.isArray(rowRaw)) {
            fatal(`Row ${rowNum} (${label}) in file "${filePath}" must be an object.`);
        }

        // --- perks: up to 4, no duplicates ---
        const perksRaw = rowRaw.perks || [];
        if (!Array.isArray(perksRaw)) {
            fatal(`"perks" in ${label} (file "${filePath}") must be a list.`);
        }
        if (perksRaw.length > 4) {
            fatal(`${label} in file "${filePath}" has ${perksRaw.length} perks; at most 4 are allowed.`);
        }
        const perkSlots = [null, null, null, null];
        const seenPerkIds = new Set();
        perksRaw.forEach((name, idx) => {
            const perk = resolvePerk(name, isSurvivorSheet, filePath, `${label}, perk slot ${idx + 1}`);
            if (seenPerkIds.has(perk.id)) {
                fatal(`Duplicate perk "${perk.name}" in ${label} (file "${filePath}").`);
            }
            seenPerkIds.add(perk.id);
            perkSlots[idx] = perk;
        });

        // --- offering: side-aware, optional ---
        let offering = null;
        if (rowRaw.offering != null) {
            const name = requireString(rowRaw.offering, `"offering" in ${label}`, filePath);
            const offLookup = isSurvivorSheet ? survivorOfferingLookup : killerOfferingLookup;
            offering = offLookup.get(normalize(name));
            if (!offering) {
                fatal(`Unknown offering "${name}" in ${label} (file "${filePath}").`);
            }
        }

        // --- item: survivor-only, optional ---
        if (!isSurvivorSheet && rowRaw.item != null) {
            fatal(
                `"item" is not valid in a killer build (${label}, file "${filePath}"); ` +
                `items are survivor-only.`
            );
        }
        let item = null;
        if (isSurvivorSheet && rowRaw.item != null) {
            const name = requireString(rowRaw.item, `"item" in ${label}`, filePath);
            item = variantByName.get(normalize(name));
            if (!item) {
                fatal(`Unknown item "${name}" in ${label} (file "${filePath}").`);
            }
        }

        // --- addons: up to 2, no duplicates, must resolve within the row's pool ---
        const addonsRaw = rowRaw.addons || [];
        if (!Array.isArray(addonsRaw)) {
            fatal(`"addons" in ${label} (file "${filePath}") must be a list.`);
        }
        if (addonsRaw.length > 2) {
            fatal(`${label} in file "${filePath}" has ${addonsRaw.length} add-ons; at most 2 are allowed.`);
        }

        let addonLookup = null;
        const addonKind = isSurvivorSheet ? 'item' : 'killer';
        if (isSurvivorSheet) {
            if (addonsRaw.length > 0) {
                if (!item) {
                    fatal(
                        `${label} in file "${filePath}" has "addons" but no "item"; ` +
                        `add-ons require an item.`
                    );
                }
                const type = typeByName.get(normalize(item.Type));
                if (!type || !type.Addons || type.Addons.length === 0) {
                    fatal(
                        `"${item.Name}" (${item.Type}) has no add-ons, but ${label} in file ` +
                        `"${filePath}" lists add-ons.`
                    );
                }
                addonLookup = buildNameLookup(type.Addons);
            }
        } else {
            addonLookup = killerAddonLookup;
        }

        const addonSlots = [null, null];
        const seenAddonKeys = new Set();
        addonsRaw.forEach((rawName, idx) => {
            const name = requireString(rawName, `Add-on entry in ${label}`, filePath);
            const addon = addonLookup.get(normalize(name));
            if (!addon) {
                const owner = isSurvivorSheet ? `item "${item.Name}"'s` : `killer "${killer.Name}"'s`;
                fatal(
                    `Unknown add-on "${name}" in ${label} (file "${filePath}"); not part of ` +
                    `${owner} add-on pool.`
                );
            }
            const key = addon.globalID != null ? addon.globalID : addon.id;
            if (seenAddonKeys.has(key)) {
                fatal(`Duplicate add-on "${addon.Name}" in ${label} (file "${filePath}").`);
            }
            seenAddonKeys.add(key);
            addonSlots[idx] = addon;
        });

        // --- survivor: removed from the schema ---
        if (rowRaw.survivor != null) {
            fatal(
                `"survivor" is no longer a valid key (${label}, file "${filePath}"); ` +
                `survivor character choice was removed from the build sheet schema.`
            );
        }

        return { perks: perkSlots, offering, item, addons: addonSlots, addonKind };
    });

    return { isSurvivorSheet, killer, balancing, title, rows, filePath };
}

// ---------------------------------------------------------------------------
// --rules: validation (diffing a parsed model against a loadRulesContext() result)
// ---------------------------------------------------------------------------
// { kind, rowIndex, slots: [{group, index}], text }
// kind ∈ perk-banned | addon-banned | item-banned | item-addon-banned | combo-ban
//        | pick-limit. `slots` locate the offending icon(s) for the outline pass
//        (group matches rowSlots()' slot.kind: 'perk' | 'item' | 'addon').

/** `"A" and "B"` / `"A", "B" and "C"` — used for combo-ban sentences. */
function joinWithAnd(items) {
    if (items.length <= 1) return items.join('');
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Diff one row against a resolved rules context, pushing violation objects onto
 * `violations`. Only individual allow/deny plus the single-build limit families
 * are checked here — see the doc comment on loadRulesContext() for what is
 * deliberately excluded (duo/team scopes, offerings, item pick/duplicate limits,
 * survivor repetition limits).
 */
function validateRow(row, rowIndex, isSurvivorSheet, model, rulesCtx, violations) {
    const rowLabel = isSurvivorSheet
        ? `Survivor ${rowIndex + 1}`
        : `Build ${rowIndex + 1}`;

    // --- individual perk bans (side-aware) ---
    row.perks.forEach((perk, idx) => {
        if (!perk) return;
        const allowedIds = isSurvivorSheet ? rulesCtx.allowedSurvivorPerkIds : rulesCtx.allowedKillerPerkIds;
        if (!allowedIds.has(perk.id)) {
            violations.push({
                kind: 'perk-banned',
                rowIndex,
                slots: [{ group: 'perk', index: idx }],
                text: `${rowLabel}: "${perk.name}" is not on the allowed ` +
                      `${isSurvivorSheet ? 'survivor' : 'killer'} perk list.`,
            });
        }
    });

    // --- individual killer power add-on bans (killer side only) ---
    if (!isSurvivorSheet && rulesCtx.allowedKillerAddonIds) {
        row.addons.forEach((addon, idx) => {
            if (!addon) return;
            if (!rulesCtx.allowedKillerAddonIds.has(addon.globalID)) {
                violations.push({
                    kind: 'addon-banned',
                    rowIndex,
                    slots: [{ group: 'addon', index: idx }],
                    text: `${rowLabel}: "${addon.Name}" is not on ${model.killer.Name}'s ` +
                          `allowed add-on list.`,
                });
            }
        });
    }

    // --- individual item-variant + item-addon bans (survivor side only) ---
    if (isSurvivorSheet && row.item) {
        const itemAllowed = rulesCtx.allowedItemVariantIds.has(row.item.id);
        if (!itemAllowed) {
            violations.push({
                kind: 'item-banned',
                rowIndex,
                slots: [{ group: 'item', index: 0 }],
                text: `${rowLabel}: "${row.item.Name}" is not on the allowed item list.`,
            });
        }

        // Only check add-ons when the item itself is legal: once the item is
        // already banned, any add-on picked with it is moot (redundant with
        // the item-banned violation above), not a second finding.
        if (itemAllowed) {
            // Item add-on `id` is local per type — always look the pool up by
            // the row's OWN item Type, never a flat set.
            const addonIds = rulesCtx.allowedItemAddonsByType.get(normalize(row.item.Type)) || new Set();
            row.addons.forEach((addon, idx) => {
                if (!addon) return;
                if (!addonIds.has(addon.id)) {
                    violations.push({
                        kind: 'item-addon-banned',
                        rowIndex,
                        slots: [{ group: 'addon', index: idx }],
                        text: `${rowLabel}: "${addon.Name}" is not on the allowed ` +
                              `${row.item.Type} add-on list.`,
                    });
                }
            });
        }
    }

    // --- combo bans (single-build scope only) ---
    const combos = isSurvivorSheet ? rulesCtx.survivorCombosBuild : rulesCtx.killerCombos;
    for (const combo of combos) {
        const slots = [];
        let allPresent = true;
        for (const comboPerk of combo.perks) {
            const idx = row.perks.findIndex(p => p && p.id === comboPerk.id);
            if (idx === -1) { allPresent = false; break; }
            slots.push({ group: 'perk', index: idx });
        }
        if (allPresent) {
            const names = combo.perks.map(p => `"${p.name}"`);
            violations.push({
                kind: 'combo-ban',
                rowIndex,
                slots,
                text: `${rowLabel}: may not bring ${joinWithAnd(names)} together.`,
            });
        }
    }

    // --- pick limits (single-build scope only) ---
    const pickLimits = isSurvivorSheet ? rulesCtx.survivorPickLimitsBuild : rulesCtx.killerPickLimits;
    for (const limit of pickLimits) {
        const slots = [];
        for (const p of limit.perks) {
            const idx = row.perks.findIndex(rp => rp && rp.id === p.id);
            if (idx !== -1) slots.push({ group: 'perk', index: idx });
        }
        if (slots.length > limit.max) {
            const names = limit.perks.map(p => `"${p.name}"`);
            violations.push({
                kind: 'pick-limit',
                rowIndex,
                slots,
                text: `${rowLabel}: may bring at most ${limit.max} of ${names.join(', ')}; ` +
                      `brought ${slots.length}.`,
            });
        }
    }
}

// Sort order within a row: perk -> offering -> item -> addon, then limits
// (combo-ban / pick-limit have no single "slot kind" of their own).
const VIOLATION_KIND_ORDER = {
    'perk-banned': 0,
    'addon-banned': 3,
    'item-banned': 2,
    'item-addon-banned': 3,
    'combo-ban': 4,
    'pick-limit': 4,
};

/**
 * Validate an entire parsed build model against a resolved rules context.
 * Fatal on a killer mismatch between the rules file and the build file (the
 * killer power add-on allow-list is per-killer and would otherwise be diffed
 * against the wrong pool); a killer-less survivor build file only warns, since
 * killer add-ons are never checked on the survivor side anyway.
 * @returns {Array} violations, sorted by row then slot order then limits.
 */
function validateModel(model, rulesCtx) {
    if (model.killer) {
        if (!rulesCtx.rulesKiller) {
            fatal(
                `Rules file "${rulesCtx.rulesPath}" has no "killer" field, but build file ` +
                `"${model.filePath}" is for "${model.killer.Name}"; a rules file must name the ` +
                `same killer to validate its power add-ons.`
            );
        } else if (normalize(rulesCtx.rulesKiller.Name) !== normalize(model.killer.Name)) {
            fatal(
                `Killer mismatch: rules file "${rulesCtx.rulesPath}" is for ` +
                `"${rulesCtx.rulesKiller.Name}" but build file "${model.filePath}" is for ` +
                `"${model.killer.Name}".`
            );
        }
    } else {
        console.warn(
            `WARNING: build file "${model.filePath}" has no killer; skipping killer power ` +
            `add-on validation against rules file "${rulesCtx.rulesPath}".`
        );
    }

    const violations = [];
    model.rows.forEach((row, i) => validateRow(row, i, model.isSurvivorSheet, model, rulesCtx, violations));

    violations.sort((a, b) => {
        if (a.rowIndex !== b.rowIndex) return a.rowIndex - b.rowIndex;
        const ao = VIOLATION_KIND_ORDER[a.kind];
        const bo = VIOLATION_KIND_ORDER[b.kind];
        if (ao !== bo) return ao - bo;
        const ai = a.slots.length ? a.slots[0].index : 0;
        const bi = b.slots.length ? b.slots[0].index : 0;
        return ai - bi;
    });

    return violations;
}

/** Dedupe outline targets by `${rowIndex}:${group}:${index}` across every violation. */
function buildOutlineSet(violations) {
    const set = new Set();
    for (const v of violations) {
        for (const s of v.slots) set.add(`${v.rowIndex}:${s.group}:${s.index}`);
    }
    return set;
}

// ---------------------------------------------------------------------------
// Output filename resolution
// ---------------------------------------------------------------------------
function outputFilename(model, iconsOnly) {
    let base;
    if (!model.isSurvivorSheet) {
        base = `${model.killer.Name.replace(/\s+/g, '-')}-killer-builds`;
    } else if (model.killer) {
        base = `${model.killer.Name.replace(/\s+/g, '-')}-survivor-builds`;
    } else {
        base = `${path.basename(model.filePath, path.extname(model.filePath))}-survivor-builds`;
    }
    return iconsOnly ? `${base}-icons.png` : `${base}.png`;
}

// ---------------------------------------------------------------------------
// Image rendering
// ---------------------------------------------------------------------------
/** Copied verbatim from perk-sheet-generator.js:826-834. */
function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
}

/** Stroke the violation outline over a slot BOX (not its art) — see the doc
 * comment on VIOLATION_COLOR's usage in renderSheet/renderIconSheet for why. */
function strokeViolationOutline(ctx, x, y, size) {
    ctx.strokeStyle = VIOLATION_COLOR;
    ctx.lineWidth = 4;
    roundRectPath(ctx, x + 2, y + 2, size - 4, size - 4, 8);
    ctx.stroke();
}

/** Greedy word-wrap: split `text` into lines no wider than `maxWidth` under the
 * ctx's currently-set font. Always returns at least one line. */
function wrapText(measureCtx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
        const test = cur ? `${cur} ${w}` : w;
        if (cur && measureCtx.measureText(test).width > maxWidth) {
            lines.push(cur);
            cur = w;
        } else {
            cur = test;
        }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
}

/**
 * Lay out the "Violations" section: title + subtitle + one marker-prefixed line
 * per violation (soft-wrapped onto a second VIOL_LINE_H line when it would
 * otherwise widen the sheet). Mirrors item-sheet-generator.js:683-702's section
 * styling (SECTION_GAP, #2a2833 divider, 700 22pt title, 400 13pt #999999
 * subtitle) but with a plain red marker square instead of a scope chip — every
 * violation here is build-scoped, so a chip would carry zero information.
 * @returns {null|{title, subtitle, entries, width, height}}
 */
function buildViolationsLayout(violations, rulesPath, bodyWidth, measure) {
    if (!violations.length) return null;

    const title = 'Violations';
    const subtitle = `rules broken by these builds, per ${path.basename(rulesPath)}`;
    const textX = MARGIN + VIOL_MARKER + VIOL_MARKER_GAP;
    const wrapWidth = Math.max(50, bodyWidth - MARGIN * 2 - VIOL_MARKER - VIOL_MARKER_GAP);

    measure.font = '400 14pt sans-serif';
    let maxLineW = 0;
    const entries = violations.map(v => {
        const textLines = wrapText(measure, v.text, wrapWidth);
        for (const line of textLines) maxLineW = Math.max(maxLineW, measure.measureText(line).width);
        return { violation: v, textLines };
    });

    measure.font = '700 22pt sans-serif';
    const titleW = measure.measureText(title).width;
    measure.font = '400 13pt sans-serif';
    const subtitleW = measure.measureText(subtitle).width;

    const contentW = Math.max(titleW, subtitleW, textX - MARGIN + maxLineW);
    const width = MARGIN * 2 + contentW;

    let physicalLines = 0;
    for (const e of entries) physicalLines += e.textLines.length;

    // SECTION_GAP (gap before divider) + divider(2) + gap(16) + title(40) +
    // subtitle(24+8), then physicalLines * VIOL_LINE_H — same accounting as
    // drawLimitSection's header block, extended with the violation lines.
    const height = SECTION_GAP + 2 + 16 + 40 + 24 + 8 + physicalLines * VIOL_LINE_H;

    return { title, subtitle, entries, width, height };
}

/**
 * Draw a previously-built violations layout starting at `startY` (the bottom of
 * the row area, i.e. HEADER_H + rowBandH — NOT including the canvas's
 * BOTTOM_MARGIN, exactly like drawLimitSection's `gridBottom` convention).
 */
function drawViolationsSection(ctx, layout, startY, width) {
    let y = startY + SECTION_GAP;

    ctx.strokeStyle = '#2a2833';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y + 1);
    ctx.lineTo(width - MARGIN, y + 1);
    ctx.stroke();
    y += 2 + 16;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 22pt sans-serif';
    ctx.fillText(layout.title, MARGIN, y);
    y += 40;

    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.fillText(layout.subtitle, MARGIN, y);
    y += 24 + 8;

    const textX = MARGIN + VIOL_MARKER + VIOL_MARKER_GAP;
    ctx.font = '400 14pt sans-serif';
    for (const entry of layout.entries) {
        const markerY = y + Math.round((VIOL_LINE_H - VIOL_MARKER) / 2);
        ctx.fillStyle = VIOLATION_COLOR;
        ctx.fillRect(MARGIN, markerY, VIOL_MARKER, VIOL_MARKER);

        ctx.fillStyle = '#cccccc';
        for (const line of entry.textLines) {
            ctx.fillText(line, textX, y);
            y += VIOL_LINE_H;
        }
    }
}

/** Preload every slot's icon (across every row) in one batch. */
async function preloadRowIcons(rows, slots) {
    const flat = [];
    for (let r = 0; r < rows.length; r++) {
        for (const slot of slots) flat.push({ r, slot });
    }
    const results = await Promise.allSettled(
        flat.map(({ r, slot }) => loadImage(slotIconPath(rows[r], slot)))
    );
    return { flat, results };
}

/**
 * Render the full sheet: a fixed 1280-wide canvas with the sample's large
 * killer render bleeding up the left edge, translucent per-build panels
 * overlapping that art, and a compact two-line header — the visual language of
 * canvasGenerator.js:594 (GenerateSurvivorImage), NOT the portrait+title/
 * subtitle/count header its perk-/addon-/item-sheet-generator siblings use.
 * Height is dynamic (HEADER_H + the row band + BOTTOM_MARGIN + an optional
 * Violations section); width never varies. Draw order matters here — it is
 * what produces the sample's overlap: background, then lore art (clipped to
 * the row band), then the translucent panels over it, then icons+outlines,
 * then header text on top of everything, then the Violations section.
 */
async function renderSheet(model, outDir, dateStamp) {
    const isSurvivor = model.isSurvivorSheet;
    const { slots } = rowSlots(isSurvivor);
    const rows = model.rows;
    const n = rows.length;
    const rowBandH = n * PANEL_H + (n - 1) * PANEL_GAP;

    // Load the killer's lore art up front (killer sheets always name a killer;
    // survivor sheets only when `killer:` was given). lorePng() itself covers
    // "no art exists for this killer" (returns null, warns once); a load
    // failure on a path it DID resolve is the same "render without it"
    // outcome, just from a different cause, so both funnel into loreImg=null.
    let loreImg = null;
    if (model.killer) {
        const lorePath = lorePng(model.killer);
        if (lorePath) {
            try {
                loreImg = await loadImage(lorePath);
            } catch (e) {
                // fallback: no lore art (load error, not the no-art case above)
            }
        }
    }

    // --rules: null when validation wasn't requested at all (no status line,
    // no outlines, no section); an array (possibly empty) once it was.
    const hasRules = Array.isArray(model.violations);

    // --- Header text plan ---
    // A YAML `title:` override renders whole, with no prefix. Otherwise: killer
    // sheets get 'Playing as: <Killer>'; a survivor sheet that names a killer
    // gets 'Going against: <Killer>'; a killer-less survivor sheet gets no
    // prefix at all and falls back to the plain 'Survivor Builds' name.
    let prefix = '';
    let nameText = null;
    if (!model.title) {
        if (!isSurvivor) {
            prefix = 'Playing as: ';
            nameText = model.killer.Name;
        } else if (model.killer) {
            prefix = 'Going against: ';
            nameText = model.killer.Name;
        } else {
            nameText = 'Survivor Builds';
        }
    }

    // Measure the title line's height from the NAME, not the prefix —
    // canvasGenerator.js:620-622 measures its prefix (always non-empty there),
    // but this tool's killer-less survivor case has prefix === '', which would
    // collapse titleH to 0 if measured the same way.
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = '700 24pt sans-serif';
    const titleMetrics = measure.measureText(model.title || nameText);
    const titleH = titleMetrics.actualBoundingBoxAscent + titleMetrics.actualBoundingBoxDescent;

    // --rules: lay out the Violations section now (before the canvas height is
    // finalized below) so its height can be folded in. bodyWidth is always
    // CANVAS_W now — this sheet's width never varies with content.
    const violationsLayout = hasRules
        ? buildViolationsLayout(model.violations, model.rulesPath, CANVAS_W, measure)
        : null;
    const violationsH = violationsLayout ? violationsLayout.height : 0;

    const width = CANVAS_W;
    const height = HEADER_H + rowBandH + BOTTOM_MARGIN + violationsH;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    // 2. Lore art, clipped to the row band so it can never bleed into the
    // Violations section below it. Fixed 384x761 anchored top-left of the
    // band, exactly as canvasGenerator.js:726-733 — on a 4-row sheet it runs
    // off the bottom just like the sample; on a 1-2 row sheet the clip crops
    // it to a head-and-shoulders slice, which is why the art is top-anchored
    // rather than centred.
    if (loreImg) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, HEADER_H, LORE_W, rowBandH);
        ctx.clip();
        ctx.globalAlpha = LORE_ALPHA;
        ctx.drawImage(loreImg, 0, HEADER_H, LORE_W, LORE_H);
        ctx.globalAlpha = 1;

        // When a Violations section follows, the row-band clip above would
        // otherwise cut the art off in a hard horizontal line straight across
        // the killer's body, reading as a rendering bug rather than a crop —
        // so dissolve the last ~90px of the band into BG_COLOR with a plain
        // fillRect + linear gradient (still inside the clip; NOT
        // 'destination-out', which would punch the opaque background itself
        // through to transparency). This is conditional on violationsLayout
        // specifically: without one, the cut sits BOTTOM_MARGIN (13px) below
        // the fold and is already invisible, and bbd-sample.png has no
        // equivalent transition to match — its art simply runs off the
        // canvas's bottom edge — so fading unconditionally would wash out the
        // bottom of the art in exactly the case meant to match the sample
        // pixel-for-pixel.
        if (violationsLayout) {
            const fadeH = Math.min(90, rowBandH);
            const fadeTop = HEADER_H + rowBandH - fadeH;
            const gradient = ctx.createLinearGradient(0, fadeTop, 0, HEADER_H + rowBandH);
            gradient.addColorStop(0, 'rgba(16, 15, 22, 0)'); // BG_COLOR (#100f16) fully transparent
            gradient.addColorStop(1, BG_COLOR);
            ctx.fillStyle = gradient;
            ctx.fillRect(0, fadeTop, LORE_W, fadeH);
        }

        ctx.restore();
    }

    // 3. Translucent per-build panels, painted over the art so it only shows
    // through between x=0 and x=PANEL_X.
    ctx.fillStyle = PANEL_COLOR;
    for (let r = 0; r < n; r++) {
        ctx.fillRect(PANEL_X, HEADER_H + r * (PANEL_H + PANEL_GAP), PANEL_W, PANEL_H);
    }

    // 4. Icons + violation outlines
    const outlineSet = hasRules ? buildOutlineSet(model.violations) : null;
    const { flat, results } = await preloadRowIcons(rows, slots);
    flat.forEach(({ r, slot }, i) => {
        const y = HEADER_H + r * (PANEL_H + PANEL_GAP) + slot.y;
        const x = PANEL_X + slot.x;
        const result = results[i];
        if (result.status === 'fulfilled') {
            ctx.drawImage(result.value, x, y, slot.size, slot.size);
        } else {
            ctx.fillStyle = '#333333';
            ctx.fillRect(x, y, slot.size, slot.size);
        }
        if (outlineSet && outlineSet.has(`${r}:${slot.kind}:${slot.index}`)) {
            strokeViolationOutline(ctx, x, y, slot.size);
        }
    });

    // 5. Header text, drawn last so it sits above the art and panels, matching
    // the sample's own draw order.
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT_COLOR;
    if (model.title) {
        ctx.font = '700 24pt sans-serif';
        ctx.fillText(model.title, 10, 10, width);
    } else {
        ctx.font = '400 24pt sans-serif';
        ctx.fillText(prefix, 10, 10, width);
        const prefixW = ctx.measureText(prefix).width;
        ctx.font = '700 24pt sans-serif';
        ctx.fillText(nameText, 10 + prefixW, 10, width);
    }

    if (model.balancing) {
        const balancingY = 20 + titleH;
        ctx.font = '400 18pt sans-serif';
        ctx.fillText('Balancing: ', 10, balancingY, width);
        const balPrefixW = ctx.measureText('Balancing: ').width;
        ctx.font = '700 18pt sans-serif';
        ctx.fillText(model.balancing, 10 + balPrefixW, balancingY, width);
    }

    ctx.font = '700 14pt sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(`Image Date: ${dateStamp} UTC`, width - 10, 10, width);

    // Status line: only rendered when --rules was actually passed — a
    // killer-less/rule-less sheet gets no right-hand line at all.
    if (hasRules) {
        const numViolations = model.violations.length;
        const statusText = numViolations === 0
            ? 'No violations found'
            : `${numViolations} violation${numViolations === 1 ? '' : 's'} found`;
        ctx.fillStyle = numViolations === 0 ? '#80ff80' : '#ff8080';
        ctx.fillText(statusText, width - 10, 40, width);
    }
    ctx.textAlign = 'left';

    // 6. Violations section
    if (violationsLayout) {
        drawViolationsSection(ctx, violationsLayout, HEADER_H + rowBandH, width);
    }

    const outFile = path.join(outDir, outputFilename(model, false));
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

/**
 * Render the --icons-only variant: just the row strip, no header, no art, no
 * panels, no text at all, tightly cropped to the rows' own bounding box on a
 * fully transparent background. Reference implementation:
 * addon-sheet-generator.js:478-530. Empty slots still draw blank.png (it is
 * art, not text, and all four blanks have alpha-0 corners) so rows stay
 * aligned; the opaque #333333 placeholder used in renderSheet is deliberately
 * NOT drawn here — it would punch a hole in the transparency.
 */
async function renderIconSheet(model, outDir) {
    const isSurvivor = model.isSurvivorSheet;
    const { slots } = rowSlots(isSurvivor);
    const rows = model.rows;
    const n = rows.length;

    // slot.x starts at 20 (SLOT_X.perk[0]) and slot.y at 10 (PANEL_H-centring
    // of the 118px perk icons), not 0 as in the siblings' flat layout — crop
    // to the slots' own bounding box rather than assuming it starts at the
    // canvas origin. On the killer side, the empty item column shows up as
    // internal transparent space — the deliberate consequence of sharing the
    // survivor x-table (see rowSlots()'s doc comment).
    let minX = Infinity, minY = Infinity, maxRight = -Infinity;
    for (const slot of slots) {
        minX = Math.min(minX, slot.x);
        minY = Math.min(minY, slot.y);
        maxRight = Math.max(maxRight, slot.x + slot.size);
    }

    const width = maxRight - minX;
    const height = n * PANEL_H + (n - 1) * PANEL_GAP - 2 * minY;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    // No background fill, no art, no panels — see doc comment above.

    const outlineSet = Array.isArray(model.violations) ? buildOutlineSet(model.violations) : null;
    const { flat, results } = await preloadRowIcons(rows, slots);
    flat.forEach(({ r, slot }, i) => {
        const y = r * (PANEL_H + PANEL_GAP) + slot.y - minY;
        const x = slot.x - minX;
        const result = results[i];
        if (result.status === 'fulfilled') {
            ctx.drawImage(result.value, x, y, slot.size, slot.size);
        } else {
            // No opaque placeholder here — it would punch a hole in the transparency.
            console.warn(
                `WARNING: missing icon for ${slot.kind} slot (row ${r + 1}); skipping cell.`
            );
        }
        // Violation outlines are drawn here too (--icons-only has no header/text,
        // but the outlines are art, same as blank.png).
        if (outlineSet && outlineSet.has(`${r}:${slot.kind}:${slot.index}`)) {
            strokeViolationOutline(ctx, x, y, slot.size);
        }
    });

    const outFile = path.join(outDir, outputFilename(model, true));
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.files.length === 0) {
        console.log(
            'Usage: node build-sheet-generator.js <file.yaml...>\n' +
            '       [--asset-root <dir>] [--out <dir>] [--rules <file.yaml>] [--icons-only]'
        );
        process.exit(0);
    }

    // Parsed once and reused across every input file — perks/items/killer-addon
    // pools don't depend on which build file is being checked.
    const rulesCtx = args.rulesPath ? loadRulesContext(args.rulesPath) : null;

    const outDirOverride = args.outDir ? path.resolve(args.outDir) : null;

    // Stamp the generation time once so a batch shares a consistent timestamp.
    // Full "YYYY-MM-DD HH:MM:SS" stamp, matching the sample's own Image Date
    // line (canvasGenerator.js:671) — not just the date.
    const generatedAt = new Date();
    const generatedISO = generatedAt.toISOString();
    const dateStamp = generatedISO.replace('T', ' ').replace(/\..+/, '');

    for (const filePath of args.files) {
        const absPath = path.resolve(filePath);
        const model = processFile(absPath);

        // A violation is a finding to render, not a CLI error: validateModel()
        // only fatal()s on a killer/rules-file mismatch (a real authoring
        // error), never on the violations themselves — those just populate
        // model.violations for renderSheet/renderIconSheet to outline, and the
        // process exits 0 either way.
        if (rulesCtx) {
            model.rulesPath = args.rulesPath;
            model.violations = validateModel(model, rulesCtx);
        } else {
            model.violations = null;
        }

        const outDir = outDirOverride || path.dirname(absPath);
        fs.mkdirSync(outDir, { recursive: true });

        const outFile = await renderSheet(model, outDir, dateStamp);

        let summary =
            `[${path.basename(absPath)}]\n` +
            `  Side  : ${model.isSurvivorSheet ? 'survivor' : 'killer'}\n` +
            `  Rows  : ${model.rows.length}\n` +
            `  Sheet → ${outFile}`;

        if (args.iconsOnly) {
            const iconsOut = await renderIconSheet(model, outDir);
            summary += `\n  Icons → ${iconsOut}`;
        }

        if (rulesCtx) {
            if (model.violations.length) {
                summary += `\n  Violations (${model.violations.length}):`;
                for (const v of model.violations) summary += `\n    - ${v.text}`;
            } else {
                summary += `\n  Violations : none`;
            }
        }

        console.log(summary);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * perk-sheet-generator.js
 *
 * Reads a YAML file describing one killer's allowed perks (killer-side and
 * survivor-side separately), produces two PNG sheets, and optionally compiles
 * a BbD balancing-preset JSON when --preset is passed.
 *
 * Usage:
 *   node utilities/perk-sheet-generator/perk-sheet-generator.js <file.yaml...>
 *        [--asset-root <dir>] [--out <dir>] [--columns <n>]
 *        [--preset <out.json>] [--name "<name>"]
 *
 * Sheets are written next to each input file by default; --out overrides this.
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
const PERKS_FILE   = path.join(REPO_ROOT, 'public', 'Perks', 'dbdperks.json');
const KILLERS_FILE = path.join(REPO_ROOT, 'public', 'Killers.json');
const DEBUG_PRESET = path.join(REPO_ROOT, 'public', 'BalancingPresets', 'DEBUG.json');
const PNG_PERKS_BASE = path.join(REPO_ROOT, 'canvas-image-library', 'Perks');
const PNG_PORTRAITS  = path.join(REPO_ROOT, 'canvas-image-library', 'Portraits');

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const DEFAULT_COLUMNS = 8;
const ICON     = 118;   // px per icon
const GAP      = 16;    // px between icons
const MARGIN   = 32;    // outer margin
const HEADER_H = 190;   // header height
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';

// Combination-ban section (rendered below the allowed-perk grid)
const COMBO_ICON        = 72;   // px per combo perk icon
const COMBO_PLUS_W      = 40;   // horizontal slot reserved for the "+" glyph
const COMBO_ROW_GAP     = 20;   // vertical gap between combo rows
const COMBO_NAME_H      = 22;   // height reserved for the perk name under an icon
const COMBO_SECTION_GAP = 28;   // gap between the grid and the combo section
const CHIP_W            = 156;  // width of the scope chip

// Repetition-limit section (reuses the combo constants above; these are extra)
const REP_ICON_GAP = 24;   // horizontal gap between subset icons (no "+" glyph)
const REP_PILL_H   = 34;   // height of the "ALL PERKS" pill

// Per-scope presentation: chip label, chip colour, and the plain-English rule.
const SCOPE_META = {
    survivor: {
        label: 'ONE SURVIVOR', color: '#f0b429',
        rule: 'One survivor may not bring both perks.',
    },
    duo: {
        label: 'DUO', color: '#e8823a',
        rule: 'Neither duo may bring both perks between its two members.',
    },
    team: {
        label: 'WHOLE TEAM', color: '#e5484d',
        rule: 'If one survivor brings one perk, no other survivor may bring the other.',
    },
    build: {
        label: 'BUILD', color: '#8a8f98',
        rule: 'The killer may not bring both perks in one build.',
    },
};

// Fixed scope order for the survivor side (matches the increasing strictness).
const SURVIVOR_COMBO_SCOPES = ['survivor', 'duo', 'team'];

// Scopes valid for repetition limits (survivor side only). A per-single-survivor
// scope is meaningless here — one survivor can't bring the same perk twice — so only
// duo and team apply. Fixed order = rendering order (increasing group size).
const REPETITION_SCOPES = ['duo', 'team'];

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
const allPerks  = JSON.parse(fs.readFileSync(PERKS_FILE,   'utf8'));
const allKillers = JSON.parse(fs.readFileSync(KILLERS_FILE, 'utf8'));
const debugPreset = JSON.parse(fs.readFileSync(DEBUG_PRESET, 'utf8'));

// Pull the first KillerOverride entry as a template for the compile step
const OVERRIDE_TEMPLATE = debugPreset.KillerOverride[0];

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------
function normalize(str) {
    return String(str)
        .toLowerCase()
        .replace(/[\s\-_'.]+/g, '');
}

/**
 * Build a lookup map: normalized name/alias -> perk object.
 * Only includes perks whose survivorPerk matches `isKillerSide` (inverted).
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

const killerLookup = buildKillerLookup(allKillers);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        files: [],
        outDir: null,
        columns: DEFAULT_COLUMNS,
        presetPath: null,
        presetName: 'Generated Allow-List',
    };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--out' && argv[i + 1]) {
            args.outDir = argv[++i];
        } else if (a === '--columns' && argv[i + 1]) {
            const n = parseInt(argv[++i], 10);
            if (isNaN(n) || n < 1) fatal(`--columns must be a positive integer`);
            args.columns = n;
        } else if (a === '--preset' && argv[i + 1]) {
            args.presetPath = argv[++i];
        } else if (a === '--name' && argv[i + 1]) {
            args.presetName = argv[++i];
        } else if (a === '--asset-root' && argv[i + 1]) {
            i++;
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
// Selector matching
// ---------------------------------------------------------------------------
/**
 * Apply a single selector to a set of perks (perk array for the correct side).
 * Returns the set of perks matched by this selector.
 * @param {*} selector - string or object
 * @param {Array} universe - all perks for this side
 * @param {Map} lookup - normalized-name -> perk for this side
 * @param {string} filePath - for error messages
 */
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
        // If the object has exactly one key that is not a known selector keyword,
        // reconstruct the intended perk name and look it up.
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

// ---------------------------------------------------------------------------
// Perk resolution
// ---------------------------------------------------------------------------
/**
 * Resolve allowed perks for one side.
 * @param {Object} sideConfig - { default, allow, deny } from YAML
 * @param {Array|string} universeDecl - explicit universe declaration or 'all'
 * @param {boolean} isSurvivor - true for survivor-side
 * @param {string} filePath - for error messages
 * @returns {Array} array of allowed perk objects, sorted by name
 */
function resolveSide(sideConfig, universeDecl, isSurvivor, filePath) {
    // 1. Build the universe
    const sideAll = allPerks.filter(p => p.survivorPerk === isSurvivor);
    let universe;
    if (!universeDecl || universeDecl === 'all') {
        universe = sideAll;
    } else if (Array.isArray(universeDecl)) {
        // Universe is an explicit list of perk names
        const lookup = buildPerkLookup(sideAll);
        universe = universeDecl.map(name => {
            const p = lookup.get(normalize(name));
            if (!p) fatal(`Unknown perk "${name}" in universe list in file "${filePath}".`);
            return p;
        });
    } else {
        fatal(`Invalid universe declaration in file "${filePath}".`);
    }

    // Build a lookup for this side's universe
    const lookup = buildPerkLookup(universe);

    // 2. Seed from default
    const defaultVal = (sideConfig && sideConfig.default) || 'allow';
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" in file "${filePath}".`);
    }
    let allowed = new Map(); // id -> perk
    if (defaultVal === 'allow') {
        for (const p of universe) allowed.set(p.id, p);
    }
    // deny default: allowed starts empty

    // 3. Apply deny selectors
    const denyList = (sideConfig && sideConfig.deny) || [];
    for (const sel of denyList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const p of matched) allowed.delete(p.id);
    }

    // 4. Apply allow selectors (allow wins on conflict; intersected with universe)
    const allowList = (sideConfig && sideConfig.allow) || [];
    for (const sel of allowList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const p of matched) allowed.set(p.id, p);
    }

    // Sort alphabetically by name
    return [...allowed.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Combination-ban resolution
// ---------------------------------------------------------------------------
/**
 * Resolve combination bans for one side into an ordered list of
 * { scope, perks: [perkObj, …] } entries.
 *
 * Survivor config is a map keyed by scope (survivor / duo / team); killer config
 * is a flat list of combos under a single implicit "build" scope. Each combo is a
 * list of 2+ perk names (alias-aware, colon-names quoted — same resolver as
 * allow/deny). Group selectors ({exhaustion}/{tag}) are not allowed inside a combo.
 *
 * @param {*} comboConfig - doc.survivorComboBans (map) or doc.killerComboBans (list)
 * @param {boolean} isSurvivor - true for the survivor side
 * @param {Array} allowedPerks - the side's allowed perks (for the moot-combo warning)
 * @param {string} filePath - for error messages
 * @returns {Array} ordered [{ scope, perks }]
 */
function resolveComboBans(comboConfig, isSurvivor, allowedPerks, filePath) {
    if (comboConfig == null) return [];

    const sideAll    = allPerks.filter(p => p.survivorPerk === isSurvivor);
    const lookup     = buildPerkLookup(sideAll);
    const allowedIds = new Set(allowedPerks.map(p => p.id));
    const sideName   = isSurvivor ? 'survivor' : 'killer';

    const out = [];

    const resolveOneCombo = (entry, scope) => {
        if (!Array.isArray(entry)) {
            fatal(
                `Combo ban entry (scope "${scope}") in file "${filePath}" must be a list of ` +
                `perk names, got ${JSON.stringify(entry)}.`
            );
        }
        const perks = entry.map(sel => {
            // Group selectors are meaningless inside a combo.
            if (sel && typeof sel === 'object' &&
                (sel.exhaustion === true || typeof sel.tag === 'string')) {
                fatal(
                    `Group selectors ({ exhaustion } / { tag }) are not allowed inside a combo ` +
                    `ban (scope "${scope}") in file "${filePath}".`
                );
            }
            // matchSelector handles single names + unquoted colon names, and fatals
            // on unknown perks. For a valid entry it returns exactly one perk.
            return matchSelector(sel, sideAll, lookup, filePath)[0];
        });
        if (perks.length < 2) {
            fatal(
                `Combo ban (scope "${scope}") in file "${filePath}" needs at least 2 perks, ` +
                `got ${perks.length}: ${JSON.stringify(entry)}.`
            );
        }
        for (const p of perks) {
            if (!allowedIds.has(p.id)) {
                console.warn(
                    `WARNING: combo-ban perk "${p.name}" (scope "${scope}", ${sideName} side) is ` +
                    `not in the allowed set in "${filePath}"; the combo is moot because that perk ` +
                    `is already individually banned.`
                );
            }
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
        // Emit in fixed strictness order regardless of YAML key order.
        for (const scope of SURVIVOR_COMBO_SCOPES) {
            const list = comboConfig[scope];
            if (list == null) continue;
            if (!Array.isArray(list)) {
                fatal(`Survivor combo-ban scope "${scope}" must be a list in file "${filePath}".`);
            }
            for (const entry of list) resolveOneCombo(entry, scope);
        }
    } else {
        // Killer: a flat list of combos under the single implicit "build" scope.
        if (!Array.isArray(comboConfig)) {
            fatal(`"killerComboBans" must be a list of perk-name lists in file "${filePath}".`);
        }
        for (const entry of comboConfig) resolveOneCombo(entry, 'build');
    }

    return out;
}

/**
 * Resolve survivor repetition limits into an ordered list of
 * { scope, max, perks } entries. `perks` is an array of resolved perk objects for a
 * subset rule, or null when the rule covers every allowed perk ("all"/omitted).
 *
 * A repetition limit caps how many members of a scoped group may each bring the SAME
 * perk (unlike a combo ban, which restricts a set of DIFFERENT perks). Survivor side
 * only; scopes are duo / team (see REPETITION_SCOPES). Perk names use the same
 * alias-aware resolver as allow/deny/combos; group selectors ({exhaustion}/{tag}) are
 * not allowed inside `perks`.
 *
 * @param {*} config - doc.survivorRepetitionLimits (a list of rule objects)
 * @param {Array} allowedPerks - the survivor side's allowed perks (for the moot warning)
 * @param {string} filePath - for error messages
 * @returns {Array} ordered [{ scope, max, perks }]
 */
function resolveRepetitionLimits(config, allowedPerks, filePath) {
    if (config == null) return [];

    if (!Array.isArray(config)) {
        fatal(
            `"survivorRepetitionLimits" must be a list of { scope, max, perks } objects ` +
            `in file "${filePath}".`
        );
    }

    const sideAll    = allPerks.filter(p => p.survivorPerk === true);
    const lookup     = buildPerkLookup(sideAll);
    const allowedIds = new Set(allowedPerks.map(p => p.id));

    const out = [];

    for (const entry of config) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            fatal(
                `Each "survivorRepetitionLimits" entry must be a { scope, max, perks } object ` +
                `in file "${filePath}", got ${JSON.stringify(entry)}.`
            );
        }

        // scope
        const scope = entry.scope;
        if (!REPETITION_SCOPES.includes(scope)) {
            const extra = scope === 'survivor'
                ? ` The "survivor" scope is meaningless for repetition limits (one survivor ` +
                  `cannot bring the same perk twice); use a combination ban instead.`
                : '';
            fatal(
                `Invalid repetition-limit scope ${JSON.stringify(scope)} in file "${filePath}". ` +
                `Valid scopes: ${REPETITION_SCOPES.join(', ')}.${extra}`
            );
        }

        // max
        const max = entry.max;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
            fatal(
                `Repetition-limit "max" (scope "${scope}") must be a positive integer in ` +
                `file "${filePath}", got ${JSON.stringify(max)}.`
            );
        }
        if (scope === 'duo' && max >= 2) {
            console.warn(
                `WARNING: repetition limit (scope "duo", max ${max}) in "${filePath}" is vacuous ` +
                `— a duo has only two members, so a max of ${max} never restricts anything.`
            );
        }

        // perks: 'all' / omitted -> null; a list -> resolved subset
        let perks = null;
        const perksDecl = entry.perks;
        if (perksDecl != null && perksDecl !== 'all') {
            if (!Array.isArray(perksDecl)) {
                fatal(
                    `Repetition-limit "perks" (scope "${scope}") must be "all" or a list of perk ` +
                    `names in file "${filePath}", got ${JSON.stringify(perksDecl)}.`
                );
            }
            perks = perksDecl.map(sel => {
                if (sel && typeof sel === 'object' &&
                    (sel.exhaustion === true || typeof sel.tag === 'string')) {
                    fatal(
                        `Group selectors ({ exhaustion } / { tag }) are not allowed inside a ` +
                        `repetition limit (scope "${scope}") in file "${filePath}".`
                    );
                }
                return matchSelector(sel, sideAll, lookup, filePath)[0];
            });
            for (const p of perks) {
                if (!allowedIds.has(p.id)) {
                    console.warn(
                        `WARNING: repetition-limit perk "${p.name}" (scope "${scope}") is not in the ` +
                        `allowed set in "${filePath}"; the limit is moot because that perk is ` +
                        `already individually banned.`
                    );
                }
            }
        }

        out.push({ scope, max, perks });
    }

    // Emit in fixed scope order (duo before team), stable within a scope.
    out.sort((a, b) => REPETITION_SCOPES.indexOf(a.scope) - REPETITION_SCOPES.indexOf(b.scope));
    return out;
}

/**
 * Build a draw-ready layout for the combination-ban section, computing the total
 * height and the minimum width it needs. Uses `measure` (a throwaway 2d context)
 * for text metrics. Returns null when there are no combos.
 */
function buildComboLayout(comboBans, measure) {
    if (!comboBans || comboBans.length === 0) return null;

    // Group by scope, preserving the (already strictness-ordered) first-seen order.
    const groups = [];
    for (const cb of comboBans) {
        let g = groups.find(x => x.scope === cb.scope);
        if (!g) { g = { scope: cb.scope, meta: SCOPE_META[cb.scope], combos: [] }; groups.push(g); }
        g.combos.push(cb);
    }

    let width = 0;
    for (const g of groups) {
        measure.font = '400 14pt sans-serif';
        const ruleW = measure.measureText(g.meta.rule).width;
        width = Math.max(width, MARGIN + CHIP_W + 16 + Math.ceil(ruleW) + MARGIN);

        for (const combo of g.combos) {
            measure.font = '400 12pt sans-serif';
            const n = combo.perks.length;
            let rowW = MARGIN * 2;
            // Each icon sits in a slot at least as wide as its name so labels never
            // collide with the neighbouring icon.
            combo.slots = combo.perks.map((p, i) => {
                const nameW = measure.measureText(p.name).width;
                const slotW = Math.max(COMBO_ICON, Math.ceil(nameW) + 8);
                rowW += slotW;
                if (i < n - 1) rowW += COMBO_PLUS_W;
                return { perk: p, slotW };
            });
            width = Math.max(width, rowW);
        }
    }

    // Height: section gap + divider + title + subtitle, then per group a chip/rule
    // header and one row per combo.
    let height = COMBO_SECTION_GAP + 2 + 16 + 40 + 24 + 8;
    for (const g of groups) {
        height += 12 + 30 + 10;
        for (let i = 0; i < g.combos.length; i++) {
            height += COMBO_ICON + COMBO_NAME_H + COMBO_ROW_GAP;
        }
    }

    return { groups, width, height };
}

// ---------------------------------------------------------------------------
// Asset path resolution
// ---------------------------------------------------------------------------
function perkIconPng(perk) {
    const side = perk.survivorPerk ? 'Survivors' : 'Killers';
    const basename = path.basename(perk.icon).replace('.webp', '.png');
    const candidate = path.join(PNG_PERKS_BASE, side, basename);
    if (fs.existsSync(candidate)) return candidate;
    return path.join(PNG_PERKS_BASE, 'blank.png');
}

function portraitPng(killer) {
    const basename = path.basename(killer.Portrait).replace('.webp', '.png');
    const candidate = path.join(PNG_PORTRAITS, basename);
    if (fs.existsSync(candidate)) return candidate;
    return path.join(PNG_PORTRAITS, 'Blank.png');
}

// ---------------------------------------------------------------------------
// Image rendering
// ---------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
}

function drawScopeChip(ctx, x, y, w, h, color, label) {
    ctx.fillStyle = color;
    roundRectPath(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.fillStyle = BG_COLOR;
    ctx.font = '700 12pt sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + w / 2, y + h / 2 + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
}

/**
 * Draw the combination-ban section starting at `startY`. `iconMap` maps perk id ->
 * loaded Image (or null). Returns nothing; the caller sizes the canvas from the
 * matching buildComboLayout() result.
 */
function drawComboSection(ctx, layout, startY, iconMap, width) {
    let y = startY + COMBO_SECTION_GAP;

    // Divider between the grid and the section
    ctx.strokeStyle = '#2a2833';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y + 1);
    ctx.lineTo(width - MARGIN, y + 1);
    ctx.stroke();
    y += 2 + 16;

    // Title + subtitle
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 22pt sans-serif';
    ctx.fillText('Combination Bans', MARGIN, y);
    y += 40;
    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.fillText('each perk is allowed on its own — these pairings are restricted', MARGIN, y);
    y += 24 + 8;

    for (const g of layout.groups) {
        y += 12;
        const chipH = 30;
        drawScopeChip(ctx, MARGIN, y, CHIP_W, chipH, g.meta.color, g.meta.label);
        ctx.font = '400 14pt sans-serif';
        ctx.fillStyle = '#cccccc';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(g.meta.rule, MARGIN + CHIP_W + 16, y + chipH / 2);
        ctx.textBaseline = 'top';
        y += chipH + 10;

        for (const combo of g.combos) {
            let x = MARGIN;
            const iconY = y;
            combo.slots.forEach((slot, i) => {
                const cx = x + slot.slotW / 2;
                const ix = Math.round(cx - COMBO_ICON / 2);
                const img = iconMap.get(slot.perk.id);
                if (img) {
                    ctx.drawImage(img, ix, iconY, COMBO_ICON, COMBO_ICON);
                } else {
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(ix, iconY, COMBO_ICON, COMBO_ICON);
                }
                // Perk name centered under the icon
                ctx.font = '400 12pt sans-serif';
                ctx.fillStyle = '#dddddd';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(slot.perk.name, Math.round(cx), iconY + COMBO_ICON + 4);

                x += slot.slotW;
                if (i < combo.slots.length - 1) {
                    ctx.font = '700 24pt sans-serif';
                    ctx.fillStyle = '#888888';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('+', x + COMBO_PLUS_W / 2, iconY + COMBO_ICON / 2);
                    x += COMBO_PLUS_W;
                }
            });
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            y += COMBO_ICON + COMBO_NAME_H + COMBO_ROW_GAP;
        }
    }
}

/**
 * Plain-English rule sentence for one repetition limit, keyed off scope, max, and
 * whether it targets a subset of perks ("listed") or every perk.
 */
function repetitionRuleText(rule) {
    const listed = rule.perks ? ' listed' : '';
    if (rule.scope === 'duo') {
        if (rule.max === 1) return `Duo partners may not both bring the same${listed} perk.`;
        return `At most ${rule.max} duo members may bring any single${listed} perk.`;
    }
    // team
    if (rule.max === 1) return `No two survivors may bring the same${listed} perk.`;
    return `At most ${rule.max} survivors may bring any single${listed} perk.`;
}

/**
 * Build a draw-ready layout for the repetition-limit section, parallel to
 * buildComboLayout. Each rule renders as a scope chip + rule sentence, followed by
 * either an icon row (subset rules) or an "ALL PERKS" pill (all-perks rules). Returns
 * null when there are no limits.
 */
function buildRepetitionLayout(limits, measure) {
    if (!limits || limits.length === 0) return null;

    const rules = [];
    let width = 0;

    for (const rule of limits) {
        const meta = SCOPE_META[rule.scope];
        const text = repetitionRuleText(rule);

        measure.font = '400 14pt sans-serif';
        const textW = measure.measureText(text).width;
        width = Math.max(width, MARGIN + CHIP_W + 16 + Math.ceil(textW) + MARGIN);

        let slots = null;
        let pillW = 0;
        let contentH;
        if (rule.perks) {
            // Subset icon row (no "+" between icons). Each icon sits in a slot at
            // least as wide as its name so labels never collide with the neighbour.
            measure.font = '400 12pt sans-serif';
            let rowW = MARGIN * 2;
            slots = rule.perks.map(p => {
                const nameW = measure.measureText(p.name).width;
                const slotW = Math.max(COMBO_ICON, Math.ceil(nameW) + 8);
                rowW += slotW + REP_ICON_GAP;
                return { perk: p, slotW };
            });
            rowW -= REP_ICON_GAP; // no trailing gap after the last icon
            width = Math.max(width, rowW);
            contentH = COMBO_ICON + COMBO_NAME_H;
        } else {
            measure.font = '700 12pt sans-serif';
            pillW = Math.ceil(measure.measureText('ALL PERKS').width) + 28;
            width = Math.max(width, MARGIN * 2 + pillW);
            contentH = REP_PILL_H;
        }

        rules.push({ ...rule, meta, text, slots, pillW, contentH });
    }

    // Height: section gap + divider + title + subtitle, then per rule a chip header
    // and its content row.
    let height = COMBO_SECTION_GAP + 2 + 16 + 40 + 24 + 8;
    for (const r of rules) {
        height += 12 + 30 + 10;
        height += r.contentH + COMBO_ROW_GAP;
    }

    return { rules, width, height };
}

/**
 * Draw the repetition-limit section starting at `startY`. `iconMap` maps perk id ->
 * loaded Image (or null). Mirrors drawComboSection; the caller sizes the canvas from
 * the matching buildRepetitionLayout() result.
 */
function drawRepetitionSection(ctx, layout, startY, iconMap, width) {
    let y = startY + COMBO_SECTION_GAP;

    // Divider between the previous section and this one
    ctx.strokeStyle = '#2a2833';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(MARGIN, y + 1);
    ctx.lineTo(width - MARGIN, y + 1);
    ctx.stroke();
    y += 2 + 16;

    // Title + subtitle
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 22pt sans-serif';
    ctx.fillText('Repetition Limits', MARGIN, y);
    y += 40;
    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.fillText('how many survivors may bring the same perk', MARGIN, y);
    y += 24 + 8;

    for (const rule of layout.rules) {
        y += 12;
        const chipH = 30;
        drawScopeChip(ctx, MARGIN, y, CHIP_W, chipH, rule.meta.color, rule.meta.label);
        ctx.font = '400 14pt sans-serif';
        ctx.fillStyle = '#cccccc';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(rule.text, MARGIN + CHIP_W + 16, y + chipH / 2);
        ctx.textBaseline = 'top';
        y += chipH + 10;

        if (rule.perks) {
            let x = MARGIN;
            const iconY = y;
            rule.slots.forEach(slot => {
                const cx = x + slot.slotW / 2;
                const ix = Math.round(cx - COMBO_ICON / 2);
                const img = iconMap.get(slot.perk.id);
                if (img) {
                    ctx.drawImage(img, ix, iconY, COMBO_ICON, COMBO_ICON);
                } else {
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(ix, iconY, COMBO_ICON, COMBO_ICON);
                }
                ctx.font = '400 12pt sans-serif';
                ctx.fillStyle = '#dddddd';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(slot.perk.name, Math.round(cx), iconY + COMBO_ICON + 4);
                x += slot.slotW + REP_ICON_GAP;
            });
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
        } else {
            // "ALL PERKS" pill in the slot where icons would otherwise sit
            ctx.fillStyle = '#2a2833';
            roundRectPath(ctx, MARGIN, y, rule.pillW, REP_PILL_H, 6);
            ctx.fill();
            ctx.fillStyle = '#cccccc';
            ctx.font = '700 12pt sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('ALL PERKS', MARGIN + rule.pillW / 2, y + REP_PILL_H / 2 + 1);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
        }
        y += rule.contentH + COMBO_ROW_GAP;
    }
}

async function renderSheet(killer, allowedPerks, sideLabel, killerSlug, columns, outDir, balancing, dateLabel, comboBans, repetitionLimits) {
    const count = allowedPerks.length;
    const rows  = count > 0 ? Math.ceil(count / columns) : 0;
    const gridW = columns * ICON + (columns - 1) * GAP;
    const gridH = rows > 0 ? rows * ICON + (rows - 1) * GAP : 0;
    // When nothing is allowed we still reserve a line for the "None allowed" note
    // so the combo section (if any) does not overlap it.
    const noteH = count === 0 ? 40 : 0;

    // Load the portrait up front so its width feeds into the layout below
    // (loadImage needs no canvas, so this can run before the canvas is sized).
    const portraitPath = portraitPng(killer);
    let portraitImg = null;
    try {
        portraitImg = await loadImage(portraitPath);
    } catch (e) {
        // fallback: no portrait
    }

    const portraitH = HEADER_H - MARGIN;
    const portraitW = portraitImg
        ? Math.round((portraitImg.width / portraitImg.height) * portraitH)
        : 0;
    const textX = portraitImg ? MARGIN + portraitW + 16 : MARGIN;

    const isSurvivorSheet = sideLabel === 'Allowed Survivor Perks';
    const titleText = isSurvivorSheet ? `Going against: ${killer.Name}` : killer.Name;

    // Width: max of the perk grid and the header text (title block + right-aligned
    // provenance), so the header is never clipped on narrow grids.
    const bodyWidth = MARGIN * 2 + gridW;
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = '700 30pt sans-serif';
    const titleW = measure.measureText(titleText).width;
    measure.font = '400 18pt sans-serif';
    const subW = measure.measureText(sideLabel).width;
    measure.font = '400 16pt sans-serif';
    const countW = measure.measureText(`(${count} perks)`).width;
    const comboCount = comboBans ? comboBans.length : 0;
    const comboCountW = comboCount
        ? measure.measureText(`(${comboCount} combination ban${comboCount === 1 ? '' : 's'})`).width
        : 0;
    const repCount = repetitionLimits ? repetitionLimits.length : 0;
    measure.font = '400 14pt sans-serif';
    const repCountW = repCount
        ? measure.measureText(`(${repCount} repetition limit${repCount === 1 ? '' : 's'})`).width
        : 0;
    measure.font = '400 16pt sans-serif';
    const leftMaxW = Math.max(titleW, subW, countW, comboCountW, repCountW);
    measure.font = '400 13pt sans-serif';
    const genW = measure.measureText(`Generated: ${dateLabel}`).width;
    const balW = balancing ? measure.measureText(`Balancing: ${balancing}`).width : 0;
    const metaMaxW = Math.max(genW, balW);

    // Combination-ban section layout (null when there are no combos)
    const comboLayout = buildComboLayout(comboBans, measure);
    const comboH = comboLayout ? comboLayout.height : 0;
    const comboW = comboLayout ? comboLayout.width : 0;

    // Repetition-limit section layout (null when there are no limits)
    const repLayout = buildRepetitionLayout(repetitionLimits, measure);
    const repH = repLayout ? repLayout.height : 0;
    const repW = repLayout ? repLayout.width : 0;

    const leftNeed = textX + leftMaxW + MARGIN;
    const metaNeed = textX + metaMaxW + MARGIN; // textX floor also clears the portrait
    const width = Math.ceil(Math.max(bodyWidth, leftNeed, metaNeed, comboW, repW));

    const height = HEADER_H + noteH + gridH + MARGIN * 2 + comboH + repH;

    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    // --- Header ---
    if (portraitImg) {
        // Top-align the portrait with the killer name (both at MARGIN); its left
        // edge already sits at MARGIN, in line with the first perk-icon column.
        ctx.drawImage(portraitImg, MARGIN, MARGIN, portraitW, portraitH);
    }

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 30pt sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(titleText, textX, MARGIN);

    ctx.font = '400 18pt sans-serif';
    ctx.fillText(sideLabel, textX, MARGIN + 46);

    ctx.font = '400 16pt sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`(${count} perks)`, textX, MARGIN + 84);
    if (repCount) {
        ctx.font = '400 14pt sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText(
            `(${repCount} repetition limit${repCount === 1 ? '' : 's'})`,
            textX, MARGIN + 116
        );
    }
    if (comboCount) {
        ctx.font = '400 14pt sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText(
            `(${comboCount} combination ban${comboCount === 1 ? '' : 's'})`,
            textX, MARGIN + (repCount ? 140 : 116)
        );
    }

    // Provenance: balancing ruleset + generation timestamp, bottom-aligned to portrait
    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const metaRight = width - MARGIN;
    ctx.fillText(`Generated: ${dateLabel}`, metaRight, HEADER_H);
    if (balancing) {
        ctx.fillText(`Balancing: ${balancing}`, metaRight, HEADER_H - 22);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (count === 0) {
        ctx.fillStyle = '#888888';
        ctx.font = '400 16pt sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('None allowed', MARGIN, HEADER_H + MARGIN);
    } else {
        // --- Perk grid ---
        // Preload all icons
        const iconPaths = allowedPerks.map(p => perkIconPng(p));
        const iconImages = await Promise.allSettled(iconPaths.map(p => loadImage(p)));

        for (let i = 0; i < allowedPerks.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            const x   = MARGIN + col * (ICON + GAP);
            const y   = HEADER_H + MARGIN + row * (ICON + GAP);

            const result = iconImages[i];
            if (result.status === 'fulfilled') {
                ctx.drawImage(result.value, x, y, ICON, ICON);
            } else {
                // Draw placeholder box
                ctx.fillStyle = '#333333';
                ctx.fillRect(x, y, ICON, ICON);
            }
        }
    }

    // --- Repetition-limit section (directly below the grid / note) ---
    if (repLayout) {
        // Preload subset icons (deduped by perk id; all-perks rules have no icons)
        const repPerks = [...new Map(
            repetitionLimits.flatMap(r => r.perks || []).map(p => [p.id, p])
        ).values()];
        const repIconResults = await Promise.allSettled(
            repPerks.map(p => loadImage(perkIconPng(p)))
        );
        const iconMap = new Map();
        repPerks.forEach((p, i) => {
            const r = repIconResults[i];
            iconMap.set(p.id, r.status === 'fulfilled' ? r.value : null);
        });

        const sectionStartY = HEADER_H + MARGIN + noteH + gridH;
        drawRepetitionSection(ctx, repLayout, sectionStartY, iconMap, width);
    }

    // --- Combination-ban section (below the repetition section) ---
    if (comboLayout) {
        // Preload combo icons (deduped by perk id)
        const comboPerks = [...new Map(
            comboBans.flatMap(c => c.perks).map(p => [p.id, p])
        ).values()];
        const comboIconResults = await Promise.allSettled(
            comboPerks.map(p => loadImage(perkIconPng(p)))
        );
        const iconMap = new Map();
        comboPerks.forEach((p, i) => {
            const r = comboIconResults[i];
            iconMap.set(p.id, r.status === 'fulfilled' ? r.value : null);
        });

        const sectionStartY = HEADER_H + MARGIN + noteH + gridH + repH;
        drawComboSection(ctx, comboLayout, sectionStartY, iconMap, width);
    }

    const sidePart = sideLabel === 'Allowed Killer Perks' ? 'killer' : 'survivor';
    const outFile  = path.join(outDir, `${killerSlug}-${sidePart}-perks.png`);
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

// ---------------------------------------------------------------------------
// Preset compilation
// ---------------------------------------------------------------------------
function buildPreset(results, name, balancing, generatedISO) {
    // NOTE: combination bans (survivorComboBans / killerComboBans) and repetition
    // limits (survivorRepetitionLimits) are intentionally image-only and are NOT
    // emitted here — the live checker has no duo/team scope and its only repetition
    // surface is the top-level MaxPerkRepetition (no per-subset/scope concept), so
    // they would have no enforcement path. The preset carries individual bans only.
    const killerOverrides = results.map(r => {
        // Start from a deep copy of the template (so all fields are present)
        const entry = JSON.parse(JSON.stringify(OVERRIDE_TEMPLATE));

        // Reset everything to sane empty defaults
        entry.Name                   = r.killer.Name;
        entry.KillerNotes            = '';
        entry.IsDisabled             = false;
        entry.Map                    = [];
        entry.BalanceTiers           = [0];
        entry.SurvivorBalanceTiers   = [0];
        entry.AntiFacecampPermitted  = false;
        entry.KillerComboPerkBans    = [];
        entry.SurvivorComboPerkBans  = [];
        entry.SurvivorWhitelistedPerks       = [];
        entry.SurvivorWhitelistedComboPerks  = [];
        entry.KillerWhitelistedPerks         = [];
        entry.KillerWhitelistedComboPerks    = [];
        entry.AddonTiersBanned       = [];
        entry.IndividualAddonBans    = [];
        entry.ItemWhitelist          = [];
        entry.AddonWhitelist         = {
            Firecracker: { Addons: [] },
            Flashlight:  { Addons: [] },
            'Med-Kit':   { Addons: [] },
            Toolbox:     { Addons: [] },
            Key:         { Addons: [] },
            Map:         { Addons: [] },
        };
        entry.SurvivorOfferings = [];
        entry.KillerOfferings   = [];

        // Compute bans = universe - allowed
        const killerUniverse = allPerks.filter(p => !p.survivorPerk);
        const survivorUniverse = allPerks.filter(p => p.survivorPerk);

        const allowedKillerIds   = new Set(r.allowedKiller.map(p => p.id));
        const allowedSurvivorIds = new Set(r.allowedSurvivor.map(p => p.id));

        entry.KillerIndvPerkBans   = killerUniverse
            .filter(p => !allowedKillerIds.has(p.id))
            .map(p => String(p.id));
        entry.SurvivorIndvPerkBans = survivorUniverse
            .filter(p => !allowedSurvivorIds.has(p.id))
            .map(p => String(p.id));

        return entry;
    });

    return {
        Name: name,
        Balancing: balancing || '',
        GeneratedDate: generatedISO,
        MaxPerkRepetition: 1,
        GlobalNotes: '',
        Tiers: [
            {
                Name: 'General',
                SurvivorIndvPerkBans: [],
                SurvivorComboPerkBans: [],
                KillerIndvPerkBans: [],
                KillerComboPerkBans: [],
            },
        ],
        KillerOverride: killerOverrides,
    };
}

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------
async function processFile(filePath, columns) {
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

    // Resolve killer
    if (!doc.killer) fatal(`Missing "killer" field in "${filePath}".`);
    const killerKey = normalize(doc.killer);
    const killer = killerLookup.get(killerKey);
    if (!killer) {
        fatal(
            `Unknown killer "${doc.killer}" in file "${filePath}". ` +
            `No matching entry in Killers.json.`
        );
    }

    // Balancing ruleset label (optional)
    const balancing = (doc.balancing == null) ? '' : String(doc.balancing).trim();

    // Universe declarations
    const universeKiller   = doc.universe && doc.universe.killer   !== undefined ? doc.universe.killer   : 'all';
    const universeSurvivor = doc.universe && doc.universe.survivor !== undefined ? doc.universe.survivor : 'all';

    // Resolve both sides
    const allowedKiller   = resolveSide(doc.killerPerks,   universeKiller,   false, filePath);
    const allowedSurvivor = resolveSide(doc.survivorPerks, universeSurvivor, true,  filePath);

    // Resolve combination bans (image-only; not written into the preset)
    const survivorCombos = resolveComboBans(doc.survivorComboBans, true,  allowedSurvivor, filePath);
    const killerCombos   = resolveComboBans(doc.killerComboBans,   false, allowedKiller,   filePath);

    // Resolve repetition limits (survivor side only; image-only, like combos)
    const repetitionLimits = resolveRepetitionLimits(doc.survivorRepetitionLimits, allowedSurvivor, filePath);

    return { killer, allowedKiller, allowedSurvivor, balancing, survivorCombos, killerCombos, repetitionLimits };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.files.length === 0) {
        console.log(
            'Usage: node perk-sheet-generator.js <file.yaml...>\n' +
            '       [--asset-root <dir>] [--out <dir>] [--columns <n>]\n' +
            '       [--preset <out.json>] [--name "<name>"]'
        );
        process.exit(0);
    }

    // Output dir: explicit --out, otherwise next to each input file (per-file).
    const outDirOverride = args.outDir ? path.resolve(args.outDir) : null;

    // Stamp the generation time once so a batch shares a consistent timestamp
    const generatedAt = new Date();
    const generatedISO = generatedAt.toISOString();
    const dateLabel = generatedISO.slice(0, 10);

    const results = [];

    for (const filePath of args.files) {
        const absPath = path.resolve(filePath);
        const result = await processFile(absPath, args.columns);
        const { killer, allowedKiller, allowedSurvivor, balancing, survivorCombos, killerCombos, repetitionLimits } = result;

        const outDir = outDirOverride || path.dirname(absPath);
        fs.mkdirSync(outDir, { recursive: true });

        // Killer slug for filenames
        const killerSlug = killer.Name.replace(/\s+/g, '-');

        // Render killer-side sheet (repetition limits are survivor-only → null)
        const killerOut = await renderSheet(
            killer, allowedKiller, 'Allowed Killer Perks',
            killerSlug, args.columns, outDir, balancing, dateLabel, killerCombos, null
        );

        // Render survivor-side sheet
        const survivorOut = await renderSheet(
            killer, allowedSurvivor, 'Allowed Survivor Perks',
            killerSlug, args.columns, outDir, balancing, dateLabel, survivorCombos, repetitionLimits
        );

        console.log(
            `[${killer.Name}]\n` +
            `  Allowed killer perks  : ${allowedKiller.length}\n` +
            `  Allowed survivor perks: ${allowedSurvivor.length}\n` +
            `  Killer sheet  → ${killerOut}\n` +
            `  Survivor sheet→ ${survivorOut}`
        );

        results.push(result);
    }

    // Compile preset if requested
    if (args.presetPath) {
        const presetBalancing = results.find(r => r.balancing)?.balancing || '';
        const preset = buildPreset(results, args.presetName, presetBalancing, generatedISO);
        const presetAbs = path.resolve(args.presetPath);
        fs.writeFileSync(presetAbs, JSON.stringify(preset, null, 4), 'utf8');
        console.log(`\nPreset written → ${presetAbs}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

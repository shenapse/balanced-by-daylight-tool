#!/usr/bin/env node
'use strict';

/**
 * item-sheet-generator.js
 *
 * Reads a YAML file describing one killer's allowed *survivor items* (per item
 * type, with per-variant and per-add-on allow/deny), produces one PNG sheet
 * (one row per allowed item variant, showing that variant + its type's allowed
 * add-ons), and optionally compiles a BbD balancing-preset JSON when --preset
 * is passed.
 *
 * Items are survivor-only; there is no killer side. Killer power add-ons are out
 * of scope (this tool only deals with `ItemWhitelist` + `AddonWhitelist`).
 *
 * Usage:
 *   node utilities/item-sheet-generator/item-sheet-generator.js <file.yaml...>
 *        [--asset-root <dir>] [--out <dir>] [--preset <out.json>] [--name "<name>"]
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
const ITEMS_FILE   = path.join(REPO_ROOT, 'public', 'Items.json');
const KILLERS_FILE = path.join(REPO_ROOT, 'public', 'Killers.json');
const DEBUG_PRESET = path.join(REPO_ROOT, 'public', 'BalancingPresets', 'DEBUG.json');
const PNG_ITEMS     = path.join(REPO_ROOT, 'canvas-image-library', 'Items');
const PNG_ADDONS    = path.join(REPO_ROOT, 'canvas-image-library', 'Addons');
const PNG_PORTRAITS = path.join(REPO_ROOT, 'canvas-image-library', 'Portraits');

// ---------------------------------------------------------------------------
// Rarity
// ---------------------------------------------------------------------------
const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Ultra Rare', 'Event'];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const ITEM_ICON  = 96;   // px per item-variant icon
const ADDON_ICON = 56;   // px per add-on icon
const GAP        = 12;   // px between icons
const ROW_GAP    = 16;   // px between rows
const MARGIN     = 32;   // outer margin
const HEADER_H   = 210;  // header height (room for the per-survivor legend line)
const ROW_H      = ITEM_ICON;
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';

// Header legend clarifying that the grid is a per-survivor candidate pool: each
// survivor equips exactly ONE item, chosen from the allowed items shown below.
const LEGEND_TEXT = 'Each survivor brings one item, chosen from the pool below.';

// Item-type section headers drawn within the grid
const TYPE_HEADER_H = 38;  // height reserved for a type name + its underline rule
const GROUP_GAP     = 14;  // extra vertical gap between item-type groups

// Limit sections (duplicate / pick), rendered below the item grid. These mirror the
// perk-sheet-generator's section styling for cross-tool visual consistency.
const LIMIT_ICON        = 72;   // px per item icon inside a limit rule
const LIMIT_ICON_GAP    = 24;   // horizontal gap between limit-rule icons
const LIMIT_NAME_H      = 22;   // height reserved for the item name under an icon
const LIMIT_ROW_GAP     = 20;   // vertical gap between limit rules
const LIMIT_SECTION_GAP = 28;   // gap between the grid and a limit section
const LIMIT_PILL_H      = 34;   // height of the "ALL ITEMS" pill
const CHIP_W            = 156;  // width of the scope chip

// Per-scope presentation: chip label + colour. Items are survivor-only and each
// survivor brings a single item, so only team/duo scopes apply (a per-survivor item
// limit would be vacuous). Warmer colour = stricter scope.
const SCOPE_META = {
    duo:  { label: 'DUO',        color: '#e8823a' },
    team: { label: 'WHOLE TEAM', color: '#e5484d' },
};
const SCOPE_ORDER = ['duo', 'team'];
function scopeRank(scope) {
    const i = SCOPE_ORDER.indexOf(scope);
    return i === -1 ? SCOPE_ORDER.length : i;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
const itemsData   = JSON.parse(fs.readFileSync(ITEMS_FILE,   'utf8'));
const allKillers  = JSON.parse(fs.readFileSync(KILLERS_FILE, 'utf8'));
const debugPreset = JSON.parse(fs.readFileSync(DEBUG_PRESET, 'utf8'));

const ITEM_TYPES = itemsData.ItemTypes;  // [{ id, Name, Addons:[{id,Name,icon}] }]
const ITEM_VARIANTS = itemsData.Items;   // [{ id, Name, Type, icon }]

// Pull the first KillerOverride entry as a template for the compile step
const OVERRIDE_TEMPLATE = debugPreset.KillerOverride[0];

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------
function normalize(str) {
    return String(str)
        .toLowerCase()
        .replace(/[\s\-_'.&]+/g, '');
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

// Map normalized type name -> ItemType object
const typeByName = new Map(ITEM_TYPES.map(t => [normalize(t.Name), t]));

/** Build a normalized-name -> object lookup over a list of {Name} entries. */
function buildNameLookup(list) {
    const map = new Map();
    for (const o of list) {
        const n = normalize(o.Name);
        if (!map.has(n)) map.set(n, o);
    }
    return map;
}

// Normalized item-variant name -> variant object (over the full universe). Used to
// resolve item-limit selectors and to distinguish an unknown name (fatal) from a
// name that is simply not in this sheet's allowed pool (warn + skip).
const allVariantByName = buildNameLookup(ITEM_VARIANTS);

function rarityToIndex(value, filePath) {
    if (typeof value === 'number') {
        if (value >= 0 && value < RARITY_NAMES.length) return value;
        fatal(`Rarity index ${value} out of range (0–${RARITY_NAMES.length - 1}) in "${filePath}".`);
    }
    const norm = normalize(value);
    const idx = RARITY_NAMES.findIndex(n => normalize(n) === norm);
    if (idx === -1) {
        fatal(`Unknown rarity "${value}" in "${filePath}". Expected one of: ${RARITY_NAMES.join(', ')} (or a 0–5 index).`);
    }
    return idx;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        files: [],
        outDir: null,
        presetPath: null,
        presetName: 'Generated Item Allow-List',
    };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--out' && argv[i + 1]) {
            args.outDir = argv[++i];
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
// Allow/deny resolution
// ---------------------------------------------------------------------------
/**
 * Resolve which entries of `universe` are allowed.
 * @param {Object} cfg       - { default, allow, deny } block (may be undefined)
 * @param {Array}  universe  - array of {id, Name} objects
 * @param {string} fallbackDefault - 'allow' | 'deny' used when cfg.default is absent
 * @param {string} label     - for error messages, e.g. 'Flashlight variant'
 * @param {string} filePath  - for error messages
 * @returns {Array} allowed entries, sorted by Name
 */
function resolveAllowList(cfg, universe, fallbackDefault, label, filePath) {
    const lookup = buildNameLookup(universe);

    const defaultVal = (cfg && cfg.default) || fallbackDefault;
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" (${label}) in file "${filePath}".`);
    }

    const allowed = new Map(); // id -> entry
    if (defaultVal === 'allow') {
        for (const e of universe) allowed.set(e.id, e);
    }

    // Returns an array of matching entries (one for a name string, many for {rarity:}).
    const resolveSels = (sel) => {
        if (typeof sel === 'string') {
            const e = lookup.get(normalize(sel));
            if (!e) fatal(`Unknown ${label} "${sel}" in file "${filePath}".`);
            return [e];
        }
        if (typeof sel === 'object' && sel !== null && sel.rarity !== undefined) {
            const idx = rarityToIndex(sel.rarity, filePath);
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

    return [...allowed.values()].sort((a, b) => a.Name.localeCompare(b.Name));
}

/**
 * Resolve a whole file into per-type allowed variants + allowed add-ons.
 * @returns {{ killer, types: Array<{type, allowedVariants, allowedAddons}> }}
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

    // Resolve killer
    if (!doc.killer) fatal(`Missing "killer" field in "${filePath}".`);
    const killer = killerLookup.get(normalize(doc.killer));
    if (!killer) {
        fatal(`Unknown killer "${doc.killer}" in file "${filePath}". No matching entry in Killers.json.`);
    }

    // Balancing ruleset label (optional)
    const balancing = (doc.balancing == null) ? '' : String(doc.balancing).trim();

    const topDefault = doc.default || 'deny';
    if (topDefault !== 'allow' && topDefault !== 'deny') {
        fatal(`Top-level "default" must be "allow" or "deny" in file "${filePath}".`);
    }

    const itemsCfg = doc.items || {};

    // Error on unknown item-type keys
    for (const key of Object.keys(itemsCfg)) {
        if (!typeByName.has(normalize(key))) {
            fatal(`Unknown item type "${key}" in file "${filePath}".`);
        }
    }

    const types = ITEM_TYPES.map(type => {
        // Find this type's config block by normalized name match
        let typeCfg;
        for (const [key, val] of Object.entries(itemsCfg)) {
            if (normalize(key) === normalize(type.Name)) { typeCfg = val; break; }
        }

        const variantUniverse = ITEM_VARIANTS.filter(v => v.Type === type.Name);
        const typeDefault = (typeCfg && typeCfg.default) || topDefault;

        const allowedVariants = resolveAllowList(
            typeCfg, variantUniverse, topDefault, `${type.Name} variant`, filePath
        );

        // Add-on default falls back to this type's variant default, then top default
        const addonsCfg = typeCfg && typeCfg.addons;
        const allowedAddons = resolveAllowList(
            addonsCfg, type.Addons, typeDefault, `${type.Name} add-on`, filePath
        );

        return { type, allowedVariants, allowedAddons };
    });

    // Item limits (image-only: rendered on the sheet, never written to the preset).
    const limits = parseItemLimits(doc, types, filePath);

    return { killer, types, balancing, limits };
}

// ---------------------------------------------------------------------------
// Asset path resolution
// ---------------------------------------------------------------------------
function pngFromIcon(baseDir, iconPath) {
    const basename = path.basename(iconPath).replace(/\.webp$/i, '.png');
    return path.join(baseDir, basename);
}

function portraitPng(killer) {
    const candidate = pngFromIcon(PNG_PORTRAITS, killer.Portrait || '');
    if (fs.existsSync(candidate)) return candidate;
    return path.join(PNG_PORTRAITS, 'Blank.png');
}

/** Preload item-variant icons into an id -> Image (or null) map. */
async function loadItemIconMap(variants) {
    const uniq = [...new Map(variants.map(v => [v.id, v])).values()];
    const results = await Promise.allSettled(uniq.map(v => loadImage(pngFromIcon(PNG_ITEMS, v.icon))));
    const map = new Map();
    uniq.forEach((v, i) => map.set(v.id, results[i].status === 'fulfilled' ? results[i].value : null));
    return map;
}

// ---------------------------------------------------------------------------
// Item limits (image-only) — parsing, classification, and plain-English wording
// ---------------------------------------------------------------------------
// Both limit families reduce to one generalized IR entry { scope, count, max, items }:
//   count 'perPerk' -> each item may be brought by at most `max` survivors  (DUPLICATE)
//   count 'total'   -> the scope group may bring at most `max` of `items`   (PICK)
// `items` is null for a duplicate limit that covers every allowed item ("all"); otherwise
// it is a resolved list of item-variant objects. classifyItemLimits() sorts each family by
// scope and drops vacuous pick limits. Limits are rendered on the sheet but never written
// to the --preset JSON (only the allow-lists feed the preset).

/** Reduce IR limit entries into the concrete { duplicate, pick } render buckets. */
function classifyItemLimits(limits, filePath) {
    const duplicate = [];
    const pick = [];
    for (const lim of limits) {
        if (lim.count === 'perPerk') {
            duplicate.push(lim);
            continue;
        }
        // count === 'total' (pick limit): needs an explicit, non-vacuous item set.
        const len = (lim.items || []).length;
        if (len < 2) {
            console.warn(
                `WARNING: a pick limit (scope "${lim.scope}") in "${filePath}" resolves to ` +
                `${len} allowed item(s); a pick limit needs at least 2; skipping.`
            );
            continue;
        }
        if (lim.max >= len) {
            console.warn(
                `WARNING: a pick limit (scope "${lim.scope}", max ${lim.max}) over ${len} items in ` +
                `"${filePath}" is vacuous (max is at least the number of items); skipping.`
            );
            continue;
        }
        pick.push(lim);
    }
    const byScope = (a, b) => scopeRank(a.scope) - scopeRank(b.scope);
    duplicate.sort(byScope);
    pick.sort(byScope);
    return { duplicate, pick };
}

/** Rule sentence for one pick limit, keyed off scope and max. */
function itemPickRuleText(rule) {
    const atMost = rule.max === 1 ? 'at most one' : `at most ${rule.max}`;
    switch (rule.scope) {
        case 'duo':  return `Each duo may bring ${atMost} of these items between its two members.`;
        case 'team': return `The team may bring ${atMost} of these items.`;
        default:     return `${atMost.charAt(0).toUpperCase()}${atMost.slice(1)} of these items may be brought.`;
    }
}

/** Rule sentence for one duplicate limit; "listed" distinguishes subset from all-items. */
function itemDuplicateRuleText(rule) {
    const listed = rule.items ? ' listed' : '';
    if (rule.scope === 'duo') {
        if (rule.max === 1) return `Duo partners may not both bring the same${listed} item.`;
        return `At most ${rule.max} duo members may bring any single${listed} item.`;
    }
    // team
    if (rule.max === 1) return `No two survivors may bring the same${listed} item.`;
    return `At most ${rule.max} survivors may bring any single${listed} item.`;
}

/**
 * Parse the two optional top-level limit keys into classified { duplicate, pick } buckets.
 * Selectors reference the *allowed pool*: a plain string is an item-variant name; a
 * { type: <TypeName> } object expands to all allowed variants of that type (this also
 * disambiguates a variant named like its type, e.g. the "Flashlight" variant vs. type).
 */
function parseItemLimits(doc, types, filePath) {
    const dupRaw  = doc.itemDuplicateLimits;
    const pickRaw = doc.itemPickLimits;
    if (dupRaw !== undefined && !Array.isArray(dupRaw)) {
        fatal(`"itemDuplicateLimits" must be a list in "${filePath}".`);
    }
    if (pickRaw !== undefined && !Array.isArray(pickRaw)) {
        fatal(`"itemPickLimits" must be a list in "${filePath}".`);
    }

    // Allowed-pool lookups built from the already-resolved types.
    const allowedById   = new Set();
    const allowedByType = new Map(); // normalized type name -> [allowed variant]
    for (const { type, allowedVariants } of types) {
        allowedByType.set(normalize(type.Name), allowedVariants);
        for (const v of allowedVariants) allowedById.add(v.id);
    }

    // Resolve one selector to its allowed variant object(s). Unknown names/types are
    // fatal; a known-but-banned variant is warned about and contributes nothing.
    const resolveSelector = (sel) => {
        if (typeof sel === 'string') {
            const v = allVariantByName.get(normalize(sel));
            if (!v) {
                // A plain string is a variant name; if it matches an item TYPE instead,
                // point the author at the {type: ...} selector.
                const hint = typeByName.has(normalize(sel))
                    ? ` (did you mean the whole type? use { type: ${sel} })`
                    : '';
                fatal(`Unknown item "${sel}" in a limit in file "${filePath}"${hint}.`);
            }
            if (!allowedById.has(v.id)) {
                console.warn(
                    `WARNING: a limit in "${filePath}" references "${v.Name}", which is not in the ` +
                    `allowed pool; dropping it from that limit.`
                );
                return [];
            }
            return [v];
        }
        if (typeof sel === 'object' && sel !== null && sel.type !== undefined) {
            const nt = normalize(sel.type);
            if (!typeByName.has(nt)) fatal(`Unknown item type "${sel.type}" in a limit in file "${filePath}".`);
            return allowedByType.get(nt) || [];
        }
        fatal(
            `Invalid item-limit selector ${JSON.stringify(sel)} in file "${filePath}". ` +
            `Expected a plain item name or a {type: <TypeName>} object.`
        );
    };

    // Resolve a selector list to a de-duplicated, name-sorted array of allowed variants.
    const resolveList = (selectors) => {
        const map = new Map();
        for (const sel of selectors) {
            for (const v of resolveSelector(sel)) map.set(v.id, v);
        }
        return [...map.values()].sort((a, b) => a.Name.localeCompare(b.Name));
    };

    const validateScopeMax = (entry, label) => {
        if (entry.scope !== 'duo' && entry.scope !== 'team') {
            fatal(
                `${label} in "${filePath}" has scope "${entry.scope}"; item limits support only ` +
                `"duo" or "team" (each survivor brings a single item, so a per-survivor limit is meaningless).`
            );
        }
        if (!Number.isInteger(entry.max) || entry.max < 1) {
            fatal(`${label} in "${filePath}" must have a positive integer "max".`);
        }
    };

    const irs = [];

    // Duplicate limits: "items" is "all"/omitted (whole pool) or an explicit list.
    for (const entry of (dupRaw || [])) {
        if (!entry || typeof entry !== 'object') fatal(`Each itemDuplicateLimits entry must be a mapping in "${filePath}".`);
        validateScopeMax(entry, 'An itemDuplicateLimits entry');
        let itemsResolved = null; // null = every allowed item
        if (entry.items !== undefined && entry.items !== 'all' && entry.items !== null) {
            if (!Array.isArray(entry.items)) fatal(`itemDuplicateLimits "items" must be "all" or a list in "${filePath}".`);
            itemsResolved = resolveList(entry.items);
            if (itemsResolved.length === 0) {
                console.warn(`WARNING: an itemDuplicateLimits entry in "${filePath}" resolves to no allowed items; skipping.`);
                continue;
            }
        }
        irs.push({ scope: entry.scope, count: 'perPerk', max: entry.max, items: itemsResolved });
    }

    // Pick limits: "items" is a required list of 2+ selectors.
    for (const entry of (pickRaw || [])) {
        if (!entry || typeof entry !== 'object') fatal(`Each itemPickLimits entry must be a mapping in "${filePath}".`);
        validateScopeMax(entry, 'An itemPickLimits entry');
        if (!Array.isArray(entry.items) || entry.items.length < 2) {
            fatal(`An itemPickLimits entry in "${filePath}" must list at least 2 items under "items".`);
        }
        irs.push({ scope: entry.scope, count: 'total', max: entry.max, items: resolveList(entry.items) });
    }

    return classifyItemLimits(irs, filePath);
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
 * Body layout: each item-type group renders a type header followed by one row per allowed
 * variant. Returns positioned elements (y relative to the body top) plus the total bodyH,
 * so the canvas can be sized and the body drawn from one shared computation.
 */
function computeBodyLayout(groups) {
    const elements = [];
    let y = 0;
    groups.forEach((g, gi) => {
        if (gi > 0) y += GROUP_GAP;
        elements.push({ kind: 'header', typeName: g.typeName, y });
        y += TYPE_HEADER_H;
        g.variants.forEach((variant, vi) => {
            elements.push({ kind: 'row', variant, addons: g.addons, y });
            y += ROW_H;
            if (vi < g.variants.length - 1) y += ROW_GAP;
        });
    });
    return { elements, bodyH: y };
}

/**
 * Build a draw-ready layout for one limit section (duplicate or pick), computing its total
 * height and the minimum width it needs. Each rule renders as a scope chip + rule sentence,
 * then either an icon row of the listed items or an "ALL ITEMS" pill (duplicate-all rules).
 * `measure` is a throwaway 2d context for text metrics. Returns null when there are no rules.
 */
function buildLimitLayout(rules, ruleTextFn, measure) {
    if (!rules || rules.length === 0) return null;

    const out = [];
    let width = 0;
    for (const rule of rules) {
        const meta = SCOPE_META[rule.scope];
        const text = ruleTextFn(rule);

        measure.font = '400 14pt sans-serif';
        const textW = measure.measureText(text).width;
        width = Math.max(width, MARGIN + CHIP_W + 16 + Math.ceil(textW) + MARGIN);

        let slots = null;
        let pillW = 0;
        let contentH;
        if (rule.items) {
            // Icon row (no "+" glyph). Each icon sits in a slot at least as wide as its
            // name so labels never collide with the neighbouring icon.
            measure.font = '400 12pt sans-serif';
            let rowW = MARGIN * 2;
            slots = rule.items.map(it => {
                const nameW = measure.measureText(it.Name).width;
                const slotW = Math.max(LIMIT_ICON, Math.ceil(nameW) + 8);
                rowW += slotW + LIMIT_ICON_GAP;
                return { item: it, slotW };
            });
            rowW -= LIMIT_ICON_GAP; // no trailing gap after the last icon
            width = Math.max(width, rowW);
            contentH = LIMIT_ICON + LIMIT_NAME_H;
        } else {
            measure.font = '700 12pt sans-serif';
            pillW = Math.ceil(measure.measureText('ALL ITEMS').width) + 28;
            width = Math.max(width, MARGIN * 2 + pillW);
            contentH = LIMIT_PILL_H;
        }

        out.push({ ...rule, meta, text, slots, pillW, contentH });
    }

    // Height: section gap + divider + title + subtitle, then per rule a chip header and
    // its content row.
    let height = LIMIT_SECTION_GAP + 2 + 16 + 40 + 24 + 8;
    for (const r of out) {
        height += 12 + 30 + 10;
        height += r.contentH + LIMIT_ROW_GAP;
    }

    return { rules: out, width, height };
}

/**
 * Draw one limit section starting at `startY`. `iconMap` maps variant id -> loaded Image
 * (or null). The caller sizes the canvas from the matching buildLimitLayout() result.
 */
function drawLimitSection(ctx, layout, startY, iconMap, width, title, subtitle) {
    let y = startY + LIMIT_SECTION_GAP;

    // Divider between the previous content and this section
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
    ctx.fillText(title, MARGIN, y);
    y += 40;
    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.fillText(subtitle, MARGIN, y);
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

        if (rule.slots) {
            let x = MARGIN;
            const iconY = y;
            rule.slots.forEach(slot => {
                const cx = x + slot.slotW / 2;
                const ix = Math.round(cx - LIMIT_ICON / 2);
                const img = iconMap.get(slot.item.id);
                if (img) {
                    ctx.drawImage(img, ix, iconY, LIMIT_ICON, LIMIT_ICON);
                } else {
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(ix, iconY, LIMIT_ICON, LIMIT_ICON);
                }
                ctx.font = '400 12pt sans-serif';
                ctx.fillStyle = '#dddddd';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.fillText(slot.item.Name, Math.round(cx), iconY + LIMIT_ICON + 4);
                x += slot.slotW + LIMIT_ICON_GAP;
            });
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
        } else {
            // "ALL ITEMS" pill in the slot where icons would otherwise sit
            ctx.fillStyle = '#2a2833';
            roundRectPath(ctx, MARGIN, y, rule.pillW, LIMIT_PILL_H, 6);
            ctx.fill();
            ctx.fillStyle = '#cccccc';
            ctx.font = '700 12pt sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('ALL ITEMS', MARGIN + rule.pillW / 2, y + LIMIT_PILL_H / 2 + 1);
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
        }
        y += rule.contentH + LIMIT_ROW_GAP;
    }
}

async function renderSheet(killer, types, killerSlug, outDir, balancing, dateLabel, limits) {
    // Classified render buckets (image-only). Rendered below the grid in this order:
    // duplicate limits -> pick limits.
    const duplicateLimits = (limits && limits.duplicate) || [];
    const pickLimits      = (limits && limits.pick)      || [];

    // Group allowed variants by item type (types with none are skipped), preserving
    // item-type order. Each group carries its type's allowed add-ons for the row strips.
    const groups = [];
    for (const { type, allowedVariants, allowedAddons } of types) {
        if (allowedVariants.length === 0) continue;
        groups.push({ typeName: type.Name, variants: allowedVariants, addons: allowedAddons });
    }

    const variantCount = groups.reduce((n, g) => n + g.variants.length, 0);
    const maxAddons = groups.reduce((m, g) => Math.max(m, g.addons.length), 0);

    // Body layout: a type header then one row per variant, per group.
    const bodyLayout = computeBodyLayout(groups);

    // Load the portrait up front so its width feeds into the layout below
    // (loadImage needs no canvas, so this can run before the canvas is sized).
    let portraitImg = null;
    try {
        portraitImg = await loadImage(portraitPng(killer));
    } catch (e) { /* fallback: no portrait */ }

    const portraitH = HEADER_H - MARGIN;
    const portraitW = portraitImg
        ? Math.round((portraitImg.width / portraitImg.height) * portraitH)
        : 0;
    const textX = portraitImg ? MARGIN + portraitW + 16 : MARGIN;

    // Body geometry
    const addonStripX = MARGIN + ITEM_ICON + GAP;
    const addonStripW = maxAddons > 0
        ? maxAddons * (ADDON_ICON + GAP) - GAP
        : 240; // room for the "(no add-ons allowed)" note
    const bodyWidth = addonStripX + addonStripW + MARGIN;

    // Header-text width: keep the canvas wide enough for the title block, the legend,
    // the restriction count-lines, and the right-aligned provenance so nothing clips.
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = '700 30pt sans-serif';
    const titleW = measure.measureText(`Going against: ${killer.Name}`).width;
    measure.font = '400 18pt sans-serif';
    const subW = measure.measureText('Allowed Items & Add-ons').width;
    measure.font = '400 14pt sans-serif';
    const legendW = measure.measureText(LEGEND_TEXT).width;
    measure.font = '400 16pt sans-serif';
    const countW = measure.measureText(`(${variantCount} items)`).width;
    measure.font = '400 14pt sans-serif';
    const repCount = duplicateLimits.length;
    const repCountW = repCount
        ? measure.measureText(`(${repCount} duplicate limit${repCount === 1 ? '' : 's'})`).width
        : 0;
    const pickCount = pickLimits.length;
    const pickCountW = pickCount
        ? measure.measureText(`(${pickCount} pick limit${pickCount === 1 ? '' : 's'})`).width
        : 0;
    const leftMaxW = Math.max(titleW, subW, legendW, countW, repCountW, pickCountW);
    measure.font = '400 13pt sans-serif';
    const genW = measure.measureText(`Generated: ${dateLabel}`).width;
    const balW = balancing ? measure.measureText(`Balancing: ${balancing}`).width : 0;
    const metaMaxW = Math.max(genW, balW);

    // Limit section layouts (null when a family is empty)
    const repLayout  = buildLimitLayout(duplicateLimits, itemDuplicateRuleText, measure);
    const pickLayout = buildLimitLayout(pickLimits, itemPickRuleText, measure);
    const repH  = repLayout  ? repLayout.height  : 0;
    const pickH = pickLayout ? pickLayout.height : 0;
    const repW  = repLayout  ? repLayout.width   : 0;
    const pickW = pickLayout ? pickLayout.width  : 0;

    const leftNeed = textX + leftMaxW + MARGIN;
    const metaNeed = textX + metaMaxW + MARGIN; // textX floor also clears the portrait
    const width = Math.ceil(Math.max(bodyWidth, leftNeed, metaNeed, repW, pickW));

    const height = HEADER_H + MARGIN + bodyLayout.bodyH + MARGIN + repH + pickH;

    const canvas = createCanvas(width, Math.max(height, HEADER_H + MARGIN * 2 + 40));
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // --- Header ---
    if (portraitImg) {
        // Top-align the portrait with the killer name (both at MARGIN); its left
        // edge already sits at MARGIN, in line with the item-variant icon column.
        ctx.drawImage(portraitImg, MARGIN, MARGIN, portraitW, portraitH);
    }

    ctx.fillStyle = TEXT_COLOR;
    ctx.textBaseline = 'top';
    ctx.font = '700 30pt sans-serif';
    // Items are always survivor-facing (survivors bring items against the killer)
    ctx.fillText(`Going against: ${killer.Name}`, textX, MARGIN);

    ctx.font = '400 18pt sans-serif';
    ctx.fillText('Allowed Items & Add-ons', textX, MARGIN + 46);

    // Legend: the grid is a per-survivor candidate pool, not a set brought all at once.
    ctx.font = '400 14pt sans-serif';
    ctx.fillStyle = '#bbbbbb';
    ctx.fillText(LEGEND_TEXT, textX, MARGIN + 80);

    ctx.font = '400 16pt sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`(${variantCount} items)`, textX, MARGIN + 106);

    // Restriction counts, stacked in render order (duplicate -> pick).
    let countLineY = MARGIN + 134;
    const drawCountLine = (n, singular) => {
        ctx.font = '400 14pt sans-serif';
        ctx.fillStyle = '#888888';
        ctx.fillText(`(${n} ${singular}${n === 1 ? '' : 's'})`, textX, countLineY);
        countLineY += 22;
    };
    if (repCount)  drawCountLine(repCount, 'duplicate limit');
    if (pickCount) drawCountLine(pickCount, 'pick limit');

    // Provenance: balancing ruleset + generation timestamp, bottom-aligned to portrait
    ctx.font = '400 13pt sans-serif';
    ctx.fillStyle = '#999999';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    const metaRight = canvas.width - MARGIN;
    ctx.fillText(`Generated: ${dateLabel}`, metaRight, HEADER_H);
    if (balancing) {
        ctx.fillText(`Balancing: ${balancing}`, metaRight, HEADER_H - 22);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    if (variantCount === 0) {
        ctx.fillStyle = '#888888';
        ctx.font = '400 16pt sans-serif';
        ctx.fillText('No items allowed', MARGIN, HEADER_H + MARGIN);
        const outFile = path.join(outDir, `${killerSlug}-items.png`);
        fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
        return outFile;
    }

    // Preload variant + add-on icons for every row element.
    const rowElements = bodyLayout.elements.filter(e => e.kind === 'row');
    const loaded = await Promise.all(rowElements.map(async (el) => {
        const variantImg = await loadImage(pngFromIcon(PNG_ITEMS, el.variant.icon)).catch(() => null);
        const addonImgs = await Promise.all(
            el.addons.map(a => loadImage(pngFromIcon(PNG_ADDONS, a.icon)).catch(() => null))
        );
        return { variantImg, addonImgs };
    }));
    const loadedByElement = new Map(rowElements.map((el, i) => [el, loaded[i]]));

    // --- Body (type headers + variant rows) ---
    const bodyTop = HEADER_H + MARGIN;
    for (const el of bodyLayout.elements) {
        const y = bodyTop + el.y;

        if (el.kind === 'header') {
            ctx.fillStyle = TEXT_COLOR;
            ctx.font = '700 16pt sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(el.typeName, MARGIN, y);
            // Thin rule under the type name, separating it from its rows.
            ctx.strokeStyle = '#2a2833';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(MARGIN, y + 28);
            ctx.lineTo(width - MARGIN, y + 28);
            ctx.stroke();
            continue;
        }

        // Item-variant icon
        const data = loadedByElement.get(el);
        if (data.variantImg) {
            ctx.drawImage(data.variantImg, MARGIN, y, ITEM_ICON, ITEM_ICON);
        } else {
            ctx.fillStyle = '#333333';
            ctx.fillRect(MARGIN, y, ITEM_ICON, ITEM_ICON);
        }

        // Add-on strip
        const ay = y + Math.round((ROW_H - ADDON_ICON) / 2);
        if (el.addons.length === 0) {
            ctx.fillStyle = '#888888';
            ctx.font = '400 13pt sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('(no add-ons allowed)', addonStripX, y + ROW_H / 2);
            ctx.textBaseline = 'top';
        } else {
            for (let j = 0; j < el.addons.length; j++) {
                const x = addonStripX + j * (ADDON_ICON + GAP);
                const img = data.addonImgs[j];
                if (img) {
                    ctx.drawImage(img, x, ay, ADDON_ICON, ADDON_ICON);
                } else {
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(x, ay, ADDON_ICON, ADDON_ICON);
                }
            }
        }
    }

    // --- Limit sections (below the grid) ---
    const gridBottom = bodyTop + bodyLayout.bodyH;
    if (repLayout) {
        const iconMap = await loadItemIconMap(duplicateLimits.flatMap(r => r.items || []));
        drawLimitSection(
            ctx, repLayout, gridBottom, iconMap, width,
            'Duplicate Limit', 'how many survivors may bring the same item'
        );
    }
    if (pickLayout) {
        const iconMap = await loadItemIconMap(pickLimits.flatMap(r => r.items || []));
        drawLimitSection(
            ctx, pickLayout, gridBottom + repH, iconMap, width,
            'Pick Limits', 'how many items you may choose from a group'
        );
    }

    const outFile = path.join(outDir, `${killerSlug}-items.png`);
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

// ---------------------------------------------------------------------------
// Preset compilation
// ---------------------------------------------------------------------------
function buildPreset(results, name, balancing, generatedISO) {
    const killerOverrides = results.map(({ killer, types }) => {
        const entry = JSON.parse(JSON.stringify(OVERRIDE_TEMPLATE));

        // Reset everything to sane empty defaults (this tool does not touch perks)
        entry.Name                  = killer.Name;
        entry.KillerNotes           = '';
        entry.IsDisabled            = false;
        entry.Map                   = [];
        entry.BalanceTiers          = [0];
        entry.SurvivorBalanceTiers  = [0];
        entry.AntiFacecampPermitted = false;
        entry.KillerIndvPerkBans    = [];
        entry.SurvivorIndvPerkBans  = [];
        entry.KillerComboPerkBans   = [];
        entry.SurvivorComboPerkBans = [];
        entry.SurvivorWhitelistedPerks      = [];
        entry.SurvivorWhitelistedComboPerks = [];
        entry.KillerWhitelistedPerks        = [];
        entry.KillerWhitelistedComboPerks   = [];
        entry.AddonTiersBanned      = [];
        entry.IndividualAddonBans   = [];
        entry.SurvivorOfferings     = [];
        entry.KillerOfferings       = [];

        // Item whitelist = allowed variant ids (numbers, sorted)
        const itemWhitelist = [];
        const addonWhitelist = {};
        for (const { type, allowedVariants, allowedAddons } of types) {
            for (const v of allowedVariants) itemWhitelist.push(v.id);
            addonWhitelist[type.Name] = {
                Addons: allowedAddons.map(a => a.id).sort((x, y) => x - y),
            };
        }
        itemWhitelist.sort((a, b) => a - b);

        entry.ItemWhitelist  = itemWhitelist;
        entry.AddonWhitelist = addonWhitelist;

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
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.files.length === 0) {
        console.log(
            'Usage: node item-sheet-generator.js <file.yaml...>\n' +
            '       [--asset-root <dir>] [--out <dir>] [--preset <out.json>] [--name "<name>"]'
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
        const result = processFile(absPath);
        const { killer, types, balancing, limits } = result;

        const outDir = outDirOverride || path.dirname(absPath);
        fs.mkdirSync(outDir, { recursive: true });

        const killerSlug = killer.Name.replace(/\s+/g, '-');
        const sheetOut = await renderSheet(killer, types, killerSlug, outDir, balancing, dateLabel, limits);

        const variantCount = types.reduce((n, t) => n + t.allowedVariants.length, 0);
        console.log(
            `[${killer.Name}]\n` +
            `  Allowed items: ${variantCount}\n` +
            types
                .filter(t => t.allowedVariants.length > 0)
                .map(t => `    ${t.type.Name}: ${t.allowedVariants.length} item(s), ${t.allowedAddons.length} add-on(s)`)
                .join('\n') +
            `\n  Sheet → ${sheetOut}`
        );

        results.push(result);
    }

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

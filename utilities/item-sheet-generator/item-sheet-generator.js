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
 *        [--out <dir>] [--preset <out.json>] [--name "<name>"]
 *
 * Sheets are written next to each input file by default; --out overrides this.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createCanvas, loadImage } = require('canvas');

// ---------------------------------------------------------------------------
// Paths relative to the REPO ROOT (two levels up from __dirname)
// ---------------------------------------------------------------------------
const REPO_ROOT = path.join(__dirname, '..', '..');
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
const HEADER_H   = 190;  // header height
const ROW_H      = ITEM_ICON;
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';

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

    return { killer, types, balancing };
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

// ---------------------------------------------------------------------------
// Image rendering
// ---------------------------------------------------------------------------
async function renderSheet(killer, types, killerSlug, outDir, balancing, dateLabel) {
    // Flatten to one row per allowed variant (in type order, then variant name)
    const rows = [];
    for (const { type, allowedVariants, allowedAddons } of types) {
        for (const variant of allowedVariants) {
            rows.push({ variant, addons: allowedAddons, typeName: type.Name });
        }
    }

    const variantCount = rows.length;
    const maxAddons = rows.reduce((m, r) => Math.max(m, r.addons.length), 0);

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

    // Header-text width: keep the canvas wide enough for the title block and the
    // right-aligned provenance lines so they are never clipped on narrow sheets.
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = '700 30pt sans-serif';
    const titleW = measure.measureText(`Going against: ${killer.Name}`).width;
    measure.font = '400 18pt sans-serif';
    const subW = measure.measureText('Allowed Items & Add-ons').width;
    measure.font = '400 16pt sans-serif';
    const countW = measure.measureText(`(${variantCount} items)`).width;
    const leftMaxW = Math.max(titleW, subW, countW);
    measure.font = '400 13pt sans-serif';
    const genW = measure.measureText(`Generated: ${dateLabel}`).width;
    const balW = balancing ? measure.measureText(`Balancing: ${balancing}`).width : 0;
    const metaMaxW = Math.max(genW, balW);

    const leftNeed = textX + leftMaxW + MARGIN;
    const metaNeed = textX + metaMaxW + MARGIN; // textX floor also clears the portrait
    const width = Math.ceil(Math.max(bodyWidth, leftNeed, metaNeed));

    const bodyH  = variantCount > 0
        ? variantCount * (ROW_H + ROW_GAP) - ROW_GAP
        : 0;
    const height = HEADER_H + MARGIN + bodyH + MARGIN;

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

    ctx.font = '400 16pt sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`(${variantCount} items)`, textX, MARGIN + 84);

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

    // Preload all images (variant icons + addon icons), keyed by row
    const loaders = rows.map(async (r) => {
        const variantImg = await loadImage(pngFromIcon(PNG_ITEMS, r.variant.icon)).catch(() => null);
        const addonImgs = await Promise.all(
            r.addons.map(a => loadImage(pngFromIcon(PNG_ADDONS, a.icon)).catch(() => null))
        );
        return { variantImg, addonImgs };
    });
    const loaded = await Promise.all(loaders);

    // --- Rows ---
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const y = HEADER_H + MARGIN + i * (ROW_H + ROW_GAP);

        // Item-variant icon
        const vImg = loaded[i].variantImg;
        if (vImg) {
            ctx.drawImage(vImg, MARGIN, y, ITEM_ICON, ITEM_ICON);
        } else {
            ctx.fillStyle = '#333333';
            ctx.fillRect(MARGIN, y, ITEM_ICON, ITEM_ICON);
        }

        // Add-on strip
        const ay = y + Math.round((ROW_H - ADDON_ICON) / 2);
        if (r.addons.length === 0) {
            ctx.fillStyle = '#888888';
            ctx.font = '400 13pt sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText('(no add-ons allowed)', addonStripX, y + ROW_H / 2);
            ctx.textBaseline = 'top';
        } else {
            for (let j = 0; j < r.addons.length; j++) {
                const x = addonStripX + j * (ADDON_ICON + GAP);
                const img = loaded[i].addonImgs[j];
                if (img) {
                    ctx.drawImage(img, x, ay, ADDON_ICON, ADDON_ICON);
                } else {
                    ctx.fillStyle = '#333333';
                    ctx.fillRect(x, ay, ADDON_ICON, ADDON_ICON);
                }
            }
        }
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
            '       [--out <dir>] [--preset <out.json>] [--name "<name>"]'
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
        const { killer, types, balancing } = result;

        const outDir = outDirOverride || path.dirname(absPath);
        fs.mkdirSync(outDir, { recursive: true });

        const killerSlug = killer.Name.replace(/\s+/g, '-');
        const sheetOut = await renderSheet(killer, types, killerSlug, outDir, balancing, dateLabel);

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

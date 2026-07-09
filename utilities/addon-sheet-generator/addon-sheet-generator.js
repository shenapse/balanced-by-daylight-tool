#!/usr/bin/env node
'use strict';

/**
 * addon-sheet-generator.js
 *
 * Reads a YAML file describing one killer's allowed *power add-ons*, produces a
 * PNG sheet grouped by rarity (Common -> Uncommon -> Rare -> Very Rare ->
 * Ultra Rare), and optionally compiles a BbD balancing-preset JSON when
 * --preset is passed.
 *
 * Add-ons are killer-side only; there is no survivor side. Survivor items and
 * their add-ons are out of scope (see item-sheet-generator). This tool only
 * deals with `AddonTiersBanned` + `IndividualAddonBans`.
 *
 * Usage:
 *   node utilities/addon-sheet-generator/addon-sheet-generator.js <file.yaml...>
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
const ADDONS_FILE  = path.join(REPO_ROOT, 'public', 'NewAddons.json');
const KILLERS_FILE = path.join(REPO_ROOT, 'public', 'Killers.json');
const DEBUG_PRESET = path.join(REPO_ROOT, 'public', 'BalancingPresets', 'DEBUG.json');
const PNG_LIBRARY  = path.join(REPO_ROOT, 'canvas-image-library');
const PNG_PORTRAITS = path.join(PNG_LIBRARY, 'Portraits');

// ---------------------------------------------------------------------------
// Rarity model
//   NewAddons.json "Rarity" is a numeric index 0..4.
//   The rarity border images are named <index>.png in addon-combine-tool.
// ---------------------------------------------------------------------------
const RARITY_NAMES = ['Common', 'Uncommon', 'Rare', 'Very Rare', 'Ultra Rare'];

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
const DEFAULT_COLUMNS = 8;
const ICON       = 118;  // px per add-on icon (border + art)
const GAP        = 16;   // px between icons
const MARGIN     = 32;   // outer margin
const HEADER_H   = 190;  // header height
const LABEL_W    = 160;  // left gutter holding the rarity label
const SECTION_GAP = 22;  // vertical space between rarity sections
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
const allAddons   = JSON.parse(fs.readFileSync(ADDONS_FILE,  'utf8'));
const allKillers  = JSON.parse(fs.readFileSync(KILLERS_FILE, 'utf8'));
const debugPreset = JSON.parse(fs.readFileSync(DEBUG_PRESET, 'utf8'));

// Pull the first KillerOverride entry as a template for the compile step
const OVERRIDE_TEMPLATE = debugPreset.KillerOverride[0];

// ---------------------------------------------------------------------------
// Name normalisation helpers
// ---------------------------------------------------------------------------
function normalize(str) {
    return String(str)
        .toLowerCase()
        .replace(/[\s\-_'.&"]+/g, '');
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

// Build a lookup: killer Name -> its add-on array
const addonsByKiller = new Map();
for (const k of allAddons) addonsByKiller.set(normalize(k.Name), k.Addons || []);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        files: [],
        outDir: null,
        columns: DEFAULT_COLUMNS,
        presetPath: null,
        presetName: 'Generated Add-on Allow-List',
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
// Rarity helpers
// ---------------------------------------------------------------------------
/** Resolve a rarity selector value (name or numeric index) to an index 0..4. */
function rarityToIndex(value, filePath) {
    if (typeof value === 'number') {
        if (value >= 0 && value < RARITY_NAMES.length) return value;
        fatal(`Rarity tier ${value} out of range (0-${RARITY_NAMES.length - 1}) in "${filePath}".`);
    }
    const norm = normalize(value);
    const idx = RARITY_NAMES.findIndex(n => normalize(n) === norm);
    if (idx === -1) {
        fatal(
            `Unknown rarity "${value}" in "${filePath}". ` +
            `Expected one of: ${RARITY_NAMES.join(', ')} (or a 0-4 tier index).`
        );
    }
    return idx;
}

// ---------------------------------------------------------------------------
// Selector matching
// ---------------------------------------------------------------------------
/**
 * Apply a single selector to the killer's add-on universe.
 * Returns the array of add-ons matched by this selector.
 * @param {*} selector - string (add-on name) or object ({rarity}/{tier})
 * @param {Array} universe - all add-ons for this killer
 * @param {Map} lookup - normalized-name -> add-on
 * @param {string} filePath - for error messages
 */
function matchSelector(selector, universe, lookup, filePath) {
    if (typeof selector === 'string') {
        const addon = lookup.get(normalize(selector));
        if (!addon) {
            fatal(
                `Unknown add-on name "${selector}" in file "${filePath}". ` +
                `No matching add-on found for this killer.`
            );
        }
        return [addon];
    }
    if (typeof selector === 'object' && selector !== null) {
        if (selector.rarity !== undefined) {
            const idx = rarityToIndex(selector.rarity, filePath);
            return universe.filter(a => a.Rarity === idx);
        }
        if (selector.tier !== undefined) {
            const idx = rarityToIndex(selector.tier, filePath);
            return universe.filter(a => a.Rarity === idx);
        }
        fatal(
            `Unknown group selector ${JSON.stringify(selector)} in file "${filePath}". ` +
            `Only { rarity: "<name>" } and { tier: <0-4> } are supported.`
        );
    }
    fatal(`Invalid selector value ${JSON.stringify(selector)} in file "${filePath}".`);
}

// ---------------------------------------------------------------------------
// Add-on resolution
// ---------------------------------------------------------------------------
/**
 * Resolve allowed add-ons for one killer.
 * @param {Object} cfg - { default, allow, deny } from YAML
 * @param {Array} universe - this killer's full add-on list
 * @param {string} filePath - for error messages
 * @returns {Array} array of allowed add-on objects (unsorted)
 */
function resolveAllowList(cfg, universe, filePath) {
    // Build a name lookup for this killer's universe
    const lookup = new Map();
    for (const a of universe) {
        const n = normalize(a.Name);
        if (!lookup.has(n)) lookup.set(n, a);
    }

    // Seed from default
    const defaultVal = (cfg && cfg.default) || 'deny';
    if (defaultVal !== 'allow' && defaultVal !== 'deny') {
        fatal(`"default" must be "allow" or "deny" in file "${filePath}".`);
    }
    let allowed = new Map(); // globalID -> add-on
    if (defaultVal === 'allow') {
        for (const a of universe) allowed.set(a.globalID, a);
    }
    // deny default: allowed starts empty

    // Apply deny selectors
    const denyList = (cfg && cfg.deny) || [];
    for (const sel of denyList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const a of matched) allowed.delete(a.globalID);
    }

    // Apply allow selectors (allow wins on conflict)
    const allowList = (cfg && cfg.allow) || [];
    for (const sel of allowList) {
        const matched = matchSelector(sel, universe, lookup, filePath);
        for (const a of matched) allowed.set(a.globalID, a);
    }

    return [...allowed.values()];
}

// ---------------------------------------------------------------------------
// Asset path resolution
// ---------------------------------------------------------------------------
/**
 * Derive the PNG mirror path for an add-on from its `addonIcon` (a WebP path
 * under public/, e.g. "public/PowerAddons/Trapper/Trapper-Gloves.webp").
 */
function addonIconPng(addon) {
    const rel = String(addon.addonIcon)
        .replace(/^public[\\/]/, '')
        .replace(/\.webp$/i, '.png');
    return path.join(PNG_LIBRARY, rel);
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
async function renderSheet(killer, allowedAddons, killerSlug, columns, outDir, balancing, dateLabel) {
    const count = allowedAddons.length;

    // Group allowed add-ons by rarity, sorted within each rarity by name.
    const sections = []; // { rarity, addons: [...] }
    for (let r = 0; r < RARITY_NAMES.length; r++) {
        const group = allowedAddons
            .filter(a => a.Rarity === r)
            .sort((a, b) => a.Name.localeCompare(b.Name));
        if (group.length > 0) sections.push({ rarity: r, addons: group });
    }

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

    // Geometry: each section wraps its add-ons at `columns`.
    const gridW = columns * ICON + (columns - 1) * GAP;
    const bodyWidth = MARGIN + LABEL_W + GAP + gridW + MARGIN;

    // Width: max of the add-on grid and the header text (title block + right-aligned
    // provenance), so the header is never clipped on narrow grids.
    const measure = createCanvas(1, 1).getContext('2d');
    measure.font = '700 30pt sans-serif';
    const titleW = measure.measureText(killer.Name).width;
    measure.font = '400 18pt sans-serif';
    const subW = measure.measureText('Allowed Killer Add-ons').width;
    measure.font = '400 16pt sans-serif';
    const countW = measure.measureText(`(${count} add-ons)`).width;
    const leftMaxW = Math.max(titleW, subW, countW);
    measure.font = '400 13pt sans-serif';
    const genW = measure.measureText(`Generated: ${dateLabel}`).width;
    const balW = balancing ? measure.measureText(`Balancing: ${balancing}`).width : 0;
    const metaMaxW = Math.max(genW, balW);

    const leftNeed = textX + leftMaxW + MARGIN;
    const metaNeed = textX + metaMaxW + MARGIN; // textX floor also clears the portrait
    const width = Math.ceil(Math.max(bodyWidth, leftNeed, metaNeed));

    // Compute the height + per-section y offsets.
    let bodyH = 0;
    for (let s = 0; s < sections.length; s++) {
        const rows = Math.ceil(sections[s].addons.length / columns);
        sections[s].rows = rows;
        sections[s].height = rows * ICON + (rows - 1) * GAP;
        sections[s].y = HEADER_H + MARGIN + bodyH;
        bodyH += sections[s].height;
        if (s < sections.length - 1) bodyH += SECTION_GAP;
    }
    const height = HEADER_H + MARGIN + (count > 0 ? bodyH : 0) + MARGIN;

    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    // --- Header ---
    if (portraitImg) {
        ctx.drawImage(portraitImg, MARGIN, MARGIN, portraitW, portraitH);
    }

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 30pt sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(killer.Name, textX, MARGIN);

    ctx.font = '400 18pt sans-serif';
    ctx.fillText('Allowed Killer Add-ons', textX, MARGIN + 46);

    ctx.font = '400 16pt sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`(${count} add-ons)`, textX, MARGIN + 84);

    // Provenance: balancing ruleset + generation timestamp
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
        ctx.fillText('None allowed', MARGIN, HEADER_H + MARGIN);
        const outFile = path.join(outDir, `${killerSlug}-killer-addons.png`);
        fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
        return outFile;
    }

    // --- Add-on sections ---
    // Preload all add-on art (flattened, in render order)
    const flat = [];
    for (const sec of sections) for (const a of sec.addons) flat.push(a);
    const artImages = await Promise.allSettled(flat.map(a => loadImage(addonIconPng(a))));
    const artByGlobalId = new Map();
    const missingArt = []; // add-ons whose PNG failed to load (drawn as placeholders)
    flat.forEach((a, i) => {
        artByGlobalId.set(a.globalID, artImages[i]);
        if (artImages[i].status !== 'fulfilled') missingArt.push(a);
    });

    const gridX = MARGIN + LABEL_W + GAP;

    for (const sec of sections) {
        // Rarity label, vertically centred against the section block
        ctx.fillStyle = TEXT_COLOR;
        ctx.font = '600 16pt sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(RARITY_NAMES[sec.rarity], MARGIN, sec.y + sec.height / 2, LABEL_W - GAP);
        ctx.textBaseline = 'top';

        for (let i = 0; i < sec.addons.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            const x = gridX + col * (ICON + GAP);
            const y = sec.y + row * (ICON + GAP);

            // The add-on PNG already has its rarity plate baked in (produced by
            // addon-combine-tool), so draw it bare — like the perk/item generators.
            const art = artByGlobalId.get(sec.addons[i].globalID);
            if (art && art.status === 'fulfilled') {
                ctx.drawImage(art.value, x, y, ICON, ICON);
            } else {
                // No art on disk: draw a placeholder box
                ctx.fillStyle = '#333333';
                ctx.fillRect(x, y, ICON, ICON);
            }
        }
    }

    if (missingArt.length > 0) {
        console.warn(
            `WARN: ${missingArt.length} add-on icon(s) missing from canvas-image-library ` +
            `(drawn as placeholder):`
        );
        for (const a of missingArt) {
            console.warn(`  - ${killer.Name} / ${a.Name} → ${addonIconPng(a)}`);
        }
    }

    const outFile = path.join(outDir, `${killerSlug}-killer-addons.png`);
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

// ---------------------------------------------------------------------------
// Preset compilation
// ---------------------------------------------------------------------------
function buildPreset(results, name, balancing, generatedISO) {
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
        entry.KillerIndvPerkBans     = [];
        entry.KillerComboPerkBans    = [];
        entry.SurvivorIndvPerkBans   = [];
        entry.SurvivorComboPerkBans  = [];
        entry.SurvivorWhitelistedPerks       = [];
        entry.SurvivorWhitelistedComboPerks  = [];
        entry.KillerWhitelistedPerks         = [];
        entry.KillerWhitelistedComboPerks    = [];
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
        const universe = r.universe;
        const allowedIds = new Set(r.allowedAddons.map(a => a.globalID));
        const denied = universe.filter(a => !allowedIds.has(a.globalID));

        // Collapse fully-denied rarities into AddonTiersBanned; the rest become
        // individual globalID bans.
        const bannedTiers = [];
        for (let rarity = 0; rarity < RARITY_NAMES.length; rarity++) {
            const inTier = universe.filter(a => a.Rarity === rarity);
            if (inTier.length > 0 && inTier.every(a => !allowedIds.has(a.globalID))) {
                bannedTiers.push(rarity);
            }
        }
        const bannedTierSet = new Set(bannedTiers);

        entry.AddonTiersBanned = bannedTiers;
        entry.IndividualAddonBans = denied
            .filter(a => !bannedTierSet.has(a.Rarity))
            .map(a => a.globalID);

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
    const killerKey = normalize(doc.killer);
    const killer = killerLookup.get(killerKey);
    if (!killer) {
        fatal(
            `Unknown killer "${doc.killer}" in file "${filePath}". ` +
            `No matching entry in Killers.json.`
        );
    }

    const universe = addonsByKiller.get(killerKey);
    if (!universe) {
        fatal(`No add-ons found for killer "${killer.Name}" in NewAddons.json.`);
    }

    // Balancing ruleset label (optional)
    const balancing = (doc.balancing == null) ? '' : String(doc.balancing).trim();

    // Accept either an `addons:` block or top-level default/allow/deny.
    const cfg = doc.addons || {
        default: doc.default,
        allow: doc.allow,
        deny: doc.deny,
    };

    const allowedAddons = resolveAllowList(cfg, universe, filePath);

    return { killer, universe, allowedAddons, balancing };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.files.length === 0) {
        console.log(
            'Usage: node addon-sheet-generator.js <file.yaml...>\n' +
            '       [--asset-root <dir>] [--out <dir>] [--columns <n>]\n' +
            '       [--preset <out.json>] [--name "<name>"]'
        );
        process.exit(0);
    }

    const outDirOverride = args.outDir ? path.resolve(args.outDir) : null;

    // Stamp the generation time once so a batch shares a consistent timestamp
    const generatedAt = new Date();
    const generatedISO = generatedAt.toISOString();
    const dateLabel = generatedISO.slice(0, 10);

    const results = [];

    for (const filePath of args.files) {
        const absPath = path.resolve(filePath);
        const result = processFile(absPath);
        const { killer, allowedAddons, balancing } = result;

        const outDir = outDirOverride || path.dirname(absPath);
        fs.mkdirSync(outDir, { recursive: true });

        const killerSlug = killer.Name.replace(/\s+/g, '-');

        const outFile = await renderSheet(
            killer, allowedAddons, killerSlug, args.columns, outDir, balancing, dateLabel
        );

        console.log(
            `[${killer.Name}]\n` +
            `  Allowed add-ons: ${allowedAddons.length} / ${result.universe.length}\n` +
            `  Sheet → ${outFile}`
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

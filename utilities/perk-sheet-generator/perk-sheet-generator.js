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
 *        [--out <dir>] [--columns <n>] [--preset <out.json>] [--name "<name>"]
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createCanvas, loadImage } = require('canvas');

// ---------------------------------------------------------------------------
// Paths relative to the REPO ROOT (two levels up from __dirname)
// ---------------------------------------------------------------------------
const REPO_ROOT = path.join(__dirname, '..', '..');
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
const HEADER_H = 140;   // header height
const BG_COLOR   = '#100f16';
const TEXT_COLOR = '#ffffff';

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
async function renderSheet(killer, allowedPerks, sideLabel, killerSlug, columns, outDir) {
    const count = allowedPerks.length;
    const rows  = count > 0 ? Math.ceil(count / columns) : 0;
    const gridW = columns * ICON + (columns - 1) * GAP;
    const gridH = rows > 0 ? rows * ICON + (rows - 1) * GAP : 0;
    const width  = MARGIN * 2 + gridW;
    const height = HEADER_H + gridH + MARGIN * 2;

    const canvas = createCanvas(width, height);
    const ctx    = canvas.getContext('2d');

    // Background
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, width, height);

    // --- Header ---
    // Load portrait
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

    let textX = MARGIN;

    if (portraitImg) {
        const py = Math.round((HEADER_H - portraitH) / 2);
        ctx.drawImage(portraitImg, MARGIN, py, portraitW, portraitH);
        textX = MARGIN + portraitW + 16;
    }

    ctx.fillStyle = TEXT_COLOR;
    ctx.font = '700 30pt sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(killer.Name, textX, MARGIN);

    ctx.font = '400 18pt sans-serif';
    ctx.fillText(sideLabel, textX, MARGIN + 46);

    ctx.font = '400 16pt sans-serif';
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(`(${count} perks)`, textX, MARGIN + 84);

    if (count === 0) {
        ctx.fillStyle = '#888888';
        ctx.font = '400 16pt sans-serif';
        ctx.fillText('None allowed', MARGIN, HEADER_H + MARGIN);
        const outFile = path.join(outDir, `${killerSlug}-${sideLabel === 'Allowed Killer Perks' ? 'killer' : 'survivor'}-perks.png`);
        fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
        return outFile;
    }

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

    const sidePart = sideLabel === 'Allowed Killer Perks' ? 'killer' : 'survivor';
    const outFile  = path.join(outDir, `${killerSlug}-${sidePart}-perks.png`);
    fs.writeFileSync(outFile, canvas.toBuffer('image/png'));
    return outFile;
}

// ---------------------------------------------------------------------------
// Preset compilation
// ---------------------------------------------------------------------------
function buildPreset(results, name) {
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

    // Universe declarations
    const universeKiller   = doc.universe && doc.universe.killer   !== undefined ? doc.universe.killer   : 'all';
    const universeSurvivor = doc.universe && doc.universe.survivor !== undefined ? doc.universe.survivor : 'all';

    // Resolve both sides
    const allowedKiller   = resolveSide(doc.killerPerks,   universeKiller,   false, filePath);
    const allowedSurvivor = resolveSide(doc.survivorPerks, universeSurvivor, true,  filePath);

    return { killer, allowedKiller, allowedSurvivor };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.files.length === 0) {
        console.log(
            'Usage: node perk-sheet-generator.js <file.yaml...>\n' +
            '       [--out <dir>] [--columns <n>] [--preset <out.json>] [--name "<name>"]'
        );
        process.exit(0);
    }

    // Determine output directory
    const outDir = args.outDir
        ? path.resolve(args.outDir)
        : path.join(__dirname, 'output');

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const results = [];

    for (const filePath of args.files) {
        const absPath = path.resolve(filePath);
        const result = await processFile(absPath, args.columns);
        const { killer, allowedKiller, allowedSurvivor } = result;

        // Killer slug for filenames
        const killerSlug = killer.Name.replace(/\s+/g, '-');

        // Render killer-side sheet
        const killerOut = await renderSheet(
            killer, allowedKiller, 'Allowed Killer Perks',
            killerSlug, args.columns, outDir
        );

        // Render survivor-side sheet
        const survivorOut = await renderSheet(
            killer, allowedSurvivor, 'Allowed Survivor Perks',
            killerSlug, args.columns, outDir
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
        const preset = buildPreset(results, args.presetName);
        const presetAbs = path.resolve(args.presetPath);
        fs.writeFileSync(presetAbs, JSON.stringify(preset, null, 4), 'utf8');
        console.log(`\nPreset written → ${presetAbs}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

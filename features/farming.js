/**
 * Gewassen oogsten en terugplanten.
 *
 * De oogstregels staan niet hier maar in data/crops.js: per gewas ligt daar vast tot welke van de
 * vier categorieën het hoort (breken-en-herplanten, vrucht-naast-de-stengel, aanklikken,
 * verticale groeier). Deze module voert die categorieën uit. Wil je een gewas toevoegen of
 * corrigeren, dan hoef je hier dus niets aan te raken.
 *
 * De ronde: scannen -> pad controleren -> oogsten + herplanten -> bij volle inventaris naar
 * de dichtstbijzijnde speler en afgeven -> opnieuw. Daarna, eenmalig, de dieren voeren.
 *
 * Twee dingen die makkelijk misgaan:
 *   - de eindlevering staat BUITEN de oogstlus, want het fokvoer (graan, wortels) zit in
 *     dezelfde inventaris als de oogst. Eerst leveren betekent met lege handen bij de koeien staan.
 *   - blokstate-waarden komen als STRING binnen (age: "7"), dus age === 7 vindt nooit iets.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG } = require('../config');
const botState = require('../state');
const {
  Logger, setMovements, findItemExact, placeBlockAllowed, withTimeout, findNearestEntity,
} = require('../utils');
const { safeDig } = require('./mining');
const {
  CATEGORY, CROP_LIST, CROPS_BY_BLOCK, NEVER_BREAK, PROTECTED_BLOCKS, YIELD_ITEMS, SEED_ITEMS,
} = require('../data/crops');
const { breedAnimals } = require('./breeding');

const FARM = CONFIG.farming;
const BREED = CONFIG.breeding;

const HORIZONTAL = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
];

function farmMovements(bot) {
  setMovements(bot, {
    canDig: false,        // constraint: niets anders breken dan het gerichte gewas
    canPlace: false,      // constraint: niets plaatsen behalve zaad (via placeBlockAllowed)
    allowSprinting: false,
    allowParkour: false,  // springen vertrapt akkerland tot gewone aarde
    protectBlocks: PROTECTED_BLOCKS,
  });
}

// ---------------------------------------------------------------------------
// Rijpheid
// ---------------------------------------------------------------------------

/** Max age uit het registry i.p.v. hardgecodeerd: klopt zo ook voor bietjes (3) en kelp (25). */
function maxAgeOf(bot, blockName) {
  const cache = bot._maxAgeCache ?? (bot._maxAgeCache = new Map());
  if (cache.has(blockName)) return cache.get(blockName);
  const state = bot.registry.blocksByName[blockName]?.states?.find(s => s.name === 'age');
  const value = state ? state.num_values - 1 : null;
  cache.set(blockName, value);
  return value;
}

/**
 * Is dit blok oogstbaar volgens zijn eigen categorie-regels?
 *
 * Let op: block.getProperties().age komt terug als STRING ('7'), niet als getal — een
 * vergelijking met === 7 vindt dus nul gewassen. Vandaar Number() in de predicaten.
 * `berries` is wél een echte boolean; isTrue() in data/crops.js vangt beide af.
 *
 * Gememoizeerd op stateId, want findBlocks roept dit voor elk blok in elke sectie aan.
 */
function isHarvestable(bot, block) {
  if (!block) return false;
  const def = CROPS_BY_BLOCK[block.name];
  if (!def) return false;

  const cache = bot._cropRipeCache ?? (bot._cropRipeCache = new Map());
  const key = typeof block.stateId === 'number' ? block.stateId : null;
  if (key !== null && cache.has(key)) return cache.get(key);

  let ripe = false;
  try {
    const props = block.getProperties?.() ?? {};
    ripe = !!def.ripe(props, maxAgeOf(bot, block.name));
  } catch (err) {
    ripe = false;
  }

  if (key !== null) cache.set(key, ripe);
  return ripe;
}

// ---------------------------------------------------------------------------
// Stap 1: scannen
// ---------------------------------------------------------------------------

/** Ruwe scan: alle blokken binnen 2 chunks die volgens hun categorie oogstbaar zijn. */
function scanCropBlocks(bot) {
  return bot.findBlocks({
    matching: (block) => isHarvestable(bot, block),
    maxDistance: FARM.scanRadius,
    count: FARM.maxCropsPerScan,
  });
}

/** Zoekt de voet van een verticale plant: het laagste blok dat nog bij de plant hoort. */
function columnBottom(bot, pos, members) {
  let y = pos.y;
  for (let i = 0; i < 64; i++) {           // veiligheidsrem tegen eindeloze kolommen
    const below = bot.blockAt(new Vec3(pos.x, y - 1, pos.z));
    if (!below || !members.has(below.name)) break;
    y--;
  }
  return y;
}

/**
 * Zet ruwe posities om in concrete oogsttaken. Hier zit de categorie-logica die per
 * plantsoort bepaalt WELK blok je aanraakt en HOE:
 *   - REPLANT  -> het gevonden blok breken (bij 2-hoge planten de onderste helft)
 *   - FRUIT    -> de vrucht breken, maar alleen als er een stengel naast staat
 *   - INTERACT -> rechtsklikken op het gevonden blok
 *   - VERTICAL -> niet het gevonden blok, maar het tweede blok van onderen
 */
function buildTasks(bot, positions) {
  const tasks = [];
  const seen = new Set();
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;

  for (const pos of positions) {
    const block = bot.blockAt(pos);
    if (!isHarvestable(bot, block)) continue;
    const def = CROPS_BY_BLOCK[block.name];

    let target = pos;
    let action = 'dig';
    let expect = block.name;

    if (def.category === CATEGORY.INTERACT) {
      action = 'activate';

    } else if (def.category === CATEGORY.FRUIT) {
      // Alleen vruchten die echt aan een stengel hangen. Zo blijft een wilde pompoen of
      // een gecarvede pompoen in de muur met rust, en oogsten we alleen de akker.
      const stems = new Set(def.stems);
      const hasStem = HORIZONTAL.some(d => stems.has(bot.blockAt(pos.plus(d))?.name));
      if (!hasStem) continue;

    } else if (def.category === CATEGORY.VERTICAL) {
      const members = new Set(def.column);
      const bottomY = columnBottom(bot, pos, members);
      // Het onderste blok blijft staan; we pakken het blok daarboven.
      const cut = new Vec3(pos.x, bottomY + 1, pos.z);
      const cutBlock = bot.blockAt(cut);
      if (!cutBlock || !members.has(cutBlock.name)) continue; // plant is maar 1 hoog
      target = cut;
      expect = cutBlock.name;

    } else if (def.lowerHalfOnly && block.getProperties?.().half === 'upper') {
      // Twee blokken hoog: altijd de onderste helft pakken, die neemt de bovenste mee.
      const lower = pos.offset(0, -1, 0);
      const lowerBlock = bot.blockAt(lower);
      if (!lowerBlock || lowerBlock.name !== block.name) continue;
      target = lower;
      expect = lowerBlock.name;
    }

    const key = keyOf(target);
    if (seen.has(key)) continue;   // meerdere blokken van dezelfde kolom -> één taak
    seen.add(key);

    tasks.push({ pos: target, def, action, expect, cropPos: pos });
  }

  // Per gewas afwerken in plaats van kriskras door elkaar.
  //
  // Puur op afstand sorteren leverde een ronde op waarin de bot tussen tarwe, wortels en
  // pompoenen heen en weer stuiterde: het dichtstbijzijnde blok is telkens van een ander
  // gewas, dus hij liep steeds een stukje terug en had aan het eind overal halve akkers.
  // Nu kiest hij het gewas waar hij het dichtst bij staat, maakt dat helemaal af, en pakt
  // dan pas het volgende gewas — binnen een gewas nog steeds van dichtbij naar ver.
  const botPos = bot.entity.position;
  const distance = (task) => botPos.distanceTo(task.pos);

  const perCrop = new Map();
  for (const task of tasks) {
    const group = perCrop.get(task.def.block) ?? [];
    group.push(task);
    perCrop.set(task.def.block, group);
  }

  return [...perCrop.values()]
    .map(group => group.sort((a, b) => distance(a) - distance(b)))
    .sort((a, b) => distance(a[0]) - distance(b[0]))
    .flat();
}

// ---------------------------------------------------------------------------
// Stap 2: bereikbaarheid
// ---------------------------------------------------------------------------

function hasPathTo(bot, pos) {
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, FARM.approachRange);
  const result = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, FARM.pathCheckTimeout);
  return !!result && result.status === 'success';
}

function distanceTo(bot, pos) {
  return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
}

// ---------------------------------------------------------------------------
// Stap 3a: gereedschap
// ---------------------------------------------------------------------------

function durabilityLeft(item) {
  if (!item || !item.maxDurability) return Infinity; // niet beschadigbaar
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

/** Een item dat als blok geplaatst kan worden (zaad, bouwblok) — gevaarlijk bij rechtsklikken. */
function isPlaceable(bot, item) {
  return !!item && !!bot.registry.blocksByName[item.name];
}

/**
 * Zorgt dat de bot het juiste gereedschap vasthoudt, zonder ooit een bijna-kapot stuk
 * gereedschap te riskeren.
 *
 * Anders dan bij alleen graangewassen telt dit nu echt: meloen en pompoen (hardness 1),
 * cactus en chorus (0.4), bamboe (1) en cocoa (0.2) kosten wél duurzaamheid. Graan,
 * wortels en bessen hebben hardness 0 en breken direct, ongeacht wat je vasthoudt.
 *
 * bot.unequip('hand') wordt bewust vermeden bij een volle inventaris: die gooit dan het
 * item in je hand weg (zie simple_inventory.js) — precies wat we moeten voorkomen.
 *
 * @returns {'tool'|'bare'|'none'} 'none' betekent: stop met oogsten.
 */
async function equipSafeTool(bot, toolKind) {
  const held = bot.heldItem;

  if (toolKind) {
    const candidates = bot.inventory.items()
      .filter(item => item.name.endsWith(`_${toolKind}`) || item.name === toolKind)
      .sort((a, b) => durabilityLeft(b) - durabilityLeft(a));

    const safe = candidates.find(t => durabilityLeft(t) >= FARM.minToolDurability);
    if (safe) {
      if (held?.slot !== safe.slot) {
        await bot.equip(safe, 'hand');
        if (held && durabilityLeft(held) < FARM.minToolDurability) {
          Logger.info(`Gereedschap gewisseld: ${held.name} (${durabilityLeft(held)} over) -> ${safe.name}`);
        }
      }
      return 'tool';
    }
  }

  // Geen (veilig) gereedschap: zorg in elk geval dat we niets breekbaars vasthouden.
  if (durabilityLeft(held) >= FARM.minToolDurability) return 'bare';

  const harmless = bot.inventory.items().find(item => durabilityLeft(item) === Infinity);
  if (harmless) {
    await bot.equip(harmless, 'hand');
    Logger.warn(`Geen gereedschap boven ${FARM.minToolDurability} duurzaamheid, oogst met de hand`);
    return 'bare';
  }

  if (bot.inventory.emptySlotCount() > 0) {
    await bot.unequip('hand');
    return 'bare';
  }

  return 'none';
}

/**
 * Rechtsklikken met een plaatsbaar blok in de hand zou dat blok kunnen plaatsen, en dat
 * is tegen de constraints. Voor INTERACT-gewassen zorgen we dus eerst voor een hand die
 * niets kan plaatsen (gereedschap is altijd veilig).
 */
async function equipNonPlaceable(bot) {
  if (!isPlaceable(bot, bot.heldItem) && durabilityLeft(bot.heldItem) >= FARM.minToolDurability) return true;

  const tool = bot.inventory.items()
    .filter(item => /_(hoe|axe|pickaxe|shovel|sword)$/.test(item.name))
    .filter(item => durabilityLeft(item) >= FARM.minToolDurability)
    .sort((a, b) => durabilityLeft(b) - durabilityLeft(a))[0];
  if (tool) { await bot.equip(tool, 'hand'); return true; }

  const safe = bot.inventory.items().find(item => !isPlaceable(bot, item));
  if (safe) { await bot.equip(safe, 'hand'); return true; }

  if (bot.inventory.emptySlotCount() > 0) { await bot.unequip('hand'); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Stap 3b: oogsten en herplanten
// ---------------------------------------------------------------------------

/**
 * Voert één oogstactie uit. De laatste controle vlak voor het breken is bewust hier:
 * wat er ook misgaat bij het opbouwen van taken, een stengel, bessenstruik of ondergrond
 * wordt nooit gebroken.
 */
async function harvest(bot, task) {
  const block = bot.blockAt(task.pos);
  if (!block || block.name !== task.expect) return false;

  if (task.action === 'activate') {
    if (NEVER_BREAK.has(block.name) === false && CROPS_BY_BLOCK[block.name]?.category !== CATEGORY.INTERACT) {
      return false;
    }
    if (!await equipNonPlaceable(bot)) {
      Logger.warn('Kan niets veiligs vasthouden om te rechtsklikken, interactie overgeslagen');
      return false;
    }
    try {
      await bot.activateBlock(block);
      return true;
    } catch (err) {
      Logger.debug(`Rechtsklikken mislukt op ${task.pos}: ${err.message}`);
      return false;
    }
  }

  if (NEVER_BREAK.has(block.name)) {
    Logger.error(`GEWEIGERD: ${block.name} op ${task.pos} staat op de niet-breken-lijst`);
    return false;
  }

  return safeDig(bot, block);
}

/** Herplant het zaad. REPLANT-gewassen alleen; stengels en verticale planten groeien zelf terug. */
async function replant(bot, task) {
  const def = task.def;
  if (def.category !== CATEGORY.REPLANT || !def.seed) return false;

  const here = bot.blockAt(task.pos);
  if (here && here.name !== 'air' && here.name !== 'water') return false; // er staat alweer iets

  // Het ITEM in de inventaris, niet het blok in de wereld: 'wheat_seeds' vs 'wheat'.
  const seed = findItemExact(bot, def.seed);
  if (!seed) {
    Logger.debug(`Geen ${def.seed} in inventaris om terug te planten`);
    return false;
  }

  // Waar plaatsen we tegenaan? Cocoa gaat zijwaarts tegen een jungle log, de rest op
  // de ondergrond eronder.
  let reference = null;
  let face = null;

  if (def.placeOn === 'side') {
    for (const d of HORIZONTAL) {
      const neighbour = bot.blockAt(task.pos.plus(d));
      if (neighbour && def.soil.includes(neighbour.name)) {
        reference = neighbour;
        face = new Vec3(-d.x, -d.y, -d.z);
        break;
      }
    }
  } else {
    const below = bot.blockAt(task.pos.offset(0, -1, 0));
    const soilOk = below && (def.soil === null ? below.boundingBox === 'block' : def.soil.includes(below.name));
    if (soilOk) {
      reference = below;
      face = new Vec3(0, 1, 0);
    }
  }

  if (!reference) {
    Logger.debug(`Geen geldige ondergrond voor ${def.seed} op ${task.pos}`);
    return false;
  }

  try {
    await bot.equip(seed, 'hand');
    await placeBlockAllowed(bot, reference, face);
    return true;
  } catch (err) {
    Logger.debug(`Terugplanten mislukt op ${task.pos}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stap 4/5: inventaris en levering
// ---------------------------------------------------------------------------

function inventoryFull(bot) {
  return bot.inventory.emptySlotCount() <= FARM.minFreeSlots;
}

/** Alle item-entities binnen een straal, dichtstbij eerst. */
function nearbyDrops(bot, radius) {
  return Object.values(bot.entities)
    .filter(e => e && e.name === 'item' && e.position)
    .map(e => ({ entity: e, distance: bot.entity.position.distanceTo(e.position) }))
    .filter(d => d.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Naar een drop lopen tot hij opgeraapt is. Geeft false als de bot er niet bij kon.
 *
 * GoalNear rekent in blokken, dus met straal 1 kan de bot diagonaal nog ruim 1,4 blok van het
 * item vandaan stil komen te staan — net buiten de oprapradius van Minecraft, waarna het item
 * gewoon bleef liggen. Daarom wordt er na aankomst kort gewacht tot de server het oprapen
 * doorgeeft, en ligt het er dan nog, dan schuift de bot er alsnog bovenop (straal 0).
 */
async function collectDrop(bot, entity) {
  const pos = entity.position;

  for (const range of [1, 0]) {
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)),
        FARM.dropSweepTimeout,
        'drop oprapen'
      );
    } catch (err) {
      Logger.debug(`Drop oprapen overgeslagen: ${err.message}`);
      return !entity.isValid;
    }
    await new Promise(resolve => setTimeout(resolve, FARM.dropPickupDelay));
    if (!entity.isValid) return true;
  }

  return !entity.isValid;
}

async function sweepDrops(bot, shouldStop, radius = FARM.dropSweepRadius) {
  let collected = 0;

  for (const { entity } of nearbyDrops(bot, radius)) {
    if (shouldStop() || inventoryFull(bot)) break;
    if (!entity.isValid) continue;
    if (await collectDrop(bot, entity)) collected++;
  }

  return collected;
}

/**
 * Slotronde over de hele akker.
 *
 * sweepDrops() kijkt met opzet maar FARM.dropSweepRadius blokken om de bot heen: tussen het
 * oogsten door moet oprapen goedkoop blijven. Maar er wordt tot FARM.scanRadius blokken ver
 * geoogst, dus alles wat tien oogsten eerder aan de andere kant van het veld viel, lag buiten
 * die straal en bleef daar gewoon liggen — precies de items die na het boeren achterbleven.
 *
 * Deze ronde loopt daarom aan het eind het hele veld nog een keer af, en herhaalt dat: onderweg
 * naar de ene drop komen er telkens nieuwe in beeld. Wat onbereikbaar blijkt wordt onthouden,
 * zodat de bot niet elke ronde opnieuw naar hetzelfde onbereikbare item loopt.
 */
async function sweepFieldDrops(bot, shouldStop) {
  const unreachable = new Set();
  let collected = 0;

  for (let pass = 1; pass <= FARM.finalSweepPasses; pass++) {
    if (shouldStop() || inventoryFull(bot)) break;

    const drops = nearbyDrops(bot, FARM.finalSweepRadius)
      .filter(d => d.entity.isValid && !unreachable.has(d.entity.id));
    if (drops.length === 0) break;

    Logger.debug(`Slotronde ${pass}: nog ${drops.length} drops binnen ${FARM.finalSweepRadius} blokken`);
    for (const { entity } of drops) {
      if (shouldStop() || inventoryFull(bot)) break;
      if (!entity.isValid) continue;
      if (await collectDrop(bot, entity)) collected++;
      else unreachable.add(entity.id);
    }
  }

  if (collected > 0) Logger.info(`Slotronde: ${collected} drops alsnog opgeraapt`);
  return collected;
}

/** Alles uit YIELD_ITEMS mag weg, minus 1 stack per zaadsoort. */
function computeSurplus(bot) {
  const totals = new Map();
  for (const item of bot.inventory.items()) {
    if (!YIELD_ITEMS.has(item.name)) continue;
    const entry = totals.get(item.name) ?? { type: item.type, count: 0 };
    entry.count += item.count;
    totals.set(item.name, entry);
  }

  const surplus = [];
  for (const [name, entry] of totals) {
    const keep = SEED_ITEMS.has(name) ? FARM.keepSeedCount : 0;
    const drop = entry.count - keep;
    if (drop > 0) surplus.push({ name, type: entry.type, count: drop });
  }
  return surplus;
}

async function deliverHarvest(bot) {
  if (computeSurplus(bot).length === 0) {
    Logger.debug('Niets te leveren');
    return false;
  }

  const player = findNearestEntity(bot, e => e.type === 'player' && e.username !== bot.username);
  if (!player) {
    bot.chat('Mijn inventaris zit vol maar ik zie niemand om het aan te geven!');
    Logger.warn('Levering afgebroken: geen speler in zicht');
    return false;
  }

  const target = player.position.floored();
  if (!hasPathTo(bot, target)) {
    bot.chat(`Ik kan niet bij ${player.username} komen om af te geven!`);
    Logger.warn(`Levering afgebroken: geen pad naar ${player.username}`);
    return false;
  }

  bot.chat(`Inventaris vol, ik breng de oogst naar ${player.username}!`);
  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, FARM.approachRange)),
      FARM.deliverTimeout,
      'levering'
    );
  } catch (err) {
    Logger.warn(`Kon niet bij de speler komen: ${err.message}`);
    bot.chat('Ik kom er niet bij, ik dump het hier.');
  }

  try {
    if (player.isValid) await bot.lookAt(player.position.offset(0, 1.6, 0));
  } catch (err) {
    Logger.debug('Kon niet naar speler kijken');
  }

  let dropped = 0;
  for (const item of computeSurplus(bot)) {
    try {
      await bot.toss(item.type, null, item.count);
      dropped += item.count;
      Logger.debug(`${item.count}x ${item.name} gedropt`);
    } catch (err) {
      Logger.warn(`Kon ${item.name} niet droppen: ${err.message}`);
    }
  }

  const kept = bot.inventory.items()
    .filter(i => SEED_ITEMS.has(i.name))
    .reduce((sum, i) => sum + i.count, 0);

  bot.chat(`${dropped} items voor je neergelegd. Ik hou ${kept} zaad om door te planten.`);
  Logger.info(`Levering klaar: ${dropped} items gedropt, ${kept} zaad behouden`);
  return true;
}

// ---------------------------------------------------------------------------
// Oogstronde
// ---------------------------------------------------------------------------

async function harvestPass(bot, tasks, shouldStop, stats) {
  const result = { harvested: 0, replanted: 0, skipped: 0, paused: false, stopped: false };
  // Hoogstens één keer per ronde nieuw gereedschap gaan maken; zie de plek waar hij op 'none'
  // uitkomt, verderop in deze lus.
  let resupplyGeprobeerd = false;
  // Welk gewas hij nu onder handen heeft; buildTasks levert de taken per gewas gegroepeerd aan.
  let huidigGewas = null;

  for (const task of tasks) {
    if (shouldStop()) { result.stopped = true; return result; }
    if (inventoryFull(bot)) { result.paused = true; return result; }

    if (botState.isFleeing) {
      await new Promise(resolve => setTimeout(resolve, 500));
      continue;
    }

    // De wereld kan tussen scan en oogst veranderd zijn.
    let block = bot.blockAt(task.pos);
    if (!block || block.name !== task.expect) continue;

    if (distanceTo(bot, task.pos) > FARM.reachDistance) {
      if (!hasPathTo(bot, task.pos)) {
        Logger.debug(`Geen pad naar ${task.expect} op ${task.pos}, overgeslagen`);
        result.skipped++;
        continue;
      }
      try {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(task.pos.x, task.pos.y, task.pos.z, FARM.approachRange)),
          FARM.approachTimeout,
          'naar gewas lopen'
        );
      } catch (err) {
        Logger.debug(`Kon niet bij ${task.expect} komen: ${err.message}`);
        result.skipped++;
        continue;
      }
      if (shouldStop()) { result.stopped = true; return result; }
      block = bot.blockAt(task.pos);
      if (!block || block.name !== task.expect) continue;
    }

    // Rechtsklik-gewassen regelen hun eigen (niet-plaatsbare) hand in harvest().
    if (task.action !== 'activate') {
      let tool = await equipSafeTool(bot, task.def.tool);

      // Hier stopte het oogsten vroeger gewoon. Nu wordt er eerst geprobeerd om bij te maken
      // of te repareren; lukt dat, dan gaat de ronde verder. Eén poging per ronde, anders
      // loopt hij bij een lege grondstofkist heen en weer tussen akker en werkbank.
      if (tool === 'none' && CONFIG.toolsmith.autoResupply && !resupplyGeprobeerd) {
        resupplyGeprobeerd = true;
        bot.chat('Mijn gereedschap is op, ik maak eerst wat nieuws.');
        const { resupplyTools } = require('./toolsmith');
        await resupplyTools(bot, task.def.tool ? [task.def.tool] : undefined, { quiet: true });
        farmMovements(bot);   // het loopje naar de werkbank heeft de movements aangepast
        tool = await equipSafeTool(bot, task.def.tool);
      }

      if (tool === 'none') {
        bot.chat(`Al mijn gereedschap staat onder ${FARM.minToolDurability} duurzaamheid en ik kan niets wisselen. Ik stop met oogsten.`);
        Logger.warn('Oogsten gestopt: geen veilig gereedschap beschikbaar');
        result.stopped = true;
        return result;
      }
    }

    if (!await harvest(bot, task)) {
      result.skipped++;
      continue;
    }

    // Eén melding per gewas, niet per blok: zo is in de chat te volgen dat hij eerst de
    // tarwe afmaakt en daarna pas aan de wortels begint.
    if (task.def.block !== huidigGewas) {
      huidigGewas = task.def.block;
      Logger.info(`Begint aan ${huidigGewas}`);
      bot.chat(`Ik doe eerst alle ${huidigGewas}.`);
    }

    result.harvested++;
    stats[task.def.block] = (stats[task.def.block] ?? 0) + 1;

    // Even wachten: de server moet de drop sturen en de bot moet hem opgeraapt hebben,
    // anders is het zaad er nog niet om meteen terug te planten.
    await new Promise(resolve => setTimeout(resolve, 250));

    if (task.def.category === CATEGORY.REPLANT) {
      if (await replant(bot, task)) {
        result.replanted++;
      } else if (task.def.seed && !findItemExact(bot, task.def.seed)) {
        await sweepDrops(bot, shouldStop);
        if (await replant(bot, task)) result.replanted++;
      }
    }

    if (result.harvested % FARM.dropSweepInterval === 0) {
      await sweepDrops(bot, shouldStop);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hoofdfunctie
// ---------------------------------------------------------------------------

/**
 * Automatisch gewassen oogsten, terugplanten en de opbrengst bij de dichtstbijzijnde
 * speler afleveren — voor elk gewas met de manier die bij dat gewas hoort.
 *
 * Per ronde:
 *   1. scan 2 chunks rond de bot naar oogstbare gewassen
 *   2. controleer per doel of er een pad naartoe is voordat de bot gaat lopen
 *   3. oogst volgens de categorie van het gewas en plant waar nodig terug
 *   4. zit de inventaris vol, dan pauzeert de oogst
 *   5. breng de opbrengst naar de dichtstbijzijnde speler (1 stack zaad blijft achter)
 *      en begin daarna opnieuw bij 1
 *   6. is er niets meer te oogsten, loop dan nog een slotronde over het veld om alles op te
 *      rapen wat buiten de kleine sweep-straal is blijven liggen
 *
 * @param {import('mineflayer').Bot} bot
 * @returns {Promise<{harvested:number, replanted:number, skipped:number, rounds:number, perCrop:object}>}
 */
async function farmCrops(bot) {
  if (botState.isFarming) {
    bot.chat('Ik ben al aan het boeren!');
    return { harvested: 0, replanted: 0, skipped: 0, rounds: 0, perCrop: {} };
  }

  const session = ++botState.farmSession;
  botState.isFarming = true;
  botState.stopFarming = false;

  const totals = { harvested: 0, replanted: 0, skipped: 0, rounds: 0, bred: 0, pairs: 0, perCrop: {} };
  let superseded = false;

  const shouldStop = () => {
    if (botState.farmSession !== session) { superseded = true; return true; }
    return botState.stopFarming || !botState.isFarming;
  };

  farmMovements(bot);

  Logger.info(`FARM START: scanradius ${FARM.scanRadius}, ${CROP_LIST.length} gewassoorten in ${Object.keys(CATEGORY).length} categorieën`);
  bot.chat('Ik ga boeren!');

  let barrenRounds = 0;
  // De levering is uit de lus gehaald: het fokvoer (graan, wortels) zit in dezelfde
  // inventaris als de oogst, dus leveren vóór het fokken betekent voeren met lege handen.
  let deliverAtEnd = false;

  try {
    for (let round = 1; round <= FARM.maxRounds; round++) {
      if (shouldStop()) break;
      totals.rounds = round;

      // Stap 1
      const tasks = buildTasks(bot, scanCropBlocks(bot));
      Logger.info(`Ronde ${round}: ${tasks.length} oogstbare doelen`);

      if (tasks.length === 0) {
        if (round === 1) bot.chat('Ik zie geen oogstbare gewassen in de buurt.');
        break;
      }

      // Stap 2 t/m 4
      const pass = await harvestPass(bot, tasks, shouldStop, totals.perCrop);
      totals.harvested += pass.harvested;
      totals.replanted += pass.replanted;
      totals.skipped += pass.skipped;

      if (pass.stopped) break;

      barrenRounds = pass.harvested === 0 ? barrenRounds + 1 : 0;
      if (barrenRounds >= 2) {
        Logger.warn('Twee rondes op rij niets kunnen oogsten, farmen gestopt');
        bot.chat('Ik kom niet verder met boeren, ik stop ermee.');
        break;
      }

      await sweepDrops(bot, shouldStop);

      // Stap 5 -> terug naar stap 1
      if (pass.paused) {
        if (shouldStop()) break;
        if (!await deliverHarvest(bot)) {
          Logger.warn('Farmen gestopt: inventaris vol en niets geleverd');
          break;
        }
        farmMovements(bot); // de goto tijdens de levering kan de movements aangepast hebben
        continue;
      }

      deliverAtEnd = true;
      break;
    }

    // Slotronde: alles oprapen wat verspreid over de akker is blijven liggen. Dit moet hier,
    // vóór het voeren en leveren: daarna staat de bot bij de dieren of bij de speler en is
    // het veld allang buiten bereik.
    if (!shouldStop()) await sweepFieldDrops(bot, shouldStop);

    // Stap 6: eenmalig de dieren voeren. Dit gebeurt na het oogsten en vóór de levering,
    // zodat de bot het graan dat hij net geoogst heeft nog in zijn inventaris heeft.
    if (BREED.enabled && !shouldStop()) {
      const bred = await breedAnimals(bot, { shouldStop, announce: 'success' });
      totals.bred = bred.fed;
      totals.pairs = bred.pairs;
      farmMovements(bot); // het lopen naar de dieren heeft de movements aangepast
    }

    if (deliverAtEnd && !shouldStop()) await deliverHarvest(bot);
  } catch (err) {
    Logger.error('Farm error', err);
    bot.chat('Er ging iets mis met het boeren.');
  } finally {
    if (!superseded) {
      botState.isFarming = false;
      botState.stopFarming = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    } else {
      Logger.debug('Oude farm-run afgebroken door een nieuwe');
    }
  }

  const breakdown = Object.entries(totals.perCrop).map(([k, v]) => `${v}x ${k}`).join(', ');
  Logger.info(`FARM KLAAR: ${totals.harvested} geoogst, ${totals.replanted} teruggeplant, ${totals.skipped} overgeslagen (${totals.rounds} rondes)${breakdown ? ' | ' + breakdown : ''}`);
  if (!superseded && (totals.harvested > 0 || totals.pairs > 0)) {
    const fokdeel = totals.pairs > 0 ? `, ${totals.pairs} paar dieren gevoerd` : '';
    bot.chat(`Klaar met boeren: ${totals.harvested} geoogst, ${totals.replanted} teruggeplant${fokdeel}.`);
    if (breakdown) bot.chat(breakdown);
  }

  return totals;
}

function stopFarming(bot) {
  if (!botState.isFarming) {
    bot.chat('Ik ben niet aan het boeren.');
    return;
  }
  botState.stopFarming = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met boeren.');
  Logger.info('Farmen gestopt door gebruiker');
}

module.exports = {
  farmCrops,
  stopFarming,
  // geëxporteerd voor tests en hergebruik
  scanCropBlocks,
  buildTasks,
  isHarvestable,
  computeSurplus,
  equipSafeTool,
  equipNonPlaceable,
  replant,
  harvest,
  durabilityLeft,
};

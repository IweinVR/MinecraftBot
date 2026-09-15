/**
 * Dieren voeren zodat ze fokken. Wordt aangeroepen door !breed en, eenmalig per ronde, door
 * het farmen.
 *
 * "Eenmalig" is geen luiheid: de server stuurt niet mee of een dier al in love mode staat of
 * nog in zijn cooldown van vijf minuten zit. Dat is van buitenaf niet te zien. Een tweede hap
 * doet dus niets en kost alleen voer, en daarom telt elk dier per ronde precies één keer mee.
 *
 * Verder is het grotendeels filteren: baby's kunnen niet fokken, ongetemde paarden en wolven
 * eten het voer op zonder resultaat, en twee dieren die meer dan 8 blokken uit elkaar staan
 * gaan wel in love mode maar vinden elkaar nooit. Wat die filters uitleest (baby, getemd)
 * komt uit entity.metadata, en welke index dat is wordt per diersoort in het registry
 * opgezocht — die verschilt per soort en per spelversie.
 *
 * De zaadreserve van het farmen gaat altijd voor: wortels en zaad zijn tegelijk veevoer en
 * plantgoed, en de akker leegvoeren aan de varkens is geen winst.
 */

const { goals } = require('mineflayer-pathfinder');
const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout } = require('../utils');
const { SEED_ITEMS, PROTECTED_BLOCKS } = require('../data/crops');

const BREED = CONFIG.breeding;
const FARM = CONFIG.farming;

// ---------------------------------------------------------------------------
// Wat eet welk dier?
// ---------------------------------------------------------------------------
// Fokvoer is NIET hetzelfde als "wat het dier lekker vindt". Een koe eet geen brood en een
// paard fok je niet met een gewone appel. Dit zijn alleen de items waarmee het dier
// daadwerkelijk in love mode gaat.

// Wolven eten elk vlees behalve vis. Rotten flesh werkt ook (zij worden er niet ziek van).
const WOLF_FOODS = [
  'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken',
  'mutton', 'cooked_mutton', 'rabbit', 'cooked_rabbit', 'rotten_flesh',
];

// Bijen accepteren elke bloem. Wither rose staat er bewust niet bij: die doet schade.
const BEE_FOODS = [
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip',
  'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'torchflower',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'pink_petals', 'wildflowers', 'open_eyeblossom',
];

// Kippen fok je met elk zaad. 'pitcher_pod' is het zaad-item van de pitcher plant.
const CHICKEN_FOODS = [
  'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod',
];

const HORSE_FOODS = ['golden_carrot', 'golden_apple', 'enchanted_golden_apple'];

/**
 * @typedef {object} BreedSpec
 * @property {string[]} foods         items waarmee dit dier in love mode gaat
 * @property {boolean}  [needsTame]   ongetemde exemplaren negeren (paard, wolf, kat, lama)
 * @property {boolean}  [needsFullHp] wolven fokken alleen op volle health
 * @property {(bot: object, entity: object) => boolean} [extra] extra voorwaarde ter plaatse
 */

/** @type {Record<string, BreedSpec>} */
const BREEDABLE = {
  // --- klassiek boerenerf ---
  cow: { foods: ['wheat'] },
  mooshroom: { foods: ['wheat'] },
  sheep: { foods: ['wheat'] },
  goat: { foods: ['wheat'] },
  pig: { foods: ['carrot', 'potato', 'beetroot'] },
  chicken: { foods: CHICKEN_FOODS },
  rabbit: { foods: ['carrot', 'golden_carrot', 'dandelion'] },

  // --- rijdieren: moeten getemd zijn, anders eten ze het op zonder te fokken ---
  horse: { foods: HORSE_FOODS, needsTame: true },
  donkey: { foods: HORSE_FOODS, needsTame: true },
  llama: { foods: ['hay_block'], needsTame: true },
  trader_llama: { foods: ['hay_block'], needsTame: true },

  // --- huisdieren ---
  wolf: { foods: WOLF_FOODS, needsTame: true, needsFullHp: true },
  cat: { foods: ['cod', 'salmon'], needsTame: true },
  ocelot: { foods: ['cod', 'salmon'] },

  // --- de rest ---
  fox: { foods: ['sweet_berries', 'glow_berries'] },
  panda: { foods: ['bamboo'], extra: pandaHasBamboo },
  turtle: { foods: ['seagrass'] },
  bee: { foods: BEE_FOODS },
  strider: { foods: ['warped_fungus'] },
  hoglin: { foods: ['crimson_fungus'] },
  axolotl: { foods: ['tropical_fish'] },
  frog: { foods: ['slime_ball'] },
  sniffer: { foods: ['torchflower_seeds'] },
  camel: { foods: ['cactus'] },
  armadillo: { foods: ['spider_eye'] },
};

/** Panda's gaan alleen in love mode met minstens 8 bamboe-blokken binnen 5 blokken. */
function pandaHasBamboo(bot, entity) {
  const id = bot.registry.blocksByName.bamboo?.id;
  if (id === undefined) return false;
  const found = bot.findBlocks({ matching: [id], maxDistance: 5, count: 8, point: entity.position });
  return found.length >= 8;
}

// ---------------------------------------------------------------------------
// Metadata uitlezen
// ---------------------------------------------------------------------------
// entity.metadata is een kale array op index. Welke index welk veld is verschilt per
// diersoort en per spelversie, dus we zoeken de index op in het registry i.p.v. hem
// hard te coderen. Een veld dat op zijn standaardwaarde staat wordt door de server niet
// verstuurd, dus 'undefined' betekent "standaard", niet "onbekend".

function metaValue(bot, entity, key) {
  const keys = bot.registry.entitiesByName[entity.name]?.metadataKeys;
  if (!keys) return undefined;
  const index = keys.indexOf(key);
  if (index === -1) return undefined;
  return entity.metadata?.[index];
}

/** Babydieren kunnen niet fokken; voeren versnelt alleen hun groei en kost voer. */
function isBaby(bot, entity) {
  return metaValue(bot, entity, 'baby') === true;
}

/**
 * Getemd? Wolven en katten dragen een owner-UUID, paarden/ezels/lama's hebben bit 0x02
 * in hun 'flags'-byte staan.
 */
function isTamed(bot, entity) {
  const owner = metaValue(bot, entity, 'owneruuid');
  if (owner !== undefined && owner !== null) return true;

  const flags = metaValue(bot, entity, 'flags');
  if (typeof flags === 'number') return (flags & 0x02) !== 0;

  return false;
}

function isFullHealth(entity) {
  // entity.health is pas bekend zodra de server de metadata gestuurd heeft. Zolang we het
  // niet weten gaan we uit van gezond: een wolf die toch gewond is eet het vlees gewoon op.
  if (typeof entity.health !== 'number') return true;
  return entity.health >= 20;
}

// ---------------------------------------------------------------------------
// Voorraad
// ---------------------------------------------------------------------------

/**
 * Hoeveel van dit item mag opgevoerd worden.
 *
 * Zaad is dubbelop: 'carrot' is zowel varkensvoer als het plantgoed voor de akker. De
 * zaadreserve van het farmen gaat voor — anders voert de bot de akker leeg aan de varkens
 * en kan hij daarna niets meer terugplanten.
 */
function spareCount(bot, itemName) {
  const total = bot.inventory.items()
    .filter(i => i.name === itemName)
    .reduce((sum, i) => sum + i.count, 0);

  const reserve = (SEED_ITEMS.has(itemName) ? FARM.keepSeedCount : 0) + BREED.keepFoodCount;
  return Math.max(0, total - reserve);
}

/** Het eerste voer uit de lijst waar we genoeg van hebben. */
function pickFood(bot, foods) {
  for (const name of foods) {
    const spare = spareCount(bot, name);
    if (spare >= 2) return { name, spare }; // minder dan 2 is nooit een paar
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zoeken en paren
// ---------------------------------------------------------------------------

function distanceToEntity(bot, entity) {
  return bot.entity.position.distanceTo(entity.position);
}

/** Volwassen, fokbare dieren binnen scanRadius, per soort gegroepeerd en op afstand gesorteerd. */
function scanAnimals(bot) {
  const perSpecies = new Map();

  for (const entity of Object.values(bot.entities)) {
    if (!entity || !entity.position || entity === bot.entity) continue;
    if (!entity.name || !BREEDABLE[entity.name]) continue;
    if (distanceToEntity(bot, entity) > BREED.scanRadius) continue;

    const spec = BREEDABLE[entity.name];
    if (isBaby(bot, entity)) continue;
    if (spec.needsTame && !isTamed(bot, entity)) continue;
    if (spec.needsFullHp && !isFullHealth(entity)) continue;

    if (!perSpecies.has(entity.name)) perSpecies.set(entity.name, []);
    perSpecies.get(entity.name).push(entity);
  }

  for (const list of perSpecies.values()) {
    list.sort((a, b) => distanceToEntity(bot, a) - distanceToEntity(bot, b));
  }
  return perSpecies;
}

/**
 * Koppelt dieren twee aan twee.
 *
 * Alleen op afstand tot de bot sorteren is niet genoeg: twee koeien die elk 3 blokken van
 * de bot staan maar 20 van elkaar, gaan wel in love mode maar lopen nooit naar elkaar toe.
 * Vanilla laat ze elkaar zoeken binnen 8 blokken, dus dat is hier de eis.
 */
function makePairs(animals, maxPairs) {
  const pairs = [];
  const used = new Set();

  for (const a of animals) {
    if (pairs.length >= maxPairs) break;
    if (used.has(a.id)) continue;

    let partner = null;
    let best = Infinity;
    for (const b of animals) {
      if (b.id === a.id || used.has(b.id)) continue;
      const d = a.position.distanceTo(b.position);
      if (d <= BREED.pairRange && d < best) { best = d; partner = b; }
    }

    if (!partner) continue;
    used.add(a.id);
    used.add(partner.id);
    pairs.push([a, partner]);
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Lopen en voeren
// ---------------------------------------------------------------------------

function breedMovements(bot) {
  setMovements(bot, {
    canDig: false,        // net als bij het farmen: niets slopen om bij een dier te komen
    canPlace: false,
    allowSprinting: false,
    allowParkour: false,  // springen vertrapt akkerland tot gewone aarde
    protectBlocks: PROTECTED_BLOCKS,
  });
}

function hasPathTo(bot, pos) {
  const goal = new goals.GoalNear(pos.x, pos.y, pos.z, BREED.approachRange);
  const result = bot.pathfinder.getPathTo(bot.pathfinder.movements, goal, BREED.pathCheckTimeout);
  return !!result && result.status === 'success';
}

/**
 * Loopt naar een dier tot het binnen armbereik staat.
 *
 * Een dier is geen blok: het loopt weg terwijl de bot ernaartoe loopt. Daarom wordt de
 * entity elke poging opnieuw uit bot.entities gehaald (de oude referentie kan verouderd of
 * verdwenen zijn) en wordt er opnieuw gericht i.p.v. één keer een pad uit te rekenen.
 */
async function approachAnimal(bot, id, shouldStop) {
  for (let attempt = 0; attempt < BREED.approachAttempts; attempt++) {
    if (shouldStop()) return false;

    const live = bot.entities[id];
    if (!live || !live.position || !live.isValid) return false; // weggelopen, dood of uit zicht
    if (distanceToEntity(bot, live) <= BREED.reachDistance) return true;

    const target = live.position.floored();
    if (!hasPathTo(bot, target)) {
      Logger.debug(`Geen pad naar ${live.name} op ${target.x} ${target.y} ${target.z}`);
      return false;
    }

    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, BREED.approachRange)),
        BREED.approachTimeout,
        'naar dier lopen'
      );
    } catch (err) {
      Logger.debug(`Lopen naar ${live.name} mislukt: ${err.message}`);
    }
  }

  const live = bot.entities[id];
  return !!live && !!live.position && distanceToEntity(bot, live) <= BREED.reachDistance;
}

/** Voert één dier: juiste item in de hand en dan rechtsklikken. */
async function feedAnimal(bot, entity, foodName) {
  const item = bot.inventory.items().find(i => i.name === foodName);
  if (!item) return false;

  if (bot.heldItem?.name !== foodName) {
    await bot.equip(item, 'hand');
  }

  await bot.activateEntity(entity);
  await new Promise(resolve => setTimeout(resolve, BREED.feedDelay));
  return true;
}

// ---------------------------------------------------------------------------
// De ronde zelf
// ---------------------------------------------------------------------------

/**
 * Voert alle fokbare dieren in de buurt, precies één keer per aanroep (waarom: zie de kop
 * van dit bestand).
 *
 * @param {object} bot
 * @param {object} [opts]
 * @param {() => boolean} [opts.shouldStop] afbreekvlag van de aanroeper (bv. het farmen)
 * @param {'always'|'success'|'never'} [opts.announce] wanneer er in de chat gemeld wordt.
 *   Het farmen gebruikt 'success': anders meldt de bot na élke oogstronde dat hij geen
 *   dieren ziet, ook als je alleen om gewassen gevraagd hebt.
 * @returns {Promise<{fed: number, pairs: number, perSpecies: Record<string, number>, skipped: string[]}>}
 */
async function breedAnimals(bot, opts = {}) {
  const shouldStop = opts.shouldStop ?? (() => false);
  const announce = opts.announce ?? 'always';
  const result = { fed: 0, pairs: 0, perSpecies: {}, skipped: [] };

  const perSpecies = scanAnimals(bot);
  if (perSpecies.size === 0) {
    Logger.info('Fokken: geen volwassen fokbare dieren in de buurt');
    if (announce === 'always') bot.chat('Ik zie geen dieren om te fokken.');
    return result;
  }

  breedMovements(bot);

  // Elk dier hoogstens één keer, ook als het in twee soortlijsten zou opduiken.
  const gevoerd = new Set();

  for (const [species, animals] of perSpecies) {
    if (shouldStop()) break;

    if (animals.length < 2) {
      result.skipped.push(`${species} (maar 1 volwassen exemplaar)`);
      continue;
    }

    const food = pickFood(bot, BREEDABLE[species].foods);
    if (!food) {
      result.skipped.push(`${species} (geen voer)`);
      continue;
    }

    const maxPairs = Math.min(BREED.maxPairsPerSpecies, Math.floor(food.spare / 2));
    const pairs = makePairs(animals, maxPairs);
    if (pairs.length === 0) {
      result.skipped.push(`${species} (staan te ver uit elkaar)`);
      continue;
    }

    Logger.info(`Fokken: ${pairs.length} paar ${species} met ${food.name}`);

    for (const pair of pairs) {
      if (shouldStop()) break;

      let gevoerdInPaar = 0;
      for (const animal of pair) {
        if (shouldStop()) break;
        if (gevoerd.has(animal.id)) continue;

        // Voorraad kan tussendoor op zijn geraakt (ander paar, of de akker die zaad opeist).
        if (spareCount(bot, food.name) < 1) {
          Logger.debug(`${food.name} op, ${species} gestopt`);
          break;
        }

        const extra = BREEDABLE[species].extra;
        if (extra && !extra(bot, animal)) {
          result.skipped.push(`${species} (voorwaarde niet voldaan)`);
          continue;
        }

        if (!await approachAnimal(bot, animal.id, shouldStop)) {
          Logger.debug(`Kon niet bij ${species} #${animal.id} komen`);
          continue;
        }

        const live = bot.entities[animal.id];
        if (!live) continue;

        try {
          if (!await feedAnimal(bot, live, food.name)) continue;
          gevoerd.add(animal.id);
          gevoerdInPaar++;
          result.fed++;
          result.perSpecies[species] = (result.perSpecies[species] ?? 0) + 1;
        } catch (err) {
          Logger.warn(`Voeren van ${species} mislukt: ${err.message}`);
        }
      }

      // Alleen een volledig paar levert een kalf op. Eén dier in love mode staat te wachten
      // tot het afkoelt; dat tellen we niet als geslaagd.
      if (gevoerdInPaar === 2) result.pairs++;
    }
  }

  const overzicht = Object.entries(result.perSpecies).map(([k, v]) => `${v}x ${k}`).join(', ');
  Logger.info(`FOKKEN KLAAR: ${result.fed} dieren gevoerd, ${result.pairs} paren${overzicht ? ' | ' + overzicht : ''}`);
  if (result.skipped.length > 0) Logger.debug(`Overgeslagen: ${result.skipped.join(', ')}`);

  if (announce !== 'never') {
    if (result.pairs > 0) {
      bot.chat(`${result.pairs} paar gevoerd (${overzicht}). Er komen babies aan!`);
    } else if (result.fed > 0) {
      bot.chat(`${result.fed} dier(en) gevoerd, maar geen compleet paar.`);
    } else if (announce === 'always') {
      bot.chat('Ik kon geen enkel dier fokken.');
      if (result.skipped.length > 0) bot.chat(`Reden: ${result.skipped.slice(0, 3).join(', ')}`);
    }
  }

  return result;
}

/** Losse !breed-ronde, met eigen sessie-bewaking zodat !stop hem ook afkapt. */
async function breedOnce(bot) {
  if (botState.isBreeding) {
    bot.chat('Ik ben al aan het fokken!');
    return null;
  }

  const session = ++botState.breedSession;
  botState.isBreeding = true;
  botState.stopBreeding = false;

  const shouldStop = () => botState.breedSession !== session || botState.stopBreeding;

  try {
    return await breedAnimals(bot, { shouldStop });
  } catch (err) {
    Logger.error('Fok-fout', err);
    bot.chat('Er ging iets mis met het fokken.');
    return null;
  } finally {
    if (botState.breedSession === session) {
      botState.isBreeding = false;
      botState.stopBreeding = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }
}

module.exports = {
  breedAnimals,
  breedOnce,
  // geëxporteerd voor tests en hergebruik
  BREEDABLE,
  scanAnimals,
  makePairs,
  pickFood,
  spareCount,
  isBaby,
  isTamed,
};

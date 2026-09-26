/**
 * Vissen. De bot zoekt open water, gaat op de oever staan en werpt uit tot zijn inventaris
 * vol is; daarna legt hij de vangst in de invoerkist en laat het sorteren de rest uitzoeken.
 *
 * bot.fish() doet het werpen en binnenhalen, maar is kaler dan hij lijkt. Vier dingen die je
 * er zelf omheen moet bouwen, en die hieronder dus ook allemaal terugkomen:
 *
 *  1. Hij pakt de hengel NIET zelf. bot.fish() roept alleen activateItem() aan — heb je een
 *     schep vast, dan gooi je met een schep en gebeurt er niets.
 *
 *  2. Hij kent geen timeout. De promise wordt pas vervuld als het "fishing"-deeltjespakket
 *     binnenkomt. Landt de dobber op het gras, of mist de client dat ene pakket, dan wacht
 *     hij tot het einde der tijden.
 *
 *  3. Hij kan afwijzen. Verdwijnt de dobber (entity_destroy), dan gooit hij 'Fishing
 *     cancelled'. Dat is geen storing maar de normale gang van zaken: auto-eat haalt de
 *     hengel uit je hand om te eten en blaast de worp daarmee op.
 *
 *  4. Twee keer bot.fish() tegelijk breekt de eerste af met een afwijzing. Zonder een .catch
 *     op de oude promise is dat een unhandled rejection en in moderne Node een harde crash.
 *
 * De richting waarin je kijkt bepaalt waar de dobber landt, dus het mikken op open water een
 * paar blokken verderop is het halve werk.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout, hasPathTo, abortable, chatList } = require('../utils');
const { closeWindow, openContainerAt, sleep } = require('../lib/containers');
const { findInputChest, sortItems, sortableItems, STORAGE_BLOCKS } = require('./sorting');

const FISH = CONFIG.fishing;
const ROD = 'fishing_rod';

const HORIZONTAAL = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
];

// ---------------------------------------------------------------------------
// Hengel
// ---------------------------------------------------------------------------

function durabilityLeft(item) {
  if (!item || !item.maxDurability) return Infinity;
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

/** De hengel met de meeste slijtage over, mits die niet bijna kapot is. */
function bestRod(bot) {
  return bot.inventory.items()
    .filter(i => i.name === ROD)
    .filter(i => durabilityLeft(i) > FISH.minRodDurability)
    .sort((a, b) => durabilityLeft(b) - durabilityLeft(a))[0] ?? null;
}

/**
 * Zorgt dat er een bruikbare hengel in de hand zit.
 *
 * Dit gebeurt vóór élke worp, niet één keer aan het begin: auto-eat en de armor-manager
 * kunnen tussendoor iets anders in de hand duwen, en dan werp je met een broodje.
 */
async function equipRod(bot) {
  if (bot.heldItem?.name === ROD && durabilityLeft(bot.heldItem) > FISH.minRodDurability) return true;

  const hengel = bestRod(bot);
  if (!hengel) return false;

  await bot.equip(hengel, 'hand');
  return true;
}

/**
 * De dobber binnenhalen.
 *
 * bot.fish() heeft geen afbreek-knop: zolang er niets bijt blijft de lijn liggen. Nog een
 * keer met de hengel klikken haalt hem binnen, precies zoals een speler dat zelf doet.
 * Zonder dat blijft de lijn na een !stop of een timeout in het water hangen, en dan haalt
 * de eerstvolgende bot.fish() hem alleen maar binnen in plaats van opnieuw te werpen --
 * elke tweede worp was dan een lege klik.
 *
 * Alleen aanroepen zolang de worp nog loopt. Is de dobber al weg (de 'Fishing cancelled'
 * die auto-eat veroorzaakt), dan werpt deze klik juist een nieuwe lijn uit waar niemand
 * meer op wacht.
 */
function reelIn(bot) {
  if (bot.heldItem?.name !== ROD) return;
  try {
    bot.activateItem();
  } catch (err) {
    Logger.debug(`Kon de dobber niet binnenhalen: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Een visstek zoeken
// ---------------------------------------------------------------------------

function isAir(block) {
  return !!block && (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air');
}

/** Water met lucht erboven: alleen daar kan een dobber landen. */
function isOpenWater(bot, pos) {
  const blok = bot.blockAt(pos);
  if (!blok || blok.name !== 'water') return false;
  return isAir(bot.blockAt(pos.offset(0, 1, 0)));
}

/**
 * Zoekt een plek om te staan en een punt om op te mikken.
 *
 * De bot moet op de kant staan, niet in het water: zwemmend werpen werkt wel, maar dan trekt
 * de stroming hem weg en verdwijnt de dobber steeds. Daarom wordt er een oeverblok gezocht —
 * een vast blok naast het water met twee blokken lucht erboven.
 *
 * @returns {{stand: Vec3, mik: Vec3} | null}
 */
async function findFishingSpot(bot) {
  const waterId = bot.registry.blocksByName.water?.id;
  if (waterId === undefined) return null;

  const water = bot.findBlocks({
    matching: [waterId],
    maxDistance: FISH.waterRadius,
    count: FISH.waterSamples,
  }).filter(pos => isOpenWater(bot, pos));

  if (water.length === 0) return null;

  const botPos = bot.entity.position;
  const dichtbijEerst = [...water].sort((a, b) => botPos.distanceTo(a) - botPos.distanceTo(b));

  for (const plas of dichtbijEerst) {
    for (const richting of HORIZONTAAL) {
      const oever = plas.plus(richting);
      const grond = bot.blockAt(oever);
      if (!grond || grond.name === 'water' || isAir(grond)) continue;      // geen vaste kant
      if (!isAir(bot.blockAt(oever.offset(0, 1, 0)))) continue;            // geen ruimte voor voeten
      if (!isAir(bot.blockAt(oever.offset(0, 2, 0)))) continue;            // geen ruimte voor hoofd

      const stand = oever.offset(0, 1, 0);
      if (!await hasPathTo(bot, stand, FISH)) continue;

      // Verder het water op mikken dan het blok pal voor je neus: mik je te dichtbij, dan
      // ketst de dobber op de oever en gebeurt er niets.
      const mik = water
        .filter(p => {
          const d = stand.distanceTo(p);
          return d >= FISH.minCastDistance && d <= FISH.maxCastDistance;
        })
        .sort((a, b) => stand.distanceTo(b) - stand.distanceTo(a))[0] ?? plas;

      return { stand, mik };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Eén worp
// ---------------------------------------------------------------------------

/** Momentopname van de inventaris, om te zien wat er bij een worp bij kwam. */
function snapshot(bot) {
  const telling = new Map();
  for (const item of bot.inventory.items()) {
    telling.set(item.name, (telling.get(item.name) ?? 0) + item.count);
  }
  return telling;
}

function diff(voor, na) {
  const erbij = {};
  for (const [naam, aantal] of na) {
    const verschil = aantal - (voor.get(naam) ?? 0);
    if (verschil > 0) erbij[naam] = verschil;
  }
  return erbij;
}

/**
 * Eén keer uitwerpen en binnenhalen.
 *
 * @returns {Promise<{gevangen: object|null, reden: string|null}>}
 */
async function castOnce(bot, mik, shouldStop) {
  if (!await equipRod(bot)) return { gevangen: null, reden: 'geen bruikbare hengel' };

  try {
    // Elke worp opnieuw richten: de bot kan geduwd zijn door stroming of een mob.
    await bot.lookAt(mik.offset(0.5, 1, 0.5), true);
  } catch (err) {
    Logger.debug(`Kon niet naar het water kijken: ${err.message}`);
  }

  if (shouldStop()) return { gevangen: null, reden: 'gestopt' };

  const voor = snapshot(bot);

  // Loopt de worp nog? Zo niet, dan is de dobber weg (binnengehaald of door de server
  // vernietigd) en mag reelIn() er niet overheen klikken.
  let worpKlaar = false;
  const worp = bot.fish();
  // Verliest bot.fish() de race met de timeout, dan wordt hij later alsnog afgewezen (de
  // volgende bot.fish() breekt hem af). Zonder deze handler is dat een unhandled rejection.
  worp.then(() => { worpKlaar = true; }, () => { worpKlaar = true; });

  try {
    // Behalve op de timeout wordt er ook op shouldStop() gepolld. Zonder dat merkt !stop pas
    // na castTimeout (40 seconden) dat hij mag ophouden, en zolang blijft de bot gewoon aan
    // het vissen -- precies waarom !stop aanvoelde alsof hij er niets mee deed.
    await abortable(withTimeout(worp, FISH.castTimeout, 'wachten op een beet'), shouldStop);
  } catch (err) {
    if (!worpKlaar) reelIn(bot);
    return { gevangen: null, reden: err.message };
  }

  // De vis vliegt naar de bot toe en wordt vanzelf opgepakt; even wachten tot de server dat
  // heeft doorgegeven, anders zie je in de inventaris nog niets.
  await sleep(FISH.pickupDelay);

  return { gevangen: diff(voor, snapshot(bot)), reden: null };
}

// ---------------------------------------------------------------------------
// De vangst wegbrengen
// ---------------------------------------------------------------------------

/**
 * Legt de vangst in de invoerkist van het sorteersysteem en laat het sorteren hem verdelen.
 *
 * Bewust niet zelf uitzoeken in welke kist welke vis hoort: dat kan het sorteren al, inclusief
 * de categorieën en de whitelist. sortableItems() bepaalt hier ook wat "vangst" is — de
 * hengel en het eten dat de bot bij zich houdt vallen daar vanzelf buiten.
 */
async function deliverCatch(bot, shouldStop) {
  const stats = { gestort: 0, proviand: 0, gesorteerd: false };

  // sortableItems() houdt tot CONFIG.sorting.keepFood aan eten achter. Dat is hier precies
  // goed: de bot loopt met een paar vissen op zak als proviand en bergt de rest op. Bij een
  // korte visbeurt kan het dus zijn dat er alleen rommel (bot, leer) de kist in gaat.
  const vracht = sortableItems(bot);
  stats.proviand = bot.inventory.items()
    .filter(i => !!bot.registry?.foodsByName?.[i.name])
    .reduce((som, i) => som + i.count, 0)
    - vracht.filter(i => !!bot.registry?.foodsByName?.[i.name]).reduce((som, i) => som + i.count, 0);

  if (vracht.length === 0) {
    Logger.debug(`Niets te leveren (${stats.proviand} als proviand gehouden)`);
    return stats;
  }

  const { pos, reden } = findInputChest(bot);
  if (!pos) {
    bot.chat(`Ik kan de invoerkist niet vinden: ${reden}. Ik hou de vangst bij me.`);
    return stats;
  }

  const window = await openContainerAt(bot, pos, shouldStop, {
    ...FISH, allowed: STORAGE_BLOCKS, label: 'invoerkist',
  });
  if (!window) {
    bot.chat('Ik kan de invoerkist niet openen, ik hou de vangst bij me.');
    return stats;
  }

  try {
    for (const item of vracht) {
      try {
        await window.deposit(item.type, null, item.count);
        stats.gestort += item.count;
      } catch (err) {
        Logger.warn(`Kon ${item.name} niet in de kist leggen: ${err.message}`);
        break;
      }
    }
  } finally {
    await closeWindow(bot, window, FISH);
  }

  Logger.info(`${stats.gestort} items in de invoerkist gelegd`);

  if (FISH.sortAfter && stats.gestort > 0 && !shouldStop()) {
    await sortItems(bot);
    stats.gesorteerd = true;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// De hele sessie
// ---------------------------------------------------------------------------

function fishMovements(bot) {
  setMovements(bot, {
    canDig: false,
    canPlace: false,
    allowSprinting: true,
    allowParkour: false,
  });
}

function inventoryFull(bot) {
  return bot.inventory.emptySlotCount() <= FISH.minFreeSlots;
}

/**
 * Vist tot de inventaris vol is, de hengel op is, of het opgegeven aantal worpen bereikt is.
 *
 * @param {object} bot
 * @param {number} [maxCasts] hoeveel keer uitwerpen; standaard uit config
 */
async function fishForItems(bot, maxCasts = FISH.maxCasts) {
  if (botState.isFishing) {
    bot.chat('Ik ben al aan het vissen!');
    return null;
  }

  const session = ++botState.fishSession;
  botState.isFishing = true;
  botState.stopFishing = false;
  const shouldStop = () => botState.fishSession !== session || botState.stopFishing;

  const totaal = { worpen: 0, gevangen: 0, perSoort: {}, gestort: 0, proviand: 0, mislukt: 0 };
  // Of de sessie door de speler is afgebroken. Moet vastliggen vóór het finally-blok
  // stopFishing weer op false zet, anders weet het eindrapport niet meer wat er gebeurd is.
  let afgebroken = false;

  try {
    if (!bestRod(bot)) {
      bot.chat('Ik heb geen (hele) hengel.');
      return totaal;
    }

    fishMovements(bot);

    const stek = await findFishingSpot(bot);
    if (!stek) {
      bot.chat('Ik zie geen open water waar ik bij kan.');
      return totaal;
    }

    Logger.info(`Visstek: staan op ${stek.stand.x} ${stek.stand.y} ${stek.stand.z}, mikken op ${stek.mik.x} ${stek.mik.y} ${stek.mik.z}`);

    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalBlock(stek.stand.x, stek.stand.y, stek.stand.z)),
        FISH.approachTimeout,
        'naar het water lopen'
      );
    } catch (err) {
      Logger.warn(`Kon de visstek niet bereiken: ${err.message}`);
      bot.chat('Ik kan niet bij het water komen.');
      return totaal;
    }

    // Stilstaan tijdens het vissen. Een lopende bot sleept zijn dobber mee en vangt niets.
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();

    bot.chat('Ik ga vissen!');

    let opRij = 0;
    for (let worp = 1; worp <= maxCasts; worp++) {
      if (shouldStop()) break;

      if (inventoryFull(bot)) {
        Logger.info('Inventaris vol, stoppen met vissen');
        break;
      }
      if (!bestRod(bot)) {
        bot.chat('Mijn hengel is bijna kapot, ik stop ermee.');
        break;
      }

      const { gevangen, reden } = await castOnce(bot, stek.mik, shouldStop);

      // Eerst bijschrijven, dan pas op stoppen kijken: een vis die net binnenkwam hoort in
      // het eindrapport, ook als de speler er op datzelfde moment !stop achteraan typt.
      if (gevangen) {
        totaal.worpen++;
        opRij = 0;
        for (const [naam, aantal] of Object.entries(gevangen)) {
          totaal.perSoort[naam] = (totaal.perSoort[naam] ?? 0) + aantal;
          totaal.gevangen += aantal;
        }
      }

      // Een worp die door !stop is afgebroken is geen misser: niet als worp meetellen, niet
      // wachten, en niet opnieuw werpen.
      if (shouldStop()) break;

      if (reden) {
        totaal.worpen++;
        totaal.mislukt++;
        opRij++;
        Logger.debug(`Worp ${worp} mislukt: ${reden}`);
        // Een paar missers zijn normaal (auto-eat, een mob die langs zwemt). Blijft het
        // misgaan, dan klopt er iets niet aan de stek en heeft doorgaan geen zin.
        if (opRij >= FISH.maxFailuresInRow) {
          bot.chat('Het vissen lukt hier niet, ik stop.');
          break;
        }
      }

      await sleep(FISH.recastDelay);
    }

    if (FISH.deliverAfter && totaal.gevangen > 0 && !shouldStop()) {
      const levering = await deliverCatch(bot, shouldStop);
      totaal.gestort = levering.gestort;
      totaal.proviand = levering.proviand;
    }
  } catch (err) {
    Logger.error('Visfout', err);
    bot.chat('Er ging iets mis met vissen.');
  } finally {
    afgebroken = shouldStop();

    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, FISH).catch(() => {});
    bot.clearControlStates();

    if (botState.fishSession === session) {
      botState.isFishing = false;
      botState.stopFishing = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  const soorten = Object.entries(totaal.perSoort)
    .sort((a, b) => b[1] - a[1])
    .map(([naam, aantal]) => `${aantal}x ${naam}`);
  Logger.info(`VISSEN ${afgebroken ? 'AFGEBROKEN' : 'KLAAR'}: ${totaal.worpen} worpen, `
    + `${totaal.gevangen} gevangen (${totaal.mislukt} mislukt), ${totaal.gestort} opgeborgen`
    + `${soorten.length ? ' | ' + soorten.join(', ') : ''}`);

  // Ook een afgebroken sessie somt de hele vangst op: wie !stop typt wil juist weten wat hij
  // tot dan toe heeft binnengehaald. Alleen een sessie die door een NIEUWE !vis is ingehaald
  // zwijgt, anders praat de oude run door de nieuwe heen.
  if (botState.fishSession === session) {
    const kop = afgebroken ? 'Gestopt met vissen' : 'Klaar met vissen';
    if (totaal.gevangen > 0) {
      bot.chat(`${kop}: ${totaal.gevangen} items uit ${totaal.worpen} worpen.`);
      chatList(bot, 'Gevangen: ', soorten);
      if (totaal.gestort > 0) bot.chat(`${totaal.gestort} in de kist gelegd.`);
      else if (afgebroken) bot.chat('De vangst hou ik bij me; met !leeg leg ik hem bij je neer.');
      if (totaal.proviand > 0) bot.chat(`${totaal.proviand} eten hou ik als proviand.`);
    } else if (afgebroken || totaal.worpen > 0) {
      bot.chat(`${kop}: nog niets gevangen in ${totaal.worpen} worpen.`);
    }
  }

  return totaal;
}

function stopFishing(bot) {
  if (!botState.isFishing) {
    bot.chat('Ik ben niet aan het vissen.');
    return;
  }
  botState.stopFishing = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met vissen.');
  Logger.info('Vissen gestopt door gebruiker');
}

module.exports = {
  fishForItems,
  stopFishing,
  // geëxporteerd voor tests en hergebruik
  findFishingSpot,
  isOpenWater,
  bestRod,
  equipRod,
  castOnce,
  reelIn,
  deliverCatch,
  durabilityLeft,
};

/**
 * Handelsbot: gewassen uit een kist halen, bij dorpelingen omruilen voor smaragden en die
 * smaragden in een kluiskist leggen.
 *
 * Alles loopt via mineflayers ingebouwde bot.openVillager() / bot.trade(); er wordt nergens
 * handmatig in het venster geklikt. Dat is geen stijlkeuze: bot.trade() regelt het
 * select_trade-pakket, het vullen van de invoerslots, het ophalen van slot 2 en de restanten
 * die 1.14+ vanzelf terugstuurt. Dat met de hand nabouwen gaat gegarandeerd desyncen.
 *
 * Drie dingen uit de mineflayer-bron die je moet weten om deze code te volgen:
 *
 *  1. Het veld heet trade.tradeDisabled, NIET trade.disabled. Dat laatste bestaat niet en is
 *     dus altijd undefined — je zou daarmee eeuwig op een dichtgeslagen handel blijven rammen.
 *
 *  2. De prijs is trade.realPrice, niet inputItem1.count. Vraag en reputatie kunnen de prijs
 *     verhogen; bot.trade() stort realPrice per ruil, dus daar moet je ook op rekenen als je
 *     uitrekent hoeveel ruilen je je kunt veroorloven.
 *
 *  3. bot.openVillager() doet een assert op het entity-type. Een wandering_trader of een
 *     zombievillager laat hem hard klappen, dus er wordt streng op naam gefilterd.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG, CHEST_BLOCKS } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout, hasPathTo } = require('../utils');
const { closeWindow, openContainerAt, equipNonPlaceable, returnCursorItem, sleep } = require('../lib/containers');
const storage = require('../lib/storage');

const TRADE = CONFIG.trading;

// Waar de bot gewassen uit mag halen en smaragden in mag leggen.
const CONTAINER_BLOCKS = [...CHEST_BLOCKS, 'barrel'];

/**
 * Gewassen die een boer-dorpeling koopt. Precies deze, en alleen deze — een dorpeling die
 * iets anders vraagt is geen boer en wordt overgeslagen.
 *
 * Zoetebessen en glow berries staan er bewust niet bij: die koopt geen enkele boer.
 */
const TRADEABLE_CROPS = new Set([
  'wheat', 'carrot', 'potato', 'beetroot', 'pumpkin', 'melon',
  'sugar_cane', 'sweet_berries',
]);

const EMERALD = 'emerald';

// ---------------------------------------------------------------------------
// Handels beoordelen
// ---------------------------------------------------------------------------

/**
 * Is dit een gewas-naar-smaragd ruil die wij willen doen?
 *
 * Drie eisen, en elk ervan sluit iets concreets uit:
 *   - uitvoer is smaragd        -> sluit "smaragd voor brood" uit, dat is juist de omgekeerde kant
 *   - invoer staat in onze lijst -> sluit de bibliothecaris (papier) en de visser (vis) uit
 *   - geen tweede invoerslot     -> ruilen met twee invoeren zijn altijd koop-ruilen
 */
function isCropSale(trade) {
  if (!trade?.outputItem || !trade.inputItem1) return false;
  if (trade.outputItem.name !== EMERALD) return false;
  if (!TRADEABLE_CROPS.has(trade.inputItem1.name)) return false;
  if (trade.hasItem2) return false;
  return true;
}

/** Hoeveel keer kan deze ruil nog voordat de dorpeling hem dichtslaat? */
function usesLeft(trade) {
  if (trade.tradeDisabled) return 0;
  return Math.max(0, (trade.maximumNbTradeUses ?? 0) - (trade.nbTradeUses ?? 0));
}

/** Hoeveel van dit item heeft de bot? */
function countItem(bot, itemName) {
  return bot.inventory.items()
    .filter(i => i.name === itemName)
    .reduce((som, i) => som + i.count, 0);
}

/**
 * Hoeveel ruilen kunnen we nu doen?
 *
 * Het minimum van drie dingen: wat de dorpeling nog aankan, wat we aan gewas hebben, en
 * hoeveel smaragden er nog in de inventaris passen. Dat laatste is geen overdreven
 * voorzichtigheid: bot.trade() doet per ruil een putAway(2) om de smaragd op te halen, en
 * zonder vrij slot loopt die vast met een venster dat openstaat.
 */
function affordableTrades(bot, trade) {
  const prijs = trade.realPrice ?? trade.inputItem1.count;
  if (prijs <= 0) return 0;

  const voorraad = Math.floor(countItem(bot, trade.inputItem1.name) / prijs);
  const ruimte = bot.inventory.emptySlotCount() > 0
    ? Number.MAX_SAFE_INTEGER
    : countItem(bot, EMERALD) > 0 ? Number.MAX_SAFE_INTEGER : 0;

  return Math.max(0, Math.min(usesLeft(trade), voorraad, ruimte));
}

// ---------------------------------------------------------------------------
// Dorpelingen vinden
// ---------------------------------------------------------------------------

/**
 * Alle echte dorpelingen binnen de zoekstraal, dichtstbijzijnde eerst.
 *
 * De naamcheck is streng met opzet: bot.openVillager() doet
 * assert.strictEqual(entity.entityType, villagerId) en een AssertionError uit een assert is
 * niet iets waar je netjes van herstelt. Wandering traders, zombievillagers en illagers
 * komen er dus niet doorheen.
 */
function findVillagers(bot, center) {
  const vanaf = center ?? bot.entity.position;
  return Object.values(bot.entities)
    .filter(e => e && e.position && e.name === 'villager' && e.isValid !== false)
    .filter(e => vanaf.distanceTo(e.position) <= TRADE.villagerRadius)
    .sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))
    .slice(0, TRADE.maxVillagers);
}

/**
 * Loopt naar een dorpeling toe. Dorpelingen lopen rond, dus de entity wordt elke poging
 * opnieuw uit bot.entities gehaald in plaats van één keer een pad uit te rekenen naar waar
 * hij toevallig stond.
 */
async function approachVillager(bot, id, shouldStop) {
  for (let poging = 0; poging < TRADE.approachAttempts; poging++) {
    if (shouldStop()) return false;

    const levend = bot.entities[id];
    if (!levend || !levend.position || levend.isValid === false) return false;
    if (bot.entity.position.distanceTo(levend.position) <= TRADE.reachDistance) return true;

    const doel = levend.position.floored();
    if (!await hasPathTo(bot, doel, TRADE)) {
      Logger.debug(`Geen pad naar dorpeling #${id}`);
      return false;
    }

    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(doel.x, doel.y, doel.z, TRADE.approachRange)),
        TRADE.approachTimeout,
        'naar dorpeling lopen'
      );
    } catch (err) {
      Logger.debug(`Lopen naar dorpeling mislukt: ${err.message}`);
    }
  }

  const levend = bot.entities[id];
  return !!levend && !!levend.position
    && bot.entity.position.distanceTo(levend.position) <= TRADE.reachDistance;
}

// ---------------------------------------------------------------------------
// Handelen met één dorpeling
// ---------------------------------------------------------------------------

/**
 * Opent het handelsscherm en ruilt alles wat kan.
 *
 * Het venster wordt in een finally gesloten, ook als bot.trade() halverwege gooit. Blijft het
 * openstaan, dan weigert de server het volgende openVillager() en staat de bot de rest van de
 * ronde tegen een dorpeling aan te kijken.
 *
 * @returns {Promise<{geruild: number, smaragden: number, gesloten: boolean, reden: string|null}>}
 *   gesloten = elke bruikbare ruil van deze dorpeling zit nu op slot
 *   reden    = waarom er niets geruild is (voor de melding in de chat), null als het wel lukte
 */
async function tradeWithVillager(bot, entity, shouldStop) {
  const stats = { geruild: 0, smaragden: 0, gesloten: false, reden: null };

  if (!await approachVillager(bot, entity.id, shouldStop)) {
    Logger.debug('Kon niet bij de dorpeling komen');
    stats.reden = 'onbereikbaar';
    return stats;
  }

  // Niet strikt nodig (use_entity plaatst geen blokken), maar het scheelt een verrassing als
  // de bot per ongeluk tegen een blok aanklikt terwijl hij een stapel aarde vasthoudt.
  await equipNonPlaceable(bot);

  let villager = null;
  try {
    // openVillager wacht op windowOpen én op de handelslijst. Komt een van beide niet, dan
    // hangt dit eeuwig; een dorpeling die net gaat slapen of in een boot stapt doet dat.
    villager = await withTimeout(bot.openVillager(entity), TRADE.openTimeout, 'handelsscherm openen');
  } catch (err) {
    Logger.warn(`Handelsscherm ging niet open: ${err.message}`);
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, TRADE);
    stats.reden = 'ging niet open';
    return stats;
  }

  try {
    if (!Array.isArray(villager.trades) || villager.trades.length === 0) {
      Logger.debug('Dorpeling heeft geen handel (nog geen beroep?)');
      stats.reden = 'koopt geen gewassen';
      return stats;
    }

    const bruikbaar = villager.trades
      .map((trade, index) => ({ trade, index }))
      .filter(({ trade }) => isCropSale(trade));

    if (bruikbaar.length === 0) {
      Logger.debug(`Dorpeling handelt niet in gewassen (${villager.trades.length} ruilen bekeken)`);
      stats.reden = 'koopt geen gewassen';
      return stats;
    }

    const smaragdenVoor = countItem(bot, EMERALD);
    let vastgelopen = false;

    for (const { trade, index } of bruikbaar) {
      if (shouldStop() || vastgelopen) break;

      // Zolang de handel niet op slot zit en we het kunnen betalen, doorgaan. bot.trade()
      // werkt nbTradeUses en tradeDisabled bij, dus deze lus loopt vanzelf leeg.
      while (!shouldStop()) {
        const aantal = Math.min(affordableTrades(bot, trade), TRADE.maxPerCall);
        if (aantal < 1) break;

        try {
          // bot.trade() wacht na het kiezen van de ruil tot de server de invoerslots vult, en
          // daar zit geen timeout op. Komt die update nooit, dan bleef !trade eeuwig hangen
          // en antwoordde de bot daarna op elke !trade "Ik ben al aan het handelen!".
          await withTimeout(bot.trade(villager, index, aantal), TRADE.tradeTimeout, 'ruilen');
          stats.geruild += aantal;
          Logger.debug(`${aantal}x geruild: ${trade.realPrice} ${trade.inputItem1.name} -> ${trade.outputItem.count} smaragd`);
        } catch (err) {
          // 'trade blocked' en 'Not enough item' zijn normale eindes, geen fouten.
          Logger.debug(`Ruil gestopt: ${err.message}`);
          // Na een timeout is het venster in een onbekende staat: niet verder met deze dorpeling.
          if (/timeout/.test(err.message)) vastgelopen = true;
          break;
        }

        await sleep(TRADE.tradeDelay);
      }

      if (usesLeft(trade) === 0) {
        Logger.debug(`Handel ${trade.inputItem1.name} -> smaragd zit op slot`);
      }
    }

    stats.smaragden = countItem(bot, EMERALD) - smaragdenVoor;
    stats.gesloten = bruikbaar.every(({ trade }) => usesLeft(trade) === 0);

    if (stats.geruild === 0) {
      const kanBetalen = ({ trade }) => countItem(bot, trade.inputItem1.name) >= (trade.realPrice ?? trade.inputItem1.count);
      if (vastgelopen) stats.reden = 'ruilen liep vast';
      else if (stats.gesloten) stats.reden = 'uitverkocht';
      else if (!bruikbaar.some(kanBetalen)) stats.reden = 'wil een gewas dat ik niet (genoeg) heb';
      else stats.reden = 'ruilen mislukte';
    }
  } finally {
    // Altijd sluiten, ook na een fout: een openstaand venster blokkeert de volgende dorpeling.
    await closeWindow(bot, villager, TRADE);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Kisten
// ---------------------------------------------------------------------------

function findChest(bot, coords, radius, label) {
  if (coords) {
    const pos = new Vec3(coords.x, coords.y, coords.z);
    const block = bot.blockAt(pos);
    if (!block) return { pos: null, reden: 'die plek is niet geladen' };
    if (!CONTAINER_BLOCKS.includes(block.name)) return { pos: null, reden: `daar staat geen kist maar ${block.name}` };
    return { pos, reden: null };
  }

  const ids = CONTAINER_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined);
  const gevonden = bot.findBlocks({ matching: ids, maxDistance: radius, count: 1 });
  if (gevonden.length === 0) return { pos: null, reden: `geen ${label} in de buurt` };
  return { pos: gevonden[0], reden: null };
}

/**
 * De voorraadkist als er geen coördinaten meegegeven zijn.
 *
 * De dichtstbijzijnde kist kan net zo goed de kluis of een willekeurige opslagkist zijn, en dan
 * meldt !trade "maar 0 gewassen". Weet de bot van !index of !sort al wat waar ligt, dan pakt hij
 * de kist met de meeste verhandelbare gewassen.
 */
function findCropChest(bot) {
  const perKist = new Map();
  for (const naam of TRADEABLE_CROPS) {
    for (const treffer of storage.lookup(naam)) {
      if (bot.entity.position.distanceTo(treffer.pos) > TRADE.chestRadius) continue;
      const sleutel = treffer.pos.toString();
      const kist = perKist.get(sleutel) ?? { pos: treffer.pos, aantal: 0 };
      kist.aantal += treffer.count;
      perKist.set(sleutel, kist);
    }
  }

  const beste = [...perKist.values()].sort((a, b) => b.aantal - a.aantal)[0];
  if (beste && CONTAINER_BLOCKS.includes(bot.blockAt(beste.pos)?.name)) {
    return { pos: beste.pos, reden: null };
  }
  return findChest(bot, null, TRADE.chestRadius, 'voorraadkist');
}

const openChest = (bot, pos, shouldStop, label) =>
  openContainerAt(bot, pos, shouldStop, { ...TRADE, allowed: CONTAINER_BLOCKS, label });

/**
 * Haalt verhandelbare gewassen uit de voorraadkist.
 *
 * minStock voorkomt zinloze loopjes: minder dan dat halen betekent een wandeling naar de
 * handelshal voor een handvol tarwe, waar geen enkele ruil uit komt.
 */
async function withdrawCrops(bot, window, shouldStop) {
  const stats = { opgehaald: 0, perGewas: {} };

  for (const item of window.containerItems()) {
    if (shouldStop()) break;
    if (!TRADEABLE_CROPS.has(item.name)) continue;

    if (bot.inventory.emptySlotCount() <= TRADE.minFreeSlots) {
      Logger.info('Inventaris vol, rest van de gewassen blijft liggen');
      break;
    }

    // Aantal vooraf vastleggen: containerItems() geeft de echte slot-objecten terug en
    // withdraw() zet de count daarvan op nul.
    const aantal = item.count;
    const naam = item.name;

    try {
      await window.withdraw(item.type, null, aantal);
      stats.opgehaald += aantal;
      stats.perGewas[naam] = (stats.perGewas[naam] ?? 0) + aantal;
      Logger.debug(`${aantal}x ${naam} uit de voorraadkist gehaald`);
    } catch (err) {
      Logger.warn(`Kon ${naam} niet oppakken: ${err.message}`);
      if (/full/i.test(err.message)) break;
    }
  }

  return stats;
}

/**
 * Hoeveel van de opgehaalde gewassen draagt de bot nog bij zich?
 *
 * Alleen wat hij uit de kist haalde gaat terug, niet wat hij zelf al had (van het boeren
 * bijvoorbeeld). Ruilen verbruikt eerst het opgehaalde: had hij 10 eigen tarwe, haalde hij er
 * 64 bij en ruilde hij er 40 weg, dan gaan er 24 terug en houdt hij zijn eigen 10.
 */
function leftoverCrops(bot, meegenomen, eigen) {
  const rest = {};
  for (const [naam, aantal] of Object.entries(meegenomen)) {
    const over = Math.min(aantal, countItem(bot, naam) - (eigen[naam] ?? 0));
    if (over > 0) rest[naam] = over;
  }
  return rest;
}

/**
 * Legt de gewassen die niet geruild zijn terug in de (geopende) voorraadkist.
 * Werkt `meegenomen` bij, zodat een tweede aanroep niets dubbel teruglegt.
 */
async function returnCrops(bot, window, meegenomen, eigen) {
  let teruggelegd = 0;

  for (const [naam, aantal] of Object.entries(leftoverCrops(bot, meegenomen, eigen))) {
    const type = bot.registry.itemsByName[naam]?.id;
    if (type === undefined) continue;
    try {
      await window.deposit(type, null, aantal);
      teruggelegd += aantal;
      meegenomen[naam] -= aantal;
      Logger.debug(`${aantal}x ${naam} terug in de voorraadkist`);
    } catch (err) {
      // Kist vol: wat al aan de cursor hing terug de inventaris in, anders valt het op de grond.
      Logger.warn(`Kon ${naam} niet terugleggen: ${err.message}`);
      await returnCursorItem(bot, window);
      break;
    }
  }

  return teruggelegd;
}

/** Legt alle smaragden in de kluiskist. */
async function depositEmeralds(bot, window) {
  let gestort = 0;

  for (const item of bot.inventory.items()) {
    if (item.name !== EMERALD) continue;
    const aantal = item.count;
    try {
      await window.deposit(item.type, null, aantal);
      gestort += aantal;
    } catch (err) {
      Logger.warn(`Kon smaragden niet storten: ${err.message}`);
      break;
    }
  }

  return gestort;
}

// ---------------------------------------------------------------------------
// De hele ronde
// ---------------------------------------------------------------------------

function tradeMovements(bot) {
  setMovements(bot, {
    canDig: false,    // eis: nooit blokken breken
    canPlace: false,  // eis: nooit blokken plaatsen
    allowSprinting: true,
    allowParkour: false,
  });
}

/**
 * Eén handelsronde: gewassen ophalen, langs de dorpelingen, smaragden wegbergen, en wat niet
 * geruild kon worden terug in de voorraadkist.
 *
 * @param {object} bot
 * @param {object} [opts]
 * @param {{x,y,z}} [opts.cropChest] voorraadkist; standaard de kist met de meeste gewassen volgens
 *                                   de index, en zonder index de dichtstbijzijnde kist
 * @param {{x,y,z}} [opts.hall]      middelpunt van de handelshal; standaard waar de bot staat
 * @param {{x,y,z}} [opts.vault]     kluiskist; standaard de voorraadkist
 */
async function tradeCrops(bot, opts = {}) {
  if (botState.isTrading) {
    bot.chat('Ik ben al aan het handelen!');
    return null;
  }

  const session = ++botState.tradeSession;
  botState.isTrading = true;
  botState.stopTrading = false;
  const shouldStop = () => botState.tradeSession !== session || botState.stopTrading;

  const totaal = { opgehaald: 0, geruild: 0, smaragden: 0, dorpelingen: 0, gestort: 0, teruggelegd: 0 };
  const redenen = {};       // waarom het bij een dorpeling niet lukte -> hoe vaak
  let window = null;

  try {
    tradeMovements(bot);

    // --- stap 1: gewassen ophalen ---
    const { pos: kistPos, reden } = opts.cropChest
      ? findChest(bot, opts.cropChest, TRADE.chestRadius, 'voorraadkist')
      : findCropChest(bot);
    if (!kistPos) {
      bot.chat(`Ik kan de voorraadkist niet vinden: ${reden}.`);
      return totaal;
    }

    window = await openChest(bot, kistPos, shouldStop, 'voorraadkist');
    if (!window) {
      bot.chat('Ik kan de voorraadkist niet openen.');
      return totaal;
    }

    // Wat de bot zelf al bij zich had blijft van hem; alleen het opgehaalde gaat straks terug.
    const eigen = Object.fromEntries([...TRADEABLE_CROPS].map(naam => [naam, countItem(bot, naam)]));
    const oogst = await withdrawCrops(bot, window, shouldStop);
    const meegenomen = { ...oogst.perGewas };
    totaal.opgehaald = oogst.opgehaald;

    if (oogst.opgehaald < TRADE.minStock) {
      // Meteen terug in dezelfde kist, die staat toch nog open.
      await returnCrops(bot, window, meegenomen, eigen);
      await closeWindow(bot, window, TRADE);
      window = null;
      bot.chat(`Maar ${oogst.opgehaald} gewassen in de kist, dat is de wandeling niet waard.`);
      return totaal;
    }

    await closeWindow(bot, window, TRADE);
    window = null;

    const lijst = Object.entries(oogst.perGewas).map(([k, v]) => `${v}x ${k}`).join(', ');
    bot.chat(`${oogst.opgehaald} gewassen opgehaald (${lijst}), ik ga handelen.`);

    // --- stap 2: naar de handelshal ---
    if (opts.hall && !shouldStop()) {
      const hal = new Vec3(opts.hall.x, opts.hall.y, opts.hall.z);
      if (await hasPathTo(bot, hal, TRADE)) {
        try {
          await withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(hal.x, hal.y, hal.z, TRADE.hallRange)),
            TRADE.travelTimeout,
            'naar de handelshal lopen'
          );
        } catch (err) {
          Logger.warn(`Kon de handelshal niet bereiken: ${err.message}`);
        }
      } else {
        bot.chat('Ik kan niet bij de handelshal komen.');
      }
    }

    // --- stap 3 t/m 6: langs de dorpelingen ---
    const dorpelingen = findVillagers(bot, opts.hall ? new Vec3(opts.hall.x, opts.hall.y, opts.hall.z) : null);
    if (dorpelingen.length === 0) {
      bot.chat('Ik zie geen dorpelingen om mee te handelen.');
    } else {
      Logger.info(`${dorpelingen.length} dorpelingen gevonden`);
    }

    for (const dorpeling of dorpelingen) {
      if (shouldStop()) break;

      // Geen gewas meer over? Dan hoeven de rest van de dorpelingen niet meer.
      const nogGewas = [...TRADEABLE_CROPS].some(naam => countItem(bot, naam) > 0);
      if (!nogGewas) {
        Logger.info('Alle gewassen geruild');
        break;
      }

      const resultaat = await tradeWithVillager(bot, dorpeling, shouldStop);
      if (resultaat.geruild > 0) {
        totaal.dorpelingen++;
        totaal.geruild += resultaat.geruild;
        totaal.smaragden += resultaat.smaragden;
      } else if (resultaat.reden) {
        redenen[resultaat.reden] = (redenen[resultaat.reden] ?? 0) + 1;
      }
    }

    if (totaal.geruild === 0 && Object.keys(redenen).length > 0) {
      const waarom = Object.entries(redenen).map(([r, n]) => `${n}x ${r}`).join(', ');
      bot.chat(`Niks kunnen ruilen met ${dorpelingen.length} dorpelingen: ${waarom}.`);
    }

    // --- stap 7: smaragden wegbergen ---
    // Zonder aparte kluis gaan ze in de voorraadkist: dat is wat de uitleg belooft. Eerder werd
    // dat de dichtstbijzijnde kist van waar de bot na het handelen stond.
    const kluis = opts.vault
      ? findChest(bot, opts.vault, TRADE.chestRadius, 'kluiskist')
      : { pos: kistPos, reden: null };
    const kluisIsVoorraad = !!kluis.pos && kluis.pos.equals(kistPos);

    const smaragden = countItem(bot, EMERALD);
    if (smaragden > 0 && !shouldStop()) {
      if (!kluis.pos) {
        bot.chat(`Ik kan de kluiskist niet vinden: ${kluis.reden}. Ik hou de smaragden bij me.`);
      } else {
        window = await openChest(bot, kluis.pos, shouldStop, 'kluiskist');
        if (window) {
          totaal.gestort = await depositEmeralds(bot, window);
          // Zelfde kist? Dan meteen ook de rest van de gewassen erin, scheelt een keer openen.
          if (kluisIsVoorraad) totaal.teruggelegd += await returnCrops(bot, window, meegenomen, eigen);
          await closeWindow(bot, window, TRADE);
          window = null;
        } else {
          bot.chat('Ik kan de kluiskist niet openen, ik hou de smaragden bij me.');
        }
      }
    }

    // --- stap 8: wat niet geruild is terug in de voorraadkist ---
    if (!shouldStop() && Object.keys(leftoverCrops(bot, meegenomen, eigen)).length > 0) {
      window = await openChest(bot, kistPos, shouldStop, 'voorraadkist');
      if (window) {
        totaal.teruggelegd += await returnCrops(bot, window, meegenomen, eigen);
        await closeWindow(bot, window, TRADE);
        window = null;
      }
      if (Object.keys(leftoverCrops(bot, meegenomen, eigen)).length > 0) {
        bot.chat('Ik kon niet alle gewassen terugleggen in de voorraadkist, de rest hou ik bij me.');
      }
    }
  } catch (err) {
    Logger.error('Handelsfout', err);
    bot.chat('Er ging iets mis met handelen.');
  } finally {
    // Wat er ook misgaat: het venster moet dicht, anders weigert de server het volgende.
    if (window) await closeWindow(bot, window, TRADE).catch(() => {});
    else if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, TRADE).catch(() => {});

    if (botState.tradeSession === session) {
      botState.isTrading = false;
      botState.stopTrading = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`HANDELEN KLAAR: ${totaal.opgehaald} gewassen opgehaald, ${totaal.geruild} ruilen `
    + `met ${totaal.dorpelingen} dorpelingen, ${totaal.smaragden} smaragden, ${totaal.gestort} gestort, `
    + `${totaal.teruggelegd} gewassen teruggelegd`);

  if (botState.tradeSession === session) {
    if (totaal.geruild > 0) {
      bot.chat(`Klaar: ${totaal.geruild} ruilen met ${totaal.dorpelingen} dorpelingen, ${totaal.smaragden} smaragden verdiend.`);
    }
    if (totaal.gestort > 0) bot.chat(`${totaal.gestort} smaragden in de kluis gelegd.`);
    if (totaal.teruggelegd > 0) bot.chat(`${totaal.teruggelegd} gewassen die ik niet kwijt kon teruggelegd in de voorraadkist.`);
  }

  return totaal;
}

function stopTrading(bot) {
  if (!botState.isTrading) {
    bot.chat('Ik ben niet aan het handelen.');
    return;
  }
  botState.stopTrading = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met handelen.');
  Logger.info('Handelen gestopt door gebruiker');
}

module.exports = {
  tradeCrops,
  stopTrading,
  // geëxporteerd voor tests en hergebruik
  TRADEABLE_CROPS,
  isCropSale,
  usesLeft,
  affordableTrades,
  countItem,
  findVillagers,
  tradeWithVillager,
  withdrawCrops,
  depositEmeralds,
  findChest,
};

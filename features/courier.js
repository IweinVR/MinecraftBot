/**
 * Voorraadkoerier: het omgekeerde van sorteren. Jij vraagt iets, de bot zoekt op in welke kist
 * het ligt, haalt het op en legt het voor je neer.
 *
 * Het zoekwerk kost hier bijna niets, want het sorteren onthoudt in lib/storage.js al wat er in
 * elke kist ligt. Deze module slaat dat op en gaat er meteen naartoe, in plaats van opnieuw
 * de hele opslag af te lopen.
 *
 * Die index is per definitie een momentopname: jij kunt intussen zelf spullen uit een kist
 * hebben gehaald. Daarom wordt er bij aankomst gecontroleerd wat er écht ligt, en klopt het
 * niet, dan wordt de index bijgewerkt en de volgende kist geprobeerd. De index heeft dus geen
 * gelijk te hebben — hij hoeft alleen te voorkomen dat de bot alles hoeft af te lopen.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout, findNearestEntity } = require('../utils');
const { closeWindow, openContainerAt } = require('../lib/containers');
const { STORAGE_BLOCKS } = require('./sorting');
const storage = require('../lib/storage');

const KOERIER = CONFIG.courier;

// ---------------------------------------------------------------------------
// Zoekterm omzetten naar een echte itemnaam
// ---------------------------------------------------------------------------

/**
 * "cobblestone", "Cobble Stone" en "cobble" moeten alle drie bij cobblestone uitkomen.
 *
 * Eerst exact, dan een deeltreffer. Levert een deeltreffer meerdere kandidaten op, dan
 * kiezen we die welke daadwerkelijk in de opslag ligt — vraag je om "cobble" terwijl er
 * alleen cobblestone in een kist ligt, dan is cobblestone_stairs geen zinnige kandidaat.
 *
 * @returns {{naam: string|null, kandidaten: string[]}}
 */
function resolveItem(bot, invoer) {
  const zoek = String(invoer).toLowerCase().trim().replace(/\s+/g, '_');
  if (!zoek) return { naam: null, kandidaten: [] };

  if (bot.registry.itemsByName[zoek]) return { naam: zoek, kandidaten: [] };

  const alle = Object.keys(bot.registry.itemsByName);
  const treffers = alle.filter(n => n.includes(zoek));
  if (treffers.length === 0) return { naam: null, kandidaten: [] };
  if (treffers.length === 1) return { naam: treffers[0], kandidaten: [] };

  // Meerdere mogelijk: laat de opslag beslissen.
  const inOpslag = storage.knownItems();
  const aanwezig = treffers.filter(n => inOpslag.has(n));
  if (aanwezig.length === 1) return { naam: aanwezig[0], kandidaten: [] };
  if (aanwezig.length > 1) return { naam: null, kandidaten: aanwezig.slice(0, 5) };

  return { naam: null, kandidaten: treffers.slice(0, 5) };
}

/**
 * Zelfde idee als resolveItem, maar disambigueert met wat ze ECHT bij zich heeft in plaats
 * van de kisten-index — logisch, want !geef gaat over haar eigen inventaris.
 */
function resolveOwnItem(bot, invoer) {
  const zoek = String(invoer).toLowerCase().trim().replace(/\s+/g, '_');
  if (!zoek) return { naam: null, kandidaten: [] };

  if (bot.registry.itemsByName[zoek]) return { naam: zoek, kandidaten: [] };

  const alle = Object.keys(bot.registry.itemsByName);
  const treffers = alle.filter(n => n.includes(zoek));
  if (treffers.length === 0) return { naam: null, kandidaten: [] };
  if (treffers.length === 1) return { naam: treffers[0], kandidaten: [] };

  const bijZich = new Set(bot.inventory.items().map(i => i.name));
  const aanwezig = treffers.filter(n => bijZich.has(n));
  if (aanwezig.length === 1) return { naam: aanwezig[0], kandidaten: [] };
  if (aanwezig.length > 1) return { naam: null, kandidaten: aanwezig.slice(0, 5) };

  return { naam: null, kandidaten: treffers.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// Kisten
// ---------------------------------------------------------------------------

function findAllChests(bot) {
  const ids = STORAGE_BLOCKS.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined);
  if (ids.length === 0) return [];
  // Twee keer zoveel blokken als kisten: een dubbele kist zijn twee blokken. Met maxChests
  // blokken viel bij een opslagmuur van dubbele kisten de verste helft van de muur af.
  return bot.findBlocks({ matching: ids, maxDistance: KOERIER.chestRadius, count: KOERIER.maxChests * 2 })
    .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
}

// facing.getClockWise() uit vanilla, als [dx, dz].
const RECHTSOM = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] };

/**
 * De andere helft van een dubbele kist, of null bij een enkele kist (of een ton, shulker, ...).
 *
 * Elke helft is een eigen blok, dus zonder dit werd een dubbele kist twee keer geopend en
 * stond dezelfde inhoud twee keer in de index. Welke kant de andere helft zit volgt uit de
 * blokstate, net als in vanilla (ChestBlock.getConnectedDirection): type=left hoort bij de kist
 * rechtsom van zijn facing, type=right bij die linksom. GeyserMC rekent het precies zo uit
 * (DoubleChestBlockEntityTranslator). Niet overnemen uit mineflayers FACING_MAP in
 * block_actions.js: die staat andersom.
 */
function chestPartner(bot, pos) {
  const blok = bot.blockAt(pos);
  const props = blok?.getProperties?.() ?? {};
  const rechtsom = RECHTSOM[props.facing];
  if (!rechtsom || (props.type !== 'left' && props.type !== 'right')) return null;

  const [dx, dz] = props.type === 'left' ? rechtsom : [-rechtsom[0], -rechtsom[1]];
  const partner = pos.offset(dx, 0, dz);
  const ander = bot.blockAt(partner);
  const anderProps = ander?.getProperties?.() ?? {};
  if (ander?.name !== blok.name || anderProps.facing !== props.facing || anderProps.type === props.type) return null;
  return partner;
}

const openChest = (bot, pos, shouldStop) =>
  openContainerAt(bot, pos, shouldStop, { ...KOERIER, allowed: STORAGE_BLOCKS, label: 'kist' });

/**
 * Loopt langs alle kisten in de buurt en schrijft de inhoud in de index, zonder iets te
 * verplaatsen. Dit is wat !index doet, en wat !haal zelf doet als de index nog leeg is.
 *
 * @returns {Promise<{bekeken: number, mislukt: Vec3[]}>} mislukt = kisten die niet open gingen
 */
async function buildIndex(bot, shouldStop) {
  const kisten = findAllChests(bot);
  const gehad = new Set();   // andere helften van dubbele kisten die al bekeken zijn
  const stats = { bekeken: 0, mislukt: [] };

  for (const pos of kisten) {
    if (shouldStop() || stats.bekeken >= KOERIER.maxChests) break;
    if (gehad.has(pos.toString())) continue;

    const window = await openChest(bot, pos, shouldStop);
    if (!window) {
      if (shouldStop()) break;
      storage.forget(pos);
      stats.mislukt.push(pos);
      continue;
    }

    storage.record(pos, window.containerItems());
    const partner = chestPartner(bot, pos);
    if (partner) {
      gehad.add(partner.toString());
      storage.forget(partner);   // kan er nog van het sorteren in staan, dan telde hij dubbel
    }
    await closeWindow(bot, window, KOERIER);
    stats.bekeken++;
  }

  if (stats.mislukt.length > 0) {
    Logger.warn(`Index: ${stats.mislukt.length} kisten niet open gekregen: `
      + stats.mislukt.map(p => `${p.x} ${p.y} ${p.z}`).join(', '));
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Ophalen
// ---------------------------------------------------------------------------

function countItem(bot, itemName) {
  return bot.inventory.items()
    .filter(i => i.name === itemName)
    .reduce((som, i) => som + i.count, 0);
}

/**
 * Haalt tot `gevraagd` stuks uit één kist.
 *
 * @returns {Promise<number>} hoeveel er daadwerkelijk uitgekomen is
 */
async function takeFromChest(bot, pos, itemName, gevraagd, shouldStop) {
  const window = await openChest(bot, pos, shouldStop);
  if (!window) {
    // Kist weg, vol gebouwd of onbereikbaar: uit de index, anders komt hij elke keer terug.
    storage.forget(pos);
    return 0;
  }

  let gepakt = 0;
  try {
    for (const item of window.containerItems()) {
      if (shouldStop() || gepakt >= gevraagd) break;
      if (item.name !== itemName) continue;
      if (bot.inventory.emptySlotCount() <= KOERIER.minFreeSlots) {
        Logger.info('Inventaris vol tijdens het ophalen');
        break;
      }

      // Aantal vooraf vastleggen: containerItems() geeft de echte slot-objecten terug en
      // withdraw() zet de count daarvan op nul.
      const aantal = Math.min(item.count, gevraagd - gepakt);
      try {
        await window.withdraw(item.type, null, aantal);
        gepakt += aantal;
      } catch (err) {
        Logger.warn(`Kon ${itemName} niet pakken: ${err.message}`);
        break;
      }
    }

    // De index bijwerken met wat er nu écht ligt — ook als we niets vonden. Zo corrigeert
    // een verkeerde index zichzelf bij het eerste bezoek.
    storage.record(pos, window.containerItems());
  } finally {
    await closeWindow(bot, window, KOERIER);
  }

  return gepakt;
}

/** Loopt naar de speler en legt het gevraagde voor hem neer. */
async function handOver(bot, username, itemName, aantal, shouldStop) {
  const speler = bot.players?.[username]?.entity
    ?? findNearestEntity(bot, e => e.type === 'player' && e.username !== bot.username);

  if (!speler) {
    bot.chat(`Ik kan je niet vinden, ${username}. Ik hou het bij me.`);
    return 0;
  }

  const doel = speler.position.floored();
  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(doel.x, doel.y, doel.z, KOERIER.approachRange)),
      KOERIER.deliverTimeout,
      'naar de speler lopen'
    );
  } catch (err) {
    Logger.warn(`Kon niet bij de speler komen: ${err.message}`);
    bot.chat('Ik kom er niet bij, ik leg het hier neer.');
  }

  if (shouldStop()) return 0;

  // Naar het hoofd kijken geeft een vlakke hoek, waardoor bot.toss() het item ver voorbij de
  // speler gooit. Naar zijn voeten kijken geeft een steile hoek, dus valt het vlak bij hem neer.
  try {
    if (speler.isValid) await bot.lookAt(speler.position);
  } catch (err) {
    Logger.debug('Kon niet naar de speler kijken');
  }

  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) return 0;

  // Alleen weggeven wat we deze ronde opgehaald hebben. Had de bot zelf al 10 stenen, dan
  // blijven die van hem.
  const geven = Math.min(aantal, countItem(bot, itemName));
  try {
    await bot.toss(item.type, null, geven);
    return geven;
  } catch (err) {
    Logger.warn(`Kon ${itemName} niet neerleggen: ${err.message}`);
    return 0;
  }
}

function courierMovements(bot) {
  setMovements(bot, {
    canDig: false,    // eis: nooit blokken breken
    canPlace: false,  // eis: nooit blokken plaatsen
    allowSprinting: true,
    allowParkour: false,
  });
}

/**
 * De hele opdracht: opzoeken, ophalen, afleveren.
 *
 * @param {object} bot
 * @param {string} username wie erom vroeg
 * @param {string} zoekterm itemnaam of deel daarvan
 * @param {number|null} [gevraagd] aantal; standaard één stapel van dat item
 */
async function fetchItem(bot, username, zoekterm, gevraagd = null) {
  if (botState.isFetching) {
    bot.chat('Ik ben al iets aan het halen!');
    return null;
  }

  const session = ++botState.fetchSession;
  botState.isFetching = true;
  botState.stopFetching = false;
  const shouldStop = () => botState.fetchSession !== session || botState.stopFetching;

  const totaal = { item: null, gevraagd: 0, opgehaald: 0, geleverd: 0, kisten: 0 };

  try {
    courierMovements(bot);

    const { naam, kandidaten } = resolveItem(bot, zoekterm);
    if (!naam) {
      if (kandidaten.length > 0) bot.chat(`Bedoel je: ${kandidaten.join(', ')}?`);
      else bot.chat(`Ik ken geen item dat "${zoekterm}" heet.`);
      return totaal;
    }
    totaal.item = naam;

    const stapel = bot.registry.itemsByName[naam]?.stackSize ?? 64;
    const wil = Math.min(gevraagd ?? stapel, KOERIER.maxAmount);
    totaal.gevraagd = wil;

    // Nog nooit gesorteerd of geïndexeerd? Dan eerst kijken wat er staat.
    if (storage.isEmpty()) {
      bot.chat('Ik weet nog niet wat waar ligt, ik kijk even rond...');
      const { bekeken } = await buildIndex(bot, shouldStop);
      Logger.info(`Index opgebouwd: ${bekeken} kisten`);
      if (bekeken === 0) {
        bot.chat('Ik zie hier geen kisten.');
        return totaal;
      }
    }

    let treffers = storage.lookup(naam);
    if (treffers.length === 0) {
      // Misschien is de index gewoon oud. Eén keer opnieuw kijken voor we opgeven.
      bot.chat(`Ik heb geen ${naam} in mijn lijst, ik loop de kisten even na...`);
      await buildIndex(bot, shouldStop);
      treffers = storage.lookup(naam);
    }

    if (treffers.length === 0) {
      bot.chat(`Ik kan nergens ${naam} vinden.`);
      return totaal;
    }

    // Dichtstbijzijnde eerst: bij een gelijk aantal scheelt dat de meeste loopafstand.
    const botPos = bot.entity.position;
    treffers.sort((a, b) => botPos.distanceTo(a.pos) - botPos.distanceTo(b.pos));

    bot.chat(`Ik haal ${wil} ${naam} voor je.`);

    for (const treffer of treffers) {
      if (shouldStop() || totaal.opgehaald >= wil) break;
      const gepakt = await takeFromChest(bot, treffer.pos, naam, wil - totaal.opgehaald, shouldStop);
      if (gepakt > 0) {
        totaal.opgehaald += gepakt;
        totaal.kisten++;
        Logger.debug(`${gepakt}x ${naam} uit de kist op ${treffer.pos.x} ${treffer.pos.y} ${treffer.pos.z}`);
      }
    }

    if (totaal.opgehaald === 0) {
      bot.chat(`Er lag toch geen ${naam} meer. Mijn lijst is bijgewerkt.`);
      return totaal;
    }

    if (!shouldStop()) {
      totaal.geleverd = await handOver(bot, username, naam, totaal.opgehaald, shouldStop);
    }
  } catch (err) {
    Logger.error('Koeriersfout', err);
    bot.chat('Er ging iets mis met halen.');
  } finally {
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, KOERIER).catch(() => {});

    if (botState.fetchSession === session) {
      botState.isFetching = false;
      botState.stopFetching = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`HALEN KLAAR: ${totaal.opgehaald}/${totaal.gevraagd} ${totaal.item} `
    + `uit ${totaal.kisten} kisten, ${totaal.geleverd} geleverd`);

  if (botState.fetchSession === session && totaal.geleverd > 0) {
    const tekort = totaal.gevraagd - totaal.geleverd;
    bot.chat(`Alsjeblieft: ${totaal.geleverd} ${totaal.item}.`
      + (tekort > 0 ? ` Meer had ik niet, ${tekort} tekort.` : ''));
  }

  return totaal;
}

// ---------------------------------------------------------------------------
// Geven
// ---------------------------------------------------------------------------

/**
 * !geef <aantal> <item> — het omgekeerde van !haal: dit haalt niks uit een kist, maar geeft
 * iets weg dat ze op dit moment zelf bij zich draagt (bv. gereedschap, wat ze net gemined
 * heeft, ...). Zonder aantal krijg je alles wat ze ervan heeft.
 *
 * Eigen sessie/vlag (isGiving) i.p.v. isFetching hergebruiken: anders zou !geef een lopende
 * !haal afbreken en andersom, terwijl het allebei losse, korte klusjes zijn.
 */
async function giveItem(bot, username, zoekterm, gevraagd = null) {
  if (botState.isGiving) {
    bot.chat('Ik ben al iets aan het geven!');
    return null;
  }
  if (botState.isFetching) {
    bot.chat('Ik ben eerst nog aan het halen, momentje!');
    return null;
  }

  const session = ++botState.giveSession;
  botState.isGiving = true;
  botState.stopGiving = false;
  const shouldStop = () => botState.giveSession !== session || botState.stopGiving;

  const totaal = { item: null, inBezit: 0, wil: 0, gegeven: 0 };

  try {
    const { naam, kandidaten } = resolveOwnItem(bot, zoekterm);
    if (!naam) {
      if (kandidaten.length > 0) bot.chat(`Bedoel je: ${kandidaten.join(', ')}?`);
      else bot.chat(`Ik ken geen item dat "${zoekterm}" heet.`);
      return totaal;
    }
    totaal.item = naam;

    const inBezit = countItem(bot, naam);
    totaal.inBezit = inBezit;
    if (inBezit === 0) {
      bot.chat(`Ik heb geen ${naam} bij me.`);
      return totaal;
    }

    totaal.wil = Math.min(gevraagd ?? inBezit, inBezit);

    courierMovements(bot);
    bot.chat(`Komt eraan: ${totaal.wil} ${naam}.`);
    totaal.gegeven = await handOver(bot, username, naam, totaal.wil, shouldStop);
  } catch (err) {
    Logger.error('Geeffout', err);
    bot.chat('Er ging iets mis met geven.');
  } finally {
    if (botState.giveSession === session) {
      botState.isGiving = false;
      botState.stopGiving = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  if (botState.giveSession === session && totaal.gegeven > 0) {
    const mislukt = totaal.wil - totaal.gegeven;
    const achtergehouden = totaal.inBezit - totaal.wil;
    bot.chat(`Alsjeblieft: ${totaal.gegeven} ${totaal.item}.`
      + (mislukt > 0 ? ` De rest lukte niet neer te leggen.` : '')
      + (mislukt === 0 && achtergehouden > 0 ? ` De overige ${achtergehouden} hou ik zelf.` : ''));
  }

  return totaal;
}

function stopGiving(bot) {
  if (!botState.isGiving) {
    bot.chat('Ik ben niets aan het geven.');
    return;
  }
  botState.stopGiving = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met geven.');
  Logger.info('Geven gestopt door gebruiker');
}

// ---------------------------------------------------------------------------
// Opzoeken zonder te lopen
// ---------------------------------------------------------------------------

/** !waar <item> — vertelt waar het ligt, zonder ergens heen te gaan. */
function whereIs(bot, zoekterm) {
  const { naam, kandidaten } = resolveItem(bot, zoekterm);
  if (!naam) {
    if (kandidaten.length > 0) bot.chat(`Bedoel je: ${kandidaten.join(', ')}?`);
    else bot.chat(`Ik ken geen item dat "${zoekterm}" heet.`);
    return null;
  }

  if (storage.isEmpty()) {
    bot.chat('Ik heb nog geen lijst van de kisten. Doe eerst !index of !sort.');
    return null;
  }

  const treffers = storage.lookup(naam);
  if (treffers.length === 0) {
    // De lijst kan onvolledig zijn: het sorteren stopt zodra zijn handen leeg zijn en heeft
    // de verste kisten dan nooit opengemaakt. !haal lost dat zelf op door alsnog rond te
    // lopen, maar !waar kijkt bewust alleen in de lijst — dus zeg erbij wat je kunt doen.
    bot.chat(`Geen ${naam} in mijn lijst. Doe !index als je zeker wil weten dat ik alles gezien heb.`);
    return null;
  }

  bot.chat(`${storage.totalOf(naam)}x ${naam}, verdeeld over ${treffers.length} kist(en):`);
  for (const t of treffers.slice(0, KOERIER.maxReported)) {
    bot.chat(`  ${t.count}x op ${t.pos.x} ${t.pos.y} ${t.pos.z}`);
  }
  return treffers;
}

/** !index — de lijst opnieuw opbouwen zonder te sorteren. */
async function refreshIndex(bot) {
  if (botState.isFetching) {
    bot.chat('Ik ben al bezig!');
    return 0;
  }

  const session = ++botState.fetchSession;
  botState.isFetching = true;
  botState.stopFetching = false;
  const shouldStop = () => botState.fetchSession !== session || botState.stopFetching;

  try {
    courierMovements(bot);
    bot.chat('Ik loop de kisten na...');
    storage.clear();
    const { bekeken, mislukt } = await buildIndex(bot, shouldStop);
    const s = storage.stats();
    bot.chat(`${bekeken} kisten bekeken: ${s.items} items in ${s.soorten} soorten.`);
    // Zonder deze melding was "hij zegt dat er niks is" niet te onderscheiden van "hij is er
    // nooit bij gekomen".
    if (mislukt.length > 0) {
      const p = mislukt[0];
      bot.chat(`${mislukt.length} kist(en) kon ik niet bereiken of openen, bv. op ${p.x} ${p.y} ${p.z}.`);
    }
    Logger.info(`Index: ${s.kisten} kisten, ${s.items} items, ${s.soorten} soorten`);
    return bekeken;
  } catch (err) {
    Logger.error('Indexfout', err);
    bot.chat('Er ging iets mis met het naloop.');
    return 0;
  } finally {
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, KOERIER).catch(() => {});
    if (botState.fetchSession === session) {
      botState.isFetching = false;
      botState.stopFetching = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }
}

/**
 * !vergeet — de lijst van wat waar ligt weggooien. Handig als hij door omgebouwde of
 * leeggehaalde kisten niet meer klopt; de volgende !index, !sort of !haal bouwt hem opnieuw op.
 */
function forgetIndex(bot) {
  const { kisten } = storage.stats();
  storage.clear();
  bot.chat(kisten > 0
    ? `Oke, ik ben vergeten wat er in ${kisten} kisten zat.`
    : 'Ik had nog niks onthouden, dus er valt niks te vergeten.');
  Logger.info(`Kistenindex gewist (${kisten} kisten)`);
}

function stopFetching(bot) {
  if (!botState.isFetching) {
    bot.chat('Ik ben niets aan het halen.');
    return;
  }
  botState.stopFetching = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met halen.');
  Logger.info('Halen gestopt door gebruiker');
}

module.exports = {
  fetchItem,
  giveItem,
  stopGiving,
  whereIs,
  refreshIndex,
  forgetIndex,
  stopFetching,
  // geëxporteerd voor tests en hergebruik
  resolveItem,
  resolveOwnItem,
  buildIndex,
  takeFromChest,
  findAllChests,
  chestPartner,
  countItem,
};

/**
 * De bot houdt zichzelf van gereedschap voorzien: hij maakt nieuw gereedschap bij een werkbank
 * en smeedt twee versleten exemplaren samen op een aambeeld.
 *
 * Aanleiding: het boeren en het minen wisselen netjes van gereedschap zodra iets onder de
 * duurzaamheidsdrempel zakt, maar als er dan niets meer over is, stopt de bot gewoon. Dat is
 * het verschil tussen een bot die je moet bijhouden en een die doorgaat.
 *
 * De aanpak leunt op twee dingen die mineflayer al weet en die je dus niet zelf hoort na te
 * bouwen:
 *
 *   recipe.delta   per recept een lijst {id, count}, waarbij een NEGATIEVE count betekent
 *                  "dit wordt verbruikt". Daaruit volgt precies wat er tekortkomt, zonder
 *                  ergens een tabel met "een pikhouweel kost 3 steen en 2 stokken" bij te
 *                  houden die bij de volgende spelversie niet meer klopt.
 *
 *   bot.recipesAll vertelt wat je zou KUNNEN maken, bot.recipesFor alleen wat je NU kunt
 *                  maken. Het verschil tussen die twee is de boodschappenlijst.
 *
 * Wat er tekortkomt wordt eerst uit de kisten gehaald (via dezelfde opslagindex als de
 * koerier) en anders zelf gemaakt: stokken uit planken, planken uit stammen. Dat gaat
 * recursief, met een diepterem, want een kringetje in de recepten zou hem anders laten hangen.
 *
 * Twee valkuilen in mineflayer zelf die hier omheen gebouwd zijn:
 *   - bot.craft() opent de werkbank met activateBlock() en wacht daarna eeuwig op windowOpen.
 *   - anvil.combine() wacht aan het eind op een 'experience'-event dat er niet altijd komt.
 * Allebei zitten ze daarom in een withTimeout().
 */

const { goals } = require('mineflayer-pathfinder');
const { CONFIG } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout, findNearestBlock, hasPathTo } = require('../utils');
const { closeWindow, equipNonPlaceable, sleep } = require('../lib/containers');
const storage = require('../lib/storage');

const SMID = CONFIG.toolsmith;

const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];

// Netherite staat hier bewust niet bij: dat maak je niet op een werkbank maar op een
// smithing table, met een template die je niet zomaar hebt. Bestaand netherite gereedschap
// telt wél gewoon mee als "goed genoeg".
const TIERS = ['diamond', 'iron', 'stone', 'golden', 'wooden'];

const WORKBENCH = 'crafting_table';
const ANVILS = ['anvil', 'chipped_anvil', 'damaged_anvil'];

// ---------------------------------------------------------------------------
// Gereedschap beoordelen
// ---------------------------------------------------------------------------

function durabilityLeft(item) {
  if (!item || !item.maxDurability) return Infinity;
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

function toolsOfKind(bot, kind) {
  return bot.inventory.items().filter(i => i.name.endsWith(`_${kind}`));
}

/** Heeft de bot nog een bruikbaar exemplaar van dit soort gereedschap? */
function hasUsableTool(bot, kind) {
  return toolsOfKind(bot, kind).some(i => durabilityLeft(i) >= SMID.minDurability);
}

/**
 * Welke soorten gereedschap moeten aangevuld worden?
 * Alleen de soorten die de bot echt gebruikt; een schoffel voor het boeren, een pikhouweel
 * voor het minen, enzovoort.
 */
function missingKinds(bot, kinds = SMID.keepKinds) {
  return kinds.filter(kind => !hasUsableTool(bot, kind));
}

/**
 * De beste variant van dit soort die we kunnen proberen te maken, op duurzaamheid gesorteerd.
 *
 * Op duurzaamheid en niet op "tier", want goud is in het spel een hogere tier dan steen maar
 * gaat 32 slagen mee tegen 131. Een gouden pikhouweel maken terwijl je steen hebt liggen is
 * dus gewoon verlies.
 */
function craftableVariants(bot, kind) {
  return TIERS
    .map(tier => `${tier}_${kind}`)
    .map(naam => bot.registry.itemsByName[naam])
    .filter(Boolean)
    .sort((a, b) => (b.maxDurability ?? 0) - (a.maxDurability ?? 0));
}

// ---------------------------------------------------------------------------
// Voorraad: inventaris, kisten, zelf maken
// ---------------------------------------------------------------------------

function countOf(bot, itemId) {
  return bot.inventory.items()
    .filter(i => i.type === itemId)
    .reduce((som, i) => som + i.count, 0);
}

function itemName(bot, itemId) {
  return bot.registry.items[itemId]?.name ?? `#${itemId}`;
}

/**
 * Haalt ontbrekende grondstof uit de kisten.
 *
 * Gebruikt de opslagindex die het sorteren en de koerier al bijhouden. Staat er niets in de
 * index, dan heeft rondlopen ook geen zin — dan is er simpelweg nog nooit een kist bekeken,
 * en dat lost !index op.
 */
async function fetchFromStorage(bot, itemId, aantal, ctx) {
  const naam = itemName(bot, itemId);
  const treffers = storage.lookup(naam);
  if (treffers.length === 0) return 0;

  // Dichtstbijzijnde eerst: scheelt loopwerk als het over meerdere kisten verdeeld ligt.
  const botPos = bot.entity.position;
  treffers.sort((a, b) => botPos.distanceTo(a.pos) - botPos.distanceTo(b.pos));

  let gehaald = 0;
  for (const treffer of treffers) {
    if (ctx.shouldStop() || gehaald >= aantal) break;
    // takeFromChest wordt lui ingeladen: courier.js leunt op sorting.js, en die keten hier
    // bovenaan binnenhalen zou een kringverwijzing opleveren.
    const { takeFromChest } = require('./courier');
    const gepakt = await takeFromChest(bot, treffer.pos, naam, aantal - gehaald, ctx.shouldStop);
    gehaald += gepakt;
  }

  if (gehaald > 0) Logger.debug(`${gehaald}x ${naam} uit de kisten gehaald`);
  return gehaald;
}

/**
 * Zorgt dat er `aantal` stuks van dit item in de inventaris zitten: eerst kijken wat we
 * hebben, dan de kisten, dan het zelf maken.
 *
 * De diepterem is geen voorzichtigheid maar noodzaak: recepten kunnen naar elkaar verwijzen
 * (planken worden stokken worden... ), en zonder rem loopt dit zichzelf achterna.
 *
 * @returns {Promise<boolean>} of het gelukt is
 */
async function ensureItem(bot, itemId, aantal, ctx, diepte = SMID.maxDepth) {
  if (ctx.shouldStop()) return false;
  if (countOf(bot, itemId) >= aantal) return true;

  const naam = itemName(bot, itemId);

  // Een kringetje in de recepten afvangen: hetzelfde item twee keer in dezelfde keten.
  if (ctx.bezig.has(itemId)) return false;

  await fetchFromStorage(bot, itemId, aantal - countOf(bot, itemId), ctx);
  if (countOf(bot, itemId) >= aantal) return true;
  if (diepte <= 0) return false;

  ctx.bezig.add(itemId);
  try {
    for (const recept of bot.recipesAll(itemId, null, ctx.table)) {
      if (ctx.shouldStop()) break;

      const perKeer = recept.result.count || 1;
      const keer = Math.ceil((aantal - countOf(bot, itemId)) / perKeer);

      // recipe.delta: negatieve count = wordt verbruikt.
      const nodig = recept.delta.filter(d => d.count < 0);
      let compleet = true;
      for (const d of nodig) {
        if (!await ensureItem(bot, d.id, -d.count * keer, ctx, diepte - 1)) { compleet = false; break; }
      }
      if (!compleet) continue;

      if (!await craftRecipe(bot, recept, keer, ctx)) continue;
      if (countOf(bot, itemId) >= aantal) {
        Logger.debug(`${keer}x ${naam} gemaakt`);
        return true;
      }
    }
  } finally {
    ctx.bezig.delete(itemId);
  }

  return countOf(bot, itemId) >= aantal;
}

/** Voert één recept uit, met alle randgevallen van bot.craft() eromheen. */
async function craftRecipe(bot, recept, keer, ctx) {
  if (recept.requiresTable && !ctx.table) {
    Logger.debug('Recept heeft een werkbank nodig en die is er niet');
    return false;
  }

  // bot.craft() roept voor een werkbank activateBlock() aan, en dat stuurt onderhuids een
  // block_place. Met een plaatsbaar blok in de hand kan dat als plaatsing verwerkt worden.
  await equipNonPlaceable(bot);

  try {
    await withTimeout(
      bot.craft(recept, keer, recept.requiresTable ? ctx.table : null),
      SMID.craftTimeout,
      'maken'
    );
    await sleep(SMID.settleDelay);
    return true;
  } catch (err) {
    Logger.warn(`Maken mislukt: ${err.message}`);
    // craft() sluit zijn eigen venster, maar niet als de timeout ertussen kwam.
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, SMID);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Naar de werkbank
// ---------------------------------------------------------------------------

function smithMovements(bot) {
  setMovements(bot, {
    canDig: false,    // eis: nooit blokken breken
    canPlace: false,  // eis: nooit blokken plaatsen
    allowSprinting: true,
    allowParkour: false,
  });
}

/**
 * Zoekt een werkbank en gaat ernaast staan. Er wordt er bewust géén geplaatst: de bot plaatst
 * in dit project nooit blokken, en een werkbank die hij neerzet zou hij ook nooit meer kunnen
 * ophalen (weghalen mag hij immers ook niet).
 */
async function goToBlock(bot, namen, shouldStop, label) {
  const pos = findNearestBlock(bot, namen, SMID.searchRadius);
  if (!pos) return null;

  const blok = bot.blockAt(pos);
  if (!blok) return null;

  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > SMID.reachDistance) {
    if (!await hasPathTo(bot, pos, SMID)) {
      Logger.debug(`Geen pad naar de ${label}`);
      return null;
    }
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, SMID.approachRange)),
        SMID.approachTimeout,
        `naar de ${label} lopen`
      );
    } catch (err) {
      Logger.warn(`Kon niet bij de ${label} komen: ${err.message}`);
      return null;
    }
  }

  if (shouldStop()) return null;
  return bot.blockAt(pos);
}

// ---------------------------------------------------------------------------
// Repareren op het aambeeld
// ---------------------------------------------------------------------------

/**
 * Twee versleten exemplaren van hetzelfde gereedschap tot één samenvoegen.
 *
 * Dat levert meer op dan een nieuw exemplaar maken: de duurzaamheid wordt opgeteld mét een
 * bonus, en eventuele betoveringen blijven behouden. Het kost wel ervaringsniveaus, en die
 * controle laat mineflayer zelf al doen — combine() weigert netjes als het niet kan.
 */
async function repairPair(bot, a, b, shouldStop) {
  const blok = await goToBlock(bot, ANVILS, shouldStop, 'aambeeld');
  if (!blok) return false;

  let anvil = null;
  try {
    await equipNonPlaceable(bot);
    anvil = await withTimeout(bot.openAnvil(blok), SMID.openTimeout, 'aambeeld openen');
  } catch (err) {
    Logger.warn(`Aambeeld ging niet open: ${err.message}`);
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, SMID);
    return false;
  }

  try {
    // combine() wacht aan het eind op een 'experience'-event. Komt dat niet (en op sommige
    // servers komt het niet), dan hangt dit zonder timeout voorgoed.
    await withTimeout(anvil.combine(a, b, null), SMID.repairTimeout, 'repareren');
    Logger.info(`${a.name} gerepareerd op het aambeeld`);
    return true;
  } catch (err) {
    // 'Not anvil-able' en 'not enough xp' zijn gewone uitkomsten, geen storingen.
    Logger.debug(`Repareren ging niet: ${err.message}`);
    return false;
  } finally {
    await closeWindow(bot, anvil, SMID);
  }
}

/** Zoekt paren versleten gereedschap van dezelfde soort en smeedt ze samen. */
async function repairTools(bot, shouldStop) {
  const perNaam = new Map();
  for (const item of bot.inventory.items()) {
    if (!item.maxDurability) continue;
    if ((item.durabilityUsed ?? 0) === 0) continue;   // ongebruikt, niets te repareren
    if (!perNaam.has(item.name)) perNaam.set(item.name, []);
    perNaam.get(item.name).push(item);
  }

  let gerepareerd = 0;
  for (const [naam, lijst] of perNaam) {
    if (shouldStop()) break;
    if (lijst.length < 2) continue;

    // De twee meest versleten eerst: die leveren samen het meeste op en halen tegelijk het
    // minst bruikbare uit de inventaris.
    lijst.sort((a, b) => durabilityLeft(a) - durabilityLeft(b));
    for (let i = 0; i + 1 < lijst.length; i += 2) {
      if (shouldStop()) break;
      if (await repairPair(bot, lijst[i], lijst[i + 1], shouldStop)) gerepareerd++;
      else break;   // lukt het één keer niet (geen aambeeld, geen xp), dan de rest ook niet
    }
    if (gerepareerd > 0) Logger.debug(`${naam}: ${gerepareerd} paar samengevoegd`);
  }

  return gerepareerd;
}

// ---------------------------------------------------------------------------
// De hoofdtaak
// ---------------------------------------------------------------------------

/**
 * Zorgt voor één bruikbaar exemplaar van dit soort gereedschap.
 *
 * @returns {Promise<string|null>} de naam van wat er gemaakt is, of null
 */
async function ensureTool(bot, kind, ctx) {
  if (hasUsableTool(bot, kind)) return null;

  for (const variant of craftableVariants(bot, kind)) {
    if (ctx.shouldStop()) break;

    // Vragen om één MEER dan hij al heeft, versleten exemplaren meegeteld. Zou hier simpelweg
    // "zorg voor 1" staan, dan is bij twee kapotte ijzeren pikhouwelen meteen aan die eis
    // voldaan en maakt hij er nooit een bij — terwijl hij er juist geen bruikbare heeft.
    const bezit = countOf(bot, variant.id);
    if (!await ensureItem(bot, variant.id, bezit + 1, ctx)) continue;

    // En pas als er daarna écht een bruikbaar exemplaar is, zijn we klaar: een reserve die
    // hij uit een kist haalde kan net zo goed versleten zijn.
    if (hasUsableTool(bot, kind)) {
      Logger.info(`Nieuw gereedschap: ${variant.name}`);
      return variant.name;
    }
  }

  return null;
}

/**
 * De hele ronde: eerst repareren wat te repareren valt, dan bijmaken wat ontbreekt.
 *
 * Repareren gaat voor, want dat behoudt de tier en eventuele betoveringen — twee halve
 * diamanten pikhouwelen zijn meer waard dan een nieuw stenen exemplaar.
 *
 * @param {string[]} [kinds] welke soorten; standaard uit config
 */
async function resupplyTools(bot, kinds = SMID.keepKinds, opts = {}) {
  const stil = opts.quiet ?? false;

  if (botState.isSmithing) {
    if (!stil) bot.chat('Ik ben al bezig met gereedschap!');
    return null;
  }

  const session = ++botState.smithSession;
  botState.isSmithing = true;
  botState.stopSmithing = false;
  const shouldStop = () => botState.smithSession !== session || botState.stopSmithing;

  const totaal = { gerepareerd: 0, gemaakt: [], ontbreekt: [] };

  try {
    smithMovements(bot);

    const tekort = missingKinds(bot, kinds);
    if (tekort.length === 0 && !opts.force) {
      if (!stil) bot.chat('Mijn gereedschap is nog prima.');
      return totaal;
    }

    if (!stil && tekort.length > 0) bot.chat(`Ik kom tekort: ${tekort.join(', ')}. Ik regel het.`);

    // Stap 1: repareren.
    if (SMID.repairFirst && !shouldStop()) {
      totaal.gerepareerd = await repairTools(bot, shouldStop);
    }

    // Stap 2: wat daarna nog ontbreekt, maken.
    const nogSteeds = missingKinds(bot, kinds);
    if (nogSteeds.length === 0) {
      if (!stil && totaal.gerepareerd > 0) bot.chat(`${totaal.gerepareerd} stuk(s) gerepareerd, dat is genoeg.`);
      return totaal;
    }

    const table = await goToBlock(bot, [WORKBENCH], shouldStop, 'werkbank');
    if (!table) {
      if (!stil) bot.chat('Ik zie geen werkbank in de buurt, daar kan ik niets zonder.');
      Logger.warn('Geen werkbank binnen bereik');
      totaal.ontbreekt = nogSteeds;
      return totaal;
    }

    const ctx = { table, shouldStop, bezig: new Set() };
    for (const kind of nogSteeds) {
      if (shouldStop()) break;
      const gemaakt = await ensureTool(bot, kind, ctx);
      if (gemaakt) totaal.gemaakt.push(gemaakt);
      else totaal.ontbreekt.push(kind);
    }
  } catch (err) {
    Logger.error('Smidsfout', err);
    if (!stil) bot.chat('Er ging iets mis met het gereedschap.');
  } finally {
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, SMID).catch(() => {});

    if (botState.smithSession === session) {
      botState.isSmithing = false;
      botState.stopSmithing = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`SMID KLAAR: ${totaal.gerepareerd} gerepareerd, ${totaal.gemaakt.length} gemaakt `
    + `(${totaal.gemaakt.join(', ') || 'niets'}), ontbreekt nog: ${totaal.ontbreekt.join(', ') || 'niets'}`);

  if (!stil && botState.smithSession === session) {
    if (totaal.gemaakt.length > 0) bot.chat(`Gemaakt: ${totaal.gemaakt.join(', ')}.`);
    if (totaal.gerepareerd > 0) bot.chat(`${totaal.gerepareerd} stuk(s) gerepareerd.`);
    if (totaal.gemaakt.length === 0 && totaal.gerepareerd === 0 && totaal.ontbreekt.length > 0) {
      bot.chat(`Ik kom niet aan de grondstoffen voor: ${totaal.ontbreekt.join(', ')}.`);
    }
  }

  return totaal;
}

/**
 * Eén specifiek ding maken: !maak diamond_pickaxe, of !maak 8 torch.
 *
 * @returns {Promise<boolean>}
 */
async function craftItem(bot, naam, aantal = 1) {
  if (botState.isSmithing) {
    bot.chat('Ik ben al bezig met gereedschap!');
    return false;
  }

  const def = bot.registry.itemsByName[naam];
  if (!def) {
    bot.chat(`Ik ken geen item dat "${naam}" heet.`);
    return false;
  }

  const session = ++botState.smithSession;
  botState.isSmithing = true;
  botState.stopSmithing = false;
  const shouldStop = () => botState.smithSession !== session || botState.stopSmithing;

  try {
    smithMovements(bot);

    if (bot.recipesAll(def.id, null, true).length === 0) {
      bot.chat(`${naam} kun je niet op een werkbank maken.`);
      return false;
    }

    const table = await goToBlock(bot, [WORKBENCH], shouldStop, 'werkbank');
    if (!table) {
      bot.chat('Ik zie geen werkbank in de buurt.');
      return false;
    }

    const voor = countOf(bot, def.id);
    const gelukt = await ensureItem(bot, def.id, voor + aantal, { table, shouldStop, bezig: new Set() });
    const erbij = countOf(bot, def.id) - voor;

    if (gelukt || erbij > 0) bot.chat(`${erbij}x ${naam} gemaakt.`);
    else bot.chat(`Ik kom niet aan de grondstoffen voor ${naam}.`);
    return gelukt;
  } catch (err) {
    Logger.error('Smidsfout', err);
    bot.chat('Er ging iets mis met maken.');
    return false;
  } finally {
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, SMID).catch(() => {});
    if (botState.smithSession === session) {
      botState.isSmithing = false;
      botState.stopSmithing = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }
}

function stopSmithing(bot) {
  if (!botState.isSmithing) {
    bot.chat('Ik ben niet met gereedschap bezig.');
    return;
  }
  botState.stopSmithing = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met het gereedschap.');
  Logger.info('Smid gestopt door gebruiker');
}

module.exports = {
  resupplyTools,
  craftItem,
  repairTools,
  stopSmithing,
  // geëxporteerd voor tests en hergebruik
  TOOL_KINDS,
  hasUsableTool,
  missingKinds,
  craftableVariants,
  ensureItem,
  ensureTool,
  durabilityLeft,
};

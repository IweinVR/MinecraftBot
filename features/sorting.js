/**
 * Sorteerbot: invoerkist leeghalen en de inhoud over de omliggende kisten verdelen.
 *
 * De kisten worden in TWEE rondes langsgelopen, en dat is de kern van waarom het goed
 * sorteert. Ronde 1 gaat langs alle kisten, onthoudt wat erin ligt en legt alleen exacte
 * treffers weg. Pas als alles bekeken is, verdeelt ronde 2 de rest op categorie. Zou hij per
 * kist meteen ook op categorie wegleggen, dan belandt een gouden zwaard in de eerste kist met
 * een stenen zwaard erin — ook als er verderop al gouden zwaarden liggen.
 *
 * De categorieën staan in data/categories.js, niet hier.
 *
 * Wat de bot voor zichzelf houdt is een QUOTUM per itemnaam, geen lijst met slotnummers
 * (slots schuiven op) en geen lijst met soorten (dan kan hij nooit een zwaardenkist vullen).
 * Dat quotum wordt één keer aan het begin berekend en daarna bevroren meegegeven — anders
 * wordt een gouden zwaard uit de invoerkist opeens "zijn beste zwaard" en gaat het er nooit
 * meer uit.
 *
 * Naast de sorteerronde zit hier ook dumpInventory() (!leeg): die gaat de andere kant op en
 * stort juist de eigen tas in de invoerkist leeg. Hij gebruikt hetzelfde quotum, zodat "wat de
 * bot nodig heeft" overal in de bot precies hetzelfde betekent.
 *
 * Het openen en sluiten van kisten zelf zit in lib/containers.js; daar staat ook waarom dat
 * subtieler is dan het lijkt.
 */

const { goals } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { CONFIG, CHEST_BLOCKS } = require('../config');
const botState = require('../state');
const { Logger, setMovements, withTimeout, chatList } = require('../utils');
const { categoryOf } = require('../data/categories');
const { closeWindow, returnCursorItem, openContainerAt } = require('../lib/containers');
const storage = require('../lib/storage');

const SORT = CONFIG.sorting;

// Waar de bot in mag opbergen. ender_chest staat er bewust NIET bij: die inhoud is van de
// speler zelf en reist met hem mee, daar hoort de bot niets in te dumpen.
const STORAGE_BLOCKS = [
  ...CHEST_BLOCKS,
  'barrel',
  'shulker_box',
  ...['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
    'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
    .map(kleur => `${kleur}_shulker_box`),
];

// Koperen kisten eerst: dit is de "koperen golem"-kist, de standaard invoerbak.
const COPPER_CHESTS = CHEST_BLOCKS.filter(name => name.includes('copper'));

// ---------------------------------------------------------------------------
// Beschermde items
// ---------------------------------------------------------------------------

const MATERIAL_RANK = {
  netherite: 6, diamond: 5, iron: 4, golden: 3, gold: 3, stone: 2, copper: 2, wooden: 1, leather: 1, chainmail: 3, turtle: 4,
};

const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];
const ARMOR_KINDS = ['helmet', 'chestplate', 'leggings', 'boots'];

// Gereedschap zonder materiaalvoorvoegsel, dus op exacte naam. Matchen op het achtervoegsel
// '_rod' zou ook blaze_rod als gereedschap aanmerken, en dat is gewoon handelswaar.
// Hiervan blijft er precies één van het beste exemplaar achter, net als bij de rest.
const SINGLE_TOOLS = ['fishing_rod', 'shears', 'bow', 'crossbow'];

// Werkvoorraad: hier houdt de bot tot een vast aantal van, geen "beste exemplaar" van.
// Fakkels en kisten zijn wat hij tijdens het minen verbruikt (verlichting en de kisten die
// hij om de zoveel fakkels in de tunnelwand zet). Zonder deze regel legde hij ze bij de
// eerste de beste sorteerronde weg en stond hij even later in het donker zonder kist.
//
// Een redstone_torch hoort er bewust niet bij: dat is bouwmateriaal, geen verlichting.
const TORCH_ITEMS = ['torch', 'soul_torch'];

// Spullen die altijd meegaan, ongeacht hoeveel het er zijn.
const ALWAYS_KEEP = new Set([
  'water_bucket', 'bucket', 'lava_bucket', 'milk_bucket',
  'shield', 'elytra', 'totem_of_undying',
  'ender_pearl', 'flint_and_steel',
]);

function materialRank(itemName) {
  const materiaal = itemName.split('_')[0];
  return MATERIAL_RANK[materiaal] ?? 0;
}

function durabilityLeft(item) {
  if (!item || !item.maxDurability) return Infinity;
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

/** Beter = duurzamer materiaal, en bij gelijk materiaal het exemplaar met de meeste slijtage over. */
function beterDan(a, b) {
  const rangA = materialRank(a.name);
  const rangB = materialRank(b.name);
  if (rangA !== rangB) return rangA > rangB;
  return durabilityLeft(a) > durabilityLeft(b);
}

/**
 * Hoeveel van elk item houdt de bot voor zichzelf?
 *
 * Een quota per itemnaam, en bewust geen lijst met slotnummers: slots schuiven op zodra er
 * iets bijkomt of weggaat, dus een slotnummer betekent even later iets anders.
 *
 * Even bewust per exemplaar en niet per soort: een sorteerbot die "alle zwaarden" beschermt
 * kan nooit een kist met zwaarden vullen. Hij houdt van elk soort gereedschap en van elk
 * harnasdeel precies het beste exemplaar, plus een werkvoorraad eten, fakkels en kisten, en
 * de rest is gewoon vracht.
 *
 * Let op dat dit bevroren hoort te worden (zie sortableItems): berekent de bot het opnieuw
 * nadat hij een stapel fakkels uit de invoerkist heeft gehaald, dan zijn dat "zijn" fakkels
 * en legt hij ze nooit meer weg.
 *
 * Gedragen harnas zit sowieso niet in bot.inventory.items() (dat zijn slots 5 t/m 8, en
 * items() begint pas bij 9), dus dat kan langs deze weg überhaupt niet in een kist belanden.
 *
 * @returns {Map<string, number>} itemnaam -> aantal dat bij de bot blijft
 */
function protectionQuota(bot) {
  const quota = new Map();
  const items = bot.inventory.items();
  const houden = (naam, n) => quota.set(naam, (quota.get(naam) ?? 0) + n);

  for (const item of items) {
    if (ALWAYS_KEEP.has(item.name)) houden(item.name, item.count);
  }

  const beste = new Map(); // soort -> beste exemplaar
  for (const item of items) {
    const soort = [...TOOL_KINDS, ...ARMOR_KINDS].find(k => item.name.endsWith(`_${k}`))
      ?? (SINGLE_TOOLS.includes(item.name) ? item.name : null);
    if (!soort) continue;
    const huidig = beste.get(soort);
    if (!huidig || beterDan(item, huidig)) beste.set(soort, item);
  }
  for (const item of beste.values()) houden(item.name, 1);

  // Werkvoorraad: van een hele groep samen hoogstens `budget` stuks houden, de rest mag de
  // kist in. Eén budget over de hele groep en niet per itemnaam, anders houdt hij van vier
  // soorten vis elk een volle drempel over.
  const reserveer = (past, budget) => {
    let over = budget;
    for (const item of items) {
      if (over <= 0) break;
      if (!past(item.name)) continue;
      const n = Math.min(item.count, over);
      houden(item.name, n);
      over -= n;
    }
  };

  reserveer(naam => !!bot.registry?.foodsByName?.[naam], SORT.keepFood);
  reserveer(naam => TORCH_ITEMS.includes(naam), SORT.keepTorches);
  reserveer(naam => CHEST_BLOCKS.includes(naam), SORT.keepChests);

  return quota;
}

/**
 * De items die wél gesorteerd mogen worden, na aftrek van het quotum.
 *
 * Het quotum hoort één keer aan het begin van de ronde berekend te worden en daarna
 * bevroren mee te gaan. Anders gaat de bot zijn eigen vracht beschermen: haalt hij een
 * gouden zwaard uit de invoerkist terwijl hij zelf geen zwaard heeft, dan is dat opeens
 * "zijn beste zwaard" en legt hij het nooit meer weg.
 */
function sortableItems(bot, quota = protectionQuota(bot)) {
  const rest = new Map(quota);
  const vracht = [];

  for (const item of bot.inventory.items()) {
    const gereserveerd = rest.get(item.name) ?? 0;
    if (gereserveerd >= item.count) {
      rest.set(item.name, gereserveerd - item.count);
      continue;
    }
    rest.set(item.name, 0);
    vracht.push({ name: item.name, type: item.type, count: item.count - gereserveerd });
  }

  return vracht;
}

// ---------------------------------------------------------------------------
// Kisten vinden
// ---------------------------------------------------------------------------

function blockIds(bot, names) {
  return names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined);
}

function findChests(bot, names, radius, count) {
  const ids = blockIds(bot, names);
  if (ids.length === 0) return [];
  return bot.findBlocks({ matching: ids, maxDistance: radius, count });
}

/**
 * De invoerkist: expliciete coördinaten als die gegeven zijn, anders de dichtstbijzijnde
 * koperen kist, en anders de dichtstbijzijnde gewone kist.
 */
function findInputChest(bot, coords = null) {
  if (coords) {
    const pos = new Vec3(coords.x, coords.y, coords.z);
    const block = bot.blockAt(pos);
    if (!block) return { pos: null, reden: 'die plek is niet geladen' };
    if (!STORAGE_BLOCKS.includes(block.name)) return { pos: null, reden: `daar staat geen kist maar ${block.name}` };
    return { pos, reden: null };
  }

  const koper = findChests(bot, COPPER_CHESTS, SORT.inputRadius, 1);
  if (koper.length > 0) return { pos: koper[0], reden: null };

  const gewoon = findChests(bot, CHEST_BLOCKS, SORT.inputRadius, 1);
  if (gewoon.length > 0) return { pos: gewoon[0], reden: null };

  return { pos: null, reden: 'geen kist in de buurt' };
}

/** Alle opslagkisten binnen bereik, dichtstbijzijnde eerst, zonder de invoerkist zelf. */
function findStorageChests(bot, inputPos) {
  return findChests(bot, STORAGE_BLOCKS, SORT.storageRadius, SORT.maxChests)
    .filter(pos => !pos.equals(inputPos))
    .sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b));
}

// ---------------------------------------------------------------------------
// Kist openen en sluiten
// ---------------------------------------------------------------------------

// Dunne wikkels om lib/containers.js heen, met de sorteer-instellingen erin.
// De echte afhandeling (wachten tot een venster dicht is, cursor-items terugleggen, niets
// plaatsbaars vasthouden) staat daar, want het handelen gebruikt precies hetzelfde.

const closeChest = (bot, window) => closeWindow(bot, window, SORT);

/** Loopt naar een kist en opent hem. Geeft null terug als dat niet lukt. */
const openChestAt = (bot, pos, shouldStop) =>
  openContainerAt(bot, pos, shouldStop, { ...SORT, allowed: STORAGE_BLOCKS, label: 'kist' });

// ---------------------------------------------------------------------------
// Stap 1: de invoerkist leeghalen
// ---------------------------------------------------------------------------

/**
 * Haalt alles uit de invoerkist wat gesorteerd moet worden.
 *
 * Beschermde spullen (gereedschap, eten) blijven expres liggen: die zou de bot toch nooit
 * wegleggen, dus meenemen betekent alleen dat ze voorgoed in zijn inventaris blijven hangen
 * en dat er minder ruimte is voor vracht.
 */
async function emptyInputChest(bot, window, shouldStop) {
  const stats = { opgenomen: 0, achtergelaten: 0, vol: false };

  for (const item of window.containerItems()) {
    if (shouldStop()) break;

    if (bot.inventory.emptySlotCount() <= SORT.minFreeSlots) {
      stats.vol = true;
      Logger.info('Inventaris vol, rest van de invoerkist blijft liggen');
      break;
    }

    // Alleen wat de bot sowieso nooit weglegt blijft liggen: dat meenemen betekent alleen
    // dat het voorgoed in zijn inventaris hangt.
    //
    // Eten stond hier eerst ook bij, en dat was te streng. Sinds het quotum per itemnaam
    // werkt (hoogstens keepFood stuks), kan alles daarboven gewoon gesorteerd worden. Met de
    // oude regel bleef vis die het vissen in de invoerkist legde daar voor altijd liggen,
    // want het sorteren raakte hem niet aan.
    if (ALWAYS_KEEP.has(item.name)) {
      stats.achtergelaten += item.count;
      continue;
    }

    // Aantal en naam vóór de verplaatsing vastleggen: containerItems() geeft de echte
    // slot-objecten terug, en withdraw() zet de count daarvan op nul. Achteraf uitlezen
    // leverde dus altijd "0x oak_log opgehaald" op.
    const aantal = item.count;
    const naam = item.name;

    try {
      await window.withdraw(item.type, null, aantal);
      stats.opgenomen += aantal;
      Logger.debug(`${aantal}x ${naam} uit de invoerkist gehaald`);
    } catch (err) {
      Logger.warn(`Kon ${item.name} niet oppakken: ${err.message}`);
      await returnCursorItem(bot, window);
      if (/full/i.test(err.message)) { stats.vol = true; break; }
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Stap 2: wegleggen
// ---------------------------------------------------------------------------

/** Wat ligt er in deze kist, op naam en op categorie? */
function indexChest(bot, window) {
  const namen = new Set();
  const categorieen = new Set();
  for (const item of window.containerItems()) {
    namen.add(item.name);
    const cat = categoryOf(bot.registry, item.name);
    if (cat) categorieen.add(cat);
  }
  return { namen, categorieen };
}

/** Zit er nog ruimte in het kistgedeelte van dit venster? */
function chestHasRoom(window, itemName) {
  if (window.firstEmptySlotRange(0, window.inventoryStart) !== null) return true;
  // Vol qua slots, maar een bestaande stapel kan er misschien nog bij.
  return window.containerItems().some(i => i.name === itemName && i.count < i.stackSize);
}

/**
 * Legt items in een geopende kist.
 *
 * @param {Set<string>|null} alleenDeze beperk tot deze itemnamen (gebruikt door de tweede ronde)
 * @param {{namen: Set<string>, categorieen: Set<string>}} inhoud
 * @param {boolean} opCategorie ook op categorie matchen, of alleen op exacte naam
 */
async function depositInto(bot, window, inhoud, { opCategorie, alleenDeze = null, shouldStop, quota = null }) {
  const gelegd = [];

  for (const item of sortableItems(bot, quota ?? protectionQuota(bot))) {
    if (shouldStop()) break;
    if (alleenDeze && !alleenDeze.has(item.name)) continue;

    const exact = inhoud.namen.has(item.name);
    const cat = categoryOf(bot.registry, item.name);
    const viaCategorie = opCategorie && !!cat && inhoud.categorieen.has(cat);
    if (!exact && !viaCategorie) continue;

    if (!chestHasRoom(window, item.name)) {
      Logger.debug(`Kist zit vol, ${item.name} blijft mee`);
      continue;
    }

    // Zelfde reden als bij het ophalen: deposit() leegt de stapel waar item naar wijst.
    const aantal = item.count;
    const naam = item.name;

    try {
      await window.deposit(item.type, null, aantal);
      gelegd.push({ naam, aantal, hoe: exact ? 'exact' : cat });
      Logger.debug(`${aantal}x ${naam} weggelegd (${exact ? 'exacte match' : 'categorie ' + cat})`);
      // De inhoud van de kist is nu veranderd: het weggelegde item hoort er voortaan bij.
      inhoud.namen.add(item.name);
      if (cat) inhoud.categorieen.add(cat);
    } catch (err) {
      Logger.warn(`Kon ${item.name} niet wegleggen: ${err.message}`);
      // Kritiek: bij 'destination full' hangt de stapel nog aan de cursor en valt hij
      // op de grond zodra we het venster sluiten.
      await returnCursorItem(bot, window);
    }
  }

  return gelegd;
}

// ---------------------------------------------------------------------------
// De hele klus
// ---------------------------------------------------------------------------

function sortMovements(bot) {
  setMovements(bot, {
    canDig: false,    // eis: nooit blokken breken
    canPlace: false,  // eis: nooit blokken plaatsen
    allowSprinting: true,
    allowParkour: false,
  });
}

/**
 * Sorteerronde: invoerkist leeghalen en de inhoud over de omliggende kisten verdelen.
 * Waarom dat in twee rondes gaat staat bovenaan dit bestand.
 *
 * @param {object} bot
 * @param {{x: number, y: number, z: number}} [coords] expliciete invoerkist
 */
async function sortItems(bot, coords = null) {
  if (botState.isSorting) {
    bot.chat('Ik ben al aan het sorteren!');
    return null;
  }

  const session = ++botState.sortSession;
  botState.isSorting = true;
  botState.stopSorting = false;
  const shouldStop = () => botState.sortSession !== session || botState.stopSorting;

  const totaal = { opgenomen: 0, weggelegd: 0, exact: 0, categorie: 0, kisten: 0, over: 0 };
  let window = null;

  try {
    sortMovements(bot);

    // Het quotum NU vastleggen, vóór er iets uit de invoerkist komt. Doe je dat later, dan
    // telt de vracht mee: een gouden zwaard uit de invoerkist wordt dan "het beste zwaard"
    // van de bot en verlaat zijn inventaris nooit meer.
    const quota = protectionQuota(bot);

    // --- invoerkist ---
    const { pos: inputPos, reden } = findInputChest(bot, coords);
    if (!inputPos) {
      bot.chat(`Ik kan de invoerkist niet vinden: ${reden}.`);
      return totaal;
    }

    Logger.info(`Sorteren: invoerkist op ${inputPos.x} ${inputPos.y} ${inputPos.z}`);
    bot.chat(`Ik haal de kist op ${inputPos.x} ${inputPos.y} ${inputPos.z} leeg.`);

    window = await openChestAt(bot, inputPos, shouldStop);
    if (!window) {
      bot.chat('Ik kan de invoerkist niet openen.');
      return totaal;
    }

    const leeg = await emptyInputChest(bot, window, shouldStop);
    totaal.opgenomen = leeg.opgenomen;
    storage.record(inputPos, window.containerItems());
    await closeChest(bot, window);
    window = null;

    if (leeg.opgenomen === 0) {
      bot.chat('De invoerkist is leeg, er valt niets te sorteren.');
      return totaal;
    }
    bot.chat(`${leeg.opgenomen} items opgehaald${leeg.vol ? ' (inventaris zat vol)' : ''}, ik ga rondbrengen.`);

    // --- opslagkisten ---
    const kisten = findStorageChests(bot, inputPos);
    if (kisten.length === 0) {
      bot.chat('Ik zie geen opslagkisten in de buurt.');
      return totaal;
    }
    Logger.info(`${kisten.length} opslagkisten gevonden binnen ${SORT.storageRadius} blokken`);

    // Ronde 1: langs elke kist, inhoud onthouden en meteen de exacte treffers wegleggen.
    const index = [];
    for (const pos of kisten) {
      if (shouldStop()) break;
      if (sortableItems(bot, quota).length === 0) break;

      window = await openChestAt(bot, pos, shouldStop);
      if (!window) continue;
      totaal.kisten++;

      const inhoud = indexChest(bot, window);
      const gelegd = await depositInto(bot, window, inhoud, { opCategorie: false, shouldStop, quota });
      // Onthouden wat hier ligt, zodat !haal en !waar later niet opnieuw langs alle kisten
      // hoeven. Na het wegleggen, want de inhoud is net veranderd.
      storage.record(pos, window.containerItems());
      await closeChest(bot, window);
      window = null;

      for (const g of gelegd) { totaal.weggelegd += g.aantal; totaal.exact += g.aantal; }
      index.push({ pos, inhoud });
    }

    // Ronde 2: wat overblijft op categorie verdelen, alleen naar kisten die echt matchen.
    const rest = sortableItems(bot, quota);
    if (rest.length > 0 && !shouldStop()) {
      const perKist = new Map();
      for (const item of rest) {
        const cat = categoryOf(bot.registry, item.name);
        if (!cat) continue; // geen categorie -> alleen exact, en dat is al geprobeerd
        const doel = index.find(k => k.inhoud.categorieen.has(cat));
        if (!doel) continue;
        const sleutel = `${doel.pos.x},${doel.pos.y},${doel.pos.z}`;
        if (!perKist.has(sleutel)) perKist.set(sleutel, { doel, namen: new Set() });
        perKist.get(sleutel).namen.add(item.name);
      }

      for (const { doel, namen } of perKist.values()) {
        if (shouldStop()) break;

        window = await openChestAt(bot, doel.pos, shouldStop);
        if (!window) continue;

        const gelegd = await depositInto(bot, window, doel.inhoud, {
          opCategorie: true, alleenDeze: namen, shouldStop, quota,
        });
        storage.record(doel.pos, window.containerItems());
        await closeChest(bot, window);
        window = null;

        for (const g of gelegd) { totaal.weggelegd += g.aantal; totaal.categorie += g.aantal; }
      }
    }

    totaal.over = sortableItems(bot, quota).reduce((som, i) => som + i.count, 0);
  } catch (err) {
    Logger.error('Sorteerfout', err);
    bot.chat('Er ging iets mis met sorteren.');
  } finally {
    // Wat er ook misgaat: het venster moet dicht, anders weigert de server elke volgende kist.
    if (window) await closeChest(bot, window).catch(() => {});
    else if (bot.currentWindow) await closeChest(bot, bot.currentWindow).catch(() => {});

    if (botState.sortSession === session) {
      botState.isSorting = false;
      botState.stopSorting = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`SORTEREN KLAAR: ${totaal.opgenomen} opgehaald, ${totaal.weggelegd} weggelegd `
    + `(${totaal.exact} exact, ${totaal.categorie} op categorie) over ${totaal.kisten} kisten, ${totaal.over} over`);

  if (botState.sortSession === session) {
    bot.chat(`Klaar: ${totaal.weggelegd} items weggelegd in ${totaal.kisten} kisten `
      + `(${totaal.exact} op naam, ${totaal.categorie} op soort).`);
    if (totaal.over > 0) bot.chat(`${totaal.over} items pasten nergens, die hou ik bij me.`);
  }

  return totaal;
}

// ---------------------------------------------------------------------------
// De tas legen
// ---------------------------------------------------------------------------

/**
 * Alles wat de bot niet nodig heeft in de invoerkist leggen, en daarna (als sortAfterDump
 * aanstaat) meteen een sorteerronde draaien.
 *
 * "Nodig" is hier exact hetzelfde als bij het sorteren, namelijk wat protectionQuota()
 * overhoudt: de emmers, het schild en de totems, van elk soort gereedschap en elk harnasdeel
 * het béste exemplaar, en een werkvoorraad eten, fakkels en kisten. Bewust dezelfde regel,
 * anders houdt !leeg iets anders over dan !sort en weet je nooit meer wat de bot bij zich
 * heeft -- en erger nog: de sorteerronde die hier direct achteraan komt zou het verschil
 * meteen weer weghalen.
 *
 * Een eigen functie en niet een vlaggetje op sortItems(), want de richting is omgekeerd:
 * sorteren haalt de invoerkist leeg en verdeelt hem, dit vult hem juist.
 *
 * @param {object} bot
 * @param {{x: number, y: number, z: number}} [coords] expliciete kist om in te storten
 */
async function dumpInventory(bot, coords = null) {
  if (botState.isDumping) {
    bot.chat('Ik ben mijn tas al aan het legen!');
    return null;
  }

  const session = ++botState.dumpSession;
  botState.isDumping = true;
  botState.stopDumping = false;
  const shouldStop = () => botState.dumpSession !== session || botState.stopDumping;

  const totaal = { gestort: 0, gehouden: 0, over: 0, perSoort: {}, gesorteerd: false };
  let window = null;

  try {
    sortMovements(bot);

    // Het quotum en de vrachtlijst één keer vastleggen, vóór de eerste kist opengaat. Zou je
    // ze onderweg opnieuw berekenen, dan schuift het eten dat net weg is weer aan als
    // proviand en blijft de bot met een halfvolle tas achter.
    const quota = protectionQuota(bot);
    const vracht = sortableItems(bot, quota);
    const alles = bot.inventory.items().reduce((som, i) => som + i.count, 0);
    totaal.gehouden = alles - vracht.reduce((som, i) => som + i.count, 0);

    if (vracht.length === 0) {
      bot.chat('Ik heb niets bij me wat weg kan, alleen mijn eigen spullen.');
      return totaal;
    }

    const { pos, reden } = findInputChest(bot, coords);
    if (!pos) {
      bot.chat(`Ik kan de invoerkist niet vinden: ${reden}.`);
      return totaal;
    }

    Logger.info(`Legen: ${vracht.length} soorten naar de kist op ${pos.x} ${pos.y} ${pos.z}`);
    bot.chat(`Ik leeg mijn tas in de kist op ${pos.x} ${pos.y} ${pos.z}.`);

    window = await openChestAt(bot, pos, shouldStop);
    if (!window) {
      bot.chat('Ik kan de invoerkist niet openen.');
      return totaal;
    }

    for (const item of vracht) {
      if (shouldStop()) break;

      if (!chestHasRoom(window, item.name)) {
        Logger.debug(`Kist zit vol, ${item.name} blijft mee`);
        totaal.over += item.count;
        continue;
      }

      // Aantal en naam vóór de verplaatsing vastleggen: deposit() zet de count van de stapel
      // waar item naar wijst op nul, dus achteraf uitlezen levert altijd "0x" op.
      const aantal = item.count;
      const naam = item.name;

      try {
        await window.deposit(item.type, null, aantal);
        totaal.gestort += aantal;
        totaal.perSoort[naam] = (totaal.perSoort[naam] ?? 0) + aantal;
      } catch (err) {
        Logger.warn(`Kon ${naam} niet in de kist leggen: ${err.message}`);
        // Kritiek: bij 'destination full' hangt de stapel nog aan de cursor en valt hij op
        // de grond zodra het venster dichtgaat.
        await returnCursorItem(bot, window);
        totaal.over += aantal;
      }
    }

    storage.record(pos, window.containerItems());
    await closeChest(bot, window);
    window = null;

    const soorten = Object.entries(totaal.perSoort)
      .sort((a, b) => b[1] - a[1])
      .map(([naam, aantal]) => `${aantal}x ${naam}`);

    // Melden vóór de sorteerronde: andersom verdrinkt dit bericht tussen de sorteermeldingen
    // en lijkt het alsof het daarbij hoort.
    if (botState.dumpSession === session) {
      bot.chat(`${totaal.gestort} items in de kist gelegd, ${totaal.gehouden} hou ik bij me `
        + '(gereedschap, harnas, proviand, fakkels en kisten).');
      chatList(bot, 'Weggelegd: ', soorten);
      if (totaal.over > 0) bot.chat(`${totaal.over} pasten er niet meer in, die hou ik bij me.`);
    }

    if (SORT.sortAfterDump && totaal.gestort > 0 && !shouldStop()) {
      await sortItems(bot);
      totaal.gesorteerd = true;
    }
  } catch (err) {
    Logger.error('Fout bij het legen', err);
    bot.chat('Er ging iets mis met het legen van mijn tas.');
  } finally {
    // Wat er ook misgaat: het venster moet dicht, anders weigert de server elke volgende kist.
    if (window) await closeChest(bot, window).catch(() => {});
    else if (bot.currentWindow) await closeChest(bot, bot.currentWindow).catch(() => {});

    if (botState.dumpSession === session) {
      botState.isDumping = false;
      botState.stopDumping = false;
      setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
    }
  }

  Logger.info(`LEGEN KLAAR: ${totaal.gestort} gestort, ${totaal.gehouden} gehouden, `
    + `${totaal.over} pasten niet${totaal.gesorteerd ? ', daarna gesorteerd' : ''}`);

  return totaal;
}

function stopDumping(bot) {
  if (!botState.isDumping) {
    bot.chat('Ik ben mijn tas niet aan het legen.');
    return;
  }
  botState.stopDumping = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met legen.');
  Logger.info('Legen gestopt door gebruiker');
}

function stopSorting(bot) {
  if (!botState.isSorting) {
    bot.chat('Ik ben niet aan het sorteren.');
    return;
  }
  botState.stopSorting = true;
  bot.pathfinder.stop();
  bot.chat('Oke, ik stop met sorteren.');
  Logger.info('Sorteren gestopt door gebruiker');
}

module.exports = {
  sortItems,
  stopSorting,
  dumpInventory,
  stopDumping,
  // geëxporteerd voor tests en hergebruik
  STORAGE_BLOCKS,
  TORCH_ITEMS,
  protectionQuota,
  sortableItems,
  findInputChest,
  findStorageChests,
  indexChest,
  chestHasRoom,
  closeChest,
  openChestAt,
  emptyInputChest,
  depositInto,
};

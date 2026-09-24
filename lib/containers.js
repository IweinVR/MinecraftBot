/**
 * Gedeelde afhandeling van vensters: kisten, tonnen en het handelsscherm van een dorpeling.
 *
 * Stond eerst in features/sorting.js. Het handelen heeft precies dezelfde valkuilen — een venster dat
 * nooit opengaat, een venster dat je denkt te sluiten maar dat nog openstaat, een item dat aan
 * de cursor blijft hangen — dus staat het nu op één plek in plaats van twee keer half.
 *
 * De opties (reachDistance, approachRange, timeouts) komen van de aanroeper mee, want het
 * sorteren en het handelen hebben elk hun eigen sectie in config.js.
 */

const { goals } = require('mineflayer-pathfinder');
const { Logger, withTimeout, hasPathTo } = require('../utils');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Zorgt dat de bot niets plaatsbaars vasthoudt vóór hij een blok aanklikt.
 *
 * openBlock() stuurt onderhuids een block_place-pakket. Kan de server de kist niet openen
 * (hij zit klem, of de bot staat net buiten bereik), dan verwerkt hij datzelfde pakket als
 * een plaatsing — en dan zet de bot dus een blok neer. Dat mag absoluut niet.
 *
 * Voor entities (een dorpeling) is dit niet nodig: openEntity stuurt use_entity, en daar zit
 * geen plaatsing in. Het kan geen kwaad, dus het gebeurt daar ook.
 *
 * bot.unequip('hand') wordt vermeden zolang de inventaris vol is: die gooit het item in je
 * hand op de grond (simple_inventory.js), en dat is precies het omgekeerde van de bedoeling.
 */
async function equipNonPlaceable(bot) {
  const isBlok = (item) => !!item && !!bot.registry.blocksByName[item.name];
  if (!isBlok(bot.heldItem)) return true;

  const veilig = bot.inventory.items().find(item => !isBlok(item));
  if (veilig) { await bot.equip(veilig, 'hand'); return true; }

  if (bot.inventory.emptySlotCount() > 0) { await bot.unequip('hand'); return true; }

  Logger.warn('Kan geen niet-plaatsbaar item in de hand nemen; venster wordt overgeslagen');
  return false;
}

/** Wacht tot het venster echt dicht is, niet alleen tot wij het dicht geklikt hebben. */
function waitForClose(bot, timeoutMs) {
  return new Promise(resolve => {
    let klaar = false;
    const afronden = () => {
      if (klaar) return;
      klaar = true;
      clearTimeout(timer);
      clearInterval(poll);
      bot.removeListener('windowClose', afronden);
      resolve();
    };
    const timer = setTimeout(afronden, timeoutMs);
    // Zowel op het event als op currentWindow pollen: het event mist als de server het
    // venster al aan zijn kant gesloten had, en dan blijven we anders de hele timeout wachten.
    const poll = setInterval(() => { if (!bot.currentWindow) afronden(); }, 50);
    bot.on('windowClose', afronden);
  });
}

/**
 * Sluit een venster en wacht tot de server bij is.
 *
 * window.close() is in mineflayer synchroon: het schrijft alleen het close_window-pakket weg.
 * `await window.close()` wacht dus in werkelijkheid nergens op. Meteen daarna het volgende
 * venster openen geeft desyncs en op strenge servers een kick, dus hier wordt wél gewacht.
 */
async function closeWindow(bot, window, { closeTimeout = 2000, settleDelay = 250 } = {}) {
  if (!window) return;
  const dicht = waitForClose(bot, closeTimeout);
  try {
    window.close();
  } catch (err) {
    Logger.debug(`Venster sluiten gaf een fout: ${err.message}`);
  }
  await dicht;
  await sleep(settleDelay);
}

/**
 * Legt een item dat nog aan de cursor hangt terug in de inventaris.
 *
 * Gooit een transfer halverwege een fout ('destination full'), dan heeft mineflayer de stapel
 * al opgepakt maar nooit ergens neergezet. Sluit je het venster dan, dan valt die stapel in
 * vanilla op de grond. Dit voorkomt dat verlies.
 */
async function returnCursorItem(bot, window) {
  if (!window?.selectedItem) return;
  const naam = window.selectedItem.name;
  const slot = window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd);
  if (slot === null) {
    Logger.warn(`${naam} hangt aan de cursor en de inventaris is vol — kan het nergens terugleggen`);
    return;
  }
  try {
    await bot.clickWindow(slot, 0, 0);
    Logger.debug(`${naam} teruggelegd in slot ${slot}`);
  } catch (err) {
    Logger.warn(`Kon ${naam} niet terugleggen: ${err.message}`);
  }
}

/**
 * Loopt naar een blok en opent het. Geeft null terug als dat niet lukt.
 *
 * @param {string[]} opts.allowed blokken die hier geopend mogen worden
 */
async function openContainerAt(bot, pos, shouldStop, opts = {}) {
  const {
    allowed = [], reachDistance = 4, approachRange = 2,
    approachTimeout = 15000, openTimeout = 5000, label = 'kist',
  } = opts;

  if (shouldStop()) return null;

  const afstand = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
  if (afstand > reachDistance) {
    if (!await hasPathTo(bot, pos, opts)) {
      Logger.debug(`Geen pad naar ${label} op ${pos.x} ${pos.y} ${pos.z}`);
      return null;
    }
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, approachRange)),
        approachTimeout,
        `naar ${label} lopen`
      );
    } catch (err) {
      Logger.warn(`Kon niet bij de ${label} komen: ${err.message}`);
      return null;
    }
  }

  if (shouldStop()) return null;

  const block = bot.blockAt(pos);
  if (!block || (allowed.length > 0 && !allowed.includes(block.name))) {
    Logger.debug(`Op ${pos.x} ${pos.y} ${pos.z} staat geen ${label} meer`);
    return null;
  }

  if (!await equipNonPlaceable(bot)) return null;

  try {
    // Zonder timeout blijft openBlock() eeuwig op 'windowOpen' wachten als de kist
    // geblokkeerd is (een kat erop, een blok erboven) — de server stuurt dan gewoon niets.
    return await withTimeout(bot.openBlock(block), openTimeout, `${label} openen`);
  } catch (err) {
    Logger.warn(`${label} op ${pos.x} ${pos.y} ${pos.z} ging niet open: ${err.message}`);
    // Half geopend venster alsnog opruimen, anders weigert de volgende openBlock().
    if (bot.currentWindow) await closeWindow(bot, bot.currentWindow, opts);
    return null;
  }
}

module.exports = {
  sleep,
  equipNonPlaceable,
  waitForClose,
  closeWindow,
  returnCursorItem,
  openContainerAt,
};

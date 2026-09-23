/**
 * Meldt in de chat wanneer het gereedschap dat de bot in zijn hand had kapotgaat.
 *
 * Er bestaat geen apart mineflayer-event voor "dit item is gebroken" — als iets breekt stuurt
 * de server gewoon een set_slot met een lege hand, precies zoals bij het wisselen van
 * gereedschap of het weggeven ervan via !geef. heldItemChanged() vuurt in al die gevallen.
 *
 * Het verschil zit 'm in het SLOT: wisselen van gereedschap (bot.equip) of het legen van de
 * hand (unequip) selecteert altijd een ANDER hotbar-slot. Alleen bij echte slijtage blijft
 * hetzelfde slot geselecteerd terwijl de inhoud verandert. Blijft het slot dus gelijk, en had
 * het vorige item nog maar 1 duurzaamheidspunt over toen het ineens verdween, dan is dat
 * gereedschap kapotgegaan.
 *
 * Bekende beperking: geeft iemand met !geef precies het gereedschap weg dat op dat moment
 * exact 1 duurzaamheidspunt over heeft, dan meldt de bot dat ook als "kapot" — dat verlaat de
 * hand namelijk via hetzelfde slot. Zeldzaam genoeg (exacte timing + exacte duurzaamheid) om
 * te laten zitten.
 */

const { Logger } = require('../utils');

function durabilityLeft(item) {
  if (!item || !item.maxDurability) return Infinity; // niet beschadigbaar
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

function startToolBreakWatcher(bot) {
  let lastSlot = null;
  let lastItem = null;

  bot.on('heldItemChanged', (item) => {
    const slot = bot.quickBarSlot;

    if (slot === lastSlot && !item && lastItem && durabilityLeft(lastItem) <= 1) {
      bot.chat(`Mijn ${lastItem.name} is net kapotgegaan!`);
      Logger.info(`Gereedschap kapot: ${lastItem.name}`);
    }

    lastSlot = slot;
    lastItem = item;
  });

  Logger.info('Gereedschap-slijtage-watcher actief (meldt het als iets in de hand kapotgaat)');
}

module.exports = { startToolBreakWatcher };

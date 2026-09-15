/**
 * Verdrinkingsbeveiliging: staat los van elke taak en draait continu vanaf de eerste spawn
 * (startDrownWatcher wordt in Index.js aangeroepen). Het waarom staat bij startDrownWatcher.
 */

const botState = require('../state');
const { Logger } = require('../utils');

// bot.oxygenLevel loopt van 20 (volle longen) naar 0 (verdrinken).
const SURFACE_AT = 14;   // vanaf hier omhoog zwemmen
const PANIC_AT = 8;      // vanaf hier ook het huidige doel loslaten
const CHECK_INTERVAL = 100;

function headBlock(bot) {
  return bot.blockAt(bot.entity.position.offset(0, 1, 0));
}

function isUnderwater(bot) {
  const head = headBlock(bot);
  if (!head) return false;
  if (head.name === 'water' || head.name === 'bubble_column') return true;
  // Waterlogged trappen/platen tellen ook als water voor de longen van de bot.
  const props = head.getProperties?.();
  return props?.waterlogged === true || props?.waterlogged === 'true';
}

/**
 * Verdrinkingsbeveiliging.
 *
 * De pathfinder zwemt op zich omhoog als hij in water zit (index.js:611 zet 'jump' aan),
 * maar alleen zolang hij een pad volgt. Loopt de bot tijdens een !goto een meer in en ligt
 * het doel aan de overkant, dan zwemt hij vrolijk over de bodem door tot zijn lucht op is.
 * En valt hij er zonder actief doel in, dan zwemt hij helemaal niet omhoog.
 *
 * Deze watcher kijkt puur naar de zuurstof: raakt die op, dan gaat de bot omhoog, en bij
 * echt weinig lucht laat hij ook zijn doel los zodat hij niet de diepte in blijft zwemmen.
 */
function startDrownWatcher(bot) {
  let lastCheck = 0;
  let surfacing = false;
  let warned = false;

  bot.on('physicsTick', () => {
    if (!bot.entity) return;

    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL) return;
    lastCheck = now;

    try {
      const oxygen = bot.oxygenLevel;
      const underwater = isUnderwater(bot);

      if (!underwater || oxygen === undefined || oxygen > SURFACE_AT) {
        if (surfacing) {
          surfacing = false;
          warned = false;
          botState.isDrowning = false;
          bot.setControlState('jump', false);
          Logger.info('Bot is weer boven water');
        }
        return;
      }

      if (!surfacing) {
        surfacing = true;
        botState.isDrowning = true;
        Logger.warn(`Zuurstof op ${oxygen}/20, bot zwemt omhoog`);
      }

      // Omhoog zwemmen. Dit overschrijft wat de pathfinder aan 'jump' doet, en dat is de
      // bedoeling: lucht halen gaat voor het bereiken van een doel.
      bot.setControlState('jump', true);
      bot.setControlState('sprint', false);

      if (oxygen <= PANIC_AT) {
        // Doel loslaten, anders blijft hij richting de overkant over de bodem zwemmen.
        bot.pathfinder.stop();
        bot.setControlState('forward', false);
        if (!warned) {
          warned = true;
          bot.chat('Ik verdrink bijna, ik ga eerst omhoog!');
          Logger.warn('Doel losgelaten wegens zuurstofgebrek');
        }
      }
    } catch (err) {
      Logger.debug(`Drown watcher error: ${err.message}`);
    }
  });

  Logger.info('Verdrinkingsbeveiliging actief');
}

module.exports = { startDrownWatcher, isUnderwater };

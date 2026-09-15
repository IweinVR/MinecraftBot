const { Logger } = require('../utils');

// mineflayer-pathfinder@2.4.5's eigen "openable" detectie vult zichzelf alleen met hekken
// (fence gates, zie movements.js) en NOOIT met echte deuren — canOpenDoors=true helpt daar dus
// niets aan. Deze watcher lost dat apart op: hij checkt continu of er een dichte deur vlak voor
// de bot staat (op voet- en hoofdhoogte, in de richting waar de bot heen kijkt) en klikt 'm open.
const CHECK_INTERVAL = 250;

function isClosedDoor(block) {
  if (!block || !block.name.endsWith('_door')) return false;
  // Een ijzeren deur gaat niet open met de hand; erop klikken doet niets en levert
  // alleen maar een zinloze interactie per 250ms op.
  if (block.name === 'iron_door') return false;
  const props = block.getProperties?.() ?? {};
  // Afhankelijk van de versie is 'open' een boolean of de string 'false'.
  return props.open === false || props.open === 'false';
}

function startDoorWatcher(bot) {
  let lastCheck = 0;

  bot.on('physicsTick', () => {
    // bot.entity bestaat pas na spawn; physicsTick kan er net omheen vuren tijdens een respawn.
    if (!bot.entity) return;

    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL) return;
    lastCheck = now;

    try {
      const yaw = bot.entity.yaw;
      const dx = Math.round(-Math.sin(yaw));
      const dz = Math.round(-Math.cos(yaw));
      if (dx === 0 && dz === 0) return;

      const feet = bot.entity.position.floored();
      const candidates = [
        feet.offset(dx, 0, dz),
        feet.offset(dx, 1, dz),
      ];

      for (const pos of candidates) {
        const block = bot.blockAt(pos);
        if (isClosedDoor(block)) {
          bot.activateBlock(block).catch(err => Logger.debug(`Deur openen mislukt: ${err.message}`));
          break;
        }
      }
    } catch (err) {
      Logger.debug(`Door watcher error: ${err.message}`);
    }
  });

  Logger.info('Door watcher actief');
}

module.exports = { startDoorWatcher };

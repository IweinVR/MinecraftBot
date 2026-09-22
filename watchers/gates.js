const { Logger } = require('../utils');

// setMovements() in utils.js zet canOpenDoors=true, en mineflayer-pathfinder gebruikt dat ook
// voor hekken (fence gates): hij klikt ze open om erdoorheen te lopen. Wat de pathfinder NOOIT
// doet is ze weer dichtklikken. Bij een dierenwei of mobfarm blijft het hek dan openstaan zodra
// de bot er voorbij is gelopen, en lopen dieren/mobs zo naar buiten.
//
// Deze watcher houdt bij welke hekken open staan (via het blockUpdate-event, dat ook vuurt
// wanneer de pathfinder zelf een hek opent) en sluit ze weer zodra de bot er niet meer vlak
// naast staat.
const CLOSE_DELAY = 1500;  // ms wachten voor een open hek dicht mag, anders sluit hij 'm voor de eigen neus dicht
const CHECK_INTERVAL = 250;
const SAFE_DISTANCE = 2;   // pas sluiten als de bot minstens dit ver van het hek af staat

function isOpenGate(block) {
  if (!block || !block.name.endsWith('_gate')) return false;
  const props = block.getProperties?.() ?? {};
  return props.open === true || props.open === 'true';
}

function startGateWatcher(bot) {
  const openGates = new Map(); // "x,y,z" -> { position, openedAt }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!isOpenGate(newBlock)) return;
    const key = `${newBlock.position.x},${newBlock.position.y},${newBlock.position.z}`;
    if (!openGates.has(key)) {
      openGates.set(key, { position: newBlock.position, openedAt: Date.now() });
    }
  });

  let lastCheck = 0;

  bot.on('physicsTick', () => {
    if (!bot.entity || openGates.size === 0) return;

    const now = Date.now();
    if (now - lastCheck < CHECK_INTERVAL) return;
    lastCheck = now;

    for (const [key, gate] of openGates) {
      if (now - gate.openedAt < CLOSE_DELAY) continue;
      if (bot.entity.position.distanceTo(gate.position) < SAFE_DISTANCE) continue;

      const block = bot.blockAt(gate.position);
      if (!isOpenGate(block)) {
        // Iemand anders (speler, redstone) heeft het hek intussen al dichtgedaan.
        openGates.delete(key);
        continue;
      }

      bot.activateBlock(block).catch(err => Logger.debug(`Hek sluiten mislukt: ${err.message}`));
      openGates.delete(key);
    }
  });

  Logger.info('Hekken-watcher actief (sluit open hekken achter de bot)');
}

module.exports = { startGateWatcher };

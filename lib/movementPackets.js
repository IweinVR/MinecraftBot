/**
 * Bewegingspakketten zoals een echte 26.1-client ze stuurt.
 *
 * De pathfinder zelf plant en loopt sprongen en bochten gewoon goed. Offline nagespeeld met
 * precies deze pathfinder, physics en setMovements() komt de bot overal: één blok omhoog, een
 * trap van hele blokken, schuin omhoog, om een L-muur, door een bocht in een gang van 1 breed.
 * Ook plat tegen een blok aan en zonder vaart springt hij er gewoon op. Wat op de server misgaat
 * zit dus tussen de bot en de server, en daar laat mineflayer 4.38 bij 26.1 drie dingen weg die
 * de gewone client wél stuurt:
 *
 *   1. hasHorizontalCollision in elk bewegingspakket. Mineflayer stuurt altijd false, ook in de
 *      ticks waarin zijn eigen physics net tegen een blok aan botste. Dat valt precies samen met
 *      wat wel en niet lukte: over vlakke grond, naar beneden en over een trap botst de bot nooit
 *      zijwaarts (een trede neemt hij met stepHeight, en daarna is de botsing opgelost). Bij één
 *      blok omhoog botst hij 2-3 ticks tegen het blok voor hij erop staat, en om een hoek schuurt
 *      hij zo'n 8 ticks langs de rand.
 *   2. player_input met de toetsen die ingedrukt zijn. Sinds 1.21.2 meldt de client elke
 *      verandering daarin. Mineflayer stuurt dat pakket alleen bij sluipen, en dan met alléén
 *      shift erin, zodat de server vooruit, springen en sprinten ook als losgelaten ziet.
 *   3. tick_end na elke client-tick. Daaraan ziet de server waar een tick ophoudt, en dus ook
 *      dat de speler een tick lang níet bewogen heeft.
 *
 * ViaVersion/ViaBackwards zetten deze pakketten één-op-één door naar de 26.2-server. Welke van
 * de drie die server precies nodig heeft is van hieruit niet te zien, dus ze staan alle drie aan:
 * op dit punt is de bot daarmee niet meer van een gewone client te onderscheiden.
 *
 * Zet de server de bot tóch terug naar een eerdere plek (rubberbanding), dan komt dat in de log,
 * met de afstand en of hij op dat moment botste of in de lucht was. Na één testrondje is dan te
 * zien of het nog gebeurt, en waar.
 */

const { CONFIG } = require('../config');
const { Logger } = require('../utils');

const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'flying']);

// [vlag in player_input, naam in bot.controlState]
const INPUT_KEYS = [
  ['forward', 'forward'],
  ['backward', 'back'],
  ['left', 'left'],
  ['right', 'right'],
  ['jump', 'jump'],
  ['shift', 'sneak'],
  ['sprint', 'sprint'],
];

const SETBACK_MAX_DISTANCE = 8;     // verder dan dit is een echte teleport (/tp, respawn), geen terugzetter
const SETBACK_LOG_INTERVAL = 2000;  // hooguit één logregel per zoveel ms, de rest wordt geteld

function inputsFromControls(controlState) {
  const inputs = {};
  for (const [flag, control] of INPUT_KEYS) inputs[flag] = !!controlState[control];
  return inputs;
}

// Een vlag die in het pakket ontbreekt, staat voor de server op "losgelaten".
function inputsFromPacket(packetInputs) {
  const inputs = {};
  for (const [flag] of INPUT_KEYS) inputs[flag] = !!packetInputs[flag];
  return inputs;
}

function sameInputs(a, b) {
  return !!a && !!b && INPUT_KEYS.every(([flag]) => a[flag] === b[flag]);
}

function fmt(pos) {
  return `${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)}`;
}

function startMovementPackets(bot) {
  const opts = CONFIG.movementPackets;
  if (!opts?.enabled) return;

  // Pas bij de eerste spawn: dan ligt de versie vast (supportFeature), en staan de handlers van
  // de pathfinder en de sprong-watcher al vóór de onze op physicsTick. Die zetten hun toetsen
  // in die event, en wij moeten de toetsen doorgeven zoals ze de volgende tick gesimuleerd worden.
  bot.once('spawn', () => {
    if (!bot.supportFeature('newPlayerInputPacket')) {
      Logger.info('Bewegingspakketten: niet nodig voor deze versie');
      return;
    }

    const client = bot._client;
    const write = client.write.bind(client);
    let sentInputs = null;   // wat de server nu denkt dat er ingedrukt is

    client.write = function (name, params) {
      if (MOVE_PACKETS.has(name) && params && typeof params.flags === 'object' && bot.entity) {
        params.flags.hasHorizontalCollision = !!bot.entity.isCollidedHorizontally;
      } else if (name === 'player_input' && params?.inputs) {
        // Ook mineflayers eigen sluip-pakket komt hier langs: onthouden, zodat de sync hieronder
        // ziet dat de server nu alle andere toetsen als losgelaten heeft, en dat rechtzet.
        sentInputs = inputsFromPacket(params.inputs);
      }
      return write(name, params);
    };

    let lastTick = null;     // { pos, collided, airborne } van de vorige physics-tick
    let setbacks = 0;
    let lastSetbackLog = 0;

    bot.on('physicsTick', () => {
      // In een voertuig stuurt mineflayer zelf player_input om te sturen; daar niet overheen.
      if (!bot.vehicle) {
        const inputs = inputsFromControls(bot.controlState);
        if (!sameInputs(inputs, sentInputs)) client.write('player_input', { inputs });
      }
      client.write('tick_end', {});

      if (opts.logSetbacks && bot.entity) {
        lastTick = {
          pos: bot.entity.position.clone(),
          collided: !!bot.entity.isCollidedHorizontally,
          airborne: !bot.entity.onGround,
        };
      }
    });

    // Na de dood of een respawn is de volgende forcedMove een verplaatsing, geen terugzetter.
    bot.on('death', () => { lastTick = null; });
    bot.on('respawn', () => { lastTick = null; });

    // forcedMove = de server heeft de positie van de bot overschreven.
    bot.on('forcedMove', () => {
      const before = lastTick;
      lastTick = null;
      if (!opts.logSetbacks || !before || !bot.entity) return;

      const afstand = bot.entity.position.distanceTo(before.pos);
      if (afstand > SETBACK_MAX_DISTANCE) return;

      setbacks++;
      const now = Date.now();
      if (now - lastSetbackLog < SETBACK_LOG_INTERVAL) return;
      lastSetbackLog = now;
      Logger.warn(
        `Server zette de bot ${afstand.toFixed(2)} blok terug (${setbacks}x sinds vorige melding), ` +
        `van ${fmt(before.pos)} naar ${fmt(bot.entity.position)}: ` +
        `botste=${before.collided ? 'ja' : 'nee'}, in de lucht=${before.airborne ? 'ja' : 'nee'}, ` +
        `pad actief=${bot.pathfinder?.isMoving() ? 'ja' : 'nee'}`
      );
      setbacks = 0;
    });

    Logger.info('Bewegingspakketten actief (horizontale botsing, toetsen en tick_end zoals een 26.1-client)');
  });
}

module.exports = { startMovementPackets };

/**
 * Startpunt: maakt de bot, laadt de plugins en hangt alle event-handlers op.
 *
 * Indeling van het project:
 *   config.js    alle instelbare getallen en lijsten, op één plek
 *   state.js     gedeelde runtime-state — één object dat alle modules importeren
 *   utils.js     helpers rond items, blokken, pathfinder-movements en timeouts
 *   features/    één bestand per ding dat de bot kan: minen, boeren, fokken, sorteren,
 *                handelen, vissen, de koerier, vechten, chatten en de commando-afhandeling
 *   watchers/    lopen continu mee zonder commando: deuren openen, niet verdrinken
 *   lib/         gedeelde bouwstenen die geen feature zijn (vensters, de opslagindex)
 *   data/        kale tabellen zonder logica: gewassen, sorteercategorieën, liedjes
 *
 * Drie patronen die in bijna elke feature terugkomen; ken je die, dan lees je de rest vlot:
 *
 *  1. SESSIENUMMERS. Elke langlopende taak (minen, boeren, fokken, sorteren) verhoogt bij de
 *     start zijn eigen teller in state.js en onthoudt die. Merkt een lus dat de teller
 *     intussen veranderd is, dan breekt hij zichzelf af. Zonder dat lopen er na een respawn
 *     of een tweede commando twee lussen door elkaar heen over dezelfde state.
 *
 *  2. DE BOT PLAATST NOOIT BLOKKEN. enforceNoBlockPlacing() onderschept
 *     pathfinder.setMovements, zodat élke Movements zonder scaffolding draait — ook die van
 *     mineflayer-pvp en collectblock, die er zelf een nieuwe neerzetten. De placeBlock-guard
 *     hieronder weigert wat daar toch langs komt. Bewuste plaatsingen (fakkel, kist, zaad)
 *     lopen via placeBlockAllowed() uit utils.js.
 *
 *  3. NIETS BLIJFT EEUWIG HANGEN. Een goto, een dig of een openBlock kan bij een nukkige
 *     server nooit terugkomen. Alles wat op de server wacht zit in withTimeout() of
 *     abortable(), zodat !stop en een respawn er altijd doorheen komen.
 */

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { plugin: collectBlockPlugin } = require('mineflayer-collectblock');
const armorManager = require('mineflayer-armor-manager');
const { plugin: pvpPlugin } = require('mineflayer-pvp');
const { CONFIG, HOSTILE_MOBS } = require('./config');
const botState = require('./state');
const { Logger, setMovements, findNearestEntity, distanceToGround, enforceNoBlockPlacing } = require('./utils');
const { restoreGoal } = require('./features/mining');
const { handleCommand } = require('./features/commands');
const { useWaterBucket, faceAttacker, fleeFromDanger } = require('./features/combat');
const { handleChatReactions } = require('./features/chat');
const { startDoorWatcher } = require('./watchers/doors');
const { startDrownWatcher } = require('./watchers/safety');
const { startGateWatcher } = require('./watchers/gates');
const { startJoinGreeter } = require('./watchers/greeting');
const { startJumpWatcher } = require('./watchers/jump');

async function createBot() {
  Logger.info(`Connecting to ${CONFIG.server.host}:${CONFIG.server.port} as ${CONFIG.server.username}`);
  const bot = mineflayer.createBot(CONFIG.server);
  bot.setMaxListeners(100);
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(collectBlockPlugin);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(pvpPlugin);
  startDoorWatcher(bot);
  startDrownWatcher(bot);
  startGateWatcher(bot);
  startJoinGreeter(bot);
  startJumpWatcher(bot);

  // mineflayer-auto-eat is ESM-only; dit project is CommonJS, dus het heeft een dynamic import nodig.
  // NOTE: bot.loadPlugin() *queuet* de plugin alleen tot mineflayers interne 'inject_allowed'-punt
  // gepasseerd is, dus bot.autoEat bestaat vlak na deze aanroep mogelijk nog niet.
  // Configureren moet daarom wachten tot 'spawn' (die altijd ná dat punt vuurt).
  try {
    const { loader: autoEatPlugin } = await import('mineflayer-auto-eat');
    bot.loadPlugin(autoEatPlugin);
  } catch (err) {
    Logger.error('Kon mineflayer-auto-eat niet laden, bot eet niet automatisch', err);
  }

  // Block placement override: geen blokken plaatsen zolang canPlace=false.
  // botState.allowPlacement is de enige uitzondering — zie placeBlockAllowed() in utils.js.
  // Zonder die uitzondering zou het terugplanten van zaad tijdens het boeren stilletjes
  // niets doen, want farmen draait bewust met canPlace=false.
  const originalPlaceBlock = bot.placeBlock;
  bot.placeBlock = function (...args) {
    if (botState.allowPlacement <= 0 && bot.pathfinder?.movements?.canPlace === false) {
      Logger.debug('Block placement blocked (canPlace=false)');
      // Bewust een reject en geen resolve: bij een resolve denkt de pathfinder dat het
      // blok er ligt en loopt hij het gat in dat hij net wilde overbruggen. Met een reject
      // valt hij terug op resetPath('place_error') en zoekt hij een andere route.
      return Promise.reject(new Error('Blokken plaatsen staat uit'));
    }
    return originalPlaceBlock.apply(this, args);
  };

  // Auto-eat instellen gebeurt maar één keer: bot.autoEat blijft over respawns heen
  // bestaan, dus dit hoeft niet bij elke 'spawn' herhaald te worden.
  bot.once('spawn', () => {
    if (bot.autoEat) {
      bot.autoEat.setOpts({ minHunger: CONFIG.health.foodThreshold });
      // De 'eatFail'-event geeft een Error mee, geen { error }-object. Het destructureren
      // daarvan leverde altijd "undefined" op in de log.
      bot.autoEat.on('eatFail', (err) => Logger.debug(`Auto-eat mislukt: ${err?.message ?? err}`));
      bot.autoEat.enableAuto();
    }
  });

  let hasSpawned = false;
  bot.on('spawn', () => {
    // 'spawn' vuurt ook na elke respawn; de begroeting hoort alleen bij de eerste keer.
    if (!hasSpawned) {
      hasSpawned = true;
      Logger.info('Bot spawned en online!');
      bot.chat('Bot is online o7');

      // Moet vóór de eerste setMovements: vanaf nu kan geen enkele plugin de pathfinder
      // nog blokken laten plaatsen.
      enforceNoBlockPlacing(bot);

      // De standaard 5 seconden denktijd is te krap voor doelen ver weg of achter een
      // doolhof; dat is precies de "Took to long to decide path to goal!"-melding.
      // searchRadius begrenst het zoekgebied zodat een onbereikbaar doel snel 'noPath'
      // oplevert in plaats van eindeloos doorrekenen.
      bot.pathfinder.thinkTimeout = CONFIG.pathfinding.thinkTimeout;
      bot.pathfinder.tickTimeout = CONFIG.pathfinding.tickTimeout;
      bot.pathfinder.searchRadius = CONFIG.pathfinding.searchRadius;
      Logger.info(`Pathfinder: thinkTimeout=${bot.pathfinder.thinkTimeout}ms, searchRadius=${bot.pathfinder.searchRadius}`);
    } else {
      Logger.info('Bot gerespawned');
    }
    botState.lastHealth = bot.health;
    setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });
  });

  // Sinds 1.20 stuurt de server een damage_event mee met de échte veroorzaker, en mineflayer
  // geeft die door als tweede argument van 'entityHurt' (entities.js:377-381).
  // Daarvoor raadde deze handler de aanvaller door de dichtstbijzijnde speler te pakken —
  // dus als de bot in lava liep, viel of verdronk, kreeg de toevallig dichtstbijzijnde
  // speler de schuld en draaide de bot zich naar hem toe. Nu wordt er alleen nog iemand
  // aangewezen als de server daadwerkelijk een entity als bron noemt.
  bot.on('entityHurt', async (entity, source) => {
    if (botState.isFleeing || entity !== bot.entity) return;

    // sourceCauseId 0 betekent "geen entity" -> omgevingsschade (lava, vuur, vallen,
    // verdrinken, cactus). Dan is er niemand om boos op te zijn.
    const attackerEntity = source && source !== bot.entity ? source : null;
    const attackerPlayer = attackerEntity?.type === 'player'
      ? bot.players[attackerEntity.username] ?? { username: attackerEntity.username, entity: attackerEntity }
      : null;

    if (attackerEntity) {
      Logger.debug(`Schade van ${attackerEntity.username ?? attackerEntity.name ?? 'onbekende entity'}`);
    } else {
      Logger.debug('Schade zonder entity-bron (omgeving: lava, val, verdrinken, ...)');
    }

    if (attackerPlayer?.entity) {
      botState.lastAttacker = attackerPlayer.username;
      faceAttacker(bot, attackerPlayer);
    }

    if (botState.isMining || botState.isFighting || botState.isSuiciding) return;

    if (bot.health <= CONFIG.health.maxHealth / 2) {
      // Alleen vluchten voor iets waar je vóór kunt weglopen. Bij omgevingsschade heeft
      // wegrennen van een niet-bestaande aanvaller geen zin; dan kijken we of er toch een
      // vijandige mob in de buurt staat, en anders laten we het met rust.
      let threatPos = attackerEntity?.position ?? null;

      if (!threatPos) {
        // entity.name kan undefined zijn (bv. bij entities waarvan de metadata nog niet
        // binnen is); zonder die check klapte .includes() hier eruit.
        const mob = findNearestEntity(
          bot,
          e => e.type === 'mob' && e.name && HOSTILE_MOBS.some(name => e.name.includes(name)),
          CONFIG.search.monsterDetectionRange
        );
        threatPos = mob ? mob.position : null;
      }

      if (threatPos) {
        fleeFromDanger(bot, threatPos);
      }
    }
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    try {
      if (handleChatReactions(bot, username, message)) return;
      handleCommand(bot, username, message);
    } catch (err) {
      // Een throw in een event-handler is in Node een uncaught exception en nekt het proces;
      // chat komt van buiten, dus dat mag nooit de bot omleggen.
      Logger.error(`Fout bij verwerken van chat van ${username}`, err);
    }
  });

  bot.on('physicsTick', async () => {
    if (!bot.entity) return;
    const velocity = bot.entity.velocity.y;

    if (velocity < CONFIG.physics.fallVelocity) {
      botState.fallingTicks++;
    } else {
      botState.fallingTicks = 0;
      botState.bucketUsed = false;
    }

    // Puur op tijd wachten werkte niet betrouwbaar: na fallTicks ticks vallen zit de bot vaak
    // nog te hoog in de lucht om de bucket ergens op te richten (activateItem heeft een blok
    // binnen bereik nodig om de emmer te legen). Daarom nu ook pas triggeren als de grond dichtbij is.
    if (botState.fallingTicks >= CONFIG.physics.fallTicks && !botState.bucketUsed) {
      const groundDistance = distanceToGround(bot, 5);
      if (groundDistance <= 3) {
        botState.bucketUsed = true;
        Logger.debug(`Water bucket deployed for fall damage (grond op ${groundDistance} blokken)`);
        await useWaterBucket(bot);
      }
    }
  });

  bot.on('death', () => {
    Logger.warn('Bot is dood, wacht op respawn...');

    // Eerst echt gerespawned zijn voordat we een doel herstellen: bot.respawn() gaat meteen
    // na 'death' de deur uit, maar de nieuwe positie en wereld zijn pas bij 'spawn' geldig.
    // Een vaste timeout van 2s raakte er regelmatig naast.
    let done = false;
    const onSpawn = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      bot.removeListener('spawn', onSpawn);

      if (!botState.shouldRestore) {
        Logger.info('Restore disabled (!stop was gegeven)');
        return;
      }
      Logger.info('Respawned, doel wordt hersteld...');
      restoreGoal(bot).catch(err => Logger.error('Restore goal error', err));
    };

    const fallback = setTimeout(() => {
      if (done) return;
      done = true;
      bot.removeListener('spawn', onSpawn);
      Logger.warn('Geen spawn-event na 15s, restore overgeslagen');
    }, 15000);

    bot.on('spawn', onSpawn);
  });

  bot.on('error', (err) => Logger.error('MINEFLAYER ERROR', err));

  // 'kicked' en 'end' vuren vaak allebei bij dezelfde disconnect (kick sluit de verbinding,
  // wat ook 'end' triggert). Zonder deze guard plant elk apart een reconnect, en verdubbelt
  // het aantal bot-instances bij elke disconnect — met alle "gekickt: already logged in"-ellende
  // van dien.
  let reconnectScheduled = false;
  const scheduleReconnect = () => {
    if (reconnectScheduled) return;
    reconnectScheduled = true;

    // De follow-lus en mining-lus draaien op timers die de oude (dode) bot vasthouden.
    // Die moeten we hier loslaten, anders blijven ze naast de nieuwe verbinding doortikken.
    botState.followToken = null;
    botState.isMining = false;
    botState.isFighting = false;
    botState.isFleeing = false;
    botState.fallingTicks = 0;
    botState.bucketUsed = false;

    Logger.info('Herverbinden over 5s...');
    setTimeout(() => {
      // createBot is async: zonder catch wordt een fout hier een unhandled rejection,
      // en die sloopt in moderne Node het hele proces.
      createBot().catch(err => {
        Logger.error('Reconnect mislukt, nieuwe poging over 5s', err);
        reconnectScheduled = false;
        scheduleReconnect();
      });
    }, 5000);
  };

  bot.on('kicked', (reason) => {
    Logger.warn(`Gekickt van server: ${reason}`);
    scheduleReconnect();
  });

  bot.on('end', () => {
    Logger.warn('Verbinding verbroken');
    scheduleReconnect();
  });
}

createBot().catch(err => Logger.error('Kon bot niet starten', err));

/**
 * Vechten, vluchten, slapen en doodgaan — alles waarbij de bot met gevaar te maken heeft.
 *
 * Het meeste hiervan wordt getriggerd vanuit Index.js (entityHurt, physicsTick) en niet door
 * een commando. Belangrijk detail daarbij: schade zonder entity-bron is omgevingsschade
 * (lava, vallen, verdrinken), en dan is er niemand om boos op te zijn. Dat werd hier eerder
 * geraden door de dichtstbijzijnde speler te pakken, wat betekende dat de bot zich omdraaide
 * naar wie er toevallig in de buurt stond als hij in lava liep.
 *
 * useWaterBucket() is de MLG-truc tegen valschade; die triggert pas als de grond dichtbij is,
 * want activateItem heeft een blok binnen bereik nodig om de emmer op te legen.
 */

const { goals } = require('mineflayer-pathfinder');
const { CONFIG, HOSTILE_MOBS } = require('../config');
const botState = require('../state');
const { Logger, findItem, findItemExact, findNearestBlock, findNearestEntity, setMovements } = require('../utils');
const { restoreGoal } = require('./mining');

// mineflayer: pitch = pi/2 is recht OMHOOG, -pi/2 is recht OMLAAG (bot.lookAt rekent
// pitch = atan2(dy, horizontaleAfstand)). Omhoog kijken raakt geen blok, dus de emmer
// moet omlaag gericht worden.
const PITCH_DOWN = -Math.PI / 2;

async function useWaterBucket(bot) {
  try {
    const waterBucket = findItem(bot, 'water_bucket');
    if (!waterBucket) return;

    await bot.equip(waterBucket, 'hand');
    await bot.look(bot.entity.yaw, PITCH_DOWN, true);
    bot.activateItem();

    await new Promise(resolve => setTimeout(resolve, CONFIG.physics.bucketActivateDelay));

    // Exact matchen: findItem(bot, 'bucket') matcht op substring en levert dus net zo goed
    // een andere water_bucket of lava_bucket op, waarmee de bot nog meer water zou plaatsen
    // in plaats van het opgezette water weer op te pakken.
    const emptyBucket = findItemExact(bot, 'bucket');
    if (emptyBucket) {
      await bot.equip(emptyBucket, 'hand');
      await bot.look(bot.entity.yaw, PITCH_DOWN, true);
      bot.activateItem();
    }
  } catch (err) {
    Logger.error('Water bucket error', err);
  }
}

async function setBedSpawn(bot) {
  try {
    Logger.info('!bed commando: Bot zoekt dichtste bed');
    const bedBlocks = Object.keys(bot.registry.blocksByName)
      .filter(name => name.endsWith('_bed'));

    Logger.debug(`${bedBlocks.length} bedtypes gevonden`);

    const bedPos = findNearestBlock(bot, bedBlocks, CONFIG.search.bedSearchRadius);

    if (!bedPos) {
      Logger.warn('Geen bed gevonden binnen zoekradius');
      bot.chat('Geen bed gevonden!');
      return;
    }

    Logger.info(`Bed gevonden op ${bedPos.x} ${bedPos.y} ${bedPos.z}, loopt ernaartoe...`);
    bot.chat(`Bed gevonden, gaat naar ${bedPos.x} ${bedPos.y} ${bedPos.z}`);

    // GoalNear i.p.v. GoalBlock: in het bed zelf gaan staan kan niet, ernaast wel.
    await bot.pathfinder.goto(new goals.GoalNear(bedPos.x, bedPos.y, bedPos.z, CONFIG.pathfinding.nearDistance));

    // Minecraft zet het spawnpoint alleen echt als je 's nachts of tijdens onweer bij het bed
    // gaat liggen. Overdag stuurt activateBlock() de interactie prima, maar de server negeert
    // 'm dan gewoon — dus zonder deze check claimden we hier succes dat er niet was.
    const canSleepNow = !bot.time.isDay || (bot.isRaining && bot.thunderState > 0);
    if (!canSleepNow) {
      Logger.warn('Bed spawn geweigerd: het is dag en er is geen onweer');
      bot.chat('Het is dag, ik kan nu geen spawnpoint zetten. Probeer het \'s nachts of tijdens onweer!');
      return;
    }

    // Het blok pas hier ophalen: tijdens het lopen kan de chunk ge(her)laden zijn, en een
    // blockAt() van vóór de reis kan dan een verouderd of null blok opleveren.
    const bedBlock = bot.blockAt(bedPos);
    if (!bedBlock) {
      Logger.warn('Bed niet meer gevonden na aankomst');
      bot.chat('Het bed is verdwenen...');
      return;
    }

    // bot.sleep() i.p.v. activateBlock(): een bed bestaat uit twee blokken (hoofd- en
    // voeteneinde) en alleen een klik op de juiste helft telt. findBlock() geeft willekeurig
    // een van de twee terug — met één bed in de buurt was dat vaak de verkeerde helft en
    // gebeurde er niets, terwijl er bij twee bedden genoeg kandidaten waren dat het toevallig
    // wél goed ging. bot.sleep() zoekt zelf het juiste deel op en geeft een echte foutmelding
    // ("there are monsters nearby", "too far away") in plaats van stilte.
    await bot.sleep(bedBlock);

    Logger.info('Respawn point ingesteld!');
    bot.chat('Respawn point ingesteld, welterusten!');
  } catch (err) {
    // bot.sleep() gooit sprekende fouten; die zijn nuttiger voor de speler dan "er ging iets mis".
    Logger.error('Bed spawn error', err);
    bot.chat(`Kan niet gaan slapen: ${err.message}`);
  }
}

async function faceAttacker(bot, player) {
  try {
    if (!player.entity) return;
    const username = player.username || 'onbekend';
    await bot.lookAt(player.entity.position.offset(0, 1.6, 0));
    Logger.info(`${username} heeft de bot geraakt, kijkt in die richting`);
  } catch (err) {
    Logger.error('Face attacker error', err);
  }
}

async function fleeFromDanger(bot, threatPos) {
  try {
    if (botState.isFleeing || !threatPos) return;

    botState.isFleeing = true;
    bot.pathfinder.stop();

    Logger.warn(`FLEE: Bot heeft nog maar ${bot.health.toFixed(1)} HP, vlucht weg!`);
    bot.chat('HELP HELP');

    const botPos = bot.entity.position;
    const dx = botPos.x - threatPos.x;
    const dz = botPos.z - threatPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    const fleeDistance = CONFIG.pathfinding.fleeDistance;

    const fleeX = botPos.x + (dx / dist) * fleeDistance;
    const fleeZ = botPos.z + (dz / dist) * fleeDistance;

    try {
      await bot.lookAt(threatPos.offset(0, 1.6, 0));
      await bot.look(bot.entity.yaw + Math.PI, 0, true);
    } catch (err) {
      Logger.debug('Kon niet wegkijken van gevaar');
    }

    let fleeTimer;
    try {
      const gotoPromise = bot.pathfinder.goto(new goals.GoalXZ(fleeX, fleeZ));
      const timeoutPromise = new Promise((_, reject) => {
        fleeTimer = setTimeout(() => reject(new Error('Timeout')), 10000);
      });
      await Promise.race([gotoPromise, timeoutPromise]);
      Logger.info('Bot is ontsnapt naar veilige afstand');
    } catch (err) {
      Logger.debug(`Vlucht pathfinding gestopt: ${err.message}`);
    } finally {
      clearTimeout(fleeTimer);
    }

    botState.isFleeing = false;

    if (botState.lastGoal?.type === 'follow') {
      const target = bot.players[botState.lastGoal.username]?.entity;
      if (target) {
        Logger.info(`Terug naar follow ${botState.lastGoal.username} na vlucht`);
        bot.pathfinder.setGoal(new goals.GoalFollow(target, CONFIG.pathfinding.followDistance), true);
      } else {
        botState.lastGoal = null;
      }
    } else if (botState.lastGoal?.type === 'goto') {
      await restoreGoal(bot);
    }
  } catch (err) {
    Logger.error('Flee error', err);
    botState.isFleeing = false;
  }
}

// 'copper' hoort hier sinds koperen gereedschap bestaat: koper zit qua schade en duurzaamheid
// tussen steen en ijzer in. Zonder deze regel viel een copper_sword terug op de laagste rang
// en koos de bot liever een stenen zwaard.
const WEAPON_MATERIAL_RANK = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
// Let op: doordat de index bij de score opgeteld wordt, wint een axe het van een sword van
// hetzelfde materiaal. Dat klopt ook met hoe mineflayer-pvp vecht (volledige cooldown afwachten,
// dus schade per klap telt), maar dit is de plek om het om te draaien als je sword wilt.
const WEAPON_TYPE_RANK = ['sword', 'axe'];

function weaponScore(item) {
  const type = WEAPON_TYPE_RANK.findIndex(t => item.name.endsWith(`_${t}`));
  if (type === -1) return -1;
  const material = WEAPON_MATERIAL_RANK.findIndex(m => item.name.startsWith(m));
  // Onbekend materiaal gaf hier -1, en daarmee een score lager dan die van "geen wapen".
  // Zo'n wapen werd dus nooit uitgerust; als vloer nemen we nu de laagste bekende rang.
  const materialRank = material === -1 ? 0 : material;
  return materialRank * WEAPON_TYPE_RANK.length + type;
}

async function equipBestWeapon(bot) {
  let best = null;
  let bestScore = -1;

  for (const item of bot.inventory.items()) {
    const score = weaponScore(item);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best) return;

  try {
    await bot.equip(best, 'hand');
    Logger.debug(`Beste wapen equipped: ${best.name}`);
  } catch (err) {
    Logger.debug(`Kon wapen niet equippen: ${err.message}`);
  }
}

async function fightPlayer(bot, username) {
  if (botState.isFighting) return;

  let cleanedUp = false;
  let stopWatcher = null;
  let fightTimer = null;
  let onEntityGone = null;
  let onDeath = null;
  let onStopped = null;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(stopWatcher);
    clearTimeout(fightTimer);
    if (onEntityGone) bot.removeListener('entityGone', onEntityGone);
    if (onDeath) bot.removeListener('death', onDeath);
    if (onStopped) bot.removeListener('stoppedAttacking', onStopped);
    botState.isFighting = false;
  };

  try {
    const player = bot.players[username];
    if (!player?.entity) {
      bot.chat(`Ik zie je niet, ${username}!`);
      return;
    }

    const distance = bot.entity.position.distanceTo(player.entity.position);
    if (distance > CONFIG.pathfinding.reachDistance) {
      bot.chat(`Kom dichterbij, ${username}, je staat niet binnen bereik!`);
      return;
    }

    botState.isFighting = true;
    botState.stopFighting = false;
    await equipBestWeapon(bot);
    bot.chat(`Oke ${username}, we vechten!`);
    Logger.info(`Fight gestart tegen ${username}`);

    const targetEntity = player.entity;
    const targetId = targetEntity.id;
    let targetDied = false;
    let botDied = false;
    let timedOut = false;

    onEntityGone = (removed) => {
      if (removed.id === targetId) targetDied = true;
    };
    onDeath = () => {
      botDied = true;
      // mineflayer-pvp stopt zichzelf NIET als de bot (de aanvaller) sterft — alleen bij
      // entityGone van het doel of het verlaten van viewDistance. Zonder forceStop() wordt
      // 'stoppedAttacking' dus nooit uitgezonden.
      bot.pvp.forceStop();
    };

    bot.on('entityGone', onEntityGone);
    bot.once('death', onDeath);

    const finished = new Promise((resolve) => {
      onStopped = () => resolve();
      // Listener eerst registreren, pas daarna aanvallen: pvp.attack() begint met een
      // interne stop() die 'stoppedAttacking' kan uitzenden, en die zou anders gemist worden.
      bot.once('stoppedAttacking', onStopped);

      stopWatcher = setInterval(() => {
        if (botState.stopFighting || botState.isFleeing) {
          bot.pvp.forceStop();
          // forceStop() doet niets (en zendt dus ook niets uit) als er al geen target meer is;
          // dan zouden we hier voor altijd blijven wachten.
          if (!bot.pvp.target) resolve();
        }
      }, 300);

      // Harde bovengrens: als pvp om welke reden dan ook nooit 'stoppedAttacking' uitzendt,
      // bleef isFighting anders permanent true en was !vecht voorgoed geblokkeerd.
      fightTimer = setTimeout(() => {
        timedOut = true;
        bot.pvp.forceStop();
        resolve();
      }, CONFIG.combat.fightTimeout);
    });

    Promise.resolve(bot.pvp.attack(targetEntity))
      .catch(err => Logger.debug(`pvp.attack error: ${err.message}`));
    await finished;

    cleanup();

    // mineflayer-pvp zet tijdens attack() zijn eigen Movements op de pathfinder (mét canDig en
    // scaffolding). Die moeten we terugdraaien, anders sloopt de bot na elk gevecht de omgeving.
    setMovements(bot, { canDig: false, canPlace: false, allowSprinting: true });

    if (botDied) {
      Logger.warn(`Bot is gestorven tijdens het gevecht tegen ${username}`);
    } else if (targetDied) {
      bot.chat(`GG ${username}, ik heb gewonnen!`);
      Logger.info(`${username} is verslagen in het gevecht`);
    } else if (timedOut) {
      bot.chat('Ik kap ermee, dit duurt te lang!');
      Logger.warn(`Fight tegen ${username} afgebroken na timeout`);
    } else {
      bot.chat('Gevecht voorbij!');
      Logger.info(`Fight tegen ${username} gestopt`);
    }
  } catch (err) {
    Logger.error('Fight player error', err);
  } finally {
    cleanup();
  }
}

async function killBot(bot) {
  try {
    botState.isSuiciding = true;   // onderdrukt het vluchtgedrag, anders rent hij weg van de lava
    Logger.info('!die commando: Bot probeert zichzelf om te brengen');
    const botPos = bot.entity.position;

    Logger.debug('Zoeken naar monsters...');
    const monster = findNearestEntity(
      bot,
      entity => entity.type === 'mob' && entity.name && HOSTILE_MOBS.some(mob => entity.name.includes(mob)),
      CONFIG.search.monsterDetectionRange
    );

    if (monster) {
      Logger.info(`Monster gevonden: ${monster.name}, gaat erheen...`);
      bot.chat('Naar monsters...');
      await bot.pathfinder.goto(new goals.GoalNear(monster.position.x, monster.position.y, monster.position.z, CONFIG.pathfinding.nearDistance));
      // Eén klap maakt de bot niet dood; blijven porren tot het monster of de bot om is.
      for (let i = 0; i < 20 && monster.isValid && bot.health > 0; i++) {
        bot.attack(monster);
        await new Promise(resolve => setTimeout(resolve, 600));
      }
      return;
    }

    Logger.debug('Zoeken naar dichtste doodsmogelijkheid (lava, vuur, water)...');
    const lava = findNearestBlock(bot, 'lava', CONFIG.search.deathSearchRadius);
    const fire = findNearestBlock(bot, 'fire', CONFIG.search.deathSearchRadius);

    const options = [];
    if (lava) options.push({ pos: lava, name: 'Lava' });
    if (fire) options.push({ pos: fire, name: 'Vuur' });

    if (options.length === 0) {
      Logger.warn('Geen monsters, lava of vuur gevonden om dood te gaan!');
      bot.chat('Geen doodsmogelijkheden gevonden.');
      return;
    }

    const closest = options.reduce((min, opt) =>
      botPos.distanceTo(opt.pos) < botPos.distanceTo(min.pos) ? opt : min
    );

    Logger.info(`${closest.name} gevonden op ${closest.pos.x} ${closest.pos.y} ${closest.pos.z}`);
    bot.chat(`Naar ${closest.name}...`);
    await bot.pathfinder.goto(new goals.GoalNear(closest.pos.x, closest.pos.y, closest.pos.z, 2));

    // Hier bleef het eerder bij: de bot stond netjes naast de lava en ging niet dood.
    // De pathfinder loopt namelijk nooit vrijwillig lava in (lava staat in blocksToAvoid),
    // dus de laatste stap moet met de hand. Pathfinder eerst helemaal loslaten, anders
    // stuurt die de bot meteen weer terug naar veilig gebied.
    await walkInto(bot, closest.pos, closest.name);

  } catch (err) {
    Logger.error('Kill bot error', err);
  } finally {
    botState.isSuiciding = false;
  }
}

/** Loopt letterlijk het doelblok in en blijft duwen tot de bot dood is of de tijd om is. */
async function walkInto(bot, pos, label) {
  bot.pathfinder.setGoal(null);
  bot.pathfinder.stop();

  const startHealth = bot.health;
  Logger.info(`Loopt ${label} in op ${pos.x} ${pos.y} ${pos.z} (${startHealth} HP)`);

  try {
    for (let tick = 0; tick < 100; tick++) {   // maximaal ~20 seconden
      if (bot.health <= 0) break;
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      await new Promise(resolve => setTimeout(resolve, 200));

      if (bot.health < startHealth) {
        Logger.info(`Schade opgelopen (${bot.health} HP), blijft erin staan`);
      }
    }
  } finally {
    bot.clearControlStates();
  }
}

module.exports = { useWaterBucket, setBedSpawn, faceAttacker, fleeFromDanger, fightPlayer, killBot };

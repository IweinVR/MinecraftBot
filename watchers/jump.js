/**
 * Extra sprong wanneer de bot tegen een blok blijft hangen.
 *
 * mineflayer-pathfinder beslist niet op het pad maar per tick of hij mag springen, en dat doet
 * hij door de sprong eerst te SIMULEREN (lib/physics.js: canStraightLine / canSprintJump /
 * canWalkJump). Die simulatie krijgt 20 ticks de tijd en eist dat de bot het volgende punt tot
 * op 0,35 blok nadert. Staat de bot al plat tegen het blok aan, dan is zijn snelheid nul — de
 * botsing heeft vx/vz op nul gezet — en in de lucht versnelt hij alleen nog met
 * airborneAcceleration. De simulatie haalt het dan nét niet, alle drie de checks geven false,
 * en dan komt index.js in de laatste tak terecht:
 *
 *     bot.setControlState('forward', false)   <-- de bot blijft stokstijf tegen het blok staan
 *
 * Elke 3,5 seconde geeft de pathfinder zichzelf een resetPath('stuck'), berekent exact hetzelfde
 * pad, en loopt weer klem. Precies het beeld van "hij loopt netjes naar het obstakel en doet daar
 * niets meer", terwijl hetzelfde blok mét aanloop wél gewoon genomen wordt.
 *
 * Deze watcher kijkt puur naar het resultaat: staat de bot stil terwijl hij een pad volgt, en
 * ligt er een blok voor hem waar hij bovenop past? Dan drukt hij zelf 'forward' + 'jump' in.
 *
 * Twee dingen zijn daarbij essentieel:
 *   1. Onze handler moet ná die van de pathfinder draaien, anders zet die 'forward' in dezelfde
 *      tick weer uit. Daarom wordt de listener pas bij de eerste spawn geregistreerd: de plugins
 *      zijn dan al geïnjecteerd (dat gebeurt op 'inject_allowed', vlak na createBot), dus staan
 *      wij achteraan in de rij.
 *   2. De sprong wordt een vast aantal ms vastgehouden. Laten we los zodra de bot beweegt, dan
 *      zet de pathfinder 'forward' meteen weer uit en valt hij halverwege de sprongboog terug.
 */

const botState = require('../state');
const { Logger } = require('../utils');

const STILL_EPSILON = 0.05;  // minder dan dit verplaatst tussen twee metingen = stilstaan
const STUCK_MS = 600;        // zo lang stilstaan tijdens het lopen = vastgelopen
const BOOST_MS = 700;        // forward+jump vasthouden: net iets langer dan een hele sprongboog
const COOLDOWN_MS = 400;     // pauze na een poging; jump moet los, zie release()
const MAX_ATTEMPTS = 5;      // daarna een lange pauze i.p.v. eindeloos staan stuiteren
const GIVEUP_MS = 5000;

function isPassable(block) {
  return !!block && block.boundingBox === 'empty';
}

/**
 * Ligt er in de looprichting een blok waar de bot bovenop zou passen?
 *
 * De pathfinder draait de bot elke tick naar het volgende punt van het pad, dus de kijkrichting
 * is ook de looprichting. Zonder deze check zou de bot ook gaan stuiteren tegen een muur van
 * twee hoog of tegen een dichte deur, waar springen niets oplost.
 */
function jumpableAhead(bot) {
  const yaw = bot.entity.yaw;
  const dx = Math.round(-Math.sin(yaw));
  const dz = Math.round(-Math.cos(yaw));
  if (dx === 0 && dz === 0) return null;

  const feet = bot.entity.position.floored();

  // Ruimte boven de bot zelf: zonder dat blok lucht komt hij niet eens omhoog.
  if (!isPassable(bot.blockAt(feet.offset(0, 2, 0)))) return null;

  // Bij een schuine kijkrichting rondt het bovenstaande af op een diagonaal. Dan tellen de twee
  // losse richtingen ook mee, want daar kan de bot net zo goed tegenaan staan.
  const dirs = [{ x: dx, z: dz }];
  if (dx !== 0 && dz !== 0) dirs.push({ x: dx, z: 0 }, { x: 0, z: dz });

  for (const dir of dirs) {
    const base = feet.offset(dir.x, 0, dir.z);
    const block = bot.blockAt(base);
    // Alleen boundingBox 'block': op een hek of een muur kan de bot toch niet landen.
    if (!block || block.boundingBox !== 'block') continue;
    if (!isPassable(bot.blockAt(base.offset(0, 1, 0)))) continue;
    if (!isPassable(bot.blockAt(base.offset(0, 2, 0)))) continue;
    return block;
  }
  return null;
}

function startJumpWatcher(bot) {
  let lastPos = null;      // waar de bot stond toen hij voor het laatst echt bewoog
  let stillSince = 0;
  let boostUntil = 0;      // 0 = er loopt geen sprong
  let boostFrom = null;
  let cooldownUntil = 0;
  let attempts = 0;

  function forget() {
    lastPos = null;
    stillSince = 0;
    attempts = 0;
  }

  function release() {
    // jump moet expliciet los: prismarine-physics zet de sprongcooldown (jumpTicks) alleen
    // terug op nul in een tick waarin jump NIET ingedrukt staat. Blijft hij staan, dan kan de
    // bot maar één keer per 10 ticks springen.
    bot.setControlState('jump', false);
    // 'forward' laten we aan de pathfinder: die zet hem de volgende tick toch weer zoals hij
    // hem hebben wil. Alleen als er géén pad meer loopt moeten wij hem zelf uitzetten, anders
    // rent de bot door nadat zijn doel al bereikt is.
    if (!bot.pathfinder?.isMoving()) bot.setControlState('forward', false);
    boostUntil = 0;
    boostFrom = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  function tick() {
    if (!bot.entity) return;
    const now = Date.now();
    const pos = bot.entity.position;

    if (boostUntil) {
      // Een sprong loopt. Geslaagd = weer op de grond, maar een blok hoger.
      const climbed = bot.entity.onGround && boostFrom && pos.y - boostFrom.y >= 0.9;
      if (climbed || now >= boostUntil || !bot.pathfinder?.isMoving()) {
        release();
        if (climbed) forget();
        return;
      }
      bot.setControlState('forward', true);
      bot.setControlState('jump', true);
      return;
    }

    // Alleen tijdens het volgen van een pad. Staat de pathfinder te graven of te bouwen, dan
    // staat de bot expres stil en zou vooruit duwen zijn werk verstoren.
    if (!bot.pathfinder?.isMoving() || bot.pathfinder.isMining() || bot.pathfinder.isBuilding() || botState.isDrowning) {
      forget();
      return;
    }
    if (now < cooldownUntil) return;
    if (!bot.entity.onGround || bot.entity.isInWater) {
      lastPos = null;
      stillSince = 0;
      return;
    }

    if (!lastPos) {
      lastPos = pos.clone();
      stillSince = now;
      return;
    }
    if (Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z) > STILL_EPSILON) {
      lastPos = pos.clone();
      stillSince = now;
      attempts = 0;
      return;
    }
    if (now - stillSince < STUCK_MS) return;

    const block = jumpableAhead(bot);
    if (!block) {
      // Vastgelopen op iets waar springen niet tegen helpt (muur, mob, onbereikbaar doel).
      // Klok opnieuw starten, anders lopen we elke tick de blokken rondom de bot af.
      stillSince = now;
      return;
    }

    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      Logger.warn(`Kom niet over ${block.name} op ${block.position.x} ${block.position.y} ${block.position.z}, even pauze`);
      attempts = 0;
      stillSince = now;
      cooldownUntil = now + GIVEUP_MS;
      return;
    }

    Logger.debug(`Vastgelopen tegen ${block.name}, extra sprong (poging ${attempts})`);
    boostFrom = pos.clone();
    boostUntil = now + BOOST_MS;
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
  }

  // Pas bij de eerste spawn aanhaken, zodat onze handler ná die van de pathfinder draait.
  bot.once('spawn', () => {
    bot.on('physicsTick', tick);
    Logger.info('Sprong-watcher actief (helpt de bot over blokken waar hij tegenaan loopt)');
  });
}

module.exports = { startJumpWatcher };

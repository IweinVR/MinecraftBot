/**
 * Extra sprong wanneer de bot tegen een blok blijft hangen.
 *
 * mineflayer-pathfinder beslist niet op het pad maar per tick of hij mag springen, en dat doet
 * hij door de sprong eerst te SIMULEREN (lib/physics.js: canStraightLine / canSprintJump /
 * canWalkJump). Die simulatie krijgt 20 ticks de tijd en eist dat de bot het volgende punt tot
 * op 0,35 blok nadert, dus tot bijna precies het midden van het blok. Staat de bot al plat tegen
 * het blok aan, dan is zijn snelheid nul (de botsing heeft vx/vz weggepoetst) en versnelt hij in
 * de lucht alleen nog met airborneAcceleration. Hij komt in die simulatie wel boven op het blok,
 * maar niet ver genoeg naar binnen, en dus geven alle drie de checks false. Daarna zet index.js
 * in zijn laatste tak zelfs forward uit: de bot blijft stokstijf staan, geeft zichzelf elke
 * 3,5 seconde een resetPath, en rekent exact hetzelfde pad opnieuw uit.
 *
 * Een trap lukt wel, want daar is elke stap maar een halve blok hoog: daar stapt de bot gewoon
 * overheen (stepHeight 0,6) zonder dat er iets gesprongen hoeft te worden.
 *
 * Deze watcher kijkt puur naar het resultaat: komt de bot niet vooruit terwijl hij ergens heen
 * wil, en ligt er een blok voor hem waar hij bovenop past? Dan neemt hij het even over.
 *
 * Vier dingen die nodig bleken:
 *   1. Meten of hij VOORUIT komt, niet of hij stilstaat. Tussen twee padberekeningen door staat
 *      de bot te schuifelen tegen het blok, en dat zijn steeds nieuwe kleine beweginkjes: een
 *      "staat hij stil"-check gaat daardoor nooit af.
 *   2. Aanloop nemen. Vanuit stilstand tegen het blok aan springen helpt niet: de botsing zet de
 *      horizontale snelheid elke tick op nul zolang hij lager staat dan de bovenkant, dus komt
 *      hij boven het blok aan zonder vaart. Daarom eerst een halve stap achteruit, dan pas
 *      vooruit + sprong. Dat is precies het "met aanloop lukt het wel" uit de praktijk.
 *   3. Zo gewoon mogelijk springen: de spronktoets kort indrukken en verder alleen vooruit.
 *      Sprint erbij gaf een lunge van 0,2 blok op het moment van afzetten die de server niet
 *      per se meerekent, en jump vasthouden laat de bot bij elke landing meteen opnieuw
 *      springen. Allebei leverden een bot op die stuiterde of in de lucht bleef hangen in
 *      plaats van netjes boven op het blok te eindigen.
 *   4. Na de pathfinder draaien, anders zet die forward in dezelfde tick weer uit. Daarom wordt
 *      de listener pas bij de eerste spawn geregistreerd: de plugins zijn dan al geinjecteerd
 *      (dat gebeurt op inject_allowed, vlak na createBot), dus staan wij achteraan in de rij.
 *
 * Blijft hij ondanks dat alles in de lucht hangen (niet op de grond, en toch niet vallen), dan
 * is dat geen sprong meer maar een desync tussen bot en server. Dan laat de watcher alles los in
 * plaats van door te duwen, en zet hij het in de log.
 */

const botState = require('../state');
const { Logger } = require('../utils');

const PROGRESS_EPSILON = 0.8;   // zoveel moet hij opschuiven om als "vooruit" te tellen
const STUCK_MS = 1000;          // blijft hij binnen die straal hangen, dan zit hij vast
const BACK_MS = 220;            // zo lang achteruit voor de aanloop
const JUMP_MS = 800;            // zo lang blijft hij vooruit duwen tijdens de sprong
const JUMP_PULSE_MS = 200;      // maar de spronktoets zelf maar zo lang, net als een speler
const HOVER_MS = 1200;          // niet op de grond en toch niet vallen = desync, niet duwen
const COOLDOWN_MS = 500;        // pauze na een poging; jump moet los, zie release()
const MAX_ATTEMPTS = 5;         // daarna een lange pauze i.p.v. eindeloos staan stuiteren
const GIVEUP_MS = 5000;

// Blokken waar de bot niet op mag landen. Akkerland wordt vertrapt tot gewone aarde zodra er
// iets op valt, en een schildpadei gaat kapot. Precies daarom zetten farming.js en de andere
// taken allowParkour op false; deze lijst is het vangnet voor de gevallen waarin er wel met
// springen gelopen mag worden, zoals een !goto dwars over een akker.
const NO_LANDING = new Set(['farmland', 'turtle_egg']);

function isPassable(block) {
  return !!block && block.boundingBox === 'empty';
}

/** Kijkrichting als hele blokken. De pathfinder draait de bot elke tick naar het volgende punt. */
function facing(bot) {
  const yaw = bot.entity.yaw;
  const dx = Math.round(-Math.sin(yaw));
  const dz = Math.round(-Math.cos(yaw));
  if (dx === 0 && dz === 0) return [];

  // Bij een schuine kijkrichting rondt dit af op een diagonaal; dan tellen de twee losse
  // richtingen ook mee, want daar kan de bot net zo goed tegenaan staan.
  const dirs = [{ x: dx, z: dz }];
  if (dx !== 0 && dz !== 0) dirs.push({ x: dx, z: 0 }, { x: 0, z: dz });
  return dirs;
}

/**
 * Ligt er in de looprichting een blok waar de bot bovenop zou passen?
 *
 * Zonder deze check zou de bot ook gaan stuiteren tegen een muur van twee hoog of tegen een
 * dichte deur, waar springen niets oplost.
 */
function jumpableAhead(bot) {
  const feet = bot.entity.position.floored();

  // Ruimte boven de bot zelf: zonder dat blok lucht komt hij niet eens omhoog.
  if (!isPassable(bot.blockAt(feet.offset(0, 2, 0)))) return null;

  for (const dir of facing(bot)) {
    const base = feet.offset(dir.x, 0, dir.z);
    const block = bot.blockAt(base);
    // Alleen boundingBox 'block': op een hek of een muur kan de bot toch niet landen.
    if (!block || block.boundingBox !== 'block') continue;
    if (NO_LANDING.has(block.name)) continue;
    if (!isPassable(bot.blockAt(base.offset(0, 1, 0)))) continue;
    if (!isPassable(bot.blockAt(base.offset(0, 2, 0)))) continue;
    return block;
  }
  return null;
}

/**
 * Kan de bot veilig een stapje achteruit voor zijn aanloop?
 *
 * Blind achteruit lopen is hoe een bot in een ravijn of in de lava eindigt, dus: achter hem moet
 * ruimte zijn en er moet vaste grond onder die ruimte liggen.
 */
function canBackUp(bot) {
  const dirs = facing(bot);
  if (dirs.length === 0) return false;

  const achter = bot.entity.position.floored().offset(-dirs[0].x, 0, -dirs[0].z);
  if (!isPassable(bot.blockAt(achter))) return false;
  if (!isPassable(bot.blockAt(achter.offset(0, 1, 0)))) return false;

  const grond = bot.blockAt(achter.offset(0, -1, 0));
  return !!grond && grond.boundingBox === 'block';
}

/**
 * Wil de bot ergens heen?
 *
 * isMoving() alleen is te weinig: tussen twee berekeningen door is het pad even leeg (de
 * pathfinder gooit het na 3,5 seconde zonder vooruitgang weg en rekent opnieuw), en juist in
 * die seconden staat hij tegen het blok. Een doel dat al bereikt is telt niet mee, anders gaat
 * de bot staan stuiteren terwijl hij met !follow netjes naast een stilstaande speler wacht.
 */
function wantsToMove(bot) {
  if (!bot.pathfinder) return false;
  if (bot.pathfinder.isMoving()) return true;

  const goal = bot.pathfinder.goal;
  if (!goal) return false;
  try {
    return !goal.isEnd(bot.entity.position.floored());
  } catch (err) {
    return false;
  }
}

function startJumpWatcher(bot) {
  let anchor = null;        // laatste plek waar hij echt vooruitkwam
  let anchorAt = 0;
  let phase = null;         // null | back | jump
  let phaseUntil = 0;
  let jumpUntil = 0;        // tot wanneer de spronktoets ingedrukt blijft
  let jumpFrom = null;
  let cooldownUntil = 0;
  let attempts = 0;
  let hoverSince = 0;

  function forget() {
    anchor = null;
    anchorAt = 0;
    attempts = 0;
  }

  function release() {
    // jump moet expliciet los: prismarine-physics zet de sprongcooldown (jumpTicks) alleen
    // terug op nul in een tick waarin jump NIET ingedrukt staat.
    bot.setControlState('jump', false);
    bot.setControlState('back', false);
    // forward laten we aan de pathfinder: die zet hem de volgende tick toch weer zoals hij hem
    // hebben wil. Alleen als er geen pad meer loopt moeten wij hem zelf uitzetten, anders rent
    // de bot door nadat zijn doel al bereikt is.
    if (!bot.pathfinder?.isMoving()) bot.setControlState('forward', false);
    phase = null;
    phaseUntil = 0;
    jumpUntil = 0;
    jumpFrom = null;
    anchor = null;          // na een poging opnieuw meten
    anchorAt = 0;
    cooldownUntil = Date.now() + COOLDOWN_MS;
  }

  function startJumpPhase(now) {
    phase = 'jump';
    phaseUntil = now + JUMP_MS;
    jumpUntil = now + JUMP_PULSE_MS;
    jumpFrom = bot.entity.position.clone();
  }

  /**
   * Blijft de bot in de lucht hangen?
   *
   * Dat is geen sprong meer maar een desync: mineflayer denkt dat er iets onder hem zit
   * (of de server denkt van niet). Niet omhoog, niet omlaag, en niet op de grond. Doorgaan met
   * vooruit duwen maakt het alleen maar erger, dus: alles loslaten en hem laten vallen.
   */
  function hangtInDeLucht(now) {
    const vy = bot.entity.velocity.y;
    if (bot.entity.onGround || bot.entity.isInWater || Math.abs(vy) > 0.02) {
      hoverSince = 0;
      return false;
    }
    if (!hoverSince) {
      hoverSince = now;
      return false;
    }
    return now - hoverSince >= HOVER_MS;
  }

  function tick() {
    if (!bot.entity) return;
    const now = Date.now();
    const pos = bot.entity.position;

    if (hangtInDeLucht(now)) {
      Logger.warn(`Blijft in de lucht hangen op ${pos.x.toFixed(1)} ${pos.y.toFixed(2)} ${pos.z.toFixed(1)}, controls los`);
      hoverSince = 0;
      bot.setControlState('jump', false);
      bot.setControlState('back', false);
      bot.setControlState('forward', false);
      phase = null;
      phaseUntil = 0;
      jumpUntil = 0;
      cooldownUntil = now + COOLDOWN_MS;
      return;
    }

    if (phase === 'back') {
      if (now >= phaseUntil) {
        bot.setControlState('back', false);
        startJumpPhase(now);
        return;
      }
      // forward expliciet uit: vooruit en achteruit tegelijk heffen elkaar op.
      bot.setControlState('forward', false);
      bot.setControlState('back', true);
      bot.setControlState('jump', false);
      return;
    }

    if (phase === 'jump') {
      // Geslaagd = weer op de grond, maar een blok hoger.
      const climbed = bot.entity.onGround && jumpFrom && pos.y - jumpFrom.y >= 0.9;
      if (climbed || now >= phaseUntil || !wantsToMove(bot)) {
        if (jumpFrom) {
          const gewonnen = (pos.y - jumpFrom.y).toFixed(2);
          Logger.debug(`Sprong klaar: ${gewonnen} blok hoogte, onGround=${bot.entity.onGround}`);
        }
        if (climbed) attempts = 0;
        release();
        return;
      }
      // De spronktoets maar kort indrukken, net als een speler. Blijft hij ingedrukt, dan
      // springt de bot bij het landen meteen opnieuw en komt hij nooit tot stilstand op het
      // blok waar hij net op geklommen is.
      bot.setControlState('jump', now < jumpUntil);
      bot.setControlState('back', false);
      bot.setControlState('forward', true);
      return;
    }

    // Alleen als hij ergens heen wil. Staat de pathfinder te graven of te bouwen, dan staat de
    // bot expres stil en zou vooruit duwen zijn werk verstoren.
    if (!wantsToMove(bot) || bot.pathfinder.isMining() || bot.pathfinder.isBuilding() || botState.isDrowning) {
      forget();
      return;
    }

    // Zet de lopende taak allowParkour uit, dan is dat een bewuste keuze (farmen, fokken,
    // sorteren: landen na een sprong vertrapt akkerland). Die overrulen we niet.
    if (bot.pathfinder.movements?.allowParkour === false) {
      forget();
      return;
    }

    if (now < cooldownUntil) return;
    if (!bot.entity.onGround || bot.entity.isInWater) {
      anchor = null;
      anchorAt = 0;
      return;
    }

    if (!anchor) {
      anchor = pos.clone();
      anchorAt = now;
      return;
    }

    // Vooruitgang meten t.o.v. het ankerpunt, niet t.o.v. de vorige tick: tegen een blok aan
    // staat de bot te schuifelen, en dat zijn steeds nieuwe kleine beweginkjes die een
    // "staat hij stil"-check onbedoeld blijven resetten.
    const opgeschoven = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);
    if (opgeschoven > PROGRESS_EPSILON || Math.abs(pos.y - anchor.y) > 0.9) {
      anchor = pos.clone();
      anchorAt = now;
      attempts = 0;
      return;
    }
    if (now - anchorAt < STUCK_MS) return;

    const block = jumpableAhead(bot);
    if (!block) {
      // Vastgelopen op iets waar springen niet tegen helpt (muur, mob, onbereikbaar doel).
      // Klok opnieuw starten, anders lopen we elke tick de blokken rondom de bot af.
      anchorAt = now;
      return;
    }

    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      Logger.warn(`Kom niet over ${block.name} op ${block.position.x} ${block.position.y} ${block.position.z}, even pauze`);
      attempts = 0;
      anchorAt = now;
      cooldownUntil = now + GIVEUP_MS;
      return;
    }

    Logger.info(`Vastgelopen tegen ${block.name} op ${block.position.x} ${block.position.y} ${block.position.z}, sprong ${attempts}/${MAX_ATTEMPTS} (bot staat op y=${pos.y.toFixed(2)})`);

    // Eerste poging meteen springen (soms staat hij nog net ver genoeg af), daarna met aanloop.
    if (attempts === 1 || !canBackUp(bot)) {
      startJumpPhase(now);
    } else {
      phase = 'back';
      phaseUntil = now + BACK_MS;
    }
  }

  // Pas bij de eerste spawn aanhaken, zodat onze handler na die van de pathfinder draait.
  bot.once('spawn', () => {
    bot.on('physicsTick', tick);
    Logger.info('Sprong-watcher actief (helpt de bot over blokken waar hij tegenaan loopt)');
  });
}

module.exports = { startJumpWatcher };

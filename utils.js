/**
 * Gedeelde helpers. Wat hier staat is meestal een omweg om een valkuil van mineflayer heen;
 * de reden staat telkens bij de functie zelf. De belangrijkste drie:
 *
 *   matchesKind()         Minecraft-itemnamen zijn <materiaal>_<soort>. Een kale substring-
 *                         match op 'chest' pakt dus ook elke chestplate, en 'torch' pakt
 *                         torchflower. Matchen gaat daarom altijd op achtervoegsel.
 *
 *   setMovements()        de enige plek waar Movements gemaakt wordt. Let op: canPlace wordt
 *                         door pathfinder 2.4.5 nergens gelezen — scaffolding leegmaken is
 *                         wél wat werkt.
 *
 *   enforceNoBlockPlacing() eenmalig bij de eerste spawn: onderschept setMovements zodat de
 *                         regel ook geldt voor Movements die plugins zelf neerzetten.
 *
 * Verder: findItem (op soort) vs findItemExact (op naam) — die twee verwisselen is een
 * klassieke bron van bugs hier.
 */

const { Movements } = require('mineflayer-pathfinder');
const { CONFIG, KEEP_ITEMS, FOOD_ITEMS } = require('./config');
const botState = require('./state');

const Logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toLocaleTimeString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toLocaleTimeString()} - ${msg}`),
  error: (msg, err) => console.error(`[ERROR] ${new Date().toLocaleTimeString()} - ${msg}`, err ? `\n${err}` : ''),
  debug: (msg) => console.log(`[DEBUG] ${new Date().toLocaleTimeString()} - ${msg}`),
};

function setMovements(bot, {
  canDig = false,
  canPlace = false,
  allowSprinting = false,
  allowParkour = true,
  // Blokken die de pathfinder sowieso nooit mag slopen, ook niet als canDig ooit aan staat.
  // Gebruikt door het boeren om de akker heel te houden.
  protectBlocks = null,
} = {}) {
  const movements = new Movements(bot);
  movements.canDig = canDig;
  movements.canPlace = canPlace; // wordt door deze pathfinder-versie zelf niet gebruikt, zie hieronder
  movements.allowSprinting = allowSprinting;
  movements.allowParkour = allowParkour;
  // Springen zet de bot hard neer, en dat vertrapt akkerland tot gewone aarde.
  movements.allow1by1towers = allowParkour;

  if (protectBlocks) {
    for (const name of protectBlocks) {
      const id = bot.registry.blocksByName[name]?.id;
      if (id !== undefined) movements.blocksCantBreak.add(id);
    }
  }
  // mineflayer-pathfinder zet dit standaard op false ("causes issues... non-paper servers"),
  // maar zonder dit blijft de bot voor elke dichte deur staan. Aternos draait meestal vanilla/Paper,
  // dus dit zetten we aan; mocht dit op deze server problemen geven, dan is dit de plek om terug te zetten.
  movements.canOpenDoors = true;

  // Deuren zichtbaar maken als doorgang.
  //
  // mineflayer-pathfinder bepaalt "kan ik hier doorheen" met block.boundingBox, en dat is een
  // eigenschap van het BLOKTYPE en niet van de stand (prismarine-block: boundingBox komt uit
  // blocks.json, alleen `shapes` verschilt per state). Een deur is dus altijd 'block' — ook als
  // hij wagenwijd openstaat. Daardoor zag de pathfinder een deuropening als een dichte muur,
  // plande hij nooit een route naar binnen, en bleef de bot voor de open deur staan wachten.
  //
  // getBlock() haalt die classificatie uit precies twee lijsten: wat in `carpets` staat telt als
  // veilig om in te lopen, en wat in `fences` staat telt niet als vloer om op te gaan staan. Een
  // houten deur in allebei betekent: behandel hem als lucht. De echte vorm van het blok blijft
  // gewoon meetellen in de sprong- en loopsimulatie, dus een DICHTE deur houdt de bot nog steeds
  // tegen — alleen staat hij er dan vóór, en dat is precies waar watchers/doors.js hem binnen een
  // kwart seconde openklikt.
  //
  // IJzeren deuren blijven expres solide: die gaan niet met de hand open, dus een route erdoorheen
  // zou de bot alleen maar voor een dichte deur zetten.
  for (const block of bot.registry.blocksArray) {
    if (!block.name.endsWith('_door') || block.name === 'iron_door') continue;
    movements.carpets.add(block.id);
    movements.fences.add(block.id);
  }

  // BELANGRIJK: movements.canPlace wordt in mineflayer-pathfinder@2.4.5 nergens gelezen door het
  // A*-algoritme (dode config) — het plant gewoon altijd bruggen/scaffolding zodra er dirt of
  // cobblestone in de inventaris zit. De enige manier om plaatsen daadwerkelijk te blokkeren is
  // door de scaffolding-lijst zelf leeg te maken, zodat er simpelweg geen blok is om te plaatsen.
  movements.scafoldingBlocks = canPlace ? movements.scafoldingBlocks : [];

  Logger.debug(`setMovements: canDig=${canDig}, canPlace=${canPlace}, allowSprinting=${allowSprinting}, canOpenDoors=true`);
  bot.pathfinder.setMovements(movements);
}

function distanceToGround(bot, maxDistance = 32) {
  const pos = bot.entity.position.floored();
  for (let dy = 1; dy <= maxDistance; dy++) {
    const block = bot.blockAt(pos.offset(0, -dy, 0));
    if (block && block.boundingBox === 'block') return dy;
  }
  return Infinity;
}

function floorPos(pos) {
  return { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
}

/**
 * Matcht een itemnaam op itemSOORT in plaats van op een kale substring.
 *
 * Minecraft-itemnamen zijn opgebouwd als <materiaal>_<soort>, dus de soort staat achteraan.
 * Met includes() liep dat mis op namen die de soort toevallig ergens anders bevatten:
 *   'chest'  matchte leather_chestplate, chest_minecart, oak_chest_boat  -> de bot dacht
 *            dat hij een kist had terwijl hij alleen een borstplaat droeg
 *   'torch'  matchte torchflower en torchflower_seeds
 *   'axe'    matchte diamond_pickaxe
 * Een suffix-match lost alle drie op en houdt de bedoelde treffers overeind
 * (torch/soul_torch/copper_torch, bucket/water_bucket, wooden_hoe/copper_hoe, ...).
 */
function matchesKind(itemName, kind) {
  return itemName === kind || itemName.endsWith(`_${kind}`);
}

function findItem(bot, itemNames) {
  const names = Array.isArray(itemNames) ? itemNames : [itemNames];
  return bot.inventory.items().find(item => names.some(n => matchesKind(item.name, n)));
}

// findItem() matcht op soort, dus findItem(bot, 'bucket') levert net zo goed een
// water_bucket of lava_bucket op, en findItem(bot, 'chest') ook een ender_chest.
// Waar het om specifieke items gaat (de lege emmer na een MLG, of precies die kisten die de
// bot mag neerzetten) moet je exact matchen. Neemt een naam of een lijst namen.
function findItemExact(bot, itemNames) {
  const names = Array.isArray(itemNames) ? itemNames : [itemNames];
  return bot.inventory.items().find(item => names.includes(item.name));
}

function hasItem(bot, itemNames) {
  return bot.inventory.items().some(item =>
    (Array.isArray(itemNames) ? itemNames : [itemNames]).some(n => matchesKind(item.name, n))
  );
}

// Eten herkennen via de spel-data zelf i.p.v. via onze eigen lijst: die lijst veroudert bij
// elke versiewissel, registry.foodsByName niet. Scheelt ook vals-positieven — met de oude
// substring-match telde 'music_disc_lava_chicken' mee als voedsel.
function hasFood(bot) {
  const foods = bot.registry?.foodsByName;
  if (!foods) return hasItem(bot, FOOD_ITEMS);
  return bot.inventory.items().some(item => !!foods[item.name]);
}

function isItemToKeep(bot, itemName) {
  if (KEEP_ITEMS.some(kind => matchesKind(itemName, kind))) return true;
  // Alles wat het spel als voedsel kent houden we ook, ook als het niet in FOOD_ITEMS staat.
  return !!bot.registry?.foodsByName?.[itemName];
}

function findNearestBlock(bot, blockNames, searchRadius = CONFIG.search.bedSearchRadius) {
  const names = Array.isArray(blockNames) ? blockNames : [blockNames];

  const blockIds = names
    .map(name => bot.registry.blocksByName[name]?.id)
    .filter(id => id !== undefined);

  if (blockIds.length === 0) return null;

  const block = bot.findBlock({
    matching: blockIds,
    maxDistance: searchRadius
  });

  return block ? block.position : null;
}

function findNearestEntity(bot, filter, searchRadius = Infinity) {
  const botPos = bot.entity.position;
  let nearest = null;
  let nearestDistance = Infinity;

  for (const entity of Object.values(bot.entities)) {
    // Entities zonder positie (of de bot zelf) moeten we overslaan, anders klapt distanceTo eruit.
    if (!entity || !entity.position || entity === bot.entity) continue;

    let matches = false;
    try {
      matches = filter(entity);
    } catch (err) {
      // Een filter dat op entity.name matcht valt om bij entities zonder naam; die slaan we over.
      continue;
    }
    if (!matches) continue;

    const distance = botPos.distanceTo(entity.position);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = entity;
    }
  }

  return nearest && nearestDistance <= searchRadius ? nearest : null;
}

// De placeBlock-guard in Index.js blokkeert standaard élke plaatsing zolang canPlace=false.
// Dit is de enige nette manier om daar kort omheen te gaan, voor plaatsingen die de bot
// expliciet wél hoort te doen (zaad terugplanten). De teller gaat in een finally weer omlaag,
// zodat een fout de deur niet open laat staan.
async function placeBlockAllowed(bot, referenceBlock, faceVector) {
  botState.allowPlacement++;
  try {
    return await bot.placeBlock(referenceBlock, faceVector);
  } finally {
    botState.allowPlacement--;
  }
}

/**
 * Zet de pathfinder definitief op slot wat betreft blokken plaatsen.
 *
 * Het leegmaken van scafoldingBlocks in setMovements() was niet genoeg: mineflayer-pvp en
 * mineflayer-collectblock zetten tijdens hun eigen acties een VERS Movements-object op de
 * pathfinder (PVP.js:71, CollectBlock.js:195), compleet met dirt en cobblestone als
 * scaffolding. Daarna bouwde de bot alsnog bruggetjes die hij nooit opruimde.
 *
 * Door setMovements zelf te onderscheppen geldt de regel voor élke aanroep, van wie dan ook:
 * de pathfinder plaatst nooit blokken. Onze eigen, bewuste plaatsingen (fakkel, kist, zaad)
 * lopen niet via de pathfinder maar via placeBlockAllowed() en blijven dus gewoon werken.
 */
function enforceNoBlockPlacing(bot) {
  if (!bot.pathfinder || bot.pathfinder._placingLocked) return;
  const original = bot.pathfinder.setMovements;
  bot.pathfinder.setMovements = function (movements) {
    if (movements && Array.isArray(movements.scafoldingBlocks) && movements.scafoldingBlocks.length > 0) {
      Logger.debug(`Scaffolding uit movements gehaald (${movements.scafoldingBlocks.length} blokken)`);
      movements.scafoldingBlocks = [];
    }
    return original.call(this, movements);
  };
  bot.pathfinder._placingLocked = true;
  Logger.info('Pathfinder mag geen blokken plaatsen (scaffolding centraal uitgeschakeld)');
}

/**
 * Wacht op een promise, maar breek meteen af zodra shouldStop() waar wordt.
 * Zonder dit bleef !stop hangen tot een lopende dig of goto uit zichzelf klaar was —
 * en dat kan seconden tot een kwartier duren.
 */
async function abortable(promise, shouldStop, onAbort, pollMs = 100) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setInterval(() => {
          if (!shouldStop()) return;
          clearInterval(timer);
          try { onAbort?.(); } catch (err) { Logger.debug(`Afbreken gaf fout: ${err.message}`); }
          reject(new Error('Afgebroken door gebruiker'));
        }, pollMs);
      }),
    ]);
  } finally {
    clearInterval(timer);
  }
}

// Wacht op een promise, maar niet langer dan timeoutMs. Gebruikt voor pathfinder-acties die
// bij een onbereikbaar doel anders blijven hangen.
async function withTimeout(promise, timeoutMs, label = 'actie') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout na ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function getInventoryStatus(bot) {
  const status = [];
  if (!hasFood(bot)) status.push('geen voedsel');
  if (!hasItem(bot, 'torch')) status.push('geen fakkels');
  if (!hasItem(bot, 'water_bucket')) status.push('geen water bucket');

  return status.length > 0 ? ' ⚠️ ' + status.join(', ') : '';
}

function findNearbyBlocks(bot, blockNames, count = 10, searchRadius = CONFIG.search.bedSearchRadius) {
  const names = Array.isArray(blockNames) ? blockNames : [blockNames];

  const blockIds = names
    .map(name => bot.registry.blocksByName[name]?.id)
    .filter(id => id !== undefined);

  if (blockIds.length === 0) return [];

  const positions = bot.findBlocks({
    matching: blockIds,
    maxDistance: searchRadius,
    count
  });

  return positions.map(pos => bot.blockAt(pos)).filter(Boolean);
}

// De taken die volgens de (isX, stopX)-afspraak uit state.js werken.
const TASKS = [
  'Mining', 'Fighting', 'Farming', 'Breeding', 'Sorting',
  'Trading', 'Fishing', 'Fetching', 'Smithing', 'Singing', 'Giving',
];

/**
 * Alle lopende taken afbreken en hun state leegmaken.
 *
 * Het gaat hier vooral om de isX-vlaggen. Sterft de bot tijdens het boeren, dan blijft de
 * oogstlus hangen in een await die nooit meer afkomt — hij staat opeens bij zijn bed, zonder
 * inventaris, meters van de akker — en dus komt zijn finally-blok, waar isFarming normaal
 * uitgezet wordt, nooit aan de beurt. Daarna antwoordde de bot op elke !farm met "Ik ben al
 * aan het boeren!" terwijl hij niets deed, en hielp !stop ook niet: dat zette alleen stopFarming.
 *
 * De stopX-vlaggen gaan aan zodat zo'n achtergebleven lus, mocht hij alsnog verder komen,
 * meteen afbreekt in plaats van door te gaan alsof er niets gebeurd is.
 */
function abortAllTasks() {
  for (const task of TASKS) {
    botState[`is${task}`] = false;
    botState[`stop${task}`] = true;
  }
  botState.isFleeing = false;
  botState.isSuiciding = false;
  // Teller, geen boolean: een taak die halverwege een bewuste plaatsing afgebroken wordt,
  // laat hem anders boven nul achter en dan mag de pathfinder ineens blokken plaatsen.
  botState.allowPlacement = 0;
}

module.exports = {
  Logger,
  setMovements,
  abortAllTasks,
  distanceToGround,
  floorPos,
  findItem,
  findItemExact,
  matchesKind,
  hasItem,
  hasFood,
  isItemToKeep,
  findNearestBlock,
  findNearbyBlocks,
  findNearestEntity,
  getInventoryStatus,
  placeBlockAllowed,
  enforceNoBlockPlacing,
  abortable,
  withTimeout,
};

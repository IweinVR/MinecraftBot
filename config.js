/**
 * Alle instelbare getallen, lijsten en drempels van de bot, op één plek. Wie gedrag wil
 * bijstellen (hoe ver hij zoekt, hoeveel hij bewaart, hoe lang hij wacht) hoort dat hier te
 * kunnen doen zonder een feature-bestand aan te raken.
 *
 * De secties volgen de features: physics, search, health, combat, farming, breeding, sorting.
 */

// Let op: deze lijsten worden gematcht met matchesKind() uit utils.js, dus op itemSOORT:
// 'beef' dekt beef en cooked_beef, 'torch' dekt torch/soul_torch/copper_torch — maar
// NIET torchflower. Eerder werd hier een kale includes() op losgelaten, en die matchte
// torchflower_seeds als "fakkel" en elke chestplate als "kist".
//
// FOOD_ITEMS wordt alleen nog gebruikt om eten te bewaren; of de bot eten HEEFT wordt
// gecontroleerd tegen registry.foodsByName (zie hasFood in utils.js), want die lijst komt
// uit de spel-data zelf en veroudert dus niet bij een versiewissel.
const FOOD_ITEMS = [
  'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
  'cooked_cod', 'cooked_salmon', 'cooked_rabbit',
  'baked_potato', 'bread', 'apple', 'golden_apple',
  // De rauwe varianten heten in moderne versies gewoon beef/porkchop/mutton/chicken
  // (niet raw_beef enz.), anders matchte hasItem() ze nooit.
  'beef', 'porkchop', 'mutton', 'chicken',
  'carrot', 'potato', 'melon_slice', 'pumpkin_pie'
];

const KEEP_ITEMS = [
  'torch', 'pickaxe', 'axe', 'shovel', 'hoe', 'sword',
  'water_bucket', 'bucket',
  // Kisten moeten we houden, anders dumpt de bot z'n eigen kisten in de kist en kan hij
  // de volgende keer dat z'n inventaris vol zit niets meer plaatsen.
  'chest',
  // Uitrusting. Dit stond er niet in: alleen chestplates bleven per ongeluk gespaard doordat
  // 'chest' een substring is van 'chestplate'. Helmen, broeken en schoenen werden dus
  // doodleuk in de kist gedumpt — en met de strengere matcher zou de chestplate dat ook zijn.
  'helmet', 'chestplate', 'leggings', 'boots', 'shield', 'elytra',
  ...FOOD_ITEMS
];

const DIRECTIONS = {
  north: { x: 0, z: -1 },
  south: { x: 0, z: 1 },
  east: { x: 1, z: 0 },
  west: { x: -1, z: 0 },
};

const SIDE_DIRECTIONS = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
];

const HOSTILE_MOBS = ['zombie', 'skeleton', 'spider', 'enderman', 'husk', 'drowned', 'wither_skeleton'];

// Waar de bot NIET tegen terugvecht als hij aangevallen wordt, hoe hard hij ook geraakt wordt.
// Een creeper ontploft juist in zijn gezicht zodra hij ernaartoe loopt, ghasts en phantoms
// vliegen en zijn met een zwaard toch niet te raken, tegen deze bazen verliest hij sowieso,
// en een iron golem hoort bij het dorp — die sla je niet terug.
const NO_FIGHT_MOBS = ['creeper', 'ghast', 'phantom', 'warden', 'wither', 'ender_dragon', 'elder_guardian', 'iron_golem'];

// Alle kistvarianten waar de bot z'n buit in kwijt kan. findNearestBlock() zocht alleen op
// 'chest' en liep dus langs de koperen kisten heen.
const CHEST_BLOCKS = [
  'chest', 'trapped_chest',
  'copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest',
  'waxed_copper_chest', 'waxed_exposed_copper_chest', 'waxed_weathered_copper_chest',
  'waxed_oxidized_copper_chest',
];

const CONFIG = {
  server: {
    host: 'localhost',
    port: 25565,
    auth: 'microsoft',
    // Mojang is overgestapt op jaar-gebaseerde versienummers: dit heet '26.1', niet '1.26.1'.
    // Zo staat het ook in minecraft-data en in mineflayers testedVersions (protocol 775).
    version: '26.1',
  },
  physics: {
    fallVelocity: -0.4,
    fallTicks: 20,
    bucketActivateDelay: 1500,
    inventoryFullThreshold: 1,
    torchPlaceInterval: 8,
  },
  pathfinding: {
    thinkTimeout: 20000,   // standaard 5000: te krap, gaf "Took to long to decide path"
    tickTimeout: 40,
    searchRadius: 256,     // begrenst A*, zodat onbereikbaar snel 'noPath' geeft
    followDistance: 2,
    reachDistance: 4,
    nearDistance: 2,
    fleeDistance: 15,
  },
  search: {
    bedSearchRadius: 64,
    deathSearchRadius: 128,
    damageDetectionRange: 32,
    monsterDetectionRange: 64,
  },
  health: {
    foodThreshold: 15,
    maxHealth: 20,
  },
  // Creeper-alarm: zie watchers/creeper.js. Terugvechten kan niet (ernaartoe lopen laat hem
  // juist ontploffen) en weglopen lukt maar half, dus roept de bot om hulp en logt hij uit.
  creeper: {
    range: 10,            // binnen zoveel blokken slaat hij alarm
    awayMs: 60000,        // zo lang blijft hij weg voordat hij opnieuw inlogt
    graceMs: 15000,       // na het inloggen zo lang geen nieuw alarm (anders een uitlog-lus)
    cooldownMs: 30000,    // en tussen twee alarmen zit minstens dit
    checkInterval: 250,
    chatGap: 400,         // pauze tussen de twee chatberichten, tegen spamfilters
  },
  combat: {
    fightTimeout: 120000,
    defendTimeout: 30000,      // hoe lang hij hooguit achter één monster aan blijft vechten
    defendMaxDistance: 16,     // vlucht het monster verder weg, dan laat hij het lopen
  },
  mining: {
    // In een brede/hoge gang valt niet elk blok binnen Minecrafts oprapradius van het looppad.
    // Na elke laag kort om zich heen kijken vangt die achterblijvers op.
    dropSweepRadius: 4,
    dropSweepTimeout: 4000,
    dropPickupDelay: 250,    // wachten tot de server het oprapen doorgeeft
  },
  farming: {
    scanRadius: 32,          // 2 chunks
    maxCropsPerScan: 256,
    pathCheckTimeout: 500,   // ms die A* per gewas mag denken
    reachDistance: 3.5,      // binnen deze afstand hoeft de bot niet te lopen
    approachRange: 2,        // hoe dicht de bot op het gewas gaat staan
    minToolDurability: 10,   // onder deze resterende duurzaamheid wordt gewisseld
    keepSeedCount: 64,       // 1 stack zaad blijft altijd in de inventaris
    minFreeSlots: 2,         // minder vrije slots = inventaris "vol"
    dropSweepRadius: 6,
    dropSweepInterval: 10,   // om de hoeveel oogsten drops oprapen
    dropSweepTimeout: 4000,
    dropPickupDelay: 250,    // wachten tot de server het oprapen doorgeeft
    finalSweepRadius: 32,    // slotronde: net zo groot als het scangebied
    finalSweepPasses: 3,     // en die ronde mag zichzelf zo vaak herhalen
    approachTimeout: 15000,
    deliverTimeout: 60000,
    maxRounds: 20,           // harde bovengrens op het aantal scan-rondes
  },
  breeding: {
    enabled: true,
    scanRadius: 24,          // dieren lopen rond; verder zoeken dan dit is zonde van de tijd
    pairRange: 8,            // twee dieren moeten binnen deze afstand van elkaar staan om te paren
    maxPairsPerSpecies: 4,   // hoogstens 8 dieren per soort per ronde voeren
    reachDistance: 3,        // vanilla interactie-afstand voor entities
    approachRange: 1,        // hoe dicht de pathfinder op het dier gaat staan
    approachAttempts: 3,     // een koe loopt weg tijdens het lopen; zo vaak opnieuw richten
    approachTimeout: 12000,
    pathCheckTimeout: 500,
    feedDelay: 350,          // pauze na het voeren, zodat de server het pakket verwerkt
    keepFoodCount: 0,        // hoeveel voer altijd achterblijft bovenop de zaadreserve
  },
  sorting: {
    inputRadius: 16,         // waar de bot de invoerkist zoekt
    storageRadius: 24,       // waar hij opslagkisten zoekt
    maxChests: 24,           // hoogstens zoveel kisten per ronde langs
    approachRange: 2,
    reachDistance: 4,        // binnen deze afstand kan hij de kist al openen
    pathCheckTimeout: 500,
    approachTimeout: 15000,
    openTimeout: 5000,       // een geblokkeerde kist stuurt nooit een windowOpen
    closeTimeout: 2000,
    settleDelay: 250,        // rust na het sluiten, tegen desyncs bij de volgende kist
    keepFood: 16,            // zoveel eten blijft altijd in de inventaris
    minFreeSlots: 1,         // stop met ophalen als er nog zoveel slots vrij zijn
  },
  trading: {
    chestRadius: 24,         // waar de voorraad- en kluiskist gezocht worden
    villagerRadius: 32,      // hoe ver rond de handelshal naar dorpelingen gekeken wordt
    maxVillagers: 12,        // hoogstens zoveel dorpelingen per ronde
    minStock: 16,            // minder gewassen dan dit -> de wandeling niet waard
    maxPerCall: 8,           // ruilen per bot.trade()-aanroep; klein houden scheelt desyncs
    tradeDelay: 200,         // rust tussen twee bot.trade()-aanroepen
    hallRange: 3,            // hoe dicht op het middelpunt van de hal hij gaat staan
    reachDistance: 3,        // vanilla interactie-afstand voor entities
    approachRange: 1,
    approachAttempts: 3,     // een dorpeling loopt weg; zo vaak opnieuw richten
    approachTimeout: 12000,
    travelTimeout: 60000,    // de handelshal kan ver weg staan
    pathCheckTimeout: 500,
    openTimeout: 5000,       // slapende dorpeling stuurt nooit een handelslijst
    closeTimeout: 2000,
    settleDelay: 250,
    minFreeSlots: 2,         // bot.trade() heeft vrije slots nodig voor de smaragden
  },
  fishing: {
    waterRadius: 32,         // hoe ver hij naar open water zoekt
    waterSamples: 200,       // hoeveel waterblokken hij bekijkt om een oever te vinden
    minCastDistance: 2,      // dichterbij mikken ketst de dobber op de kant
    maxCastDistance: 6,
    castTimeout: 40000,      // vanilla wachttijd is 5-30s; daarboven klopt er iets niet
    recastDelay: 600,
    pickupDelay: 700,        // de vis vliegt naar je toe; even wachten voor je de inventaris leest
    maxCasts: 200,
    maxFailuresInRow: 5,     // zoveel missers op rij -> de stek deugt niet
    minRodDurability: 5,     // hieronder wordt de hengel niet meer gebruikt
    minFreeSlots: 2,
    approachRange: 1,
    approachTimeout: 20000,
    pathCheckTimeout: 500,
    reachDistance: 4,
    closeTimeout: 2000,
    settleDelay: 250,
    deliverAfter: true,      // vangst na afloop in de invoerkist leggen
    sortAfter: true,         // en daarna meteen een sorteerronde draaien
  },
  courier: {
    chestRadius: 32,         // hoe ver rond de bot naar kisten gezocht wordt
    maxChests: 32,           // hoogstens zoveel kisten in de index
    maxAmount: 640,          // hoogstens 10 stapels per opdracht
    maxReported: 5,          // hoeveel kisten !waar in de chat noemt
    minFreeSlots: 1,
    approachRange: 2,
    reachDistance: 4,
    approachTimeout: 15000,
    deliverTimeout: 60000,   // de speler kan verderop staan
    pathCheckTimeout: 500,
    openTimeout: 5000,
    closeTimeout: 2000,
    settleDelay: 250,
  },
  toolsmith: {
    keepKinds: ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'],  // soorten die hij op voorraad houdt
    minDurability: 20,       // hieronder telt gereedschap niet meer als bruikbaar
    repairFirst: true,       // eerst samensmeden, dan pas nieuw maken
    maxDepth: 3,             // tool -> stokken -> planken -> stammen
    searchRadius: 24,        // waar hij de werkbank en het aambeeld zoekt
    reachDistance: 4,
    approachRange: 2,
    approachTimeout: 15000,
    pathCheckTimeout: 500,
    craftTimeout: 15000,     // bot.craft() wacht zelf eeuwig op windowOpen
    openTimeout: 5000,
    repairTimeout: 10000,    // anvil.combine() wacht op een experience-event
    closeTimeout: 2000,
    settleDelay: 250,
    autoResupply: true,      // tijdens boeren/minen zelf bijmaken i.p.v. stoppen
  },
};

module.exports = { CONFIG, FOOD_ITEMS, KEEP_ITEMS, CHEST_BLOCKS, DIRECTIONS, SIDE_DIRECTIONS, HOSTILE_MOBS, NO_FIGHT_MOBS };

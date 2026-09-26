/**
 * Gedeelde runtime-state: één enkel object dat alle modules importeren.
 *
 * Bewust geen class en geen kopieën — iedereen praat tegen hetzelfde object, zodat een
 * commando in features/commands.js een lus in features/mining.js kan afbreken zonder dat
 * die twee elkaar hoeven te kennen.
 *
 * Het terugkerende drieluik per taak is (isX, stopX, xSession):
 *   isX       draait de taak nu?           -> voorkomt dat hij dubbel start
 *   stopX     moet hij ermee ophouden?     -> de lus pollt hierop en breekt af
 *   xSession  welke run is de huidige?     -> een oude, nog draaiende run ziet dat hij
 *             achterhaald is en ruimt de state van de NIEUWE run niet meer op
 *
 * Alleen dat laatste is niet vanzelfsprekend: zonder sessienummer zet een oude lus in zijn
 * finally-blok isX weer op false, terwijl de nieuwe run net begonnen is.
 */

const botState = {
  isMining: false,
  stopMining: false,
  // Elke mineTunnel-run krijgt een eigen sessienummer. Zo kan een oude (nog draaiende) run
  // zien dat er intussen een nieuwe gestart is en zichzelf stilletjes afbreken i.p.v. de
  // state van de nieuwe run te overschrijven.
  miningSession: 0,
  fallingTicks: 0,
  bucketUsed: false,
  isEating: false,
  lastHealth: null,
  lastMineData: null,
  lastGoal: null,
  followToken: null,
  lastAttacker: null,
  // Hoe lang de volgende herverbinding mag wachten. Normaal null (dan geldt de standaard van
  // 5 seconden); het creeper-alarm zet hem op een minuut zodat de bot echt even weg is.
  reconnectDelay: null,
  isFleeing: false,
  isFighting: false,
  stopFighting: false,
  isDrowning: false,
  isSuiciding: false,
  isFarming: false,
  stopFarming: false,
  farmSession: 0,
  isBreeding: false,
  stopBreeding: false,
  breedSession: 0,
  isSorting: false,
  stopSorting: false,
  sortSession: 0,
  // Los van het sorteren: !leeg brengt alleen de eigen inventaris naar de invoerkist en
  // roept daarna sortItems() aan. Twee aparte vlaggen dus, anders zou die aanroep op zijn
  // eigen "ik ben al aan het sorteren" stuklopen.
  isDumping: false,
  stopDumping: false,
  dumpSession: 0,
  isTrading: false,
  stopTrading: false,
  tradeSession: 0,
  isSinging: false,
  stopSinging: false,
  isFishing: false,
  stopFishing: false,
  fishSession: 0,
  isFetching: false,
  stopFetching: false,
  fetchSession: 0,
  isGiving: false,
  stopGiving: false,
  giveSession: 0,
  isSmithing: false,
  stopSmithing: false,
  smithSession: 0,
  // Teller, geen boolean: de placeBlock-guard in Index.js blokkeert standaard alles zolang
  // canPlace=false, en dat moet ook zo blijven. Alleen code die bewust en kortstondig wél
  // mag plaatsen (het terugplanten van zaad) telt deze op en weer af.
  allowPlacement: 0,
  shouldRestore: true,
};

module.exports = botState;

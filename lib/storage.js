/**
 * Het geheugen van de opslag: welke kist bevat wat.
 *
 * Het sorteren loopt toch al langs elke kist en leest de inhoud uit. Dat werd tot nu toe
 * weggegooid zodra de ronde klaar was. Hier wordt het bewaard, zodat de koerier (!haal, !waar)
 * niet opnieuw de hele opslag hoeft af te lopen om te weten waar iets ligt.
 *
 * Bewust een kale datamodule zonder verwijzingen naar andere features: sorting.js schrijft
 * erin, courier.js leest eruit. Zou dit in sorting.js staan, dan zou courier.js sorting.js
 * moeten importeren en sorting.js weer courier.js — en dat draait rond.
 *
 * De index staat alleen in het geheugen en gaat bij een herstart verloren. Dat is geen
 * probleem: hij wordt vanzelf opnieuw opgebouwd (!index, of de eerste !sort), en de koerier
 * controleert bij aankomst toch of het er nog ligt. Een index die je van schijf leest is
 * juist gevaarlijker, want die is dan al dagen oud.
 */

const Vec3 = require('vec3');

/** @type {Map<string, {pos: Vec3, items: Map<string, number>, gezien: number}>} */
const index = new Map();

const sleutel = (pos) => `${pos.x},${pos.y},${pos.z}`;

/**
 * Legt vast wat er in deze kist ligt. Overschrijft wat we eerder van deze kist wisten —
 * de laatste waarneming is per definitie de juiste.
 *
 * @param {Vec3} pos
 * @param {Array<{name: string, count: number}>} items de inhoud zoals containerItems() hem geeft
 */
function record(pos, items) {
  const telling = new Map();
  for (const item of items) {
    telling.set(item.name, (telling.get(item.name) ?? 0) + item.count);
  }
  index.set(sleutel(pos), {
    pos: new Vec3(pos.x, pos.y, pos.z),
    items: telling,
    gezien: Date.now(),
  });
}

/** Deze kist bestaat niet meer (of ging niet open). Weg ermee, anders blijft hij terugkomen. */
function forget(pos) {
  index.delete(sleutel(pos));
}

function clear() {
  index.clear();
}

/**
 * Waar ligt dit item? Meeste eerst.
 * @returns {Array<{pos: Vec3, count: number, gezien: number}>}
 */
function lookup(itemName) {
  const treffers = [];
  for (const entry of index.values()) {
    const aantal = entry.items.get(itemName);
    if (aantal > 0) treffers.push({ pos: entry.pos, count: aantal, gezien: entry.gezien });
  }
  return treffers.sort((a, b) => b.count - a.count);
}

/** Alle itemnamen die ergens in de opslag liggen. Gebruikt om een zoekterm te verduidelijken. */
function knownItems() {
  const namen = new Set();
  for (const entry of index.values()) {
    for (const [naam, aantal] of entry.items) if (aantal > 0) namen.add(naam);
  }
  return namen;
}

/** Totaal aantal van dit item over alle kisten heen. */
function totalOf(itemName) {
  return lookup(itemName).reduce((som, t) => som + t.count, 0);
}

function stats() {
  let items = 0;
  for (const entry of index.values()) {
    for (const aantal of entry.items.values()) items += aantal;
  }
  return { kisten: index.size, items, soorten: knownItems().size };
}

function isEmpty() {
  return index.size === 0;
}

/** Alle bekende kistposities, voor een verversingsronde. */
function chestPositions() {
  return [...index.values()].map(e => e.pos);
}

module.exports = {
  record, forget, clear, lookup, knownItems, totalOf, stats, isEmpty, chestPositions,
};

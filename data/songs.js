/**
 * Liedjesboek voor de zing-reactie in chat.js. Puur data plus een kleine wrapper; hier zit
 * geen logica die je hoeft te begrijpen om de rest van de bot te volgen.
 */

class Song {
  constructor(name, lines) {
    this.name = name;
    this.lines = lines;
  }
}

class SongBook {
  constructor(songs = []) {
    this.songs = songs;
  }

  add(name, lines) {
    this.songs.push(new Song(name, lines));
    return this;
  }

  getRandom() {
    if (this.songs.length === 0) return null;
    return this.songs[Math.floor(Math.random() * this.songs.length)];
  }
}

const songBook = new SongBook();

songBook.add('I Got Bills', [
  'I got bills',
  'Woke up and I bumped my head',
  'Stumped my toe on the edge of the bed',
  "Opened the fridge and the food all gone",
  "Neighbor's damn dog done crapped on my lawn",
  "Hopped in the car and the car won't start",
  "It's too damn hot but I still gotta walk",
  'Behind an old lady in the grocery line',
  "Praying that my card won't get declined",
  'Ah damn, ah damn, ah damn, ah damn',
  'Oh man, oh man, oh man, oh man',
  'Ah damn, oh man, ah damn, oh man',
  'I got bills I gotta pay',
  "So I'm gon' work, work, work every day",
  'I got mouths I gotta feed',
  "So I'm gon' make sure everybody eats",
]);

songBook.add('Holding On', [
  'So you give me no reason',
  'For me to stay close to you',
  'Tell me what lovers do',
  "How are we still breathing?",
  "It's never for us to choose",
  "I'll be the strength in you",
  "Now I'm holdin' on (Now I'm holdin' on)",
  'Myself was never enough for me',
  'Gotta be so strong',
  "There's a power in what you do",
  "Now every other day, I'll be watching you",
  'Oh-ah, oh-ah',
]);

songBook.add('Stay', [
  'I took a pill in Ibiza',
  'To show Avicii I was cool',
  "And when I finally got sober, felt ten years older",
  "But fuck it, it was somethin' to do",
  "I'm livin' out in LA",
  'I drive a sports car just to prove',
  "I'm a real big baller 'cause I made a million dollars",
  'And I spend it on girls and shoes',
  "But you don't wanna be high like me",
  "Never really knowin' why like me",
  "You don't ever wanna step off that rollercoaster and be all alone",
  "You don't wanna ride the bus like this",
  "Never knowin' who to trust like this",
  "You don't wanna be stuck up on that stage singin'",
  "Stuck up on that stage singin'",
]);

songBook.add('Not Your Homie', [
  '"You here for long?" "Oh no, I\'m just passin\'"',
  '"Do you wanna drink?" "Nah, thanks for askin\'"',
  'Ooh, na-na, yeah',
  "Don't act like you know me, like you know me, na-na, yeah",
  'I am not your homie, not your ho—',
  'Ooh, na-na, yeah',
  "Don't act like you know me, like you know me, na-na, yeah",
  "You don't know me, fuck yeah",
  'Ooh, na-na, yeah',
  "Don't act like you know me, like you know me, na-na, yeah",
  'I am not your homie, not your ho—',
  'Ooh, na-na, yeah',
  "Don't act like you know me, like you know me, na-na, yeah",
  "You don't know me, fuck yeah",
]);

module.exports = { Song, SongBook, songBook };

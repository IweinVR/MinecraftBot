# MinecraftBot README

**Beschrijving**
De MinecraftBot is een modulair geautomatiseerd script, gebouwd in Node.js en aangedreven door de Mineflayer-library. Hij speelt mee als gewone speler op een vanilla- of Paper-server en neemt het werk over dat je er zelf niet meer bij wilt doen: oogsten en herplanten, dieren fokken, tunnels graven, kisten sorteren, handelen met dorpelingen, vissen, spullen ophalen (of op verzoek uit eigen zak weggeven) en gereedschap bijmaken. Daarnaast past hij op zichzelf — eten, verdrinken, valschade, monsters, een creeper desnoods van afstand neerschieten — en reageert hij op gewone chatberichten. Je stuurt hem aan met commando's in de chat; de rest doet hij zelfstandig.

## Functionaliteiten (Features)

De core-logica van de bot is opgesplitst in onafhankelijke modules binnen de `features/` directory. Elke module is verantwoordelijk voor een specifieke in-game taak:

### 🧬 Breeding (`features/breeding.js`)

Deze module is verantwoordelijk voor geautomatiseerd fokken, maar gaat veel verder dan simpelweg voedsel uitdelen. Het houdt nauwkeurig rekening met Vanilla Minecraft-mechanics en de in-game economie om voedselverspilling te voorkomen.

**Hoe te gebruiken in-game**
* **Handmatig:** Typ `!breed` in de Minecraft-chat om de bot eenmalig alle dieren in de buurt te laten voeren.
* **Stoppen:** Typ `!stop` in de chat om het fokken direct af te breken.
* **Automatisch:** Je hoeft dit niet handmatig te doen als de bot aan het boeren is; de bot voert de fok-ronde automatisch één keer per oogstronde uit tijdens de farming-cyclus.

**Slimme Beveiligingen (Fail-safes)**
* **Geen voedselverspilling:** De Minecraft-server geeft niet aan of een dier al in *love mode* is of nog in een afkoelperiode zit. De bot lost dit op door een interne lijst (`gevoerd`) bij te houden; elk dier wordt per ronde maximaal één keer gevoerd.
* **Zaad- en Voedselreserve (`spareCount`):** Items zoals wortels, aardappelen en zaden zijn zowel veevoer als plantgoed. De bot berekent dynamisch de voorraad en trekt de benodigde landbouwreserve (`FARM.keepSeedCount` + `BREED.keepFoodCount`) hiervan af, zodat akkers nooit per ongeluk aan dieren worden gevoerd.
* **Koppel-afstandslogica (`makePairs`):** Twee dieren die te ver uit elkaar staan (meer dan 8 blokken) kunnen elkaar in Vanilla Minecraft niet bereiken, zelfs niet in *love mode*. De bot berekent vooraf via `distanceTo` of partners dicht genoeg bij elkaar staan, om zinloos voeren te vermijden.

**Stap-voor-stap Werking**
1. **Scannen en Filteren (`scanAnimals`):** Zoekt alle dieren binnen de ingestelde `scanRadius` en groepeert deze per soort.
2. **Metadata Uitlezen:** De bot leest dynamisch via `bot.registry` de entiteit-metadata uit (onafhankelijk van de Minecraft-versie). Hierdoor filtert hij feilloos baby-dieren en ongetemde wolven of paarden eruit.
3. **Koppels Maken (`makePairs`):** Volwassen, geldige dieren worden logisch in setjes van twee gezet op basis van hun onderlinge afstand.
4. **Navigatie & Voeren (`approachAnimal` & `feedAnimal`):** Omdat dieren weglopen, stelt de bot niet eenmalig een pad in, maar controleert hij de actuele locatie continu uit `bot.entities`. Zodra het dier binnen `reachDistance` is, pakt de bot het juiste voedsel en voert hij een interactie (`activateEntity`) uit.
5. **Veilige Verplaatsing (`breedMovements`):** Parkour (springen) wordt automatisch uitgeschakeld om te voorkomen dat de bot *farmland* vertrapt tot normale aarde terwijl hij achter dieren aan rent.

**Uitzonderingen & Speciale Mechanieken**
De interne `BREEDABLE` dictionary bevat unieke regels per diersoort:
* **Wolven (`needsFullHp`):** Een gewonde wolf eet vlees om te genezen in plaats van te paren. De bot controleert eerst of de health minimaal 20 is.
* **Panda's (`pandaHasBamboo`):** Panda's vereisen de aanwezigheid van bamboe. Een custom `extra`-functie scant via `bot.findBlocks` of er minimaal 8 bamboeblokken binnen 5 blokken afstand van de panda staan.

### 💬 Chat & Reacties (`features/chat.js`)

Deze module zorgt voor natuurlijke, automatische reacties op in-game chatberichten. Het scant inkomende chatberichten op specifieke trefwoorden met behulp van RegEx (reguliere expressies) en voert vervolgens acties uit. Dit varieert van een simpele begroeting tot het starten van een gevecht of het zingen van een liedje.

**Hoe te gebruiken in-game**
Je hoeft voor deze feature géén commando's met een `!` te gebruiken. Typ simpelweg in de gewone chat:
* **Socialiseren:** Zeg "hallo", "doei", "hoe gaat het" of "goeie bot" en de bot reageert op de speler.
* **Informatie opvragen:** Typ "inventory" of "hp" in een zin om direct de levenspunten, honger of inventarisstatus van de bot te laten rapporteren.
* **Zingen:** Typ het woord "zing" of "muziek". De bot kiest een willekeurig liedje uit het repertoire (`songs.js`) en zingt dit regel voor regel in de chat.
* **Duelleren:** Typ "vecht tegen mij" en de bot triggert direct de `fightPlayer` functie uit de combat-module voor een duel.
* **Easter Eggs:** Noem de naam "Iwein", "Emperor" of "Solaris" om de maker te eren ("ALL HEIL THE EMPEROR SOLARIS").

**Slimme Beveiligingen (Fail-safes)**
* **Commando-voorrang (Priority):** De module weigert direct alle berichten die met een uitroepteken (`!`) beginnen. Dit voorkomt conflicten. Zonder deze regel zou een commando als `!follow Iwein` onbedoeld de "Iwein"-chat-trigger activeren, waardoor het daadwerkelijke volg-commando nooit zou worden uitgevoerd.
* **Zang-Slot (Anti-Spam):** Omdat zingen tijd kost, is er een `isSinging` lock ingebouwd (in `state.js`, zodat ook andere modules erbij kunnen). Als spelers in de chat spammen met het woord "zing", voorkomt dit dat de bot tientallen liedjes tegelijk – en volledig door elkaar heen – gaat spuien.
* **Stoppen:** Typ `!stop` en de bot houdt midden in het liedje op. De wachttijd tussen twee regels wordt in stukjes van 100ms afgewacht, zodat hij de stopvlag meteen ziet en niet eerst de regel waar hij mee bezig was nog afmaakt.
* **Zelf-Uitsluiting:** De bot negeert berichten die hij zelf heeft gestuurd (`username === bot.username`). Dit is een cruciale fail-safe om oneindige praat-loops (waarbij de bot op zijn eigen antwoord reageert) te voorkomen.

**Stap-voor-stap Werking**
1. **Validatie:** Zodra er een chatbericht binnenkomt, kijkt `handleChatReactions` eerst wie het stuurt en of het geen expliciet commando (`!`) is. 
2. **Patroonherkenning:** De bot loopt de `REACTIONS` array van boven naar beneden af. Dit is een strakke hiërarchie: **de eerste match wint altijd**. 
3. **Uitvoering & Feedback:** Als een patroon (zoals `/\b(zing|zingen|muziek)\b/i`) matcht, voert de bot de gekoppelde `reply()` functie uit. Hierna wordt `true` teruggegeven aan het hoofdscript, zodat deze weet dat het bericht is afgehandeld en er geen verdere logica (zoals command-parsing) meer op losgelaten hoeft te worden.

### ⚔️ Combat & Survival (`features/combat.js`)

Deze module beheert alles wat te maken heeft met gevaar, verdediging en overleving. Het regelt gevechten met spelers en monsters, het ontwijken van de dood (bijvoorbeeld via MLG-water), vluchtgedrag en zelfs gecontroleerde zelfmoord.

**Hoe te gebruiken in-game**
* **Vechten (chat "vecht tegen mij"):** Er is geen `!`-commando voor; typ in de gewone chat "vecht tegen mij" en de bot triggert `fightPlayer`, pakt zijn beste wapen en start een duel via de `mineflayer-pvp` plugin.
* **Slapen (`!bed`):** De bot zoekt het dichtstbijzijnde bed en stelt zijn spawnpoint in (werkt alleen 's nachts of bij onweer).
* **Zelfmoord (`!die`):** De bot zoekt het dichtstbijzijnde monster, lava of vuur op om zichzelf te elimineren en terug te keren naar spawn.
* **Automatisch:** De bot voert automatisch de 'MLG water bucket' truc uit bij diepe vallen, draait zich om naar spelers die hem slaan, verdedigt zich tegen monsters die hem aanvallen, en vlucht bij lage levenspunten.
* **Zelfverdediging (`defendAgainst`):** Slaat een monster hem, dan slaat hij terug — zonder dat je daar een commando voor hoeft te geven. Hij pakt zijn beste wapen, meldt in de chat wat hem aanvalt, en vecht tot het beest dood is, wegvlucht (verder dan 16 blokken), tot hij onder de helft van zijn harten zakt, of tot de 30 seconden om zijn. Daarna is de gewone vluchtroutine weer aan de beurt. Tegen een **creeper, ghast, phantom, warden, wither, ender dragon, elder guardian of iron golem** vecht hij bewust niet terug: ernaartoe lopen is daar juist het probleem. Die lijst staat als `NO_FIGHT_MOBS` in `config.js`.

**Slimme Beveiligingen (Fail-safes)**
* **Omgevingsschade-detectie:** De bot draait zich alleen om (`faceAttacker`) als de schade écht door een entiteit is aangericht. Hierdoor draait hij zich niet meer verward naar een willekeurige speler als hij toevallig zelf in de lava stapt.
* **MLG Bucket Precisie:** Bij het opvangen van een val gebruikt de bot `findItemExact`. Hierdoor pakt hij 100% zeker een lege emmer of wateremmer, en plaatst hij niet per ongeluk een *lava_bucket* omdat de zoekopdracht deels overeenkwam.
* **Wapen-Rangschikking:** De bot berekent dynamisch een wapenscore (`weaponScore`) inclusief koperen gereedschap. Omdat *mineflayer-pvp* altijd de volledige cooldown afwacht, kiest de bot bewust liever een bijl (hoge schade per klap) dan een zwaard.
* **Anti-Griefing na Gevecht:** De PVP-plugin zet intern opties zoals blokken breken (`canDig`) aan. Die wordt bij het opstarten al op `false` gezet (`bot.pvp.movements`), en na een gevecht zet de bot bovendien de Movements terug die de lopende taak nodig had — vecht hij midden op de akker, dan boert hij daarna gewoon verder zonder gewassen te slopen.
* **Bed Validatie:** Omdat een bed uit twee blokken bestaat (hoofd en voet), voorkomt de bot vastlopers door niet blind op het blok te klikken, maar de robuuste `bot.sleep()` functie te gebruiken die rekening houdt met de dag/nacht-cyclus en de juiste bed-helft.

**Stap-voor-stap Werking**
1. **Vluchtgedrag (`fleeFromDanger`):** Als de bot onder een bepaalde HP-grens komt, rekent hij de vector (richting) van het gevaar uit. Hij rent exact de andere kant op, stopt tijdelijk zijn huidige taak, en pakt deze na ontsnapping (zoals een speler blijven volgen) weer feilloos op.
2. **Gecontroleerde Zelfmoord (`killBot`):** De bot zoekt eerst vijanden om uit te lokken. Werkt dat niet? Dan zoekt hij vuur of lava. Omdat de pathfinder geprogrammeerd is om *nooit* in lava te lopen, wordt de pathfinder op het allerlaatste moment uitgeschakeld (`walkInto`). De bot forceert dan handmatig de *forward* en *sprint* controls om het vuur in te rennen.

### ⌨️ Commando's & Routing (`features/commands.js`)

Deze module fungeert als het zenuwstelsel van de bot. Het ontvangt alle expliciete chatcommando's (die beginnen met een `!`), interpreteert eventuele coördinaten of extra argumenten via reguliere expressies (Regex) en activeert vervolgens de juiste scripts uit de andere modules.

**Hoe te gebruiken in-game**
Alle commando's vereisen een uitroepteken (`!`) vooraf. Een kleine greep uit de mogelijkheden:
* **Navigatie:** `!kom`, `!goto <x> <y> <z>`, `!follow <speler>` om de bot te verplaatsen. Voeg `allow` toe (bijv. `!komallow`) als hij blokken mag breken op de route.
* **Tunnels & Delven:** `!tunnel naar mij`, `!tunnel noord 20` of `!collect <blok> <aantal>`. Voor tunnels kun je optioneel breedte en hoogte toevoegen (bijv. `!tunnel noord 20 3 3`).
* **Noodrem:** Typ `!stop` in de chat. Dit is de ultieme noodrem die direct álle huidige acties van de bot afbreekt.
* **Informatie:** `!help` toont een lijst met alle commando's. `!pos` rapporteert de huidige locatie en inventarisstatus in de chat.
* **Gedelegeerde acties:** Alle functies uit andere modules activeer je hier (bijv. `!tp`, `!farm`, `!sort`, `!leeg`, `!vis`, `!trade`, `!maak <item>`, `!haal <item>`, `!geef <item>`). Veel daarvan nemen een aantal of een naam als argument: `!farm tarwe` (alleen dat gewas), `!vis 20` (aantal worpen), `!maak 8 torch`, `!haal 64 cobblestone` (uit de opslag) en `!geef pickaxe` (uit haar eigen inventaris).

**Slimme Beveiligingen (Fail-safes)**
* **Crash Preventie (Prototype-check):** Bij het uitlezen van argumentloze commando's controleert de code veilig via `hasOwnProperty`. Dit voorkomt dat een grapjas de bot laat crashen door JavaScript-systeemwoorden zoals `!__proto__` of `!constructor` in de chat te typen.
* **De Absolute Noodrem (`!stop`):** Deze functie breekt via `abortAllTasks()` élke lopende taak af — zowel de `stopX`-vlag aan als de `isX`-vlag uit — en stopt daarnaast fysiek het graaf-proces (`bot.stopDigging()`) en de besturing (`clearControlStates`). Dit zorgt dat de bot *onmiddellijk* stilstaat en niet tergend langzaam eerst zijn blokje afbreekt.
* **Opruimen na de dood (`abortAllTasks`):** Sterft de bot midden in een taak, dan blijft die taaklus hangen in een `await` die nooit meer afkomt: hij staat opeens bij zijn bed, zonder inventaris, meters van zijn werk. Het `finally`-blok waarin `isFarming` normaal uitgezet wordt, komt dan nooit aan de beurt, en daarna antwoordde de bot op elk `!farm` met "Ik ben al aan het boeren!" terwijl hij stilstond — ook na `!stop`. Bij `death` en bij een herverbinding wordt de taak-state daarom hard gereset, zodat een nieuw commando altijd aanslaat.
* **Follow-Tokens tegen Overbelasting:** Elke keer als `!follow` wordt gebruikt, genereert de code een uniek token (`Symbol`). Dit voorkomt dat er meerdere loop-functies op de achtergrond opstapelen (waardoor de bot in de war raakt) als je het commando per ongeluk twee keer typt.
* **Failsafe Status Herstel:** Acties die instellingen veranderen (zoals het tijdelijk toestaan van blokken breken bij `!komallow`) worden via een `finally`-blok altijd weer netjes teruggezet. Zelfs als de bot onderweg vastloopt of een error krijgt, sloopt hij daarna niet per ongeluk je basis.
* **Tunnel Precisie & Yaw-fix:** Vroeger groef de bot vaak de verkeerde kant op omdat de "kijkrichting" (yaw) soms ongelukkig werd afgerond. Dit is gefixt: commando's vereisen nu harde doelen (coördinaten of "naar mij"), óf de bot meldt exact in de chat welke richting hij heeft gekozen (bij `!tunnel hier`), zodat eventuele afrondingsfouten direct opvallen.
* **Anti-Vastloop Limiet (`walkToTarget`):** Bewegingen die de pathfinder omzeilen hebben een ingebouwde stap-limiet (`maxSteps`). Dit voorkomt dat de bot voor eeuwig in een hoekje blijft rennen als hij de bestemming nét niet kan bereiken.

**Stap-voor-stap Werking**
1. **Directe Match:** Zodra een bericht begint met `!`, kijkt het script eerst of het commando exact overeenkomt met een commando zonder argumenten (zoals `!stop` of `!farm`).
2. **Regex Parsing:** Als er extra tekst achter staat (zoals `!tunnel noord 20`), valt het door naar de Regex-filters. Deze filters halen automatisch de nummers en woorden eruit en zetten deze om naar bruikbare variabelen (coördinaten, spelernamen, afmetingen of items).
3. **Delegatie & Foutafhandeling:** Het commando roept asynchroon (via Promises) de juiste functie uit de betreffende map aan. Eventuele fouten binnenin die functies (`.catch`) worden netjes opgevangen. Hierdoor crasht het hele Node.js proces niet, maar verschijnt er gewoon een foutmelding in de chat.

### 📦 Koerier & Voorraadbeheer (`features/courier.js`)

Deze module werkt als het omgekeerde van het sorteersysteem. De bot fungeert als logistieke koerier: hij zoekt in zijn opgebouwde geheugen op waar een specifiek item ligt, haalt het uit de juiste kist en komt het netjes bij de speler afleveren.

**Hoe te gebruiken in-game**
* **Ophalen:** Typ `!haal <item>` of `!haal <aantal> <item>` (bijv. `!haal 64 cobblestone`). De bot pakt de spullen uit de opslag en gooit het voor je neer. Geef je geen aantal op? Dan pakt hij standaard een volle stack.
* **Iets van haarzelf:** Typ `!geef <item>` of `!geef <aantal> <item>` (bijv. `!geef pickaxe` of `!geef 32 cobblestone`). Het verschil met `!haal`: dit haalt niets uit een kist, maar geeft iets weg dat de bot op dat moment al zelf bij zich draagt — handig om specifiek naar haar gereedschap te vragen. Geef je geen aantal op, dan krijg je alles wat ze ervan bij zich heeft.
* **Zoeken:** Typ `!waar <item>` om in de chat de exacte coördinaten te zien van de kisten waar dit item ligt, zonder dat de bot ernaartoe loopt.
* **Indexeren:** Typ `!index` om de bot handmatig alle kisten in de buurt te laten scannen zodat hij zijn geheugen (de index) vernieuwt. Kan hij een kist niet bereiken of openen, dan zegt hij dat erbij, met de coördinaten van zo'n kist — anders is "er ligt niks" niet te onderscheiden van "ik ben er nooit bij gekomen".
* **Vergeten:** Typ `!vergeet` om de index helemaal te wissen, bijvoorbeeld als je kisten omgebouwd of leeggehaald hebt. De volgende `!index`, `!sort` of `!haal` bouwt hem opnieuw op.
* **Stoppen:** Typ `!stophaal` (voor `!haal`), `!stopgeven` (voor `!geef`) of de algemene `!stop` om de bezorging direct te annuleren.

**Slimme Beveiligingen (Fail-safes)**
* **Zelfherstellend Geheugen:** Het zoeken kost nauwelijks tijd omdat de bot een cache-index (`lib/storage.js`) gebruikt. Als een speler stiekem een kist heeft leeggehaald, merkt de bot dit bij het openen. Hij werkt dan direct zijn index bij en zoekt naadloos verder in de volgende kist.
* **Slimme Woordherkenning (`resolveItem` / `resolveOwnItem`):** Je kunt gedeeltelijke namen typen (zoals "cobble"). Levert dit meerdere opties op? Dan kijkt de bot bij `!haal` naar wat er *daadwerkelijk* in de opslag ligt, en bij `!geef` naar wat ze *zelf* bij zich heeft, om de meest logische keuze te maken (hij kiest dan `cobblestone` in plaats van `cobblestone_stairs`).
* **Losse taakstatus (`isGiving`):** `!geef` draait op zijn eigen sessie, los van `isFetching`. Zo botst een lopende `!geef` niet met een lopende `!haal` en andersom.
* **Inventaris-limiet:** De bot stopt met het leeghalen van kisten zodra zijn eigen inventaris vol dreigt te raken (`minFreeSlots`), zodat er geen items onbedoeld op de grond vallen bij de kist.
* **Veiligheidsrestricties (`courierMovements`):** Net als bij het fokken mag de bot tijdens het bezorgen géén blokken breken of plaatsen, en niet sprint-springen (geen parkour). Dit voorkomt schade aan de basis en farmland.
* **Afstandsoptimalisatie:** Als een item in meerdere kisten ligt, rekent de bot de afstand (`distanceTo`) uit en bezoekt hij altijd de kist die het dichtstbij is.
* **Dubbele kisten één keer (`chestPartner`):** Elke helft van een dubbele kist is een eigen blok, maar ze delen één inhoud. `!index` opent er daarom maar één helft en slaat de andere over; eerder stond dezelfde inhoud dubbel in de index en liep hij elke dubbele kist twee keer af. Welke kant de andere helft zit, volgt uit de blokstate (`facing` en `type`), net als in vanilla.
* **Rakere worp (`handOver`):** Vlak voor het neerleggen kijkt de bot naar de vóéten van de speler, niet naar zijn hoofd. `bot.toss()` gooit mee met de kijkrichting; recht vooruit kijken (naar het hoofd) geeft een vlakke hoek waardoor de spullen ver voorbij de speler vliegen, terwijl omlaag kijken zorgt dat ze vlak bij hem neerkomen.

**Stap-voor-stap Werking**
1. **Vertalen & Caching:** De bot vertaalt de zoekterm naar een exacte Minecraft-itemnaam. Vervolgens checkt hij de index. Is de index helemaal leeg? Dan scant hij proactief eerst alle kisten in de buurt (`buildIndex`).
2. **Verzamelen (`takeFromChest`):** De bot navigeert naar de kist, opent de GUI (`openChest`), haalt exact het benodigde aantal items eruit en updatet tegelijkertijd zijn interne geheugen voor die kist.
3. **Afleveren (`handOver`):** Na het verzamelen (of, bij `!geef`, meteen) zoekt hij de speler op die de aanvraag deed (`findNearestEntity` of via de spelerslijst), navigeert ernaartoe en gooit de items voor diens voeten op de grond (`bot.toss`).

### 🌾 Landbouw & Oogsten (`features/farming.js`)

Deze module transformeert de bot in een volautomatische boer. Het systeem is extreem flexibel doordat de regels voor het oogsten (wanneer is iets rijp, hoe moet het gebroken worden) zijn afgescheiden in `data/crops.js`. De bot kan hierdoor moeiteloos overweg met alle soorten gewassen: van normaal graan tot verticaal groeiende suikerriet en rechtsklik-gewassen zoals bessen.

**Hoe te gebruiken in-game**
* **Starten:** Typ `!farm` in de chat. De bot scant de omgeving, oogst alles wat rijp is, plant terug, voert de dieren en komt de opbrengst bij je brengen.
* **Eén gewas:** Typ `!farm <gewas>`, bijvoorbeeld `!farm tarwe`, `!farm wortels`, `!farm pompoen` of `!farm suikerriet`. De bot oogst dan alleen dat gewas en laat de rest staan. Nederlandse én Engelse namen werken, met spaties of underscores (`!farm sugar cane` = `!farm sugar_cane` = `!farm suikerriet`), en `!farm alles` is hetzelfde als een kaal `!farm`. Kent hij de naam niet, dan somt hij in de chat op wat hij wél kent. De namenlijst staat bij de gewassen zelf, in `CROP_GROUPS` in `data/crops.js`.
* **Stoppen:** Typ `!stopfarm` (of `!stop`) om de landbouwcyclus direct af te breken.

**Slimme Beveiligingen (Fail-safes)**
* **Gereedschap-veiligheid & Auto-Resupply (`equipSafeTool`):** Gewassen zoals meloenen en bamboe kosten duurzaamheid van je gereedschap. De bot houdt de *durability* in de gaten. Dreigt een tool te breken? Dan stopt hij met het gebruik ervan. Als `autoResupply` aanstaat, loopt de bot zelfs automatisch naar een werkbank om nieuw gereedschap te maken voordat hij verder boert.
* **Anti-Griefing bij Rechtsklikken (`equipNonPlaceable`):** Gewassen zoals bessen (Sweet Berries) moet je rechtsklikken. Als de bot toevallig een aarde-blok in zijn hand houdt, zou hij per ongeluk een blok plaatsen in plaats van oogsten. De bot zorgt er dus altijd voor dat hij iets veiligs vasthoudt (zoals een zwaard of leeg slot) bij interactie-gewassen.
* **Logische Volgorde (Fokken vóór Leveren):** De bot voert altijd eerst het `breedAnimals` script uit vóórdat hij zijn inventaris bij de speler komt dumpen. Doe je dit andersom, dan staat de bot met lege handen bij de koeien omdat hij al het graan net aan jou heeft gegeven.
* **Dynamische Leeftijdscheck (`maxAgeOf`):** De bot leest de maximale leeftijd van een gewas uit het Minecraft-register in plaats van uit hardgecodeerde getallen. Hierdoor snapt de bot feilloos dat kelp (25), bietjes (3) en graan (7) allemaal andere momenten van rijpheid hebben.
* **Anti-Vertrappen (`farmMovements`):** Parkour en sprint-springen worden uitgezet zodat de bot je *farmland* (geploegde aarde) niet per ongeluk kapot springt tijdens het oogsten.
* **Eén gewas tegelijk (`buildTasks`):** De taken worden per gewas gegroepeerd. De bot kiest het gewas waar hij het dichtst bij staat, maakt dat eerst helemaal af, en begint pas daarna aan het volgende — binnen een gewas nog steeds van dichtbij naar ver. Sorteerde hij puur op afstand, dan was het dichtstbijzijnde blok telkens van een ander gewas en stuiterde hij tussen tarwe, wortels en pompoenen heen en weer met overal halve akkers als resultaat. Bij het eerste blok van een nieuw gewas zegt hij in de chat waar hij mee bezig gaat.
* **Rij voor rij (`orderInRows`):** Binnen een gewas loopt de bot de akker af zoals een boer dat doet: een rij uit, aan het eind een rij opschuiven, en terug (een slangetje). De rijen lopen langs de *langste* kant van het veld — bij een akker van 9x3 dus drie rijen van negen en niet negen rijtjes van drie — en hij begint aan de kant waar hij toch al staat. Ligt een gewas niet als akker maar verspreid (losse paddenstoelen, één pompoen), dan merkt de functie dat aan de gemiddelde rijlengte en valt hij terug op van dichtbij naar ver.

**Stap-voor-stap Werking**
1. **Scannen (`scanCropBlocks`):** De bot zoekt in een straal om zich heen naar alle blokken die als 'oogstbaar' staan gemarkeerd in de crops-data.
2. **Taakbepaling (`buildTasks`):** Hij zet de blokken om in specifieke taken. Voor pompoenen controleert hij of er wel echt een stengel naast staat. Voor suikerriet pakt hij het tweede blok van onderen, en voor bessen gebruikt hij een rechtsklik.
3. **Oogsten & Opruimen:** Hij breekt de blokken, zuigt de gedropte items op en plant direct nieuw zaad terug als het gewas dat vereist (`CATEGORY.REPLANT`).
4. **Inventaris-Pauze:** Mocht de inventaris van de bot halverwege de oogst vol raken, pauzeert hij even, loopt hij naar de speler om de opbrengst (`toss`) af te geven, en gaat hij weer vrolijk verder waar hij gebleven was.
5. **Eindfase:** Als alle velden leeg zijn, loopt de bot eerst nog een slotronde over de akker om alles op te rapen wat er tijdens het oogsten is blijven liggen, gaat hij daarna met het verse voedsel de dieren fokken, en brengt hij tot slot alle resterende surplus-opbrengst netjes bij je langs.
6. **Slotronde (`sweepFieldDrops`):** Tussendoor raapt de bot alleen op wat binnen 6 blokken ligt — dat moet goedkoop blijven. Maar er wordt tot 32 blokken ver geoogst, dus wat tien oogsten eerder aan de andere kant van het veld viel, bleef daar liggen. De slotronde gaat daarom met de volle scanstraal nog een paar keer over het veld tot er niets meer bijkomt, en onthoudt wat onbereikbaar blijkt zodat hij daar niet telkens opnieuw heen loopt.

### 🎣 Vissen (`features/fishing.js`)

Deze module maakt van de bot een geduldige visser. Omdat de standaard vis-functie van Mineflayer erg simplistisch is en de bot makkelijk kan laten crashen, is deze module uitgerust met uitgebreide logica om een veilige oever te zoeken, worpen te timen en de vangst automatisch op te bergen.

**Hoe te gebruiken in-game**
* **Starten:** Typ `!vis` in de chat. De bot zoekt water, werpt zijn hengel uit en stopt pas als zijn inventaris vol is of de hengel bijna breekt.
* **Beperkt vissen:** Typ `!vis <aantal>` (bijv. `!vis 20`) om de bot na een specifiek aantal worpen te laten stoppen.
* **Stoppen:** Typ `!stopvis` (of `!stop`) om de vis-sessie direct te beëindigen. De bot haalt zijn lijn binnen en vertelt meteen in de chat wat hij deze sessie gevangen heeft, uitgesplitst per soort (`Gevangen: 14x cod, 3x salmon, 1x bone`). Heeft hij de vangst nog niet weggebracht, dan zegt hij dat er ook bij; met `!leeg` gaat die alsnog de invoerkist in.

**Slimme Beveiligingen (Fail-safes)**
* **Anti-Crash & Timeouts:** De standaard `bot.fish()` functie heeft geen timeout en crasht de bot als een worp wordt afgebroken. Deze module wikkelt de worp in een custom timeout en vangt zogenaamde *unhandled rejections* netjes op. Als de dobber op het gras belandt of een netwerkpakketje mist, loopt de bot dus niet meer vast.
* **Slimme Oever-detectie (`findFishingSpot`):** De bot vist niet *in* het water (waardoor hij zou wegdrijven door stroming), maar zoekt een solide blok op de oever met minimaal twee blokken lucht erboven (ruimte om te staan). Daarnaast berekent hij een mikpunt vérder het water op, zodat de dobber niet op de kant stuitert.
* **Direct Stoppen (`abortable` + `reelIn`):** Een worp kan tot 40 seconden op een beet wachten. Zonder extra logica hoorde de bot een `!stop` pas ná die wachttijd, en dan leek het alsof het commando niets deed. De worp wordt nu elke tiende seconde tegen de stop-vlag gehouden, en bij een stop (of een timeout) klikt de bot zijn dobber netjes binnen. Dat laatste is meer dan cosmetisch: laat je de lijn liggen, dan *haalt* de eerstvolgende worp hem alleen maar binnen in plaats van opnieuw uit te werpen, waardoor elke tweede worp een lege klik was. Is de dobber al vernietigd (zoals bij auto-eat), dan klikt de bot juist níét, want dan zou hij een nieuwe lijn uitwerpen waar niemand op wacht.
* **Auto-Eat Herstel:** Als de bot honger krijgt, wisselt de *auto-eat* functie de hengel om voor voedsel. Dit annuleert de worp. De vis-module herkent dit, pakt daarna opnieuw de hengel vast en werpt gewoon opnieuw in.
* **Hengel Behoud (`bestRod`):** Vóór elke worp wordt de durability gecheckt. De bot stopt met vissen zodra de hengel bijna kapot is (`minRodDurability`), zodat je betoverde hengels nooit per ongeluk breken.
* **Automatische Proviand:** Bij het afleveren in de kist dumpt de bot niet klakkeloos alles. Eetbare vissen worden tot een bepaalde drempel (`keepFood`) in de inventaris gehouden als proviand voor de bot zelf.

**Stap-voor-stap Werking**
1. **Voorbereiding & Navigatie:** De bot zoekt de beste hengel in zijn inventaris. Vervolgens zoekt hij open water, berekent hij de beste sta-plek en loopt hij ernaartoe.
2. **Werpen & Wachten:** De bot staat stil (lopen annuleert vissen), kijkt naar het water en werpt uit. Hij wacht tot de server het signaal stuurt dat er beet is.
3. **Vangst Registratie (`snapshot` & `diff`):** Vlak voor de worp en vlak na de worp maakt de bot een 'foto' van zijn inventaris. Door deze te vergelijken, weet de bot exact wat hij net gevangen heeft (inclusief betoverde boeken of rommel).
4. **Afleveren (`deliverCatch`):** Zit de inventaris vol of is het aantal worpen bereikt? Dan loopt de bot naar de invoerkist van het sorteersysteem. Hij legt de vangst erin en kan (als dit is geconfigureerd) direct de sorteer-module (`!sort`) triggeren om de vis netjes over het pakhuis te verdelen.


### ⛏️ Mijnbouw & Tunnels (`features/mining.js`)

Deze module is het brein achter het gestructureerd uitgraven van tunnels en gangen. In plaats van de standaard pathfinder blind te laten graven (wat vaak resulteert in lelijke gaten overal), berekent deze module een wiskundig pad en graaft dit cel voor cel superstrak uit.

**Hoe te gebruiken in-game**
* **Tunnel via kompas:** Typ `!tunnel noord 20` (of zuid, oost, west) om een rechte gang van 20 blokken lang te graven.
* **Tunnel naar doel:** Typ `!tunnel naar <x> <y> <z>` of `!tunnel naar mij` om de bot een gang te laten graven richting een specifiek punt of speler.
* **Afmetingen aanpassen:** Zonder extra getallen graaft de bot standaard een gang van 1 breed bij 2 hoog. Voeg breedte en hoogte toe aan het einde van je commando om dat te veranderen, bijvoorbeeld: `!tunnel noord 20 3 3` voor een gang van 3 bij 3. Dit werkt bij elke tunnelvorm, dus ook `!tunnel naar mij 3 3` of `!tunnel naar <x> <y> <z> 3 3`.
* **Grote zalen:** Vraag gerust `!tunnel oost 20 20 20`. Verder dan ongeveer 4 blokken omhoog en 4 opzij reikt de bot niet vanaf zijn looppad, dus grotere maten worden automatisch in **stroken van 9 breed** en **lagen van 4 hoog** geknipt. Kleine tunnels merken hier niets van.
* **Oprapen regelen:** Standaard graaft de bot dóór en loopt hij alleen om voor **erts**; steen, aarde en grind laat hij liggen. Wil je toch alles hebben, zet dan `collect` achter het commando: `!tunnel oost 50 3 3 collect`. Dat werkt achter élke tunnelvorm.
* **Stoppen:** Typ `!stopmine` (of `!stop`) om de graafwerkzaamheden onmiddellijk te staken.

**Slimme Beveiligingen (Fail-safes)**
* **Gecontroleerd Graven (Anti-Kaasgat):** De pathfinder mag van deze module absoluut niet zelf graven (`canDig: false`). De module graaft zélf het pad vrij en laat de bot uitsluitend door de zelfgemaakte gang lopen. Dit voorkomt dat de bot dwars door muren of over de tunnel heen graaft.
* **Van Boven naar Beneden (`crossSection`):** De bot graaft per cel altijd eerst het plafond en dan pas de vloer. Draai je dit om, dan zakt de bot in een gat terwijl er nog steen op hoofdhoogte staat, waarna zand of grind direct op zijn hoofd valt.
* **Zwaartekracht-correctie (`digFallingBlocks`):** Blokken zoals grind, zand en aambeelden vallen naar beneden als je de vloer weghaalt. De bot wacht kort, detecteert of er iets gevallen is, en ruimt dit direct op zodat de tunnel echt netjes leeg is.
* **Lava Ontwijking (`lavaNearby`):** Voordat een blok gebroken wordt, scant de bot de 6 direct omliggende blokken. Ligt er lava tegenaan? Dan wordt het blok overgeslagen (`Lava in de weg, ik graaf er omheen!`), zodat de tunnel niet plotseling volstroomt.
* **Water en lava overslaan als graafdoel:** Minecraft-data noemt water zelfs `diggable: true`, maar door zijn hardheid (100) rekent `bot.dig()` er een graaftijd van tientallen seconden voor uit in plaats van de `Infinity` die een écht onbreekbaar blok krijgt. Zonder deze check bleef de bot dus een volle `safeDig`-timeout stilstaan te "graven" aan water (of aan lava die toevallig recht in het pad ligt) zonder dat er ooit iets kapotging. Beide worden nu net als lucht meteen overgeslagen: lopen of zwemmen erdoorheen kan gewoon.
* **Drops per laag opruimen (`sweepMiningDrops`):** In een brede of hoge gang valt niet elk gebroken blok binnen Minecrafts oprapradius van het looppad. Na elke laag kijkt de bot daarom kort om zich heen naar wat is blijven liggen, in plaats van dat pas aan het einde van de hele tunnel te ontdekken.
  * *Alleen erts, tenzij je om alles vraagt:* voor élk blok omlopen betekent dat de bot bij iedere rij van zijn graafpunt wegloopt naar elke losse brok steen en weer terug — bij een lange gang kost dat meer tijd dan het graven zelf. Daarom stopt hij standaard alleen voor erts en wat daaruit komt (`isWaardevolleDrop`). Met `collect` achter het commando krijg je het oude gedrag: alles gaat mee.
  * Wat als erts telt komt uit de categorieën in `data/categories.js` (`erts`, `metaal_en_edelsteen`, `grondstofblokken`), plus een handvol losse namen als `redstone` — die valt daar bij de zuigers en rails, maar is natuurlijk gewoon een ertsdrop. Zo staat er niet nóg een lijst met "wat is waardevol" in de bot.
  * De stand wordt onthouden in `lastMineData`, dus na een dood hervat hij in dezelfde modus als waar je om vroeg.
* **Voorraadkisten onderweg (`placeChestInWall`):** Om de zoveel fakkels (`chestPerTorches`, standaard elke tweede — dus vanaf fakkel twee, niet bij de eerste) graaft de bot een nis van één blok in de wand en zet daar een kist in. Zo staat er altijd een kist binnen tien blokken zodra zijn tas volloopt.
  * *Waarom in de wand:* een kist in de gang zelf blokkeert hem. De graaflus slaat kisten bewust over (anders sloopt hij zijn eigen voorraad), dus zo'n kist blijft staan en de bot kan er in een gang van één breed niet meer langs. In een bocht wordt bovendien gecontroleerd of de nis niet op het pad van het volgende stuk gang ligt; dan kiest hij de andere wand.
  * *Waarom vooraf:* de oude aanpak plaatste pas een kist als de inventaris al vol was, en mikte dan op de cel waar de bot zelf stond — een cel die vaak ook nog dichtgemetseld was. In je eigen hitbox of in massief steen kun je niets plaatsen, dus dat mislukte vrijwel altijd. Een nis graaft hij zelf, dus daar is per definitie plek.
  * Heeft hij geen kisten meer bij zich, dan zegt hij dat één keer in de chat in plaats van het bij elke fakkel te herhalen.
* **Auto-Opslag (`storeBlocksInChest`):** Raakt de inventaris vol? De bot zoekt een kist in de buurt (meestal een van zijn eigen wandkisten), en anders graaft hij ter plekke een nis en zet er een neer. Daarna slaat hij alle onnodige blokken op en werkt hij verder.
* **Slim Hervatten (`resumeFrom`):** Als de bot doodgaat, vlucht of herstart, onthoudt hij exact bij welke cel hij was gebleven (`lastMineData`). Hierdoor hoeft hij niet minutenlang in het niets te hakken om een al uitgegraven tunnel opnieuw te verwerken.

**Grote kamers (`mineRoom`)**
Een zaal van 20x20 is niet één tunnel maar een stapel doorgangen, en de vólgorde daarvan is het hele verhaal:

1. **Van boven naar beneden.** Onder elke laag ligt dan nog vaste steen, dus de bot heeft altijd een vloer. Andersom zou hij na de eerste laag in het luchtledige moeten staan en zich omhoog moeten torenen — en blokken plaatsen doet deze bot niet.
2. **Eerst een trap omhoog.** Naar de bovenste laag graaft hij een gang van 1 breed en 2 hoog schuin omhoog. Dat werkt omdat `corridorCells()` per stap maar één as omzet: een schuine lijn wordt vanzelf een traptrede (één vooruit, één omhoog). Die trap ligt binnen de kamer en verdwijnt dus vanzelf zodra de lagen eronder aan de beurt komen. Wel een voorwaarde: de kamer moet minstens zo lang zijn als hij hoog is, anders is de trap te steil om op te lopen en zegt de bot dat meteen.
3. **Helemaal naar rechts beginnen.** De eerste strook ligt tegen de rechterwand, met zijn hartlijn op het vijfde blok vanaf die wand — de helft van negen. Daarna schuift hij strook voor strook naar links.
4. **Heen en terug.** Elke volgende strook graaft hij in de andere richting, en de stroken van een nieuwe laag lopen ook weer de andere kant op. Zo begint hij elke keer aan de kant waar hij toch al stond in plaats van leeg terug te lopen.
5. **Zakken onder zijn eigen voeten.** Aan het eind van een laag loopt hij naar het startpunt van de volgende en graaft hij het blok onder zich weg, vier keer achter elkaar. Hij valt per keer één blokje (dus geen valschade), en die blokken horen toch bij de laag die hierna komt.

De opdeling is nagerekend: voor maten van 20x20x20 tot 11 breed bij 13 hoog dekken alle stroken en lagen samen precies de gevraagde blokken — geen gat, geen blok dubbel, en nooit een laag van één hoog (waar de bot zelf niet in past). Elke doorgang is verder gewoon `mineCorridor`, dus fakkels, wandkisten, lava-ontwijking en het oprapen van erts werken er net zo goed in.

**Stap-voor-stap Werking**
1. **Traject Berekenen (`corridorCells`):** Maakt een vloerplan aan naar het doelpunt. Er wordt altijd maar op één as tegelijk bewogen. Dit zorgt voor nette trappen en voorkomt diagonale sprongen waar de bot zelf niet doorheen past.
2. **Gereedschap Kiezen (`equipBestTool`):** Kiest dynamisch het perfecte gereedschap uit de `TOOL_PREFERENCES` (bijl voor hout, schep voor zand, houweel voor steen) om de duurzaamheid en snelheid te optimaliseren.
3. **Breken (`safeDig`):** Het blok wordt gebroken met een strakke timeout (15 seconden). Als de server lagt of het blok niet breekt, blijft de bot niet voor eeuwig hangen.
4. **Opruimen (`sweepMiningDrops`):** Na de kruisdoorsnede van een laag kijkt de bot om zich heen naar drops binnen een paar blokken. Zonder `collect` loopt hij alleen om voor erts; met `collect` raapt hij alles op.
5. **Verlichting en voorraad (`placeBlock`):** Op vaste intervallen (`torchPlaceInterval`) plaatst de bot automatisch fakkels, bij voorkeur op de vloer in plaats van aan de muren. Bij elke tweede fakkel (`chestPerTorches`) graaft hij er een nis naast en zet daar een voorraadkist in.


### 🗄️ Inventaris & Sorteersysteem (`features/sorting.js`)

Deze module transformeert de bot in een volautomatisch magazijnsysteem. De bot leegt een centrale invoerkist en verdeelt de inhoud over alle omliggende kisten. Dit gebeurt niet blind, maar slim: op basis van de categorieën die zijn vastgelegd in `data/categories.js`.

**Hoe te gebruiken in-game**
* **Automatisch Sorteren:** Typ `!sort` in de chat. De bot zoekt automatisch de dichtstbijzijnde koperen kist (of gewone kist) als invoerbak, haalt deze leeg en begint met sorteren.
* **Specifieke Kist Sorteren:** Typ `!sort <x> <y> <z>` om zelf de coördinaten van de invoerkist aan te wijzen.
* **Stoppen:** Typ `!stopsort` (of `!stop`) om de sorteeractie direct af te breken.
* **Tas legen (`!leeg`):** Typ `!leeg` (of `!dump`) om de bot alles wat hij niet nodig heeft van zich af te laten doen. Hij loopt naar de dichtstbijzijnde speler en legt het daar voor zijn voeten neer. Handig na een vis- of mijnsessie die je halverwege hebt afgebroken. `!stopleeg` (of `!stop`) breekt het af.
  * *Waarom op de grond en niet in een kist:* een kist zoeken, ernaartoe lopen en openen is precies het stuk dat onderweg misgaat. Neerleggen kan altijd. Wel iets om te weten: **gedropte items verdwijnen in vanilla na vijf minuten**, dus er moet iemand staan die ze oppakt. Ziet de bot niemand, dan doet hij niets en zegt hij dat.
  * *Toch een kist:* `!leeg <x> <y> <z>` stort alles in die kist in plaats van het neer te leggen. Staat `sortAfterDump` aan (standaard), dan draait er direct een sorteerronde achteraan zodat het niet in de invoerbak blijft liggen. Wat er niet meer in paste, houdt hij bij zich en meldt hij in de chat.
  * Wat hij houdt is exact wat het sorteersysteem altijd al voor hem reserveert (`protectionQuota`): zijn emmers, schild, elytra en totems, van elk soort gereedschap en van elk harnasdeel het beste exemplaar, plus een werkvoorraad van één stapel eten (`keepFood`), één stapel fakkels (`keepTorches`) en één stapel kisten (`keepChests`). Al het andere gaat weg.
  * Die werkvoorraad hoort bij het quotum zelf en niet alleen bij `!leeg`. Dat moet ook: de kist-variant draait er een sorteerronde achteraan, en die zou het verschil er anders meteen weer uit halen. Zo houdt de bot na élke opruimactie genoeg bij zich om verder te kunnen minen.

**Slimme Beveiligingen (Fail-safes)**
* **Twee-rondes Algoritme:** Dit is de kern van de module. Ronde 1 loopt langs alle kisten en legt alléén items weg die *exact* overeenkomen (steen bij steen). Pas in Ronde 2 wordt de rest op categorie verdeeld. Dit voorkomt dat een gouden zwaard in de eerste de beste kist met een stenen zwaard belandt, terwijl er verderop in het pakhuis een specifieke gouden-zwaarden-kist staat.
* **Bevroren Quotum (`protectionQuota`):** De bot beschermt zijn eigen uitrusting (het beste gereedschap, pantser, en een werkvoorraad voedsel, fakkels en kisten) door een quotum vast te stellen. Dit quotum wordt één keer aan het begin van de sessie berekend en 'bevroren'. Dit voorkomt dat de bot spullen uit de invoerkist opeens als zijn eigen eigendom gaat beschouwen en weigert weg te leggen.
* **Ender Chest Uitsluiting:** De bot mag in normale kisten, vaten en alle kleuren shulker boxes kijken, maar de Ender Chest is expliciet uitgesloten. Die inventaris is speler-gebonden en daar blijft de bot veilig vanaf.
* **Anti-Drop Beveiliging (`returnCursorItem`):** Als een kist onverwachts vol is tijdens het verplaatsen, kan een item aan de virtuele muiscursor van de bot blijven plakken. Zonder de opruim-functie zou dit item op de grond vallen zodra de kist sluit. De bot stopt het nu altijd veilig terug in zijn eigen tas.
* **Auto-Indexatie:** Tijdens het openen van kisten leert de bot direct uit zijn hoofd wat erin ligt (`lib/storage.js`). Dit voedt het geheugen van de Koerier-module (`!haal` / `!waar`).

**Stap-voor-stap Werking**
1. **Voorbereiding:** De bot bevriest zijn eigen beschermde items en bepaalt welke kist de invoerkist is.
2. **Ophalen (`emptyInputChest`):** Opent de invoerkist en haalt alle vracht eruit, totdat zijn eigen inventaris de `minFreeSlots` limiet bereikt.
3. **Ronde 1 (Exact):** Loopt langs alle omliggende kisten. Hij scant de inhoud, leert deze uit zijn hoofd en stopt direct alle exacte matches weg.
4. **Ronde 2 (Categorie):** Kijkt wat hij na ronde 1 nog over heeft. Hij zoekt kisten die items van dezelfde categorie bevatten (zoals 'gereedschap' of 'landbouw') en deelt de rest daar in.
5. **Afronding:** De bot sluit alle vensters veilig af en rapporteert in de chat hoeveel items er exact en op categorie zijn weggewerkt, plus wat hij eventueel wegens ruimtegebrek bij zich heeft gehouden.

**Tas legen (`dumpInventory`)**
Dit is de omgekeerde beweging van het sorteren: niet een kist leeghalen en verdelen, maar de eigen tas kwijtraken. De bot bevriest eerst zijn quotum en bepaalt daarmee wat vracht is. Daarna volgt één van twee routes:

* `gooiBijSpeler` (standaard): hij zoekt de dichtstbijzijnde speler, loopt ernaartoe, kijkt naar diens **voeten** — naar het hoofd kijken geeft een vlakke worphoek waardoor `bot.toss()` de spullen meters voorbij de speler smijt — en legt stapel voor stapel alles neer, met een korte pauze ertussen zodat de server geen worp mist.
* `stortInKist` (alleen met coördinaten): dezelfde afhandeling als het sorteren, inclusief het terugleggen van een item dat aan de cursor blijft hangen als de kist vol raakt, en een sorteerronde achteraf.

Daarna meldt hij per soort wat er weg is (`Neergelegd: 64x cobblestone, 16x cod, ...`). Omdat dit een eigen taak is (`isDumping`), kan hij de sorteerronde aanroepen zonder over zijn eigen "ik ben al aan het sorteren" te struikelen, en breekt `!stop` allebei tegelijk af.

### 🌀 Teleporteren (`features/teleport.js`)

De bot heeft op deze server commandorechten, en die gebruikt deze module: in plaats van een wandeling van soms duizenden blokken stuurt hij `/tp` en staat hij er meteen. Handig als je hem nodig hebt terwijl hij aan de andere kant van de wereld staat, achter een oceaan, of onder de grond waar de pathfinder toch nooit was gekomen.

**Hoe te gebruiken in-game**
* **Naar jou toe:** Typ `!tp`. De bot teleporteert naar degene die het commando typte.
* **Naar iemand anders:** Typ `!tp <speler>` om hem bij een andere speler te laten verschijnen.
* **Liever zien lopen?** `!kom` blijft gewoon bestaan; die loopt er echt naartoe.

**Slimme Beveiligingen (Fail-safes)**
* **Geen loze bevestiging:** Een servercommando stuurt geen antwoord terug dat je kunt afwachten. Mag de bot `/tp` niet gebruiken, dan gebeurt er domweg niets. Daarom wacht de module op het `forcedMove`-event (dat is de server die de bot verplaatst) en telt hij daarna na hoeveel blokken hij echt verschoven is. Pas dan zegt hij "Hier ben ik!" — anders meldt hij eerlijk dat het niet lukte en verwijst hij naar `!kom`.
* **Geen selectors in een op-commando (`SPELERSNAAM`):** De naam gaat rechtstreeks een commando in dat met op-rechten draait. Alles wat geen gewone Minecraft-naam is (letters, cijfers, underscore, hoogstens 16 tekens) wordt geweigerd. Zonder die check kon `!tp @e[type=creeper]` de bot van alles laten verslepen namens de server.
* **Lopend doel wissen:** Stond de bot te volgen of naar een coördinaat te lopen, dan wandelt hij na de sprong meteen weer terug en lijkt het alsof de teleport mislukt is. Het doel (`lastGoal`, `followToken`) wordt daarom gewist en de pathfinder gestopt.
* **Lopende taken blijven lopen:** Was hij aan het boeren of graven, dan wordt die taak bewust *niet* afgebroken — die stuurt hem waarschijnlijk gewoon terug naar de akker. Hij zegt er wel bij waar hij mee bezig was, zodat je zelf kunt kiezen of je `!stop` typt.
* **Wachten op de wereld:** Na de sprong wordt er kort gewacht (`settleDelay`), want de server stuurt de nieuwe positie en de chunks eromheen net na elkaar.

**Stap-voor-stap Werking**
1. **Naam controleren:** Is dit een echte spelersnaam? Zo niet, dan wordt er geen enkel commando verstuurd.
2. **Opruimen:** Pathfinder-doel, controls en het onthouden doel gaan eruit.
3. **Springen:** De bot onthoudt zijn positie, zet `/tp <bot> <speler>` in de chat en wacht op `forcedMove`.
4. **Nameten:** Verschoven, of nu binnen `arrivedDistance` van de speler? Dan is het gelukt, en zegt hij dat. Anders krijg je te horen dat het commando niets deed.

### 🛠️ Smid & Crafting (`features/toolsmith.js`)

Deze module maakt de bot volledig zelfvoorzienend. In plaats van domweg te stoppen als zijn houweel of schoffel breekt, zoekt de bot automatisch een werkbank of aambeeld op om zijn uitrusting te repareren of nieuw gereedschap te craften. 

**Hoe te gebruiken in-game**
* **Automatisch Aanvullen:** Typ `!gereedschap` in de chat. De bot controleert zijn inventaris en repareert of craft automatisch de basis-tools die hij mist.
* **Specifiek Craften:** Typ `!maak <item>` of `!maak <aantal> <item>` (bijvoorbeeld `!maak diamond_pickaxe` of `!maak 8 torch`) om de bot een specifieke opdracht te geven.
* **Stoppen:** Typ `!stopmaak` (of `!stop`) om de smid-sessie direct af te breken.
* **Op de achtergrond:** De *Farming* en *Mining* modules activeren dit script automatisch (in de stille modus) zodra ze merken dat hun gereedschap op het punt staat te breken.

**Slimme Beveiligingen (Fail-safes)**
* **Repareren gaat voor Maken:** Voordat de bot grondstoffen verspilt, zoekt hij een aambeeld om twee versleten tools samen te voegen. Hij pakt hierbij slim de twee meest versleten exemplaren. Dit behoudt de "tier" (bijv. diamant) en eventuele betoveringen, wat veel waardevoller is dan een nieuw stenen exemplaar maken.
* **Duurzaamheid boven Tier:** Bij het craften van nieuw gereedschap kijkt de bot naar de daadwerkelijke levensduur (`maxDurability`). Hij is geprogrammeerd om te weten dat een stenen houweel (131 slagen) beter is dan een gouden houweel (32 slagen), zodat hij geen dure maar zwakke materialen verspilt.
* **Dynamische Recursie & Anti-Loop:** De bot gebruikt geen hardgecodeerde recepten. Hij vraagt aan de server (`recipe.delta`) wat er exact nodig is. Ontbreken er stokken? Dan maakt hij die eerst zelf van planken (en de planken van hout). Om te voorkomen dat dit in een oneindige cirkel vastloopt, zit er een strikte diepte-limiet (`maxDepth`) en een `bezig` beveiliging op.
* **Voorraad-Integratie:** Voor hij begint te craften, communiceert deze module met het geheugen van de Sorteer- en Koerier-module. Hij haalt ontbrekende grondstoffen dus eerst efficiënt uit nabijgelegen kisten.
* **Anti-Crash Timeouts:** Standaard Mineflayer functies zoals `bot.craft()` en `anvil.combine()` wachten op server-pakketjes (zoals een *experience event*) die op sommige servers nooit aankomen. Deze functies zijn strak in een timeout gewikkeld, zodat de bot nooit permanent bevriest bij een werkbank.

**Stap-voor-stap Werking**
1. **Inventarisatie:** De bot controleert of er onmisbaar gereedschap (zoals zwaarden, houwelen of schoffels) onder de veilige duurzaamheidsdrempel is beland.
2. **Reparatieronde:** Is reparatie ingeschakeld? Dan navigeert de bot eerst naar een aambeeld en combineert hij de gebrekkige tools om ze te herstellen.
3. **Crafting Voorbereiden:** Als er nog steeds gereedschap ontbreekt, loopt de bot naar een werkbank (`goToBlock`) – hij plaatst deze bewust niet zelf om de wereld netjes te houden. Er wordt iets onschuldigs vastgehouden (`equipNonPlaceable`) zodat hij bij het rechtsklikken op de werkbank niet per ongeluk een blok plaatst.
4. **Materialen Verzamelen:** Ontbrekende grondstoffen worden uit kisten gehaald of ter plekke in tussenstappen gecraft.
5. **Smeden & Afronden:** De bot craft het benodigde item, sluit de GUI-vensters netjes af en rapporteert in de chat wat er precies is gerepareerd of geproduceerd.

### 🤝 Handel & Economie (`features/trading.js`)

Deze module transformeert de bot in een volautomatische handelaar. Hij haalt landbouwgewassen uit de opslag, bezoekt een handelshal met dorpelingen (villagers), verkoopt alles voor smaragden (emeralds) en bergt de pure winst netjes op in een kluiskist.

**Hoe te gebruiken in-game**
* **Automatisch:** Typ `!trade` in de chat. De bot zoekt zelf de kist met gewassen en handelt met dorpelingen in de directe omgeving. Heeft hij van `!index` of `!sort` al een lijst, dan kiest hij de kist met de meeste verhandelbare gewassen; anders de dichtstbijzijnde kist. De smaragden gaan dan terug in diezelfde kist.
* **Geavanceerd (Op afstand):** Typ `!trade kist <x> <y> <z> hal <x> <y> <z> [kluis <x> <y> <z>]` om de bot een exacte route te geven. Handig als je boerderij, handelshal en kluis ver uit elkaar liggen.
* **Stoppen:** Typ `!stoptrade` (of `!stop`) om het handelen direct te beëindigen.

**Slimme Beveiligingen (Fail-safes)**
* **Native GUI-afhandeling:** De bot klikt niet handmatig in inventaris-schermpjes (wat gegarandeerd tot desync-crashes leidt bij lag), maar gebruikt de ingebouwde `bot.trade()` protocollen. Dit handelt wisselgeld, packet-verkeer en slot-verplaatsingen feilloos af.
* **Dynamische Prijsberekening (`realPrice`):** De bot rekent niet met de basisprijs van een item, maar met de *echte* prijs. Hierdoor snapt de bot het perfect als prijzen stijgen door veelvuldig handelen, of dalen dankzij reputatie of *Hero of the Village*.
* **Strikte Entiteit-Filter:** De bot filtert hard op de naam `villager`. *Wandering traders*, *zombie villagers* of *illagers* worden genegeerd. Zonder deze check zou de onderliggende code hard crashen.
* **Beroeps- en Ruilfilter (`isCropSale`):** De bot checkt scherp of de aanbieding wel "gewas voor smaragd" is. Dit voorkomt dat hij per ongeluk smaragden uitgeeft om brood te kópen, of bij een visser of bibliothecaris probeert te pinnen.
* **Anti-Vastloop (Ruimte-check):** Voordat de bot op de ruil-knop drukt, controleert hij of hij wel een vrije plek of een bestaande stack smaragden in zijn inventaris heeft. Zonder plek kan de ruil niet voltooien en zou het scherm voor eeuwig open blijven staan.
* **Gegarandeerde Venster-Cleanup:** Dankzij het `finally`-blok wordt het handelsscherm áltijd gesloten. Zelfs als een dorpeling halverwege in een mijnkarretje stapt of wegrent, bevriest de bot niet.
* **Geen eeuwige ruil (`tradeTimeout`):** `bot.trade()` wacht na het kiezen van een ruil tot de server de invoerslots vult, zonder timeout. Kwam die update niet, dan bleef `!trade` voor altijd hangen en antwoordde de bot op elke volgende `!trade` "Ik ben al aan het handelen!". Nu geeft hij het na 20 seconden op bij die dorpeling.
* **Zegt waarom het niet lukt:** Kon hij met geen enkele dorpeling ruilen, dan meldt hij per reden hoe vaak: `onbereikbaar`, `koopt geen gewassen`, `uitverkocht`, `wil een gewas dat ik niet (genoeg) heb`, ... Eerder bleef hij dan gewoon stil.
* **Niets blijft aan hem hangen:** Wat hij niet kwijt kon, legt hij na afloop terug in de voorraadkist — alleen wat hij eruit haalde, niet de gewassen die hij zelf al bij zich had. Is het de moeite niet waard (minder dan `minStock`), dan gaat het meteen terug.

**Stap-voor-stap Werking**
1. **Inladen (`withdrawCrops`):** De bot opent de voorraadkist en pakt zoveel mogelijk verhandelbare gewassen (zoals wortels, aardappelen, tarwe). Hij filtert bewust zaken als glow berries eruit, omdat boeren die niet accepteren.
2. **Navigatie:** Hij loopt (veilig zonder blokken te breken of plaatsen) naar de ingestelde handelshal of zoekt dorpelingen in de buurt.
3. **Onderhandelen (`tradeWithVillager`):** Hij stapt op elke dorpeling af, controleert of ze boer zijn, en pompt de ruilen maximaal vol totdat de dorpeling weigert (trade locked) of de gewassen op zijn.
4. **Winst Afstorten (`depositEmeralds`):** Na zijn ronde navigeert de bot naar de kluiskist (of terug naar de voorraadkist) en stort hij alle verdiende smaragden veilig af.
5. **Rest Terugleggen (`returnCrops`):** Gewassen die geen dorpeling wilde of kon kopen, gaan terug in de voorraadkist. Is de kluis dezelfde kist, dan gebeurt dat in één keer met het afstorten.

## Achtergrondprocessen (Watchers)

Naast de commando-gestuurde features draaien er in de `watchers/` directory zeven processen continu mee, vanaf het moment dat de bot spawnt, zonder dat daar een commando voor nodig is.

### 🚪 Deuren openen (`watchers/doors.js`)

Mineflayer-pathfinder herkent standaard alleen hekken (*fence gates*) als iets dat vanzelf opengaat, nooit echte deuren. Deze watcher lost dat apart op.

Er zat nog een tweede probleem onder: de pathfinder bepaalt of hij ergens doorheen kan aan de hand van `boundingBox`, en dat is een eigenschap van het *bloktype*, niet van de stand. Een deur is daardoor voor hem altijd een dichte muur — óók als hij wagenwijd openstaat. Hij plande dus nooit een route een gebouw in, en de bot bleef voor de open deur staan. `setMovements()` in `utils.js` zet houten deuren daarom in de lijsten `carpets` en `fences` van de pathfinder, wat neerkomt op "behandel dit als lucht". De echte vorm van het blok telt gewoon mee in de loopsimulatie, dus een dichte deur houdt de bot nog steeds tegen — alleen staat hij er dan vóór, en dat is precies waar deze watcher hem openklikt. IJzeren deuren blijven expres een muur: die gaan niet met de hand open.

**Werking**
* Elke 250ms checkt de bot of er, in de richting waar hij op dat moment heen kijkt, een gesloten deur staat (op voet- of hoofdhoogte).
* Is dat zo, dan klikt de bot de deur automatisch open (`activateBlock`).
* IJzeren deuren worden bewust overgeslagen: die gaan niet met de hand open, dus klikken zou alleen maar een zinloze interactie per 250ms opleveren.

### 🚧 Hekken sluiten (`watchers/gates.js`)

Mineflayer-pathfinder opent hekken (*fence gates*) automatisch om erdoorheen te lopen, maar sluit ze nooit weer. Zonder ingrijpen blijft een hek dus openstaan zodra de bot voorbij is — bijvoorbeeld bij de ingang van een dierenwei — en lopen dieren of mobs zo naar buiten.

**Werking**
* De watcher houdt via het `blockUpdate`-event bij welke hekken open staan, ook als de pathfinder ze zelf opende.
* Zodra een hek minstens 1,5 seconde open staat én de bot er niet meer vlak naast staat, klikt de watcher het weer dicht (`activateBlock`).
* Staat de bot nog naast het hek (bijvoorbeeld omdat hij er net doorheen loopt), dan wordt het nog niet gesloten om hem niet voor zijn eigen neus op te sluiten.

### ⬆️ Vastlopers overspringen (`watchers/jump.js`)

Een vangnet voor als de bot ondanks alles tegen een blok blijft hangen. De echte oorzaak van het vastlopen bij één blok omhoog zat niet in de pathfinder maar in wat de bot naar de server stuurt — zie *Bewegingspakketten* hieronder. Offline nagespeeld met dezelfde pathfinder en physics springt de bot gewoon op een blok, ook als hij er plat en zonder vaart tegenaan staat.

**Werking**
* De watcher meet of de bot *vooruitkomt*, niet of hij stilstaat: blijft hij een seconde lang binnen 0,8 blok van waar hij was terwijl hij ergens heen wil, dan zit hij vast. Tegen een blok aan staat de bot namelijk te schuifelen, en een "staat hij stil"-check gaat daar nooit van af.
* Is er in de looprichting een blok waar hij bovenop past (blok op voethoogte, twee blokken lucht erboven en boven zichzelf), dan neemt de watcher het over: eerst een stapje achteruit voor de aanloop, dan vooruit met een korte druk op de spronktoets.
* De sprong wordt zo gewoon mogelijk gehouden: alleen vooruit, en de spronktoets maar 0,2 seconde ingedrukt. Sprint erbij gaf een lunge op het moment van afzetten die de server niet per se meerekent, en de spronktoets vasthouden liet de bot bij elke landing meteen opnieuw springen — allebei leverden een stuiterende of in de lucht hangende bot op in plaats van eentje die netjes boven op het blok eindigt.
* Hangt hij tóch in de lucht (niet op de grond, en toch niet vallen), dan is dat geen sprong meer maar een desync tussen bot en server. De watcher laat dan alles los in plaats van door te duwen, en zet het in de log.
* Achteruit gaat alleen als daar ook echt vloer ligt, zodat hij niet achterwaarts een ravijn in stapt. Kan dat niet, dan springt hij vanaf de plek waar hij staat.
* Hij telt ook mee dat de pathfinder tussen twee berekeningen door even geen pad heeft (`isMoving()` is dan false), maar niet wanneer het doel al bereikt is — anders staat hij te stuiteren terwijl hij met `!follow` naast een stilstaande speler wacht.
* Is er niets om overheen te springen (een muur van twee hoog, een dichte deur, een mob), dan doet de watcher niets: daar helpt springen niet tegen.
* Taken die bewust zonder parkour lopen (boeren, fokken, sorteren) laat de watcher met rust, en op akkerland of een schildpadei landt hij nooit: een sprong erop maakt er gewone aarde van of trapt het ei kapot.
* Elke poging komt in de log te staan (`Vastgelopen tegen ... sprong 1/5`), en na vijf mislukte pogingen op dezelfde plek volgt een pauze van vijf seconden.

### 💥 Creeper-verdediging (`watchers/creeper.js`)

Een creeper is het enige monster waar terugvechten averechts werkt: ernaartoe *lopen* is precies wat hem laat ontploffen, en daarom staat hij ook in `NO_FIGHT_MOBS`. Een pijl afschieten hoeft daar niet voor — dat kan van ruime afstand, ver buiten zijn ontploffingsbereik. Komt hij tóch te dichtbij, dan lukt weglopen maar half (hij loopt even hard als de bot), en dan werkt alleen nog uitloggen.

**Werking**
* Ziet de bot een creeper tussen de 10 en 16 blokken afstand, en heeft ze een boog én pijlen bij zich, dan trekt ze de boog en schiet ze een pijl op hem af in plaats van meteen in paniek te raken. Dit wordt overgeslagen tijdens een gevecht, vlucht of `!die`, zodat het niet per ongeluk het wapen van die andere actie omwisselt.
* Komt een creeper toch binnen 10 blokken (ondanks het schieten, of omdat er geen boog/pijlen zijn), dan roept de bot in de chat om hulp mét zijn eigen coördinaten: *"Yo, creeper bij mij op 120 64 -310! Kom die plz helpen wegdoen."*
* Daarna meldt hij netjes dat hij zo terug is en verbreekt hij de verbinding (`bot.quit`). De herverbind-logica in `Index.js` wacht dan een minuut in plaats van de gebruikelijke vijf seconden — dat stuurt de watcher door via `botState.reconnectDelay`.
* Na het opnieuw inloggen houdt hij zich 15 seconden stil, en tussen twee alarmen zit minstens 30 seconden. Zonder die twee pauzes zou een creeper die blijft staan de bot in een lus van uitloggen en inloggen houden, met elke keer dezelfde chatberichten.
* Alle tijden en afstanden (`range`, `shootRange`, `drawTimeMs`) staan onder `creeper` in `config.js`. Alleen een gewone boog wordt ondersteund, geen crossbow.

### 👋 Welkomstbericht (`watchers/greeting.js`)

Zodra iemand de server joint, stelt de bot zichzelf automatisch voor in de chat.

**Werking**
* Bij elke `playerJoined` (behalve die van de bot zelf) stuurt de bot een kort welkomstbericht: dat hij een bot is en nog foutjes kan hebben, dat bugs naar Iwein gestuurd mogen worden, en dat je voor een overzicht van wat hij kan op Iwein zijn GitHub kunt kijken of het aan Iwein kunt vragen.
* Direct bij het inloggen stuurt de server de hele bestaande spelerslijst in één keer door, wat ook allemaal `playerJoined`-events oplevert. De watcher wacht daarom de eerste paar seconden na het spawnen af voordat hij begint te reageren, zodat hij niet iedereen die al online was begroet.

### 🌊 Verdrinkingsbeveiliging (`watchers/safety.js`)

De pathfinder zwemt alleen omhoog zolang hij actief een pad volgt. Loopt de bot tijdens bijvoorbeeld een `!goto` een meer in met het doel aan de overkant, dan zwemt hij simpelweg over de bodem door tot zijn lucht op is. Deze watcher bewaakt daarom los van elke taak de zuurstof (`bot.oxygenLevel`).

**Werking**
* Onder 14/20 zuurstof zwemt de bot actief omhoog, ongeacht welke taak er loopt.
* Onder 8/20 zuurstof laat de bot ook zijn huidige doel los (`bot.pathfinder.stop()`) en meldt dit in de chat, zodat hij niet blijft doorzwemmen naar een doel aan de overkant van het water terwijl hij bijna verdrinkt.
* Is de bot weer boven water, dan wordt alles automatisch teruggezet.

### 🔨 Gereedschap-kapot melding (`watchers/toolbreak.js`)

Er bestaat geen apart mineflayer-event voor "dit item is gebroken" — als iets breekt stuurt de server gewoon een lege hand, precies zoals bij het wisselen van gereedschap of het weggeven ervan via `!geef`. Deze watcher onderscheidt de twee situaties en meldt het in de chat zodra het écht kapotgaat, bijvoorbeeld: *"Mijn diamond_pickaxe is net kapotgegaan!"*

**Werking**
* Wisselen van gereedschap of het legen van de hand selecteert altijd een ánder hotbar-slot. Alleen bij echte slijtage blijft hetzelfde slot geselecteerd terwijl de inhoud verandert.
* De watcher onthoudt daarom per `heldItemChanged`-event welk slot geselecteerd was en wat erin zat. Blijft het slot gelijk, en had het vorige item nog maar 1 duurzaamheidspunt over toen het plotseling verdween, dan meldt de bot dat gereedschap als kapot.
* Bekende beperking: geef je met `!geef` precies het gereedschap weg dat op dat moment exact 1 duurzaamheidspunt over heeft, dan meldt de bot dat ook als "kapot" — dat verlaat de hand namelijk via hetzelfde slot. Zeldzaam genoeg (exacte timing + exacte duurzaamheid) om te laten zitten.

### 📡 Bewegingspakketten (`lib/movementPackets.js`)

Geen watcher in de `watchers/`-map, maar hij loopt net zo vanaf het spawnen mee. De bot praat Minecraft 26.1 (mineflayer ondersteunt 26.2 nog niet), de server draait 26.2, en ViaVersion/ViaBackwards vertalen daartussen. Op die server liep de pathfinder vast bij elke sprong van één blok omhoog en in elke bocht, terwijl vlakke grond, naar beneden en trappen wél gingen.

De pathfinder zelf is daar niet de schuldige: offline nagespeeld met dezelfde pathfinder, physics en `setMovements()` haalt de bot al die gevallen gewoon. Het verschil tussen wat wel en niet lukte is dat de bot bij een sprong en in een bocht zijwaarts tegen een blok aan botst (2-3 ticks bij één blok omhoog, zo'n 8 in een bocht), en op vlakke grond, naar beneden en op een trap nooit. Juist die botsing gaf mineflayer 4.38 niet door. Samen met twee andere dingen die een echte 26.1-client wel stuurt:

* **`hasHorizontalCollision`** in elk bewegingspakket: mineflayer stuurt altijd `false`. Nu gaat de echte waarde uit de physics mee.
* **`player_input`** met de ingedrukte toetsen: mineflayer stuurt dat alleen bij sluipen, en dan met alléén shift erin, waardoor de server vooruit, springen en sprinten als losgelaten zag. Nu gaat elke verandering mee, net als bij een gewone client.
* **`tick_end`** na elke tick: mineflayer stuurt het helemaal niet.

**Werking**
* Staat aan via `movementPackets.enabled` in `config.js`. Mocht een server er onverhoopt over struikelen, dan zet je het daar uit.
* Zet de server de bot tóch terug naar een eerdere plek (rubberbanding), dan komt dat in de log, bijvoorbeeld: `Server zette de bot 0.42 blok terug (...): botste=ja, in de lucht=ja, pad actief=ja`. Zo zie je na één testrondje of het nog gebeurt, en in welke situatie. Uit te zetten met `movementPackets.logSetbacks`.
* In een voertuig blijft hij van `player_input` af; daar stuurt mineflayer zelf mee.

## Datastructuren

De `data/` directory bevat statische informatie en parameters die door de features worden geraadpleegd:

### 🗂️ Categorieënwoordenboek (`data/categories.js`)

Dit bestand fungeert als de encyclopedie van de bot. Het vertaalt specifieke itemnamen (zoals `diamond_sword` of `stone_sword`) naar logische, overkoepelende groepen (zoals `zwaarden`). Het sorteersysteem gebruikt dit om te bepalen in welke kist een item thuishoort. 

**Hoe te gebruiken in-game**
* Dit is een configuratiebestand en vereist geen directe commando's. De regels worden op de achtergrond automatisch toegepast zodra je het commando `!sort` gebruikt.
* Als je nieuwe items uit een mod of toekomstige Minecraft-update wilt groeperen, voeg je simpelweg hier een nieuwe regel toe met een *Regular Expression* (Regex).

**Slimme Beveiligingen (Fail-safes)**
* **Strikte Hiërarchie (Top-down):** De regels worden strikt van boven naar beneden afgehandeld en de eerste treffer wint. Dit voorkomt overlappende fouten: een `pickaxe` eindigt bijvoorbeeld op de letters `axe`. Doordat de pikhouweel-regel bóven de bijl-regel staat, belanden ze nooit in de verkeerde kist.
* **Geen 'Overig'-categorie:** Items die door geen enkele regel worden herkend, krijgen bewust de waarde `null` in plaats van een mapje "overig". Hierdoor zal de sorteermodule deze items uitsluitend bij exact dezelfde items leggen, wat voorkomt dat één kist een onoverzichtelijke verzamelbak van willekeurige blokken wordt.
* **Dynamische Voedselherkenning:** Voedsel wordt niet via een hardgecodeerde lijst herkend, maar direct aan de interne Minecraft-engine (`registry.foodsByName`) gevraagd. Dit betekent dat nieuw voedsel in latere updates direct wordt herkend zonder de code aan te passen.
* **Giftige Uitzonderingen:** Rot vlees (`rotten_flesh`) en spinnenogen (`spider_eye`) worden door Minecraft gezien als eetbaar, maar staan in deze code hard ingecodeerd bóven de voedsel-regel. Hierdoor verhuizen ze netjes naar de `mobdrops`-kisten en belanden ze niet in je keukenkist.

**Stap-voor-stap Werking**
1. **Invoer:** De sorteermodule roept `categoryOf(registry, itemName)` aan voor een item in de inventaris.
2. **Evaluatie:** De bot loopt de lijst met regels af. Hij test de itemnaam tegen de Regex-patronen (bijv. eindigt het op `_bed` of begint het met `raw_`).
3. **Match:** Zodra een patroon of functie (zoals de voedselcheck) `true` teruggeeft, stopt het zoeken direct en retourneert het script de categorienaam.
4. **Fallback:** Is de hele lijst doorlopen zonder resultaat? Dan geeft het script `null` terug, waarna de sorteermodule terugvalt op exact-matchen.

### 🌱 Gewasregister & Landbouwlogica (`data/crops.js`)

Dit bestand vormt het agrarische brein van de bot. In plaats van in het landbouw-script eindeloze `if/else`-lijsten te maken, definieert dit register per gewas exact *hoe* het groeit, *wanneer* het rijp is, en *op welke manier* het geoogst moet worden.

**Hoe te gebruiken in-game**
* Dit bestand draait volledig op de achtergrond zodra je `!farm` gebruikt.
* Wil je een nieuw gewas uit een toekomstige Minecraft-update (of mods) toevoegen? Dan registreer je het hier in de `CROP_LIST` met de juiste categorie en eigenschappen, en geef je het een regel in `CROP_GROUPS` met de namen waarop het moet luisteren. De `farming.js` module snapt de rest dan vanzelf.
* **Gewasnamen (`CROP_GROUPS` / `findCropGroup`):** Hier staat per gewas onder welke namen je het in de chat kunt aanwijzen voor `!farm <gewas>` — Nederlands en Engels door elkaar (`tarwe`, `graan`, `wheat`), met spaties of underscores. Eén regel kan meerdere bloknamen bevatten, wat kelp, gloeibessen en de bekerplant nodig hebben: die bestaan uit twee blokken die allebei bij hetzelfde gewas horen.

**De Vier Oogstcategorieën**
* **`REPLANT` (Bv. Tarwe, Wortels, Cacao):** Breek het volgroeide blok en plant het gedefinieerde zaad direct terug. Bepaalt zelfs óf het op de grond moet (`below`) of tegen de zijkant van een boom (`side`).
* **`FRUIT` (Bv. Meloen, Pompoen):** Breek uitsluitend de vrucht. De stengel waaraan de vrucht groeide, wordt met rust gelaten.
* **`INTERACT` (Bv. Zoete Bessen):** Oogst het gewas met een rechtsklik. Het blok zelf wordt nooit fysiek gebroken.
* **`VERTICAL` (Bv. Suikerriet, Bamboes):** Breek het *tweede* blok van onderen. De voet van de plant blijft hierdoor intact zodat deze direct weer kan aangroeien.

**Slimme Beveiligingen (Fail-safes)**
* **De Absolute Zwarte Lijst (`NEVER_BREAK`):** Zelfs als er elders in de logica een berekeningsfout optreedt, weigert de bot categorisch om blokken uit deze lijst te breken. Stengels, onvolgroeide gewassen (zoals de `torchflower_crop`) en akkerland (`farmland`) zijn hierdoor 100% veilig.
* **Geavanceerde Rijpheidscheck (`ripeAtMaxAge`):** Block-states komen vanuit de server vaak als *string* (bijv. `"7"`) binnen. Deze module lost die verwarring veilig op. Voor complexe twee-hoge planten (zoals de *Pitcher Plant*) is de bot geprogrammeerd om heel specifiek naar de onderste helft te kijken.
* **Voorraadbeheer (`YIELD_ITEMS` & `SEED_ITEMS`):** Door expliciet te definiëren wat telt als oogst (Yield) en wat telt als zaaigoed (Seed), voorkomt de bot dat hij onbedoeld items dropt of weigert te herplanten.
  
### 🎵 Liedjesboek & Entertainment (`data/songs.js`)

Dit bestand is de muzikale bibliotheek van de bot. Het is een pure data-module die uitsluitend songteksten bevat en deze via een kleine 'wrapper' (omhullende code) beschikbaar stelt aan de andere systemen. Door deze grote blokken tekst af te scheiden van de actieve logica, blijft de hoofdcode van de bot schoon en overzichtelijk.

**Hoe te gebruiken in-game**
* **Zingen:** Typ `zing`, `zingen` of `muziek` in de algemene chat. De Chat-module raadpleegt vervolgens dit bestand en begint de zinnen stuk voor stuk in de chat te typen.
* **Liedjes toevoegen:** Je kunt de bot eenvoudig nieuwe liedjes leren door in dit bestand een nieuw `songBook.add('Titel', ['Regel 1', 'Regel 2'])` blok toe te voegen.

**Slimme Architectuur & Beveiligingen**
* **Object-Georiënteerd (OOP):** In plaats van een simpele, losse lijst met tekst te gebruiken, maakt dit script gebruik van strakke `Song` en `SongBook` classes. Dit maakt het ophalen van data voorspelbaar en gestructureerd.
* **Safe Randomizer (`getRandom`):** De bot kiest volautomatisch een willekeurig liedje uit de lijst. Mocht je per ongeluk alle liedjes uit de code verwijderen, dan crasht de bot niet dankzij een ingebouwde check die simpelweg `null` teruggeeft als de bibliotheek leeg is.

**Stap-voor-stap Werking**
1. **Verzoek:** De `chat.js` module hoort het woord "zing" in de chat en vraagt aan dit bestand om een liedje.
2. **Selectie:** De `SongBook` class pakt via wiskundige willekeur (`Math.random()`) een van de beschikbare nummers (zoals "I Got Bills" of "Stay").
3. **Uitlevering:** Het geselecteerde liedje wordt teruggestuurd naar de chat-module, die vervolgens met een subtiele vertraging (`SONG_LINE_DELAY`) de array met regels tekst in de Minecraft-wereld typt alsof hij echt aan het meezingen is.

## Onderliggende Architectuur & Libraries

Het project is robuust opgezet met externe afhankelijkheden en interne helper-scripts:

*   **Configuratie**: De algemene instellingen, servergegevens en bot-parameters worden beheerd vanuit `config.js`. Vrijwel elk getal dat in de beschrijvingen hierboven genoemd wordt (zoekstralen, wachttijden, drempels) staat daar en niet in de modules zelf.
*   **Gedeelde state (`state.js`)**: Eén object dat alle modules importeren, zodat een commando in de ene module een lus in de andere kan afbreken. Per taak geldt het drieluik `isX` (draait hij nu?), `stopX` (moet hij ophouden?) en `xSession` (welke run is de huidige?). `abortAllTasks()` uit `utils.js` zet dat drieluik in één keer terug — dat gebeurt bij `!stop`, bij de dood van de bot en bij een herverbinding.
*   **Helpers (`utils.js`)**: De gedeelde gereedschapskist. Hier staan onder andere `setMovements()` (de enige plek waar een `Movements`-object gemaakt wordt), `enforceNoBlockPlacing()` (die afdwingt dat géén enkele plugin de pathfinder blokken laat plaatsen), `hasPathTo()` (de padcheck vóór elke wandeling naar een kist, gewas, dier of dorpeling), de item-zoekers en `abortAllTasks()`. `hasPathTo()` rekent de zoektocht helemaal af: mineflayers eigen `getPathTo()` stopt na 40ms met status `partial`, en daardoor telde alles achter een muur of achterin een opslagruimte eerder als onbereikbaar.
*   **Watchers (`watchers/`)**: Zeven achtergrondprocessen die vanaf het spawnen meedraaien zonder commando — zie de sectie hierboven.
*   **Data (`data/`)**: Statische registers los van de logica: het gewasregister (`crops.js`), het sorteerwoordenboek (`categories.js`) en het liedjesboek (`songs.js`).
*   **Lib Directory**: Bevat gedeelde technische logica: `containers.js` (veilig kisten openen, sluiten en leegtrekken), `storage.js` (de kistenindex die de koerier en de sorteerder gebruiken) en `movementPackets.js` (de bewegingspakketten die mineflayer bij 26.1 zelf niet goed stuurt, zie hierboven).
*   **Node Modules**: De directe afhankelijkheden (zie `package.json`) zijn `mineflayer`, `mineflayer-pathfinder`, `mineflayer-auto-eat`, `mineflayer-collectblock`, `mineflayer-armor-manager`, `mineflayer-pvp` en `vec3`. Pakketten als `@nxg-org/mineflayer-util-plugin`, `protodef-validator` en `@azure/msal-node` (voor de Microsoft-authenticatie) zitten ook in `node_modules`, maar zijn transitieve afhankelijkheden van Mineflayer zelf — dit project roept ze niet rechtstreeks aan.

## 🚀 Installatie & Configuratie

Volg de onderstaande stappen om de bot succesvol te installeren, te configureren en te laten verbinden met jouw server.

### Stap 1: Vereisten (Prerequisites)
Om deze bot te kunnen draaien, moet **Node.js** (inclusief `npm`) op je systeem geïnstalleerd zijn. Je kunt controleren of je dit al hebt door je terminal of command prompt te openen en het volgende te typen:
```bash
node -v
npm -v
```

### Stap 2: Dependencies installeren
Download of clone dit project, open een terminal in de projectmap en installeer de benodigde npm-pakketten:
```bash
npm install
```

### Stap 3: Server instellen (`config.js`)
De verbindingsgegevens staan niet in een los `.env`-bestand, maar direct in het `server`-blok bovenaan `config.js`:
```js
server: {
  host: 'localhost',
  port: 25565,
  auth: 'microsoft',
  version: '26.1',
},
```
`version` blijft `'26.1'`, ook als de server nieuwer is: mineflayer ondersteunt 26.2 nog niet. Draait de server 26.2, dan heeft hij ViaVersion en ViaBackwards nodig om de 26.1-bot binnen te laten. Wat de bot daarbij extra meestuurt om goed te kunnen springen en de hoek om te gaan, staat onder *Bewegingspakketten* (`lib/movementPackets.js`).

Pas `host` en `port` aan naar het adres van jouw Minecraft-server. Laat `auth: 'microsoft'` staan als je met een Microsoft-account inlogt; zet dit op `'offline'` voor een offline-mode/cracked server. Alle overige gedragsinstellingen (zoektstralen, timeouts, drempels per feature) staan verderop in datzelfde bestand.

### Stap 4: De bot starten
Start de bot vanuit de projectmap met:
```bash
npm start
```
Bij `auth: 'microsoft'` en de eerste keer inloggen toont de terminal een code en een URL (`microsoft.com/link`). Log daarmee eenmalig in via een browser; het inlogtoken wordt daarna lokaal gecachet, zodat je dit niet bij elke herstart hoeft te herhalen.

### Stap 5: In-game gebruiken
Zodra de bot in de wereld staat, kun je hem aansturen met de commando's uit de secties hierboven. Typ `!help` in de chat voor een overzicht, en `!stop` werkt altijd als directe noodrem.

Een paar dingen doet hij uit zichzelf, zonder commando: deuren openen en hekken sluiten, iedereen begroeten die inlogt, omhoog zwemmen als hij dreigt te verdrinken, terugvechten als een monster hem aanvalt, een creeper tussen de 10 en 16 blokken beschieten als ze een boog en pijlen bij zich heeft, en — bij een creeper binnen tien blokken — in de chat om hulp roepen en een minuutje uitloggen. Breekt er onderweg gereedschap uit haar hand, dan meldt ze dat ook meteen in de chat. Verdwijnt hij plotseling van de server, kijk dan dus eerst even in de chat. Een taak die op dat moment liep (`!farm`, `!tunnel`) begint na het opnieuw inloggen niet vanzelf weer.

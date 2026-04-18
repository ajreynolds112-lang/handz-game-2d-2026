import type { Archetype } from "./types";

export interface RosterEntry {
  id: number;
  firstName: string;
  nickname: string;
  lastName: string;
  archetype: Archetype;
  isKeyFighter: boolean;
  forceUndefeated: boolean;
  fixedRank?: number;
}

const A: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];

function assignArch(id: number): Archetype {
  const patterns: Record<number, Archetype> = {
    1: "BoxerPuncher", 2: "OutBoxer", 3: "Brawler", 4: "Swarmer",
    5: "Brawler", 6: "BoxerPuncher", 7: "OutBoxer", 8: "Swarmer",
    41: "OutBoxer", 131: "Brawler", 152: "BoxerPuncher", 166: "Brawler",
    197: "OutBoxer", 204: "BoxerPuncher",
  };
  if (patterns[id]) return patterns[id];
  return A[(id * 7 + 3) % 4];
}

function parseEntry(id: number, raw: string): RosterEntry {
  const nicknameMatch = raw.match(/"([^"]+)"/);
  const nickname = nicknameMatch ? nicknameMatch[1] : "";
  const withoutNickname = raw.replace(/"[^"]+"\s*/, "").trim();
  const parts = withoutNickname.split(/\s+/);
  const firstName = parts[0] || "";
  const lastName = parts.slice(1).join(" ") || "";

  const KEY_IDS = [1, 41, 131, 152, 166, 197, 204];
  const isKey = KEY_IDS.includes(id);

  return {
    id,
    firstName,
    nickname,
    lastName,
    archetype: assignArch(id),
    isKeyFighter: isKey,
    forceUndefeated: isKey,
    fixedRank: id === 204 ? 1 : undefined,
  };
}

export const ROSTER_DATA: RosterEntry[] = [
  parseEntry(1, 'Mario Holmes'),
  parseEntry(2, 'Andre "Iron Pulse" Vega'),
  parseEntry(3, 'Darius Knox'),
  parseEntry(4, 'Leon "Southpaw Phantom" Cruz'),
  parseEntry(5, 'Vlad Furyk'),
  parseEntry(6, 'Marvin "Night Engine" Carter'),
  parseEntry(7, 'Rafael Stone'),
  parseEntry(8, 'Julian "Quick Verdict" Price'),
  parseEntry(9, 'DeShawn Wildero'),
  parseEntry(10, 'Victor "Riot Hook" Salazar'),
  parseEntry(11, 'Caleb Johnson'),
  parseEntry(12, 'Roman "Cold Equation" Petrov'),
  parseEntry(13, 'Terrence Maystorm'),
  parseEntry(14, 'Isaiah "Flashpoint" Reed'),
  parseEntry(15, 'Dominic Vance'),
  parseEntry(16, 'Hector "Grim Tempo" Ruiz'),
  parseEntry(17, 'Lennox Alvarado'),
  parseEntry(18, 'Quentin "Razor Choir" Banks'),
  parseEntry(19, 'Omar Briggs'),
  parseEntry(20, 'Xavier "Blackout Theory" Shaw'),
  parseEntry(21, 'Anthony Kovalevson'),
  parseEntry(22, 'Gabriel "Velvet Hammer" King'),
  parseEntry(23, 'Jamal Ortiz'),
  parseEntry(24, 'Nikolai "Red Comet" Sokolov'),
  parseEntry(25, 'Brandon Hale'),
  parseEntry(26, 'Elias "Bone Collector" Ward'),
  parseEntry(27, 'Curtis Bennett'),
  parseEntry(28, 'Dante "Chrome Fist" Morales'),
  parseEntry(29, 'Floydrick Caneloza'),
  parseEntry(30, 'Adrian "Sudden Silence" Cole'),
  parseEntry(31, 'Trevor Lang'),
  parseEntry(32, 'Micah "Ghost Ledger" Boone'),
  parseEntry(33, 'Sergio Dalton'),
  parseEntry(34, 'Byron "Crimson Orbit" Hayes'),
  parseEntry(35, 'Peter Grant'),
  parseEntry(36, 'Khalil "War Psalm" Hodge'),
  parseEntry(37, 'Ruben Castillo'),
  parseEntry(38, 'Marcus "Hard Reset" Doyle'),
  parseEntry(39, 'Edwin Brooks'),
  parseEntry(40, 'Theo "Ivory Avalanche" Laurent'),
  parseEntry(41, 'Calvin Price'),
  parseEntry(42, 'Zaire "Midnight Verdict" Okoye'),
  parseEntry(43, 'Harold Finch'),
  parseEntry(44, 'Nico "Switchblade" Marquez'),
  parseEntry(45, 'Michael "Steel Mirage" Barrow'),
  parseEntry(46, 'Aaron Pike'),
  parseEntry(47, 'Ian Fletcher'),
  parseEntry(48, 'Shawn Porterfield'),
  parseEntry(49, 'Devon Mercer'),
  parseEntry(50, 'Victor "Iron Sabbath" Kane'),
  parseEntry(51, 'Connor Blake'),
  parseEntry(52, 'Terrence Cole'),
  parseEntry(53, 'Ryan O\'Connell'),
  parseEntry(54, 'Andre "Zero Mercy" Baptiste'),
  parseEntry(55, 'Stefan Ionescu'),
  parseEntry(56, 'Darius "Black Templar" Graves'),
  parseEntry(57, 'Miguel Santos'),
  parseEntry(58, 'Jamal "Heatwave Prophet" Bishop'),
  parseEntry(59, 'Trevor Mills'),
  parseEntry(60, 'Isaiah "Rogue Current" Maddox'),
  parseEntry(61, 'Roland Pierce'),
  parseEntry(62, 'Hector "Silent Riot" Navarro'),
  parseEntry(63, 'Samuel Turner'),
  parseEntry(64, 'Leon "Graveyard Shift" Booker'),
  parseEntry(65, 'Vincent Cole'),
  parseEntry(66, 'Arman "Titan Echo" Petrosyan'),
  parseEntry(67, 'Curtis Shaw'),
  parseEntry(68, 'DeAndre "Voltage Viper" Quinn'),
  parseEntry(69, 'Felix Moreno'),
  parseEntry(70, 'Terrence "Savage Arithmetic" Sloan'),
  parseEntry(71, 'Bradley Kent'),
  parseEntry(72, 'Roman "Nightfall Atlas" Volkov'),
  parseEntry(73, 'Shawn Ellis'),
  parseEntry(74, 'Darnell "Iron Howl" Briggs'),
  parseEntry(75, 'Patrick Doyle'),
  parseEntry(76, 'Zane "Obsidian Halo" Cross'),
  parseEntry(77, 'Henry Collins'),
  parseEntry(78, 'Dante "Solar Flare" Whitaker'),
  parseEntry(79, 'Oscar DeLomachenko'),
  parseEntry(80, 'Thomas "Storm Cipher" Ramsey'),
  parseEntry(81, 'Jason Reed'),
  parseEntry(82, 'Rafael "Cinder King" Alvarez'),
  parseEntry(83, 'Corey Mitchell'),
  parseEntry(84, 'Andre "Velcro Jab" Hudson'),
  parseEntry(85, 'Nathan Brooks'),
  parseEntry(86, 'Isaiah "Blood Moon" Carter'),
  parseEntry(87, 'Tyler Grant'),
  parseEntry(88, 'Dominic "Rogue Doctrine" Silva'),
  parseEntry(89, 'Caleb Ross'),
  parseEntry(90, 'Viktor "Hammer Doctrine" Kravtsov'),
  parseEntry(91, 'Julian Harper'),
  parseEntry(92, 'Xavier "Shock Sermon" Tate'),
  parseEntry(93, 'Brian Foster'),
  parseEntry(94, 'Lennox "Granite Gospel" Wright'),
  parseEntry(95, 'Eric Dawson'),
  parseEntry(96, 'Omar "Thunder Psalm" Haddad'),
  parseEntry(97, 'Cody Marshall'),
  parseEntry(98, 'Cody "Neptune Knuckles" Thomas'),
  parseEntry(99, 'George Hill'),
  parseEntry(100, 'Andre "Black Ice" Monroe'),
  parseEntry(101, 'Scott Jenkins'),
  parseEntry(102, 'Marcus "Grim Symphony" Rowe'),
  parseEntry(103, 'Daniel Price'),
  parseEntry(104, 'Hector "Atlas Breaker" Dominguez'),
  parseEntry(105, 'Kevin Ward'),
  parseEntry(106, 'Leon "Tempest Choir" Maddox'),
  parseEntry(107, 'Chris Nolan'),
  parseEntry(108, 'Darius "Riot Architect" Sloan'),
  parseEntry(109, 'Matthew Cole'),
  parseEntry(110, 'Jamal "Midnight Furnace" Ellis'),
  parseEntry(111, 'Brandon Scott'),
  parseEntry(112, 'Roman "Ivory Execution" Dragunov'),
  parseEntry(113, 'Luke Perry'),
  parseEntry(114, 'Caleb "Stone Prophet" Hayes'),
  parseEntry(115, 'Michael Torres'),
  parseEntry(116, 'Andre "Phantom Pressure" Knox'),
  parseEntry(117, 'Anthony Furyweather'),
  parseEntry(118, 'Zaire "Dark Matter" King'),
  parseEntry(119, 'Thomas Reed'),
  parseEntry(120, 'Ezekiel "Voltage Requiem" Stone'),
  parseEntry(121, 'Paul Harris'),
  parseEntry(122, 'Hector "Brass Tyrant" Vega'),
  parseEntry(123, 'Jonathan Clark'),
  parseEntry(124, 'Leon "North Star Nightmare" Cruz'),
  parseEntry(125, 'David Turner'),
  parseEntry(126, 'Dante "Black Cathedral" Vance'),
  parseEntry(127, 'Mark Lewis'),
  parseEntry(128, 'Nathan "Spider" Romanov'),
  parseEntry(129, 'Jason Clark'),
  parseEntry(130, 'Isaiah "Grim Static" Boone'),
  parseEntry(131, 'Steven Smith'),
  parseEntry(132, 'Rafael "Iron Oracle" Castillo'),
  parseEntry(133, 'Steven Moore'),
  parseEntry(134, 'Andre "Savage Paradox" Bennett'),
  parseEntry(135, 'Adam White'),
  parseEntry(136, 'Darius "War Algorithm" Price'),
  parseEntry(137, 'Kyle Young'),
  parseEntry(138, 'Brett "Chrome Tempest" Reed'),
  parseEntry(139, 'Justin Hall'),
  parseEntry(140, 'Leon "Ghost Hammer" Shaw'),
  parseEntry(141, 'Eric Brown'),
  parseEntry(142, 'Roman "Cold Blood Opera" Sidorov'),
  parseEntry(143, 'Nathan Green'),
  parseEntry(144, 'Jamal "Oblivion Hook" Pierce'),
  parseEntry(145, 'Aaron Scott'),
  parseEntry(146, 'Hector "Iron Eclipse" Navarro'),
  parseEntry(147, 'Kevin Lee Jr.'),
  parseEntry(148, 'Dante "Static Titan" Brooks'),
  parseEntry(149, 'Brian King'),
  parseEntry(150, 'Gray "Blackout" Mercer'),
  parseEntry(151, 'Chris Evans'),
  parseEntry(152, 'Andre "Night Engine X" Carter'),
  parseEntry(153, 'Victor Drago Jr.'),
  parseEntry(154, 'Nick "Quantum Knuckle" Zaire'),
  parseEntry(155, 'Leonidas "Starlight Mauler" Rex'),
  parseEntry(156, 'Orion "Galactic Bruiser" Voss'),
  parseEntry(157, 'Ezekiel "Thunder Gospel" Cain'),
  parseEntry(158, 'Atlas Stone'),
  parseEntry(159, 'Phoenix "Solar Executioner" Raines'),
  parseEntry(160, 'Nova "Meteor Jab" Kade'),
  parseEntry(161, 'Magnus "Iron Seraph" Voltaire'),
  parseEntry(162, 'Ajax Fury'),
  parseEntry(163, 'Darius "Emerald Guillotine" Vale'),
  parseEntry(164, 'Andre "Crimson Theory" Locke'),
  parseEntry(165, 'Nick "Ivory Rapture" Knox'),
  parseEntry(166, 'Leon "Iron" Ward'),
  parseEntry(167, 'Richard "Gravity" Briggs'),
  parseEntry(168, 'Hector "Mirage" Cruz'),
  parseEntry(169, 'Roman "Orbit" Petrov'),
  parseEntry(170, 'Jamal "The Sun" Carter'),
  parseEntry(171, 'Caleb "Granite Phantom" Ross'),
  parseEntry(172, 'Rafael "Cinder Prophet" Morales'),
  parseEntry(173, 'Andre Bennett'),
  parseEntry(174, 'Esteban Ochoa'),
  parseEntry(175, 'Leon Cruz'),
  parseEntry(176, 'Hector Ruiz'),
  parseEntry(177, 'Roman Petrov'),
  parseEntry(178, 'Jamal Bishop'),
  parseEntry(179, 'Caleb Ward'),
  parseEntry(180, 'Rafael Stone'),
  parseEntry(181, 'Hugo Kane'),
  parseEntry(182, 'Dante Morales'),
  parseEntry(183, 'Isaiah Reed'),
  parseEntry(184, 'Victor Salazar'),
  parseEntry(185, 'Marcus Doyle'),
  parseEntry(186, 'Omar Haddad'),
  parseEntry(187, 'Zane Cross'),
  parseEntry(188, 'Darius Knox'),
  parseEntry(189, 'Frank Stroud'),
  parseEntry(190, 'Andre Hudson'),
  parseEntry(191, 'Leon Booker'),
  parseEntry(192, 'Hector Dominguez'),
  parseEntry(193, 'Roman Volkov'),
  parseEntry(194, 'Jamal Sloan'),
  parseEntry(195, 'Caleb Hayes'),
  parseEntry(196, 'Rafael Alvarez'),
  parseEntry(197, 'Floyd Vale'),
  parseEntry(198, 'Dante Whitaker'),
  parseEntry(199, 'Isaiah Carter'),
  parseEntry(200, 'Malik Ramsey'),
  parseEntry(201, 'Andre Baptiste'),
  parseEntry(202, 'Leon Maddox'),
  parseEntry(203, 'Nino "Nightmare" Black'),
  parseEntry(204, 'Wolfgang "Superman" Aruzenai Jr.'),
];

export const KEY_FIGHTER_IDS = [1, 41, 131, 152, 166, 197, 204];
export const TOTAL_ROSTER = 204;
export const ACTIVE_ROSTER_SIZE = 150;
export const WEEKLY_FIGHT_COUNT = 100;

export function getRosterDisplayName(entry: RosterEntry, state?: { customFirstName?: string; customNickname?: string; customLastName?: string }): string {
  const first = state?.customFirstName ?? entry.firstName;
  const nick = state?.customNickname ?? entry.nickname;
  const last = state?.customLastName ?? entry.lastName;
  if (nick) {
    return `${first} "${nick}" ${last}`;
  }
  return `${first} ${last}`;
}

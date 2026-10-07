// @ts-nocheck
/**
 * @fileoverview Trivia question sourcing — Open Trivia DB API with local fallback.
 *
 * Fetches questions from opentdb.com (free, no API key needed).
 * Falls back to a curated local bank when the API is down.
 * Supports categories, difficulty levels, and a daily challenge.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard';

export type TriviaCategory = {
  id: number;
  name: string;
  emoji: string;
};

export type TriviaQuestion = {
  id: string;
  question: string;
  choices: [string, string, string, string];
  answerIndex: 0 | 1 | 2 | 3;
  explanation: string;
  category: string;
  difficulty: Difficulty;
  source: 'opentdb' | 'local';
};

// ── Categories ──────────────────────────────────────────────────────────────

export const TRIVIA_CATEGORIES: TriviaCategory[] = [
  { id: 9, name: 'General Knowledge', emoji: '🧠' },
  { id: 17, name: 'Science & Nature', emoji: '🔬' },
  { id: 18, name: 'Computers', emoji: '💻' },
  { id: 23, name: 'History', emoji: '📜' },
  { id: 22, name: 'Geography', emoji: '🌍' },
  { id: 11, name: 'Film', emoji: '🎬' },
  { id: 14, name: 'Television', emoji: '📺' },
  { id: 12, name: 'Music', emoji: '🎵' },
  { id: 15, name: 'Video Games', emoji: '🎮' },
  { id: 21, name: 'Sports', emoji: '⚽' },
  { id: 25, name: 'Art', emoji: '🎨' },
  { id: 20, name: 'Mythology', emoji: '⚡' },
  { id: 27, name: 'Animals', emoji: '🐾' },
  { id: 19, name: 'Mathematics', emoji: '🔢' },
  { id: 24, name: 'Politics', emoji: '🏛️' },
  { id: 26, name: 'Celebrities', emoji: '⭐' },
  { id: 10, name: 'Books', emoji: '📚' },
];

export function categoryByName(name: string): TriviaCategory | undefined {
  const lower = name.toLowerCase().trim();
  return TRIVIA_CATEGORIES.find(
    (c) =>
      c.name.toLowerCase() === lower ||
      c.name.toLowerCase().includes(lower) ||
      lower.includes(c.name.toLowerCase().split(' ')[0]!),
  );
}

// ── Difficulty points ───────────────────────────────────────────────────────

export const DIFFICULTY_POINTS: Record<Difficulty, number> = {
  easy: 10,
  medium: 25,
  hard: 50,
};

// ── Trivia Levels ───────────────────────────────────────────────────────────

export type TriviaLevel = {
  level: number;
  name: string;
  emoji: string;
  minPoints: number;
};

/**
 * Trivia levels — exponential curve for long-term progression.
 *
 * At ~25 pts/question average (medium difficulty):
 *   L1→L2:   20 questions    (~1 session)
 *   L2→L3:   40 more         (~2 sessions)
 *   L3→L4:   80 more         (~1 day)
 *   L4→L5:  140 more         (~2-3 days)
 *   L5→L6:  240 more         (~1 week)
 *   L6→L7:  400 more         (~2 weeks)
 *   L7→L8:  600 more         (~1 month)
 *   L8→L9: 1000 more         (~2 months)
 *   L9→L10: 2000+ more       (~6+ months, prestige)
 */
export const TRIVIA_LEVELS: TriviaLevel[] = [
  { level: 1,  name: 'Trivia Novice',      emoji: '🌱', minPoints: 0 },
  { level: 2,  name: 'Quiz Apprentice',     emoji: '📖', minPoints: 500 },
  { level: 3,  name: 'Knowledge Seeker',    emoji: '🔍', minPoints: 1_500 },
  { level: 4,  name: 'Lore Keeper',         emoji: '📜', minPoints: 3_500 },
  { level: 5,  name: 'Trivia Adept',        emoji: '⚡', minPoints: 7_000 },
  { level: 6,  name: 'Quiz Master',         emoji: '🎯', minPoints: 13_000 },
  { level: 7,  name: 'Sage',                emoji: '🧙', minPoints: 23_000 },
  { level: 8,  name: 'Oracle',              emoji: '🔮', minPoints: 38_000 },
  { level: 9,  name: 'Grandmaster',         emoji: '🏆', minPoints: 63_000 },
  { level: 10, name: 'Omniscient',          emoji: '👑', minPoints: 113_000 },
];

export function triviaLevelForPoints(points: number): TriviaLevel {
  for (let i = TRIVIA_LEVELS.length - 1; i >= 0; i--) {
    if (points >= TRIVIA_LEVELS[i]!.minPoints) return TRIVIA_LEVELS[i]!;
  }
  return TRIVIA_LEVELS[0]!;
}

export function nextTriviaLevel(points: number): TriviaLevel | null {
  const current = triviaLevelForPoints(points);
  const next = TRIVIA_LEVELS.find((l) => l.level === current.level + 1);
  return next ?? null;
}

// ── HTML entity decoder ─────────────────────────────────────────────────────

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&apos;': "'",
  '&laquo;': '«',
  '&raquo;': '»',
  '&ldquo;': '\u201c',
  '&rdquo;': '\u201d',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&ndash;': '\u2013',
  '&mdash;': '\u2014',
  '&hellip;': '\u2026',
  '&shy;': '',
  '&eacute;': 'é',
  '&Eacute;': 'É',
  '&ouml;': 'ö',
  '&uuml;': 'ü',
};

function decodeHtml(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    while (out.includes(entity)) out = out.replace(entity, char);
  }
  // Handle numeric entities: &#123; or &#x1F;
  out = out.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return out;
}

// ── Open Trivia DB fetch ────────────────────────────────────────────────────

interface OpenTDBResult {
  category: string;
  type: string;
  difficulty: string;
  question: string;
  correct_answer: string;
  incorrect_answers: string[];
}

/** Fetch a batch of questions from Open Trivia DB. */
export async function fetchOpenTDB(
  amount: number,
  category?: number,
  difficulty?: Difficulty,
): Promise<TriviaQuestion[]> {
  const params = new URLSearchParams({
    amount: String(amount),
    type: 'multiple', // always 4-choice
  });
  if (category != null) params.set('category', String(category));
  if (difficulty) params.set('difficulty', difficulty);

  const url = `https://opentdb.com/api.php?${params}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { response_code: number; results: OpenTDBResult[] };
    if (data.response_code !== 0 || !Array.isArray(data.results)) return [];

    return data.results.map((r, i) => {
      const correct = decodeHtml(r.correct_answer);
      const incorrect = r.incorrect_answers.map(decodeHtml);
      // Shuffle answer position
      const answerIndex = Math.floor(Math.random() * 4) as 0 | 1 | 2 | 3;
      const choices: string[] = [...incorrect];
      choices.splice(answerIndex, 0, correct);

      return {
        id: `otdb-${Date.now()}-${i}`,
        question: decodeHtml(r.question),
        choices: choices.slice(0, 4) as [string, string, string, string],
        answerIndex,
        explanation: `The correct answer is: ${correct}`,
        category: decodeHtml(r.category),
        difficulty: (r.difficulty as Difficulty) || 'medium',
        source: 'opentdb' as const,
      };
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ── Question cache ──────────────────────────────────────────────────────────

/**
 * Questions fetched from Open Trivia DB in batches, so /trivia does not call the API every time.
 * The first request for a question starts the first fetch; loading the module sends none.
 */
const questionBuffer: TriviaQuestion[] = [];
let lastFetchMs = 0;
const FETCH_COOLDOWN_MS = 10_000; // Don't hammer the API

async function refillBuffer(): Promise<void> {
  if (Date.now() - lastFetchMs < FETCH_COOLDOWN_MS) return;
  lastFetchMs = Date.now();
  const batch = await fetchOpenTDB(20);
  if (batch.length > 0) {
    questionBuffer.push(...batch);
    // Cap buffer at 100
    if (questionBuffer.length > 100) questionBuffer.splice(0, questionBuffer.length - 100);
  }
}

// ── Local fallback bank ─────────────────────────────────────────────────────

const LOCAL_BANK: TriviaQuestion[] = [
  {
    id: 'local-science-1',
    question: 'What is the chemical symbol for gold?',
    choices: ['Go', 'Gd', 'Au', 'Ag'],
    answerIndex: 2,
    explanation: 'Au comes from the Latin word "aurum" meaning gold.',
    category: 'Science & Nature',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-history-1',
    question: 'In what year did the Berlin Wall fall?',
    choices: ['1987', '1989', '1991', '1993'],
    answerIndex: 1,
    explanation: 'The Berlin Wall fell on November 9, 1989.',
    category: 'History',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-geo-1',
    question: 'What is the smallest country in the world by area?',
    choices: ['Monaco', 'Vatican City', 'San Marino', 'Liechtenstein'],
    answerIndex: 1,
    explanation: 'Vatican City is approximately 0.44 km², making it the smallest country.',
    category: 'Geography',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-film-1',
    question: 'Who directed "2001: A Space Odyssey"?',
    choices: ['Steven Spielberg', 'Stanley Kubrick', 'Ridley Scott', 'George Lucas'],
    answerIndex: 1,
    explanation: 'Stanley Kubrick directed 2001: A Space Odyssey, released in 1968.',
    category: 'Film',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-music-1',
    question: 'Which band released the album "The Dark Side of the Moon"?',
    choices: ['Led Zeppelin', 'The Beatles', 'Pink Floyd', 'The Rolling Stones'],
    answerIndex: 2,
    explanation: 'Pink Floyd released The Dark Side of the Moon in 1973.',
    category: 'Music',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-games-1',
    question: 'What was the first commercially successful video game?',
    choices: ['Pac-Man', 'Space Invaders', 'Pong', 'Tetris'],
    answerIndex: 2,
    explanation: 'Pong, released by Atari in 1972, was the first commercially successful video game.',
    category: 'Video Games',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-myth-1',
    question: 'In Greek mythology, who is the god of the sea?',
    choices: ['Zeus', 'Hades', 'Poseidon', 'Apollo'],
    answerIndex: 2,
    explanation: 'Poseidon is the Greek god of the sea, earthquakes, and horses.',
    category: 'Mythology',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-animals-1',
    question: 'What is the fastest land animal?',
    choices: ['Lion', 'Cheetah', 'Pronghorn', 'Greyhound'],
    answerIndex: 1,
    explanation: 'The cheetah can reach speeds of up to 70 mph (112 km/h).',
    category: 'Animals',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-art-1',
    question: 'Who painted the ceiling of the Sistine Chapel?',
    choices: ['Leonardo da Vinci', 'Raphael', 'Michelangelo', 'Donatello'],
    answerIndex: 2,
    explanation: 'Michelangelo painted the Sistine Chapel ceiling between 1508 and 1512.',
    category: 'Art',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-sports-1',
    question: 'How many players are on a standard soccer team on the field?',
    choices: ['9', '10', '11', '12'],
    answerIndex: 2,
    explanation: 'A soccer team has 11 players on the field, including the goalkeeper.',
    category: 'Sports',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-math-1',
    question: 'What is the value of Pi to two decimal places?',
    choices: ['3.12', '3.14', '3.16', '3.18'],
    answerIndex: 1,
    explanation: 'Pi (π) is approximately 3.14159...',
    category: 'Mathematics',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-computers-1',
    question: 'What does "HTTP" stand for?',
    choices: [
      'HyperText Transfer Protocol',
      'High Throughput Transfer Process',
      'Hyper Terminal Transport Protocol',
      'Host Transfer Text Protocol',
    ],
    answerIndex: 0,
    explanation: 'HTTP = HyperText Transfer Protocol, the foundation of web communication.',
    category: 'Computers',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-books-1',
    question: 'Who wrote "1984"?',
    choices: ['Aldous Huxley', 'Ray Bradbury', 'George Orwell', 'Philip K. Dick'],
    answerIndex: 2,
    explanation: 'George Orwell (Eric Arthur Blair) published 1984 in 1949.',
    category: 'Books',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-tv-1',
    question: 'What is the longest-running animated TV series in the US?',
    choices: ['Family Guy', 'South Park', 'The Simpsons', 'SpongeBob SquarePants'],
    answerIndex: 2,
    explanation: 'The Simpsons has been on air since 1989, making it the longest-running animated series.',
    category: 'Television',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-science-2',
    question: 'What planet has the most moons in our solar system?',
    choices: ['Jupiter', 'Saturn', 'Uranus', 'Neptune'],
    answerIndex: 1,
    explanation: 'Saturn has over 140 confirmed moons, more than any other planet.',
    category: 'Science & Nature',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-history-2',
    question: 'Which ancient civilization built Machu Picchu?',
    choices: ['Aztec', 'Maya', 'Inca', 'Olmec'],
    answerIndex: 2,
    explanation: 'Machu Picchu was built by the Inca civilization in the 15th century.',
    category: 'History',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-paranormal-1',
    question: 'In what year was the Roswell UFO incident?',
    choices: ['1942', '1947', '1952', '1961'],
    answerIndex: 1,
    explanation: 'The Roswell incident occurred in July 1947 near Roswell, New Mexico.',
    category: 'General Knowledge',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-paranormal-2',
    question: 'The Bermuda Triangle is located in which ocean?',
    choices: ['Pacific', 'Indian', 'Atlantic', 'Arctic'],
    answerIndex: 2,
    explanation: 'The Bermuda Triangle is in the western part of the North Atlantic Ocean.',
    category: 'General Knowledge',
    difficulty: 'easy',
    source: 'local',
  },
  {
    id: 'local-horror-1',
    question: 'Which horror author created Cthulhu?',
    choices: ['Stephen King', 'H.P. Lovecraft', 'Edgar Allan Poe', 'Bram Stoker'],
    answerIndex: 1,
    explanation: 'H.P. Lovecraft created Cthulhu in his 1928 short story "The Call of Cthulhu".',
    category: 'Books',
    difficulty: 'medium',
    source: 'local',
  },
  {
    id: 'local-crypto-1',
    question: 'What is the maximum supply of Bitcoin?',
    choices: ['10 million', '21 million', '100 million', 'Unlimited'],
    answerIndex: 1,
    explanation: 'Bitcoin has a hard cap of 21 million coins, enforced by its protocol.',
    category: 'General Knowledge',
    difficulty: 'medium',
    source: 'local',
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get a random trivia question. Tries the API buffer first, falls back to local.
 * Optionally filters by category and difficulty.
 */
export async function getQuestion(
  category?: string,
  difficulty?: Difficulty,
): Promise<TriviaQuestion> {
  // Try to get from API with specific params
  if (category || difficulty) {
    const cat = category ? categoryByName(category) : undefined;
    const fetched = await fetchOpenTDB(1, cat?.id, difficulty);
    if (fetched.length > 0) return fetched[0]!;
  }

  // Try buffer
  if (questionBuffer.length > 0) {
    let filtered = questionBuffer;
    if (difficulty) filtered = filtered.filter((q) => q.difficulty === difficulty);
    if (filtered.length > 0) {
      const idx = Math.floor(Math.random() * filtered.length);
      const q = filtered[idx]!;
      questionBuffer.splice(questionBuffer.indexOf(q), 1);
      // Trigger background refill when buffer gets low
      if (questionBuffer.length < 5) void refillBuffer();
      return q;
    }
  }

  // Background refill for next time
  void refillBuffer();

  // Fallback to local
  let pool = LOCAL_BANK;
  if (difficulty) pool = pool.filter((q) => q.difficulty === difficulty);
  if (pool.length === 0) pool = LOCAL_BANK;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

// ── Daily Challenge ─────────────────────────────────────────────────────────

let dailyQuestion: TriviaQuestion | null = null;
let dailyDateKey = '';

/** Get today's daily challenge (same question for everyone). */
export async function getDailyQuestion(): Promise<TriviaQuestion> {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyDateKey === today && dailyQuestion) return dailyQuestion;

  // Fetch a hard question for the daily
  const fetched = await fetchOpenTDB(1, undefined, 'hard');
  if (fetched.length > 0) {
    dailyQuestion = { ...fetched[0]!, id: `daily-${today}` };
  } else {
    const hard = LOCAL_BANK.filter((q) => q.difficulty !== 'easy');
    const pick = hard[Math.floor(Math.random() * hard.length)] ?? LOCAL_BANK[0]!;
    dailyQuestion = { ...pick, id: `daily-${today}`, difficulty: 'hard' };
  }
  dailyDateKey = today;
  return dailyQuestion;
}

/** For legacy compatibility. */
export function randomTriviaQuestion(): TriviaQuestion {
  if (questionBuffer.length > 0) {
    const q = questionBuffer.shift()!;
    if (questionBuffer.length < 5) void refillBuffer();
    return q;
  }
  void refillBuffer();
  return LOCAL_BANK[Math.floor(Math.random() * LOCAL_BANK.length)]!;
}

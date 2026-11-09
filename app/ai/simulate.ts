import type { OutputRule } from '../engine/schema.ts';
import { pick, seededRandom, shuffle } from './random.ts';

// A stand-in for a language model. It reads the input text the way a sloppy
// extractor would, and varies its answer by seed the way a real model varies
// between calls: wording, field order, confidence, and whether optional
// fields appear at all. It never leaves the declared output contract.

export interface ModelCall {
  /** AI_SEED for this server. Same seed + same call = same answer. */
  seed: string;
  stepId: string;
  prompt: string;
  input: string;
  output: Readonly<Record<string, OutputRule>>;
}

/** How often an optional field is left out. */
const OPTIONAL_FIELD_SKIP_RATE = 0.6;
/** How often a labelled number is "misread" as another number in the text. */
const MISREAD_RATE = 0.15;
/** How often a classifier ignores a keyword match and guesses. */
const KEYWORD_IGNORE_RATE = 0.3;

const wordings: readonly ((text: string) => string)[] = [
  (text) => text,
  (text) => text,
  (text) => text.toUpperCase(),
  (text) => text.toLowerCase(),
  (text) => text.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  (text) => `${text}.`,
];

/** "dueDate" → "due date", so labels in the text can be matched by field name. */
function labelFor(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The rest of a line like "Vendor: Northwind Paper Co", if the text has one. */
function labelled(input: string, field: string): string | undefined {
  const label = labelFor(field).replace(/\s+/g, '\\s+');
  const match = new RegExp(`^\\s*${label}[^:\\n]*:\\s*(.+?)\\s*$`, 'im').exec(input);
  return match?.[1];
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((match) =>
    Number(match[0].replace(/,/g, '')),
  );
}

function wordsIn(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function fitLength(text: string, rule: Extract<OutputRule, { type: 'string' }>): string {
  let fitted = rule.maxLength === undefined ? text : text.slice(0, rule.maxLength).trimEnd();
  const min = Math.max(rule.minLength ?? 0, rule.required ? 1 : 0);
  if (fitted.length < min) fitted = fitted.padEnd(min, '.');
  return fitted;
}

function generateString(
  field: string,
  rule: Extract<OutputRule, { type: 'string' }>,
  input: string,
  random: () => number,
): string {
  if (rule.allowed) {
    // A classifier: usually goes with an option the text mentions, sometimes guesses.
    const mentioned = rule.allowed.filter((option) =>
      input.toLowerCase().includes(option.toLowerCase()),
    );
    return mentioned.length > 0 && random() >= KEYWORD_IGNORE_RATE
      ? pick(mentioned, random)
      : pick(rule.allowed, random);
  }
  let base = labelled(input, field);
  if (base === undefined) {
    // Nothing labelled: paraphrase a slice of the text.
    const words = wordsIn(input);
    const start = Math.floor(random() * Math.max(1, words.length - 3));
    base = words.slice(start, start + 2 + Math.floor(random() * 4)).join(' ') || field;
  }
  return fitLength(pick(wordings, random)(base), rule);
}

function generateNumber(
  field: string,
  rule: Extract<OutputRule, { type: 'number' }>,
  input: string,
  random: () => number,
): number {
  if (rule.allowed) return pick(rule.allowed, random);
  const min = rule.min ?? 0;
  const max = rule.max ?? min + 1000;
  const line = labelled(input, field);
  const candidates = line === undefined ? [] : numbersIn(line);
  let value: number;
  if (candidates.length > 0) {
    const others = numbersIn(input);
    value =
      random() < MISREAD_RATE && others.length > 1 ? pick(others, random) : (candidates[0] ?? min);
  } else {
    value = min + random() * (max - min);
  }
  value = Math.min(max, Math.max(min, value));
  if (rule.decimals !== undefined) {
    const scale = 10 ** rule.decimals;
    value = Math.min(max, Math.max(min, Math.round(value * scale) / scale));
  }
  return value;
}

export function simulateModel(call: ModelCall): Record<string, unknown> {
  const random = seededRandom(`${call.seed}|${call.stepId}|${call.prompt}|${call.input}`);
  const response: Record<string, unknown> = {};
  // Field order varies between calls, as it does with real model output.
  for (const [field, rule] of shuffle(Object.entries(call.output), random)) {
    if (!rule.required && random() < OPTIONAL_FIELD_SKIP_RATE) continue;
    switch (rule.type) {
      case 'string':
        response[field] = generateString(field, rule, call.input, random);
        break;
      case 'number':
        response[field] = generateNumber(field, rule, call.input, random);
        break;
      case 'boolean':
        response[field] = random() < 0.5;
        break;
    }
  }
  return response;
}

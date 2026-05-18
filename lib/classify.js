/**
 * Goal classification — determines whether a goal is abstract (needs spec-coach)
 * or concrete (ready for execution).
 *
 * English-first with German + Russian i18n terms.
 * @module classify
 */

/**
 * Abstract goal indicators — suggest the goal is vague and needs clarification.
 * English-first, then German, then Russian.
 * @type {string[]}
 */
const ABSTRACT_TERMS = [
  // English
  'improve', 'better', 'optimize', 'refactor', 'enhance',
  'rework', 'concept', 'system', 'app', 'platform',
  'something', 'nicer', 'modern', 'perfect', 'finish',
  // German (brasco05 compat)
  'besser', 'verbessern', 'optimieren', 'überarbeiten', 'überarbeite',
  'konzept', 'plattform', 'irgendwas', 'schöner', 'perfekt', 'fertig',
  // Russian
  'улучшить', 'оптимизировать', 'переделать', 'сделать лучше',
];

/**
 * Concrete goal indicators — suggest the goal has clear deliverables.
 * English-first, then German, then Russian.
 * @type {string[]}
 */
const CONCRETE_TERMS = [
  // English
  'fix', 'create', 'build', 'implement', 'add',
  'remove', 'update', 'migrate', 'deploy', 'test',
  'validate', 'when', 'file', 'endpoint', 'function',
  'button', 'page', 'component', 'route',
  // German
  'baue', 'erstelle', 'fixe', 'behebe', 'lege',
  'validiere', 'teste', 'implementiere', 'datei',
  'endpoint', 'button', 'seite', 'funktion', 'wenn',
  'fertig wenn',
  // Russian
  'исправь', 'создай', 'добавь', 'реализуй', 'обнови',
  'удали', 'разверни', 'проверь', 'файл', 'функция',
];

/**
 * Regex pattern for validation hints in the goal text.
 * Matches words like "test", "verify", "done when", "acceptance", etc.
 * @type {RegExp}
 */
const VALIDATION_HINT_RE =
  /\b(test|valid|verify|check|pass|done when|acceptance|validier|prüf|fertig wenn|done wenn|akzeptanz|erfolg|провер|когда готово|критерий)\b/i;

/**
 * Classify a goal as abstract (needs spec-coach) or concrete (ready for execution).
 *
 * Heuristic rules:
 * 1. Very short goals (≤3 words) with no concrete terms → abstract
 * 2. Contains abstract terms but no concrete terms and no validation hints → abstract
 * 3. Everything else → concrete
 *
 * @param {string} goal - The goal text to classify
 * @returns {boolean} `true` if the goal is likely abstract (needs spec-coach)
 */
export function isLikelyAbstractGoal(goal) {
  const normalized = goal.trim().toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean);

  const hasAbstract = ABSTRACT_TERMS.some((t) => normalized.includes(t));
  const hasConcrete = CONCRETE_TERMS.some((t) => normalized.includes(t));
  const hasValidationHint = VALIDATION_HINT_RE.test(goal);

  // Rule 1: very short goals without concrete terms are abstract
  if (words.length <= 3 && !hasConcrete) return true;

  // Rule 2: abstract + no concrete + no validation = likely abstract
  if (hasAbstract && !hasConcrete && !hasValidationHint) return true;

  return false;
}
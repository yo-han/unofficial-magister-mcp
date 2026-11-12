import { Parser } from 'htmlparser2';
import { amsterdamDateOf, CalendarDate, formatAmsterdamTime } from './dates.js';
import { Appointment, isCancelled } from './magister-api.js';

/**
 * Homework and tests as returned to the model, derived from validated agenda
 * appointments by their AfspraakInfoType. No ids, people or account data.
 */

export interface AssignmentItem {
  /** The upstream ISO start instant; used for ordering. */
  start: string;
  date: CalendarDate;
  startTime: string;
  endTime: string;
  subject: string;
  /** Dutch label of the InfoType, e.g. "Huiswerk" or "Proefwerk". */
  kind: string;
  /** Readable plain text of the assignment, possibly empty. */
  content: string;
  /** null when Magister does not say. */
  completed: boolean | null;
  cancelled: boolean;
}

const HOMEWORK_TYPES: ReadonlyMap<number, string> = new Map([[1, 'Huiswerk']]);
const TEST_TYPES: ReadonlyMap<number, string> = new Map([
  [2, 'Proefwerk'],
  [3, 'Tentamen'],
  [4, 'Schriftelijke overhoring'],
  [5, 'Mondelinge overhoring'],
]);

export const MAX_CONTENT_CHARS = 10_000;
export const TRUNCATION_MARKER = '… [truncated]';

/** Elements whose content is never text for the reader. */
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'noscript',
  'template',
  'svg',
  'object',
]);
/** Elements that end a paragraph (blank line). */
const PARAGRAPH_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']);
/** Elements that end a line. */
const LINE_TAGS = new Set([
  'div',
  'li',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'tr',
  'table',
  'section',
  'article',
  'header',
  'footer',
  'hr',
]);
const CELL_TAGS = new Set(['td', 'th']);
/** C0/C1 controls (except tab/newline, which collapse) and invisible format/bidi characters. */
const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * Converts assignment HTML to readable plain text without a DOM: nothing is
 * executed, loaded or followed. Block elements become line boundaries, list
 * items get "- ", entities are decoded, scripts/styles/embedded content,
 * comments, link targets and images disappear. The result is limited to
 * `maxChars` characters plus TRUNCATION_MARKER.
 */
export function htmlToText(html: string, maxChars = MAX_CONTENT_CHARS): string {
  let output = '';
  let skipDepth = 0;
  // 0: nothing pending, 1: line break, 2: paragraph break before the next text.
  let pendingBreak = 0;
  let pendingBullet = false;

  const breakBefore = (level: number) => {
    pendingBreak = Math.max(pendingBreak, level);
  };

  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIPPED_TAGS.has(name)) skipDepth += 1;
        if (skipDepth > 0) return;
        if (name === 'br') output += '\n';
        else if (PARAGRAPH_TAGS.has(name)) breakBefore(2);
        else if (LINE_TAGS.has(name)) breakBefore(1);
        else if (CELL_TAGS.has(name)) output += ' ';
        if (name === 'li') pendingBullet = true;
      },
      onclosetag(name) {
        if (SKIPPED_TAGS.has(name)) {
          skipDepth = Math.max(0, skipDepth - 1);
          return;
        }
        if (skipDepth > 0) return;
        if (PARAGRAPH_TAGS.has(name)) breakBefore(2);
        else if (LINE_TAGS.has(name)) breakBefore(1);
        if (name === 'li') pendingBullet = false;
      },
      ontext(data) {
        if (skipDepth > 0) return;
        const text = data.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ');
        if (text.trim() === '') {
          if (pendingBreak === 0) output += text;
          return;
        }
        if (output.length > 0 && pendingBreak > 0) output += pendingBreak === 2 ? '\n\n' : '\n';
        pendingBreak = 0;
        if (pendingBullet) output += '- ';
        pendingBullet = false;
        output += text;
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  return truncate(normalizeLines(output), maxChars);
}

/** Trims every line, drops leading/trailing blank lines and keeps at most one blank line. */
function normalizeLines(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/ {2,}/g, ' ').trim();
    if (line === '' && (lines.length === 0 || lines[lines.length - 1] === '')) continue;
    lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}${TRUNCATION_MARKER}`;
}

function subjectOf(appt: Appointment): string {
  const named = appt.Vakken?.find((vak) => vak.Naam)?.Naam;
  return named || appt.Omschrijving || 'Unknown';
}

function toAssignment(appt: Appointment, kind: string): AssignmentItem {
  return {
    start: appt.Start,
    date: amsterdamDateOf(appt.Start),
    startTime: formatAmsterdamTime(appt.Start),
    endTime: formatAmsterdamTime(appt.Einde),
    subject: subjectOf(appt),
    kind,
    content: htmlToText(appt.Inhoud ?? ''),
    completed: appt.Afgerond ?? null,
    cancelled: isCancelled(appt),
  };
}

function project(appointments: Appointment[], types: ReadonlyMap<number, string>) {
  const items: AssignmentItem[] = [];
  for (const appt of appointments) {
    const kind = appt.InfoType == null ? undefined : types.get(appt.InfoType);
    if (kind !== undefined) items.push(toAssignment(appt, kind));
  }
  // Array.prototype.sort is stable, so equal instants keep their upstream order.
  return items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Appointments with InfoType 1, in chronological order. */
export function toHomework(appointments: Appointment[]): AssignmentItem[] {
  return project(appointments, HOMEWORK_TYPES);
}

/** Appointments with InfoType 2 to 5, in chronological order. */
export function toTests(appointments: Appointment[]): AssignmentItem[] {
  return project(appointments, TEST_TYPES);
}

/** Schedule data as returned to the model, and the rules that interpret it. */

export interface ScheduleItem {
  startTime: string;
  endTime: string;
  subject: string;
  teacher?: string;
  location?: string;
  cancelled: boolean;
  description?: string;
}

export interface ClassResult {
  class: ScheduleItem | null;
  cancellationReason: string | null;
}

const CANCELLATION_PATTERNS = [
  /alle lessen vervallen/i,
  /school gesloten/i,
  /geen lessen/i,
  /lesuitval/i,
  /code (oranje|rood)/i,
];

export function isActualClass(item: ScheduleItem): boolean {
  // Filter out cancelled classes
  if (item.cancelled) return false;

  const subject = item.subject.toLowerCase();

  // Filter out "no class" and cancellation notices
  if (subject.includes('geen les')) return false;
  if (subject.includes('lesuitval')) return false;
  if (subject.includes('vervallen')) return false;

  // Informational notices often start with ! or #
  if (item.subject.startsWith('!') || item.subject.startsWith('#')) return false;

  // All-day events (00:00-00:00) are notices, not actual classes
  if (item.startTime === '00:00' && item.endTime === '00:00') return false;

  // Real classes have teachers assigned
  if (!item.teacher) return false;

  return true;
}

/**
 * Detects school-wide cancellation notices in the schedule.
 * Only returns a cancellation reason for all-day notices (00:00-00:00).
 * Per-period cancellations like "geen lessen 4e uur" are ignored here.
 */
export function detectSchoolWideCancellation(schedule: ScheduleItem[]): string | null {
  for (const item of schedule) {
    if (item.startTime !== '00:00' || item.endTime !== '00:00') continue;
    const textToCheck = `${item.subject} ${item.description || ''}`;
    if (CANCELLATION_PATTERNS.some((pattern) => pattern.test(textToCheck))) {
      return item.description || item.subject;
    }
  }
  return null;
}

function pickClass(schedule: ScheduleItem[], which: 'first' | 'last'): ClassResult {
  const actualClasses = schedule.filter(isActualClass);

  // Only report cancellation if there are no actual classes AND a cancellation notice exists
  if (actualClasses.length === 0) {
    const cancellationReason = detectSchoolWideCancellation(schedule);
    if (cancellationReason) return { class: null, cancellationReason };
  }

  const chosen = which === 'first' ? actualClasses[0] : actualClasses[actualClasses.length - 1];
  return { class: chosen ?? null, cancellationReason: null };
}

export function firstClass(schedule: ScheduleItem[]): ClassResult {
  return pickClass(schedule, 'first');
}

export function lastClass(schedule: ScheduleItem[]): ClassResult {
  return pickClass(schedule, 'last');
}

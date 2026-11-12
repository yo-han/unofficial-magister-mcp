import { z } from 'zod';
import { CalendarDate, resolveDate, resolveRange } from './dates.js';
import { PublicError } from './errors.js';

export type ToolName =
  | 'get_schedule'
  | 'get_week_schedule'
  | 'get_dropoff_time'
  | 'get_pickup_time'
  | 'get_homework'
  | 'get_tests';

export type ToolCall =
  | { name: 'get_schedule'; date: CalendarDate }
  | { name: 'get_week_schedule' }
  | { name: 'get_dropoff_time'; date: CalendarDate }
  | { name: 'get_pickup_time'; date: CalendarDate }
  | { name: 'get_homework' | 'get_tests'; dates: CalendarDate[] };

const DATE_DESCRIPTION =
  'Can be "today", "tomorrow", a weekday name, or YYYY-MM-DD format (Europe/Amsterdam)';

function dateSchema(description: string) {
  return {
    type: 'object' as const,
    properties: {
      date: { type: 'string', maxLength: 32, description: `${description}. ${DATE_DESCRIPTION}` },
    },
    required: ['date'],
    additionalProperties: false,
  };
}

const RANGE_DESCRIPTION =
  'Inclusive. Can be "today", "tomorrow", a weekday name (its next occurrence), or YYYY-MM-DD format (Europe/Amsterdam)';

function rangeSchema() {
  return {
    type: 'object' as const,
    properties: {
      from: {
        type: 'string',
        maxLength: 32,
        description: `First day of the period; defaults to today. ${RANGE_DESCRIPTION}`,
      },
      to: {
        type: 'string',
        maxLength: 32,
        description: `Last day of the period; defaults to 13 days after "from". ${RANGE_DESCRIPTION}`,
      },
    },
    additionalProperties: false,
  };
}

const RANGE_RULES =
  'Without arguments the period is the next 14 days starting today; at most 31 days, from must not be after to.';

export const TOOL_DEFINITIONS = [
  {
    name: 'get_schedule',
    description: 'Get school schedule for a specific date',
    inputSchema: dateSchema('Date to get schedule for'),
  },
  {
    name: 'get_week_schedule',
    description: 'Get school schedule for the entire week (next 7 days)',
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
  {
    name: 'get_dropoff_time',
    description: 'Get the time of the first class (for drop-off planning)',
    inputSchema: dateSchema('Date to check'),
  },
  {
    name: 'get_pickup_time',
    description: 'Get the time of the last class (for pick-up planning)',
    inputSchema: dateSchema('Date to check'),
  },
  {
    name: 'get_homework',
    description: `Get homework (Magister agenda items marked as homework) for an inclusive period, with subject, content, completed and cancelled state. ${RANGE_RULES}`,
    inputSchema: rangeSchema(),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_tests',
    description: `Get tests (proefwerk, tentamen, schriftelijke and mondelinge overhoring) from the Magister agenda for an inclusive period. ${RANGE_RULES}`,
    inputSchema: rangeSchema(),
    annotations: { readOnlyHint: true },
  },
] as const satisfies readonly {
  name: ToolName;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
}[];

const DateArgs = z.strictObject({ date: z.string().max(32) });
const NoArgs = z.strictObject({});
const RangeArgs = z.strictObject({
  from: z.string().max(32).optional(),
  to: z.string().max(32).optional(),
});

function isToolName(name: string): name is ToolName {
  return TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

/**
 * Validates a tool call before any client or browser exists.
 * Throws PublicError(UNKNOWN_TOOL) or PublicError(INVALID_ARGUMENT).
 */
export function parseToolCall(name: string, args: unknown, now: Date): ToolCall {
  if (!isToolName(name)) throw new PublicError('UNKNOWN_TOOL');
  if (name === 'get_week_schedule') {
    if (!NoArgs.safeParse(args ?? {}).success) throw new PublicError('INVALID_ARGUMENT');
    return { name };
  }
  if (name === 'get_homework' || name === 'get_tests') {
    const range = RangeArgs.safeParse(args ?? {});
    if (!range.success) throw new PublicError('INVALID_ARGUMENT');
    return { name, dates: resolveRange(range.data.from, range.data.to, now) };
  }
  const parsed = DateArgs.safeParse(args);
  if (!parsed.success) throw new PublicError('INVALID_ARGUMENT');
  return { name, date: resolveDate(parsed.data.date, now) };
}

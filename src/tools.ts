import { z } from 'zod';
import { CalendarDate, resolveDate } from './dates.js';
import { PublicError } from './errors.js';

export type ToolName =
  'get_schedule' | 'get_week_schedule' | 'get_dropoff_time' | 'get_pickup_time';

export type ToolCall =
  | { name: 'get_schedule'; date: CalendarDate }
  | { name: 'get_week_schedule' }
  | { name: 'get_dropoff_time'; date: CalendarDate }
  | { name: 'get_pickup_time'; date: CalendarDate };

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
] as const satisfies readonly { name: ToolName; description: string; inputSchema: object }[];

const DateArgs = z.strictObject({ date: z.string().max(32) });
const NoArgs = z.strictObject({});

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
  const parsed = DateArgs.safeParse(args);
  if (!parsed.success) throw new PublicError('INVALID_ARGUMENT');
  return { name, date: resolveDate(parsed.data.date, now) };
}

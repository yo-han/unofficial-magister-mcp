import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { CalendarDate, formatDisplayDate, weekRange } from './dates.js';
import { PublicError, toPublicError } from './errors.js';
import { logEvent } from './logger.js';
import { ClassResult, ScheduleItem } from './schedule.js';
import { parseToolCall, TOOL_DEFINITIONS, ToolCall } from './tools.js';

/** What the MCP layer needs from a Magister client. */
export interface ScheduleClient {
  getSchedule(date: CalendarDate): Promise<ScheduleItem[]>;
  getWeekSchedule(dates: CalendarDate[]): Promise<Record<CalendarDate, ScheduleItem[]>>;
  getFirstClass(date: CalendarDate): Promise<ClassResult>;
  getLastClass(date: CalendarDate): Promise<ClassResult>;
}

export interface ServerOptions {
  /** Called lazily on the first valid tool call; must not start a browser itself. */
  clientFactory: () => ScheduleClient;
  version: string;
  now?: () => Date;
}

export function formatSchedule(items: ScheduleItem[]): string {
  if (items.length === 0) return 'No classes scheduled';
  return items
    .map((item) => {
      const status = item.cancelled ? ' [CANCELLED]' : '';
      const time =
        item.startTime && item.endTime ? `${item.startTime} - ${item.endTime}` : 'Time unknown';
      const location = item.location ? ` @ ${item.location}` : '';
      const teacher = item.teacher ? ` (${item.teacher})` : '';
      return `${time}: ${item.subject}${teacher}${location}${status}`;
    })
    .join('\n');
}

function formatClassResult(
  date: CalendarDate,
  result: ClassResult,
  kind: 'first' | 'last'
): string {
  const display = formatDisplayDate(date);
  if (result.cancellationReason) {
    return `No classes on ${display} - cancelled (${result.cancellationReason})`;
  }
  if (result.class) {
    const location = result.class.location ? ` @ ${result.class.location}` : '';
    return kind === 'first'
      ? `First class on ${display}: ${result.class.subject} at ${result.class.startTime}${location}`
      : `Last class on ${display}: ${result.class.subject} ends at ${result.class.endTime}${location}`;
  }
  return `No classes scheduled for ${display}`;
}

async function runTool(call: ToolCall, client: ScheduleClient, now: Date): Promise<string> {
  switch (call.name) {
    case 'get_schedule': {
      const schedule = await client.getSchedule(call.date);
      return `Schedule for ${formatDisplayDate(call.date)}:\n\n${formatSchedule(schedule)}`;
    }
    case 'get_week_schedule': {
      const dates = weekRange(now);
      const week = await client.getWeekSchedule(dates);
      const sections = dates.map(
        (date) => `=== ${formatDisplayDate(date)} ===\n${formatSchedule(week[date] ?? [])}\n\n`
      );
      return `Week Schedule:\n\n${sections.join('')}`;
    }
    case 'get_dropoff_time':
      return formatClassResult(call.date, await client.getFirstClass(call.date), 'first');
    case 'get_pickup_time':
      return formatClassResult(call.date, await client.getLastClass(call.date), 'last');
  }
}

function errorResult(error: PublicError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: error.toPublicText() }] };
}

export function createServer(options: ServerOptions): Server {
  const now = options.now ?? (() => new Date());
  let client: ScheduleClient | null = null;

  const server = new Server(
    { name: 'unofficial-magister-mcp', version: options.version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const callTime = now();
    let call: ToolCall;
    try {
      call = parseToolCall(name, args, callTime);
    } catch (error) {
      const publicError = toPublicError(error);
      logEvent('tool_failed', { code: publicError.code }, 'warn');
      if (publicError.code === 'UNKNOWN_TOOL') {
        throw new McpError(ErrorCode.InvalidParams, publicError.message);
      }
      return errorResult(publicError);
    }

    logEvent('tool_called', { tool: call.name });
    try {
      client ??= options.clientFactory();
      const text = await runTool(call, client, callTime);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      const publicError = toPublicError(error);
      logEvent('tool_failed', { tool: call.name, code: publicError.code }, 'error');
      return errorResult(publicError);
    }
  });

  return server;
}

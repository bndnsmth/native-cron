const NICKNAMES: Readonly<Record<string, string>> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export interface CronField {
  readonly values: readonly number[];
  readonly wildcard: boolean;
}

export interface ParsedCalendarCronExpression {
  readonly trigger: "calendar";
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
  readonly normalized: string;
}

export interface ParsedStartupCronExpression {
  readonly trigger: "startup";
  readonly normalized: "@reboot";
}

export type ParsedCronExpression = ParsedCalendarCronExpression | ParsedStartupCronExpression;

interface FieldDefinition {
  label: string;
  min: number;
  max: number;
  names?: Readonly<Record<string, number>>;
  sundayAlias?: boolean;
}

const DEFINITIONS: readonly FieldDefinition[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES, sundayAlias: true },
];

function parseNumber(value: string, definition: FieldDefinition): number {
  const named = definition.names?.[value.toLowerCase()];
  const parsed = named ?? (/^\d+$/.test(value) ? Number(value) : Number.NaN);

  if (!Number.isInteger(parsed) || parsed < definition.min || parsed > definition.max) {
    throw new Error(
      `Invalid cron expression: ${definition.label} value '${value}' must be between ${definition.min} and ${definition.max}`,
    );
  }

  return parsed;
}

function addRange(
  values: Set<number>,
  start: number,
  end: number,
  step: number,
  definition: FieldDefinition,
): void {
  if (start > end) {
    throw new Error(
      `Invalid cron expression: ${definition.label} range must be ascending (use a list for wrap-around)`,
    );
  }

  for (let value = start; value <= end; value += step) {
    values.add(definition.sundayAlias && value === 7 ? 0 : value);
  }
}

function parseField(source: string, definition: FieldDefinition): CronField {
  const values = new Set<number>();

  for (const part of source.split(",")) {
    if (!part) {
      throw new Error(`Invalid cron expression: empty ${definition.label} list item`);
    }

    const stepParts = part.split("/");
    if (stepParts.length > 2 || !stepParts[0]) {
      throw new Error(`Invalid cron expression: invalid ${definition.label} step`);
    }

    const stepSource = stepParts[1];
    if (stepSource !== undefined && !/^\d+$/u.test(stepSource)) {
      throw new Error(
        `Invalid cron expression: ${definition.label} step must be a positive integer`,
      );
    }
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(
        `Invalid cron expression: ${definition.label} step must be a positive integer`,
      );
    }

    const base = stepParts[0];
    if (base === "*") {
      addRange(values, definition.min, definition.max, step, definition);
      continue;
    }

    const rangeParts = base.split("-");
    if (rangeParts.length > 2 || rangeParts.some((value) => !value)) {
      throw new Error(`Invalid cron expression: invalid ${definition.label} range`);
    }

    const start = parseNumber(rangeParts[0], definition);
    const end =
      rangeParts[1] === undefined
        ? stepParts[1] === undefined
          ? start
          : definition.max
        : parseNumber(rangeParts[1], definition);
    addRange(values, start, end, step, definition);
  }

  const sorted = [...values].sort((left, right) => left - right);
  return Object.freeze({
    values: Object.freeze(sorted),
    wildcard: source === "*" || source === "*/1",
  });
}

function formatField(field: CronField): string {
  return field.wildcard ? "*" : field.values.join(",");
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== "string") {
    throw new TypeError("Cron expression must be a string");
  }

  const trimmed = expression.trim();
  if (trimmed.toLowerCase() === "@reboot" || trimmed.toLowerCase() === "@login") {
    return Object.freeze({ trigger: "startup", normalized: "@reboot" });
  }
  const expanded = NICKNAMES[trimmed.toLowerCase()] ?? trimmed;
  const fields = expanded.split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      fields.length > 5
        ? "Invalid cron expression: expected 5 fields; seconds are not supported"
        : "Invalid cron expression: expected 5 fields (minute hour day month weekday)",
    );
  }

  const parsed = fields.map((field, index) => parseField(field, DEFINITIONS[index]));
  const result: ParsedCalendarCronExpression = {
    trigger: "calendar",
    minute: parsed[0],
    hour: parsed[1],
    dayOfMonth: parsed[2],
    month: parsed[3],
    dayOfWeek: parsed[4],
    normalized: parsed.map(formatField).join(" "),
  };

  return Object.freeze(result);
}

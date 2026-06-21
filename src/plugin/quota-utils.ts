export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function pad(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  return value.padEnd(width, " ");
}

export function buildProgressBar(fraction: number, width = 20): string {
  const clamped = clamp(fraction, 0, 1);
  const filled = clamped >= 1
    ? width
    : Math.max(0, Math.min(width, Math.max(clamped > 0 ? 1 : 0, Math.floor(clamped * width))));
  const empty = width - filled;
  return `${"▓".repeat(filled)}${"░".repeat(empty)}`;
}

export function formatRemainingAmount(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return parsed.toLocaleString("en-US");
}

export function formatRelativeResetTime(resetTime: string | undefined): string | undefined {
  if (!resetTime) {
    return undefined;
  }

  const resetAt = new Date(resetTime).getTime();
  if (Number.isNaN(resetAt)) {
    return undefined;
  }

  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) {
    return "reset pending";
  }

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `resets in ${hours}h`;
  }
  return `resets in ${minutes}m`;
}

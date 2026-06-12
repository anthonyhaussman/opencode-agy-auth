/**
 * Agy/Gemini CLI attaches a short activity ID to each request via its network logger.
 * We mirror the same format so backend/debug traces look like CLI traffic.
 */
export function createAgyActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}

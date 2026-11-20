import type { AcpPermissionOption, AcpPermissionRequest, AcpPermissionResponse } from "./process";
import { classifyToolCall } from "./stream-map";

const ALLOW_KINDS: readonly AcpPermissionOption["kind"][] = ["allow_once", "allow_always"];
const REJECT_KINDS: readonly AcpPermissionOption["kind"][] = ["reject_once", "reject_always"];

/**
 * Allows only `call_mcp_tool` aimed at the OpenCode bridge; rejects everything
 * else. Replies `cancelled` only when no option of the needed kind exists.
 */
export function decidePermission(req: AcpPermissionRequest): {
  response: AcpPermissionResponse;
  allowed: boolean;
} {
  const allowed = classifyToolCall(req.toolCall ?? { toolCallId: "" }).kind === "bridge";
  const options = req.options ?? [];
  for (const kind of allowed ? ALLOW_KINDS : REJECT_KINDS) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { response: { outcome: { outcome: "selected", optionId: option.optionId } }, allowed };
  }
  return { response: { outcome: { outcome: "cancelled" } }, allowed };
}

/**
 * Tool Name Schema Mapping for Gemini API
 *
 * Gemini API tool schemas strictly enforce function names matching `^[a-zA-Z_][a-zA-Z0-9_]*$`.
 * Agent frameworks (MCP servers, OpenCode plugins, OpenAI adapters) often use hyphens (-), dots (.),
 * slashes (/), or colons (:) in tool names (e.g. `context7_resolve_library_id`, `atlassian:get-issue`, `my-tool`).
 *
 * This module maintains a bidirectional mapping between original client tool names and Gemini-compliant tool names,
 * resolving collisions deterministically and persisting session mappings across multi-turn tool loops.
 */

export function sanitizeToolName(name: string): string {
  if (!name || typeof name !== "string") {
    return "unnamed_tool";
  }

  // Replace all non-alphanumeric and non-underscore characters with '_'
  let sanitized = name.replace(/[^a-zA-Z0-9_]/g, "_");

  // Ensure starts with [a-zA-Z_]
  if (!/^[a-zA-Z_]/.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  return sanitized;
}

export class ToolMapper {
  private originalToSanitized = new Map<string, string>();
  private sanitizedToOriginal = new Map<string, string>();

  /**
   * Register a tool name and get its Gemini-compliant sanitized name.
   * Handles naming collisions by appending a numeric suffix if needed.
   */
  register(originalName: string): string {
    if (!originalName || typeof originalName !== "string") {
      return originalName;
    }

    const existing = this.originalToSanitized.get(originalName);
    if (existing) {
      return existing;
    }

    const baseSanitized = sanitizeToolName(originalName);
    let sanitized = baseSanitized;
    let counter = 1;

    // Resolve collision if a different originalName already claimed this sanitized name
    while (this.sanitizedToOriginal.has(sanitized) && this.sanitizedToOriginal.get(sanitized) !== originalName) {
      sanitized = `${baseSanitized}_${counter++}`;
    }

    this.originalToSanitized.set(originalName, sanitized);
    this.sanitizedToOriginal.set(sanitized, originalName);

    return sanitized;
  }

  /**
   * Map an original tool name to sanitized Gemini name.
   * If not already registered, registers it on the fly.
   */
  toGemini(originalName: string): string {
    if (!originalName || typeof originalName !== "string") {
      return originalName;
    }
    const sanitized = this.originalToSanitized.get(originalName);
    if (sanitized) {
      return sanitized;
    }
    return this.register(originalName);
  }

  /**
   * Restore a sanitized Gemini tool name back to the original client tool name.
   */
  fromGemini(sanitizedName: string): string {
    if (!sanitizedName || typeof sanitizedName !== "string") {
      return sanitizedName;
    }
    return this.sanitizedToOriginal.get(sanitizedName) ?? sanitizedName;
  }

  /**
   * Register tools from Gemini `tools[].functionDeclarations` array.
   */
  registerFromFunctionDeclarations(tools: unknown): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (tool && Array.isArray(tool.functionDeclarations)) {
        for (const fn of tool.functionDeclarations) {
          if (fn && typeof fn.name === "string") {
            this.register(fn.name);
          }
        }
      }
    }
  }

  /**
   * Register tools from OpenAI format `tools[].function.name`.
   */
  registerFromOpenAITools(tools: unknown): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (tool && typeof tool === "object") {
        const fn = (tool as Record<string, unknown>).function as Record<string, unknown> | undefined;
        if (fn && typeof fn.name === "string") {
          this.register(fn.name);
        }
      }
    }
  }

  /**
   * Scan contents/messages to register any previously used tool names.
   */
  registerFromContents(contents: unknown): void {
    if (!Array.isArray(contents)) return;
    for (const content of contents) {
      if (!content || typeof content !== "object") continue;
      const parts = (content as Record<string, unknown>).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.functionCall && typeof (p.functionCall as Record<string, unknown>).name === "string") {
            this.register((p.functionCall as Record<string, unknown>).name as string);
          }
          if (p.functionResponse && typeof (p.functionResponse as Record<string, unknown>).name === "string") {
            this.register((p.functionResponse as Record<string, unknown>).name as string);
          }
        }
      }
    }
  }
}

// Session-based mapper cache
const sessionMappers = new Map<string, { mapper: ToolMapper; updatedAt: number }>();
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getToolMapper(sessionId?: string): ToolMapper {
  if (!sessionId) {
    return new ToolMapper();
  }

  const now = Date.now();
  const existing = sessionMappers.get(sessionId);
  if (existing && now - existing.updatedAt < MAX_SESSION_AGE_MS) {
    existing.updatedAt = now;
    return existing.mapper;
  }

  // Cleanup old sessions if cache grows large
  if (sessionMappers.size > 1000) {
    for (const [key, value] of sessionMappers.entries()) {
      if (now - value.updatedAt >= MAX_SESSION_AGE_MS) {
        sessionMappers.delete(key);
      }
    }
  }

  const mapper = new ToolMapper();
  sessionMappers.set(sessionId, { mapper, updatedAt: now });
  return mapper;
}

export function clearToolMapper(sessionId: string): void {
  sessionMappers.delete(sessionId);
}

/**
 * Restores original client tool names inside Gemini candidates/parts functionCall objects.
 */
export function restoreToolNamesInResponse(body: unknown, toolMapper: ToolMapper): void {
  if (!body || typeof body !== "object") return;
  const b = body as Record<string, unknown>;

  const target = b.response && typeof b.response === "object" ? (b.response as Record<string, unknown>) : b;
  const candidates = target.candidates;
  if (Array.isArray(candidates)) {
    for (const cand of candidates) {
      if (!cand || typeof cand !== "object") continue;
      const content = (cand as Record<string, unknown>).content;
      if (!content || typeof content !== "object") continue;
      const parts = (content as Record<string, unknown>).parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.functionCall && typeof (p.functionCall as Record<string, unknown>).name === "string") {
            const fnCall = p.functionCall as Record<string, unknown>;
            fnCall.name = toolMapper.fromGemini(fnCall.name as string);
          }
        }
      }
    }
  }
}

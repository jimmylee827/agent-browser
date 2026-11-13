import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type Ctx } from "./tools/index.js";
import { AbError } from "./errors.js";

/** Terminal and MCP use the exact same schema, guard, lock and result handler.
 * Registration has no side effects. Do not maintain parallel control workflows. */
export async function invokeBrowserOperation(ctx: Ctx, name: string, args: Record<string, unknown>) {
  let selected: { shape: z.ZodRawShape; run: (args: unknown) => Promise<unknown> } | undefined;
  const sink = { tool(n: string, _description: string, shape: z.ZodRawShape, run: (args: unknown) => Promise<unknown>) {
    if (n === name) selected = { shape, run };
  } };
  registerTools(sink as unknown as McpServer, ctx);
  if (!selected) throw new AbError("BAD_REQUEST", `unknown browser operation: ${name}`);
  return selected.run(z.object(selected.shape).strict().parse(args));
}

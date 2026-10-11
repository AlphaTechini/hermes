import { z } from "zod";
import { HermesError } from "../errors";

/** Validate or throw a 400 with zod issues attached. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw new HermesError(400, "validation_error", issues[0] ? `${issues[0].path || "body"}: ${issues[0].message}` : "Invalid request", issues);
  }
  return r.data;
}

export const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

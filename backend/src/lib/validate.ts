import type { ZodType, ZodTypeDef } from 'zod';
import { type FieldIssue, validationFailed } from './errors.js';

/**
 * Run a Zod schema and convert failures into the API's field-issue shape.
 *
 * Generic over input and output separately rather than using `ZodSchema<T>`,
 * which collapses both to one parameter — that would make every schema using
 * `.default()`, `.coerce`, or `.transform()` infer its *input* type, so
 * defaulted fields would appear optional to callers even though parsing always
 * fills them.
 *
 * Zod messages are safe to return: they describe the caller's own input, not
 * anything about the server. That is a deliberate exception to the "no detail
 * in errors" rule — a device author debugging a payload needs to know which
 * field was rejected and why.
 */
export function parseOrThrow<Output, Def extends ZodTypeDef, Input>(
  schema: ZodType<Output, Def, Input>,
  input: unknown,
): Output {
  const result = schema.safeParse(input);

  if (!result.success) {
    const issues: FieldIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    throw validationFailed(issues);
  }

  return result.data;
}

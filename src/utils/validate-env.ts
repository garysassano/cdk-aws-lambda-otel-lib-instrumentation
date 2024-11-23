import { z } from "zod";

/**
 * Validates that required environment variables are present in `process.env`.
 *
 * @param requiredEnvVars - Array of required environment variables to validate.
 * @returns Object containing the validated environment variables.
 * @throws Error if any required environment variables are missing.
 */
export const validateEnv = <T extends string>(requiredEnvVars: T[]) => {
  const required = (name: string) =>
    z.string({
      required_error: name,
    });

  try {
    return z
      .object(
        Object.fromEntries(
          requiredEnvVars.map((name) => [name, required(name)]),
        ) as { [K in T]: z.ZodString },
      )
      .parse(process.env) as { [K in T]: string };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingEnvVars = error.issues
        .map((issue) => issue.message)
        .join("\n");
      throw new Error(`Missing environment variables\n${missingEnvVars}`);
    }
    throw error;
  }
};

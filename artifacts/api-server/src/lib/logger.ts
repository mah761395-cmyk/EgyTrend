import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Error strings from database drivers, mail transports, and upstream APIs can
 * embed connection URLs, recipient addresses, SQL values, or response bodies.
 * Keep only a small diagnostic classification in process logs; detailed
 * investigation belongs in the provider's protected observability tooling.
 */
function safeErrorSerializer(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return { type: "UnknownError" };
  const candidate = value as { name?: unknown; code?: unknown };
  const type = typeof candidate.name === "string" ? candidate.name.slice(0, 80) : "Error";
  const code = typeof candidate.code === "string" && /^[A-Z0-9_-]{1,32}$/i.test(candidate.code)
    ? candidate.code
    : undefined;
  return code ? { type, code } : { type };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { err: safeErrorSerializer },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers.x-admin-token",
    "res.headers['set-cookie']",
    "req.body.password",
    "req.body.currentPassword",
    "req.body.newPassword",
    "req.body.token",
    "req.body.proofImage",
    "req.body.tx",
    "req.body.phone",
    "req.body.email",
    "req.body.name",
    "req.body.proofName",
    "phone",
    "email",
    "to",
    "resetLink",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

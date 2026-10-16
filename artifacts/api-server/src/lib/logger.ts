import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
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

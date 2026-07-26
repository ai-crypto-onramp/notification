// Vitest global setup. Sets DEV_MODE=1 so the service-token auth hook
// bypasses auth when test suites import buildApp without configuring
// SERVICE_TOKEN_SECRET. Mirrors the DEV_MODE bypass in authtoken.ts.
process.env.DEV_MODE = "1";
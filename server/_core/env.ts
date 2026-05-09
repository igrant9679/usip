export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",

  // AI providers — at least one must be configured for AI features.
  // Resolution order (when AI_DEFAULT_PROVIDER is unset): anthropic → openai → gemini.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
  aiDefaultProvider: process.env.AI_DEFAULT_PROVIDER ?? "",

  // Symmetric key used to encrypt secrets at rest (workspace AI keys, etc.).
  // Generate with: `openssl rand -hex 32`. May also be a passphrase (hashed to 32 bytes).
  encryptionKey: process.env.ENCRYPTION_KEY ?? process.env.JWT_SECRET ?? "",

  // DEPRECATED: Manus Forge platform shims. Still referenced by storage / dataApi /
  // imageGeneration / map / notification / storageProxy / voiceTranscription.
  // Schedule for removal alongside replacing each Manus dependency (see TODO P0).
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

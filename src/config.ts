export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.OUTLETS_SERVICE_DATABASE_URL || process.env.DATABASE_URL || "",
  apiKey: process.env.OUTLETS_SERVICE_API_KEY || "",
  chatServiceUrl: process.env.CHAT_SERVICE_URL || "",
  chatServiceApiKey: process.env.CHAT_SERVICE_API_KEY || "",
  googleServiceUrl: process.env.GOOGLE_SERVICE_URL || "",
  googleServiceApiKey: process.env.GOOGLE_SERVICE_API_KEY || "",
};

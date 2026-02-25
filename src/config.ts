export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  apiKey: process.env.OUTLETS_SERVICE_API_KEY || "",
  runsServiceUrl: process.env.RUNS_SERVICE_URL || "",
  runsServiceApiKey: process.env.RUNS_SERVICE_API_KEY || "",
};

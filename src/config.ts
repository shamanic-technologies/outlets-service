export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  apiKey: process.env.API_KEY || "",
};

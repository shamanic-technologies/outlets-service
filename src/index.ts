import { createApp } from "./app";
import { config } from "./config";
import { runMigration } from "./db/migrate";

const app = createApp();

runMigration()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`outlets-service listening on port ${config.port}`);
    });
  })
  .catch((err) => {
    console.error("Migration failed, refusing to start:", err);
    process.exit(1);
  });

import { serve } from "@hono/node-server";
import { openDb, migrate } from "./db.js";
import { createRoutes } from "./routes.js";

const db = openDb();
migrate(db);

const app = createRoutes(db);

const port = parseInt(process.env.PORT || "3001", 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Ionosphere appview running on http://localhost:${info.port}`);
});

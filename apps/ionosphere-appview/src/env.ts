import { readFileSync } from "node:fs";
import path from "node:path";

// Load .env file from the appview package root
const envPath = path.resolve(import.meta.dirname, "../.env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^([^#=][^=]*)=(.+)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
} catch {}

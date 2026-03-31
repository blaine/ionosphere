import { AtpAgent } from "@atproto/api";

const PDS_URL = process.env.PDS_URL ?? "http://localhost:2690";
const BOT_HANDLE = process.env.BOT_HANDLE ?? "ionosphere.test";
const BOT_PASSWORD = process.env.BOT_PASSWORD ?? "ionosphere-dev-password";
const BOT_EMAIL = process.env.BOT_EMAIL ?? "ionosphere@example.com";

async function setup() {
  const agent = new AtpAgent({ service: PDS_URL });

  console.log(`Creating account ${BOT_HANDLE} on ${PDS_URL}...`);

  try {
    const result = await agent.createAccount({
      handle: BOT_HANDLE,
      password: BOT_PASSWORD,
      email: BOT_EMAIL,
    });
    console.log(`Account created. DID: ${result.data.did}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("already exists") ||
      message.includes("HandleNotAvailable")
    ) {
      console.log("Account already exists, skipping.");
    } else {
      throw err;
    }
  }
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});

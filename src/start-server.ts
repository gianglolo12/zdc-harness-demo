// Production entry point for the webhook server.
// Calls server main() which wires real Redis/BullMQ/GitLab and starts listening.
import { main } from "./server.js"

main().catch((e) => {
  console.error("[start-server] fatal:", e)
  process.exit(1)
})

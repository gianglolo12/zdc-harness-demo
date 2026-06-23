// Production entry point for the BullMQ worker.
// Calls worker main() which wires real Redis/GitLab/Claude and consumes the queue.
import { main } from "./worker.js"

main().catch((e) => {
  console.error("[start-worker] fatal:", e)
  process.exit(1)
})

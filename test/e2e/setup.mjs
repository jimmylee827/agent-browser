// One-time setup of the end-to-end test browser: opens the real Chrome on the
// test profile at chrome://extensions and waits while a person loads the
// extension. Run again any time to check the test browser connects.
//   npm run test:e2e:setup
import { startHarness, extensionInstalled, SETUP_STEPS } from "./harness.mjs";

if (extensionInstalled()) console.log("The test extension is already loaded; checking that it connects…");
else console.log(`${SETUP_STEPS}\n\nWaiting up to 10 minutes…`);
const h = await startHarness({ setup: true, waitMs: 600_000 });
console.log(h.connected ? "Connected: the test browser is ready. Run `npm run test:e2e`." : "Not connected. Check the extension card on chrome://extensions for errors, then run this again.");
await h.stop();
process.exit(h.connected ? 0 : 1);

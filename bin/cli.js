#!/usr/bin/env node
// nostrwolfe-bridge CLI entry point.
//
// Config is read from environment variables; a `.env` file in the current
// working directory is loaded automatically (see src/config.ts). Run from a
// directory containing your `.env`, or export the variables directly.
import { main } from "../dist/index.js";

main().catch((err) => {
  // Log the message, not the raw error object — avoids dumping a full stack
  // (which could carry incidental context) to stderr on a startup failure.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

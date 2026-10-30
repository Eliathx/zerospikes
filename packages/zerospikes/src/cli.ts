#!/usr/bin/env node
import { COMPARE_USAGE, EXIT, runCompareCommand } from "./compare-command.js";
import { HISTORY_USAGE, runHistoryCommand } from "./history-command.js";

const [command, ...rest] = process.argv.slice(2);
if (command === "compare") runCompareCommand(rest);
else if (command === undefined || (command.startsWith("--") && command !== "--help")) runHistoryCommand(process.argv.slice(2));
else {
  console.error(`${HISTORY_USAGE}\n\n${COMPARE_USAGE}`);
  process.exit(command === "--help" ? 0 : EXIT.usage);
}

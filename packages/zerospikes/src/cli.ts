#!/usr/bin/env node
import { COMPARE_USAGE, EXIT, runCompareCommand } from "./compare-command.js";
import { HISTORY_USAGE, runHistoryCommand } from "./history-command.js";

const [command, ...rest] = process.argv.slice(2);
if (command === "compare") runCompareCommand(rest);
else if (command === "history") runHistoryCommand(rest);
else {
  console.error(`${COMPARE_USAGE}\n\n${HISTORY_USAGE}`);
  process.exit(EXIT.usage);
}

/** Environment variables `zerospikes compare` sets for each Playwright session it runs. */
export const SESSION_ENV = {
  /** Where the reporter writes the session's results, instead of printing a table. */
  resultsFile: "ZEROSPIKES_SESSION_RESULTS",
  /** The `baseURL` the session's pages load, in place of the config's. */
  baseURL: "ZEROSPIKES_BASE_URL",
} as const;

/** Inside a compare session scenarios are only measured: limits are neither checked nor recorded. */
export const inCompareSession = () => Boolean(process.env[SESSION_ENV.resultsFile]);

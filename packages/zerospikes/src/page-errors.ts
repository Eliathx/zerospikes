import type { ConsoleMessage, Page } from "@playwright/test";
import type { PageError } from "./types.js";

/** A serialized object or a component stack can run to pages: the first line, cut here. */
const MAX_MESSAGE_LENGTH = 300;

/** Matches an error to leave out, by its message or where it came from: a string anywhere in them, or a pattern. */
export type ErrorFilter = string | RegExp;

export interface ErrorWatch {
  /** What was logged since the last take, the same message from the same place counted once, most repeated first. */
  take(): PageError[];
  stop(): void;
}

/**
 * Starts collecting what the page logs as an error, `console.error` and
 * exceptions nothing caught (rejected promises included), leaving out what
 * `ignore` matches.
 */
export function watchErrors(page: Page, ignore: readonly ErrorFilter[]): ErrorWatch {
  const seen = new ErrorTally();
  const add = (text: string, location: string | undefined) => {
    if (ignore.some((filter) => matches(filter, text) || (location !== undefined && matches(filter, location)))) return;
    seen.add({ message: truncateMessage(text), ...(location ? { location } : {}), count: 1 });
  };
  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const { url, lineNumber } = msg.location();
    if (isBrowserFavicon(url)) return;
    // Playwright counts lines from 0, editors and stacks from 1.
    add(msg.text(), url ? `${shortUrl(url)}:${lineNumber + 1}` : undefined);
  };
  const onPageError = (error: Error) => add(error.name ? `${error.name}: ${error.message}` : error.message, stackLocation(error.stack));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return {
    take() {
      const errors = seen.list();
      seen.clear();
      return errors;
    },
    stop() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
    },
  };
}

/** Errors by message and place: the same one added again adds to its count. */
export class ErrorTally {
  private readonly byKey = new Map<string, PageError>();

  get size(): number {
    return this.byKey.size;
  }

  add(error: PageError): void {
    const known = this.byKey.get(keyOf(error));
    if (known) known.count += error.count;
    else this.byKey.set(keyOf(error), { ...error });
  }

  has(error: PageError): boolean {
    return this.byKey.has(keyOf(error));
  }

  /** Most repeated first. */
  list(): PageError[] {
    return [...this.byKey.values()].map((error) => ({ ...error })).sort((a, b) => b.count - a.count);
  }

  clear(): void {
    this.byKey.clear();
  }
}

const keyOf = (error: PageError) => `${error.message}\0${error.location}`;

/** A pattern is copied first: a global one remembers where its last match ended. */
const matches = (filter: ErrorFilter, s: string) => (typeof filter === "string" ? s.includes(filter) : new RegExp(filter).test(s));

/** The icon the browser asks every site for on its own: a site without one hasn't broken. */
function isBrowserFavicon(url: string): boolean {
  try {
    return new URL(url).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

function truncateMessage(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > MAX_MESSAGE_LENGTH ? line.slice(0, MAX_MESSAGE_LENGTH - 1) + "…" : line;
}

/** A script's URL as a path in the project: `src/grid.ts`, without the dev server's origin or its `?t=` cache busting. */
function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http") ? parsed.pathname.replace(/^\//, "") : url;
  } catch {
    return url;
  }
}

/** Where the stack's first frame is, as `file:line`: `at sortRows (http://localhost:5173/src/grid.ts:12:5)`. */
export function stackLocation(stack: string | undefined): string | undefined {
  const frame = stack?.split("\n").find((line) => /^\s*at\s/.test(line));
  const match = frame && /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(frame);
  return match ? `${shortUrl(match[1])}:${match[2]}` : undefined;
}

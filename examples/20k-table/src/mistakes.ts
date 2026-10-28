/**
 * Four performance mistakes, all off. Set one to true to play the developer who
 * just made it, then run `npm run perf`: zerospikes fails the scenario it slows
 * down and names the function at fault. With `npm run dev` open, the page
 * reloads and the meter shows the difference by hand.
 */
export const MISTAKES = {
  /** Filter: every key press serializes and folds all rows instead of searching the prebuilt index. */
  filter: false,
  /** Sort: the comparator strips accents from both strings on every comparison instead of once per row. */
  sort: true,
  /** Column resize: each drag re-measures the text of every cell, instead of reusing the first measurement. */
  resize: false,
  /** Detail panel: closing it leaves its window listener behind and keeps its DOM node in a cache. */
  leak: false,
};

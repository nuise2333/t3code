export interface ReaderHeading {
  readonly element: HTMLElement;
  readonly level: number;
  readonly text: string;
}

const keys = new WeakMap<Element, number>();
let nextKey = 0;

/** A React key that follows the heading element across re-renders of the outline. */
export function headingKey(element: Element): number {
  let key = keys.get(element);
  if (key === undefined) {
    nextKey += 1;
    key = nextKey;
    keys.set(element, key);
  }
  return key;
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
// Folded text kept mounted for find, and screen-reader-only labels such as "Footnotes".
const UNSEEN_SELECTOR = "[hidden], .sr-only";

// Source markers and gutters the editor draws beside its text.
const NOT_TEXT_SELECTOR = "[data-thread-find-ignore]";

function headingText(element: HTMLElement) {
  if (element.querySelector(NOT_TEXT_SELECTOR) === null) return element.textContent ?? "";
  let text = "";
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(NOT_TEXT_SELECTOR) === null) text += node.textContent;
  }
  return text;
}

function readHeadings(root: Element): ReaderHeading[] {
  return Array.from(root.querySelectorAll<HTMLElement>(HEADING_SELECTOR), (element) => ({
    element,
    level: Number(element.tagName.slice(1)),
    text: headingText(element).replace(/\s+/g, " ").trim(),
  })).filter((heading) => heading.text !== "" && heading.element.closest(UNSEEN_SELECTOR) === null);
}

/** Whether a mutation can change the headings: one inside a heading, or one adding or removing one. */
function touchesHeadings(record: MutationRecord) {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest(HEADING_SELECTOR)) return true;
  if (record.type === "attributes") return true;
  const nodes = [...record.addedNodes, ...record.removedNodes];
  return nodes.some(
    (node) =>
      node instanceof Element &&
      (node.matches(HEADING_SELECTOR) || node.querySelector(HEADING_SELECTOR)),
  );
}

function sameHeadings(a: ReadonlyArray<ReaderHeading>, b: ReadonlyArray<ReaderHeading>) {
  return (
    a.length === b.length &&
    a.every(
      (heading, index) =>
        heading.element === b[index]?.element &&
        heading.level === b[index].level &&
        heading.text === b[index].text,
    )
  );
}

/** Calls back with the document's headings whenever the rendered document changes. */
export function observeHeadings(
  root: Element,
  onChange: (headings: ReaderHeading[]) => void,
): () => void {
  let headings = readHeadings(root);
  onChange(headings);
  const mutations = new MutationObserver((records) => {
    // Typing in a paragraph of a long document must not read every heading again.
    if (!records.some(touchesHeadings)) return;
    const next = readHeadings(root);
    if (sameHeadings(headings, next)) return;
    headings = next;
    onChange(next);
  });
  mutations.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributeFilter: ["hidden"],
  });
  return () => mutations.disconnect();
}

/** The share of the view, from its top, a heading must reach to start the current section. */
const READING_LINE = 0.25;
const ABOVE = 10_000_000;

/**
 * Reports the index of the section being read: the last heading at or above the reading line
 * near the top of the view, or -1 above the first. One observer, fed by crossings only.
 */
export function observeCurrentHeading(
  viewport: Element,
  headings: ReadonlyArray<ReaderHeading>,
  onChange: (index: number) => void,
): () => void {
  if (headings.length === 0 || typeof IntersectionObserver === "undefined") return () => {};
  const indexOf = new Map(headings.map((heading, index) => [heading.element as Element, index]));
  const reached = headings.map(() => false);
  let current = Number.NaN;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = indexOf.get(entry.target);
        if (index === undefined) continue;
        reached[index] = entry.isIntersecting;
      }
      const next = reached.lastIndexOf(true);
      if (next === current) return;
      current = next;
      onChange(next);
    },
    // Everything above the reading line, however far scrolled past: a jump across the line
    // then always changes a heading's intersection and reaches the callback.
    { root: viewport, rootMargin: `${ABOVE}px 0px -${(1 - READING_LINE) * 100}% 0px` },
  );
  for (const heading of headings) observer.observe(heading.element);
  return () => observer.disconnect();
}

import {
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";

import {
  inlineStyleOf,
  readerFigureInk,
  readerLayoutEpoch,
  subscribeReaderLayoutEpoch,
} from "./readerTypesetDom";

export interface OrderedListMarkerSlot {
  /** Ink width of the widest label. */
  readonly slot: number;
  /** How far the label's ink ends before its advance does. */
  readonly trim: number;
}

/** The number column of an ordered list set in `font`; null without a canvas to measure with. */
export function orderedListMarkerSlot(
  labels: ReadonlyArray<string>,
  font: string,
): OrderedListMarkerSlot | null {
  let widest: OrderedListMarkerSlot | null = null;
  for (const label of labels) {
    const ink = readerFigureInk(label, font);
    if (ink === null) return null;
    const slot = ink.right - ink.left;
    if (widest === null || slot > widest.slot) widest = { slot, trim: ink.advance - ink.right };
  }
  return widest;
}

/** The custom properties reader.css reads the number column from. */
export const orderedListSlotStyle = (marker: OrderedListMarkerSlot) => ({
  "--reader-ol-slot": `${marker.slot}px`,
  "--reader-ol-trim": `${marker.trim}px`,
});

interface MarkerSlot extends OrderedListMarkerSlot {
  readonly key: string;
}

/**
 * An ordered list of the reading view. Its number column is as wide as the ink of its widest
 * label, and each label's ink ends a marker gap before the text, so both are measured.
 */
export function ReaderOrderedList({
  labels,
  style,
  ...props
}: ComponentProps<"ol"> & { readonly labels: ReadonlyArray<string> }) {
  const ref = useRef<HTMLOListElement>(null);
  const epoch = useSyncExternalStore(
    subscribeReaderLayoutEpoch,
    readerLayoutEpoch,
    readerLayoutEpoch,
  );
  const [marker, setMarker] = useState<MarkerSlot | null>(null);
  const key = `${epoch}|${labels.join(" ")}`;

  const measure = useEffectEvent((forKey: string) => {
    const element = ref.current;
    if (element === null || labels.length === 0) return;
    const widest = orderedListMarkerSlot(labels, inlineStyleOf(getComputedStyle(element)).font);
    if (widest !== null) setMarker({ key: forKey, ...widest });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the number column follows the ink of the labels in the list's computed font, which only the laid-out DOM gives, before paint
  useLayoutEffect(() => measure(key), [key]);

  const current = marker?.key === key ? marker : null;
  const slot = current && orderedListSlotStyle(current);
  return <ol {...props} ref={ref} style={slot ? { ...style, ...slot } : style} />;
}

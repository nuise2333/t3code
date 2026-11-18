import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { formatThreadFindCount } from "~/components/chat/threadFind";
import { cn } from "~/lib/utils";

export function ReaderFindBar(props: {
  readonly query: string;
  readonly count: number;
  readonly active: number;
  readonly focusRequestId: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (delta: number) => void;
  readonly onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses and selects the input DOM node when the bar opens or the find shortcut fires again
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Each find shortcut bumps the request id, so an open bar refocuses and reselects its query.
    props.focusRequestId,
  ]);

  const hasQuery = props.query.trim().length > 0;
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    event.preventDefault();
    event.stopPropagation();
    props.onStep(event.shiftKey ? -1 : 1);
  };

  return (
    <div data-reader-find-bar className="absolute inset-x-3 top-2 z-30 flex justify-end">
      <InputGroup
        variant="popover"
        size="lg"
        role="search"
        aria-label="Find in document"
        className="max-w-80"
        onContextMenu={(event) => event.stopPropagation()}
      >
        <InputGroupAddon align="inline-start">
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          value={props.query}
          aria-label="Find in document"
          placeholder="Find"
          maxLength={200}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <InputGroupAddon align="inline-end" inset="pill">
          <span
            aria-live="polite"
            className={cn(
              "min-w-10 text-center text-xs tabular-nums",
              hasQuery && props.count === 0 ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {hasQuery ? formatThreadFindCount(props.active, props.count) : ""}
          </span>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Previous match"
            disabled={props.count === 0}
            onClick={() => props.onStep(-1)}
          >
            <ChevronUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Next match"
            disabled={props.count === 0}
            onClick={() => props.onStep(1)}
          >
            <ChevronDownIcon />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={props.onClose}>
            <XIcon />
          </Button>
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

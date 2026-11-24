import { AtSignIcon, PlayIcon, WrapTextIcon, CheckIcon, CopyIcon } from "lucide-react";
import { toHtml } from "hast-util-to-html";
import React, { use, useEffect, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSettings } from "../../hooks/useSettings";
import type { CodeBlockThemeName } from "../../lib/diffRendering";
import {
  createIncrementalHighlightedDocument,
  highlightCodeToHast,
} from "../../lib/incrementalHighlighting";
import { LRUCache } from "../../lib/lruCache";
import {
  getSyntaxHighlighterPromise,
  MAX_HIGHLIGHTED_CODE_LENGTH,
} from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import {
  hasSpecificPierreIconForFileName,
  syntheticFileNameForLanguageId,
} from "../../pierre-icons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HighlightedCodeLines } from "./HighlightedCodeLines";
import {
  createHighlightCacheKey,
  estimateHighlightedSize,
  extractFenceLanguage,
} from "./MarkdownCodeBlock.logic";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { PierreEntryIcon } from "./PierreEntryIcon";

const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

/** Blocks this long can be folded by hand; nothing folds on its own. */
const MIN_CODE_FOLD_LINES = 48;

function countCodeLines(code: string): number {
  let lines = 1;
  for (let index = code.indexOf("\n"); index !== -1; index = code.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return code.endsWith("\n") ? lines - 1 : lines;
}

const THREAD_FIND_IGNORE_PROPS = {
  "data-thread-find-ignore": "",
} as React.HTMLAttributes<HTMLDivElement>;

export function MarkdownCodeBlockFrame({
  as: Wrapper = "div",
  language,
  fenceTitle,
  theme,
  wrapped = true,
  title,
  actions,
  headerProps,
  folded,
  children,
}: {
  as?: React.ElementType;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  wrapped?: boolean;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  headerProps?: React.HTMLAttributes<HTMLDivElement>;
  /** Undefined when the block is too short to fold. */
  folded?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <Wrapper
      dir="ltr"
      // Clip, not hidden: a hidden overflow makes the block its own scroller and the header could never stick.
      className="chat-markdown-codeblock my-[0.65rem] scroll-mt-3 text-start overflow-clip rounded-lg border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
      data-code-folded={folded === undefined ? undefined : folded ? "true" : "false"}
    >
      <div
        {...headerProps}
        className={cn(
          "chat-markdown-codeblock-header sticky top-0 z-[2] flex items-center justify-between gap-2 bg-secondary pt-1.5 pr-1.5 pb-0 pl-3 select-none",
          headerProps?.className,
        )}
      >
        {title ?? (
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs">
            <MarkdownCodeBlockTitleContent
              fenceTitle={fenceTitle}
              language={language}
              theme={theme}
            />
          </span>
        )}
        {actions}
      </div>
      {children}
    </Wrapper>
  );
}

function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

export interface CodeBlockCitationInput {
  readonly code: string;
  readonly language: string;
  readonly fenceTitle: string | null;
  readonly element: HTMLElement | null;
}

export function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  onRunShellCommand,
  onCiteCodeBlock,
  isStreaming,
  viewToggle,
  canWrap = true,
  wrapByDefault,
  diagram = false,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  onRunShellCommand?: ((command: string) => void) | undefined;
  onCiteCodeBlock?: ((input: CodeBlockCitationInput) => void) | undefined;
  isStreaming: boolean;
  viewToggle?: ReactNode;
  canWrap?: boolean;
  /** Overrides the word wrap preference as the starting state. */
  wrapByDefault?: boolean | undefined;
  diagram?: boolean;
  children: ReactNode;
}) {
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard({
    timeout: 1200,
    onError: (cause) =>
      reportMarkdownActionFailure(
        {
          operation: "copy-code-block",
          language,
          ...(fenceTitle ? { fenceTitle } : {}),
        },
        cause,
      ),
  });
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const [wrapOverride, setWrapOverride] = useState<boolean | null>(null);
  const wrapped = wrapOverride ?? wrapByDefault ?? wordWrap;
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";
  const command = code.trim();
  const canRun =
    onRunShellCommand !== undefined &&
    !isStreaming &&
    /^(?:sh|bash|zsh|fish|shell|powershell|pwsh)$/.test(language) &&
    code.endsWith("\n") &&
    command.length > 0 &&
    !command.endsWith("\\") &&
    // Control and invisible format characters (bidi overrides, zero-width) can
    // make the rendered command differ from what the terminal would receive.
    !/[\p{Cc}\p{Cf}]/u.test(code.slice(0, -1));

  const handleCopy = () => copyToClipboard(code);
  const lineCount = countCodeLines(code);
  const foldable = !isStreaming && lineCount >= MIN_CODE_FOLD_LINES;
  const [folded, setFolded] = useState(false);
  const foldLabel = folded ? `Expand ${lineCount} lines` : `Fold ${lineCount} lines`;
  const toggleFold = (event: React.MouseEvent<HTMLElement>) => {
    const block = event.currentTarget.closest<HTMLElement>(".chat-markdown-codeblock");
    setFolded(!folded);
    // Folding a block whose top scrolled away would strand the reader below it.
    if (!folded && block && block.getBoundingClientRect().top < 0) {
      block.scrollIntoView({ block: "start" });
    }
  };

  const citeButton =
    onCiteCodeBlock && !isStreaming && code.trim().length > 0 ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              onClick={(event) => {
                const block = event.currentTarget.closest<HTMLElement>(".chat-markdown-codeblock");
                onCiteCodeBlock({ code, language, fenceTitle, element: block });
              }}
              aria-label="Cite code block in composer"
            />
          }
        >
          <AtSignIcon className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="top">Cite in composer</TooltipPopup>
      </Tooltip>
    ) : null;

  const copyButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-xs"
            onClick={handleCopy}
            aria-label={copyLabel}
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{copyLabel}</TooltipPopup>
    </Tooltip>
  );

  if (diagram) {
    return (
      <div className="my-[0.65rem] border border-transparent" data-language={language}>
        <div className="flex items-center justify-end gap-0.5 pt-1.5 pr-1.5 select-none">
          {viewToggle}
          {citeButton}
          {copyButton}
        </div>
        {children}
      </div>
    );
  }

  return (
    <MarkdownCodeBlockFrame
      language={language}
      fenceTitle={fenceTitle}
      theme={theme}
      wrapped={wrapped}
      headerProps={THREAD_FIND_IGNORE_PROPS}
      folded={foldable ? folded : undefined}
      actions={
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          {foldable ? (
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              aria-pressed={folded}
              onClick={toggleFold}
            >
              {foldLabel}
            </Button>
          ) : null}
          {canWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={wrapped ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={wrapped}
                    onClick={() => setWrapOverride(!wrapped)}
                    aria-label={wrapLabel}
                  />
                }
              >
                <WrapTextIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canRun ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost-muted"
                    size="icon-xs"
                    onClick={() => onRunShellCommand(command)}
                    aria-label="Run in terminal"
                  />
                }
              >
                <PlayIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Run in terminal</TooltipPopup>
            </Tooltip>
          ) : null}
          {viewToggle}
          {citeButton}
          {copyButton}
        </span>
      }
    >
      {children}
    </MarkdownCodeBlockFrame>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: CodeBlockThemeName;
  isStreaming: boolean;
}

export function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: SuspenseShikiCodeBlockProps) {
  const [hasStreamed, setHasStreamed] = useState(isStreaming);
  if (isStreaming && !hasStreamed) setHasStreamed(true);
  const language =
    code.length > MAX_HIGHLIGHTED_CODE_LENGTH ? "text" : extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  // Once lines are mounted individually, keep that renderer when streaming
  // finishes so switching to cached HTML cannot clear an existing selection.
  const cachedHighlightedHtml =
    !isStreaming && !hasStreamed ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
      preserveLines={isStreaming || hasStreamed}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: CodeBlockThemeName;
  cacheKey: string;
  isStreaming: boolean;
  preserveLines: boolean;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  preserveLines,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const incrementalHighlight = preserveLines
    ? createIncrementalHighlightedDocument(highlighter, language, themeName)
    : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes the incremental Shiki highlighter when it is replaced or the block unmounts
  useEffect(() => () => incrementalHighlight?.dispose(), [incrementalHighlight]);
  const highlighted = (() => {
    const result = (() => {
      try {
        if (incrementalHighlight) return incrementalHighlight(code);
        return preserveLines
          ? highlightCodeToHast(highlighter, code, language, themeName)
          : highlighter.codeToHtml(code, { lang: language, theme: themeName });
      } catch (error) {
        console.warn(
          `Code highlighting failed for language "${language}", falling back to plain text.`,
          error instanceof Error ? error.message : error,
        );
        return preserveLines
          ? highlightCodeToHast(highlighter, code, "text", themeName)
          : highlighter.codeToHtml(code, { lang: "text", theme: themeName });
      }
    })();
    // A finished block is cached for the next mount; a streaming one is still changing.
    if (!isStreaming) {
      const highlightedHtml = typeof result === "string" ? result : toHtml(result);
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, cacheKey),
      );
    }
    return result;
  })();

  return typeof highlighted === "string" ? (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlighted }} />
  ) : (
    <div className="chat-markdown-shiki">
      <HighlightedCodeLines root={highlighted} />
    </div>
  );
}

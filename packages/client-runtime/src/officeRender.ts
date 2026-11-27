import type { AssetResource } from "@t3tools/contracts";
import type { OfficeRenderKind } from "@t3tools/shared/filePreview";

export type OfficeRenderSource = Extract<AssetResource, { _tag: "office-render" }>["source"];

/** `unsupported` covers hosts that predate the renderer and files it cannot reach; it shows no notice. */
export type OfficeRenderFallback = "unavailable" | "failed" | "unsupported";

export type OfficeRenderState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "pdf"; readonly url: string }
  | { readonly _tag: "fallback"; readonly reason: OfficeRenderFallback };

export type OfficeSheetView = "layout" | "grid";

export function officeRenderFallback(cause: unknown): OfficeRenderFallback {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  return tag === "AssetOfficeRendererUnavailableError"
    ? "unavailable"
    : tag === "AssetOfficeRenderError"
      ? "failed"
      : "unsupported";
}

export function officeRenderNotice(reason: OfficeRenderFallback, hasParser: boolean) {
  if (reason === "unavailable")
    return hasParser
      ? "Install LibreOffice on the computer running T3 Code to see the original layout; showing a simplified preview."
      : "Install LibreOffice on the computer running T3 Code to preview this file.";
  if (reason === "failed")
    return hasParser
      ? "LibreOffice couldn't open this file; showing a simplified preview."
      : "LibreOffice couldn't open this file.";
  return null;
}

/**
 * The server converts on the first request for the signed URL, so one byte is fetched before a
 * viewer mounts: the wait shows as loading, and a failed conversion falls back instead of
 * surfacing inside the PDF viewer.
 */
export async function prepareOfficeRender(input: {
  readonly mint: () => Promise<string | null>;
  readonly fetch: (
    url: string,
    init: { readonly headers: Record<string, string>; readonly signal: AbortSignal },
  ) => Promise<Pick<Response, "ok" | "status" | "body">>;
  readonly signal: AbortSignal;
}): Promise<Exclude<OfficeRenderState, { _tag: "loading" }>> {
  try {
    const url = await input.mint();
    if (!url) return { _tag: "fallback", reason: "unsupported" };
    const response = await input.fetch(url, {
      headers: { Range: "bytes=0-0" },
      signal: input.signal,
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.ok) return { _tag: "pdf", url };
    return {
      _tag: "fallback",
      reason:
        response.status === 503
          ? "unavailable"
          : response.status === 422
            ? "failed"
            : "unsupported",
    };
  } catch (cause) {
    return { _tag: "fallback", reason: officeRenderFallback(cause) };
  }
}

function hasGrid(input: { renderKind: OfficeRenderKind | null; hasParser: boolean }) {
  return input.renderKind === "spreadsheet" && input.hasParser;
}

export function wantsOfficeRender(input: {
  readonly renderKind: OfficeRenderKind | null;
  readonly hasParser: boolean;
  readonly hasSource: boolean;
  readonly sheetView: OfficeSheetView;
}) {
  return (
    input.renderKind !== null && input.hasSource && !(hasGrid(input) && input.sheetView === "grid")
  );
}

/** What an Office preview shows: LibreOffice's PDF, the built-in parser, or nothing. */
export function officePreviewView(input: {
  readonly renderKind: OfficeRenderKind | null;
  readonly hasParser: boolean;
  readonly hasSource: boolean;
  readonly sheetView: OfficeSheetView;
  readonly render: OfficeRenderState;
}): {
  readonly body: "loading" | "pdf" | "parser" | "none";
  readonly notice: string | null;
  /** Whether the layout/grid switch is offered. */
  readonly sheetToggle: boolean;
} {
  const parser = input.hasParser ? "parser" : "none";
  const sheetToggle = hasGrid(input) && input.hasSource;
  if (!wantsOfficeRender(input)) return { body: parser, notice: null, sheetToggle };
  if (input.render._tag === "fallback") {
    return {
      body: parser,
      notice: officeRenderNotice(input.render.reason, input.hasParser),
      sheetToggle: false,
    };
  }
  return { body: input.render._tag, notice: null, sheetToggle };
}

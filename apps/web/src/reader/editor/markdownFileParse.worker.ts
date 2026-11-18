import "./markdownFileParseWorkerDocument";
import { parseMarkdownFile } from "./markdownFileParse";
import type { MarkdownParseRequest, MarkdownParseResponse } from "./markdownFileParseProtocol";

self.addEventListener("message", (event: MessageEvent<MarkdownParseRequest>) => {
  const { id, source, math } = event.data;
  let response: MarkdownParseResponse;
  try {
    response = { id, ok: true, parse: parseMarkdownFile(source, { math }) };
  } catch (cause) {
    response = { id, ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  self.postMessage(response, { transfer: response.ok ? [response.parse.inline.buffer] : [] });
});

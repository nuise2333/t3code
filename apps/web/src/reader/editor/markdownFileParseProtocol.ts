import type { MarkdownFileParse } from "./markdownFileParse";

/** Files this large parse in a worker; smaller ones parse on the main thread, as fast. */
export const MARKDOWN_PARSE_WORKER_MIN_LENGTH = 128 * 1024;

export interface MarkdownParseRequest {
  readonly id: number;
  readonly source: string;
  readonly math: boolean;
}

export type MarkdownParseResponse =
  | { readonly id: number; readonly ok: true; readonly parse: MarkdownFileParse }
  | { readonly id: number; readonly ok: false; readonly message: string };

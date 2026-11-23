const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const FILE_PATH_RE = /(?:^|[\s(])(?:~\/|\/|\.\.?\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./:-]+/g;

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/g;
const HANGUL_RE = /[\uac00-\ud7af\u1100-\u11ff]/g;
const CYRILLIC_RE = /[\u0400-\u04ff]/g;
const ARABIC_RE = /[\u0600-\u06ff]/g;
const LATIN_RE = /[A-Za-z\u00c0-\u024f]/g;
const LATIN_WORD_RE = /[A-Za-z]{3,}/g;

const MAX_HEURISTIC_SAMPLE_CHARS = 8_000;

type TargetLanguageFamily =
  | "chinese"
  | "japanese"
  | "korean"
  | "cyrillic"
  | "arabic"
  | "english"
  | "other";

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

export function classifyTargetLanguage(targetLanguage: string): TargetLanguageFamily {
  const normalized = targetLanguage.trim().toLowerCase();
  if (!normalized) return "other";
  if (
    normalized === "zh" ||
    normalized.startsWith("zh-") ||
    normalized.startsWith("zh_") ||
    normalized.includes("chinese") ||
    normalized.includes("中文") ||
    normalized.includes("汉语") ||
    normalized.includes("漢語") ||
    normalized.includes("普通话") ||
    normalized.includes("国语") ||
    normalized.includes("國語") ||
    normalized.includes("粤语") ||
    normalized.includes("粵語")
  ) {
    return "chinese";
  }
  if (
    normalized === "ja" ||
    normalized === "jp" ||
    normalized.startsWith("ja-") ||
    normalized.includes("japanese") ||
    normalized.includes("日本語") ||
    normalized.includes("日语") ||
    normalized.includes("日文")
  ) {
    return "japanese";
  }
  if (
    normalized === "ko" ||
    normalized === "kr" ||
    normalized.startsWith("ko-") ||
    normalized.includes("korean") ||
    normalized.includes("한국어") ||
    normalized.includes("韩语") ||
    normalized.includes("韩文")
  ) {
    return "korean";
  }
  if (
    normalized === "ru" ||
    normalized === "uk" ||
    normalized.startsWith("ru-") ||
    normalized.startsWith("uk-") ||
    normalized.includes("russian") ||
    normalized.includes("русский") ||
    normalized.includes("俄语") ||
    normalized.includes("ukrainian") ||
    normalized.includes("українська")
  ) {
    return "cyrillic";
  }
  if (
    normalized === "ar" ||
    normalized.startsWith("ar-") ||
    normalized.includes("arabic") ||
    normalized.includes("العربية") ||
    normalized.includes("阿拉伯语")
  ) {
    return "arabic";
  }
  if (
    normalized === "en" ||
    normalized.startsWith("en-") ||
    normalized.startsWith("en_") ||
    normalized.includes("english") ||
    normalized.includes("英语") ||
    normalized.includes("英文")
  ) {
    return "english";
  }
  return "other";
}

function stripNonProse(text: string): string {
  const sample =
    text.length > MAX_HEURISTIC_SAMPLE_CHARS ? text.slice(0, MAX_HEURISTIC_SAMPLE_CHARS) : text;
  return sample
    .replace(FENCED_CODE_RE, " ")
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ")
    .replace(FILE_PATH_RE, " ");
}

/**
 * Cheap script-based check to skip translating reasoning text that is already written in the
 * user's target language (or contains no prose beyond code, paths, and punctuation).
 */
export function isAlreadyTargetLanguage(text: string, targetLanguage: string): boolean {
  const normalizedTarget = targetLanguage.trim();
  if (!normalizedTarget) return true;

  const trimmed = text.trim();
  if (trimmed.length < 4) return true;

  const prose = stripNonProse(trimmed);
  const han = countMatches(prose, HAN_RE);
  const kana = countMatches(prose, KANA_RE);
  const hangul = countMatches(prose, HANGUL_RE);
  const cyrillic = countMatches(prose, CYRILLIC_RE);
  const arabic = countMatches(prose, ARABIC_RE);
  const latin = countMatches(prose, LATIN_RE);
  const total = han + kana + hangul + cyrillic + arabic + latin;

  if (total < 4) return true;

  const family = classifyTargetLanguage(normalizedTarget);
  switch (family) {
    case "chinese": {
      if (kana >= 4 || hangul >= 4 || cyrillic >= 6 || arabic >= 6) return false;
      const latinWords = countMatches(prose, LATIN_WORD_RE);
      if (han >= 4 && latinWords === 0) return true;
      return han >= 6 && han / total >= 0.45 && latinWords < Math.max(8, Math.floor(han / 2));
    }
    case "japanese": {
      if (hangul >= 4 || cyrillic >= 6) return false;
      const latinWords = countMatches(prose, LATIN_WORD_RE);
      return kana >= 4 && (han + kana) / total >= 0.45 && latinWords < Math.max(8, han + kana);
    }
    case "korean": {
      if (kana >= 4 || cyrillic >= 6) return false;
      return hangul >= 4 && hangul / total >= 0.45;
    }
    case "cyrillic":
      return cyrillic >= 6 && cyrillic / total >= 0.5;
    case "arabic":
      return arabic >= 6 && arabic / total >= 0.5;
    case "english":
      return latin >= 6 && han + kana + hangul + cyrillic + arabic < 4 && latin / total >= 0.85;
    case "other":
      return false;
  }
}

export function shouldTranslateThought(text: string, targetLanguage: string): boolean {
  return (
    targetLanguage.trim().length > 0 &&
    text.trim().length > 0 &&
    !isAlreadyTargetLanguage(text, targetLanguage)
  );
}

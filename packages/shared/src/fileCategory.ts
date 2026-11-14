import { ProjectFileCategory } from "@t3tools/contracts";

const FILE_CATEGORIES = ProjectFileCategory.literals;

const FILE_CATEGORY_EXTENSIONS: Record<ProjectFileCategory, string> = {
  document:
    "pdf doc docx xls xlsx ppt pptx pages numbers key txt md markdown mdx rtf csv tsv epub odt ods odp tex log rst adoc",
  image: "png jpg jpeg gif heic heif webp bmp tiff tif svg psd ai sketch fig ico icns avif",
  code: "ts tsx js jsx mjs cjs mts cts py rb go rs java kt kts swift c h cc cpp hpp m mm cs php html htm css scss sass less vue svelte astro sh bash zsh fish ps1 json jsonc yaml yml toml xml sql lua dart r pl ex exs erl hs ml scala clj zig nim gradle graphql gql proto tf ipynb",
  video: "mp4 mov mkv avi wmv flv webm m4v mpg mpeg 3gp",
  audio: "mp3 wav flac aac m4a ogg wma aiff aif opus mid midi caf",
  archive: "zip rar 7z tar gz tgz bz2 xz zst dmg iso pkg jar war apk ipa",
};

const CATEGORY_BY_EXTENSION = new Map(
  FILE_CATEGORIES.flatMap((category) =>
    FILE_CATEGORY_EXTENSIONS[category]
      .split(" ")
      .map((extension) => [extension, category] as const),
  ),
);

export function fileCategoryOf(path: string): ProjectFileCategory | null {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0) return null;
  return CATEGORY_BY_EXTENSION.get(basename.slice(dotIndex + 1).toLowerCase()) ?? null;
}

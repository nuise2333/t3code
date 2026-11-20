import type { Bot, BotColor } from "@t3tools/contracts";

const COLOR_CLASS: Record<BotColor, string> = {
  slate: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  red: "bg-red-500/15 text-red-700 dark:text-red-300",
  orange: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  amber: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  green: "bg-green-500/15 text-green-700 dark:text-green-300",
  teal: "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  blue: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  violet: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  pink: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
};

export const BOT_AVATAR_SIZE_CLASS = {
  xs: "size-5 text-xs",
  sm: "size-7 text-sm",
  md: "size-9 text-lg",
  lg: "size-10 text-xl",
  xl: "size-14 text-3xl",
} as const;

export function BotAvatar({
  bot,
  size = "sm",
}: {
  readonly bot: Pick<Bot, "avatar" | "color">;
  readonly size?: keyof typeof BOT_AVATAR_SIZE_CLASS;
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full ${COLOR_CLASS[bot.color]} ${BOT_AVATAR_SIZE_CLASS[size]}`}
    >
      {bot.avatar || "🤖"}
    </span>
  );
}

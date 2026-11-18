import type { CSSProperties } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_READER_FONT_SIZE,
  MAX_READER_ZOOM,
  MIN_READER_FONT_SIZE,
  MIN_READER_ZOOM,
  READER_ZOOM_STEP,
  ReaderTableStyle,
  ReaderTheme,
  ReaderTypography,
} from "@t3tools/contracts/settings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const READER_TYPOGRAPHY_LABELS: Record<ReaderTypography, string> = {
  serif: "Serif",
  sans: "Sans",
  "serif-charter": "Charter",
  "sans-avenir": "Avenir Next",
  "serif-tc": "Traditional Chinese",
  book: "Book",
};

const READER_THEME_LABELS: Record<ReaderTheme, string> = {
  mono: "Mono",
  classic: "Classic",
  one: "One",
  solarized: "Solarized",
  app: "App theme",
};

const READER_TABLE_STYLE_LABELS: Record<ReaderTableStyle, string> = {
  booktabs: "Ruled",
  grid: "Grid",
};

const READER_FONT_SIZES = Array.from(
  { length: MAX_READER_FONT_SIZE - MIN_READER_FONT_SIZE + 1 },
  (_, index) => MIN_READER_FONT_SIZE + index,
);

function ReaderChoiceRow<Choice extends string>({
  id,
  title,
  description,
  resetLabel,
  choices,
  labels,
  value,
  defaultValue,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  resetLabel: string;
  choices: ReadonlyArray<Choice>;
  labels: Record<Choice, string>;
  value: Choice;
  defaultValue: Choice;
  onChange: (value: Choice) => void;
}) {
  return (
    <SettingsRow
      id={id}
      title={title}
      description={description}
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton label={resetLabel} onClick={() => onChange(defaultValue)} />
        ) : null
      }
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            const choice = choices.find((candidate) => candidate === next);
            if (choice !== undefined) onChange(choice);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-44" aria-label={title}>
            <SelectValue>{labels[value]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {choice === defaultValue ? `${labels[choice]} (default)` : labels[choice]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function ReaderSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const zoomRatio = (settings.readerZoom - MIN_READER_ZOOM) / (MAX_READER_ZOOM - MIN_READER_ZOOM);
  const zoomSliderStyle = {
    "--settings-slider-progress": `${zoomRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - zoomRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsSection id="reader" title="Reader">
      <ReaderChoiceRow
        {...searchableSetting("reader-typography")}
        description="Fonts for rendered Markdown files. Book indents paragraphs instead of spacing them."
        resetLabel="reading typography"
        choices={ReaderTypography.literals}
        labels={READER_TYPOGRAPHY_LABELS}
        value={settings.readerTypography}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.readerTypography}
        onChange={(readerTypography) => updateSettings({ readerTypography })}
      />
      <SettingsRow
        {...searchableSetting("reader-font-size")}
        description="Body text size. Headings and code scale with it."
        resetAction={
          settings.readerFontSize !== DEFAULT_UNIFIED_SETTINGS.readerFontSize ? (
            <SettingResetButton
              label="reading font size"
              onClick={() =>
                updateSettings({ readerFontSize: DEFAULT_UNIFIED_SETTINGS.readerFontSize })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.readerFontSize)}
            onValueChange={(next) => {
              const readerFontSize = READER_FONT_SIZES.find((px) => String(px) === next);
              if (readerFontSize !== undefined) updateSettings({ readerFontSize });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Reading font size">
              <SelectValue>{settings.readerFontSize} px</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {READER_FONT_SIZES.map((px) => (
                <SelectItem key={px} value={String(px)}>
                  {px === DEFAULT_UNIFIED_SETTINGS.readerFontSize
                    ? `${px} px (default)`
                    : `${px} px`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("reader-justify")}
        description="Align body text to both edges of the column instead of the left edge."
        resetAction={
          settings.readerJustify !== DEFAULT_UNIFIED_SETTINGS.readerJustify ? (
            <SettingResetButton
              label="text justification"
              onClick={() =>
                updateSettings({ readerJustify: DEFAULT_UNIFIED_SETTINGS.readerJustify })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.readerJustify}
            onCheckedChange={(checked) => updateSettings({ readerJustify: Boolean(checked) })}
            aria-label="Justify text"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("reader-limit-width")}
        description="Keep lines a comfortable length and center the text in wide panels."
        resetAction={
          settings.readerLimitWidth !== DEFAULT_UNIFIED_SETTINGS.readerLimitWidth ? (
            <SettingResetButton
              label="reading width limit"
              onClick={() =>
                updateSettings({ readerLimitWidth: DEFAULT_UNIFIED_SETTINGS.readerLimitWidth })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.readerLimitWidth}
            onCheckedChange={(checked) => updateSettings({ readerLimitWidth: Boolean(checked) })}
            aria-label="Limit reading width"
          />
        }
      />
      <ReaderChoiceRow
        {...searchableSetting("reader-theme")}
        description="Colors for rendered Markdown files. App theme matches the rest of the app."
        resetLabel="reading theme"
        choices={ReaderTheme.literals}
        labels={READER_THEME_LABELS}
        value={settings.readerTheme}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.readerTheme}
        onChange={(readerTheme) => updateSettings({ readerTheme })}
      />
      <ReaderChoiceRow
        {...searchableSetting("reader-table-style")}
        description="Ruled draws horizontal lines only. Grid outlines every cell."
        resetLabel="table style"
        choices={ReaderTableStyle.literals}
        labels={READER_TABLE_STYLE_LABELS}
        value={settings.readerTableStyle}
        defaultValue={DEFAULT_UNIFIED_SETTINGS.readerTableStyle}
        onChange={(readerTableStyle) => updateSettings({ readerTableStyle })}
      />
      <SettingsRow
        {...searchableSetting("reader-zoom")}
        description="Magnify the whole reading view, including images and spacing."
        resetAction={
          settings.readerZoom !== DEFAULT_UNIFIED_SETTINGS.readerZoom ? (
            <SettingResetButton
              label="reading zoom"
              onClick={() => updateSettings({ readerZoom: DEFAULT_UNIFIED_SETTINGS.readerZoom })}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-3 sm:w-52">
            <output
              className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
              htmlFor="reader-zoom-percent"
            >
              {settings.readerZoom}%
            </output>
            <input
              aria-label="Reading zoom"
              className="settings-slider min-w-0 flex-1"
              id="reader-zoom-percent"
              max={MAX_READER_ZOOM}
              min={MIN_READER_ZOOM}
              onChange={(event) => {
                const readerZoom = Number(event.currentTarget.value);
                if (
                  Number.isInteger(readerZoom) &&
                  readerZoom >= MIN_READER_ZOOM &&
                  readerZoom <= MAX_READER_ZOOM
                ) {
                  updateSettings({ readerZoom });
                }
              }}
              step={READER_ZOOM_STEP}
              style={zoomSliderStyle}
              type="range"
              value={settings.readerZoom}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

import type { CSSProperties } from "react";
import { useState } from "react";
import {
  DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
  DEFAULT_UNIFIED_SETTINGS,
  type ChatWidth,
  type EffortDisplay,
  type EnvironmentIdentificationMode,
  type OpticalAmbientIntensity,
  type OpticalMotionLevel,
  type OpticalSpectrum,
  type OpticalTargetFps,
  type UnifiedSettings,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MAX_PANEL_ANIMATION_DURATION_MS,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  MIN_PANEL_ANIMATION_DURATION_MS,
} from "@t3tools/contracts/settings";
import {
  resolveSidebarStageBackdropVariant,
  type SidebarStageBackdropVariant,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemeLibrary } from "./ThemeSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { AdvancedSettings } from "./AdvancedSettings";
import { FileIconThemeRow } from "./FileIconThemeSettings";
import { PanelAnimationsPreview } from "./PanelAnimationsPreview";
import { ReaderSection } from "./ReaderSettings";
import { TypographySection } from "./TypographySettings";
import { ThreadDetailsItemsRow } from "./ThreadDetailsItemsRow";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  "nightly-artwork": "Nightly artwork",
  "dev-artwork": "Dev artwork",
  pill: "Version pill",
  none: "None",
};

// The default "artwork" follows the running channel, so it is labeled as that channel's art,
// or as "None" on Latest. The other channel's art is offered as a fixed choice.
function environmentIdentificationOptions(
  stageVariant: SidebarStageBackdropVariant | null,
): ReadonlyArray<readonly [EnvironmentIdentificationMode, string]> {
  if (stageVariant === "dev") {
    return [
      ["artwork", "Dev artwork"],
      ["nightly-artwork", "Nightly artwork"],
      ["pill", "Version pill"],
      ["none", "None"],
    ];
  }
  if (stageVariant === "nightly") {
    return [
      ["artwork", "Nightly artwork"],
      ["dev-artwork", "Dev artwork"],
      ["pill", "Version pill"],
      ["none", "None"],
    ];
  }
  return [
    ["artwork", "None"],
    ["nightly-artwork", "Nightly artwork"],
    ["dev-artwork", "Dev artwork"],
  ];
}

const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
};

const EFFORT_DISPLAY_LABELS: Record<EffortDisplay, string> = {
  label: "Word",
  bars: "Bars",
};

const OPTICAL_MOTION_OPTIONS: ReadonlyArray<readonly [OpticalMotionLevel, string]> = [
  ["off", "Off"],
  ["subtle", "Subtle"],
  ["standard", "Standard"],
  ["ultra", "Ultra"],
];

const OPTICAL_AMBIENT_OPTIONS: ReadonlyArray<readonly [OpticalAmbientIntensity, string]> = [
  [0, "Off (0%)"],
  [35, "Subtle (35%)"],
  [70, "Balanced (70%)"],
  [100, "Full (100%)"],
];

const OPTICAL_SPECTRUM_OPTIONS: ReadonlyArray<readonly [OpticalSpectrum, string]> = [
  ["follow", "Follow theme"],
  ["cobalt", "Cobalt"],
  ["iris", "Iris"],
  ["amber", "Amber"],
  ["mono", "Monochrome"],
];

const OPTICAL_TARGET_FPS_OPTIONS: ReadonlyArray<readonly [OpticalTargetFps, string]> = [
  ["60", "60 fps"],
  ["120", "120 fps"],
  ["180", "180 fps"],
  ["native", "Native"],
];

type OpticalScenePreset = Pick<
  UnifiedSettings,
  | "opticalMotionLevel"
  | "opticalAmbientIntensity"
  | "opticalHomeRipple"
  | "opticalSmoothCaret"
  | "opticalTargetFps"
>;

const OPTICAL_SCENE_PRESETS: ReadonlyArray<readonly [string, OpticalScenePreset]> = [
  [
    "Full Optical",
    {
      opticalMotionLevel: "ultra",
      opticalAmbientIntensity: 100,
      opticalHomeRipple: true,
      opticalSmoothCaret: true,
      opticalTargetFps: "120",
    },
  ],
  [
    "Deep Focus",
    {
      opticalMotionLevel: "subtle",
      opticalAmbientIntensity: 35,
      opticalHomeRipple: false,
      opticalSmoothCaret: true,
      opticalTargetFps: "120",
    },
  ],
  [
    "Silent Eco",
    {
      opticalMotionLevel: "off",
      opticalAmbientIntensity: 0,
      opticalHomeRipple: false,
      opticalSmoothCaret: false,
      opticalTargetFps: "60",
    },
  ],
];

function matchesOpticalScenePreset(settings: OpticalScenePreset, preset: OpticalScenePreset) {
  return (
    settings.opticalMotionLevel === preset.opticalMotionLevel &&
    settings.opticalAmbientIntensity === preset.opticalAmbientIntensity &&
    settings.opticalHomeRipple === preset.opticalHomeRipple &&
    settings.opticalSmoothCaret === preset.opticalSmoothCaret &&
    settings.opticalTargetFps === preset.opticalTargetFps
  );
}

function optionLabel<Value>(
  options: ReadonlyArray<readonly [Value, string]>,
  value: Value,
): string | undefined {
  return options.find(([optionValue]) => optionValue === value)?.[1];
}

export function AppearanceSettingsPanel() {
  const {
    appearanceMode,
    refreshTheme,
    resolvedTheme,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    theme,
    themeHalves,
  } = useTheme();
  const customThemes = useCustomThemes();
  const [isImportThemeOpen, setIsImportThemeOpen] = useState(false);
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentStageLabel = useEnvironmentStageLabel();
  const environmentStageVariant = resolveSidebarStageBackdropVariant(environmentStageLabel);
  const environmentIdentificationOptionList =
    environmentIdentificationOptions(environmentStageVariant);
  const environmentIdentificationLabel =
    environmentIdentificationOptionList.find(
      ([value]) => value === settings.environmentIdentificationMode,
    )?.[1] ?? ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode];
  const effectiveEnvironmentIdentificationMode = useEnvironmentIdentificationMode();
  const themeHidesEnvironmentArtwork =
    effectiveEnvironmentIdentificationMode === "pill" &&
    resolveSidebarStageBackdropVariant(
      environmentStageLabel,
      settings.environmentIdentificationMode,
    ) !== null;
  const environmentIdentificationDescription = themeHidesEnvironmentArtwork
    ? environmentStageVariant
      ? "Only built-in themes show artwork, so this theme shows the version pill."
      : "Only built-in themes show artwork."
    : environmentStageVariant
      ? "Choose how Dev and Nightly environments are identified."
      : "Show Dev or Nightly artwork in the sidebar header.";
  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;
  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;

  return (
    <SettingsPageContainer>
      <SettingsSection id="appearance" title="Colors & themes" variant="plain" hideTitle>
        <div id={searchableSetting("theme").id}>
          <ThemeLibrary
            appearanceMode={appearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
            refreshTheme={refreshTheme}
            isImportOpen={isImportThemeOpen}
            setAppearanceMode={setAppearanceMode}
            setTheme={setTheme}
            setThemeHalf={setThemeHalf}
            theme={theme}
            themeHalves={themeHalves}
            onImportOpenChange={setIsImportThemeOpen}
          />
        </div>
      </SettingsSection>

      <SettingsSection id="appearance-interface" title="Interface">
        <SettingsRow
          {...searchableSetting("setting-appearance-contrast")}
          description="Adjust the contrast of colors and borders across the interface."
          resetAction={
            settings.appearanceContrast !== DEFAULT_UNIFIED_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label="Contrast"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("setting-glass-opacity")}
          description="Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_UNIFIED_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />

        <SettingsRow
          {...searchableSetting("chat-width")}
          description="Set how wide messages and the composer can grow on large screens."
          resetAction={
            settings.chatWidth !== DEFAULT_UNIFIED_SETTINGS.chatWidth ? (
              <SettingResetButton
                label="chat width"
                onClick={() => updateSettings({ chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth })}
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.chatWidth}
                onValueChange={(value) => {
                  if (value === "comfortable" || value === "wide" || value === "full")
                    updateSettings({ chatWidth: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Chat width">
                  <SelectValue>{CHAT_WIDTH_LABELS[settings.chatWidth]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="comfortable">Comfortable (default)</SelectItem>
                  <SelectItem value="wide">Wide</SelectItem>
                  <SelectItem value="full">Full</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <FileIconThemeRow />
        <ThreadDetailsItemsRow />
        <SettingsRow
          {...searchableSetting("effort-display")}
          description="Show reasoning effort in the composer as its name, such as High, or as bars."
          resetAction={
            settings.effortDisplay !== DEFAULT_UNIFIED_SETTINGS.effortDisplay ? (
              <SettingResetButton
                label="effort display"
                onClick={() =>
                  updateSettings({ effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.effortDisplay}
                onValueChange={(value) => {
                  if (value === "bars" || value === "label")
                    updateSettings({ effortDisplay: value });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Effort display">
                  <SelectValue>{EFFORT_DISPLAY_LABELS[settings.effortDisplay]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="label">Word (default)</SelectItem>
                  <SelectItem value="bars">Bars</SelectItem>
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("math-rendering")}
          description="Typeset LaTeX math, such as $x^2$ or \[x^2\], in messages and Markdown previews. The composer keeps TeX source editable."
          resetAction={
            settings.mathRenderingEnabled !== DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled ? (
              <SettingResetButton
                label="math rendering"
                onClick={() =>
                  updateSettings({
                    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.mathRenderingEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ mathRenderingEnabled: Boolean(checked) })
              }
              aria-label="Render math"
            />
          }
        />
        <AdvancedSettings
          targetIds={[
            searchableSetting("panel-animations").id,
            searchableSetting("environment-identification").id,
            // Environment identification's search result lands on this section.
            "appearance-interface",
            searchableSetting("composer-context").id,
          ]}
        >
          <SettingsRow
            {...searchableSetting("panel-animations")}
            description="Set how fast panels open and close."
            control={
              <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
                <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
                <div className="flex w-full items-center gap-3">
                  <output
                    className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="panel-animation-duration"
                  >
                    {settings.panelAnimationDurationMs} ms
                  </output>
                  <input
                    aria-label="Panel animation duration"
                    className="settings-slider min-w-0 flex-1"
                    id="panel-animation-duration"
                    max={MAX_PANEL_ANIMATION_DURATION_MS}
                    min={MIN_PANEL_ANIMATION_DURATION_MS}
                    onChange={(event) => {
                      const panelAnimationDurationMs = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(panelAnimationDurationMs) &&
                        panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                        panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                      ) {
                        updateSettings({ panelAnimationDurationMs });
                      }
                    }}
                    step={25}
                    style={panelAnimationDurationSliderStyle}
                    type="range"
                    value={settings.panelAnimationDurationMs}
                  />
                </div>
              </div>
            }
            resetAction={
              settings.panelAnimationDurationMs !==
              DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs ? (
                <SettingResetButton
                  label="panel animations"
                  onClick={() =>
                    updateSettings({
                      panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
                    })
                  }
                />
              ) : null
            }
          />
          <SettingsRow
            {...searchableSetting("environment-identification")}
            description={environmentIdentificationDescription}
            resetAction={
              settings.environmentIdentificationMode !== DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE ? (
                <SettingResetButton
                  label="environment identification"
                  onClick={() =>
                    updateSettings({
                      environmentIdentificationMode: DEFAULT_ENVIRONMENT_IDENTIFICATION_MODE,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.environmentIdentificationMode}
                onValueChange={(value) => {
                  const option = environmentIdentificationOptionList.find(
                    ([optionValue]) => optionValue === value,
                  );
                  if (option) updateSettings({ environmentIdentificationMode: option[0] });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Environment identification"
                >
                  <SelectValue>{environmentIdentificationLabel}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environmentIdentificationOptionList.map(([value, label]) => (
                    <SelectItem hideIndicator key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            {...searchableSetting("composer-context")}
            description="Keep branch and worktree controls below the composer after a thread starts."
            resetAction={
              settings.persistComposerContextStrip !==
              DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip ? (
                <SettingResetButton
                  label="composer context"
                  onClick={() =>
                    updateSettings({
                      persistComposerContextStrip:
                        DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                checked={settings.persistComposerContextStrip}
                onCheckedChange={(checked) =>
                  updateSettings({ persistComposerContextStrip: Boolean(checked) })
                }
                aria-label="Keep composer context visible in active threads"
              />
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <SettingsSection id="appearance-optical" title="Optical UI & Physics">
        <SettingsRow
          {...searchableSetting("optical-scene-preset")}
          description="WebGL2 optical lighting, ripple fields, and damped-spring physics. Respects system reduced motion."
          control={
            <div className="flex flex-wrap items-center gap-1.5">
              {OPTICAL_SCENE_PRESETS.map(([label, preset]) => {
                const active = matchesOpticalScenePreset(settings, preset);
                return (
                  <Button
                    aria-pressed={active}
                    key={label}
                    onClick={() => updateSettings(preset)}
                    size="xs"
                    variant={active ? "default" : "outline"}
                  >
                    {label}
                  </Button>
                );
              })}
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("optical-motion-level")}
          description="Set how much spring motion the interface uses."
          resetAction={
            settings.opticalMotionLevel !== DEFAULT_UNIFIED_SETTINGS.opticalMotionLevel ? (
              <SettingResetButton
                label="motion physics"
                onClick={() =>
                  updateSettings({
                    opticalMotionLevel: DEFAULT_UNIFIED_SETTINGS.opticalMotionLevel,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.opticalMotionLevel}
                onValueChange={(value) => {
                  const option = OPTICAL_MOTION_OPTIONS.find(
                    ([optionValue]) => optionValue === value,
                  );
                  if (option) updateSettings({ opticalMotionLevel: option[0] });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Motion physics">
                  <SelectValue>
                    {optionLabel(OPTICAL_MOTION_OPTIONS, settings.opticalMotionLevel)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {OPTICAL_MOTION_OPTIONS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("optical-ambient-intensity")}
          description="Set the strength of ambient glow and rim light."
          resetAction={
            settings.opticalAmbientIntensity !==
            DEFAULT_UNIFIED_SETTINGS.opticalAmbientIntensity ? (
              <SettingResetButton
                label="ambient optical intensity"
                onClick={() =>
                  updateSettings({
                    opticalAmbientIntensity: DEFAULT_UNIFIED_SETTINGS.opticalAmbientIntensity,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={String(settings.opticalAmbientIntensity)}
                onValueChange={(value) => {
                  const option = OPTICAL_AMBIENT_OPTIONS.find(
                    ([optionValue]) => String(optionValue) === value,
                  );
                  if (option) updateSettings({ opticalAmbientIntensity: option[0] });
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label="Ambient optical intensity"
                >
                  <SelectValue>
                    {optionLabel(OPTICAL_AMBIENT_OPTIONS, settings.opticalAmbientIntensity)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {OPTICAL_AMBIENT_OPTIONS.map(([value, label]) => (
                    <SelectItem key={value} value={String(value)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("optical-spectrum")}
          description="Choose the color of optical light, or let it follow the theme."
          resetAction={
            settings.opticalSpectrum !== DEFAULT_UNIFIED_SETTINGS.opticalSpectrum ? (
              <SettingResetButton
                label="optical spectrum"
                onClick={() =>
                  updateSettings({ opticalSpectrum: DEFAULT_UNIFIED_SETTINGS.opticalSpectrum })
                }
              />
            ) : null
          }
          control={
            <div className="w-full sm:w-40">
              <Select
                value={settings.opticalSpectrum}
                onValueChange={(value) => {
                  const option = OPTICAL_SPECTRUM_OPTIONS.find(
                    ([optionValue]) => optionValue === value,
                  );
                  if (option) updateSettings({ opticalSpectrum: option[0] });
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Optical spectrum">
                  <SelectValue>
                    {optionLabel(OPTICAL_SPECTRUM_OPTIONS, settings.opticalSpectrum)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {OPTICAL_SPECTRUM_OPTIONS.map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          {...searchableSetting("optical-home-ripple")}
          description="Let the pointer ripple the glyph field on an empty draft."
          resetAction={
            settings.opticalHomeRipple !== DEFAULT_UNIFIED_SETTINGS.opticalHomeRipple ? (
              <SettingResetButton
                label="interactive home ripple"
                onClick={() =>
                  updateSettings({
                    opticalHomeRipple: DEFAULT_UNIFIED_SETTINGS.opticalHomeRipple,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.opticalHomeRipple}
              onCheckedChange={(checked) => updateSettings({ opticalHomeRipple: Boolean(checked) })}
              aria-label="Interactive home ripple"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("optical-smooth-caret")}
          description="Glide the composer caret between positions as you type."
          resetAction={
            settings.opticalSmoothCaret !== DEFAULT_UNIFIED_SETTINGS.opticalSmoothCaret ? (
              <SettingResetButton
                label="elastic smooth caret"
                onClick={() =>
                  updateSettings({
                    opticalSmoothCaret: DEFAULT_UNIFIED_SETTINGS.opticalSmoothCaret,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.opticalSmoothCaret}
              onCheckedChange={(checked) =>
                updateSettings({ opticalSmoothCaret: Boolean(checked) })
              }
              aria-label="Elastic smooth caret"
            />
          }
        />
        <AdvancedSettings targetIds={[searchableSetting("optical-target-fps").id]}>
          <SettingsRow
            {...searchableSetting("optical-target-fps")}
            description="Cap how often optical effects redraw. Lower caps use less GPU."
            resetAction={
              settings.opticalTargetFps !== DEFAULT_UNIFIED_SETTINGS.opticalTargetFps ? (
                <SettingResetButton
                  label="optical frame cap"
                  onClick={() =>
                    updateSettings({
                      opticalTargetFps: DEFAULT_UNIFIED_SETTINGS.opticalTargetFps,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={settings.opticalTargetFps}
                  onValueChange={(value) => {
                    const option = OPTICAL_TARGET_FPS_OPTIONS.find(
                      ([optionValue]) => optionValue === value,
                    );
                    if (option) updateSettings({ opticalTargetFps: option[0] });
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full min-w-0"
                    aria-label="Optical frame cap"
                  >
                    <SelectValue>
                      {optionLabel(OPTICAL_TARGET_FPS_OPTIONS, settings.opticalTargetFps)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {OPTICAL_TARGET_FPS_OPTIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        </AdvancedSettings>
      </SettingsSection>

      <TypographySection />
      <ReaderSection />
    </SettingsPageContainer>
  );
}

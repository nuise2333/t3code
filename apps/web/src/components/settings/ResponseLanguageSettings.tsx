import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ResponseLanguageSettings() {
  const settings = useScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["responseLanguage"]);

  return (
    <SettingsRow
      serverScoped
      settingKeys={["responseLanguage"]}
      {...searchableSetting("response-language")}
      description="Agents reply in this language. Applies from each agent's next turn."
      resetAction={
        mixed || settings.responseLanguage !== "" ? (
          <SettingResetButton
            label="response language"
            onClick={() => updateSettings({ responseLanguage: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.responseLanguage}`}
          size="sm"
          className="w-full sm:w-64"
          aria-label="Response language"
          maxLength={80}
          defaultValue={mixed ? "" : settings.responseLanguage}
          placeholder={mixed ? "Mixed" : "Any language, such as 简体中文"}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.responseLanguage))
              updateSettings({ responseLanguage: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

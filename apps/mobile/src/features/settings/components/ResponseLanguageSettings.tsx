import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

export function ResponseLanguageSettings(props: {
  /** Null when the selected environments disagree. */
  value: string | null;
  disabled: boolean;
  footer?: string | undefined;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  // Save on exit too: Android Back hides the keyboard without ending editing.
  const draft = useRef<{ text: string; over: string | null } | null>(null);
  const save = () => {
    const current = draft.current;
    draft.current = null;
    // Drop a draft typed over an older saved value: the updated value has already remounted the input.
    if (current === null || current.over !== props.value) return;
    const value = current.text.trim();
    if (props.value === null || value !== props.value) props.onChange({ responseLanguage: value });
  };
  const saveOnUnmount = useEffectEvent(save);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves an unsent response language draft to server settings when the section unmounts
  useEffect(() => () => saveOnUnmount(), []);
  return (
    <SettingsSection
      title="Response language"
      footer={props.footer}
      trailing={
        props.value === null ? <Text className="text-xs text-foreground-muted">Mixed</Text> : null
      }
    >
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground-muted">
          Agents reply in this language. Applies from each agent's next turn.
        </Text>
        <AppTextInput
          key={props.value}
          accessibilityLabel="Response language"
          onChangeText={(text) => {
            draft.current = { text, over: props.value };
          }}
          defaultValue={props.value ?? ""}
          placeholder={props.value === null ? "Mixed" : "Any language, such as 简体中文"}
          editable={!props.disabled}
          maxLength={80}
          autoCorrect={false}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
          onEndEditing={save}
        />
      </View>
    </SettingsSection>
  );
}

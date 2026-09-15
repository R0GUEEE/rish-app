import React, { useMemo, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';
import { useAppPresentation } from '../presentation/AppPresentation';
import { environmentBytes, familyNames, runtimeCopy } from '../environments/runtime-copy';
import { useRuntimeEnvironments } from '../environments/use-runtime-environments';
import { RUNTIME_FAMILIES, validEnvironmentURL } from '../native/runtime-environments';
import { RuntimeEnvironmentModal, runtimeStyles } from './runtime-environment-modal';

export type RuntimeEnvironmentSheetProps = {
  visible: boolean; onClose: () => void; onDismiss?: () => void; workspaceId: string | null; onRun?: () => void;
};
export function RuntimeEnvironmentSheet({ visible, onClose, onDismiss, workspaceId, onRun }: RuntimeEnvironmentSheetProps) {
  const { colors, locale } = useAppPresentation(), copy = runtimeCopy(locale);
  const styles = useMemo(() => runtimeStyles(colors), [colors]);
  const state = useRuntimeEnvironments({ visible, workspaceId });
  const [url, setURL] = useState(''), [urlError, setURLError] = useState(false);
  const available = state.status !== 'unavailable';
  return <RuntimeEnvironmentModal visible={visible} onClose={onClose} onDismiss={onDismiss} title={copy.title} testID="runtime-environment-sheet">
    <Text style={styles.body}>{copy.intro}</Text>
    {state.status === 'unavailable' ? <Text style={styles.error}>{copy.unavailable}</Text> : <>
      <View style={styles.row}>
        <Pressable style={[styles.button, state.busy && styles.disabled]} accessibilityRole="button" disabled={state.busy} onPress={() => { state.importFile(); }} testID="runtime-import"><Text style={styles.buttonText}>{copy.importFile}</Text></Pressable>
        <Pressable style={[styles.button, styles.secondary]} accessibilityRole="button" onPress={() => { state.refresh(); }}><Text style={styles.secondaryText}>{copy.refresh}</Text></Pressable>
      </View>
      <TextInput accessibilityLabel={copy.addURL} placeholder={copy.urlPlaceholder} placeholderTextColor={colors.faint}
        value={url} onChangeText={value => { setURL(value); setURLError(false); }} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" maxLength={2048} style={styles.input} testID="runtime-url" />
      <Text style={styles.body}>{copy.urlHelp}</Text>
      {urlError && <Text style={styles.error}>{copy.invalidURL}</Text>}
      <Pressable style={[styles.button, state.busy && styles.disabled]} disabled={state.busy} accessibilityRole="button" testID="runtime-download-url" onPress={() => {
        if (!validEnvironmentURL(url)) { setURLError(true); return; }
        state.download(url);
      }}><Text style={styles.buttonText}>{copy.addURL}</Text></Pressable>
    </>}
    {state.status === 'loading' && <Text style={styles.body}>{copy.loading}</Text>}
    {state.error && <Text accessibilityLiveRegion="polite" style={styles.error}>{copy.error} {state.error}</Text>}
    {state.busy && <View style={styles.row}><Text style={styles.body}>{copy.busy}</Text>
      {state.cancellable && <Pressable style={[styles.button, styles.secondary]} accessibilityRole="button" onPress={() => { state.cancel(); }} testID="runtime-cancel"><Text style={styles.secondaryText}>{copy.cancel}</Text></Pressable>}
    </View>}
    {available && RUNTIME_FAMILIES.map(family => {
      const environments = state.list?.environments.filter(environment => environment.family === family) ?? [];
      return <View key={family} style={styles.family}>
        <Text style={styles.label}>{familyNames[family]}</Text>
        {environments.length === 0 && state.status !== 'loading' && <Text style={styles.body}>{copy.empty}</Text>}
        {environments.map(environment => {
          const selected = state.list?.selected_environment_id === environment.environment_id;
          const downloading = ['downloading', 'installing'].includes(environment.state);
          return <View key={environment.environment_id} style={[styles.item, selected && styles.selectedItem]} testID={`runtime-package-${environment.environment_id}`}>
            <Text style={styles.label}>{environment.display_name} · {environment.version}</Text>
            <Text style={styles.body}>{copy.packageSize} {environmentBytes(environment.disk_bytes)} · {copy.memory} {environment.minimum_memory_mib} MB</Text>
            <Text accessibilityLiveRegion="polite" style={styles.body}>{copy[environment.state]}{selected ? ` · ${copy.selected}` : ''}</Text>
            {downloading && <>
              <Text style={styles.body}>{environmentBytes(environment.downloaded_bytes)}{environment.total_bytes === null ? '' : ` / ${environmentBytes(environment.total_bytes)}`}</Text>
              {environment.total_bytes !== null && <View style={styles.progressTrack}><View style={[styles.progress, { width: `${Math.min(100, environment.downloaded_bytes / environment.total_bytes * 100)}%` }]} /></View>}
            </>}
            {environment.error_code && <Text style={styles.error}>{copy.installFailed} {environment.error_code}</Text>}
            <View style={styles.row}>
              {environment.state !== 'installed' && <Pressable disabled={state.busy || downloading} accessibilityRole="button"
                style={[styles.button, (state.busy || downloading) && styles.disabled]} onPress={() => { state.install(environment.environment_id); }}
                testID={`runtime-install-${environment.environment_id}`}><Text style={styles.buttonText}>{copy.install}</Text></Pressable>}
              {workspaceId !== null && <Pressable disabled={state.busy || selected || downloading} accessibilityRole="button"
                style={[styles.button, styles.secondary, (state.busy || selected || downloading) && styles.disabled]}
                onPress={() => { state.select(environment.environment_id); }} testID={`runtime-select-${environment.environment_id}`}>
                <Text style={styles.secondaryText}>{selected ? copy.selected : copy.select}</Text></Pressable>}
              {environment.state === 'installed' && <Pressable disabled={state.busy} accessibilityRole="button"
                style={[styles.button, styles.secondary, state.busy && styles.disabled]} testID={`runtime-delete-${environment.environment_id}`}
                onPress={() => Alert.alert(copy.removePrompt, environment.display_name, [
                  { text: copy.keep, style: 'cancel' }, { text: copy.confirmDelete, style: 'destructive', onPress: () => { state.remove(environment.environment_id); } },
                ])}><Text style={styles.error}>{copy.remove}</Text></Pressable>}
            </View>
          </View>;
        })}
      </View>;
    })}
    {workspaceId !== null && onRun && <Pressable accessibilityRole="button" disabled={state.busy || !available} style={[styles.button, (state.busy || !available) && styles.disabled]} onPress={onRun} testID="runtime-open-run"><Text style={styles.buttonText}>{copy.runTitle}</Text></Pressable>}
  </RuntimeEnvironmentModal>;
}

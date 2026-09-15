import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useAppPresentation } from '../presentation/AppPresentation';
import { familyNames, runtimeCopy } from '../environments/runtime-copy';
import { useRuntimeEnvironments } from '../environments/use-runtime-environments';
import { useRuntimeProgram } from '../environments/use-runtime-program';
import { parseProgramArguments, validProgramEntry } from '../native/runtime-programs';
import type { WorkspaceRootRefV1 } from '../native/WorkspaceRoot';
import { RuntimeEnvironmentModal, runtimeStyles } from './runtime-environment-modal';

export type RuntimeProgramSheetProps = {
  visible: boolean; onClose: () => void; root: WorkspaceRootRefV1 | null; workspaceName?: string; blocked?: boolean; ownerKey?: string;
};
export function RuntimeProgramSheet({ visible, onClose, root, workspaceName, blocked = false, ownerKey }: RuntimeProgramSheetProps) {
  const { colors, locale } = useAppPresentation(), copy = runtimeCopy(locale);
  const styles = useMemo(() => runtimeStyles(colors), [colors]);
  const environments = useRuntimeEnvironments({ visible, workspaceId: root?.workspace_id ?? null });
  const runner = useRuntimeProgram({ visible, root, blocked, ownerKey });
  const [entry, setEntry] = useState(''), [argumentsText, setArgumentsText] = useState('[]');
  const [validation, setValidation] = useState<'invalidEntry' | 'invalidArgs' | 'needEnvironment' | null>(null);
  useEffect(() => {
    setEntry('');
    setArgumentsText('[]');
    setValidation(null);
  }, [visible, root?.workspace_id, root?.binding_revision, root?.project_id, ownerKey]);
  const environment = environments.list?.environments.find(item => item.environment_id === environments.list?.selected_environment_id);
  const busy = runner.busy || environments.busy;
  const disabled = busy || blocked || root === null || !runner.available;
  const receipt = runner.receipt;
  return <RuntimeEnvironmentModal visible={visible} onClose={onClose} title={copy.runTitle} testID="runtime-program-sheet">
    {workspaceName && <Text style={styles.label}>{workspaceName}</Text>}
    <View style={styles.notice}><Text style={styles.body}>{copy.snapshot}</Text><Text style={styles.body}>{copy.localOnly}</Text></View>
    {!runner.available && <Text style={styles.error}>{copy.runUnavailable}</Text>}
    {root === null && <Text style={styles.error}>{copy.needWorkspace}</Text>}
    {blocked && <Text style={styles.body}>{copy.blocked}</Text>}
    <Text style={styles.label}>{copy.chooseEnvironment}</Text>
    <Text style={styles.body}>{copy.selectedOnDemand}</Text>
    {environments.status === 'loading' && <Text style={styles.body}>{copy.loading}</Text>}
    {environments.list?.environments.length === 0 && <Text style={styles.body}>{copy.empty}</Text>}
    {environments.list?.environments.map(item => <Pressable key={item.environment_id} accessibilityRole="radio"
      accessibilityState={{ checked: environment?.environment_id === item.environment_id, disabled: busy || root === null }}
      disabled={busy || root === null} style={[styles.item, environment?.environment_id === item.environment_id && styles.selectedItem]}
      onPress={() => { setValidation(null); environments.select(item.environment_id); }} testID={`runtime-run-select-${item.environment_id}`}>
      <Text style={styles.label}>{familyNames[item.family]} · {item.version}</Text>
      <Text style={styles.body}>{item.display_name} · {copy[item.state]}</Text>
    </Pressable>)}
    {environments.error && <Text style={styles.error}>{copy.error} {environments.error}</Text>}
    <Text style={styles.label}>{copy.entry}</Text>
    <TextInput accessibilityLabel={copy.entry} editable={!busy} value={entry} onChangeText={value => { setEntry(value); setValidation(null); }}
      autoCapitalize="none" autoCorrect={false} maxLength={1024} placeholder={copy.entryPlaceholder} placeholderTextColor={colors.faint}
      style={styles.input} testID="runtime-entry" />
    <Text style={styles.body}>{copy.entryHelp}</Text>
    <Text style={styles.label}>{copy.args}</Text>
    <TextInput accessibilityLabel={copy.args} editable={!busy} value={argumentsText} onChangeText={value => { setArgumentsText(value); setValidation(null); }}
      autoCapitalize="none" autoCorrect={false} multiline maxLength={65536} style={styles.input} testID="runtime-args" />
    <Text style={styles.body}>{copy.argsHelp}</Text>
    {validation && <Text style={styles.error}>{copy[validation]}</Text>}
    {environment?.family === 'java' && entry.toLowerCase().endsWith('.java') &&
      <Text style={styles.body}>{copy.javaSourceBudget}</Text>}
    <View style={styles.row}>
      <Pressable accessibilityRole="button" disabled={disabled} style={[styles.button, disabled && styles.disabled]} testID="runtime-run" onPress={() => {
        if (!validProgramEntry(entry)) { setValidation('invalidEntry'); return; }
        const args = parseProgramArguments(argumentsText);
        if (args === null) { setValidation('invalidArgs'); return; }
        if (!environment) { setValidation('needEnvironment'); return; }
        setValidation(null); runner.start(environment, entry, args);
      }}><Text style={styles.buttonText}>{copy.run}</Text></Pressable>
      {runner.busy && <Pressable accessibilityRole="button" style={[styles.button, styles.secondary]} testID="runtime-stop" onPress={() => { runner.stop(); }}>
        <Text style={styles.secondaryText}>{runner.phase === 'downloading' ? copy.cancel : copy.stop}</Text></Pressable>}
    </View>
    {runner.phase === 'downloading' && <>
      <Text style={styles.body}>{copy.downloadingSelected}</Text>
      {environment && environment.total_bytes !== null && <Text style={styles.body}>{Math.round(environment.downloaded_bytes / environment.total_bytes * 100)}%</Text>}
    </>}
    {runner.phase === 'preparing' && <Text style={styles.body}>{copy.preparing}</Text>}
    {runner.phase === 'starting' && <Text style={styles.body}>{copy.starting}</Text>}
    {runner.error && <Text accessibilityLiveRegion="polite" style={styles.error}>{runner.error === 'E_PROGRAM_ROOT_STALE' ? copy.rootStale : runner.error === 'E_ENV_CANCELLED' ? copy.cancelled : copy.error} {runner.error}</Text>}
    {receipt && <>
      <Text accessibilityLiveRegion="polite" style={styles.label}>{copy[receipt.status]}{receipt.exit_code === null ? '' : ` · ${copy.exitCode}: ${receipt.exit_code}`}</Text>
      <Text style={styles.label}>{copy.output}</Text><View style={styles.item}><Text selectable style={styles.output} testID="runtime-stdout">{receipt.stdout || copy.noOutput}</Text></View>
      {receipt.stdout_truncated && <Text style={styles.body}>{copy.truncated}</Text>}
      <Text style={styles.label}>{copy.errors}</Text><View style={styles.item}><Text selectable style={styles.output} testID="runtime-stderr">{receipt.stderr || copy.noOutput}</Text></View>
      {receipt.stderr_truncated && <Text style={styles.body}>{copy.truncated}</Text>}
    </>}
  </RuntimeEnvironmentModal>;
}

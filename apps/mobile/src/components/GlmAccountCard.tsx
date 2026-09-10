import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppPresentation } from '../presentation/AppPresentation';
import * as Auth from '../harnessAuth/glmAccount';

type Scope = { provider: Auth.GlmAccountProvider; revision: number };
export function GlmAccountCard({ visible, disabled = false, onSourceChanged }: {
  visible: boolean; disabled?: boolean; onSourceChanged?: () => void;
}) {
  const { colors, t } = useAppPresentation();
  const [provider, setProvider] = useState<Auth.GlmAccountProvider>('bigmodel');
  const [status, setStatus] = useState<Auth.GlmAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [browserError, setBrowserError] = useState(false);
  const [source, setSource] = useState<Auth.GlmCredentialSource | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const owner = useRef<Scope | null>(null);
  const busyRef = useRef(false);
  const refresh = useCallback(async (scope: Scope) => {
    if (owner.current !== scope || busyRef.current) return;
    const revision = scope.revision;
    const next = await Auth.glmAccountStatus(scope.provider);
    const nextSource = await Auth.glmCredentialSource();
    if (owner.current === scope && scope.revision === revision) { setStatus(next); setSource(nextSource); }
  }, []);
  useEffect(() => {
    const scope = { provider, revision: 0 };
    owner.current = scope; busyRef.current = false; setBusy(false); setStatus(null); setBrowserError(false); setSource(null); setPlanError(null);
    if (!visible) return () => { if (owner.current === scope) owner.current = null; };
    refresh(scope).catch(() => undefined);
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(scope).catch(() => undefined); });
    return () => { subscription.remove(); if (owner.current === scope) owner.current = null; };
  }, [provider, visible, refresh]);
  useEffect(() => {
    if (!visible || (status?.status !== 'pending' && status?.status !== 'starting')) return;
    const scope = owner.current;
    const deadline = Math.min(status?.expires_at ? status.expires_at * 1000 + 6000 : Date.now() + 600000, Date.now() + 600000);
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); return; }
      if (scope && AppState.currentState === 'active' && !busyRef.current) refresh(scope).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [status?.status, status?.expires_at, visible, refresh]);
  const run = async (action: (value: Auth.GlmAccountProvider) => Promise<Auth.GlmAccountStatus>) => {
    const scope = owner.current;
    if (!scope || busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); scope.revision += 1;
    const revision = scope.revision;
    try {
      const next = await action(scope.provider);
      if (owner.current === scope && scope.revision === revision) {
        setStatus(next);
        if (action === Auth.logoutGlmAccount) {
          setSource(await Auth.glmCredentialSource()); onSourceChanged?.();
        }
      }
    } finally { if (owner.current === scope) { busyRef.current = false; setBusy(false); } }
  };
  const switchProvider = (next: Auth.GlmAccountProvider) => {
    if (next === provider || busy || disabled) return;
    if (status?.status === 'pending' || status?.status === 'starting') Auth.cancelGlmAccountLogin(provider).catch(() => undefined);
    owner.current = null; setProvider(next);
  };
  const open = async () => {
    const scope = owner.current;
    const url = status?.authorize_url;
    if (!scope || disabled || !Auth.validGlmAuthorizationUrl(provider, url)) return;
    try { await Auth.openGlmAccountAuthorization(scope.provider); if (owner.current === scope) setBrowserError(false); }
    catch { if (owner.current === scope) setBrowserError(true); }
  };
  const pending = status?.status === 'pending' || status?.status === 'starting';
  const chooseSource = async (choice: Auth.GlmCredentialChoice) => {
    const scope = owner.current;
    if (!scope || busyRef.current || disabled) return;
    busyRef.current = true; setBusy(true); setPlanError(null); scope.revision += 1;
    try { await Auth.selectGlmCredentialSource(choice); }
    catch (error) {
      if (owner.current === scope) {
        const code = (error as {code?: unknown})?.code;
        setPlanError(typeof code === 'string' && /^E_[A-Z0-9_]{1,80}$/.test(code) ? code : 'E_ZCODE_PLAN_UNAVAILABLE');
      }
    }
    finally {
      const next = await Auth.glmCredentialSource();
      if (owner.current === scope) {
        setSource(next); busyRef.current = false; setBusy(false); onSourceChanged?.();
      }
    }
  };
  const stateLabel = status === null ? 'checking' : status.status;
  const trialSelected = source?.source === 'bigmodel_trial' || source?.source === 'zai_trial';
  const verifiedLabel = trialSelected ? 'settings.glmAccount.trialVerified' : 'settings.glmAccount.planVerified';
  const button = (label: string, action: () => void, unavailable = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled || busy || unavailable} onPress={action} style={[styles.button, { backgroundColor: colors.surfaceRaised }, (disabled || busy || unavailable) && styles.disabled]}><Text style={{ color: colors.text }}>{label}</Text></Pressable>;
  return <View testID="glm-account-card" style={[styles.card, { backgroundColor: colors.surface }]}>
    <Text style={[styles.title, { color: colors.text }]}>{t('settings.glmAccount.title')}</Text>
    <Text style={[styles.body, { color: colors.muted }]}>{t('settings.glmAccount.description')}</Text>
    <View style={styles.row}>{(['bigmodel', 'zai'] as const).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: provider === value }} accessibilityLabel={value === 'bigmodel' ? 'BigModel' : 'Z.ai'} disabled={disabled || busy} onPress={() => switchProvider(value)} style={[styles.button, { backgroundColor: provider === value ? colors.accent : colors.surfaceRaised }]}><Text style={{ color: provider === value ? colors.background : colors.text }}>{value === 'bigmodel' ? 'BigModel' : 'Z.ai'}</Text></Pressable>)}</View>
    <Text style={[styles.body, { color: colors.muted }]}>{t(`settings.glmAccount.${stateLabel}`)}</Text>
    {status?.status === 'signed_in' && <><Text style={[styles.body, { color: colors.text }]}>{status.account_label}</Text><Text style={[styles.body, { color: colors.muted }]}>{t(Auth.glmSourceProvider(source?.source ?? null) === provider && source?.ready ? verifiedLabel : 'settings.glmAccount.accountOnly')}</Text></>}
    {browserError && <Text style={{ color: colors.danger }}>{t('settings.auth.browserError')}</Text>}
    {source && <Text style={[styles.body, {color: colors.muted}]}>
      {t('settings.glmAccount.source')}: {source.source === 'api_key' ? t('settings.glmAccount.manualKey')
        : Auth.glmSourceProvider(source.source) === 'bigmodel' ? 'BigModel' : Auth.glmSourceProvider(source.source) === 'zai' ? 'Z.ai' : '—'}
      {source.source && source.source !== 'api_key' ? ` · ${t(source.ready ? verifiedLabel : 'settings.glmAccount.planCheckRequired')}` : ''}
    </Text>}
    {planError && <View>
      <Text style={[styles.body, {color: colors.danger}]}>{t(planError === 'E_ZCODE_PLAN_KEY_UNAVAILABLE'
        ? 'settings.glmAccount.keyUnavailable' : planError === 'E_ZCODE_PLAN_WORKSPACE_UNAVAILABLE'
          ? 'settings.glmAccount.projectUnavailable' : planError === 'E_ZCODE_TRIAL_QUERY_FAILED' ? 'settings.glmAccount.trialQueryFailed' : trialSelected ? 'settings.glmAccount.trialError' : 'settings.glmAccount.planError')}</Text>
      <Text selectable style={[styles.body, {color: colors.muted}]}>{planError}</Text>
    </View>}
    {status?.status === 'signed_in' && <View style={styles.row}>
      {button(t('settings.glmAccount.useTrial'), () => { chooseSource(provider === 'bigmodel' ? 'bigmodel_trial' : 'zai_trial').catch(() => undefined); })}
      {button(t('settings.glmAccount.usePlan'), () => { chooseSource(provider).catch(() => undefined); })}
    </View>}
    <View style={styles.row}>
      {source?.source !== 'api_key' && button(t('settings.glmAccount.manualKey'), () => { chooseSource('api_key').catch(() => undefined); })}
      {status?.status === 'signed_in' ? button(t('settings.auth.logout'), () => { run(Auth.logoutGlmAccount).catch(() => undefined); }) : pending ? <>{button(t('settings.auth.openAuth'), () => { open().catch(() => undefined); }, !Auth.validGlmAuthorizationUrl(provider, status?.authorize_url))}{button(t('settings.auth.cancel'), () => { run(Auth.cancelGlmAccountLogin).catch(() => undefined); })}</> : button(t('settings.glmAccount.login'), () => { run(Auth.startGlmAccountLogin).catch(() => undefined); }, status === null || status.status === 'unavailable')}
      {button(t('settings.auth.refresh'), () => { const scope = owner.current; if (scope) refresh(scope).catch(() => undefined); })}
    </View>
  </View>;
}
const styles = StyleSheet.create({ card: { padding: 15, borderRadius: 20 }, title: { fontSize: 15, fontWeight: '600' }, body: { fontSize: 12, lineHeight: 18, marginTop: 8 }, row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }, button: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12 }, disabled: { opacity: 0.5 } });

import React, { useEffect, useState } from 'react';
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useAppPresentation } from '../presentation/AppPresentation';
import {
  taskExperience,
  type TaskPreferences,
  type TaskSettings,
} from '../taskExperience/bridge';

export function TaskSettingsCard({
  conversationId,
}: {
  conversationId?: string | null;
}) {
  const { colors, locale } = useAppPresentation();
  const zh = locale === 'zh-CN';
  const [settings, setSettings] = useState<TaskSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const refresh = () =>
    taskExperience
      .call('settings')
      .then(setSettings)
      .catch(() => setError(true));
  useEffect(() => {
    if (!taskExperience.available()) return;
    refresh();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh();
    });
    return () => subscription.remove();
  }, []);
  if (!taskExperience.available()) return null;
  const update = async (
    patch: Partial<TaskPreferences>,
    permission = false,
  ) => {
    if (!settings || busy) return;
    setBusy(true);
    setError(false);
    try {
      // Permission is requested only by an explicit notification toggle.
      if (permission && settings.notifications === 'notDetermined')
        await taskExperience.call('permission');
      setSettings(
        await taskExperience.call('preferences', {
          preferences: { ...settings.preferences, ...patch },
        }),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const rows: [keyof Omit<TaskPreferences, 'muted'>, string, string][] = [
    [
      'completed',
      zh ? '任务完成' : 'Task completed',
      zh ? '结果保存成功后提醒' : 'Notify after the result is saved',
    ],
    [
      'failed',
      zh ? '失败或中断' : 'Failure or interruption',
      zh ? '需要检查或恢复时提醒' : 'Notify when review or recovery is needed',
    ],
    [
      'attention',
      zh ? '需要我处理' : 'Needs my attention',
      zh
        ? '等待审批或回答时提醒'
        : 'Notify when approval or an answer is needed',
    ],
    [
      'liveActivity',
      Platform.OS === 'android'
        ? zh
          ? '常驻任务通知'
          : 'Ongoing task notification'
        : zh
        ? '灵动岛与锁屏状态'
        : 'Live Activities',
      zh
        ? '显示当前阶段与耗时，不显示消息正文'
        : 'Show stage and elapsed time, without message content',
    ],
    [
      'background',
      zh ? '允许后台继续任务' : 'Continue tasks in background',
      zh
        ? '由系统调度，可随时取消；系统会显示任务进度'
        : 'System-managed, cancellable work with a visible progress indicator',
    ],
  ];
  return (
    <View style={[styles.card, { borderColor: colors.line }]}>
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: colors.text }]}
      >
        {zh ? '任务提醒与后台运行' : 'Task alerts & background work'}
      </Text>
      {settings &&
        rows.map(([key, title, detail]) => (
          <View key={key} style={styles.row}>
            <View style={styles.copy}>
              <Text style={{ color: colors.text }}>{title}</Text>
              <Text style={[styles.detail, { color: colors.muted }]}>
                {detail}
                {key === 'background' && !settings.backgroundAvailable
                  ? zh
                    ? ' · 当前不可用'
                    : ' · Currently unavailable'
                  : ''}
              </Text>
            </View>
            <Switch
              accessibilityLabel={title}
              disabled={
                busy || (key === 'background' && !settings.backgroundAvailable)
              }
              value={settings.preferences[key]}
              onValueChange={value =>
                update(
                  { [key]: value },
                  value && ['completed', 'failed', 'attention'].includes(key),
                )
              }
            />
          </View>
        ))}
      {settings && conversationId && (
        <View style={styles.row}>
          <Text style={[styles.copy, { color: colors.text }]}>
            {zh ? '当前会话静音' : 'Mute this conversation'}
          </Text>
          <Switch
            accessibilityLabel={zh ? '当前会话静音' : 'Mute this conversation'}
            disabled={busy}
            value={settings.preferences.muted.includes(conversationId)}
            onValueChange={value =>
              update({
                muted: value
                  ? [
                      ...new Set([
                        ...settings.preferences.muted,
                        conversationId,
                      ]),
                    ]
                  : settings.preferences.muted.filter(
                      id => id !== conversationId,
                    ),
              })
            }
          />
        </View>
      )}
      {settings?.notifications === 'denied' && (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            taskExperience.call('openSettings').catch(() => setError(true))
          }
        >
          <Text style={{ color: colors.accent }}>
            {zh
              ? '通知权限已关闭，打开系统设置'
              : 'Notifications are disabled. Open Settings'}
          </Text>
        </Pressable>
      )}
      {error && (
        <Text accessibilityRole="alert" style={{ color: colors.muted }}>
          {zh ? '无法更新，请稍后重试' : 'Unable to update. Please try again.'}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginVertical: 14 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  copy: { flex: 1 },
  detail: { fontSize: 12, marginTop: 4 },
});

import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DEFAULT_DSH_MODELS,
  getDshCatalog,
  subscribeDshCatalog,
  type DshModelEntry,
} from '../models/catalog';
import { DshModelCatalog } from '../models/native';
import { harnessForModel } from '../harness/types';
import { useAppPresentation } from '../presentation/AppPresentation';

export function DshModelCatalogCard({
  model,
  disabled,
  visible,
}: {
  model: string;
  disabled: boolean;
  visible: boolean;
}) {
  const { colors, locale, preferences, store } = useAppPresentation();
  const zh = locale === 'zh-CN';
  const catalog = useSyncExternalStore(subscribeDshCatalog, getDshCatalog);
  const [draft, setDraft] = useState<DshModelEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current += 1;
    setNotice('');
    setSaving(false);
    return () => {
      epoch.current += 1;
    };
  }, [visible, model]);
  useEffect(() => {
    setDraft(catalog.models.map(row => ({ ...row })));
  }, [catalog, visible]);
  if (harnessForModel(model) !== 'dsh' || !DshModelCatalog.isAvailable())
    return null;
  const locked = disabled || saving;
  const update = (index: number, patch: Partial<DshModelEntry>) =>
    setDraft(rows =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  const save = async () => {
    if (locked) return;
    const current = epoch.current;
    setSaving(true);
    setNotice('');
    try {
      await DshModelCatalog.save(draft);
      if (!draft.some(row => row.id === preferences.defaultModel))
        store.setDefaultModel(draft[0].id);
      if (epoch.current === current)
        setNotice(zh ? '模型目录已保存' : 'Model catalog saved');
    } catch {
      if (epoch.current === current)
        setNotice(
          zh
            ? '请检查模型 ID、名称和重复条目；任务运行时不能修改目录。'
            : 'Check model IDs, names, and duplicates. Wait for running tasks to finish.',
        );
    } finally {
      if (epoch.current === current) setSaving(false);
    }
  };
  const button = (
    label: string,
    onPress: () => void,
    extraDisabled = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={locked || extraDisabled}
      onPress={onPress}
      style={[
        styles.button,
        {
          borderColor: colors.line,
          opacity: locked || extraDisabled ? 0.5 : 1,
        },
      ]}
    >
      <Text style={{ color: colors.text }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      style={[styles.card, { borderColor: colors.line }]}
      testID="dsh-model-catalog"
    >
      <Text style={[styles.title, { color: colors.text }]}>
        {zh ? 'DSH 模型目录' : 'DSH model catalog'}
      </Text>
      <Text style={[styles.help, { color: colors.textDim }]}>
        {zh
          ? '填写服务提供的准确模型 ID。新增模型保存后即可选择，无需更新安装包。'
          : 'Use the exact model ID provided by the service. Saved models become selectable without an app update.'}
      </Text>
      {draft.map((row, index) => (
        <View key={index} style={[styles.row, { borderColor: colors.line }]}>
          <TextInput
            accessibilityLabel={
              zh ? `模型 ID ${index + 1}` : `Model ID ${index + 1}`
            }
            testID={`dsh-model-id-${index}`}
            value={row.id}
            editable={!locked}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={128}
            onChangeText={id => update(index, { id })}
            placeholder="deepseek-…"
            placeholderTextColor={colors.faint}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.line },
            ]}
          />
          <TextInput
            accessibilityLabel={
              zh ? `显示名称 ${index + 1}` : `Display name ${index + 1}`
            }
            testID={`dsh-model-name-${index}`}
            value={row.name}
            editable={!locked}
            maxLength={80}
            onChangeText={name => update(index, { name })}
            placeholder={zh ? '显示名称' : 'Display name'}
            placeholderTextColor={colors.faint}
            style={[
              styles.input,
              { color: colors.text, borderColor: colors.line },
            ]}
          />
          <View style={styles.inline}>
            <Text style={{ color: colors.textDim }}>
              {zh ? '支持图片输入' : 'Supports image input'}
            </Text>
            <Switch
              accessibilityLabel={
                zh
                  ? `模型 ${index + 1} 支持图片`
                  : `Model ${index + 1} supports images`
              }
              disabled={locked}
              value={row.supports_images}
              onValueChange={supports_images =>
                update(index, { supports_images })
              }
            />
            {button(
              zh ? '删除' : 'Remove',
              () => setDraft(rows => rows.filter((_, i) => i !== index)),
              draft.length <= 1,
            )}
          </View>
        </View>
      ))}
      <View style={styles.inline}>
        {button(
          zh ? '添加模型' : 'Add model',
          () =>
            setDraft(rows => [
              ...rows,
              { id: '', name: '', supports_images: false },
            ]),
          draft.length >= 32,
        )}
        {button(zh ? '恢复默认目录' : 'Restore defaults', () =>
          setDraft(DEFAULT_DSH_MODELS.map(row => ({ ...row }))),
        )}
      </View>
      <Text style={[styles.help, { color: colors.textDim }]}>
        {zh
          ? '图片能力以服务实际支持为准。删除只移出选择列表，已有会话保留模型身份。'
          : 'Image support depends on the service. Removal hides a model from pickers; existing conversations retain its identity.'}
      </Text>
      {saving ? (
        <ActivityIndicator />
      ) : (
        button(zh ? '保存模型目录' : 'Save model catalog', save)
      )}
      {!!notice && (
        <Text accessibilityRole="alert" style={{ color: colors.textDim }}>
          {notice}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 14, gap: 12, borderWidth: 1, borderRadius: 16 },
  title: { fontSize: 16, fontWeight: '600' },
  help: { fontSize: 12, lineHeight: 18 },
  row: { gap: 8, borderTopWidth: 1, paddingTop: 12 },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 14,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    minHeight: 44,
    paddingHorizontal: 12,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
  },
});

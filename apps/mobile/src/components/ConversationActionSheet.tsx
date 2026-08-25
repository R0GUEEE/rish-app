import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Save from 'lucide-react-native/icons/save';
import Trash2 from 'lucide-react-native/icons/trash-2';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

type Props = {
  title: string;
  visible: boolean;
  onClose: () => void;
  onDelete: () => void;
  onDismiss: () => void;
  onRename: (title: string) => void;
};

export function ConversationActionSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [title, setTitle] = useState(props.title);
  const presented = useRef(false);
  const { onDismiss } = props;
  const reportDismissed = useCallback(() => {
    if (!presented.current) return;
    presented.current = false;
    onDismiss();
  }, [onDismiss]);

  useEffect(() => setTitle(props.title), [props.title, props.visible]);
  useEffect(() => {
    if (props.visible) {
      presented.current = true;
      return;
    }
    if (
      !presented.current ||
      (Platform.OS === 'ios' && process.env.NODE_ENV !== 'test')
    )
      return;
    if (process.env.NODE_ENV === 'test') {
      reportDismissed();
      return;
    }
    const frame = requestAnimationFrame(reportDismissed);
    return () => cancelAnimationFrame(frame);
  }, [props.visible, reportDismissed]);
  const valid = title.trim().length > 0;

  return (
    <Modal
      animationType="slide"
      onDismiss={reportDismissed}
      onRequestClose={props.onClose}
      transparent
      visible={props.visible}
    >
      <Pressable
        accessibilityLabel={t('common.close')}
        onPress={props.onClose}
        style={styles.backdrop}
      />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
        <View style={styles.handle} />
        <Text style={styles.eyebrow}>{t('conversation.eyebrow')}</Text>
        <Text style={styles.title}>{t('conversation.nameTitle')}</Text>
        <TextInput
          accessibilityLabel={t('conversation.titleLabel')}
          autoFocus
          maxLength={120}
          onChangeText={setTitle}
          placeholder={t('conversation.titleLabel')}
          placeholderTextColor={colors.faint}
          selectTextOnFocus
          style={styles.input}
          value={title}
        />
        <Pressable
          accessibilityLabel={t('conversation.saveTitle')}
          accessibilityRole="button"
          disabled={!valid}
          onPress={() => {
            props.onRename(title.trim());
            props.onClose();
          }}
          style={({ pressed }) => [
            styles.save,
            !valid && styles.disabled,
            pressed && valid && styles.pressed,
          ]}
        >
          <AppIcon color={colors.background} icon={Save} size={17} />
          <Text style={styles.saveText}>
            {t('conversation.saveTitleButton')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('conversation.delete')}
          accessibilityRole="button"
          onPress={props.onDelete}
          style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
        >
          <AppIcon color={colors.danger} icon={Trash2} size={17} />
          <Text style={styles.deleteText}>{t('conversation.delete')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: colors.scrim },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 29,
      borderTopRightRadius: 29,
      paddingTop: 10,
      paddingHorizontal: 20,
    },
    handle: {
      alignSelf: 'center',
      width: 42,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.line,
      marginBottom: 21,
    },
    eyebrow: {
      color: colors.accent,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 2,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 26,
      marginTop: 8,
    },
    input: {
      height: 50,
      borderRadius: 15,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 14,
      marginTop: 18,
    },
    save: {
      height: 49,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 12,
    },
    saveText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.3 },
    delete: {
      height: 46,
      borderRadius: 15,
      backgroundColor: colors.surfaceWarm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 9,
    },
    deleteText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
    pressed: { opacity: 0.6, transform: [{ scale: 0.987 }] },
  });

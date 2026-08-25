import React, { useMemo, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react-native';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import BrainCircuit from 'lucide-react-native/icons/brain-circuit';
import Camera from 'lucide-react-native/icons/camera';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import FileImage from 'lucide-react-native/icons/file-image';
import FileText from 'lucide-react-native/icons/file-text';
import FolderCode from 'lucide-react-native/icons/folder-code';
import Images from 'lucide-react-native/icons/images';
import Paperclip from 'lucide-react-native/icons/paperclip';
import Plus from 'lucide-react-native/icons/plus';
import Square from 'lucide-react-native/icons/square';
import X from 'lucide-react-native/icons/x';
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useAppPresentation } from '../presentation/AppPresentation';
import type { AttachmentDescriptor, ConversationThinkingMode } from '../state';
import { fonts, type ThemePalette } from '../theme';
import { localizedModelDetails, type SupportedModel } from './ModelPicker';
import { localizedThinkingDetails } from './ThinkingPicker';
import { AppIcon } from './AppIcon';

export type AttachmentSource = 'camera' | 'photos' | 'files';

type Props = {
  configured: boolean;
  draft: string;
  attachments: readonly AttachmentDescriptor[];
  attachmentBusy: boolean;
  previewingAttachmentId: string | null;
  harnessName: string;
  model: SupportedModel;
  modelPickerVisible: boolean;
  projectName?: string | null;
  thinkingMode: ConversationThinkingMode;
  thinkingPickerVisible: boolean;
  sending: boolean;
  onAddAttachment: (source: AttachmentSource) => void;
  onCancel: () => void;
  onChange: (value: string) => void;
  onConfigure: () => void;
  onModelPress: () => void;
  onPreviewAttachment: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onThinkingPress: () => void;
  onSend: () => void;
};

const menuItems: ReadonlyArray<{
  source: AttachmentSource;
  icon: LucideIcon;
  labelKey:
    | 'messages.attachment.camera'
    | 'messages.attachment.photos'
    | 'messages.attachment.files';
}> = [
  { source: 'camera', icon: Camera, labelKey: 'messages.attachment.camera' },
  { source: 'photos', icon: Images, labelKey: 'messages.attachment.photos' },
  { source: 'files', icon: Paperclip, labelKey: 'messages.attachment.files' },
];

function readableSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ChatComposer(props: Props) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const pendingAttachmentSource = useRef<AttachmentSource | null>(null);
  const canSend =
    props.configured &&
    (props.draft.trim().length > 0 || props.attachments.length > 0) &&
    !props.sending;
  const model = localizedModelDetails(props.model, t);
  const thinking = localizedThinkingDetails(props.thinkingMode, t);

  const chooseAttachment = (source: AttachmentSource) => {
    pendingAttachmentSource.current = source;
    setAttachmentMenuVisible(false);
  };

  const finishAttachmentMenuDismiss = () => {
    const source = pendingAttachmentSource.current;
    pendingAttachmentSource.current = null;
    if (source !== null) props.onAddAttachment(source);
  };

  return (
    <View style={styles.shell}>
      {props.projectName != null && (
        <View
          accessible
          accessibilityLabel={t('messages.projectContext', {
            project: props.projectName,
          })}
          style={styles.projectContext}
        >
          <AppIcon color={colors.accent} icon={FolderCode} size={12} />
          <Text numberOfLines={1} style={styles.projectContextText}>
            {props.projectName}
          </Text>
        </View>
      )}
      {props.attachments.length > 0 && (
        <ScrollView
          accessibilityLabel={t('messages.attachment.selected')}
          contentContainerStyle={styles.attachmentRow}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={styles.attachmentScroll}
        >
          {props.attachments.map(attachment => (
            <Pressable
              accessibilityLabel={t('messages.attachment.preview', {
                name: attachment.name,
              })}
              accessibilityRole="button"
              accessibilityState={{
                busy: props.previewingAttachmentId === attachment.id,
                disabled:
                  props.sending || props.previewingAttachmentId !== null,
              }}
              disabled={props.sending || props.previewingAttachmentId !== null}
              key={attachment.id}
              onPress={() => props.onPreviewAttachment(attachment.id)}
              style={({ pressed }) => [
                styles.attachmentCard,
                pressed && styles.attachmentCardPressed,
              ]}
            >
              {attachment.kind === 'image' &&
              attachment.thumbnail_data_url !== undefined ? (
                <Image
                  resizeMode="cover"
                  source={{ uri: attachment.thumbnail_data_url }}
                  style={styles.attachmentImage}
                />
              ) : (
                <View style={styles.attachmentFile}>
                  <AppIcon
                    color={colors.accent}
                    icon={attachment.kind === 'image' ? FileImage : FileText}
                    size={16}
                  />
                  <Text numberOfLines={1} style={styles.attachmentName}>
                    {attachment.name}
                  </Text>
                  <Text style={styles.attachmentSize}>
                    {readableSize(attachment.size)}
                  </Text>
                </View>
              )}
              {props.previewingAttachmentId === attachment.id && (
                <View style={styles.attachmentPreviewBusy}>
                  <ActivityIndicator color={colors.text} size="small" />
                </View>
              )}
              <Pressable
                accessibilityLabel={t('messages.attachment.remove', {
                  name: attachment.name,
                })}
                accessibilityRole="button"
                disabled={props.sending}
                hitSlop={6}
                onPress={event => {
                  event.stopPropagation();
                  props.onRemoveAttachment(attachment.id);
                }}
                style={({ pressed }) => [
                  styles.removeAttachment,
                  pressed && styles.pressed,
                ]}
              >
                <AppIcon
                  color={colors.background}
                  icon={X}
                  size={12}
                  strokeWidth={2.2}
                />
              </Pressable>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <TextInput
        accessibilityLabel={t('messages.inputLabel', {
          harness: props.harnessName,
        })}
        accessibilityState={{ disabled: !props.configured || props.sending }}
        editable={props.configured && !props.sending}
        multiline
        onChangeText={props.onChange}
        placeholder={
          props.configured
            ? t('messages.inputPlaceholder', { harness: props.harnessName })
            : t('messages.configurePlaceholder')
        }
        placeholderTextColor={colors.faint}
        style={styles.input}
        value={props.draft}
      />
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={t('messages.attachment.add')}
          accessibilityRole="button"
          accessibilityState={{
            busy: props.attachmentBusy,
            disabled: !props.configured || props.sending,
          }}
          disabled={!props.configured || props.sending || props.attachmentBusy}
          onPress={() => {
            Keyboard.dismiss();
            setAttachmentMenuVisible(true);
          }}
          style={({ pressed }) => [
            styles.addAttachment,
            pressed && styles.pressed,
          ]}
        >
          {props.attachmentBusy ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <AppIcon color={colors.text} icon={Plus} size={19} />
          )}
        </Pressable>
        {props.configured ? (
          <Pressable
            accessibilityLabel={t('messages.chooseModel')}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.modelPickerVisible }}
            onPress={() => {
              Keyboard.dismiss();
              props.onModelPress();
            }}
            style={({ pressed }) => [
              styles.modelChip,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.modelDot} />
            <Text numberOfLines={1} style={styles.modelText}>
              {model.name}
            </Text>
            <AppIcon
              color={colors.muted}
              icon={ChevronDown}
              size={14}
              style={styles.chevronIcon}
            />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel={t('messages.configureKey')}
            accessibilityRole="button"
            onPress={props.onConfigure}
            style={({ pressed }) => [
              styles.configureChip,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.configureText}>
              {t('messages.configureKeyShort')}
            </Text>
          </Pressable>
        )}
        {props.configured && (
          <Pressable
            accessibilityLabel={t('messages.chooseThinking')}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.thinkingPickerVisible }}
            onPress={() => {
              Keyboard.dismiss();
              props.onThinkingPress();
            }}
            style={({ pressed }) => [
              styles.thinkingChip,
              pressed && styles.pressed,
            ]}
          >
            <AppIcon
              color={colors.accent}
              icon={BrainCircuit}
              size={15}
              style={styles.thinkingIcon}
            />
            <Text style={styles.thinkingText}>{thinking.shortName}</Text>
            <AppIcon
              color={colors.muted}
              icon={ChevronDown}
              size={14}
              style={styles.chevronIcon}
            />
          </Pressable>
        )}
        <View style={styles.actionSpacer} />
        <Pressable
          accessibilityLabel={
            props.sending
              ? t('messages.stopResponse')
              : t('messages.sendMessage')
          }
          accessibilityRole="button"
          accessibilityState={{
            busy: props.sending,
            disabled: !props.sending && !canSend,
          }}
          disabled={!props.sending && !canSend}
          onPress={props.sending ? props.onCancel : props.onSend}
          style={({ pressed }) => [
            styles.send,
            props.sending && styles.stop,
            !props.sending && !canSend && styles.sendDisabled,
            pressed && styles.pressed,
          ]}
        >
          {props.sending ? (
            <AppIcon
              color={colors.background}
              fill={colors.background}
              icon={Square}
              size={11}
            />
          ) : (
            <AppIcon color={colors.background} icon={ArrowUp} size={20} />
          )}
        </Pressable>
      </View>
      {props.sending && (
        <View
          accessibilityLabel={t('messages.respondingLabel')}
          accessibilityLiveRegion="polite"
          accessibilityRole="status"
          style={styles.progressRow}
        >
          <ActivityIndicator color={colors.accent} size="small" />
          <Text style={styles.progressText}>
            {t('messages.workingLocally')}
          </Text>
        </View>
      )}
      <Modal
        animationType="fade"
        onDismiss={finishAttachmentMenuDismiss}
        onRequestClose={() => setAttachmentMenuVisible(false)}
        presentationStyle="overFullScreen"
        statusBarTranslucent
        transparent
        testID="attachment-menu-modal"
        visible={attachmentMenuVisible}
      >
        <Pressable
          accessibilityLabel={t('messages.attachment.closeMenu')}
          onPress={() => setAttachmentMenuVisible(false)}
          style={styles.menuBackdrop}
        >
          <View
            accessibilityLabel={t('messages.attachment.menu')}
            accessibilityRole="menu"
            style={styles.attachmentMenu}
          >
            {menuItems.map(item => (
              <Pressable
                accessibilityLabel={t(item.labelKey)}
                accessibilityRole="menuitem"
                key={item.source}
                onPress={() => chooseAttachment(item.source)}
                style={({ pressed }) => [
                  styles.attachmentMenuItem,
                  pressed && styles.menuItemPressed,
                ]}
              >
                <View style={styles.menuIcon}>
                  <AppIcon color={colors.text} icon={item.icon} size={20} />
                </View>
                <Text style={styles.menuLabel}>{t(item.labelKey)}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    shell: {
      borderRadius: 23,
      paddingHorizontal: 12,
      paddingTop: 11,
      paddingBottom: 9,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    input: {
      minHeight: 36,
      maxHeight: 116,
      padding: 0,
      color: colors.text,
      fontSize: 17,
      lineHeight: 23,
      fontFamily: fonts.body,
    },
    projectContext: {
      alignSelf: 'flex-start',
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      justifyContent: 'center',
      paddingHorizontal: 8,
      marginBottom: 7,
      maxWidth: '72%',
    },
    projectContextText: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 8,
      fontWeight: '700',
    },
    attachmentScroll: { marginBottom: 9, maxHeight: 72 },
    attachmentRow: { gap: 8, paddingRight: 4 },
    attachmentCard: {
      width: 86,
      height: 64,
      borderRadius: 13,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: 'visible',
    },
    attachmentImage: { width: '100%', height: '100%', borderRadius: 13 },
    attachmentCardPressed: { opacity: 0.76 },
    attachmentPreviewBusy: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      borderRadius: 13,
      backgroundColor: colors.scrim,
      alignItems: 'center',
      justifyContent: 'center',
    },
    attachmentFile: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 9,
      gap: 2,
    },
    attachmentName: { color: colors.text, fontSize: 10, fontWeight: '700' },
    attachmentSize: { color: colors.muted, fontSize: 8, marginTop: 2 },
    removeAttachment: {
      position: 'absolute',
      right: -5,
      top: -5,
      width: 20,
      height: 20,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.text,
      borderWidth: 2,
      borderColor: colors.surface,
    },
    actions: { flexDirection: 'row', alignItems: 'center', marginTop: 5 },
    actionSpacer: { flex: 1 },
    addAttachment: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 5,
    },
    modelChip: {
      height: 30,
      borderRadius: 15,
      paddingHorizontal: 8,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      maxWidth: 94,
    },
    modelDot: {
      width: 5,
      height: 5,
      borderRadius: 2.5,
      backgroundColor: colors.accent,
      marginRight: 5,
    },
    modelText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
    thinkingChip: {
      height: 30,
      borderRadius: 15,
      paddingHorizontal: 8,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: 4,
      maxWidth: 76,
    },
    thinkingIcon: { marginRight: 4 },
    thinkingText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
    chevronIcon: { marginLeft: 3 },
    configureChip: {
      height: 38,
      borderRadius: 19,
      paddingHorizontal: 14,
      backgroundColor: colors.accent,
      justifyContent: 'center',
    },
    configureText: {
      color: colors.background,
      fontSize: 12,
      fontWeight: '800',
    },
    send: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.text,
    },
    sendDisabled: { backgroundColor: colors.surfaceRaised },
    stop: { backgroundColor: colors.text },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      marginTop: 8,
    },
    progressText: { color: colors.muted, fontSize: 10, fontFamily: fonts.mono },
    menuBackdrop: {
      flex: 1,
      backgroundColor: colors.scrim,
      justifyContent: 'flex-end',
      paddingLeft: 18,
      paddingBottom: 108,
    },
    attachmentMenu: {
      width: 224,
      borderRadius: 24,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingHorizontal: 10,
      paddingVertical: 9,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 30,
      elevation: 16,
    },
    attachmentMenuItem: {
      minHeight: 54,
      borderRadius: 17,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 8,
    },
    menuItemPressed: { backgroundColor: colors.surfaceRaised },
    menuIcon: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    menuLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
    pressed: { opacity: 0.6, transform: [{ scale: 0.97 }] },
  });

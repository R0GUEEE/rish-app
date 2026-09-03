import React, { useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import ImageIcon from 'lucide-react-native/icons/image';

import { blockedReasonLabel, classifyImageTarget } from '../markdown/images';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { AttachmentDescriptor } from '../state';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

/**
 * Renders a markdown image token. Remote URLs never load until the user
 * taps the placeholder (privacy: model output must not trigger network
 * requests). Data URIs and app-owned attachment thumbnails are local and
 * render directly; hostile schemes fail closed to a labelled chip.
 */
export function MarkdownImageToken({
  alt,
  target,
  attachments,
}: {
  alt: string;
  target: string;
  attachments?: readonly AttachmentDescriptor[];
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const classified = useMemo(() => classifyImageTarget(target), [target]);
  const [revealed, setRevealed] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = alt.length > 0 ? alt : target;

  if (classified.kind === 'data') {
    return (
      <View accessibilityLabel={'Image: ' + label} style={styles.imageWrap}>
        <Image
          resizeMode="cover"
          source={{ uri: classified.uri }}
          style={styles.image}
        />
      </View>
    );
  }

  if (classified.kind === 'attachment') {
    const attachment = attachments?.find(item => item.id === classified.id);
    if (attachment !== undefined && attachment.thumbnail_data_url !== undefined) {
      return (
        <View accessibilityLabel={'Image: ' + label} style={styles.imageWrap}>
          <Image
            resizeMode="cover"
            source={{ uri: attachment.thumbnail_data_url }}
            style={styles.image}
          />
        </View>
      );
    }
    return (
      <View
        accessibilityLabel={'Attachment reference: ' + classified.id}
        style={styles.remoteChip}
      >
        <AppIcon color={colors.muted} icon={ImageIcon} size={16} />
        <View style={styles.chipText}>
          <Text numberOfLines={1} style={styles.chipTitle}>
            {label}
          </Text>
          <Text numberOfLines={1} style={styles.chipHost}>
            attachment: {classified.id}
          </Text>
        </View>
      </View>
    );
  }

  if (classified.kind === 'blocked') {
    return (
      <View
        accessibilityLabel={
          'Image not shown: ' + blockedReasonLabel(classified.reason)
        }
        style={styles.blockedChip}
      >
        <AppIcon color={colors.muted} icon={CircleAlert} size={14} />
        <View style={styles.chipText}>
          <Text numberOfLines={1} style={styles.blockedTitle}>
            image blocked
          </Text>
          <Text numberOfLines={1} style={styles.blockedReason}>
            {blockedReasonLabel(classified.reason)}
          </Text>
        </View>
      </View>
    );
  }

  if (!revealed || failed) {
    return (
      <Pressable
        accessibilityLabel={'Load image: ' + label + ' (' + classified.host + ')'}
        accessibilityRole="button"
        onPress={() => {
          setFailed(false);
          setRevealed(true);
        }}
        style={({ pressed }) => [
          styles.remoteChip,
          pressed && styles.pressed,
        ]}
      >
        <AppIcon color={colors.accent} icon={ImageIcon} size={16} />
        <View style={styles.chipText}>
          <Text numberOfLines={1} style={styles.chipTitle}>
            {label}
          </Text>
          <Text numberOfLines={1} style={styles.chipHost}>
            {failed ? 'failed to load — tap to retry' : classified.host + ' — tap to load'}
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View accessibilityLabel={'Image: ' + label} style={styles.imageWrap}>
      <Image
        onError={() => setFailed(true)}
        resizeMode="cover"
        source={{ uri: classified.url }}
        style={styles.image}
      />
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    imageWrap: {
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      overflow: 'hidden',
      backgroundColor: colors.surface,
      marginVertical: 2,
    },
    image: { width: 224, height: 140 },
    remoteChip: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginVertical: 2,
    },
    blockedChip: {
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      paddingHorizontal: 10,
      paddingVertical: 8,
      marginVertical: 2,
    },
    chipText: { flexShrink: 1, marginLeft: 8, minWidth: 0 },
    chipTitle: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
    chipHost: { color: colors.muted, fontFamily: fonts.mono, fontSize: 10, marginTop: 2 },
    blockedTitle: { color: colors.muted, fontSize: 13, fontWeight: '700' },
    blockedReason: { color: colors.faint, fontFamily: fonts.mono, fontSize: 10, marginTop: 2 },
    pressed: { opacity: 0.6 },
  });

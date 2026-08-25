import React from 'react';

import type { LucideIcon, LucideProps } from 'lucide-react-native';

export const iconStrokeWidth = 1.8;

type Props = Omit<LucideProps, 'color' | 'size' | 'strokeWidth'> & {
  color: string;
  icon: LucideIcon;
  size?: number;
  strokeWidth?: number;
};

export function AppIcon({
  color,
  icon: Icon,
  size = 18,
  strokeWidth = iconStrokeWidth,
  ...props
}: Props) {
  return (
    <Icon
      accessible={false}
      color={color}
      focusable={false}
      size={size}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}

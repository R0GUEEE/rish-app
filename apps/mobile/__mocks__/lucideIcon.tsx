import React, { forwardRef } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';

type MockIconProps = {
  color?: string;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const LucideIconMock = forwardRef<React.ElementRef<typeof View>, MockIconProps>(
  ({ size = 18, style, testID }, ref) => (
    <View
      accessible={false}
      pointerEvents="none"
      ref={ref}
      style={[{ height: size, width: size }, style]}
      testID={testID}
    />
  ),
);

LucideIconMock.displayName = 'LucideIconMock';

export default LucideIconMock;

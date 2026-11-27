import { Image } from "expo-image";
import { Modal, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton } from "../../ui/Button";
import { AppText } from "../../ui/Text";

/** The illustration's width to height ratio (1024 × 1536). */
export const illustrationRatio = 1024 / 1536;

/**
 * An exercise illustration over the whole screen. Pinch to zoom;
 * the close button returns to the guide.
 */
export function IllustrationViewer({
  uri,
  alt,
  title,
  visible,
  onClose,
}: {
  uri: string;
  alt: string;
  title: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const available = height - insets.top - insets.bottom - 64;
  const imageWidth = Math.min(width, available * illustrationRatio);
  const imageHeight = imageWidth / illustrationRatio;
  return (
    <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 bg-screen" accessibilityViewIsModal testID="illustration-viewer">
        <View className="flex-row items-center gap-3 px-4 pb-2" style={{ paddingTop: insets.top + 8 }}>
          <AppText textRole="headline" weight="semibold" accessibilityRole="header" numberOfLines={1} className="flex-1">
            {title}
          </AppText>
          <IconButton icon="xmark" label="Close illustration" tone="secondary" onPress={onClose} testID="illustration-close" />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center", paddingBottom: insets.bottom }}
          maximumZoomScale={4}
          minimumZoomScale={1}
          centerContent
          bouncesZoom
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Image
            source={{ uri }}
            style={{ width: imageWidth, height: imageHeight }}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={150}
            accessible
            accessibilityRole="image"
            accessibilityLabel={alt}
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

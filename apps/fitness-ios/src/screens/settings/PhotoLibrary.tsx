import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { launchImageLibraryAsync, UIImagePickerPreferredAssetRepresentationMode } from "expo-image-picker";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, View } from "react-native";
import type { PhotoSummary } from "@bent/fitness-contracts";
import { useAccount } from "../../account/AccountProvider";
import { Button, IconButton } from "../../ui/Button";
import { haptic } from "../../ui/haptics";
import { Notice, SectionTitle } from "../../ui/Layout";
import { Symbol } from "../../ui/Symbol";
import { AppText } from "../../ui/Text";
import { shape } from "../../ui/typography";
import { clearPickerCopies } from "./pickerFiles";
import { checkPhoto, photoId, photoLimits, photoName, tooManyPhotos } from "./rules";

const message = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Private equipment photos: choose from the library, view and remove. */
export function PhotoLibrary() {
  const { api } = useAccount();
  const [photos, setPhotos] = useState<PhotoSummary[] | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      setPhotos(await api.listPhotos());
      return true;
    } catch {
      setError("Equipment photos could not load. Retry when connected.");
      return false;
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setError("");
    const count = photos?.length ?? 0;
    if (count >= photoLimits.count) {
      setError(tooManyPhotos);
      return;
    }
    clearPickerCopies();
    const picked = await launchImageLibraryAsync({
      mediaTypes: ["images"],
      base64: true,
      quality: 0.7,
      exif: false,
      preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible,
    }).catch((e: unknown) => {
      setError(message(e, "The photo library did not open. Try again."));
      return null;
    });
    const asset = picked && !picked.canceled ? picked.assets[0] : undefined;
    if (!asset) return;
    // The picker writes its own copy of the photo; it is deleted once read,
    // whatever happens, so no copy stays on this iPhone.
    const removeCopy = () => {
      try {
        const copy = new File(asset.uri);
        if (copy.exists) copy.delete();
      } catch {
        // The copy is in the app's temporary files, which iOS also clears.
      }
    };
    const checked = checkPhoto(asset.base64, count);
    if (!checked.type) {
      removeCopy();
      haptic("error");
      setError(checked.error);
      return;
    }
    const base64 = asset.base64 ?? "";
    removeCopy();
    setUploading(true);
    try {
      const id = photoId(await digestStringAsync(CryptoDigestAlgorithm.SHA256, base64));
      await api.uploadPhoto({ id, name: photoName(asset.fileName, checked.type), type: checked.type, base64 });
      setPhotos(await api.listPhotos());
      haptic("success");
    } catch (e) {
      haptic("error");
      setError(message(e, "Upload failed. Choose the photo again to retry."));
    } finally {
      setUploading(false);
    }
  }

  function remove(photo: PhotoSummary) {
    Alert.alert("Remove photo?", `Remove photo ${photo.name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          setError("");
          try {
            await api.deletePhoto(photo.id);
            setPhotos(await api.listPhotos());
          } catch {
            haptic("error");
            setError("Photo could not be removed. Retry when connected.");
          }
        },
      },
    ]);
  }

  return (
    <View className="gap-3" testID="equipment-photos">
      <SectionTitle>Private equipment photos</SectionTitle>
      <AppText textRole="footnote" tone="secondary" className="px-1">
        JPEG, PNG or WebP, up to 2 MB each, and up to 20 photos. Only your account can access these photos.
      </AppText>
      <Button
        label={uploading ? "Uploading photo…" : "Upload equipment photo"}
        icon="photo.badge.plus"
        tone="tinted"
        busy={uploading}
        onPress={() => void add()}
        accessibilityLabel="Upload equipment photo"
        testID="upload-photo"
      />
      {error ? (
        <Notice
          tone="danger"
          testID="photo-error"
          action={photos === null ? <Button label="Retry" tone="plain" size="compact" onPress={() => void load().then((ok) => ok && setError(""))} /> : undefined}
        >
          {error}
        </Notice>
      ) : null}
      {photos === null && !error ? <ActivityIndicator accessibilityLabel="Loading equipment photos" /> : null}
      {photos?.length === 0 ? (
        <AppText textRole="footnote" tone="muted" className="px-1">
          No equipment photos yet.
        </AppText>
      ) : null}
      {photos?.length ? (
        <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
          {photos.map((photo) => (
            <PhotoTile key={photo.id} photo={photo} onRemove={() => remove(photo)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function PhotoTile({ photo, onRemove }: { photo: PhotoSummary; onRemove: () => void }) {
  const { api } = useAccount();
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    api.photoSource(photo.id).then(
      (next) => active && setSource(next),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [api, photo.id]);
  return (
    <View className="w-1/2 p-1" testID={`photo-${photo.id}`}>
      <View className="gap-1.5 bg-card p-1.5" style={{ borderRadius: shape.card, borderCurve: "continuous" }}>
        <View className="aspect-square items-center justify-center overflow-hidden bg-card-alt" style={{ borderRadius: shape.control, borderCurve: "continuous" }}>
          {source && !failed ? (
            <Image
              source={source}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              accessibilityLabel={photo.name}
              onError={() => setFailed(true)}
            />
          ) : failed ? (
            <Symbol name="photo" size={28} tintColorClassName="accent-chevron" />
          ) : (
            <ActivityIndicator />
          )}
          <View className="absolute right-1.5 top-1.5">
            <IconButton icon="trash" label={`Remove photo ${photo.name}`} tone="secondary" size={32} onPress={onRemove} />
          </View>
        </View>
        <AppText textRole="caption" tone="secondary" numberOfLines={1} className="px-1 pb-0.5">
          {photo.name}
        </AppText>
      </View>
    </View>
  );
}

import { Directory, Paths } from "expo-file-system";

/**
 * Deletes the photo picker's temporary copies. The picker writes each chosen
 * photo to Caches/ImagePicker, and can leave one behind when it fails before
 * returning it, so the folder is cleared before each pick and on sign-out.
 */
export function clearPickerCopies() {
  try {
    const folder = new Directory(Paths.cache, "ImagePicker");
    if (folder.exists) folder.delete();
  } catch {
    // The folder is in the app's caches, which iOS also clears.
  }
}

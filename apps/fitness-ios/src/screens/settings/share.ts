import { File, Paths } from "expo-file-system";
import { isAvailableAsync, shareAsync } from "expo-sharing";

/**
 * Writes JSON text to a temporary file and opens the share sheet, so it can
 * be saved to Files or sent. The file is deleted once the sheet closes.
 */
export async function shareJson(name: string, text: string, dialogTitle: string) {
  if (!(await isAvailableAsync())) throw new Error("Sharing is not available on this iPhone.");
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  try {
    await file.write(text);
    await shareAsync(file.uri, { mimeType: "application/json", UTI: "public.json", dialogTitle });
  } finally {
    if (file.exists) file.delete();
  }
}
